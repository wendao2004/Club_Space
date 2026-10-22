/**
 * 你画我猜 HTTP 层测试。
 *
 * 引擎纯函数（draw-test.mjs）证明了"规则对"，这里证明"路通"：
 * 房间生命周期、画笔的写入口校验、猜词的计分落位、**词在 HTTP 响应里
 * 同样不漏给未猜对者**（引擎层裁剪了，但路由层组装 payload 时再裁一次
 * 才算双保险），以及超时推进真的会把阶段往前走。
 *
 * 用法：先启动后端，然后  node scripts/draw-room-test.mjs
 * 超时加速：直接改测试库里的 phaseEndsAt（passDataDir 机制），不真等 80 秒。
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)
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
  if (cond) ok(name, extra0(cond, detail))
  else bad(name, detail || '断言失败')
}

function extra0(_cond, detail) {
  return detail
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------- 客户端

function makeClient() {
  let cookie = ''
  const request = async function request(path, method = 'GET', body) {
    const headers = { 'content-type': 'application/json' }
    if (cookie) headers.cookie = cookie
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: res.status, body: json }
  }
  /** SSE 需要原始 cookie（绕开 request 的封装）。 */
  request.currentCookie = () => cookie
  return request
}

async function register(client, username, displayName) {
  const inv = await admin('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'draw 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName,
    password: 'draw-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'draw-pass-2026' })
  }
  if (res.status !== 200) throw new Error(`账号 ${username} 准备失败：${res.status}`)
  return res
}

// ---------------------------------------------------------------- 准备

const admin = makeClient()
{
  let res = await admin('/api/auth/register', 'POST', {
    username: `drawadmin${SUFFIX}`,
    displayName: '房主管理员',
    password: 'draw-admin-2026',
  })
  if (res.status !== 200) {
    res = await admin('/api/auth/login', 'POST', {
      username: `drawadmin${SUFFIX}`,
      password: 'draw-admin-2026',
    })
  }
  if (res.status !== 200) throw new Error('管理员账号准备失败')
}

const alice = makeClient()
const bob = makeClient()
const carol = makeClient()
await register(alice, `drawa${SUFFIX}`, '画师甲')
await register(bob, `drawb${SUFFIX}`, '猜者乙')
await register(carol, `drawc${SUFFIX}`, '猜者丙')

const meOf = async (client) => (await client('/api/auth/me', 'GET')).body?.user

const aliceUser = await meOf(alice)
const bobUser = await meOf(bob)
const carolUser = await meOf(carol)
console.log(`\n\x1b[1m你画我猜 HTTP 层\x1b[0m  账号 ${aliceUser?.username} / ${bobUser?.username} / ${carolUser?.username}\n`)

// 直接改测试库里的阶段截止时间，把"80 秒"压成"1 秒后"
function hurryPhaseEnds(roomId, msFromNow) {
  if (!DATA_DIR) return false
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
  try {
    const row = db.prepare('SELECT state FROM game_rooms WHERE id = ?').get(roomId)
    if (!row) return false
    const state = JSON.parse(row.state)
    state.phaseEndsAt = Date.now() + msFromNow
    db.prepare('UPDATE game_rooms SET state = ? WHERE id = ?').run(JSON.stringify(state), roomId)
    return true
  } finally {
    db.close()
  }
}

function countRows(sql) {
  if (!DATA_DIR) return -1
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
  try {
    return db.prepare(sql).get().n
  } finally {
    db.close()
  }
}

async function currentWordOf(client, roomId) {
  const res = await client(`/api/games/draw/rooms/${roomId}`, 'GET')
  return res.body?.room
}

// ---------------------------------------------------------------- 用例

console.log('\n【房间生命周期】')

let room = null
{
  const created = await alice('/api/games/draw/rooms', 'POST', { title: '画画测试房', rounds: 1 })
  assert(created.status === 200, '建房成功')
  room = created.body?.room
  assert(!!room?.id, '拿到房间 id')
  eq(room?.kind, 'draw', 'kind 正确')
  eq(room?.phase, 'waiting', '初始 waiting')

  const joined1 = await bob(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  assert(joined1.status === 200, '乙加入')
  const joined2 = await carol(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  assert(joined2.status === 200, '丙加入')

  const again = await bob(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  assert(again.status === 200, '重复加入幂等')

  // 先验证"非房主不能开始"，再让房主开始。
  // （注意顺序：房主一旦成功 phase 就不再是 waiting，非房主那条会变成
  //   "已经开始了"的 400 而不是 403 —— 所以房主的成功断言必须放在后面。）
  const byBob = await bob(`/api/games/draw/rooms/${room.id}/start`, 'POST', {})
  assert(byBob.status === 403, '非房主开始被拒')

  const started = await alice(`/api/games/draw/rooms/${room.id}/start`, 'POST', {})
  assert(started.status === 200, '房主开始成功', JSON.stringify(started.body).slice(0, 200))
  eq(started.body?.room?.phase, 'choosing', '开始后进入选词')

  const late = await makeClient()
  await register(late, `drawlate${SUFFIX}`, '迟到者')
  const lateJoin = await late(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  assert(lateJoin.status === 400, '开局后加入被拒（等下一局）')
}

console.log('\n【选词与视角】')

let answer = null
{
  const drawerView = await currentWordOf(alice, room.id)
  const choices = drawerView?.view?.wordChoices ?? []
  assert(choices.length === 3, '画家看到 3 个候选', choices.join('、'))
  assert(drawerView?.view?.iAmDrawer === true, '画家身份标记')

  const bobView = await currentWordOf(bob, room.id)
  eq(bobView?.view?.wordChoices, [], '⚠️ 猜者在 HTTP 响应里拿不到候选')
  eq(bobView?.view?.word, null, '⚠️ 猜者拿不到词')

  // 选一个不在候选里的词
  const badWord = await alice(`/api/games/draw/rooms/${room.id}/word`, 'POST', { word: '不存在的词' })
  assert(badWord.status === 400, '选候选之外的词被拒')

  answer = choices[0]
  const chosen = await alice(`/api/games/draw/rooms/${room.id}/word`, 'POST', { word: answer })
  assert(chosen.status === 200, '画家选词成功')
  eq(chosen.body?.room?.phase, 'drawing', '进入绘画阶段')

  const afterChoose = await currentWordOf(bob, room.id)
  eq(afterChoose?.view?.word, null, '选词后猜者依然拿不到词')
  assert(typeof afterChoose?.view?.masked === 'string', '猜者拿到掩码', afterChoose?.view?.masked)
  eq(afterChoose?.view?.masked?.length, answer.length, '掩码长度等于词长')

  const wrongGuy = await bob(`/api/games/draw/rooms/${room.id}/word`, 'POST', { word: answer })
  assert(wrongGuy.status === 400, '非画家选词被拒')
}

console.log('\n【画笔】')

{
  // 非画家画被拒
  const notDrawer = await bob(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 's1',
    points: [{ x: 10, y: 10 }],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
  })
  assert(notDrawer.status === 403, '非画家画被拒')

  const begin = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 's1',
    points: [{ x: 10, y: 10 }],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
  })
  assert(begin.status === 200, '画家开始一笔')

  const points = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'points',
    strokeId: 's1',
    points: [
      { x: 20, y: 20 },
      { x: 30, y: 25 },
    ],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
  })
  assert(points.status === 200, '画笔增量上报')

  // 抬笔：前端发的是 `points: []`。
  //
  // 这曾经被判成"画笔点数不合法"回 400：抬笔不影响画面，客户端也不看回包，
  // 所以从界面到测试都没露馅 —— 但每画一笔服务端就记一条假错误。
  const finish = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'end',
    strokeId: 's1',
    points: [],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
  })
  assert(finish.status === 200, '抬笔（end 不带点）被接受')

  // 校验：坐标越界 / 非法颜色 / 点数超限
  const badXY = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'points', strokeId: 's1', points: [{ x: 5000, y: 0 }], color: '#ff0000', width: 4, tool: 'pen',
  })
  assert(badXY.status === 400, '坐标越界被拒')

  const badColor = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin', strokeId: 's2', points: [{ x: 1, y: 1 }], color: 'red', width: 4, tool: 'pen',
  })
  assert(badColor.status === 400, '非十六进制颜色被拒')

  const badPoints = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'points', strokeId: 's1',
    points: Array.from({ length: 201 }, (_, i) => ({ x: i % 1000, y: i % 1000 })),
    color: '#ff0000', width: 4, tool: 'pen',
  })
  assert(badPoints.status === 400, '单次点数超限被拒')

  // 猜者拿到的画布能看到画家的笔画（补发接口）
  const canvas = await bob(`/api/games/draw/rooms/${room.id}/canvas`, 'GET')
  assert(canvas.status === 200, '补发接口可达')
  assert(
    Array.isArray(canvas.body?.strokes) && canvas.body.strokes.some((s) => s.strokeId === 's1'),
    '画布缓冲里有那一笔',
    `${canvas.body?.strokes?.length ?? 0} 笔`,
  )

  const clear = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'clear', strokeId: '', points: [], color: '#000000', width: 4, tool: 'pen',
  })
  assert(clear.status === 200, '清空画布')
  const canvasAfter = await bob(`/api/games/draw/rooms/${room.id}/canvas`, 'GET')
  eq(canvasAfter.body?.strokes?.length, 0, '清空后缓冲为空')
}

console.log('\n【猜词与计分】')

{
  // 画家在绘画阶段发文字被拒
  const painterChat = await alice(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: '提示一下' })
  assert(painterChat.status === 400, '回合内画家不能用文字交流')

  // 猜错：进聊天流
  const wrong = await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: '画的是锅吗' })
  assert(wrong.status === 200, '猜错被接受')
  eq(wrong.body?.correct, false, '猜错标记')
  const chatAfterWrong = (await currentWordOf(bob, room.id))?.chat ?? []
  assert(chatAfterWrong.some((m) => m.text === '画的是锅吗'), '猜错的话进了房内聊天流')

  // 猜对：计分
  const correct = await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: answer })
  assert(correct.status === 200, '猜对被接受')
  eq(correct.body?.correct, true, '猜对标记')
  const bobAfter = (await currentWordOf(bob, room.id))?.view?.players?.find((p) => p.userId === bobUser.id)
  assert(bobAfter?.score >= 100, '猜对者得分', `${bobAfter?.score}`)
  const aliceAfter = (await currentWordOf(alice, room.id))?.view?.players?.find((p) => p.userId === aliceUser.id)
  assert(aliceAfter?.score >= 50, '画家按比例得分', `${aliceAfter?.score}`)
  eq(bobAfter?.guessed, true, '猜对状态落位')
  // 猜对后能看到词了
  const bobView = await currentWordOf(bob, room.id)
  eq(bobView?.view?.word, answer, '猜对者看到完整词')
  const carolView = await currentWordOf(carol, room.id)
  eq(carolView?.view?.word, null, '⚠️ 未猜对的丙依然拿不到词')

  // 丙也猜对 → 全对，进入 reveal
  const correct2 = await carol(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: ` ${answer} ` })
  assert(correct2.status === 200, '丙猜对（带空白归一化）')
  eq(correct2.body?.allGuessed, true, '全员猜对标记')
  const revealed = await currentWordOf(alice, room.id)
  eq(revealed?.view?.phase, 'reveal', '全对立即进入展示阶段')

  // 重复猜不重复计分
  const scoreBefore = (await currentWordOf(bob, room.id))?.view?.players?.find((p) => p.userId === bobUser.id)?.score
  const dup = await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: answer })
  const scoreAfter = (await currentWordOf(bob, room.id))?.view?.players?.find((p) => p.userId === bobUser.id)?.score
  eq(scoreAfter, scoreBefore, '重复猜对不重复计分')
}

console.log('\n【超时推进】')

{
  // reveal 展示完 → 回合轮转（1 轮 3 人，还有 2 人没画）→ choosing
  hurryPhaseEnds(room.id, 300)
  await sleep(3200)
  const advanced = await currentWordOf(alice, room.id)
  assert(
    advanced?.view?.phase === 'choosing' || advanced?.view?.phase === 'reveal',
    '展示结束自动轮转到下一个画家',
    advanced?.view?.phase,
  )
  eq(advanced?.view?.drawerIndex, 1, '画家轮到乙')

  // 乙不选词，等选词超时 → 服务端随机选
  hurryPhaseEnds(room.id, 300)
  await sleep(3200)
  const autoChosen = await currentWordOf(alice, room.id)
  eq(autoChosen?.view?.phase, 'drawing', '选词超时自动选词进入绘画')

  // 绘画超时 → reveal（没人猜对，画家 0 分）
  hurryPhaseEnds(room.id, 300)
  await sleep(3200)
  const drawnOut = await currentWordOf(alice, room.id)
  eq(drawnOut?.view?.phase, 'reveal', '绘画超时进入展示')

  // 把剩余两个回合全部 hurry 到结束 → finished
  for (let i = 0; i < 8; i++) {
    const st = await currentWordOf(alice, room.id)
    if (st?.view?.phase === 'finished') break
    hurryPhaseEnds(room.id, 200)
    await sleep(2600)
  }
  const finished = await currentWordOf(alice, room.id)
  eq(finished?.view?.phase, 'finished', '一局跑完进入结算')
  assert(Array.isArray(finished?.view?.result?.ranking), '有结算排名')
  eq(finished?.view?.result?.ranking?.length, 3, '排名包含 3 人')
}

console.log('\n【实时同步与回合清屏】')

{
  // 独立开一局，避免和上面那局的时序纠缠
  const created = await alice('/api/games/draw/rooms', 'POST', { title: '实时同步测试', rounds: 1 })
  const room3 = created.body?.room
  await bob(`/api/games/draw/rooms/${room3.id}/join`, 'POST', {})
  await alice(`/api/games/draw/rooms/${room3.id}/start`, 'POST', {})
  const drawerView = await currentWordOf(alice, room3.id)
  const word = drawerView?.view?.wordChoices?.[0]
  await alice(`/api/games/draw/rooms/${room3.id}/word`, 'POST', { word })

  // 乙挂 SSE 长连接（模拟"另一个人开着画桌"）
  const controller = new AbortController()
  const sseRes = await fetch(`${BASE}/api/chat/stream`, {
    headers: { cookie: bob.currentCookie(), accept: 'text/event-stream' },
    signal: controller.signal,
  })
  assert(sseRes.status === 200, '乙建立了 SSE 长连接')

  const chunks = []
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  const readLoop = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // abort 时会抛，正常
    }
  })()
  await sleep(600)

  // 甲画一笔 → 乙应该实时收到 draw-stroke
  await alice(`/api/games/draw/rooms/${room3.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 'rt1',
    points: [{ x: 120, y: 300 }],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
  })
  await sleep(1200)
  const stream = chunks.join('')
  assert(stream.includes('event: draw-stroke'), '乙实时收到了画笔事件（不用刷新）')

  // payload 形状是这次 bug 的核心：服务端必须把 from 平铺进 op，
  // 而不是包成 { from, op } —— 包一层的话前端的 op.op 恒为 undefined，
  // begin/points/clear 所有分支都不匹配，笔迹被静默丢弃。
  const payloads = stream
    .split('\n')
    .filter((l) => l.startsWith('data:') && l.includes('strokeId":"rt1"'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
  assert(payloads.length >= 1, '收到至少一条笔迹载荷', `${payloads.length} 条`)
  if (payloads.length > 0) {
    const p = payloads[0]
    eq(p.op, 'begin', '载荷是平铺的 op（不是 { from, op } 包了一层）')
    assert(typeof p.from === 'string' && p.from.length > 0, '载荷带发起人 from', String(p.from))
    assert(Array.isArray(p.points) && p.points.length === 1, '载荷带坐标')
  }

  // 回合轮转 → 画布缓冲必须清空（"每到下一题应该清空画布"）
  const canvasBefore = await bob(`/api/games/draw/rooms/${room3.id}/canvas`, 'GET')
  assert((canvasBefore.body?.strokes?.length ?? 0) >= 1, '轮转前画布上有这一笔')

  hurryPhaseEnds(room3.id, 300)
  await sleep(3200) // drawing → reveal
  hurryPhaseEnds(room3.id, 300)
  await sleep(3200) // reveal → 下一个画家（新回合）

  const afterTurn = await currentWordOf(alice, room3.id)
  assert(
    afterTurn?.view?.phase === 'choosing' || afterTurn?.view?.phase === 'drawing',
    '回合已轮转',
    afterTurn?.view?.phase,
  )
  const canvasAfter = await bob(`/api/games/draw/rooms/${room3.id}/canvas`, 'GET')
  eq(canvasAfter.body?.strokes?.length, 0, '新回合的画布缓冲已清空')

  // 轮转时服务端还广播了一次 clear（客户端据此清屏）
  await sleep(400)
  controller.abort()
  await readLoop
  const after = chunks.join('')
  assert(after.includes('"op":"clear"'), '回合轮转时广播了 clear（客户端清屏）')

  // 收尾
  await alice(`/api/games/draw/rooms/${room3.id}/leave`, 'POST', {})
  await bob(`/api/games/draw/rooms/${room3.id}/leave`, 'POST', {})
}

console.log('\n【历史对局存档】')

{
  // 前面那局已经打完了（rounds=1，3 个人），应该留下了每回合的记录
  const history = await alice('/api/games/draw/history', 'GET')
  assert(history.status === 200, '历史列表可访问')
  const items = history.body?.rooms ?? []
  const mine = items.find((r) => r.roomId === room.id)
  assert(!!mine, '刚打完的那局出现在历史里', `${items.length} 局`)
  if (mine) {
    assert(mine.roundCount >= 1, '历史里带回合数', `${mine.roundCount} 回合`)
    assert(Array.isArray(mine.ranking) && mine.ranking.length === 3, '历史里带排名')
    assert(typeof mine.finishedAt === 'number' && mine.finishedAt > 0, '历史里带结束时间')
  }

  const detail = await alice(`/api/games/draw/history/${room.id}`, 'GET')
  assert(detail.status === 200, '历史详情可访问')
  const rounds = detail.body?.detail?.rounds ?? []
  assert(rounds.length >= 1, '详情里有回合记录', `${rounds.length} 个回合`)
  if (rounds.length > 0) {
    const first = rounds[0]
    assert(typeof first.word === 'string' && first.word.length > 0, '每个回合记着画的是什么词', first.word)
    assert(typeof first.drawerName === 'string' && first.drawerName.length > 0, '每个回合记着是谁画的', first.drawerName)
    assert(Array.isArray(first.strokes), '每个回合带笔画数据')
    assert(Array.isArray(first.results), '每个回合带结果')
  }

  // ---- 打完就退：这一局不该从历史里消失 ----
  //
  // 真实用法是"打完 → 各自点返回大厅 → 关掉页面"，最后一个人退出会走到
  // leaveDrawRoom 里"人走光了"那个分支。那里过去是无条件删 game_rooms 行，
  // 而历史列表正是从这张表读的 —— 实测一退房，刚打完的那局就从历史里消失，
  // 存档还躺在 draw_rounds 里成为孤儿。下面几条钉住的就是这个场景。
  await alice(`/api/games/draw/rooms/${room.id}/leave`, 'POST', {})
  await bob(`/api/games/draw/rooms/${room.id}/leave`, 'POST', {})
  const lastLeave = await carol(`/api/games/draw/rooms/${room.id}/leave`, 'POST', {})
  assert(lastLeave.status === 404, '最后一人退出：按"房间结束"约定返回 404', `${lastLeave.status}`)

  const afterLeave = await alice('/api/games/draw/history', 'GET')
  assert(
    (afterLeave.body?.rooms ?? []).some((r) => r.roomId === room.id),
    '⚠️ 全员退房后，这一局仍在历史里',
  )
  const afterDetail = await alice(`/api/games/draw/history/${room.id}`, 'GET')
  assert(afterDetail.status === 200, '退房后历史详情仍打得开', `${afterDetail.status}`)
  assert((afterDetail.body?.detail?.rounds ?? []).length >= 1, '退房后回合存档还在')

  // 上面那局画完被 clear 过（画笔用例的收尾），画布本来就空 —— 所以"存下了画"
  // 用一局干净的来验：真画一笔、真超时，再回头看存档里有没有那一笔。
  const archiveRoom = await alice('/api/games/draw/rooms', 'POST', { title: '存档验证局', rounds: 1 })
  const archiveId = archiveRoom.body?.room?.id
  assert(!!archiveId, '开了存档验证局')
  await bob(`/api/games/draw/rooms/${archiveId}/join`, 'POST', {})
  await alice(`/api/games/draw/rooms/${archiveId}/start`, 'POST', {})
  const archiveView = await currentWordOf(alice, archiveId)
  const archiveWord = archiveView?.view?.wordChoices?.[0]
  await alice(`/api/games/draw/rooms/${archiveId}/word`, 'POST', { word: archiveWord })
  await alice(`/api/games/draw/rooms/${archiveId}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 'arch1',
    points: [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { x: 300, y: 150 },
    ],
    color: '#123456',
    width: 6,
    tool: 'pen',
  })
  // 绘画超时 → beginReveal → 存档
  hurryPhaseEnds(archiveId, 300)
  await sleep(3200)

  const archived = await alice(`/api/games/draw/history/${archiveId}`, 'GET')
  const archivedRounds = archived.body?.detail?.rounds ?? []
  assert(archivedRounds.length === 1, '验证局存下了 1 个回合', `${archivedRounds.length} 个`)
  if (archivedRounds.length > 0) {
    const r0 = archivedRounds[0]
    eq(r0.word, archiveWord, '存档记着当时的词')
    eq(r0.drawerName, '画师甲', '存档记着画家是谁')
    assert(r0.strokes.length >= 1, '存档里存下了那一笔', `${r0.strokes.length} 笔`)
    if (r0.strokes.length > 0) {
      assert(r0.strokes[0].points.length >= 3, '笔画点是完整的', `${r0.strokes[0].points.length} 个点`)
      eq(r0.strokes[0].color, '#123456', '颜色也存下来了')
    }
    assert(Array.isArray(r0.results) && r0.results.length === 1, '存档里有另一个人的结果')
  }

  // 回合数上限放宽到 10
  const big = await alice('/api/games/draw/rooms', 'POST', { title: '十轮局', rounds: 10 })
  eq(big.body?.room?.view?.totalRounds, 10, '轮数可以开到 10')
  const tooBig = await alice('/api/games/draw/rooms', 'POST', { title: '超限局', rounds: 99 })
  eq(tooBig.body?.room?.view?.totalRounds, 10, '超过 10 轮被收敛到 10')
  await alice(`/api/games/draw/rooms/${big.body?.room?.id}/leave`, 'POST', {})
  await alice(`/api/games/draw/rooms/${tooBig.body?.room?.id}/leave`, 'POST', {})

  // 未登录看历史
  const anon = makeClient()
  const anonRes = await anon('/api/games/draw/history', 'GET')
  assert(anonRes.status === 401, '未登录不能看历史')
}

console.log('\n【历史保留策略】')

{
  const FINISHED = `SELECT COUNT(*) AS n FROM game_rooms WHERE kind='draw' AND status='finished'`
  const REAL_FINISHED = `SELECT COUNT(*) AS n FROM game_rooms WHERE kind='draw' AND status='finished' AND id NOT LIKE 'room_old_%'`
  const FAKE_FINISHED = `SELECT COUNT(*) AS n FROM game_rooms WHERE kind='draw' AND status='finished' AND id LIKE 'room_old_%'`

  // 造 205 局"90 天前"的完成局（每局一条存档），把总量顶过 200 这条线。
  // 直接写库是刻意的：真打 205 局要几个小时，而这里要验的是"修剪"这件事，
  // 不是"游戏怎么结束的"（那部分上面已经验过了）。
  const base = Date.now() - 90 * 24 * 3600 * 1000
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
  const insRoom = db.prepare(
    `INSERT INTO game_rooms (id, kind, title, status, created_by, board, turn, moves, result,
                             created_at, updated_at, finished_at, state)
     VALUES (?, 'draw', ?, 'finished', ?, '', 'red', '[]', ?, ?, ?, ?, '{}')`,
  )
  const insRound = db.prepare(
    `INSERT INTO draw_rounds (id, room_id, round_no, turn_no, drawer_id, drawer_name, word,
                              strokes, results, started_at, ended_at)
     VALUES (?, ?, 1, 1, ?, '画师甲', '猫', '[]', '[]', ?, ?)`,
  )
  for (let i = 0; i < 205; i++) {
    const at = base + i * 1000
    insRoom.run(`room_old_${i}`, `老局 ${i}`, aliceUser.id, JSON.stringify({ ranking: [] }), at, at, at)
    insRound.run(`round_old_${i}`, `room_old_${i}`, aliceUser.id, at, at)
  }
  db.close()

  const before = countRows(FINISHED)
  assert(before > 200, '造出多于 200 局的局面', `${before} 局`)

  // 打开历史列表 = 修剪（见 pruneDrawHistory 的注释：唯一的写入方就是这里）
  const hist = await alice('/api/games/draw/history', 'GET')
  assert(hist.status === 200, '打开历史成功（顺带修剪）')

  const after = countRows(FINISHED)
  const real = countRows(REAL_FINISHED)
  const fakeKept = countRows(FAKE_FINISHED)
  eq(after, 200, '历史只保留最近 200 局')
  eq(fakeKept, 200 - real, '老局按时间从旧到新清，留最新的')
  eq(countRows(`SELECT COUNT(*) AS n FROM game_rooms WHERE id = 'room_old_0'`), 0, '最老的那局被清掉')
  eq(countRows(`SELECT COUNT(*) AS n FROM game_rooms WHERE id = 'room_old_204'`), 1, '最新的那局还在')
  eq(
    countRows(`SELECT COUNT(*) AS n FROM draw_rounds WHERE room_id LIKE 'room_old_%'`),
    200 - real,
    '存档跟着房间一起清',
  )
  eq(
    countRows(`SELECT COUNT(*) AS n FROM draw_rounds WHERE room_id NOT IN (SELECT id FROM game_rooms)`),
    0,
    '库里的孤儿存档为 0',
  )
}

console.log('\n【旁观者实时同步】')

{
  // 真实场景：一局已经在画了，第三个人在房间里只"看"不加入（onEnterRoom
  // 在 phase !== waiting 时只 GET 房间，不 join）。他不是 players，
  // 以前不在任何推送名单里 —— 进入时 pullCanvas 拿到一帧快照，之后永不更新。
  const created = await alice('/api/games/draw/rooms', 'POST', { title: '旁观测试', rounds: 1 })
  const room = created.body?.room
  await bob(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  await alice(`/api/games/draw/rooms/${room.id}/start`, 'POST', {})
  const dv = await currentWordOf(alice, room.id)
  const word = dv?.view?.wordChoices?.[0]
  assert(typeof word === 'string' && word.length > 0, '画家拿到了候选词')
  await alice(`/api/games/draw/rooms/${room.id}/word`, 'POST', { word })

  // carol 全程没有 join —— 她是旁观者
  const peek = await carol(`/api/games/draw/rooms/${room.id}`, 'GET')
  eq(peek.status, 200, '非成员可以打开进行中的房间（旁观）')
  eq(peek.body?.room?.view?.iAmDrawer, false, '旁观者不是画家')
  eq(peek.body?.room?.view?.word, null, '旁观者看不到答案词')
  eq(peek.body?.room?.view?.wordChoices, [], '旁观者拿不到候选词')

  const watchRes = await carol(`/api/games/draw/rooms/${room.id}/watch`, 'POST', {})
  eq(watchRes.status, 200, '旁观者登记观看')
  eq(watchRes.body?.room?.view?.word, null, 'watch 返回的也是安全的观战视图')

  // 旁观者只读：不能往房内聊天注入文本
  const chatBefore = (await bob(`/api/games/draw/rooms/${room.id}`, 'GET')).body?.room?.chat?.length ?? 0
  const denied = await carol(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: '我来喊个答案' })
  eq(denied.status, 403, '旁观者不能发言（403）')
  const chatAfter = (await bob(`/api/games/draw/rooms/${room.id}`, 'GET')).body?.room?.chat?.length ?? 0
  eq(chatAfter, chatBefore, '旁观者的发言没有进入聊天流')

  const controller = new AbortController()
  const sseRes = await fetch(`${BASE}/api/chat/stream`, {
    headers: { cookie: carol.currentCookie(), accept: 'text/event-stream' },
    signal: controller.signal,
  })
  assert(sseRes.status === 200, '旁观者建立 SSE 长连接')
  const chunks = []
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // abort 时正常
    }
  })()
  await sleep(600)

  // 画家画一笔 → 旁观者必须实时收到
  await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 'sp1',
    points: [{ x: 120, y: 300 }],
    color: '#ff0000',
    width: 4,
    tool: 'pen',
    origin: 'device-a',
  })
  await sleep(1000)
  let stream = chunks.join('')
  assert(stream.includes('event: draw-stroke'), '旁观者实时收到画笔事件（不再停在第一帧）')
  const strokePayload = stream
    .split('\n')
    .filter((l) => l.startsWith('data:') && l.includes('"strokeId":"sp1"'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .pop()
  eq(strokePayload?.roomId, room.id, '画笔事件带 roomId（多画桌窗口不串台）')
  eq(strokePayload?.origin, 'device-a', '画笔事件回显设备标识（同账号多设备的回声过滤）')

  // 房间状态（阶段/聊天/分数）也要到旁观者
  await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: '随便猜一句' })
  await sleep(800)
  stream = chunks.join('')
  assert(stream.includes('event: game-draw'), '旁观者收到房间状态推送')

  // unwatch 之后不再收笔迹（服务端 90s TTL 的主动版本）。
  // ⚠️ 必须放在"猜对"之前：两人房里唯一猜者猜对会立刻 reveal，之后
  // submitStroke 会被 400 拒绝，这条断言就变成真空通过了。
  await carol(`/api/games/draw/rooms/${room.id}/unwatch`, 'POST', {})
  const beforeCount = (chunks.join('').match(/event: draw-stroke/g) ?? []).length
  const strokeAfterUnwatch = await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 'sp2',
    points: [{ x: 200, y: 200 }],
    color: '#00ff00',
    width: 4,
    tool: 'pen',
  })
  eq(strokeAfterUnwatch.status, 200, '取消观看时画家仍在正常作画（不是阶段问题）')
  await sleep(1000)
  const afterCount = (chunks.join('').match(/event: draw-stroke/g) ?? []).length
  eq(afterCount, beforeCount, '取消观看后不再收到画笔事件')

  // 重新登记后恢复
  await carol(`/api/games/draw/rooms/${room.id}/watch`, 'POST', {})
  await alice(`/api/games/draw/rooms/${room.id}/strokes`, 'POST', {
    op: 'begin',
    strokeId: 'sp3',
    points: [{ x: 300, y: 300 }],
    color: '#0000ff',
    width: 4,
    tool: 'pen',
  })
  await sleep(1000)
  assert(
    (chunks.join('').match(/event: draw-stroke/g) ?? []).length > afterCount,
    '重新登记观看后恢复接收画笔',
  )

  // 泄题回归：猜中的原文就是答案，它**不能存进 chat**。
  // 注意 reveal 阶段答案本来就会公开给所有人（view.word），所以这里只断言
  // chat 里的 correct 消息——那是会被 listDrawRooms 带给大厅的部分。
  await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: word })
  await sleep(800)
  stream = chunks.join('')
  const pushedChat = stream
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .flatMap((p) => p.room?.chat ?? [])
  const correctMsgs = pushedChat.filter((m) => m.correct)
  assert(correctMsgs.length > 0, '旁观者收到了"猜对了"消息')
  assert(correctMsgs.every((m) => m.text === ''), '猜中的答案原文没有存进 chat')

  const lobby = await carol('/api/games/draw/rooms', 'GET')
  const listed = lobby.body?.rooms?.find((r) => r.id === room.id)
  // 空数组上的 every() 会真空通过，所以直接断言"大厅列表根本不带 chat"
  assert(
    Array.isArray(listed?.chat) && listed.chat.length === 0,
    '大厅列表不携带 chat（收窄泄题面）',
    JSON.stringify(listed?.chat),
  )

  // 房间解散：最后一名玩家离开 → 删行 → 旁观者必须收到 room:null，
  // 否则界面会停在一个已经不存在的房间上。
  await carol(`/api/games/draw/rooms/${room.id}/watch`, 'POST', {})
  await alice(`/api/games/draw/rooms/${room.id}/leave`, 'POST', {})
  await bob(`/api/games/draw/rooms/${room.id}/leave`, 'POST', {})
  await sleep(1200)
  const finalStream = chunks.join('')
  assert(finalStream.includes('"room":null'), '房间解散时旁观者收到 room:null')

  controller.abort()
}

console.log('\n【猜词聊天不泄题】')

{
  // 三个玩家：bob 猜对后 carol 还没猜，回合继续（如果只有两个玩家，
  // 唯一的猜者猜对就会 allGuessed → reveal，答案本来就会公开）。
  const created = await alice('/api/games/draw/rooms', 'POST', { title: '泄题测试', rounds: 1 })
  const room = created.body?.room
  await bob(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  await carol(`/api/games/draw/rooms/${room.id}/join`, 'POST', {})
  await alice(`/api/games/draw/rooms/${room.id}/start`, 'POST', {})
  const dv = await currentWordOf(alice, room.id)
  const word = dv?.view?.wordChoices?.[0]
  assert(typeof word === 'string' && word.length > 0, '画家拿到了候选词（泄题用例）')
  await alice(`/api/games/draw/rooms/${room.id}/word`, 'POST', { word })

  const guessed = await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: word })
  eq(guessed.body?.correct, true, 'bob 猜对了')
  eq((await currentWordOf(alice, room.id))?.view?.phase, 'drawing', 'carol 还没猜，回合继续')

  // 关键回归：已经猜对的玩家再发一次答案，applyGuess 会早退返回
  // correct=false —— 以前它会走普通 appendChat，把答案原文写进共享 chat。
  await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: word })
  // 带前后缀的答案同样不能落进 chat（close/子串匹配）
  await bob(`/api/games/draw/rooms/${room.id}/guess`, 'POST', { text: `答案是${word}` })

  const asCarol = await carol(`/api/games/draw/rooms/${room.id}`, 'GET')
  const chat = asCarol.body?.room?.chat ?? []
  assert(!JSON.stringify(chat).includes(word), '未猜对的玩家在 chat 里看不到答案原文')

  const lobby = await carol('/api/games/draw/rooms', 'GET')
  const listed = lobby.body?.rooms?.find((x) => x.id === room.id)
  assert(Array.isArray(listed?.chat) && listed.chat.length === 0, '大厅列表不携带聊天内容')
}

console.log('\n【退房与解散】')

{
  // 新开一局验证退房语义（上一局已 finished）
  const created = await alice('/api/games/draw/rooms', 'POST', { title: '退房测试' })
  const room2 = created.body?.room
  await bob(`/api/games/draw/rooms/${room2.id}/join`, 'POST', {})

  const left = await bob(`/api/games/draw/rooms/${room2.id}/leave`, 'POST', {})
  assert(left.status === 200, 'waiting 阶段退房')
  const afterLeft = await currentWordOf(alice, room2.id)
  eq(afterLeft?.view?.players?.length, 1, '房里只剩房主')

  // 最后一人退房 → 房间解散（404）
  const last = await alice(`/api/games/draw/rooms/${room2.id}/leave`, 'POST', {})
  assert(last.status === 404, '最后一人退房即解散')
  const gone = await alice(`/api/games/draw/rooms/${room2.id}`, 'GET')
  assert(gone.status === 404, '解散后房间不存在')
}

function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(name)
  else bad(name, `期望 ${b}，实际 ${a}`)
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
