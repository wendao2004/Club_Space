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
  return async function request(path, method = 'GET', body) {
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
