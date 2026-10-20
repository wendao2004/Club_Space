/**
 * 实时推送与在线状态的回归测试。
 *
 * 这个文件是为两个**真实发生过的故障**写的，两者都属于"从代码上看很合理、
 * 跑起来才会发现不对"的那种：
 *
 * 1. **象棋按"触发者视角"广播**
 *    服务端用 broadcast 把房间对象发给所有人，而房间里的 mySide / myTurn
 *    是因人而异的 —— 于是对手收到的是落子者视角：myTurn 恒为 false。
 *    现象是"象棋无法游玩且 UI 显示异常"：棋盘上下颠倒，一步也点不动。
 *    这个测试用**两个真实客户端**同时连着 SSE 来验证各自收到的视角是对的。
 *
 * 2. **在线状态被时间窗判死**
 *    touchPresence 只在连接建立时调一次，25 秒心跳却从不刷新 last_seen，
 *    判定窗口 60 秒 —— 于是每个人连上 1 分钟后就全体变灰。
 *    这个测试直接伪造一条"很久没心跳"的 presence 记录，验证连接还在的人
 *    不会被判离线；同时验证干净断开后**立刻**变离线（而不是再亮 60 秒）。
 *
 * 用法：由 scripts/run-all-tests.mjs 启动服务端后运行。
 *      需要 WL_TEST_DATA_DIR 指向服务端的数据库目录（用于伪造过期心跳）。
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const DATA_DIR = process.env.WL_TEST_DATA_DIR ?? ''
const SUFFIX = String(process.pid).slice(-5)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      let body = options.body
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const parsed = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body: parsed }
    },
  }
}

/** 开一条 SSE 流并把事件收集起来。返回 close()。 */
async function openStream(client, sink) {
  const controller = new AbortController()
  const res = await fetch(`${BASE}/api/chat/stream`, {
    headers: { cookie: client.cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!res.ok) throw new Error(`SSE 建立失败：${res.status}`)
  ;(async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const em = block.match(/^event: (.+)$/m)
          const dm = block.match(/^data: (.+)$/m)
          if (em && dm) {
            try {
              sink.push({ type: em[1], data: JSON.parse(dm[1]) })
            } catch {
              /* 解析不了就跳过 */
            }
          }
        }
      }
    } catch {
      /* 主动关闭时抛错属正常 */
    } finally {
      // 用一个哨兵事件记录"这条流结束了"。登出/强制下线的断言靠它 ——
      // 没有它就只能靠"等一段时间看有没有新事件"，那既慢又不可靠。
      sink.push({ type: '__closed', data: {} })
    }
  })()
  return () => controller.abort()
}

/** 等到 sink 里出现满足条件的事件，或超时。 */
async function waitFor(sink, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = sink.find(predicate)
    if (hit) return hit
    await sleep(80)
  }
  return null
}

/** 直接改服务端的 presence 表，伪造一条"很久没心跳"的记录。 */
function agePresence(userId, ageMs) {
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
  try {
    db.prepare('UPDATE presence SET last_seen = ? WHERE user_id = ?').run(Date.now() - ageMs, userId)
  } finally {
    db.close()
  }
}

/**
 * 把库里这条在线记录彻底"抹掉"：时间戳很旧 + 连接计数 0。
 *
 * 用来证明一件事：**在线判定不再依赖心跳写库**。
 * 连接计数被清零之后，库这边已经查不出任何"在线"迹象了，
 * 而 socket 还好端端地开着 —— 这时候仍然必须显示在线。
 *
 * 这一条同时是"心跳可以不再写库"的前提：心跳原来每 25 秒刷一次 last_seen，
 * 100 条连接就是 4 次/秒的写事务；如果在线状态其实由内存里的连接表决定，
 * 那些写就一点信息量都没有。
 */
function blankPresence(userId) {
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
  try {
    db.prepare('UPDATE presence SET last_seen = ?, connection_count = 0 WHERE user_id = ?').run(
      Date.now() - 10 * 60_000,
      userId,
    )
  } finally {
    db.close()
  }
}

async function main() {
  console.log(`\n\x1b[1m实时推送与在线状态\x1b[0m  目标 ${BASE}\n`)

  const a = makeClient()
  const b = makeClient()

  // ---------------------------------------------------------------- 准备
  console.log('【准备账号】')
  const regA = await a.api('/api/auth/register', {
    method: 'POST',
    json: { username: `rta${SUFFIX}`, displayName: '甲', password: 'realtime-test-2026' },
  })
  if (regA.status !== 200 && regA.status !== 201) {
    bad('注册账号甲', `状态 ${regA.status}：${JSON.stringify(regA.body)}`)
    process.exit(1)
  }
  const idA = regA.body.user.id
  const inv = await a.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const regB = await b.api('/api/auth/register', {
    method: 'POST',
    json: { username: `rtb${SUFFIX}`, displayName: '乙', password: 'realtime-test-2026', inviteCode: inv.body.code },
  })
  assert(regB.status === 200 || regB.status === 201, '注册账号乙（持邀请码）')
  const idB = regB.body.user.id

  // ---------------------------------------------------------------- 象棋视角
  console.log('\n【象棋：按人推送的房间视角（防"无法游玩"回归）】')

  const room = await a.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '视角回归测试', side: 'red' },
  })
  assert(room.status === 200, '甲创建棋局并执红', `状态 ${room.status}`)
  const roomId = room.body.room.id

  const joined = await b.api(`/api/games/rooms/${roomId}/join`, { method: 'POST', json: { side: 'black' } })
  assert(joined.status === 200, '乙加入并执黑', `状态 ${joined.status}`)
  assert(joined.body.room.status === 'playing', '对局进入进行中')

  // 两边都连上 SSE 之后再落子 —— 这正是真实使用时的形态
  const sinkA = []
  const sinkB = []
  const closeA = await openStream(a, sinkA)
  const closeB = await openStream(b, sinkB)
  await sleep(900)
  assert(sinkA.some((e) => e.type === 'hello'), '甲收到 hello')
  assert(sinkB.some((e) => e.type === 'hello'), '乙收到 hello')

  // 红方第一步：炮二平五（b2 → e2）。这是最基础的开局着法。
  const moved = await a.api(`/api/games/rooms/${roomId}/move`, { method: 'POST', json: { from: 'b2', to: 'e2' } })
  assert(moved.status === 200, '红方走一步（炮二平五）', `状态 ${moved.status} ${JSON.stringify(moved.body).slice(0, 150)}`)

  // ---- 核心断言：乙收到的事件里，视角必须是"乙的"，不是"甲的" ----
  const evB = await waitFor(sinkB, (e) => e.type === 'game-move')
  assert(evB !== null, '乙通过 SSE 收到落子事件')
  if (evB) {
    assert(
      evB.data.room?.mySide === 'black',
      '乙收到的房间视角是 black（不是落子者的 red）',
      `mySide=${evB.data.room?.mySide}`,
    )
    assert(
      evB.data.room?.myTurn === true,
      '乙收到的 myTurn 为 true —— 轮到他走，棋盘可以点',
      `myTurn=${evB.data.room?.myTurn}`,
    )
    assert(
      evB.data.room?.turn === 'black',
      '局面轮到黑方',
      `turn=${evB.data.room?.turn}`,
    )
    assert(
      typeof evB.data.room?.board === 'string' && evB.data.room.board.includes('/'),
      '事件里带了棋盘序列化',
    )
  }

  const evA = await waitFor(sinkA, (e) => e.type === 'game-move')
  assert(evA !== null, '甲也收到了落子事件（自己的那一步会回到自己这里）')
  if (evA) {
    assert(
      evA.data.room?.mySide === 'red',
      '甲收到的视角仍是 red',
      `mySide=${evA.data.room?.mySide}`,
    )
    assert(
      evA.data.room?.myTurn === false,
      '甲的 myTurn 为 false（已经走过了，等对方）',
      `myTurn=${evA.data.room?.myTurn}`,
    )
  }

  // 换乙走一步，验证"双方都能连续走"—— 这正是原来卡死的地方
  const moved2 = await b.api(`/api/games/rooms/${roomId}/move`, { method: 'POST', json: { from: 'b7', to: 'e7' } })
  assert(moved2.status === 200, '黑方紧接着也能走一步（双方不再互相卡死）', `状态 ${moved2.status}`)
  const evA2 = await waitFor(sinkA, (e) => e.type === 'game-move' && e.data.room?.turn === 'red')
  assert(evA2 !== null, '甲收到了黑方的落子事件')
  if (evA2) {
    assert(evA2.data.room?.myTurn === true, '甲重新可以走棋（myTurn 回到 true）', `myTurn=${evA2.data.room?.myTurn}`)
  }

  closeA()
  closeB()
  await sleep(300)

  // ---------------------------------------------------------------- 在线状态
  console.log('\n【在线状态】')

  const sinkC = []
  const closeC = await openStream(a, sinkC)
  await sleep(800)

  const onlineNow = async () => {
    const res = await b.api('/api/chat/contacts')
    const list = res.body.contacts ?? []
    return list.find((c) => c.id === idA)?.online === true
  }

  assert(await onlineNow(), '甲连着 SSE 时对乙显示为在线')

  // ---- 伪造"心跳已经过期很久"：连接计数还在，不该被判离线 ----
  if (DATA_DIR) {
    agePresence(idA, 10 * 60_000)
    assert(
      await onlineNow(),
      'last_seen 过期但 SSE 连接仍在 → 仍显示在线（这正是原来集体变灰的原因）',
      '（伪造了 10 分钟没心跳的 presence 记录）',
    )
  } else {
    console.log('  \x1b[33m⚠ 未拿到 WL_TEST_DATA_DIR，跳过"心跳过期"用例\x1b[0m')
  }

  // ---- 把库里的在线痕迹全部抹掉：socket 还在，仍然必须是在线 ----
  //
  // 这条是"心跳不再写库"的守门断言。以前心跳每 25 秒刷一次 last_seen，
  // 现在不写了 —— 如果哪天有人把在线判定改回"只看 last_seen 窗口"，
  // 这里会立刻变红：库被抹干净之后，那个实现会把人判成离线。
  if (DATA_DIR) {
    blankPresence(idA)
    assert(
      await onlineNow(),
      '库里的在线痕迹被清零，但 SSE 还连着 → 依然显示在线（在线状态由连接表决定）',
      '（last_seen 老 10 分钟 + connection_count = 0）',
    )
  }

  // ---- 干净断开应该**立刻**离线，而不是再亮 60 秒 ----
  closeC()
  await sleep(1200)
  assert(!(await onlineNow()), '断开 SSE 后立刻显示离线（不再靠 60 秒窗口挂在那里）')

  // ---------------------------------------------------------------- 未读推送的载荷契约
  //
  // 防的是"事件名对了、载荷字段名不对"这类静默失效：前端 handleUnread 曾经读的是
  // data.totalUnread，而服务端推的是 data.total —— 名字对不上，于是"实时未读红点"
  // 从来没有生效过（用户报"收到消息没有任何反馈"的直接原因）。
  // 下面这条把字段名钉死在线上，以后谁改载荷都能当场变红。
  console.log('\n【聊天未读推送的载荷契约】')
  {
    const direct = await a.api('/api/chat/conversations/direct', {
      method: 'POST',
      json: { peerId: idB },
    })
    assert(direct.status === 200, '甲和乙建立单聊')
    const convId = direct.body.conversation.id

    const sinkU = []
    const closeU = await openStream(b, sinkU)
    await sleep(900)

    const sent = await a.api(`/api/chat/conversations/${convId}/messages`, {
      method: 'POST',
      json: { kind: 'text', body: '未读契约测试' },
    })
    assert(sent.status === 200, '甲发一条消息')

    const unreadEv = await waitFor(sinkU, (e) => e.type === 'unread' && typeof e.data?.total === 'number')
    assert(
      unreadEv !== null,
      '乙收到 unread 推送，且字段名是 data.total（与前端解析一致）',
      `收到的事件：${sinkU.map((e) => e.type).join('、') || '（空）'}`,
    )
    if (unreadEv) {
      assert(
        unreadEv.data.total >= 1,
        'unread.total ≥ 1（确实把这条新消息数进去了）',
        `total=${unreadEv.data.total}`,
      )
    }
    closeU()
    await sleep(300)
  }

  // ---------------------------------------------------------------- 事件名接线
  //
  // 这一节防的是一类**静默失效**：共享的 realtime store 是遍历 KNOWN_EVENTS
  // 去 `source.addEventListener(...)` 的，服务端发了一个不在那张表里的事件名，
  // 客户端就永远收不到 —— 没有任何报错，只是那个功能悄悄不工作。
  //
  // 这不是假设：斗地主的出牌推送就这么丢过。前端当时用
  // `'game-play' as RealtimeEventName` 把它盖住了，注释还写着
  // "断言只影响编译期类型" —— 而运行期它压根没注册监听。
  console.log('\n【前后端的事件名必须对得上】')
  {
    const serverSrc = readFileSync('server/src/realtime.ts', 'utf8')
    const clientSrc = readFileSync('web/src/stores/realtime.ts', 'utf8')

    // 服务端：RealtimeEvent 联合类型里所有的 `type: 'xxx'`
    const unionStart = serverSrc.indexOf('export type RealtimeEvent')
    const unionEnd = serverSrc.indexOf('interface Connection')
    const unionBlock = unionStart >= 0 && unionEnd > unionStart ? serverSrc.slice(unionStart, unionEnd) : ''
    const serverEvents = [...unionBlock.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1])

    // 客户端：KNOWN_EVENTS 数组里的字符串字面量
    const arrStart = clientSrc.indexOf('const KNOWN_EVENTS')
    const arrEnd = clientSrc.indexOf('] as const', arrStart)
    const arrBlock = arrStart >= 0 && arrEnd > arrStart ? clientSrc.slice(arrStart, arrEnd) : ''
    const clientEvents = [...arrBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])

    assert(serverEvents.length >= 8, '解析到了服务端的事件名（说明断言真的在检查东西）', `${serverEvents.length} 个`)
    const missing = serverEvents.filter((e) => !clientEvents.includes(e))
    assert(
      missing.length === 0,
      '服务端能发的每个事件名，前端都注册了监听',
      missing.length ? `前端事件表里缺少：${missing.join('、')}` : serverEvents.join('、'),
    )
  }

  // ---------------------------------------------------------------- 登出必须断流
  //
  // 这一节防的是"看起来安全，其实没有"：SSE 只在建连那一刻鉴权一次，
  // 之后就是一条长活连接。会话行被删掉、cookie 被清掉，**都不会通知这条流**。
  // 于是共用电脑上点了"注销"，那个标签页还在继续收新消息与未读数；
  // 更严重的是"强制下线"对被偷走的 EventSource 完全无效，它会一直收到
  // 新消息直到进程重启。
  console.log('\n【登出 / 强制下线必须终止已建立的 SSE】')
  {
    const c = makeClient()
    const regC = await c.api('/api/auth/register', {
      method: 'POST',
      json: {
        username: `rtc${SUFFIX}`,
        displayName: '丙',
        password: 'realtime-test-2026',
        inviteCode: (await a.api('/api/admin/invites', {
          method: 'POST',
          json: { role: 'member', maxUses: 1, expiresInDays: 1 },
        })).body.code,
      },
    })
    if (regC.status !== 200 && regC.status !== 201) {
      bad('注册账号丙', `状态 ${regC.status}：${JSON.stringify(regC.body)}`)
      process.exit(1)
    }
    const idC = regC.body.user.id

    // 1) 自己点"注销"
    const sinkC = []
    const closeC = await openStream(c, sinkC)
    const helloC = await waitFor(sinkC, (e) => e.type === 'hello')
    assert(helloC !== null, '丙的 SSE 已建立')

    await c.api('/api/auth/logout', { method: 'POST', json: {} })
    const closedAfterLogout = await waitFor(sinkC, (e) => e.type === '__closed', 3000)
    assert(
      closedAfterLogout !== null,
      '登出后 3 秒内这条流被服务端关闭（不再是"退出登录但还在收消息"）',
      `收到的事件：${sinkC.map((e) => e.type).join('、')}`,
    )
    closeC()

    // 2) 管理员强制下线（revokeAllSessions）
    const relogin = await c.api('/api/auth/login', {
      method: 'POST',
      json: { username: `rtc${SUFFIX}`, password: 'realtime-test-2026' },
    })
    assert(relogin.status === 200, '丙重新登录')

    const sinkC2 = []
    const closeC2 = await openStream(c, sinkC2)
    const helloC2 = await waitFor(sinkC2, (e) => e.type === 'hello')
    assert(helloC2 !== null, '丙的第二条流已建立')

    const revoke = await a.api(`/api/admin/users/${idC}/sessions/revoke`, {
      method: 'POST',
      json: {},
    })
    assert(revoke.status === 200, '管理员强制下线丙', `状态 ${revoke.status}`)

    const closedAfterRevoke = await waitFor(sinkC2, (e) => e.type === '__closed', 3000)
    assert(
      closedAfterRevoke !== null,
      '强制下线后 3 秒内流被关闭（否则"踢下线"对已建立的流等于没生效）',
      `收到的事件：${sinkC2.map((e) => e.type).join('、')}`,
    )
    closeC2()
    await sleep(200)
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
