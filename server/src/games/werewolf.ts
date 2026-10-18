/**
 * 狼人杀规则引擎（纯逻辑：不碰数据库、不碰 HTTP）。
 *
 * ============================================================================
 * 为什么规则引擎要和房间/推送分开
 * ============================================================================
 * 和 doudizhu.ts / xiangqi.ts 一样自研，理由也一样：这类游戏的命脉是
 * "规则判得对不对"，而它的正确性只能靠**大量可断言的纯函数**来保证。
 * 所以这个文件里全部是纯函数：给定一个 state 和一个动作，要么返回结果，
 * 要么抛 RuleError —— 不读写数据库、不发网络请求，测试可以直接 import 出来
 * 反复调用（见 scripts/werewolf-test.mjs）。
 *
 * 房间管理、按玩家视角裁剪、超时清扫在 werewolf-rooms.ts。
 *
 * ============================================================================
 * 信息模型（这是本模块的核心，做错了整个游戏就废了）
 * ============================================================================
 * 狼人杀是**隐藏信息**游戏。服务端保存的 state 里当然有每个人的身份
 * （roles 数组），但**绝不能原样发给客户端** —— 前端藏起来没有用，
 * 打开浏览器控制台就看见了。裁剪规则见 werewolf-rooms.ts 的 toWerewolfView：
 *
 *   - 每个玩家能看到**自己的**身份；别人的身份一律不出现。
 *   - 狼人之间互相可见（这是规则的一部分，不是漏洞）。
 *   - 预言家的查验结果只给预言家本人；女巫的药品与"今晚谁被刀了"只给女巫。
 *
 * 这个 state 结构里之所以能把预言家查验、女巫药品直接放在顶层（而不是按座位
 * 存放在一个 map 里），是因为本板子预言家/女巫各只有一个；将来若加第二个
 * 预言家，要改成按座位索引。
 *
 * ============================================================================
 * 板子（6~12 人可自定义）
 * ============================================================================
 * 默认 9 人局：3 狼人 + 预言家 + 女巫 + 猎人 + 3 村民（线下最常见的入门配置）。
 * 现在建房时可以指定 6~12 人，配置由 boardFor(n) 这张**确定性表**给出（见下），
 * 每个配置都保证好人数严格多于狼人数、有且只有一名预言家。
 * 9 人的那一行与历史板子逐字一致 —— 那是已经在用的棋盘，一个字都不能变。
 *
 * ============================================================================
 * 房内文字频道
 * ============================================================================
 * 每个房间有一条文字频道。**它同样受隐藏信息约束**：白天公开、夜晚仅狼队可见，
 * 规则与裁剪见下方"房内文字频道"一节与 werewolf-rooms.ts 的 buildWerewolfView。
 *
 * ============================================================================
 * 随机性
 * ============================================================================
 * 身份分配**必须用 node:crypto 的 randomInt**，不能用 Math.random。
 * 斗地主踩过这个坑：发牌种子曾经能从公开的房间 id 推出来，导致所有人能算出
 * 别人的手牌。身份分配同理 —— 它一旦可预测，狼人杀就彻底退化成了明牌。
 * 这里默认的 rng 就是 `randomInt(max)`（它无取模偏差），只有在测试里才注入
 * 确定性的假 rng。
 */

import { randomInt, randomUUID } from 'node:crypto'

// ============================================================================
// 基础类型与常量
// ============================================================================

export type Role = 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager'
export type Team = 'wolf' | 'good'

/**
 * 顶层阶段。
 *
 * waiting → night → day-announce → day-discuss → day-vote → (night | finished)
 *
 * `hunter` 是一个**独立的短暂阶段**，不是白天流程的一环：当猎人出局且可以开枪
 * 时，整局会挂起等他选目标。把它做成独立阶段（而不是埋一个 flag）的好处是
 * legalActions / advance 都只需按 phase 分派，不用到处判"现在是不是在等猎人"。
 */
export type Phase =
  | 'waiting'
  | 'night'
  | 'day-announce'
  | 'day-discuss'
  | 'day-vote'
  | 'hunter'
  | 'finished'

/** 夜晚的三个子步骤，必须按狼 → 预言家 → 女巫的顺序进行。 */
export type NightStep = 'wolf' | 'seer' | 'witch'

export type LogKind = 'phase' | 'death' | 'vote' | 'shot' | 'night' | 'end'

export const ROLE_LABELS: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '村民',
}

export const TEAM_LABELS: Record<Team, string> = {
  wolf: '狼人阵营',
  good: '好人阵营',
}

/** 阵营判定：除狼人外全是好人阵营（村民、神职都在一边）。 */
export function roleTeam(role: Role): Team {
  return role === 'wolf' ? 'wolf' : 'good'
}

/** 一个身份配置项：某身份多少张。 */
export interface BoardEntry {
  role: Role
  count: number
}

/**
 * 支持的自定义人数范围。
 *
 * 为什么下限是 6：更少的话好人数减掉狼之后剩不下几个，一轮刀+一轮票就结束了，
 * 没有任何推理空间。为什么上限是 12：再多，一张 8GB NAS 上的单局时长和"凑齐人"
 * 的成本都不划算，而且身份种类没有相应增加（会变成一堆村民陪跑）。
 */
export const MIN_PLAYER_COUNT = 6
export const MAX_PLAYER_COUNT = 12

/** 默认人数 = 原来的固定 9 人局。旧房间与旧行为都锚在它上面。 */
export const DEFAULT_PLAYER_COUNT = 9

/**
 * 本板子（9 人局）的固定人数。保留旧名字：现有 9 人局的代码与测试仍然引用它。
 * 注意它现在只是"默认值"，不再是"唯一合法值"。
 */
export const PLAYER_COUNT = DEFAULT_PLAYER_COUNT

/**
 * 人数 → 身份配置表。
 *
 * 为什么要一张**写死的表**而不是现算：这是规则的公开信息，玩家会在心里盘
 * "这局几狼几神"，如果实现是一段会随人数漂移的公式，规则就没法推理、也没法解释。
 * 表让每个配置都**确定**（同一个人数每次都得到同样的配置），随机只体现在
 * "谁拿到哪个身份"上（见 assignRoles）。
 *
 * 每个配置都满足：
 *   - 好人数 **严格多于** 狼人数（否则一开局就满足狼人胜利条件，直接卡死）；
 *   - 有且只有一名预言家；
 *   - 狼人数随人数**单调不减**（人越多狼越多，符合常见棋盘惯例）；
 *   - 各项 count 之和 = 该人数。
 *
 * 9 人的那一行必须与历史板子**逐字一致**（3 狼 / 预言家 / 女巫 / 猎人 / 3 村民），
 * 这是已经在用的棋盘，一个字都不能变。
 */
const BOARDS: Record<number, ReadonlyArray<BoardEntry>> = {
  6: [
    { role: 'wolf', count: 2 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'villager', count: 2 },
  ],
  7: [
    { role: 'wolf', count: 2 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 2 },
  ],
  8: [
    { role: 'wolf', count: 3 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 2 },
  ],
  9: [
    { role: 'wolf', count: 3 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 3 },
  ],
  10: [
    { role: 'wolf', count: 3 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 4 },
  ],
  11: [
    { role: 'wolf', count: 4 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 4 },
  ],
  12: [
    { role: 'wolf', count: 4 },
    { role: 'seer', count: 1 },
    { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 },
    { role: 'villager', count: 5 },
  ],
}

export function isValidPlayerCount(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_PLAYER_COUNT && n <= MAX_PLAYER_COUNT
}

/**
 * **纯函数**：人数 → 身份配置。确定性（没有随机、没有副作用），
 * 非法人数抛 RuleError。房间层与界面都靠它，"这一局是什么板子"只有一个来源。
 */
export function boardFor(n: number): ReadonlyArray<BoardEntry> {
  if (!isValidPlayerCount(n)) {
    throw new RuleError(`人数必须在 ${MIN_PLAYER_COUNT}~${MAX_PLAYER_COUNT} 之间，收到 ${n} 人`)
  }
  return BOARDS[n]!
}

/**
 * 默认（9 人）板子构成。公开信息：规则本就人人知道，写进 view 里也没关系。
 * 现在只是 `boardFor(默认人数)` 的别名，向后兼容旧引用。
 */
export const BOARD_COMPOSITION: ReadonlyArray<BoardEntry> = boardFor(PLAYER_COUNT)

/**
 * 某身份在配置里的数量（没有则为 0）。给测试与界面用。
 */
export function countOfRole(board: ReadonlyArray<BoardEntry>, role: Role): number {
  return board.find((entry) => entry.role === role)?.count ?? 0
}

/**
 * 各阶段时长（毫秒）。
 *
 * 为什么要给每个阶段都设死线：狼人杀是**同步回合**游戏，只要有一个人挂机
 * 不行动，整桌人都要干等。项目里棋类房间用 cleanupStaleRooms 清扫僵尸房间，
 * 思路一致 —— 这里换成"到点就替他把这一步走完"（见 advance 的超时分支）。
 *   - 夜晚每个子步骤 30 秒：狼/预言家/女巫各一次操作，够用。
 *   - 公布 8 秒：只是展示昨夜的死讯，不需要操作。
 *   - 发言 90 秒：纯计时，线下发言也就这个量级。
 *   - 投票 45 秒：比发言短，避免有人拖着不投。
 *   - 猎人开枪 20 秒：一个人做决定，够了。
 */
export const NIGHT_STEP_MS = 30_000
export const ANNOUNCE_MS = 8_000
export const DISCUSS_MS = 90_000
export const VOTE_MS = 45_000
export const HUNTER_MS = 20_000

/** 规则校验失败。房间层会把它翻译成 HTTP 400。 */
export class RuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleError'
  }
}

/** 取 [0, maxExclusive) 的整数。可注入，方便测试复现。 */
export type Rng = (maxExclusive: number) => number

const cryptoRng: Rng = (maxExclusive) => randomInt(maxExclusive)

// ============================================================================
// 状态结构
// ============================================================================

export interface NightState {
  step: NightStep
  /** 狼的刀票：狼座位(字符串) → 目标座位。狼内部可见，不对外。 */
  wolfVotes: Record<string, number>
  /** 狼多数决选出的刀口。狼步骤结束时结算，供女巫决定要不要救。 */
  victim: number | null
  seerActed: boolean
  witchActed: boolean
  /** 女巫本晚是否使用解药。 */
  witchHeal: boolean
  /** 女巫本晚毒的目标（null = 没用毒）。 */
  witchPoison: number | null
}

export interface SeerCheck {
  seer: number
  target: number
  team: Team
  day: number
}

export interface PublicLog {
  day: number
  phase: Phase
  kind: LogKind
  /** 面向玩家的中文文案。**只含座位号，绝不含身份**（否则就从日志泄露了）。 */
  text: string
  /** 结构化字段，前端可据此高亮/播放动画。 */
  seat?: number
  target?: number
  at: number
}

/**
 * 房内文字频道的一条发言。
 *
 * `scope` 决定谁能看到：
 *   - `public`：白天（以及大厅/结算）的发言，房间里所有人（含观战）可见。
 *   - `wolf`：**夜晚**的狼队发言，只有狼人可见 —— 这是本模块隐藏信息的一部分，
 *     和"身份不能泄漏"是同一级别的要求，裁剪见 werewolf-rooms.ts。
 */
export interface WerewolfMessage {
  id: string
  /** 发送者座位。观战者不发言，所以恒有座位；留 number 以便将来扩展。 */
  seat: number
  /** 发送者显示名快照（避免人退出后座位错位导致张冠李戴）。 */
  name: string
  text: string
  scope: ChatScope
  day: number
  at: number
}

export type ChatScope = 'public' | 'wolf'

/** 单条发言长度上限。 */
export const MAX_CHAT_LEN = 200
/**
 * 房间内保留的发言条数上限。
 *
 * 发言整块序列化进 state 列，无上限地涨会吃内存也吃数据库；保留最近 200 条
 * 对"这一局里的发言"完全够用（狼人杀一局也就能说这么多）。
 */
export const MAX_CHAT_HISTORY = 200

/**
 * 服务端保存的完整状态。**绝不直接发给客户端**（见 werewolf-rooms.ts）。
 */
export interface WerewolfState {
  phase: Phase
  /** 第几天（第一夜 = 第 1 天）。 */
  day: number
  /** 本房间**目标人数**（6~12）。等待阶段 players 可能还没满，用它算"还差几个"。 */
  playerCount: number
  /** 座位 → 用户 id。长度 = playerCount（开局后）。 */
  players: string[]
  /** 座位 → 身份。waiting 阶段为空数组（还没分配）。 */
  roles: Role[]
  /** 座位 → 是否存活。 */
  alive: boolean[]
  night: NightState
  /** 昨夜结算（公开信息，day-announce 起展示）。 */
  lastNight: { victim: number | null; saved: boolean; poisoned: number | null } | null
  /** 女巫药品剩余（私密，只给女巫本人看）。 */
  witchHealLeft: boolean
  witchPoisonLeft: boolean
  /** 预言家查验历史（私密）。 */
  seerChecks: SeerCheck[]
  /** 当前投票：投票座位(字符串) → 目标座位（-1 = 弃票）。 */
  votes: Record<string, number>
  /** 上一轮投票的公开结果。 */
  lastVote: { executed: number | null; tally: Array<{ target: number; count: number }> } | null
  /** 猎人待开枪：{ seat, after }。after 表示开枪结束后回到哪个阶段。 */
  pending: { seat: number; after: Phase } | null
  /** 房内文字频道（按 scope 裁剪后才会发给玩家）。 */
  messages: WerewolfMessage[]
  /** 当前阶段死线（毫秒时间戳）。null = 无计时。 */
  deadline: number | null
  log: PublicLog[]
  winner: Team | null
  finishReason: string | null
}

function freshNight(): NightState {
  return {
    step: 'wolf',
    wolfVotes: {},
    victim: null,
    seerActed: false,
    witchActed: false,
    witchHeal: false,
    witchPoison: null,
  }
}

/**
 * 只创建"等人"状态（还没分配身份）。
 *
 * playerCount 是**目标人数**；不传时按传入的座位数推断，推断不出（比如空数组、
 * 或人数不在 6~12）就退回默认 9 人。这样旧的调用方（createGameState(playerIds)）
 * 不用改也能得到正确结果。
 */
export function createWaitingState(playerIds: string[], playerCount?: number): WerewolfState {
  const count = isValidPlayerCount(playerCount ?? 0)
    ? playerCount!
    : isValidPlayerCount(playerIds.length)
      ? playerIds.length
      : DEFAULT_PLAYER_COUNT
  return {
    phase: 'waiting',
    day: 0,
    playerCount: count,
    players: [...playerIds],
    roles: [],
    alive: playerIds.map(() => true),
    night: freshNight(),
    lastNight: null,
    witchHealLeft: true,
    witchPoisonLeft: true,
    seerChecks: [],
    votes: {},
    lastVote: null,
    pending: null,
    messages: [],
    deadline: null,
    log: [],
    winner: null,
    finishReason: null,
  }
}

// ============================================================================
// 角色分配
// ============================================================================

/**
 * 分配身份。返回"座位 → 身份"的数组，长度为 count。
 *
 * 配置来自 boardFor(count)（确定性），随机只体现在**洗牌**上。
 * 用 Fisher-Yates + crypto 随机，逐张洗牌。**不要**用"按 random 排序"那种
 * 偷懒写法（`arr.sort(() => Math.random() - 0.5)`）—— 它的分布不均匀，
 * 而且依赖 Math.random，不可复现也不安全。
 */
export function assignRoles(count: number, rng: Rng = cryptoRng): Role[] {
  const board = boardFor(count) // 非法人数在这里抛 RuleError
  const pool: Role[] = []
  for (const entry of board) {
    for (let i = 0; i < entry.count; i++) pool.push(entry.role)
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng(i + 1)
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  return pool
}

/**
 * 人凑齐（达到该房间设定的 playerCount）后开局：分配身份并进入第一夜。
 *
 * 只在 waiting 阶段可调用 —— 重复调用会把已验证的身份全部重洗，
 * 那是一个"房间刚开始还能再摇一次身份"的漏洞。
 */
export function startGame(state: WerewolfState, nowMs: number, rng: Rng = cryptoRng): void {
  if (state.phase !== 'waiting') throw new RuleError('对局已经开始了')
  if (state.players.length !== state.playerCount) {
    throw new RuleError(`需要 ${state.playerCount} 人才能开始，当前 ${state.players.length} 人`)
  }
  state.roles = assignRoles(state.playerCount, rng)
  state.alive = state.players.map(() => true)
  state.day = 1
  state.night = freshNight()
  state.lastNight = null
  state.witchHealLeft = true
  state.witchPoisonLeft = true
  state.seerChecks = []
  state.votes = {}
  state.lastVote = null
  state.pending = null
  // 开局清空大厅阶段的闲聊：这个频道是"这一局里的发言"，与"人还没齐"时的
  // 打招呼语义不同，混在一起会让第一天的记录里掺进开局的寒暄。
  state.messages = []
  state.winner = null
  state.finishReason = null
  state.phase = 'night'
  state.deadline = nowMs + NIGHT_STEP_MS
  state.log = [{ day: 1, phase: 'night', kind: 'phase', text: '天黑请闭眼', at: nowMs }]
}

/** 便捷组合：直接造一个"已经开局"的状态（测试与自动对局用）。 */
export function createGameState(playerIds: string[], nowMs = 0, rng: Rng = cryptoRng): WerewolfState {
  const state = createWaitingState(playerIds)
  startGame(state, nowMs, rng)
  return state
}

// ============================================================================
// 基础查询
// ============================================================================

export function aliveSeats(state: WerewolfState): number[] {
  return state.alive.flatMap((alive, seat) => (alive ? [seat] : []))
}

export function wolfSeats(state: WerewolfState): number[] {
  return state.roles.flatMap((role, seat) => (role === 'wolf' ? [seat] : []))
}

/** 某个身份的唯一座位（本板子预言家/女巫/猎人各一个）。找不到返回 -1。 */
export function seatOfRole(state: WerewolfState, role: Role): number {
  return state.roles.indexOf(role)
}

function isAlive(state: WerewolfState, seat: number): boolean {
  return seat >= 0 && seat < state.players.length && state.alive[seat] === true
}

// ============================================================================
// 胜负判定
// ============================================================================

export interface WinVerdict {
  over: boolean
  winner: Team | null
  reason: string | null
}

/**
 * 胜负判定。
 *
 * 规则：
 *   - 狼人全死 → 好人胜。
 *   - 狼人数 ≥ 好人数 → 狼人胜（此时狼已经控场，好人票也投不出去）。
 *   - "只剩一人"是上面两条的特例，不需要单独写：
 *       * 剩 1 个好人（狼 0）→ 命中第一条；
 *       * 剩 1 个狼（好人 0）→ 1 ≥ 0 命中第二条。
 *
 * ⚠️ 判定用 **≥** 而不是 **==** ：如果写成等于，在"夜里连死两人"（女巫又毒了一个）
 * 导致狼数从 2 直接跳到 3、好人数掉到 2 时就会漏判，对局会一直挂着。
 */
export function checkWin(state: WerewolfState): WinVerdict {
  let wolves = 0
  let good = 0
  for (let seat = 0; seat < state.roles.length; seat++) {
    if (!state.alive[seat]) continue
    if (state.roles[seat] === 'wolf') wolves++
    else good++
  }
  if (wolves === 0) return { over: true, winner: 'good', reason: 'wolves-dead' }
  if (wolves >= good) return { over: true, winner: 'wolf', reason: 'wolves-outnumber' }
  return { over: false, winner: null, reason: null }
}

// ============================================================================
// 每个阶段的合法行动（"谁能做什么"）
// ============================================================================

export type ActionKind = 'kill' | 'check' | 'witch' | 'vote' | 'shoot'

export interface LegalActions {
  canAct: boolean
  kind: ActionKind | null
  /** 可指向的座位（kill/check/poison/vote/shoot 共用）。 */
  targets: number[]
  /** 女巫专用：能不能用解药（有药 + 今晚确实有人被刀 + 人还活着）。 */
  canHeal: boolean
  canPoison: boolean
  /** 投票可弃票。 */
  canAbstain: boolean
}

const NO_ACTIONS: LegalActions = {
  canAct: false,
  kind: null,
  targets: [],
  canHeal: false,
  canPoison: false,
  canAbstain: false,
}

/**
 * 计算某个座位此刻能做什么。
 *
 * 这是"服务端权威"的规则面：客户端拿它渲染按钮，服务端拿它做校验 ——
 * **两边用同一个函数**，就不会出现"界面允许但服务端拒绝"的割裂。
 * 观战者（seat 越界）与死人一律得到 NO_ACTIONS。
 */
export function legalActions(state: WerewolfState, seat: number): LegalActions {
  if (state.phase === 'finished' || state.phase === 'waiting') return NO_ACTIONS
  if (seat < 0 || seat >= state.players.length) return NO_ACTIONS

  // 等猎人开枪时，全场只有他一个人能动。
  // 注意：**猎人此时已经死了**（正是死亡触发了他开枪），所以这里绝不能再用
  // isAlive 去卡他 —— 否则 pending 座位永远不可行动，猎人等于被吃掉天赋。
  if (state.phase === 'hunter') {
    if (state.pending?.seat !== seat) return NO_ACTIONS
    return {
      canAct: true,
      kind: 'shoot',
      targets: aliveSeats(state).filter((s) => s !== seat),
      canHeal: false,
      canPoison: false,
      canAbstain: true,
    }
  }

  if (!isAlive(state, seat)) return NO_ACTIONS

  if (state.phase === 'night') {
    const role = state.roles[seat]
    const others = aliveSeats(state).filter((s) => s !== seat)
    if (state.night.step === 'wolf' && role === 'wolf') {
      // 允许刀任意存活玩家（含别的狼），不做"不能刀队友"的特判 ——
      // 真实对局里狼不会刀队友，而写这条限制反而要额外分支；允许它不影响正确性。
      return { canAct: true, kind: 'kill', targets: others, canHeal: false, canPoison: false, canAbstain: false }
    }
    if (state.night.step === 'seer' && role === 'seer' && !state.night.seerActed) {
      return { canAct: true, kind: 'check', targets: others, canHeal: false, canPoison: false, canAbstain: false }
    }
    if (state.night.step === 'witch' && role === 'witch' && !state.night.witchActed) {
      const victim = state.night.victim
      const canHeal = state.witchHealLeft && victim !== null && isAlive(state, victim)
      const canPoison = state.witchPoisonLeft
      return { canAct: true, kind: 'witch', targets: others, canHeal, canPoison, canAbstain: true }
    }
    return NO_ACTIONS
  }

  if (state.phase === 'day-vote') {
    return {
      canAct: true,
      kind: 'vote',
      targets: aliveSeats(state).filter((s) => s !== seat),
      canHeal: false,
      canPoison: false,
      canAbstain: true,
    }
  }

  return NO_ACTIONS
}

/** 某个座位此刻是否"轮到我"。 */
export function canSeatAct(state: WerewolfState, seat: number): boolean {
  return legalActions(state, seat).canAct
}

// ============================================================================
// 房内文字频道（谁能发言 / 谁能看到）
// ============================================================================
//
// ⚠️ 这个频道同样受**隐藏信息**约束，和"身份不能泄漏"是同一级别的要求：
//   - 白天（及大厅/结算）：公开频道，房间里所有人（含观战）可见。
//   - **夜晚**：狼队私频。只有狼人能发言，且只有狼人看得到 —— 这是狼队
//     商量刀谁的地方。非狼玩家（含观战者）无论在 payload 里还是通过任何接口
//     都**拿不到**这些消息（裁剪在 werewolf-rooms.ts 的 buildWerewolfView）。
//
// 关于"出局的人能不能说/能看"（规则由本实现定，理由写在这里，全站一致）：
//   - **发言**：出局的人不能发言（死人退出游戏，让他还能跟活人对话会立刻
//     破坏推理）。观战者同理不能发言。
//   - **看公开频道**：可以。白天发言是公开信息，和公开记录一样，出局/观战都能看。
//   - **看狼队私频**：只要是狼身份就能看（含已出局的狼）—— 狼队友身份本来
//     对狼就是公开的（teammates 也包含已出局的狼），死亡不改变这一点；
//     但他们同样受"死人不能发言"约束。

/**
 * 当前频道：夜晚是狼队私频，其余（白天/大厅/结算）是公开频道。
 *
 * ⚠️ 判定里**必须带上"夜刀之后的猎人阶段"**，这一条是审查抓出来的泄漏：
 *
 * 猎人被狼刀死时，\`resolveNight\` 会把 phase 从 'night' 直接切成 'hunter'
 * （pending.after = 'day-announce'）—— 也就是**天还没亮、结果还没公布**，
 * 游戏叙事上仍然处于夜晚。而这里原来只看 \`phase === 'night'\`，
 * 于是这 20 秒的窗口里频道会静默变成公开：
 * 狼给队友发的"3 号是自己人"，会被打上 scope='public'，
 * 然后推给**所有玩家和观战者**。
 *
 * 9 人默认板子有猎人，所以线上正在用的棋盘就会触发。
 *
 * 反向也要注意：因**投票出局**触发的猎人开枪（pending.after === 'night'）
 * 发生在白天，那时频道本来就该是公开的，不能一起算成夜晚。
 */
export function chatScope(state: WerewolfState): ChatScope {
  if (state.phase === 'night') return 'wolf'
  if (state.phase === 'hunter' && state.pending?.after === 'day-announce') return 'wolf'
  return 'public'
}

/** 某个座位此刻能不能发言。观战者(座位越界)与出局者一律不能。 */
export function canSendChat(state: WerewolfState, seat: number): boolean {
  if (seat < 0 || seat >= state.players.length) return false
  if (state.alive[seat] !== true) return false
  // 夜晚只有狼能发言
  if (chatScope(state) === 'wolf') return state.roles[seat] === 'wolf'
  return true
}

/** 某个座位能不能看到狼队私频的历史（狼身份可见，含已出局的狼；观战者/非狼不行）。 */
export function canSeeWolfChat(state: WerewolfState, seat: number): boolean {
  return seat >= 0 && seat < state.roles.length && state.roles[seat] === 'wolf'
}

/**
 * 追加一条发言。校验"现在能不能发言"，失败抛 RuleError（房间层翻成 400）。
 * 返回落库后的这条消息（前端可用它做"我发的"高亮）。
 */
export function addChatMessage(
  state: WerewolfState,
  seat: number,
  name: string,
  text: string,
  nowMs: number,
): WerewolfMessage {
  if (!canSendChat(state, seat)) throw new RuleError('现在你不能发言')
  const trimmed = text.trim()
  if (!trimmed) throw new RuleError('发言不能为空')
  if (trimmed.length > MAX_CHAT_LEN) throw new RuleError(`发言不能超过 ${MAX_CHAT_LEN} 个字`)

  const message: WerewolfMessage = {
    id: randomUUID(),
    seat,
    name,
    text: trimmed,
    scope: chatScope(state),
    day: state.day,
    at: nowMs,
  }
  state.messages.push(message)
  // 无上限会把 state 越撑越大；只留最近若干条，老的直接丢（游戏内发言没有留存价值）
  if (state.messages.length > MAX_CHAT_HISTORY) {
    state.messages.splice(0, state.messages.length - MAX_CHAT_HISTORY)
  }
  return message
}

// ============================================================================
// 夜晚：行动收集
// ============================================================================

function assertNightStep(state: WerewolfState, step: NightStep, who: string): void {
  if (state.phase !== 'night') throw new RuleError(`${who}只能在夜晚行动`)
  if (state.night.step !== step) throw new RuleError(`现在不是${who}行动的时机`)
}

/** 狼刀：一次一刀（记名投票），支持改票（后一次覆盖前一次）。 */
export function applyWolfKill(state: WerewolfState, seat: number, target: number): void {
  assertNightStep(state, 'wolf', '狼人')
  if (state.roles[seat] !== 'wolf') throw new RuleError('只有狼人能刀人')
  if (!isAlive(state, seat)) throw new RuleError('你已经出局了')
  if (!isAlive(state, target)) throw new RuleError('目标不是存活玩家')
  if (target === seat) throw new RuleError('不能刀自己')
  state.night.wolfVotes[String(seat)] = target
}

/** 预言家查验：返回被查者的阵营。结果只入私密记录，不进公开日志。 */
export function applySeerCheck(state: WerewolfState, seat: number, target: number): { target: number; team: Team } {
  assertNightStep(state, 'seer', '预言家')
  if (state.roles[seat] !== 'seer') throw new RuleError('只有预言家能查验')
  if (!isAlive(state, seat)) throw new RuleError('你已经出局了')
  if (state.night.seerActed) throw new RuleError('本晚已经查验过了')
  if (!isAlive(state, target)) throw new RuleError('目标不是存活玩家')
  if (target === seat) throw new RuleError('不能查验自己')

  const team = roleTeam(state.roles[target]!)
  state.night.seerActed = true
  state.seerChecks.push({ seer: seat, target, team, day: state.day })
  return { target, team }
}

export interface WitchChoice {
  /** 是否使用解药救今晚被刀的人。 */
  heal?: boolean
  /** 毒杀目标（null / 省略表示不毒）。 */
  poisonTarget?: number | null
}

/**
 * 女巫行动。
 *
 * 规则要点：
 *   - 解药只能救"今晚被狼刀的人"，不能救别人（所以没被刀时我用不了解药）。
 *   - 毒药可以毒任意存活玩家（不能毒自己）。
 *   - **同一晚不能同时用两瓶药** —— 这是标准规则，也让"女巫一夜双杀"这种
 *     破坏平衡的情况不会出现。
 *   - 什么都不做也算"行动过了"（witchActed = true），否则轮次不会推进。
 */
export function applyWitch(state: WerewolfState, seat: number, choice: WitchChoice): void {
  assertNightStep(state, 'witch', '女巫')
  if (state.roles[seat] !== 'witch') throw new RuleError('只有女巫能用药')
  if (!isAlive(state, seat)) throw new RuleError('你已经出局了')
  if (state.night.witchActed) throw new RuleError('本晚已经行动过了')

  const heal = choice.heal === true
  const poison = choice.poisonTarget ?? null

  if (heal && poison !== null) throw new RuleError('同一晚不能同时用解药和毒药')

  if (heal) {
    if (!state.witchHealLeft) throw new RuleError('解药已经用过了')
    if (state.night.victim === null) throw new RuleError('今晚没有人被刀，用不了解药')
    if (!isAlive(state, state.night.victim)) throw new RuleError('被刀的人已经出局了')
  }
  if (poison !== null) {
    if (!state.witchPoisonLeft) throw new RuleError('毒药已经用过了')
    if (!isAlive(state, poison)) throw new RuleError('目标不是存活玩家')
    if (poison === seat) throw new RuleError('不能毒自己')
  }

  state.night.witchActed = true
  state.night.witchHeal = heal
  state.night.witchPoison = poison
}

/**
 * 狼的刀口 = 得票最多的目标。平票时取**座位号小的** —— 关键是要有一条
 * 确定的规则，否则"三个狼各刀一个"这种局面下结算结果会随对象遍历顺序漂移。
 */
export function tallyWolfVotes(state: WerewolfState): number | null {
  const counts = new Map<number, number>()
  for (const target of Object.values(state.night.wolfVotes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [target, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = target
      bestCount = count
    }
  }
  return best
}

/** 某个夜晚子步骤是否已经完成（所有人都行动过，或该角色已出局）。 */
export function nightStepDone(state: WerewolfState): boolean {
  const step = state.night.step
  if (step === 'wolf') {
    const wolves = aliveSeats(state).filter((s) => state.roles[s] === 'wolf')
    return wolves.length > 0 && wolves.every((s) => state.night.wolfVotes[String(s)] !== undefined)
  }
  if (step === 'seer') {
    const seer = seatOfRole(state, 'seer')
    return !isAlive(state, seer) || state.night.seerActed
  }
  const witch = seatOfRole(state, 'witch')
  return !isAlive(state, witch) || state.night.witchActed
}

// ============================================================================
// 夜晚结算
// ============================================================================

export interface NightOutcome {
  victim: number | null
  saved: boolean
  poisoned: number | null
  /** 本次夜晚实际死亡的座位（去重）。 */
  deaths: number[]
}

/** **纯函数**：算出这一夜会死谁，不改 state。方便单独断言。 */
export function computeNightOutcome(state: WerewolfState): NightOutcome {
  const victim = state.night.victim
  const saved = state.night.witchHeal && victim !== null
  const poisoned = state.night.witchPoison

  const deaths = new Set<number>()
  if (victim !== null && !saved) deaths.add(victim)
  if (poisoned !== null) deaths.add(poisoned)
  return { victim, saved, poisoned, deaths: [...deaths].sort((a, b) => a - b) }
}

// ============================================================================
// 白天投票
// ============================================================================

/** 投票：target 为 null 表示弃票。支持改票（后一次覆盖前一次）。 */
export function applyVote(state: WerewolfState, seat: number, target: number | null): void {
  if (state.phase !== 'day-vote') throw new RuleError('现在不是投票阶段')
  if (!isAlive(state, seat)) throw new RuleError('出局的人不能投票')
  if (target !== null) {
    if (!isAlive(state, target)) throw new RuleError('目标不是存活玩家')
    if (target === seat) throw new RuleError('不能投自己')
  }
  state.votes[String(seat)] = target === null ? -1 : target
}

/** **纯函数**：统计票型。弃票(-1)与指向死人的票都不计入。 */
export function tallyVotes(state: WerewolfState): Array<{ target: number; count: number }> {
  const counts = new Map<number, number>()
  for (const target of Object.values(state.votes)) {
    if (target < 0 || !isAlive(state, target)) continue
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count || a.target - b.target)
}

/**
 * 投票结果：得票最多者出局。
 *
 * **平票时无人出局**（不做"PK 再投一轮"）—— 理由：再投一轮要么又要引入一个
 * 新的计时阶段，要么在平票的平票上无限套娃，收益配不上复杂度。平票不出局
 * 在大多数线上狼人杀里也是可接受的默认。
 */
export function executedFromTally(tally: Array<{ target: number; count: number }>): number | null {
  if (tally.length === 0) return null
  const top = tally[0]!
  if (top.count === 0) return null
  const tied = tally.filter((entry) => entry.count === top.count)
  return tied.length === 1 ? top.target : null
}

// ============================================================================
// 猎人开枪
// ============================================================================

export function applyHunterShot(state: WerewolfState, seat: number, target: number | null, nowMs: number): void {
  if (state.phase !== 'hunter') throw new RuleError('现在不是开枪的时机')
  if (state.pending?.seat !== seat) throw new RuleError('不该你开枪')
  if (target !== null) {
    if (!isAlive(state, target)) throw new RuleError('目标不是存活玩家')
    if (target === seat) throw new RuleError('不能带走自己')
  }
  const after = state.pending.after
  if (target !== null) {
    state.alive[target] = false
    state.log.push({
      day: state.day,
      phase: 'hunter',
      kind: 'shot',
      text: `${seat + 1}号 开枪带走了 ${target + 1}号`,
      seat,
      target,
      at: nowMs,
    })
  } else {
    state.log.push({
      day: state.day,
      phase: 'hunter',
      kind: 'shot',
      text: `${seat + 1}号 放弃开枪`,
      seat,
      at: nowMs,
    })
  }
  // 开枪本身可能改变胜负（比如带走了最后一只狼）
  const win = checkWin(state)
  if (win.over) {
    finish(state, win, nowMs)
    return
  }
  state.pending = null
  resumeAfterHunter(state, after, nowMs)
}

// ============================================================================
// 阶段推进 / 超时兜底
// ============================================================================

function finish(state: WerewolfState, win: WinVerdict, nowMs: number): void {
  state.phase = 'finished'
  state.winner = win.winner
  state.finishReason = win.reason
  state.deadline = null
  state.pending = null
  state.log.push({
    day: state.day,
    phase: 'finished',
    kind: 'end',
    text: win.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜',
    at: nowMs,
  })
}

function resumeAfterHunter(state: WerewolfState, after: Phase, nowMs: number): void {
  if (after === 'night') {
    startNight(state, nowMs)
    return
  }
  state.phase = 'day-announce'
  state.deadline = nowMs + ANNOUNCE_MS
}

/** 进入新的一夜。day +1，清空当晚行动收集。 */
function startNight(state: WerewolfState, nowMs: number): void {
  state.day += 1
  state.night = freshNight()
  state.lastNight = null
  state.votes = {}
  state.pending = null
  state.phase = 'night'
  state.deadline = nowMs + NIGHT_STEP_MS
  state.log.push({ day: state.day, phase: 'night', kind: 'phase', text: '天黑请闭眼', at: nowMs })
}

function seatLabel(seat: number): string {
  return `${seat + 1}号`
}

/** 结算夜晚：应用死亡、判定胜负、必要时挂起等猎人。 */
function resolveNight(state: WerewolfState, nowMs: number): void {
  const outcome = computeNightOutcome(state)
  state.lastNight = { victim: outcome.victim, saved: outcome.saved, poisoned: outcome.poisoned }

  // 用药就消耗掉（哪怕救的是自己/毒的是自己，规则一致）
  if (state.night.witchHeal) state.witchHealLeft = false
  if (state.night.witchPoison !== null) state.witchPoisonLeft = false

  for (const seat of outcome.deaths) {
    state.alive[seat] = false
    state.log.push({ day: state.day, phase: 'night', kind: 'death', text: `${seatLabel(seat)} 倒在了夜里`, seat, at: nowMs })
  }
  if (outcome.victim !== null && outcome.saved) {
    state.log.push({ day: state.day, phase: 'night', kind: 'night', text: '女巫用了解药，今晚平安无事', at: nowMs })
  }

  const win = checkWin(state)
  if (win.over) {
    finish(state, win, nowMs)
    return
  }

  // 猎人被狼刀可以开枪；被女巫毒死则不能（这是为了平衡：毒药是"无声"的解法）。
  const hunter = seatOfRole(state, 'hunter')
  if (outcome.deaths.includes(hunter) && outcome.poisoned !== hunter) {
    state.pending = { seat: hunter, after: 'day-announce' }
    state.phase = 'hunter'
    state.deadline = nowMs + HUNTER_MS
    return
  }

  state.phase = 'day-announce'
  state.deadline = nowMs + ANNOUNCE_MS
}

/** 结算投票。 */
function resolveVote(state: WerewolfState, nowMs: number): void {
  const tally = tallyVotes(state)
  const executed = executedFromTally(tally)
  state.lastVote = { executed, tally }

  if (executed !== null) {
    state.alive[executed] = false
    state.log.push({ day: state.day, phase: 'day-vote', kind: 'vote', text: `${seatLabel(executed)} 被投票放逐`, seat: executed, at: nowMs })
  } else {
    state.log.push({ day: state.day, phase: 'day-vote', kind: 'vote', text: '平票，本轮无人出局', at: nowMs })
  }

  const win = checkWin(state)
  if (win.over) {
    finish(state, win, nowMs)
    return
  }

  const hunter = seatOfRole(state, 'hunter')
  if (executed === hunter) {
    state.pending = { seat: hunter, after: 'night' }
    state.phase = 'hunter'
    state.deadline = nowMs + HUNTER_MS
    return
  }

  startNight(state, nowMs)
}

/**
 * 推进状态机。**每次玩家动作之后、以及定时器 tick 时都要调用它。**
 *
 * 它做两件事：
 *   1. 若当前步骤/阶段的条件已满足（所有人都行动了）→ 结算并进入下一阶段；
 *   2. 若已过死线 → **替掉线的人把这一步走完**（超时兜底），再进入下一阶段。
 *
 * 内部用 while 循环一路推进到底，直到"需要真人输入且还没到点"才停下 ——
 * 这样一次调用就能把"夜晚结束→公布→发言"这类无需操作的过渡全部走完。
 * guard 是为了防止某个分支漏写转移条件导致死循环（宁可抛错也不要卡死进程）。
 */
export function advance(state: WerewolfState, nowMs: number): void {
  let guard = 0
  while (true) {
    if (++guard > 200) throw new RuleError('状态机未收敛（内部错误）')
    if (state.phase === 'finished' || state.phase === 'waiting') return

    const expired = nowMs >= (state.deadline ?? Number.POSITIVE_INFINITY)

    if (state.phase === 'hunter') {
      if (!expired) return
      // 超时 = 弃枪
      const seat = state.pending!.seat
      const after = state.pending!.after
      state.log.push({ day: state.day, phase: 'hunter', kind: 'shot', text: `${seatLabel(seat)} 超时未开枪`, seat, at: nowMs })
      state.pending = null
      resumeAfterHunter(state, after, nowMs)
      continue
    }

    if (state.phase === 'night') {
      if (!nightStepDone(state) && !expired) return
      const step = state.night.step
      if (step === 'wolf') {
        state.night.victim = tallyWolfVotes(state)
        state.night.step = 'seer'
        state.deadline = nowMs + NIGHT_STEP_MS
        continue
      }
      if (step === 'seer') {
        state.night.step = 'witch'
        state.deadline = nowMs + NIGHT_STEP_MS
        continue
      }
      resolveNight(state, nowMs)
      continue
    }

    if (state.phase === 'day-announce') {
      if (!expired) return
      state.phase = 'day-discuss'
      state.deadline = nowMs + DISCUSS_MS
      continue
    }

    if (state.phase === 'day-discuss') {
      if (!expired) return
      state.phase = 'day-vote'
      state.votes = {}
      state.deadline = nowMs + VOTE_MS
      continue
    }

    if (state.phase === 'day-vote') {
      const alive = aliveSeats(state)
      const allVoted = alive.every((seat) => state.votes[String(seat)] !== undefined)
      if (!allVoted && !expired) return
      resolveVote(state, nowMs)
      continue
    }

    return
  }
}

// ============================================================================
// 供界面使用的"当前该谁"信息
// ============================================================================

/**
 * 当前阶段正在等谁（公开信息，用来显示"等待 3 号行动"）。
 * 夜晚每个子步骤返回该角色的存活玩家；白天投票返回所有存活玩家。
 */
export function waitingOn(state: WerewolfState): number[] {
  if (state.phase === 'hunter') return state.pending ? [state.pending.seat] : []
  if (state.phase === 'night') {
    const step = state.night.step
    if (step === 'wolf') {
      return aliveSeats(state).filter(
        (s) => state.roles[s] === 'wolf' && state.night.wolfVotes[String(s)] === undefined,
      )
    }
    if (step === 'seer') {
      const seer = seatOfRole(state, 'seer')
      return isAlive(state, seer) && !state.night.seerActed ? [seer] : []
    }
    const witch = seatOfRole(state, 'witch')
    return isAlive(state, witch) && !state.night.witchActed ? [witch] : []
  }
  if (state.phase === 'day-vote') return aliveSeats(state).filter((s) => state.votes[String(s)] === undefined)
  return []
}
