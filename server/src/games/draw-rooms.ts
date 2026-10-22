/**
 * 你画我猜房间层（服务端权威 + 按玩家视角裁剪）。
 *
 * ============================================================================
 * 和斗地主 / 狼人杀共用 game_rooms，但有一条自己的铁律：**画笔永不落库**
 * ============================================================================
 *
 * state 列在每次变更后是**整列覆盖写**（见 persist），而画笔是 append-only 的
 * 无限增长序列 —— 让它进 state，一局下来就是把同一个几百 KB 的字符串反复
 * 重写几百次，SQLite 的 WAL 会被一个"画画"功能打爆。
 *
 * 所以分两层：
 *  - state 列：只存回合状态（谁在画、词、分数、提示、阶段截止）—— 几 KB；
 *  - 画笔 + 房内聊天：进程内存 `Map<roomId, ...>`，重启即清。
 *    重启丢的只是"正在画的那张图的已画部分"，回合状态在库里，
 *    扫描器到点照样推进。补发接口（getDrawCanvas）会如实返回空，
 *    客户端画布空白但不至于卡死 —— 这是有意的取舍，不是遗漏。
 *
 * ============================================================================
 * 广播路径
 * ============================================================================
 * realtime.ts 没有按房间广播（只有 pushTo(userIds)），房间推送沿用斗地主的
 * 模式：路由层查成员名单 → 逐人 pushTo 按视角裁剪的视图。画笔是例外 ——
 * 它**没有视角差异**（画家画什么大家看什么，词藏在 state 不在笔迹里），
 * 所以 stroke 事件对所有成员发同一份。
 */
import { getDb, newId, now } from '../db.ts'
import { HttpError } from '../files.ts'
import {
  CHOOSE_MS,
  DRAW_MAX_PLAYERS,
  DRAW_MIN_PLAYERS,
  advanceTurn,
  applyGuess,
  beginChoosing,
  beginReveal,
  chooseWord,
  dueHints,
  pickFallbackWord,
  type DrawChatMsg,
  type DrawPhase,
  type DrawState,
  type DrawView,
  viewFor,
} from './draw.ts'

// ---------------------------------------------------------------- 画布内存

export interface DrawStrokeOp {
  op: 'begin' | 'points' | 'end' | 'clear' | 'undo'
  strokeId: string
  points: Array<{ x: number; y: number }>
  color: string
  width: number
  tool: 'pen' | 'eraser'
  /**
   * 发起这条 op 的**设备/窗口**标识（客户端生成，服务端原样回显）。
   *
   * 客户端只看 `from === 我` 无法区分"我这台设备"和"我这个账号的另一台设备"：
   * 画家在手机和电脑上都开着同一局时，电脑会把自己的回声当成别人的笔迹，
   * 或者把手机上的清屏忽略掉。有了 origin 就能精确跳过本设备的回声。
   */
  origin?: string
}

/** 单房间画布缓冲上限（按笔画数）。超出说明异常（或有人恶意刷），整体清空重开。 */
const MAX_STROKES = 3000
/** 单条 op 的点数上限：80ms 攒一批，正常 5-8 个点，200 已经非常宽。 */
const MAX_POINTS_PER_OP = 200
/** 房内聊天（含猜错词）的保留条数 —— 只为刷新/重连补发，再多没有意义。 */
const MAX_CHAT = 50

// ---------------------------------------------------------------- 近期词记忆
//
// "每次游玩的词要随机"除了洗牌本身，还有一层体验问题：玩家连开几局时，
// 上一局刚画过的词不该马上又出现在候选里。本局去重由 state.usedWords 管
// （随房间状态序列化），跨局去重靠这条进程内的滑动窗口 —— 房间是一次性的、
// 状态不跨房，所以这个记忆只能住在这里。重启清零可接受：等于记忆重置，
// 不影响正确性，只影响"连玩不撞词"的体验上限。

/** 最近出过的词最多记这么多个（约两三个 8 人局的量）。 */
const RECENT_WORDS_LIMIT = 60

const recentWords: string[] = []

function rememberWord(word: string): void {
  if (!word) return
  recentWords.push(word)
  if (recentWords.length > RECENT_WORDS_LIMIT) recentWords.splice(0, recentWords.length - RECENT_WORDS_LIMIT)
}

interface RoomVolatile {
  strokes: DrawStrokeOp[]
  chat: DrawChatMsg[]
}

/**
 * key 是房间 id。**进程内**：多实例部署时每个实例各有各的画布 ——
 * 这个系统是单实例部署（docker-compose 一个 app），如果将来改多实例，
 * 这里是第一个要搬去 Redis 的地方（届时 state 列反而不用动）。
 */
const volatile = new Map<string, RoomVolatile>()

/**
 * 旁观者登记：roomId → (userId → 最后一次心跳)。
 *
 * 为什么需要它：`drawMembers` 只返回 `state.players`，而"观看"不是玩家身份 ——
 * 非成员打开一个已经开始的房间（`onEnterRoom` 在 phase !== waiting 时只 GET、
 * 不 join）时，他不在任何推送名单里。进入时 `pullCanvas` 拿到一帧快照，之后
 * 收不到 game-draw / draw-stroke，画面就永远停在那第一帧。
 *
 * 放进程内存而不是 game_rooms.state：登记/续期是每 20 秒一次的高频动作，
 * 写进 state 等于每次都整列 persist；而且进程重启后残留的 watcher 也没有意义。
 */
const watchers = new Map<string, Map<string, number>>()
/**
 * 90 秒没心跳就算不看了（前端 20 秒一次，容忍后台节流到 1 次/分钟）。
 * 环境变量只给自动化测试用（TTL 用例等 2 秒就够了，不必真等 90 秒）。
 */
const WATCH_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.WL_DRAW_WATCH_TTL_MS ?? '', 10)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 90_000
})()

export function watchDrawRoom(roomId: string, userId: string): void {
  let room = watchers.get(roomId)
  if (!room) {
    room = new Map()
    watchers.set(roomId, room)
  }
  const ts = now()
  room.set(userId, ts)
  for (const [id, at] of room) {
    if (at < ts - WATCH_TTL_MS) room.delete(id)
  }
}

export function unwatchDrawRoom(roomId: string, userId: string): void {
  watchers.get(roomId)?.delete(userId)
}

/**
 * 一条事件该推给谁：玩家 ∪ 未过期的观看者（去重）。
 *
 * **必须去重**：同一个人可能既是玩家又登记了观看；笔迹不是幂等状态，
 * 重复投递会让 points 叠两遍、undo 多弹一笔。
 */
export function drawRecipients(roomId: string): string[] {
  const ids = new Set(drawMembers(roomId))
  const room = watchers.get(roomId)
  if (room) {
    const cutoff = now() - WATCH_TTL_MS
    for (const [id, at] of room) {
      if (at < cutoff) room.delete(id)
      else ids.add(id)
    }
  }
  return [...ids]
}

/** 上次清扫时间：2 秒 tick 每 60 秒真正扫一次就够了。 */
let lastWatcherSweep = 0

/**
 * 清理过期的观看登记与空房间条目。
 *
 * 读取路径（drawRecipients）已经会过滤过期项，但空的内层 Map 会一直挂在
 * 外层 —— 被删掉的房间每多一个就留一个空壳。这里低频扫一遍。
 */
export function sweepDrawWatchers(ts = now()): void {
  if (ts - lastWatcherSweep < 60_000) return
  lastWatcherSweep = ts
  const cutoff = ts - WATCH_TTL_MS
  for (const [roomId, room] of watchers) {
    for (const [userId, at] of room) {
      if (at < cutoff) room.delete(userId)
    }
    if (room.size === 0) watchers.delete(roomId)
  }
}

function volatileOf(roomId: string): RoomVolatile {
  let v = volatile.get(roomId)
  if (!v) {
    v = { strokes: [], chat: [] }
    volatile.set(roomId, v)
  }
  return v
}

function dropVolatile(roomId: string): void {
  volatile.delete(roomId)
}

// ---------------------------------------------------------------- 读取

interface DrawRow {
  id: string
  title: string
  status: string
  created_by: string
  creator_name: string
  state: string | null
  result: string | null
  created_at: number
  updated_at: number
}

const DRAW_SELECT = `
  SELECT r.*, c.display_name AS creator_name
    FROM game_rooms r
    JOIN users c ON c.id = r.created_by
`

function readRow(id: string): DrawRow | null {
  const row = getDb()
    .prepare(`${DRAW_SELECT} WHERE r.id = ? AND r.kind = 'draw'`)
    .get(id) as DrawRow | undefined
  return row ?? null
}

function emptyState(): DrawState {
  return {
    phase: 'waiting',
    players: [],
    drawerIndex: 0,
    round: 1,
    totalRounds: 2,
    turnNo: 0,
    word: null,
    wordChoices: [],
    revealed: [],
    hintOffsets: [],
    usedWords: [],
    drawingStartedAt: 0,
    phaseEndsAt: 0,
    result: null,
  }
}

function parseState(raw: string | null): DrawState {
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<DrawState>
    return { ...emptyState(), ...parsed }
  } catch {
    return emptyState()
  }
}

function persist(roomId: string, state: DrawState): void {
  const status =
    state.phase === 'waiting' ? 'waiting' : state.phase === 'finished' ? 'finished' : 'playing'
  const result = state.phase === 'finished' ? JSON.stringify(state.result) : null
  const ts = now()
  getDb()
    .prepare(
      `UPDATE game_rooms
          SET state = ?, status = ?, result = ?, updated_at = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(JSON.stringify(state), status, result, ts, state.phase === 'finished' ? ts : null, roomId)
}

// ---------------------------------------------------------------- 视图

export interface DrawRoomView {
  id: string
  kind: 'draw'
  title: string
  phase: DrawPhase
  status: string
  createdBy: string
  creatorName: string
  view: DrawView
  /** 房内聊天 / 猜词流（最近 50 条，内存）。 */
  chat: DrawChatMsg[]
  createdAt: number
  updatedAt: number
}

function toDrawView(row: DrawRow, viewerId: string, onlineIds: Set<string>): DrawRoomView {
  const state = parseState(row.state)
  // 在线状态不进 state（那要每次上下线都覆盖写一整局状态），视图时动态算
  for (const p of state.players) p.online = onlineIds.has(p.userId)
  // **不要用 volatileOf**：它会给每个被读到的房间创建空条目，而大厅列表
// 一次读 50 个房间 —— 等于给一堆没人玩的房间挂上空 Map。读取用 get，
// 真正需要写入时（submitStroke / getDrawCanvas / appendChat）才创建。
  const v = volatile.get(row.id) ?? { strokes: [], chat: [] }
  return {
    id: row.id,
    kind: 'draw',
    title: row.title,
    phase: state.phase,
    status: row.status,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    view: viewFor(state, viewerId),
    chat: v.chat,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function drawMembers(roomId: string): string[] {
  const row = readRow(roomId)
  if (!row) return []
  return parseState(row.state).players.map((p) => p.userId)
}

export function listDrawRooms(viewerId: string, onlineIds: Set<string>): DrawRoomView[] {
  const rows = getDb()
    .prepare(`${DRAW_SELECT} WHERE r.kind = 'draw' AND r.status IN ('waiting','playing') ORDER BY r.updated_at DESC LIMIT 50`)
    .all() as unknown as DrawRow[]
  return rows.map((row) => {
    const view = toDrawView(row, viewerId, onlineIds)
    // 大厅不展示聊天。不带 chat 既减小载荷，也收窄"任何登录用户在大厅
    // 就能读到所有房间聊天"的暴露面（猜中的原文已经置空，但普通聊天仍在）。
    return { ...view, chat: [] }
  })
}

export function getDrawRoom(roomId: string, viewerId: string, onlineIds: Set<string>): DrawRoomView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  return toDrawView(row, viewerId, onlineIds)
}

// ---------------------------------------------------------------- 房间操作

export function createDrawRoom(input: { title: string; creatorId: string; creatorName: string; rounds?: number }): DrawRoomView {
  const title = input.title.trim() || '一局你画我猜'
  if (title.length > 40) throw new HttpError(400, '房间名过长')
  // 轮数上限 10：再多一局就是两三个小时，社团活动撑不住；
  // 下限 1（6 个人画一轮就已经 10 分钟了，不强制多轮）。
  const rounds = Math.min(Math.max(Math.round(input.rounds ?? 2), 1), 10)

  const id = newId('room')
  const ts = now()
  const state = emptyState()
  state.totalRounds = rounds
  state.players = [{ userId: input.creatorId, name: input.creatorName, score: 0, online: true, guessed: false }]

  getDb()
    .prepare(
      `INSERT INTO game_rooms
         (id, kind, title, status, created_by, red_player, board, turn, moves, state, created_at, updated_at)
       VALUES (?, 'draw', ?, 'waiting', ?, ?, '', '', '[]', ?, ?, ?)`,
    )
    .run(id, title, input.creatorId, input.creatorId, JSON.stringify(state), ts, ts)

  return getDrawRoom(id, input.creatorId, new Set([input.creatorId]))
}

export function joinDrawRoom(roomId: string, userId: string, userName: string, onlineIds: Set<string>): DrawRoomView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)

  if (state.players.some((p) => p.userId === userId)) return toDrawView(row, userId, onlineIds)
  // 中途加入在技术上不难，但会让"画家顺序"出现插队歧义（他排最后还是下一位？），
  // 第一版砍掉：进行中的房间只能看结果列表里的下一局。
  if (state.phase !== 'waiting') throw new HttpError(400, '这局已经开始了，等下一局吧')
  if (state.players.length >= DRAW_MAX_PLAYERS) throw new HttpError(409, `房间最多 ${DRAW_MAX_PLAYERS} 人`)

  state.players.push({ userId, name: userName, score: 0, online: true, guessed: false })
  persist(roomId, state)
  return getDrawRoom(roomId, userId, onlineIds)
}

export function leaveDrawRoom(roomId: string, userId: string, onlineIds: Set<string>): DrawRoomView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)
  // 旁观者点"返回大厅"走的是同一个 /leave：他不是 players，不能让它
  // persist、更不能走到"players 为空 → 删房间"的分支。只注销观看即可。
  if (!state.players.some((p) => p.userId === userId)) {
    unwatchDrawRoom(roomId, userId)
    return getDrawRoom(roomId, userId, onlineIds)
  }
  // 画家身份必须在过滤**之前**判：filter 之后下标会错位
  const wasDrawer =
    state.phase !== 'waiting' && state.phase !== 'finished' && state.players[state.drawerIndex]?.userId === userId
  state.players = state.players.filter((p) => p.userId !== userId)

  if (state.players.length === 0) {
    // 人走光了。
    //
    // ⚠️ **打完的局不删行**：历史对局（listDrawHistory）是从 game_rooms 读的，
    // 删了行就等于把这一局从历史里抹掉 —— 而 draw_rounds 里的存档还在，
    // 变成没有任何入口能查到的孤儿。一局打完就不再是"房间"而是"一条记录"，
    // 保留多少条交给 pruneDrawHistory（默认最近 200 局）。
    //
    // 没打完就散伙的局照旧删行：它没有存档，也没有记录价值。
    if (row.status === 'finished') {
      persist(roomId, state)
      disposeDrawRoom(roomId)
      throw new HttpError(404, '已退出房间（这一局已存入历史）')
    }
    // 人走光了：删行，房间从列表消失（斗地主/狼人杀同款处理）
    getDb().prepare('DELETE FROM game_rooms WHERE id = ?').run(roomId)
    disposeDrawRoom(roomId)
    throw new HttpError(404, '房间已解散')
  }

  // 画家走了：
  //  - waiting：无事可做（顺序无所谓）
  //  - choosing：重开一个候选窗口（下一位本来也要轮到，不如直接给他选）
  //    简化起见这里只是把他的回合作废、轮到下一位 —— 与"等超时"结果一致，
  //    但不用等 10 秒。
  //  - drawing：词随画家作废，直接 reveal（本轮没人得分），6 秒后轮转。
  if (wasDrawer) {
    if (state.phase === 'choosing') {
      state.drawerIndex = state.drawerIndex % state.players.length
      beginChoosing(state, now())
      resetDrawCanvas(roomId)
    } else if (state.phase === 'drawing') {
      state.word = null
      beginReveal(state, now())
    }
  }

  persist(roomId, state)
  return getDrawRoom(roomId, userId, onlineIds)
}

export function startDrawRoom(roomId: string, userId: string, onlineIds: Set<string>): DrawRoomView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)

  if (row.created_by !== userId) throw new HttpError(403, '只有房主能开始')
  if (state.phase !== 'waiting') throw new HttpError(400, '已经开始了')
  if (state.players.length < DRAW_MIN_PLAYERS) throw new HttpError(400, `至少要 ${DRAW_MIN_PLAYERS} 个人才能开始`)

  beginChoosing(state, now(), recentWords)
  resetDrawCanvas(roomId)
  volatileOf(roomId).chat = []
  persist(roomId, state)
  return getDrawRoom(roomId, userId, onlineIds)
}

// ---------------------------------------------------------------- 选词 / 画笔 / 猜词

export function chooseDrawWord(roomId: string, userId: string, word: string, onlineIds: Set<string>): DrawRoomView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)

  if (!chooseWord(state, userId, word, now())) {
    throw new HttpError(400, '现在不能选这个词（可能已经选过、不是你选、或词无效）')
  }
  rememberWord(word)
  // 新回合从白纸开始。即使 advanceTurn 已经清过，这里再清一次是幂等的 ——
  // 而"选词后画布上还留着上一题的图"是最难解释的现象之一。
  resetDrawCanvas(roomId)
  persist(roomId, state)
  return getDrawRoom(roomId, userId, onlineIds)
}

/** 画笔校验：只信任"当前画家"，且字段全部收紧 —— 这是公网可达的写入口。 */
export function submitStroke(roomId: string, userId: string, op: DrawStrokeOp): DrawStrokeOp {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)

  if (state.phase !== 'drawing') throw new HttpError(400, '现在不是绘画阶段')
  if (state.players[state.drawerIndex]?.userId !== userId) throw new HttpError(403, '现在轮不到你画')

  if (!['begin', 'points', 'end', 'clear', 'undo'].includes(op.op)) {
    throw new HttpError(400, '未知的画笔操作')
  }
  // strokeId 只在真实笔画上有意义；clear/undo（尤其 clear）可以不带
  if (op.op !== 'clear' && op.op !== 'undo') {
    if (typeof op.strokeId !== 'string' || op.strokeId.length === 0 || op.strokeId.length > 40) {
      throw new HttpError(400, 'strokeId 不合法')
    }
  }
  if (op.op !== 'clear' && op.op !== 'undo') {
    // 点数只有 begin / points 需要。
    //
    // `end` 是"抬笔"信号，前端发的是 `points: []` —— 之前这里一视同仁地要求
    // "点数非空"，于是**每一笔抬笔都回一个 400**。客户端不看回包、抬笔也不需要
    // 服务端做什么，所以从界面到测试都没露馅，只有日志里堆着一串假错误：
    // 真出问题时，那堆 400 会把人往"网络/鉴权坏了"的方向带。
    if (op.op !== 'end') {
      if (!Array.isArray(op.points) || op.points.length === 0 || op.points.length > MAX_POINTS_PER_OP) {
        throw new HttpError(400, '画笔点数不合法')
      }
      for (const p of op.points) {
        if (typeof p.x !== 'number' || typeof p.y !== 'number') throw new HttpError(400, '坐标不合法')
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new HttpError(400, '坐标必须是数字')
        if (p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 1000) throw new HttpError(400, '坐标超出画布')
      }
    }
    if (typeof op.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(op.color)) {
      throw new HttpError(400, '颜色不合法')
    }
    if (typeof op.width !== 'number' || !Number.isFinite(op.width) || op.width < 1 || op.width > 48) {
      throw new HttpError(400, '粗细不合法')
    }
    if (op.tool !== 'pen' && op.tool !== 'eraser') throw new HttpError(400, '工具不合法')
  }

  const clean: DrawStrokeOp = {
    op: op.op,
    strokeId: op.strokeId,
    points: op.op === 'clear' || op.op === 'undo' ? [] : op.points,
    color: op.color,
    width: op.width,
    tool: op.tool,
    // 原样回显给其他设备；它只是回声过滤用的不透明标识，不参与校验
    origin: typeof op.origin === 'string' ? op.origin.slice(0, 64) : undefined,
  }

  const v = volatileOf(roomId)
  if (clean.op === 'clear') {
    v.strokes = []
  } else if (clean.op === 'undo') {
    // 撤销自己最近的 begin：从后往前找，只认笔画的归属由"是谁 begin 的"
    // 不成立（op 里没有身份字段，身份在路由层已验过）—— 所以约定 undo 只
    // 删最后一笔，且只允许画家本人调用（上面已拦）。多人不会同时画。
    v.strokes.pop()
  } else if (clean.op === 'begin') {
    v.strokes.push(clean)
  } else {
    // points/end：挂到最近的 begin 上。找不到（比如重启后缓冲没了）就丢弃
    // —— 接收端同样丢弃，两端一致地"当作没画过这一段"。
    const open = v.strokes.findLast((s) => s.strokeId === clean.strokeId && s.op === 'begin')
    if (open) {
      // 增量点直接并入缓冲（接收端按 strokeId 把点接上）
      open.points.push(...clean.points)
      if (v.strokes.length > MAX_STROKES) {
        v.strokes = []
        clean.op = 'clear'
        clean.points = []
      }
    }
  }
  return clean
}

/** 中途进来 / 刷新的人补发整张画布。缓冲为空（重启过）就返回空数组。 */
export function getDrawCanvas(roomId: string): DrawStrokeOp[] {
  return volatileOf(roomId).strokes
}

/**
 * 清空画布缓冲（**回合切换时必须调用**）。
 *
 * 这是"每到下一题画布不清空"那个 bug 的根因：缓冲从不随回合重置，于是
 * 新回合客户端 pullCanvas 一拉，上一题整张图又回来了 —— 前端就算在
 * phase 变化时 clearCanvas 也没用，下一帧就被补发覆盖回去。
 * 服务器才是画布的权威，重置必须在这里做，并广播给所有人。
 */
export function resetDrawCanvas(roomId: string): void {
  volatileOf(roomId).strokes = []
}

// ---------------------------------------------------------------- 聊天 / 猜词

function appendChat(roomId: string, msg: DrawChatMsg): void {
  const v = volatileOf(roomId)
  v.chat.push(msg)
  if (v.chat.length > MAX_CHAT) v.chat.splice(0, v.chat.length - MAX_CHAT)
}

export interface DrawGuessResult {
  room: DrawRoomView
  correct: boolean
  close: boolean
  allGuessed: boolean
}

export function guessDrawWord(
  roomId: string,
  userId: string,
  userName: string,
  text: string,
  onlineIds: Set<string>,
): DrawGuessResult {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const state = parseState(row.state)
  const trimmed = text.trim()
  if (!trimmed) throw new HttpError(400, '先写点什么再发')
  if (trimmed.length > 60) throw new HttpError(400, '一句话最长 60 字')
  // 旁观者只读：否则任何登录用户都能往任意房间的聊天流里注入文本
  // （包括直接喊答案、刷屏）。前端同时会隐藏输入框。
  if (!state.players.some((p) => p.userId === userId)) {
    throw new HttpError(403, '观众只能观看，不能发言')
  }

  // waiting 阶段是普通闲聊；drawing 才有猜对一说。
  // 画家的文字在 drawing 阶段一律不进聊天 —— 哪怕不是答案，也容易变成变相提示。
  if (state.phase === 'drawing' && state.players[state.drawerIndex]?.userId === userId) {
    throw new HttpError(400, '你是画家，回合内不能用文字交流')
  }

  // 按**内容**判断这条会不会泄题，而不是只看 correct 标记。
  //
  // 两个真实缺口：
  //  1. 已经猜对的玩家再发一次答案：applyGuess 会对 guessed=true 早退返回
  //     correct=false，随后走普通 appendChat —— 答案原文照样进共享 chat。
  //  2. "很接近"的句子通常包含答案本身（答案是「苹果」，输入「苹果好吃」），
  //     close 标记只在部分情况下为真。
  // 所以 drafting 阶段只要归一化后的文本包含归一化后的答案，text 一律置空。
  // 界面本来就不读 correct/close 消息的 text（见 chatTextOf）。
  const normalizedAnswer = (state.word ?? '').replace(/\s+/g, '').toLowerCase()
  const mentionsAnswer =
    state.phase === 'drawing' &&
    normalizedAnswer.length > 0 &&
    trimmed.replace(/\s+/g, '').toLowerCase().includes(normalizedAnswer)

  if (state.phase === 'drawing') {
    const outcome = applyGuess(state, userId, trimmed, now())
    if (outcome.correct) {
      // ⚠️ **不要把猜中的原文存进 chat**。
      //
      // 猜对时 `trimmed` 就是答案本身；chat 是不做视角裁剪的（`viewFor` 只裁
      // word / wordChoices），而 `listDrawRooms` 会把最多 50 个房间的 chat
      // 一起返回给大厅 —— 任何登录用户在大厅列表里就能读到当前题目的答案。
      // 前端只是把 correct 消息的**渲染文案**换成了"猜对了"，数据一直在网络层。
      // text 留空：界面对 correct 消息本来就不读 text（见 chatTextOf）。
      appendChat(roomId, { userId, name: userName, text: '', at: now(), correct: true })
      if (outcome.allGuessed) {
        beginReveal(state, now())
        // 全员猜对即结束绘画：这一回合的画与结果在这里定稿存档
        archiveRound(roomId, state)
      }
      persist(roomId, state)
      return { room: getDrawRoom(roomId, userId, onlineIds), correct: true, close: false, allGuessed: outcome.allGuessed }
    }
    // close（"很接近"）同样不存原文：它是**按字符接近度**判定的，猜的句子
// 里很可能包含答案（答案是"苹果"，输入"苹果好吃"就会命中），
// 而界面本来就只显示"猜得很接近"，不读 text。
    appendChat(roomId, {
      userId,
      name: userName,
      text: outcome.close || mentionsAnswer ? '' : trimmed,
      at: now(),
      close: outcome.close,
    })
    // 猜错不改 state，但 close 标记只给本人（见 viewFor 的约定：chat.close 全员可见没问题，
    // 因为"接近"不泄露答案方向太多 —— 与 skribbl 的通行做法一致）
    return { room: getDrawRoom(roomId, userId, onlineIds), correct: false, close: outcome.close, allGuessed: false }
  }

  appendChat(roomId, { userId, name: userName, text: trimmed, at: now() })
  return { room: getDrawRoom(roomId, userId, onlineIds), correct: false, close: false, allGuessed: false }
}

// ---------------------------------------------------------------- 超时推进

export interface DrawTimeoutEvent {
  roomId: string
  state: DrawState
  /** 揭示了提示（需要广播，让已画布面之外的信息更新）。 */
  hintsRevealed: boolean
  /** 回合轮转了（画布缓冲已重置，调用方要广播一次 clear 让所有客户端清屏）。 */
  canvasCleared: boolean
}

/**
 * 扫描全部进行中的 draw 房间，推进到期的阶段。
 *
 * 由 index.ts 的 2 秒 tick 调用（与狼人杀的 5 秒扫描同一模式）：
 *  - choosing 超时 → 随机选一个候选（画家卡住不能让全屋陪等）
 *  - drawing 到了提示时间点 → 揭示（一次可能揭示多个字）
 *  - drawing 超时 / 全员猜对（猜对在 guessDrawWord 里即时处理）→ reveal
 *  - reveal 超时 → 下一个画家 / 结束
 *
 * 每个房间最多推进**一步**就返回 —— 一步的状态变化广播一次，顺序天然正确；
 * 一步推进到下一个阶段后如果又已超时（比如 reveal 只有 6 秒），下一个 tick
 * 会接着推。不做 while 循环：省掉"一次 tick 推三步、广播三次"的复杂度。
 */
export function processDrawTimeouts(nowTs: number): DrawTimeoutEvent[] {
  const rows = getDb()
    .prepare(`SELECT r.*, c.display_name AS creator_name FROM game_rooms r JOIN users c ON c.id = r.created_by
               WHERE r.kind = 'draw' AND r.status IN ('choosing','playing')`)
    .all() as unknown as DrawRow[]
  const events: DrawTimeoutEvent[] = []

  for (const row of rows) {
    const state = parseState(row.state)
    let changed = false
    let hintsRevealed = false
    let canvasCleared = false

    if (state.phase === 'choosing' && nowTs >= state.phaseEndsAt) {
      const fallback = pickFallbackWord(state)
      if (fallback) {
        chooseWord(state, state.players[state.drawerIndex]?.userId ?? '', fallback, nowTs)
        rememberWord(fallback)
      }
      changed = true
    } else if (state.phase === 'drawing') {
      const due = dueHints(state, nowTs)
      if (due.length > 0) {
        for (const i of due) state.revealed[i] = true
        hintsRevealed = true
        changed = true
      }
      if (nowTs >= state.phaseEndsAt) {
        beginReveal(state, nowTs)
        // 绘画超时：这一回合定稿存档（画到哪儿算哪儿 —— 半张图也是记录）
        archiveRound(row.id, state)
        changed = true
      }
    } else if (state.phase === 'reveal' && nowTs >= state.phaseEndsAt) {
      // 轮转成功 = 进入新回合：画布跟着换新的（这里不清，客户端下一帧就会
      // 用 pullCanvas 把上一题拉回来 —— 见 resetDrawCanvas 的注释）
      if (advanceTurn(state, nowTs, recentWords)) {
        resetDrawCanvas(row.id)
        canvasCleared = true
      }
      changed = true
    }

    if (changed) {
      persist(row.id, state)
      events.push({ roomId: row.id, state, hintsRevealed, canvasCleared })
    }
  }
  return events
}

/** 房间销毁（删除）时把内存一起带走，防止 Map 缓慢膨胀。 */
export function disposeDrawRoom(roomId: string): void {
  dropVolatile(roomId)
  watchers.delete(roomId)
}

// ---------------------------------------------------------------- 对局存档

/**
 * 单回合存档的点数上限。
 *
 * 80 秒的密集涂鸦能上万点，一局十轮就是几十 MB —— 存档的价值在"回头看画了
 * 什么"，前 6000 个点已经能看出整张图（超出的部分通常是最后反复描的细节）。
 * 截断而不是拒绝存档：宁可图不完整，也不要因为"画得太满"丢了整回合记录。
 */
const MAX_ARCHIVE_POINTS = 6000

/**
 * 把一个回合存档到 draw_rounds。
 *
 * 时机是**绘画结束时**（beginReveal 之后）：那一瞬间笔画完整、词已知、
 * 谁猜对也已经定下来 —— 之后再调只会覆盖同一份（id = room:turnNo，幂等）。
 *
 * 画笔只在这里落库一次，回合内的增量永远只走内存广播（见文件头的说明）。
 */
function archiveRound(roomId: string, state: DrawState): void {
  // 画家中途退房时词被清空（回合作废）—— 没画成，不值得存
  if (!state.word) return
  const drawer = state.players[state.drawerIndex]
  if (!drawer) return

  // 按"点"截断，并把同一笔的增量合并成一条（clear/undo 折叠掉）。
  // 存的是"最终这张图"，不是一串操作日志 —— 复盘时不该还要重放撤销语义；
  // 合并另一个好处是体积：同一笔的 N 条增量变成一个数组，少 N 份元数据。
  let budget = MAX_ARCHIVE_POINTS
  const byStroke = new Map<string, DrawStrokeOp>()
  const order: string[] = []
  for (const op of getDrawCanvas(roomId)) {
    if (op.op === 'clear') {
      byStroke.clear()
      order.length = 0
      continue
    }
    if (op.op === 'undo') {
      const last = order.pop()
      if (last) byStroke.delete(last)
      continue
    }
    if (budget <= 0) continue
    const points = op.points.slice(0, budget)
    budget -= points.length
    if (points.length === 0) continue

    const existing = byStroke.get(op.strokeId)
    if (existing) {
      existing.points.push(...points)
    } else {
      byStroke.set(op.strokeId, { ...op, points: [...points] })
      order.push(op.strokeId)
    }
  }
  const strokes = order.map((id) => byStroke.get(id)!).filter(Boolean)

  const results = state.players
    .filter((_, i) => i !== state.drawerIndex)
    .map((p) => ({ userId: p.userId, name: p.name, guessed: p.guessed, score: p.score }))

  const id = `${roomId}:${state.turnNo}`
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO draw_rounds
         (id, room_id, round_no, turn_no, drawer_id, drawer_name, word, strokes, results, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      state.round,
      state.turnNo,
      drawer.userId,
      drawer.name,
      state.word,
      JSON.stringify(strokes),
      JSON.stringify(results),
      state.drawingStartedAt,
      now(),
    )
}

export interface DrawHistoryItem {
  roomId: string
  title: string
  finishedAt: number
  /** 排名（game_rooms.result 里存的）。 */
  ranking: Array<{ userId: string; name: string; score: number }>
  roundCount: number
}

/**
 * 历史对局的保留条数（默认最近 200 局）。
 *
 * 为什么是"按局数"而不是"按天数"：这个社团一局可能一周一次，也可能一天十局。
 * 按天数存，闲的时候会把仅有的几局删掉；按局数存，"我们上礼拜那局"永远在最近
 * 200 条里。每局存档上限 6000 点/回合，200 局是几百 MB 量级 —— 也还在可接受范围。
 */
export const DRAW_HISTORY_KEEP = Math.max(Number(process.env.WL_DRAW_HISTORY_KEEP ?? 200) || 200, 1)

/**
 * 修剪历史：只留最近 keep 局，顺手清掉"房间早被删掉"的孤儿存档。
 *
 * 触发点放在**打开历史列表时**，而不是定时器：这是唯一的写入方（没有别的入口会
 * 产生历史），一次 GET 的代价是一条带 LIMIT/OFFSET 的 DELETE；而定时器要在
 * 每个 2 秒的 tick 里判断"今天修剪过没有"，反而更绕。
 *
 * 顺序很重要：先删存档（子表），再删房间。反过来的话，删完房间就找不到
 * "哪些存档属于被删的那几局"了 —— 表上没有外键。
 */
export function pruneDrawHistory(keep = DRAW_HISTORY_KEEP): { rooms: number; rounds: number } {
  const db = getDb()
  const stale = `SELECT id FROM game_rooms
                  WHERE kind = 'draw' AND status = 'finished'
                  ORDER BY COALESCE(finished_at, updated_at) DESC
                  LIMIT -1 OFFSET ?`
  // 先记下要删的房间，删完把进程内的画布/聊天/观看登记一起丢掉 ——
// 只删 DB 行的话，这些房间的 strokes 会一直留在 volatile 里。
  const staleIds = (db.prepare(stale).all(keep) as Array<{ id: string }>).map((r) => r.id)
  const rounds = db.prepare(`DELETE FROM draw_rounds WHERE room_id IN (${stale})`).run(keep)
  const rooms = db.prepare(`DELETE FROM game_rooms WHERE id IN (${stale})`).run(keep)
  for (const id of staleIds) disposeDrawRoom(id)
  // 兜底：旧版本里"打完就退房"留下的孤儿存档（房间行已经没了）
  db.prepare('DELETE FROM draw_rounds WHERE room_id NOT IN (SELECT id FROM game_rooms)').run()
  return { rooms: Number(rooms.changes ?? 0), rounds: Number(rounds.changes ?? 0) }
}

/**
 * 历史对局列表。
 *
 * 权限取舍：**登录用户都能看**。这是社团内部的娱乐记录，不是私密内容；
 * 而"只能看自己参加过的"会让"我们上礼拜那局"这种最常见的问法问不出结果。
 */
export function listDrawHistory(limit = 30): DrawHistoryItem[] {
  pruneDrawHistory()
  const rows = getDb()
    .prepare(
      `SELECT r.id, r.title, r.result, r.finished_at,
              (SELECT COUNT(*) FROM draw_rounds d WHERE d.room_id = r.id) AS round_count
         FROM game_rooms r
        WHERE r.kind = 'draw' AND r.status = 'finished'
        ORDER BY COALESCE(r.finished_at, r.updated_at) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string
    title: string
    result: string | null
    finished_at: number | null
    round_count: number
  }>

  return rows.map((row) => {
    let ranking: Array<{ userId: string; name: string; score: number }> = []
    try {
      ranking = (JSON.parse(row.result ?? '{}') as { ranking?: typeof ranking }).ranking ?? []
    } catch {
      ranking = []
    }
    return {
      roomId: row.id,
      title: row.title,
      finishedAt: row.finished_at ?? 0,
      ranking,
      roundCount: row.round_count,
    }
  })
}

export interface DrawHistoryRound {
  turnNo: number
  roundNo: number
  drawerId: string
  drawerName: string
  word: string
  /** 存档的笔画（前端直接重放）。 */
  strokes: DrawStrokeOp[]
  results: Array<{ userId: string; name: string; guessed: boolean; score: number }>
  endedAt: number
}

export interface DrawHistoryDetail {
  roomId: string
  title: string
  finishedAt: number
  ranking: Array<{ userId: string; name: string; score: number }>
  rounds: DrawHistoryRound[]
}

/** 某一局的全部回合（含每回合的画）。 */
export function getDrawHistoryDetail(roomId: string): DrawHistoryDetail {
  const room = getDb()
    .prepare(`SELECT id, title, result, finished_at FROM game_rooms WHERE id = ? AND kind = 'draw'`)
    .get(roomId) as { id: string; title: string; result: string | null; finished_at: number | null } | undefined
  if (!room) throw new HttpError(404, '这一局不存在')

  const rows = getDb()
    .prepare(
      `SELECT turn_no, round_no, drawer_id, drawer_name, word, strokes, results, ended_at
         FROM draw_rounds WHERE room_id = ? ORDER BY turn_no ASC`,
    )
    .all(roomId) as Array<{
    turn_no: number
    round_no: number
    drawer_id: string
    drawer_name: string
    word: string
    strokes: string
    results: string
    ended_at: number
  }>

  let ranking: Array<{ userId: string; name: string; score: number }> = []
  try {
    ranking = (JSON.parse(room.result ?? '{}') as { ranking?: typeof ranking }).ranking ?? []
  } catch {
    ranking = []
  }

  return {
    roomId: room.id,
    title: room.title,
    finishedAt: room.finished_at ?? 0,
    ranking,
    rounds: rows.map((row) => {
      let strokes: DrawStrokeOp[] = []
      let results: DrawHistoryRound['results'] = []
      try {
        strokes = JSON.parse(row.strokes) as DrawStrokeOp[]
      } catch {
        strokes = []
      }
      try {
        results = JSON.parse(row.results) as DrawHistoryRound['results']
      } catch {
        results = []
      }
      return {
        turnNo: row.turn_no,
        roundNo: row.round_no,
        drawerId: row.drawer_id,
        drawerName: row.drawer_name,
        word: row.word,
        strokes,
        results,
        endedAt: row.ended_at,
      }
    }),
  }
}
