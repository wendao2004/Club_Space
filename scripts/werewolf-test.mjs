/**
 * 狼人杀规则引擎 + 房间状态机测试。
 *
 * 分两层：
 *
 *  1. **纯逻辑**（直接 import werewolf.ts，无需数据库）：
 *     身份分配、隐藏信息裁剪、合法行动矩阵、胜负边界、整局自动跑完、超时兜底。
 *
 *  2. **房间层**（动态 import werewolf-rooms.ts，需要一个临时 SQLite）：
 *     建房/加入/开局、按视角裁剪的端到端验证、一次完整的夜晚+投票、离开与超时。
 *
 * 最核心的一组断言是**隐藏信息**：狼人杀不是"看不到手牌"，而是"看不到别人是谁"。
 * 所以这里对每个玩家的 view 做**逐字段扫描**（不是抽查几个字段）：把 view 序列化后
 * 递归找出所有出现的身份字符串，断言它们**只能出现在** `myRole`、`myRoleLabel`
 * 和公开的板子构成 `board[*]` 里 —— 换句话说，别人的身份一个字段都不许有。
 *
 * 用法：node scripts/werewolf-test.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_PLAYER_COUNT,
  MIN_PLAYER_COUNT,
  addChatMessage,
  advance,
  applyHunterShot,
  applySeerCheck,
  applyVote,
  applyWitch,
  applyWolfKill,
  assignRoles,
  boardFor,
  canSeeWolfChat,
  canSendChat,
  chatScope,
  checkWin,
  countOfRole,
  createGameState,
  createWaitingState,
  isValidPlayerCount,
  legalActions,
} from '../server/src/games/werewolf.ts'

// 让 DB 层用一个临时目录，绝不碰仓库里的 data/。
// 必须在**动态** import werewolf-rooms.ts（它会 import config.ts 读取这些环境变量）之前设置。
const TMP = mkdtempSync(join(tmpdir(), 'wl-werewolf-test-'))
process.env.WL_DATA_DIR = TMP
process.env.WL_DB_PATH = join(TMP, 'test.sqlite')
process.env.WL_SESSION_SECRET = 'werewolf-test-secret-0123456789abcdef'

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

function eq(actual, expected, name) {
  assert(actual === expected, name, `期望 ${expected}，实际 ${actual}`)
}

function arrEq(actual, expected, name) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function throws(fn, name, expectStatus) {
  try {
    fn()
  } catch (err) {
    if (expectStatus !== undefined && err.status !== expectStatus) {
      bad(name, `抛了错但状态码是 ${err.status}，期望 ${expectStatus}：${err.message}`)
      return
    }
    ok(name)
    return
  }
  bad(name, '本该抛错，但没有')
}

// ============================================================================
// 测试用的小工具
// ============================================================================

/** mulberry32：可播种的伪随机。测试里用它让"自动对局"可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const next = mulberry32(seed)
  return (max) => Math.floor(next() * max)
}

const PLAYERS = Array.from({ length: 9 }, (_, i) => `u${i}`)
/** 固定的身份布局，让纯逻辑测试能精确断言。座位 0/1/2 狼，3 预言家，4 女巫，5 猎人，6/7/8 村民。 */
const ROLES = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager']

function baseState(overrides = {}) {
  const state = createWaitingState(PLAYERS)
  state.roles = [...ROLES]
  state.alive = PLAYERS.map(() => true)
  state.phase = 'night'
  state.day = 1
  state.deadline = 1_000_000
  Object.assign(state, overrides)
  return state
}

const ROLE_STRINGS = new Set(['wolf', 'seer', 'witch', 'hunter', 'villager'])
const LABEL_STRINGS = new Set(['狼人', '预言家', '女巫', '猎人', '村民'])

/** 递归收集一个对象里所有"身份字符串"出现的路径。 */
function rolePaths(node, path = '', out = []) {
  if (typeof node === 'string') {
    if (ROLE_STRINGS.has(node) || LABEL_STRINGS.has(node)) out.push({ path, value: node })
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => rolePaths(v, `${path}[${i}]`, out))
    return out
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) rolePaths(node[key], path ? `${path}.${key}` : key, out)
  }
  return out
}

/**
 * 允许出现"身份字符串"的路径白名单。
 *   - myRole / myRoleLabel / myTeam / actionKind：都是**我自己**的信息
 *     （actionKind 只会等于自己能做的动作，非行动者的 view 里它是 null）。
 *   - myChecks[*].team：预言家**自己**查出来的阵营，是她本人的信息。
 *   - board[*]：板子构成，公开信息。
 *   - chatScope / messages[*].scope：频道标签（'wolf' / 'public'）只是"现在是不是
 *     夜里、这条发言属于哪个频道"，不是任何人的身份（夜晚的公开频道里 scope 恒为
 *     'public'；'wolf' 只会出现在狼自己的 view 里）。所以允许，但**发言正文**仍受
 *     扫描约束 —— 正文里若出现身份词会被这里抓住。
 * 任何别的路径出现身份字符串 = 泄露，测试直接失败。
 */
const ALLOWED_ROLE_PATH =
  /^(myRole|myRoleLabel|myTeam|actionKind|chatScope|board\[\d+\]\.(role|label|team)|myChecks\[\d+\]\.team|messages\[\d+\]\.scope)$/

async function main() {
  console.log('\n\x1b[1m狼人杀规则引擎 / 房间状态机测试\x1b[0m\n')

  // ==========================================================================
  console.log('【身份分配】')

  const roles = assignRoles(9)
  eq(roles.length, 9, '分配出 9 个身份')
  const counts = {}
  for (const role of roles) counts[role] = (counts[role] ?? 0) + 1
  eq(counts.wolf, 3, '狼人 3 个')
  eq(counts.seer, 1, '预言家 1 个')
  eq(counts.witch, 1, '女巫 1 个')
  eq(counts.hunter, 1, '猎人 1 个')
  eq(counts.villager, 3, '村民 3 个')

  throws(() => assignRoles(5), '5 人局被拒绝（低于下限 6）')
  throws(() => assignRoles(13), '13 人局被拒绝（高于上限 12）')
  throws(() => assignRoles(0), '0 人被拒绝')

  // 随机性：连抽 60 次，至少应出现很多种不同的排列。
  // 如果实现里退化成"每次一样"（比如忘了洗牌或种子恒定），这里会失败。
  const distinct = new Set()
  for (let i = 0; i < 60; i++) distinct.add(assignRoles(9).join(','))
  assert(distinct.size > 20, '多次分配得到的身份排列不恒定（随机性存在）', `60 次里出现 ${distinct.size} 种`)

  // 每个身份的数量恒定，但"谁拿到哪个"应当分散：统计 300 次里每个座位当狼的次数，
  // 只要不是"某个座位必是狼"就说明身份没有和座位号绑定。
  const wolfBySeat = new Array(9).fill(0)
  for (let i = 0; i < 300; i++) {
    assignRoles(9).forEach((r, seat) => {
      if (r === 'wolf') wolfBySeat[seat]++
    })
  }
  const minWolf = Math.min(...wolfBySeat)
  const maxWolf = Math.max(...wolfBySeat)
  assert(minWolf > 0 && maxWolf < 300, '身份与座位号无关（没有哪个座位固定在狼队）', `每座位当狼次数 ${minWolf}..${maxWolf}`)

  // ==========================================================================
  console.log('\n【自定义人数：6~12 人的身份配置】')

  // 逐个人数检查配置的硬性约束：总数对、好人数严格多于狼人数、恰好一名预言家。
  for (let n = MIN_PLAYER_COUNT; n <= MAX_PLAYER_COUNT; n++) {
    const board = boardFor(n)
    const total = board.reduce((sum, entry) => sum + entry.count, 0)
    const wolves = countOfRole(board, 'wolf')
    const seers = countOfRole(board, 'seer')
    const good = total - wolves
    assert(total === n, `${n} 人：配置总数 = ${n}`, `实际 ${total}`)
    assert(good > wolves, `${n} 人：好人数(${good}) 严格多于狼人数(${wolves})`)
    assert(seers === 1, `${n} 人：恰好一名预言家`, `实际 ${seers}`)
    // 确定性：同一个人数每次得到同样的配置（不能随机漂移）
    assert(JSON.stringify(boardFor(n)) === JSON.stringify(board), `${n} 人：配置确定性（两次一致）`)
  }

  // 狼人数随人数单调不减（人越多狼越多）
  let prevWolves = 0
  let monotonic = true
  for (let n = MIN_PLAYER_COUNT; n <= MAX_PLAYER_COUNT; n++) {
    const w = countOfRole(boardFor(n), 'wolf')
    if (w < prevWolves) monotonic = false
    prevWolves = w
  }
  assert(monotonic, '狼人数随人数单调不减')

  // 非法人数：boardFor 抛错；isValidPlayerCount 为 false
  throws(() => boardFor(5), 'boardFor(5) 被拒')
  throws(() => boardFor(13), 'boardFor(13) 被拒')
  throws(() => boardFor(0), 'boardFor(0) 被拒')
  assert(!isValidPlayerCount(5) && !isValidPlayerCount(13) && !isValidPlayerCount(0), '非法人数 isValidPlayerCount=false')

  // assignRoles 在每个人数下都给出该人数的配置（数量逐项吻合）
  for (let n = MIN_PLAYER_COUNT; n <= MAX_PLAYER_COUNT; n++) {
    const roles = assignRoles(n)
    const counts = {}
    for (const role of roles) counts[role] = (counts[role] ?? 0) + 1
    const board = boardFor(n)
    const matches = board.every((entry) => counts[entry.role] === entry.count)
    assert(roles.length === n && matches, `${n} 人：assignRoles 给出的人数与配置都正确`)
  }

  // 9 人局的行为一个字都不能变 —— 显式钉死历史棋盘
  assert(
    JSON.stringify(boardFor(9)) ===
      JSON.stringify([
        { role: 'wolf', count: 3 },
        { role: 'seer', count: 1 },
        { role: 'witch', count: 1 },
        { role: 'hunter', count: 1 },
        { role: 'villager', count: 3 },
      ]),
    '9 人局板子与历史完全一致（3 狼 / 预言家 / 女巫 / 猎人 / 3 村民）',
  )

  // ==========================================================================
  console.log('\n【隐藏信息（按视角裁剪）】')

  const { buildWerewolfView } = await import('../server/src/games/werewolf-rooms.ts')

  const viewState = baseState()
  viewState.night.step = 'witch'
  viewState.night.victim = 6 // 女巫今晚该看到刀口是 6 号
  viewState.seerChecks.push({ seer: 3, target: 0, team: 'wolf', day: 1 })
  // 一条夜晚狼队发言 + 一条白天公开发言：用来验证按视角裁剪
  viewState.messages.push({ id: 'm1', seat: 0, name: '玩家0', text: '狼队暗号', scope: 'wolf', day: 1, at: 1 })
  viewState.messages.push({ id: 'm2', seat: 6, name: '玩家6', text: '大家早上好', scope: 'public', day: 1, at: 2 })

  const meta = {
    id: 'room_x',
    title: '测试局',
    createdBy: 'u0',
    creatorName: '玩家0',
    createdAt: 1,
    updatedAt: 2,
  }
  const seats = PLAYERS.map((userId, seat) => ({ seat, userId, name: `玩家${seat}` }))
  const onlinePure = new Set(PLAYERS)
  const viewFor = (userId) => buildWerewolfView(meta, viewState, seats, userId, onlinePure)

  // --- 逐字段扫描：任何玩家的 view 里，身份字符串只允许出现在白名单路径 ---
  const sampleViews = [0, 1, 3, 4, 5, 6, 8].map((seat) => ({ seat, view: viewFor(PLAYERS[seat]) }))
  sampleViews.push({ seat: 'spectator', view: viewFor('outsider') })
  for (const { seat, view } of sampleViews) {
    const paths = rolePaths(view)
    const illegal = paths.filter((entry) => !ALLOWED_ROLE_PATH.test(entry.path))
    assert(
      illegal.length === 0,
      `座位 ${seat} 的 view 没有泄露任何别人的身份`,
      illegal.map((entry) => `${entry.path}=${entry.value}`).join(', '),
    )
  }

  // --- 狼人：看得见队友 ---
  const wolfView = viewFor('u0')
  eq(wolfView.myRole, 'wolf', '狼人看得到自己的身份')
  arrEq(wolfView.teammates, [1, 2], '狼人 A 看得到另外两只狼的座位')
  eq(wolfView.myChecks, null, '狼人拿不到预言家的查验')
  eq(wolfView.myPotions, null, '狼人拿不到女巫的药品')

  const wolfView2 = viewFor('u2')
  arrEq(wolfView2.teammates, [0, 1], '狼人 C 看得到另外两只狼（视角对称）')

  // --- 预言家：只看得到自己的查验 ---
  const seerView = viewFor('u3')
  eq(seerView.myRole, 'seer', '预言家看得到自己的身份')
  eq(seerView.teammates, null, '预言家拿不到狼队友')
  eq(Array.isArray(seerView.myChecks), true, '预言家拿得到自己的查验记录')
  arrEq(seerView.myChecks, [{ target: 0, team: 'wolf', day: 1 }], '预言家的查验内容是 0 号是狼')

  // --- 女巫：只看得到药品与今晚刀口 ---
  const witchView = viewFor('u4')
  eq(witchView.myRole, 'witch', '女巫看得到自己的身份')
  eq(witchView.teammates, null, '女巫拿不到狼队友')
  eq(witchView.myChecks, null, '女巫拿不到预言家的查验')
  assert(witchView.myPotions && witchView.myPotions.heal && witchView.myPotions.poison, '女巫看得到两瓶药都还在')
  eq(witchView.witchNightVictim, 6, '女巫看得到今晚被刀的是 6 号')

  // --- 村民：什么都没有 ---
  const villagerView = viewFor('u6')
  eq(villagerView.myRole, 'villager', '村民看得到自己的身份')
  eq(villagerView.teammates, null, '村民拿不到狼队友')
  eq(villagerView.myChecks, null, '村民拿不到预言家的查验')
  eq(villagerView.myPotions, null, '村民拿不到女巫的药品')
  eq(villagerView.witchNightVictim, null, '村民拿不到今晚的刀口（这是女巫的私密信息）')

  // --- 房内频道：狼队夜间发言只有狼能看到（view 里根本不存在） ---
  const wolfChat = wolfView.messages.map((m) => m.text)
  assert(
    wolfChat.includes('狼队暗号') && wolfChat.includes('大家早上好'),
    '狼人的 view 里既有狼队私频也有公开频道',
    JSON.stringify(wolfChat),
  )
  arrEq(
    villagerView.messages.map((m) => m.text),
    ['大家早上好'],
    '村民的 view 里**没有**狼队夜间发言（只剩公开那条）',
  )
  assert(
    !JSON.stringify(villagerView).includes('狼队暗号'),
    '村民 view 序列化后也不含狼队夜间发言的任何痕迹',
  )
  arrEq(
    viewFor('outsider').messages.map((m) => m.text),
    ['大家早上好'],
    '观战者的 view 里没有狼队夜间发言',
  )
  arrEq(
    buildWerewolfView(meta, viewState, seats, 'u3', onlinePure).messages.map((m) => m.text),
    ['大家早上好'],
    '预言家（非狼）的 view 里也没有狼队夜间发言',
  )

  // --- 观战者：连自己的身份都没有 ---
  const specView = viewFor('outsider')
  eq(specView.mySeat, null, '观战者不在座位上')
  eq(specView.myRole, null, '观战者没有身份')
  eq(specView.teammates, null, '观战者没有队友')

  // --- 死亡玩家：保留自己的身份，但依然看不到别人的身份 ---
  const deadState = baseState()
  deadState.alive[3] = false // 预言家已出局
  const deadView = buildWerewolfView(meta, deadState, seats, 'u3', onlinePure)
  eq(deadView.myRole, 'seer', '出局的预言家仍知道自己是预言家')
  arrEq(deadView.myChecks, [], '出局且本局还没查过人 → 查验记录为空')
  const deadScan = rolePaths(deadView).filter((entry) => !ALLOWED_ROLE_PATH.test(entry.path))
  assert(deadScan.length === 0, '出局玩家的 view 同样不泄露别人的身份')

  // --- 「当前该谁行动」不能把身份漏出去 ---
  //
  // ⚠️ 这一节是为一个**真实发生过的泄漏**补的回归测试。
  //
  // waitingOn 在夜晚返回的是"哪个狼还没刀人""预言家行动了没有""女巫行动了没有" ——
  // 而那些**座位号本身就等于身份**。原样发出去，任何人打开房间（或者第 9 个人
  // 一坐下触发的那次推送）就能从浏览器控制台直接读出三个狼、预言家、女巫是谁。
  //
  // 上面那条"逐字段扫描"只找身份**字符串**，而泄漏出去的是**座位整数**（[0,1,2]），
  // 永远匹配不到 —— 所以它一直绿着，149 条断言全过，问题却在那儿躺着。
  // 这就是为什么这里不扫字段名，而是拿**真实的身份布局**去比座位号。
  for (const step of ['wolf', 'seer', 'witch']) {
    const nightState = baseState()
    nightState.night.step = step
    for (let seat = 0; seat < PLAYERS.length; seat++) {
      const v = buildWerewolfView(meta, nightState, seats, PLAYERS[seat], onlinePure)
      const others = v.waitingOn.filter((s) => s !== seat)
      eq(
        others.length,
        0,
        `夜晚 ${step} 步：${seat} 号看到的 waitingOn 不含别人的座位（含了就等于点名了特殊身份）`,
      )
    }
    // 观战者：一个座位都不该看到
    const specNight = buildWerewolfView(meta, nightState, seats, 'outsider', onlinePure)
    arrEq(specNight.waitingOn, [], `夜晚 ${step} 步：观战者拿不到任何"谁在行动"的信息`)
  }

  // 对照：本人正是该行动的人时，必须能看到自己 —— 否则界面不知道该谁操作
  const seerWaitState = baseState()
  seerWaitState.night.step = 'seer'
  const seerWaitView = buildWerewolfView(meta, seerWaitState, seats, 'u3', onlinePure)
  arrEq(seerWaitView.waitingOn, [3], '预言家轮到自己时，waitingOn 指向自己')
  assert(seerWaitView.myTurn === true, '同时 myTurn 为真（界面靠它渲染操作按钮）')

  // 白天投票是公开节奏，座位可以保留 —— 别把这条有用的信息一起堵掉了
  const dayVoteState = baseState()
  dayVoteState.phase = 'day-vote'
  dayVoteState.votes = {}
  const dayVoteView = buildWerewolfView(meta, dayVoteState, seats, 'u6', onlinePure)
  assert(
    dayVoteView.waitingOn.length > 1,
    '白天投票阶段仍公开「还有谁没投」',
    `${dayVoteView.waitingOn.length} 人未投`,
  )

  // ==========================================================================
  console.log('\n【各阶段的合法行动矩阵】')

  // 夜晚 · 狼人步骤：只有狼能动
  const s1 = baseState()
  s1.night.step = 'wolf'
  eq(legalActions(s1, 0).kind, 'kill', '狼人在狼人步骤可刀人')
  eq(legalActions(s1, 3).canAct, false, '预言家在狼人步骤不能验人')
  eq(legalActions(s1, 6).canAct, false, '村民夜里不能行动')
  throws(() => applyWolfKill(s1, 6, 0), '村民冒充狼刀人会被拒')
  throws(() => applyWolfKill(s1, 0, 0), '狼不能刀自己')
  throws(() => applyWolfKill(s1, 0, 999), '狼不能刀不存在的座位')
  applyWolfKill(s1, 0, 6)
  eq(s1.night.wolfVotes['0'], 6, '狼刀的记录写入票里')

  // 夜晚 · 预言家步骤
  const s2 = baseState()
  s2.night.step = 'seer'
  eq(legalActions(s2, 3).kind, 'check', '预言家在预言家步骤可验人')
  eq(legalActions(s2, 0).canAct, false, '狼在预言家步骤不能行动')
  throws(() => applySeerCheck(s2, 0, 3), '狼冒充预言家验人会被拒')
  const check = applySeerCheck(s2, 3, 0)
  eq(check.team, 'wolf', '预言家验 0 号，得到狼人阵营')
  throws(() => applySeerCheck(s2, 3, 1), '预言家一晚上只能验一次')

  // 夜晚 · 女巫步骤
  const s3 = baseState()
  s3.night.step = 'witch'
  s3.night.victim = 6
  const witchActions = legalActions(s3, 4)
  eq(witchActions.canAct, true, '女巫在女巫步骤可行动')
  eq(witchActions.canHeal, true, '今晚有人被刀 → 女巫可以救')
  eq(witchActions.canPoison, true, '毒药还在 → 女巫可以毒')
  throws(() => applyWitch(s3, 4, { heal: true, poisonTarget: 8 }), '同一晚不能同时用解药和毒药')
  throws(() => applyWitch(s3, 4, { poisonTarget: 4 }), '女巫不能毒自己')
  throws(() => applyWitch(s3, 3, { heal: true }), '不是女巫不能用药')
  applyWitch(s3, 4, { heal: true })
  eq(s3.night.witchHeal, true, '女巫选择用解药')

  // 今晚没人被刀 → 用不了解药
  const s3b = baseState()
  s3b.night.step = 'witch'
  s3b.night.victim = null
  eq(legalActions(s3b, 4).canHeal, false, '今晚没人被刀，用不了解药')
  throws(() => applyWitch(s3b, 4, { heal: true }), '没有刀口时用解药会被拒')

  // 白天 · 投票
  const s4 = baseState()
  s4.phase = 'day-vote'
  eq(legalActions(s4, 0).kind, 'vote', '存活玩家白天可以投票')
  throws(() => applyVote(s4, 0, 0), '不能投自己')
  s4.alive[2] = false
  throws(() => applyVote(s4, 0, 2), '不能投已经出局的人')
  throws(() => applyVote(s4, 2, 1), '出局的人不能投票')
  applyVote(s4, 0, 1)
  eq(s4.votes['0'], 1, '投票被记录')
  applyVote(s4, 0, null)
  eq(s4.votes['0'], -1, '改票为弃票（-1）')

  // 猎人开枪：即使猎人已死也必须能行动
  const s5 = baseState()
  s5.alive[5] = false
  s5.phase = 'hunter'
  s5.pending = { seat: 5, after: 'night' }
  eq(legalActions(s5, 5).canAct, true, '已出局的猎人仍能开枪')
  eq(legalActions(s5, 5).kind, 'shoot', '猎人动作类型是 shoot')
  eq(legalActions(s5, 0).canAct, false, '猎人开枪时其他人不能行动')
  throws(() => applyHunterShot(s5, 0, 1, 100), '不该开枪的人开枪会被拒')
  applyHunterShot(s5, 5, 0, 100)
  eq(s5.alive[0], false, '猎人带走了 0 号')
  eq(s5.phase, 'night', '开枪结束后回到夜晚（after=night）')

  // waiting / finished 阶段谁都不能行动
  const sWait = createWaitingState(PLAYERS)
  eq(legalActions(sWait, 0).canAct, false, '等人阶段谁都不能行动')
  const sFin = baseState()
  sFin.phase = 'finished'
  eq(legalActions(sFin, 0).canAct, false, '结束阶段谁都不能行动')

  // ==========================================================================
  console.log('\n【房内文字频道：谁能说 / 谁能看（纯逻辑）】')

  // 夜晚：只有狼能发言、只有狼能看到
  const chatNight = baseState()
  chatNight.night.step = 'wolf'
  eq(chatScope(chatNight), 'wolf', '夜晚频道是狼队私频')
  eq(canSendChat(chatNight, 0), true, '夜晚狼人可以发言')
  eq(canSendChat(chatNight, 3), false, '夜晚预言家不能发言')
  eq(canSendChat(chatNight, 6), false, '夜晚村民不能发言')
  eq(canSendChat(chatNight, -1), false, '观战者不能发言')
  eq(canSeeWolfChat(chatNight, 0), true, '狼能看到狼队私频')
  eq(canSeeWolfChat(chatNight, 6), false, '村民看不到狼队私频')

  const wolfMsg = addChatMessage(chatNight, 0, '玩家0', '今晚刀 7 号', 1000)
  eq(wolfMsg.scope, 'wolf', '夜晚发言被标记为狼队私频')
  eq(chatNight.messages.length, 1, '发言写进了 state')
  throws(() => addChatMessage(chatNight, 6, '玩家6', '我说话', 1000), '夜晚非狼发言被拒')
  throws(() => addChatMessage(chatNight, 0, '玩家0', '   ', 1000), '空发言被拒')
  throws(() => addChatMessage(chatNight, 0, '玩家0', 'x'.repeat(999), 1000), '超长发言被拒')

  // ⚠️ 猎人被夜刀之后的那个窗口，频道**仍然是狼队私频**。
  //
  // 这一条是为一个审查抓出来的泄漏补的：猎人被狼刀死时，phase 会从 'night'
  // 直接切成 'hunter'（pending.after = 'day-announce'）—— 天还没亮、结果还没公布，
  // 叙事上仍在夜晚。而 chatScope 原来只看 `phase === 'night'`，
  // 于是这 20 秒的窗口里频道会静默变成公开：狼给队友的配合被推给所有玩家和观战者。
  // 9 人默认板子有猎人，所以线上正在用的棋盘就会触发。
  const hunterAtNight = baseState()
  hunterAtNight.phase = 'hunter'
  hunterAtNight.pending = { seat: 5, after: 'day-announce' }
  eq(chatScope(hunterAtNight), 'wolf', '夜刀之后的猎人阶段，频道仍是狼队私频（不能提前变公开）')
  eq(canSendChat(hunterAtNight, 0), true, '这个窗口里狼仍能发言')
  eq(canSendChat(hunterAtNight, 6), false, '这个窗口里村民仍不能发言')
  const hunterMsg = addChatMessage(hunterAtNight, 0, '玩家0', '别投 3 号', 3000)
  eq(hunterMsg.scope, 'wolf', '这个窗口里的狼队发言标记为私频')
  eq(canSeeWolfChat(hunterAtNight, 6), false, '村民在这个窗口里看不到狼队私频')

  // 反向：**投票出局**触发的猎人开枪发生在白天，那时频道本来就该是公开的，
  // 不能一起算成夜晚（否则白天的发言会被错误地藏起来）
  const hunterAtDay = baseState()
  hunterAtDay.phase = 'hunter'
  hunterAtDay.pending = { seat: 5, after: 'night' }
  eq(chatScope(hunterAtDay), 'public', '白天投票触发的猎人阶段是公开频道（不能一起算成夜晚）')

  // 白天：公开频道，存活玩家都能说，消息是 public
  const chatDay = baseState()
  chatDay.phase = 'day-discuss'
  eq(chatScope(chatDay), 'public', '白天频道是公开')
  eq(canSendChat(chatDay, 6), true, '白天村民可以发言')
  eq(canSendChat(chatDay, 0), true, '白天狼人也可以发言')
  const dayMsg = addChatMessage(chatDay, 6, '玩家6', '我觉得 1 号像狼', 2000)
  eq(dayMsg.scope, 'public', '白天发言是公开 scope')

  // 出局的人不能发言（无论白天黑夜）
  const chatDead = baseState()
  chatDead.alive[6] = false
  eq(canSendChat(chatDead, 6), false, '出局的人不能发言（夜晚）')
  chatDead.phase = 'day-vote'
  eq(canSendChat(chatDead, 6), false, '出局的人不能发言（白天）')

  // 上限：只保留最近 MAX 条，不会无限涨
  const chatCap = baseState()
  for (let i = 0; i < 260; i++) addChatMessage(chatCap, 0, '玩家0', `发言 ${i}`, 1000 + i)
  assert(chatCap.messages.length <= 200, '发言历史有上限（不会无限增长）', `${chatCap.messages.length} 条`)
  eq(chatCap.messages[chatCap.messages.length - 1].text, '发言 259', '保留的是最近的发言')

  // ==========================================================================
  console.log('\n【胜负判定边界】')

  function winCheck(aliveSeats) {
    const state = baseState()
    state.alive = PLAYERS.map((_, i) => aliveSeats.includes(i))
    return checkWin(state)
  }

  eq(winCheck([3, 4, 5, 6, 7, 8]).winner, 'good', '狼人全死 → 好人胜')
  eq(winCheck([3, 4, 5, 6, 7, 8]).reason, 'wolves-dead', '原因是 wolves-dead')
  eq(winCheck([0, 1, 3, 4]).winner, 'wolf', '狼人数(2) ≥ 好人数(2) → 狼人胜')
  eq(winCheck([0, 1, 3, 4]).reason, 'wolves-outnumber', '原因是 wolves-outnumber')
  eq(winCheck([6]).winner, 'good', '只剩一个好人（狼 0）→ 好人胜')
  eq(winCheck([0]).winner, 'wolf', '只剩一个狼（好人 0）→ 狼人胜')
  eq(winCheck([0, 1, 3, 4, 5]).over, false, '2 狼 3 好人 → 未结束')
  eq(winCheck([0, 1, 3, 4, 5]).winner, null, '未结束时没有胜方')

  // ==========================================================================
  console.log('\n【一整局自动跑完（随机行动）】')

  function autoPlay(seed, count = 9) {
    const players = Array.from({ length: count }, (_, i) => `u${i}`)
    const rng = makeRng(seed)
    const state = createGameState(players, 0, makeRng(seed ^ 0x9e37))
    const pick = (arr) => (arr.length ? arr[Math.floor(rng(arr.length))] : null)
    let nowMs = 0
    let steps = 0
    while (state.phase !== 'finished') {
      if (++steps > 20000) throw new Error(`未收敛（seed=${seed}，count=${count}，phase=${state.phase}）`)
      let acted = false
      for (let seat = 0; seat < state.players.length; seat++) {
        const a = legalActions(state, seat)
        if (!a.canAct) continue
        if (a.kind === 'kill') {
          applyWolfKill(state, seat, pick(a.targets))
          acted = true
        } else if (a.kind === 'check') {
          applySeerCheck(state, seat, pick(a.targets))
          acted = true
        } else if (a.kind === 'witch') {
          const choice = {}
          if (a.canHeal && rng(2) === 0) choice.heal = true
          else if (a.canPoison && rng(3) === 0) choice.poisonTarget = pick(a.targets)
          applyWitch(state, seat, choice)
          acted = true
        } else if (a.kind === 'vote') {
          applyVote(state, seat, rng(5) === 0 ? null : pick(a.targets))
          acted = true
        } else if (a.kind === 'shoot') {
          applyHunterShot(state, seat, pick(a.targets), nowMs)
          acted = true
        }
      }
      nowMs += 1000
      advance(state, nowMs)
      if (!acted) {
        // 没人能行动（纯计时阶段）：把时间往前推，让超时逻辑推进它
        nowMs += 10 * 60 * 1000
        advance(state, nowMs)
      }
    }
    return state
  }

  // ---- 9 人局：沿用原来的 200 局压力测试（行为与历史一致） ----
  let allFinished = true
  let goodWins = 0
  let wolfWins = 0
  for (let seed = 1; seed <= 200; seed++) {
    let result
    try {
      result = autoPlay(seed)
    } catch (err) {
      allFinished = false
      bad(`seed=${seed} 的自动对局跑完`, err.message)
      break
    }
    if (!result.winner) {
      allFinished = false
      bad(`seed=${seed} 收敛但无胜方`, JSON.stringify(result))
      break
    }
    if (result.winner === 'good') goodWins++
    else wolfWins++
  }
  assert(allFinished, '200 局随机对战全部跑完且都有胜方')
  assert(goodWins > 0 && wolfWins > 0, '随机对战里两边都赢过（胜负没有被写死）', `好人 ${goodWins} / 狼人 ${wolfWins}`)

  // ---- 每个支持的人数各跑若干局自动对战，必须都能收敛到 finished 且不抛异常 ----
  for (let count = MIN_PLAYER_COUNT; count <= MAX_PLAYER_COUNT; count++) {
    let finished = 0
    let crashed = null
    const games = 30
    for (let seed = 1; seed <= games; seed++) {
      try {
        const result = autoPlay(seed * 7919 + count, count)
        if (result.phase === 'finished' && result.winner) finished++
        else crashed = `seed=${seed} 收敛但无胜方（phase=${result.phase}）`
      } catch (err) {
        crashed = `seed=${seed}: ${err.message}`
        break
      }
    }
    assert(
      crashed === null && finished === games,
      `${count} 人局自动对战 ${games} 局全部收敛到 finished`,
      crashed ?? `${finished}/${games}`,
    )
  }

  // ==========================================================================
  console.log('\n【超时兜底（角色不行动也不能卡死）】')

  const timeoutState = createGameState(PLAYERS, 0, makeRng(12345))
  eq(timeoutState.phase, 'night', '开局在夜晚')
  const seenPhases = new Set()
  let nowMs = 0
  // 全程**没有任何人行动**：只能靠超时推进。
  for (let i = 0; i < 60 && timeoutState.phase !== 'finished'; i++) {
    nowMs += 10 * 60 * 1000
    advance(timeoutState, nowMs)
    seenPhases.add(timeoutState.phase)
  }
  assert(seenPhases.has('night') && seenPhases.has('day-vote'), '没有任何人行动时也能从夜晚推进到投票')
  assert(timeoutState.day >= 2, '超时兜底让对局进入了第 2 天（没有卡在第 1 夜）', `day=${timeoutState.day}`)
  assert(timeoutState.alive.every(Boolean), '狼人始终没刀 → 没人出局（超时=弃权，不是随机杀人）')

  // 夜晚总时长：狼→预言家→女巫三步都能被超时跨过
  const t2 = createGameState(PLAYERS, 0, makeRng(7))
  let t = 0
  const stepsSeen = new Set()
  for (let i = 0; i < 6; i++) {
    t += 10 * 60 * 1000
    advance(t2, t)
    stepsSeen.add(t2.night.step)
    if (t2.phase !== 'night') break
  }
  eq(t2.phase !== 'night', true, '狼/预言家/女巫都不行动时，超时也能走完整个夜晚')

  // ==========================================================================
  console.log('\n【房间层端到端】')

  const roomsMod = await import('../server/src/games/werewolf-rooms.ts')
  const { getDb } = await import('../server/src/db.ts')
  const db = getDb()

  function mkUser(i) {
    const id = `wtest_u${i}`
    db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, `wtest_u${i}`, `玩家${i}`, 'x', Date.now())
    return id
  }
  const ids = Array.from({ length: 10 }, (_, i) => mkUser(i))
  const spectatorId = ids[9]
  const online = new Set(ids)

  const created = roomsMod.createWerewolfRoom({ title: '狼人杀测试局', creatorId: ids[0] })
  eq(created.kind, 'werewolf', '创建的是狼人杀房间')
  eq(created.phase, 'waiting', '建好后是等人状态')
  eq(created.myRole, null, '还没开局，没有身份')
  assertEqualsPlayers(created, 1)

  function assertEqualsPlayers(view, expected) {
    eq(view.players.length, expected, `房间里有 ${expected} 名玩家`)
  }

  for (let i = 1; i < 9; i++) roomsMod.joinWerewolfRoom(created.id, ids[i], online)
  const started = roomsMod.getWerewolfView(created.id, ids[0], online)
  eq(started.phase, 'night', '9 人到齐后自动开局进入夜晚')
  assert(started.myRole !== null, '开局后每个玩家都拿到了自己的身份')

  // 从数据库读出真实身份，用来验证"每个人只看到自己那份"
  const rawState = JSON.parse(db.prepare('SELECT state FROM game_rooms WHERE id = ?').get(created.id).state)
  const trueRoles = rawState.roles
  const wolfSeats = trueRoles.flatMap((r, seat) => (r === 'wolf' ? [seat] : []))
  eq(wolfSeats.length, 3, '真实身份里有 3 只狼')

  for (let seat = 0; seat < 9; seat++) {
    const view = roomsMod.getWerewolfView(created.id, ids[seat], online)
    eq(view.myRole, trueRoles[seat], `座位 ${seat} 的 view 里自己的身份正确`)
    eq(view.mySeat, seat, `座位 ${seat} 的 mySeat 正确`)
    if (trueRoles[seat] === 'wolf') {
      arrEq(view.teammates, wolfSeats.filter((s) => s !== seat), `座位 ${seat}（狼）看得到队友`)
    } else {
      eq(view.teammates, null, `座位 ${seat}（非狼）看不到任何狼`)
    }
    const illegal = rolePaths(view).filter((entry) => !ALLOWED_ROLE_PATH.test(entry.path))
    assert(illegal.length === 0, `座位 ${seat} 的端到端 view 不泄露别人的身份`, illegal.map((e) => e.path).join(','))
  }

  // 观战者：没有身份
  const spectatorView = roomsMod.getWerewolfView(created.id, spectatorId, online)
  eq(spectatorView.myRole, null, '观战者看不到任何身份')

  const seerSeat = trueRoles.indexOf('seer')
  const witchSeat = trueRoles.indexOf('witch')
  const goodSeats = trueRoles.flatMap((r, seat) => (r !== 'wolf' ? [seat] : []))
  const villagerSeat = trueRoles.indexOf('villager')
  const killTarget = goodSeats[0]

  // 房内发言（房间层）：夜晚狼能说、非狼不能；狼的发言绝不出现在非狼/观战者的 view 里
  const chatWolfSeat = wolfSeats[0]
  const wolfChatView = roomsMod.werewolfChat(created.id, ids[chatWolfSeat], '今晚刀谁？', online)
  assert(
    wolfChatView.messages.some((m) => m.text === '今晚刀谁？'),
    '狼的夜间发言写进了自己的 view',
    JSON.stringify(wolfChatView.messages.map((m) => m.text)),
  )
  throws(() => roomsMod.werewolfChat(created.id, ids[goodSeats[0]], '我也说一句', online), '非狼在夜晚发言被拒', 400)
  const nonWolfChatView = roomsMod.getWerewolfView(created.id, ids[goodSeats[0]], online)
  assert(!JSON.stringify(nonWolfChatView).includes('今晚刀谁'), '非狼的 view 里不含狼队夜间发言')
  const specChatView = roomsMod.getWerewolfView(created.id, spectatorId, online)
  assert(!JSON.stringify(specChatView).includes('今晚刀谁'), '观战者的 view 里不含狼队夜间发言')

  // 观战者不能操作
  throws(() => roomsMod.werewolfKill(created.id, spectatorId, goodSeats[0], online), '观战者不能参与夜晚行动', 403)

  // 夜里：三狼一致刀一个好人，预言家验人，女巫救人
  for (const seat of wolfSeats) roomsMod.werewolfKill(created.id, ids[seat], killTarget, online)
  roomsMod.werewolfCheck(created.id, ids[seerSeat], wolfSeats[0], online)
  const afterNight = roomsMod.werewolfWitch(created.id, ids[witchSeat], { heal: true }, online)
  assert(
    afterNight.phase === 'day-announce' || afterNight.phase === 'hunter',
    '夜晚走完后进入白天（公布结果）',
    afterNight.phase,
  )
  assert(afterNight.lastNight && afterNight.lastNight.saved === true, '女巫救人成功，昨夜无人出局')
  assert(afterNight.players.every((p) => p.alive), '救人后 9 个人都还活着')

  // 非狼不能刀人 / 狼不能在白天刀人，服务端必须拒绝
  throws(() => roomsMod.werewolfKill(created.id, ids[goodSeats[0]], killTarget, online), '好人不能刀人', 400)

  // 超时兜底：推进到投票阶段
  let vt = Date.now()
  for (let i = 0; i < 20; i++) {
    vt += 10 * 60 * 1000
    roomsMod.advanceWerewolfRoom(created.id, vt)
    if (roomsMod.getWerewolfView(created.id, ids[0], online).phase === 'day-vote') break
  }
  const voteView = roomsMod.getWerewolfView(created.id, ids[0], online)
  eq(voteView.phase, 'day-vote', '超时把对局推进到了投票阶段')

  // 全体投票放逐一个村民（选村民是为了避开猎人的连带效果，让断言更直接）
  const exile = villagerSeat
  for (let seat = 0; seat < 9; seat++) {
    const v = roomsMod.getWerewolfView(created.id, ids[0], online)
    if (v.phase !== 'day-vote') break
    if (!v.players[seat].alive) continue
    // 被放逐者自己不能投自己，弃票即可（弃票同样算"已投票"，不会卡住流程）
    roomsMod.werewolfVote(created.id, ids[seat], seat === exile ? null : exile, online)
  }
  const afterVote = roomsMod.getWerewolfView(created.id, ids[0], online)
  assert(afterVote.lastVote && afterVote.lastVote.executed === exile, '得票最多者被放逐', JSON.stringify(afterVote.lastVote))
  eq(afterVote.players[exile].alive, false, '被放逐的人已出局')

  // 离开：对局中退出按出局处理，且不整局卡死
  const leaver = goodSeats.find((s) => afterVote.players[s].alive)
  const left = roomsMod.leaveWerewolfRoom(created.id, ids[leaver], online)
  assert(left.abandoned === true, '对局中离开被标记为 abandoned')
  eq(left.view.players[leaver].alive, false, '离开的人按出局处理')

  // processWerewolfTimeouts：扫描进行中的房间，把过期的推进掉
  const advanced = roomsMod.processWerewolfTimeouts(Date.now() + 60 * 60 * 1000)
  assert(advanced.includes(created.id), '定时扫描把过期的房间推进了')

  // 清理：长时间没人动的 waiting 房间会被删掉
  const stale = roomsMod.createWerewolfRoom({ title: '被遗忘的房间', creatorId: ids[0] })
  db.prepare('UPDATE game_rooms SET updated_at = ? WHERE id = ?').run(Date.now() - 25 * 60 * 60 * 1000, stale.id)
  const cleaned = roomsMod.cleanupStaleWerewolfRooms()
  const stillThere = db.prepare('SELECT id FROM game_rooms WHERE id = ?').get(stale.id)
  assert(cleaned >= 1 && !stillThere, '超过 24 小时的 waiting 房间被清理')

  // --------------------------------------------------------------------------
  // 房主（创建者）退房 = 解散房间
  //
  // 之前房主关掉窗口，房间还挂在大厅里显示"1/9 人"，谁都开不了局，
  // 只能等 24 小时的兜底清理。现在房主在等待阶段退房就直接删房，
  // 并把还留在房里的人请回大厅（路由据此给他们推 room:null）。
  console.log('\n【房主退房解散房间】')
  const hostRoom = roomsMod.createWerewolfRoom({ title: '房主的房间', creatorId: ids[0] })
  roomsMod.joinWerewolfRoom(hostRoom.id, ids[1], online)
  const hostLeft = roomsMod.leaveWerewolfRoom(hostRoom.id, ids[0], online)
  eq(hostLeft.view, null, '房主退房后房间不复存在')
  eq(hostLeft.dissolved?.length, 1, '返回需要被请出房间的名单')
  eq(hostLeft.dissolved?.[0], ids[1], '名单里是还留在房里的成员')
  assert(
    !db.prepare('SELECT id FROM game_rooms WHERE id = ?').get(hostRoom.id),
    '房主退房后房间行已从库里删除',
  )

  // 普通成员退房：房间保留，只让出座位
  const hostRoom2 = roomsMod.createWerewolfRoom({ title: '第二个房间', creatorId: ids[0] })
  roomsMod.joinWerewolfRoom(hostRoom2.id, ids[1], online)
  const guestLeft = roomsMod.leaveWerewolfRoom(hostRoom2.id, ids[1], online)
  eq(guestLeft.view?.players.length, 1, '普通成员退房后房间还在，只剩房主')
  assert(!guestLeft.dissolved, '普通成员退房不解散房间')
  const hostLeft2 = roomsMod.leaveWerewolfRoom(hostRoom2.id, ids[0], online)
  eq(hostLeft2.view, null, '房主最后退房同样删房')

  // 列表
  const list = roomsMod.listWerewolfRooms(ids[0], online)
  assert(list.every((r) => r.kind === 'werewolf'), '房间列表只返回狼人杀房间')

  // ==========================================================================
  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m测试脚本异常终止：\x1b[0m', err)
  process.exit(1)
})
