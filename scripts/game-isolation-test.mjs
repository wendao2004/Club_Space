/**
 * 三种游戏**共存**时的隔离测试。
 *
 * ⚠️ 这个文件是为一个线上事故补的，而它的教训比 bug 本身更重要：
 *
 * 象棋、斗地主、狼人杀共用 `game_rooms` 一张表，但 `board` 列的含义不同 ——
 * 象棋写的是一局棋盘，另外两个写的是**空串**（它们的局面在 state 列里）。
 *
 * 象棋的房间列表当初没有按 kind 过滤，于是会把斗地主/狼人杀的房间也拿去做
 * `deserializeBoard('')`，而 `''.split('/')` 只有 1 段 —— 直接抛异常，
 * **整个象棋大厅接口 500**。用户看到的是"象棋打开就报服务器内部出错"，
 * 而根因是隔壁那张斗地主的桌子。
 *
 * 为什么原来的测试没抓到：`games-test.mjs`、`doudizhu-room-test.mjs`、
 * `werewolf-route-test.mjs` 各自跑在**全新的空库**上，库里永远只有自己这一种房间。
 * **单独测每一个都全绿，合在一起才炸** —— 这是典型的集成缺陷，
 * 必须专门写一条"让三种房间同时存在"的测试才守得住。
 *
 * 用法：由 scripts/run-all-tests.mjs 启动服务端后运行。
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
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

async function main() {
  console.log(`\n\x1b[1m三种游戏共存时的隔离\x1b[0m  目标 ${BASE}\n`)

  const c = makeClient()
  const reg = await c.api('/api/auth/register', {
    method: 'POST',
    json: { username: `gio${SUFFIX}`, displayName: '隔离测试', password: 'game-isolation-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册账号')

  // ---------------------------------------------------------------- 三种房间
  console.log('\n【先各建一个房间，让三种数据同时躺在 game_rooms 里】')

  const xq = await c.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '隔离测试棋局', side: 'red' },
  })
  assert(xq.status === 200, '建象棋房间', `状态 ${xq.status}`)
  const xqId = xq.body.room?.id

  const ddz = await c.api('/api/games/doudizhu/rooms', { method: 'POST', json: { title: '隔离测试牌局' } })
  assert(ddz.status === 200, '建斗地主房间', `状态 ${ddz.status}`)
  const ddzId = ddz.body.room?.id

  const ww = await c.api('/api/games/werewolf/rooms', { method: 'POST', json: { title: '隔离测试狼人局' } })
  assert(ww.status === 200, '建狼人杀房间', `状态 ${ww.status}`)
  const wwId = ww.body.room?.id

  assert(!!xqId && !!ddzId && !!wwId, '三个房间都建出来了', `${xqId} / ${ddzId} / ${wwId}`)

  // ---------------------------------------------------------------- 象棋大厅
  // 这一条就是那次线上事故的直接回归。
  console.log('\n【象棋大厅（这里曾经 500）】')
  const xqList = await c.api('/api/games/rooms')
  assert(
    xqList.status === 200,
    '象棋房间列表返回 200（库里躺着另外两种游戏的房间时也不能炸）',
    `状态 ${xqList.status}：${typeof xqList.body === 'string' ? String(xqList.body).slice(0, 120) : ''}`,
  )
  const xqRooms = xqList.body?.rooms ?? []
  assert(
    xqRooms.some((r) => r.id === xqId),
    '自己的棋局在列表里',
    `${xqRooms.length} 个`,
  )
  assert(
    xqRooms.every((r) => r.kind === 'xiangqi'),
    '列表里**只有**象棋房间（没有把斗地主/狼人杀混进来）',
    xqRooms.map((r) => r.kind).join('、') || '(空)',
  )
  assert(
    !xqRooms.some((r) => r.id === ddzId || r.id === wwId),
    '另外两个房间确实被挡住了',
  )
  assert(
    xqRooms.every((r) => typeof r.board === 'string' && r.board.split('/').length === 10),
    '每个房间的棋盘都能正常解析（10 行）',
  )

  // ---------------------------------------------------------------- 另外两个大厅
  console.log('\n【另外两个大厅也要各自干净】')
  const ddzList = await c.api('/api/games/doudizhu/rooms')
  assert(ddzList.status === 200, '斗地主房间列表可读')
  assert(
    (ddzList.body?.rooms ?? []).every((r) => r.kind === 'doudizhu'),
    '斗地主列表里只有斗地主房间',
    (ddzList.body?.rooms ?? []).map((r) => r.kind).join('、'),
  )
  assert(
    (ddzList.body?.rooms ?? []).some((r) => r.id === ddzId),
    '自己的牌局在列表里',
  )

  const wwList = await c.api('/api/games/werewolf/rooms')
  assert(wwList.status === 200, '狼人杀房间列表可读')
  assert(
    (wwList.body?.rooms ?? []).every((r) => r.kind === 'werewolf'),
    '狼人杀列表里只有狼人杀房间',
    (wwList.body?.rooms ?? []).map((r) => r.kind).join('、'),
  )
  assert(
    (wwList.body?.rooms ?? []).some((r) => r.id === wwId),
    '自己的狼人局在列表里',
  )

  // ---------------------------------------------------------------- 交叉访问
  console.log('\n【拿别的游戏的房间 id 打错接口】')
  const crossDdz = await c.api(`/api/games/rooms/${ddzId}`)
  assert(
    crossDdz.status === 404,
    '用斗地主的房间 id 查象棋房间 → 404（不是 500，也不是别人的牌局）',
    `状态 ${crossDdz.status}`,
  )
  const crossWw = await c.api(`/api/games/rooms/${wwId}`)
  assert(crossWw.status === 404, '用狼人杀的房间 id 查象棋房间 → 404', `状态 ${crossWw.status}`)
  const crossXq = await c.api(`/api/games/doudizhu/rooms/${xqId}`)
  assert(
    crossXq.status === 404,
    '反过来也不行：用象棋的房间 id 查斗地主房间 → 404',
    `状态 ${crossXq.status}`,
  )

  // ---------------------------------------------------------------- 象棋仍然可用
  console.log('\n【象棋本身仍然能用（别为了修列表把玩法修坏了）】')
  const reload = await c.api(`/api/games/rooms/${xqId}`)
  assert(reload.status === 200, '还能打开自己的棋局')
  // 只有一个人时对局处于 waiting，myTurn 本来就该是 false —— 拉个对手进来才有对局可言
  assert(
    reload.body.room?.mySide === 'red' && reload.body.room?.myTurn === false,
    '我一个人时视角正确（坐红方，但还没开局，轮不到我）',
    `mySide=${reload.body.room?.mySide} turn=${reload.body.room?.turn} myTurn=${reload.body.room?.myTurn}`,
  )

  const inv = await c.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const rival = makeClient()
  const rreg = await rival.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `gir${SUFFIX}`,
      displayName: '对手',
      password: 'game-isolation-2026',
      inviteCode: inv.body.code,
    },
  })
  assert(rreg.status === 200 || rreg.status === 201, '注册第二个账号')
  const rjoin = await rival.api(`/api/games/rooms/${xqId}/join`, { method: 'POST', json: { side: 'black' } })
  assert(rjoin.status === 200, '对手坐下（执黑）', `状态 ${rjoin.status}`)
  assert(rjoin.body.room?.status === 'playing', '对局进入进行中', `status=${rjoin.body.room?.status}`)

  const mine = await c.api(`/api/games/rooms/${xqId}`)
  assert(
    mine.body.room?.myTurn === true,
    '人齐之后轮到我走（视角按人算对了）',
    `myTurn=${mine.body.room?.myTurn}`,
  )
  const rivalView = await rival.api(`/api/games/rooms/${xqId}`)
  assert(
    rivalView.body.room?.mySide === 'black' && rivalView.body.room?.myTurn === false,
    '对手看到的是他自己那一侧、且不该轮到他 —— 两个人拿到的是各自的视角',
    `mySide=${rivalView.body.room?.mySide} myTurn=${rivalView.body.room?.myTurn}`,
  )

  const legal = await c.api(`/api/games/rooms/${xqId}/legal?from=b2`)
  assert(legal.status === 200, '还能查合法着法', `状态 ${legal.status}`)
  assert((legal.body.targets ?? []).length > 0, '炮二有落点', `${legal.body.targets?.length} 个`)

  // 真走一步，确认对局可以推进
  const move = await c.api(`/api/games/rooms/${xqId}/move`, { method: 'POST', json: { from: 'b2', to: 'e2' } })
  assert(move.status === 200, '能走棋', `状态 ${move.status} ${JSON.stringify(move.body).slice(0, 100)}`)
  const afterMove = await c.api('/api/games/rooms')
  assert(afterMove.status === 200, '走完棋后大厅依然正常（棋盘序列化往返没坏）')
  assert(
    (afterMove.body?.rooms ?? []).every((r) => r.kind === 'xiangqi'),
    '走棋之后列表仍然只有象棋房间',
  )

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
