/**
 * 狼人杀房间（服务端权威 + 按玩家视角裁剪状态）。
 *
 * ============================================================================
 * 这个文件最重要的职责：**toWerewolfView / buildWerewolfView**
 * ============================================================================
 * 狼人杀是隐藏信息游戏。服务端 state 里有每个人的身份（roles），
 * 但发给任何一个玩家的 payload 绝不能带上别人的身份 —— 前端藏起来没有用，
 * 打开浏览器控制台就看见了。这是评审团在斗地主模块就点名过的硬要求
 * （见 doudizhu-rooms.ts 顶部的说明），狼人杀比斗地主更极端：
 *   斗地主只是"看不到手牌"，狼人杀是"看不到别人是谁"，泄露一次就毁掉整局。
 *
 * 裁剪规则（都在 buildWerewolfView 里）：
 *   - myRole：只有"我自己的"身份是明确的。
 *   - teammates：只有我是狼时才给狼队友的座位（狼互相可见是规则的一部分）。
 *   - myChecks：预言家的查验结果只给预言家本人。
 *   - myPotions / witchNightVictim：女巫的药品与"今晚谁被刀了"只给女巫本人。
 *   - messages：**夜晚的狼队私频只给狼人**；白天发言与其余字段一样是公开信息。
 *   - 其余字段（谁死了、票型、日志、板子构成）都是公开信息。
 *
 * buildWerewolfView 是**纯函数**（只吃 state + 座位信息，不碰数据库），
 * 所以 scripts/werewolf-test.mjs 可以逐字段地验证"非狼玩家的 view 里不含
 * 任何别人的身份"，以及"非狼玩家在夜晚拿不到任何狼队发言"。
 *
 * ============================================================================
 * 为什么复用 game_rooms 表（而不是新建一张 werewolf_rooms）
 * ============================================================================
 * 本模块被要求"不改 db.ts"（迁移只能由另一个人追加），所以这里刻意复用已有的
 * game_rooms 表：把**全部对局状态**序列化进它的 `state` 列，各座位的信息存在
 * state.players / state.roles / state.alive 里（人数 6~12 都装得下）。
 *
 * 为什么不把玩家塞进 red_player/seat_1/seat_2 三列：狼人杀最多有 12 个座位，
 * 三列根本装不下；而且"十来个人的圈"和棋类的"两方"语义完全不同，硬塞进现有列会让
 * 后面到处写特判。整块 JSON 进 state 列最简单，也不会出现"事件流与快照不一致"。
 */

import { getDb, newId, now, transaction } from '../db.ts'
import { HttpError } from '../files.ts'
import {
  DEFAULT_PLAYER_COUNT,
  ROLE_LABELS,
  RuleError,
  addChatMessage,
  advance,
  applyHunterShot,
  applySeerCheck,
  applyVote,
  applyWitch,
  applyWolfKill,
  boardFor,
  canSeeWolfChat,
  canSendChat,
  chatScope,
  createWaitingState,
  isValidPlayerCount,
  legalActions,
  roleTeam,
  startGame,
  waitingOn,
  type ActionKind,
  type ChatScope,
  type Phase,
  type PublicLog,
  type Role,
  type Team,
  type WerewolfMessage,
  type WerewolfState,
  type WitchChoice,
} from './werewolf.ts'

// ============================================================================
// 视图类型（发给客户端的形状）
// ============================================================================

export interface WerewolfSeatView {
  seat: number
  userId: string | null
  name: string | null
  online: boolean
  alive: boolean
  isMe: boolean
}

export interface WerewolfView {
  id: string
  kind: 'werewolf'
  title: string
  phase: Phase
  day: number
  createdBy: string
  creatorName: string
  /** 本房间的目标人数（6~12），界面用它显示"还差几个"。 */
  playerCount: number
  /** 板子构成（公开：规则本就人人知道）。按 playerCount 推出。 */
  board: Array<{ role: Role; label: string; team: Team; count: number }>
  players: WerewolfSeatView[]
  mySeat: number | null
  /**
   * ⚠️ 我自己的身份。**这是 view 里唯一一处"玩家→身份"的映射**，
   * 而且只映射我自己。观战者为 null。
   */
  myRole: Role | null
  myRoleLabel: string | null
  myTeam: Team | null
  /** 狼队友的座位（仅当我是狼）。其余人一律 null。 */
  teammates: number[] | null
  /** 预言家的查验记录（仅当我是预言家）。 */
  myChecks: Array<{ target: number; team: Team; day: number }> | null
  /** 女巫的药品剩余（仅当我是女巫）。 */
  myPotions: { heal: boolean; poison: boolean } | null
  /** 今晚被狼刀的目标（仅当我是女巫、且处于夜晚）—— 她靠这个决定要不要救。 */
  witchNightVictim: number | null
  /** 此刻我能不能行动，以及能做什么（前端渲染按钮用，服务端同一套规则校验）。 */
  canAct: boolean
  actionKind: ActionKind | null
  legalTargets: number[]
  canHeal: boolean
  canPoison: boolean
  canAbstain: boolean
  /** 本阶段我是否已经行动过。 */
  acted: boolean
  myTurn: boolean
  /** 当前阶段正在等谁（公开）。 */
  waitingOn: number[]
  /** 票型（公开，见下面 toWerewolfView 上方关于"投票公开"的说明）。 */
  votes: Array<{ voter: number; target: number | null }>
  lastVote: { executed: number | null; tally: Array<{ target: number; count: number }> } | null
  lastNight: { victim: number | null; saved: boolean; poisoned: number | null } | null
  /** 等待开枪的猎人座位（公开：死了猎人大家都会知道）。 */
  pendingHunter: number | null
  log: PublicLog[]
  deadline: number | null
  winner: Team | null
  finishReason: string | null
  /**
   * 房内文字频道里**我这个视角能看到**的消息。
   * ⚠️ 夜晚的狼队私频对非狼（含观战者）在这里根本不存在 —— 不是前端藏起来。
   */
  messages: WerewolfMessage[]
  /** 当前频道（夜晚 = wolf，其余 = public；公开信息，人人都知道现在是不是夜里）。 */
  chatScope: ChatScope
  /** 此刻我能不能发言（观战者、出局者、夜晚的非狼都不能）。 */
  canChat: boolean
  createdAt: number
  updatedAt: number
}

// ============================================================================
// 纯函数：按视角裁剪
// ============================================================================

export interface WerewolfRoomMeta {
  id: string
  title: string
  createdBy: string
  creatorName: string
  createdAt: number
  updatedAt: number
}

/**
 * 把 state + 座位信息裁剪成某个请求者能看到的视图。**纯函数**。
 *
 * 关于"投票是否公开"：这里选择**公开**，即每个人都看得到谁投了谁。
 * 理由：线下的举手表决本来就是公开的，公开票型是好人的推理依据，也是这类游戏
 * 乐趣的核心；把它藏起来反而需要额外发明一套"投票匿名但结果公开"的约定。
 * 至于"狼可以照着票型配合"——语音开黑场景下这本来就存在，不是界面能防的。
 * 真正必须藏的是**身份**，那个上面已经处理。
 */
/**
 * 把「当前该谁行动」按**请求者的视角**裁剪。
 *
 * ⚠️ 这个函数存在的唯一理由是堵一个隐藏信息泄漏，不是排版偏好。
 *
 * `waitingOn(state)` 在夜晚返回的是"哪个狼还没刀人""预言家行动了没有""女巫行动了没有" ——
 * 而**这些座位号本身就等于身份**。原样发出去，任何人打开房间（或者第 9 个人
 * 一坐下触发的那次推送）就能从浏览器控制台直接读出三个狼、预言家、女巫分别是谁，
 * 整个游戏的隐藏信息前提当场失效。
 *
 * 所以夜晚只对**正在行动的那个人**返回他自己，对其他人一律返回空数组：
 * 界面照样能显示"等待某人行动"，只是不点名。本人渲染操作按钮用的是 myTurn，
 * 不依赖这个字段。
 *
 * 白天投票与猎人开枪是全桌都知道的公开节奏，保留原样。
 */
function publicWaitingOn(state: WerewolfState, mySeat: number | null): number[] {
  const seats = waitingOn(state)
  if (state.phase !== 'night') return seats
  // 观战者没有座位 —— 夜晚对他一律不点名
  if (mySeat === null) return []
  return seats.includes(mySeat) ? [mySeat] : []
}

export function buildWerewolfView(
  meta: WerewolfRoomMeta,
  state: WerewolfState,
  seats: Array<{ seat: number; userId: string | null; name: string | null }>,
  viewerId: string,
  onlineIds: Set<string>,
): WerewolfView {
  const mySeat = state.players.indexOf(viewerId)
  const myIndex = mySeat === -1 ? null : mySeat
  const myRole: Role | null = myIndex === null ? null : (state.roles[myIndex] ?? null)
  const isWolf = myRole === 'wolf'

  const playerViews: WerewolfSeatView[] = seats.map((s) => ({
    seat: s.seat,
    userId: s.userId,
    name: s.name,
    online: s.userId ? onlineIds.has(s.userId) : false,
    alive: state.alive[s.seat] === true,
    isMe: s.userId === viewerId,
  }))

  const actions = myIndex === null ? null : legalActions(state, myIndex)

  // ---- 私密信息：每一项都严格要求"只有本人能拿到" ----
  // 狼队友：包含已出局的狼（他知道都有谁，出局也不影响）。
  const teammates = isWolf
    ? state.roles.flatMap((role, seat) => (role === 'wolf' && seat !== myIndex ? [seat] : []))
    : null

  const myChecks =
    myRole === 'seer'
      ? state.seerChecks.filter((c) => c.seer === myIndex).map((c) => ({ target: c.target, team: c.team, day: c.day }))
      : null

  const myPotions = myRole === 'witch' ? { heal: state.witchHealLeft, poison: state.witchPoisonLeft } : null

  // 女巫只有在夜晚（还没结算）才看得到刀口，白天的刀口是公开信息（lastNight）
  const witchNightVictim = myRole === 'witch' && state.phase === 'night' ? state.night.victim : null

  // ---- 是否已行动 ----
  let acted = false
  if (myIndex !== null) {
    if (state.phase === 'night') {
      if (state.night.step === 'wolf') acted = state.night.wolfVotes[String(myIndex)] !== undefined
      else if (state.night.step === 'seer') acted = myRole === 'seer' ? state.night.seerActed : false
      else acted = myRole === 'witch' ? state.night.witchActed : false
    } else if (state.phase === 'day-vote') {
      acted = state.votes[String(myIndex)] !== undefined
    }
  }

  // ---- 房内文字频道：按 scope 裁剪 ----
  // 公开频道人人可见；狼队私频只有狼身份（含已出局的狼，见 werewolf.ts 的规则说明）
  // 才能看到。观战者与非狼拿到的 messages 里**根本不含**狼队发言。
  const seesWolfChat = myIndex !== null && canSeeWolfChat(state, myIndex)
  const messages = state.messages.filter((m) => m.scope === 'public' || seesWolfChat)

  return {
    id: meta.id,
    kind: 'werewolf',
    title: meta.title,
    phase: state.phase,
    day: state.day,
    createdBy: meta.createdBy,
    creatorName: meta.creatorName,
    playerCount: state.playerCount,
    board: boardFor(state.playerCount).map((entry) => ({
      role: entry.role,
      label: ROLE_LABELS[entry.role],
      team: roleTeam(entry.role),
      count: entry.count,
    })),
    players: playerViews,
    mySeat: myIndex,
    myRole,
    myRoleLabel: myRole ? ROLE_LABELS[myRole] : null,
    myTeam: myRole ? roleTeam(myRole) : null,
    teammates,
    myChecks,
    myPotions,
    witchNightVictim,
    canAct: actions?.canAct ?? false,
    actionKind: actions?.kind ?? null,
    legalTargets: actions?.targets ?? [],
    canHeal: actions?.canHeal ?? false,
    canPoison: actions?.canPoison ?? false,
    canAbstain: actions?.canAbstain ?? false,
    acted,
    myTurn: actions?.canAct ?? false,
    waitingOn: publicWaitingOn(state, myIndex),
    votes: Object.entries(state.votes)
      .map(([voter, target]) => ({ voter: Number(voter), target: target < 0 ? null : target }))
      .sort((a, b) => a.voter - b.voter),
    lastVote: state.lastVote,
    lastNight: state.lastNight,
    pendingHunter: state.pending?.seat ?? null,
    log: state.log.slice(-60),
    deadline: state.deadline,
    winner: state.winner,
    finishReason: state.finishReason,
    messages,
    chatScope: chatScope(state),
    canChat: myIndex !== null && canSendChat(state, myIndex),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

// ============================================================================
// 数据库读写
// ============================================================================

interface RawRow {
  id: string
  title: string
  status: string
  created_by: string
  creator_name: string
  state: string | null
  created_at: number
  updated_at: number
}

const WW_SELECT = `
  SELECT r.*, c.display_name AS creator_name
    FROM game_rooms r
    JOIN users c ON c.id = r.created_by
`

function readRow(id: string): RawRow | null {
  const row = getDb()
    .prepare(`${WW_SELECT} WHERE r.id = ? AND r.kind = 'werewolf'`)
    .get(id) as RawRow | undefined
  return row ?? null
}

/**
 * 状态坏掉时**不能**退化成空房间：狼人杀的身份一旦丢失，这一局就没法继续，
 * 而且悄悄重开还会让已经死了/还活着的人错乱。所以这里明确报错，让上层提示重开。
 * （这一点和斗地主的取舍不同 —— 斗地主状态坏了重发一手牌还能玩。）
 */
function parseState(raw: string | null): WerewolfState {
  if (!raw) return createWaitingState([])
  let state: WerewolfState
  try {
    state = JSON.parse(raw) as WerewolfState
  } catch {
    throw new HttpError(500, '房间状态损坏，请重开一局')
  }
  // 兼容旧数据：本功能之前落库的状态里没有 playerCount / messages。
  // 那些房间一律是 9 人局（当时唯一合法人数），照默认补上即可，不至于让
  // 一个进行中的旧房间因为缺字段而读不出来。
  if (!isValidPlayerCount(state.playerCount)) state.playerCount = DEFAULT_PLAYER_COUNT
  if (!Array.isArray(state.messages)) state.messages = []
  return state
}

function persist(roomId: string, state: WerewolfState): void {
  const status = state.phase === 'waiting' ? 'waiting' : state.phase === 'finished' ? 'finished' : 'playing'
  const result =
    state.phase === 'finished' ? JSON.stringify({ winner: state.winner, reason: state.finishReason }) : null
  const ts = now()
  getDb()
    .prepare(
      `UPDATE game_rooms
          SET state = ?, status = ?, result = ?, updated_at = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(JSON.stringify(state), status, result, ts, status === 'finished' ? ts : null, roomId)
}

/** 批量取显示名。放一次 IN 查询里，不要每个座位查一次。 */
function namesFor(userIds: string[]): Map<string, string> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()
  const placeholders = unique.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT id, display_name FROM users WHERE id IN (${placeholders})`)
    .all(...unique) as unknown as Array<{ id: string; display_name: string }>
  return new Map(rows.map((row) => [row.id, row.display_name]))
}

function toWerewolfView(row: RawRow, viewerId: string, onlineIds: Set<string>): WerewolfView {
  const state = parseState(row.state)
  const names = namesFor(state.players)
  const seats = state.players.map((userId, seat) => ({
    seat,
    userId,
    name: names.get(userId) ?? null,
  }))
  return buildWerewolfView(
    {
      id: row.id,
      title: row.title,
      createdBy: row.created_by,
      creatorName: row.creator_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    state,
    seats,
    viewerId,
    onlineIds,
  )
}

// ============================================================================
// 房间生命周期
// ============================================================================

export function getWerewolfView(roomId: string, viewerId: string, onlineIds: Set<string>): WerewolfView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  return toWerewolfView(row, viewerId, onlineIds)
}

/** 房间里需要收到定向推送的人（座位上的玩家，数量 = playerCount）。观战者靠主动拉取。 */
export function werewolfMembers(roomId: string): string[] {
  const row = readRow(roomId)
  if (!row) return []
  const state = parseState(row.state)
  return state.players.filter((id): id is string => Boolean(id))
}

export function listWerewolfRooms(viewerId: string, onlineIds: Set<string>, onlyOpen = false): WerewolfView[] {
  const where = onlyOpen ? "AND r.status IN ('waiting','playing')" : ''
  const rows = getDb()
    .prepare(`${WW_SELECT} WHERE r.kind = 'werewolf' ${where} ORDER BY r.updated_at DESC LIMIT 50`)
    .all() as unknown as RawRow[]
  return rows.map((row) => toWerewolfView(row, viewerId, onlineIds))
}

export function createWerewolfRoom(input: {
  title: string
  creatorId: string
  /** 目标人数 6~12；不传或非法则退回默认 9 人。 */
  playerCount?: number
}): WerewolfView {
  const title = input.title.trim() || '一局狼人杀'
  if (title.length > 40) throw new HttpError(400, '房间名过长')

  const playerCount = isValidPlayerCount(input.playerCount ?? 0) ? input.playerCount! : DEFAULT_PLAYER_COUNT

  const id = newId('room')
  const ts = now()
  const state = createWaitingState([input.creatorId], playerCount)

  getDb()
    .prepare(
      `INSERT INTO game_rooms
         (id, kind, title, status, created_by, red_player, board, turn, moves, state, created_at, updated_at)
       VALUES (?, 'werewolf', ?, 'waiting', ?, NULL, '', 'red', '[]', ?, ?, ?)`,
    )
    .run(id, title, input.creatorId, JSON.stringify(state), ts, ts)

  return toWerewolfView(readRow(id)!, input.creatorId, new Set())
}

export function joinWerewolfRoom(roomId: string, userId: string, onlineIds: Set<string>): WerewolfView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.status === 'finished') throw new HttpError(400, '这局已经结束了')

    const state = parseState(row.state)

    // 已经在里面了，幂等返回
    if (state.players.includes(userId)) return toWerewolfView(row, userId, onlineIds)

    if (state.phase !== 'waiting') throw new HttpError(409, '对局已经开始了，只能观战')
    if (state.players.length >= state.playerCount) {
      throw new HttpError(409, `${state.playerCount} 个座位都满了，可以观战`)
    }

    state.players.push(userId)
    state.alive.push(true)

    // 正好凑满该房间设定的人数 → 分配身份并进入第一夜
    if (state.players.length === state.playerCount) {
      startGame(state, now())
    }

    persist(roomId, state)
    return toWerewolfView(readRow(roomId)!, userId, onlineIds)
  })
}

/**
 * 退出房间。
 *
 * waiting 阶段就是把自己从名单里拿掉（人没满，空位留给下一位）；
 * **房主退房则会解散整个房间** —— 房间是围着他组的，他走了之后
 * 留下来的玩家既开不了局也等不到人（房主不会回来），留着只会变成
 * 大厅里的"僵尸房"。解散时返回 notify 名单，由路由把"房间没了"
 * 明确推给还留在房里的人。
 *
 * 对局中退出则**按死亡处理**（alive=false）—— 理由：狼人杀不像象棋那样
 * "少一个人整盘就下不下去"，把掉线的人当作出局能让其他 8 个人继续玩完；
 * 直接判整局结束对留下的人太苛刻。退出后立刻 advance 一次，避免他的回合
 * 因为没人操作而卡住（死人不再需要行动，nightStepDone / allVoted 都会跳过）。
 * 注意：对局中房主退出**不解散** —— 那是把其他 8 个人的对局连根拔掉，
 * 比"少一个玩家"恶劣得多。
 */
export function leaveWerewolfRoom(
  roomId: string,
  userId: string,
  onlineIds: Set<string>,
): {
  view: WerewolfView | null
  abandoned: boolean
  /** 房间被解散（房主退房 / 最后一人退房）时，还需要被踢回大厅的人 */
  dissolved?: string[]
} {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const state = parseState(row.state)
    const seat = state.players.indexOf(userId)
    if (seat === -1) {
      // 观战者退出，什么都不用做
      return { view: toWerewolfView(row, userId, onlineIds), abandoned: false }
    }

    if (state.phase === 'waiting') {
      const isCreator = row.created_by === userId
      state.players.splice(seat, 1)
      state.alive.splice(seat, 1)
      // 空房间、或房主走了：直接删掉，别在列表里堆垃圾
      if (state.players.length === 0 || isCreator) {
        getDb().prepare('DELETE FROM game_rooms WHERE id = ?').run(roomId)
        return { view: null, abandoned: false, dissolved: [...state.players] }
      }
      persist(roomId, state)
      return { view: toWerewolfView(readRow(roomId)!, userId, onlineIds), abandoned: false }
    }

    if (state.phase === 'finished') {
      // 已经结束：房主把房间从大厅撤掉是合理的（否则要挂到 24 小时兜底清理）；
      // 其余人只是从"历史陈列"里少一项，不打扰结果页上的人。
      if (row.created_by === userId) {
        getDb().prepare('DELETE FROM game_rooms WHERE id = ?').run(roomId)
        return { view: null, abandoned: false }
      }
      // 只把他从这个房间的推送名单里去掉即可（不改 state 里的历史）
      return { view: toWerewolfView(row, userId, onlineIds), abandoned: false }
    }

    if (state.alive[seat]) {
      state.alive[seat] = false
      state.log.push({
        day: state.day,
        phase: state.phase,
        kind: 'death',
        text: `${seat + 1}号 退出了对局（按出局处理）`,
        seat,
        at: now(),
      })
      advance(state, now())
      persist(roomId, state)
    }

    return { view: toWerewolfView(readRow(roomId)!, userId, onlineIds), abandoned: true }
  })
}

// ============================================================================
// 玩家动作（服务端权威校验）
// ============================================================================

/**
 * 统一的动作入口：读状态 → 定位座位 → 跑引擎校验并应用 → 推进状态机 → 落库。
 *
 * 引擎抛的是 RuleError（不带 HTTP 语义，方便纯函数测试）；这里把它翻译成
 * HttpError(400)。观战者一律 403 —— 和斗地主一样，先判身份再判状态，
 * 不要用"还没开始/不是你的回合"这种 400 去回答一个根本不在局里的人。
 */
function act(
  roomId: string,
  userId: string,
  fn: (state: WerewolfState, seat: number, nowMs: number) => void,
  onlineIds: Set<string>,
): WerewolfView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const state = parseState(row.state)
    const seat = state.players.indexOf(userId)
    if (seat === -1) throw new HttpError(403, '你是观战者，不能操作')

    const nowMs = now()
    try {
      fn(state, seat, nowMs)
    } catch (err) {
      if (err instanceof RuleError) throw new HttpError(400, err.message)
      throw err
    }
    advance(state, nowMs)
    persist(roomId, state)

    return toWerewolfView(readRow(roomId)!, userId, onlineIds)
  })
}

export function werewolfKill(roomId: string, userId: string, target: number, onlineIds: Set<string>): WerewolfView {
  return act(roomId, userId, (state, seat) => applyWolfKill(state, seat, target), onlineIds)
}

export function werewolfCheck(roomId: string, userId: string, target: number, onlineIds: Set<string>): WerewolfView {
  return act(roomId, userId, (state, seat) => void applySeerCheck(state, seat, target), onlineIds)
}

export function werewolfWitch(
  roomId: string,
  userId: string,
  choice: WitchChoice,
  onlineIds: Set<string>,
): WerewolfView {
  return act(roomId, userId, (state, seat) => applyWitch(state, seat, choice), onlineIds)
}

export function werewolfVote(
  roomId: string,
  userId: string,
  target: number | null,
  onlineIds: Set<string>,
): WerewolfView {
  return act(roomId, userId, (state, seat) => applyVote(state, seat, target), onlineIds)
}

export function werewolfShoot(
  roomId: string,
  userId: string,
  target: number | null,
  onlineIds: Set<string>,
): WerewolfView {
  return act(roomId, userId, (state, seat, nowMs) => applyHunterShot(state, seat, target, nowMs), onlineIds)
}

/**
 * 房内文字发言。
 *
 * 和五个行动不同，发言**不推进状态机**（它不影响对局流程），所以不复用 act()，
 * 但同样走服务端权威校验：canSendChat 决定"这个座位此刻能不能说话"
 * （夜晚只有狼能说、出局者与观战者不能说），失败翻成 400。
 *
 * 隐藏信息：落库时按当前阶段打上 scope（夜晚=wolf）。发给谁、谁看得到，
 * 由 buildWerewolfView 按 scope + 视角裁剪 —— 狼队夜晚的发言绝不会进入
 * 非狼或观战者的 payload。
 */
export function werewolfChat(
  roomId: string,
  userId: string,
  text: string,
  onlineIds: Set<string>,
): WerewolfView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const state = parseState(row.state)
    const seat = state.players.indexOf(userId)
    if (seat === -1) throw new HttpError(403, '你是观战者，不能发言')

    const name = namesFor([userId]).get(userId) ?? `${seat + 1}号`
    try {
      addChatMessage(state, seat, name, text, now())
    } catch (err) {
      if (err instanceof RuleError) throw new HttpError(400, err.message)
      throw err
    }
    persist(roomId, state)
    return toWerewolfView(readRow(roomId)!, userId, onlineIds)
  })
}

// ============================================================================
// 超时兜底
// ============================================================================

/**
 * 推进一个房间的状态机（供定时器调用）。
 *
 * 返回是否**发生了变化**（阶段或天数变了）—— 变了才需要重新推送给玩家，
 * 否则每 5 秒 tick 一次就会把同一份状态反复推给所有人。
 */
export function advanceWerewolfRoom(roomId: string, nowMs = now()): boolean {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) return false
    const state = parseState(row.state)
    if (state.phase === 'waiting' || state.phase === 'finished') return false

    // 只在"阶段 / 天数 / 夜晚子步骤 / 待开枪的人"任一变过时才算变化。
    // 只比来比 phase:day 是不够的：夜晚狼→预言家→女巫之间 phase 一直是 'night'，
    // 但"该谁行动"变了，必须让上层重新推送，否则界面会停在"等待 3 号"。
    const sig = (s: WerewolfState): string =>
      `${s.phase}:${s.day}:${s.night.step}:${s.pending ? s.pending.seat : '-'}`
    const before = sig(state)
    advance(state, nowMs)
    const after = sig(state)
    if (before === after) return false

    persist(roomId, state)
    return true
  })
}

/**
 * 扫描所有进行中的狼人杀房间，把过了死线的推进掉。返回发生了变化的 roomId 列表。
 *
 * 这就是"超时兜底"的落地：某个角色不行动不能把整局卡死。用法（由路由层接）：
 *   setInterval(() => { for (const id of processWerewolfTimeouts()) pushWerewolfRoom(id) }, 5000)
 *
 * 为什么用"轮询扫描"而不是给每个房间挂 setTimeout：定时器要随进程重启丢失、
 * 要随房间删除清理、还会和"加时/改票"互相打架；扫描无状态、可重入，
 * 5 秒一轮对回合制游戏完全够用（棋类的 cleanupStaleRooms 也是这个思路）。
 */
export function processWerewolfTimeouts(nowMs = now()): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM game_rooms WHERE kind = 'werewolf' AND status = 'playing'")
    .all() as unknown as Array<{ id: string }>

  const changed: string[] = []
  for (const row of rows) {
    try {
      if (advanceWerewolfRoom(row.id, nowMs)) changed.push(row.id)
    } catch {
      // 单个房间出错不能拖垮整轮扫描
    }
  }
  return changed
}

/** 清理：把超过 24 小时没动静的 waiting 狼人杀房间删掉，避免列表越来越长。 */
export function cleanupStaleWerewolfRooms(): number {
  const cutoff = now() - 24 * 60 * 60 * 1000
  const result = getDb()
    .prepare("DELETE FROM game_rooms WHERE kind = 'werewolf' AND status = 'waiting' AND updated_at < ?")
    .run(cutoff)
  return Number(result.changes ?? 0)
}
