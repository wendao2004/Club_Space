/**
 * 人机对战的性能与"卡在思考中"回归测试。
 *
 * 两个真实故障驱动了这个文件：
 *
 * 1. **卡顿**：搜索原来是同步跑在主线程上的，困难档一手棋 1.2 秒里整个 Node
 *    进程停摆（实测 /api/health 的 p99 从 4ms 变成 1195ms）。用户体感就是
 *    "下棋卡顿" —— 点棋子的合法性请求、SSE 推送全在排队。第一组用例就是
 *    把这个数字钉住：机器人思考期间，别人的请求必须照常几毫秒返回。
 *
 * 2. **卡在思考**：后台落子这条链（定时器 → 搜索 → 推送）任何一环断了，
 *    房间就会永远停在"该电脑走"，界面上的"电脑正在思考…"再也不变。
 *    第二、三、四组用例分别验证三条出口：正常应招、掉了一次调度能自愈、
 *    搜索期间认输不会被打回进行中。
 *
 * 用法：先启动后端，然后  node scripts/xiangqi-bot-test.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deserializeBoard, legalMoves, squareName } from '../server/src/games/xiangqi.ts'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
/** 服务端的数据目录。要在【3】里直接改库造一个"掉了一次调度"的房间。 */
const DATA_DIR = process.env.WL_TEST_DATA_DIR ?? ''

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
}

function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个带 cookie 的极简客户端。 */
function makeClient() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    async api(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(init.headers ?? {}),
        },
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      let body = null
      try {
        body = await res.json()
      } catch {
        // 无响应体
      }
      return { status: res.status, body }
    },
  }
}

/** 等房间满足条件，返回最后一次拿到的 room；超时返回 null。 */
async function waitRoom(client, roomId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await client.api(`/api/games/rooms/${roomId}`)
    last = res.body?.room ?? null
    if (last && predicate(last)) return last
    await sleep(150)
  }
  return null
}

/** 人走一步：优先走"能吃子/能将军"的着法，让局面更快进入复杂状态。 */
function pickHumanMove(boardText, turn) {
  const moves = legalMoves(deserializeBoard(boardText), turn)
  if (moves.length === 0) return null
  const captures = moves.filter((m) => deserializeBoard(boardText)[m.to])
  const pool = captures.length > 0 ? captures : moves
  return pool[Math.floor(Math.random() * pool.length)]
}

async function main() {
  console.log(`\n\x1b[1m人机对战：性能与卡死回归\x1b[0m  目标 ${BASE}\n`)

  const client = makeClient()
  const suffix = String(Date.now()).slice(-6)
  let reg = await client.api('/api/auth/register', {
    method: 'POST',
    json: undefined,
    body: JSON.stringify({
      username: `xq${suffix}`,
      displayName: '象棋测试员',
      password: 'xq-test-pass-2026',
    }),
  })
  if (reg.status !== 200) {
    reg = await client.api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'xqowner', password: 'xq-test-pass-2026' }),
    })
  }
  if (reg.status !== 200) {
    bad('准备会话', `注册 ${reg.status}，登录也失败`)
    process.exit(1)
  }
  ok('准备会话')

  // ================================================================ 1. 不阻塞主线程
  console.log('\n【1】机器人思考期间，服务端照常响应')

  const hardRoom = await client.api('/api/games/rooms', {
    method: 'POST',
    body: JSON.stringify({ kind: 'xiangqi', bot: { level: 'hard', side: 'black' } }),
  })
  assert(hardRoom.status === 200, '创建困难档人机对战', `状态 ${hardRoom.status}`)
  const hardId = hardRoom.body.room.id

  const firstMove = pickHumanMove(hardRoom.body.room.board, 'red')
  await client.api(`/api/games/rooms/${hardId}/move`, {
    method: 'POST',
    body: JSON.stringify({ from: squareName(firstMove.from), to: squareName(firstMove.to) }),
  })

  // 从这一刻开始，机器人最多要算 1.2 秒。密集打 health，看主线程有没有被堵住。
  const latencies = []
  const probeDeadline = Date.now() + 2500
  while (Date.now() < probeDeadline) {
    const t0 = Date.now()
    await fetch(`${BASE}/api/health`)
    latencies.push(Date.now() - t0)
    await sleep(25)
  }
  latencies.sort((a, b) => a - b)
  const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] ?? 0
  const maxLatency = latencies[latencies.length - 1] ?? 0
  assert(
    p99 < 400,
    '搜索不再堵住主线程（p99 < 400ms）',
    `${latencies.length} 次探测 p99=${p99}ms max=${maxLatency}ms（改前 max≈1195ms）`,
  )

  await waitRoom(client, hardId, (r) => r.turn === 'red' || r.status !== 'playing', 10000)
  await client.api(`/api/games/rooms/${hardId}/resign`, { method: 'POST', body: '{}' })

  // ================================================================ 2. 连续应招
  console.log('\n【2】连续多手都能应招，且落子合法')

  const normalRoom = await client.api('/api/games/rooms', {
    method: 'POST',
    body: JSON.stringify({ kind: 'xiangqi', bot: { level: 'normal', side: 'black' } }),
  })
  const roomId = normalRoom.body.room.id
  let room = normalRoom.body.room
  let plies = 0
  let stalledAt = null
  let invalidMove = null

  for (let i = 0; i < 10; i++) {
    if (room.status !== 'playing' || room.turn !== 'red') break
    const pick = pickHumanMove(room.board, 'red')
    if (!pick) break
    const res = await client.api(`/api/games/rooms/${roomId}/move`, {
      method: 'POST',
      body: JSON.stringify({ from: squareName(pick.from), to: squareName(pick.to) }),
    })
    if (res.status !== 200) {
      invalidMove = `人的着法被拒：${res.status} ${JSON.stringify(res.body)}`
      break
    }
    plies++
    if (res.body.finished) {
      room = res.body.room
      break
    }
    const after = await waitRoom(client, roomId, (r) => r.turn === 'red' || r.status !== 'playing', 8000)
    if (!after) {
      stalledAt = plies
      room = (await client.api(`/api/games/rooms/${roomId}`)).body.room
      break
    }
    if (after.moves.length < room.moves.length + 2 && after.status === 'playing') {
      invalidMove = `第 ${plies} 手之后机器人没有落子，但局面仍在进行`
      room = after
      break
    }
    room = after
  }

  assert(stalledAt === null, `机器人每一手都在 8 秒内应招（走了 ${plies} 手）`, stalledAt ? `第 ${stalledAt} 手卡住` : '')
  assert(invalidMove === null, '落子全程没有被服务端拒绝', invalidMove ?? '')
  assert(
    room.moves.every((m, i) => (i % 2 === 0 ? m.color === 'red' : m.color === 'black')),
    '走子历史红黑交替（没有连走两手）',
  )
  await client.api(`/api/games/rooms/${roomId}/resign`, { method: 'POST', body: '{}' })

  // ================================================================ 3. 自愈
  console.log('\n【3】掉了一次调度的房间能自己补上这一手')

  const healRoom = await client.api('/api/games/rooms', {
    method: 'POST',
    body: JSON.stringify({ kind: 'xiangqi', bot: { level: 'easy', side: 'black' } }),
  })
  const healId = healRoom.body.room.id
  const healPick = pickHumanMove(healRoom.body.room.board, 'red')
  const afterHuman = await client.api(`/api/games/rooms/${healId}/move`, {
    method: 'POST',
    body: JSON.stringify({ from: squareName(healPick.from), to: squareName(healPick.to) }),
  })
  // 状态：人走完了，轮黑方（电脑）。先把这一手正常等回来
  const botPlayed = await waitRoom(client, healId, (r) => r.turn === 'red', 8000)
  assert(botPlayed !== null, '（基准）机器人正常应了第一手')

  /**
   * 现在把库里的状态**回滚到"人走完、轮到电脑"**，并把 updated_at 拨老 20 秒。
   *
   * 这精确模拟了"后台定时器丢了"：对局状态说该电脑走，但进程里没有任何排队中的
   * 落子任务（in-memory 的 pendingBotReplies 是空的）。真实场景里进程重启、
   * 定时器被丢、异常被吞，都会停在这个状态。
   */
  const dbPath = join(DATA_DIR, 'app.sqlite')
  let dbPatched = false
  if (!DATA_DIR || !existsSync(dbPath)) {
    // 没有数据目录就没法造这个状态。让它**失败**而不是跳过 ——
    // 这一节是"卡在思考"的核心回归，静默跳过等于没测。
    bad('把房间改成"该电脑走但没人调度"的历史状态', '没拿到 WL_TEST_DATA_DIR（用例注册时忘了 passDataDir？）')
  } else {
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare(
        `UPDATE game_rooms SET board = ?, moves = ?, turn = 'black', status = 'playing',
                result = NULL, finished_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        afterHuman.body.room.board,
        JSON.stringify(afterHuman.body.room.moves),
        Date.now() - 20_000,
        healId,
      )
      dbPatched = true
      ok('把房间改成"该电脑走但没人调度"的历史状态')
    } finally {
      db.close()
    }
  }

  if (dbPatched) {
    const before = await client.api(`/api/games/rooms/${healId}`)
    assert(
      before.body.room.botThinking === true && before.body.room.turn === 'black',
      '改造后确实停在"电脑正在思考"',
    )
    // 前端看门狗做的就是这一件事：重新拉一次房间。服务端应当自己补上一手。
    const healed = await waitRoom(client, healId, (r) => r.turn === 'red' || r.status !== 'playing', 10000)
    assert(
      healed !== null,
      '重新拉取房间后，服务端自己补上了这一手（无需重启、无需刷新）',
      healed ? `现在轮到 ${healed.turn}，共 ${healed.moves.length} 手` : '超时仍是"思考中"',
    )
  }

  // ================================================================ 4. 搜索期间认输
  console.log('\n【4】搜索期间认输，对局不会被写回进行中')

  const resignRoom = await client.api('/api/games/rooms', {
    method: 'POST',
    body: JSON.stringify({ kind: 'xiangqi', bot: { level: 'hard', side: 'black' } }),
  })
  const resignId = resignRoom.body.room.id
  const resignPick = pickHumanMove(resignRoom.body.room.board, 'red')
  await client.api(`/api/games/rooms/${resignId}/move`, {
    method: 'POST',
    body: JSON.stringify({ from: squareName(resignPick.from), to: squareName(resignPick.to) }),
  })
  // 机器人还在算（困难档 1.2 秒），这时认输
  await client.api(`/api/games/rooms/${resignId}/resign`, { method: 'POST', body: '{}' })
  await sleep(2500)
  const settled = await client.api(`/api/games/rooms/${resignId}`)
  assert(settled.body.room.status === 'finished', '认输后对局保持结束状态', `状态 ${settled.body.room.status}`)
  assert(
    settled.body.room.result?.reason === 'resign',
    '结束原因是认输（没有被机器人的落子覆盖）',
    `原因 ${settled.body.room.result?.reason}`,
  )

  // ================================================================ 汇总
  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
