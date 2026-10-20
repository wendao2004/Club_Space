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
}

/** 单房间画布缓冲上限（按笔画数）。超出说明异常（或有人恶意刷），整体清空重开。 */
const MAX_STROKES = 3000
/** 单条 op 的点数上限：80ms 攒一批，正常 5-8 个点，200 已经非常宽。 */
const MAX_POINTS_PER_OP = 200
/** 房内聊天（含猜错词）的保留条数 —— 只为刷新/重连补发，再多没有意义。 */
const MAX_CHAT = 50

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
  const v = volatileOf(row.id)
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
  return rows.map((row) => toDrawView(row, viewerId, onlineIds))
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
  const rounds = Math.min(Math.max(input.rounds ?? 2, 1), 5)

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
  // 画家身份必须在过滤**之前**判：filter 之后下标会错位
  const wasDrawer =
    state.phase !== 'waiting' && state.phase !== 'finished' && state.players[state.drawerIndex]?.userId === userId
  state.players = state.players.filter((p) => p.userId !== userId)

  if (state.players.length === 0) {
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

  beginChoosing(state, now())
  volatileOf(roomId).strokes = []
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
    if (!Array.isArray(op.points) || op.points.length === 0 || op.points.length > MAX_POINTS_PER_OP) {
      throw new HttpError(400, '画笔点数不合法')
    }
    for (const p of op.points) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number') throw new HttpError(400, '坐标不合法')
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new HttpError(400, '坐标必须是数字')
      if (p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 1000) throw new HttpError(400, '坐标超出画布')
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

  // waiting 阶段是普通闲聊；drawing 才有猜对一说。
  // 画家的文字在 drawing 阶段一律不进聊天 —— 哪怕不是答案，也容易变成变相提示。
  if (state.phase === 'drawing' && state.players[state.drawerIndex]?.userId === userId) {
    throw new HttpError(400, '你是画家，回合内不能用文字交流')
  }

  if (state.phase === 'drawing') {
    const outcome = applyGuess(state, userId, trimmed, now())
    if (outcome.correct) {
      appendChat(roomId, { userId, name: userName, text: trimmed, at: now(), correct: true })
      if (outcome.allGuessed) beginReveal(state, now())
      persist(roomId, state)
      return { room: getDrawRoom(roomId, userId, onlineIds), correct: true, close: false, allGuessed: outcome.allGuessed }
    }
    appendChat(roomId, { userId, name: userName, text: trimmed, at: now(), close: outcome.close })
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

    if (state.phase === 'choosing' && nowTs >= state.phaseEndsAt) {
      const fallback = pickFallbackWord(state)
      if (fallback) chooseWord(state, state.players[state.drawerIndex]?.userId ?? '', fallback, nowTs)
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
        changed = true
      }
    } else if (state.phase === 'reveal' && nowTs >= state.phaseEndsAt) {
      advanceTurn(state, nowTs)
      changed = true
    }

    if (changed) {
      persist(row.id, state)
      events.push({ roomId: row.id, state, hintsRevealed })
    }
  }
  return events
}

/** 房间销毁（删除）时把内存一起带走，防止 Map 缓慢膨胀。 */
export function disposeDrawRoom(roomId: string): void {
  dropVolatile(roomId)
}
