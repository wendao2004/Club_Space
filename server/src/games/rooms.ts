/**
 * 游戏房间（当前只有中国象棋）。
 *
 * 设计上刻意的取舍：
 *
 * 1. **服务端权威。** 走法一律在服务端用规则引擎校验，客户端只发"我想从 a 走到 b"。
 *    客户端算的合法性一概不采信 —— 否则改一行前端代码就能把车当马用。
 *    这是评审团对棋牌类功能给出的硬要求（"客户端权威无法防改牌"）。
 *
 * 2. **整盘序列化存一行，不做增量存盘。** 棋盘很小（90 格），每次落子覆盖写一次
 *    比维护"事件流 + 快照"简单得多，也不会出现两者不一致的难查问题。
 *
 * 3. **广播给所有在线用户，而不是只发给房间成员。** 社团规模下连接数很少
 *    （几十个），做精确订阅要维护"谁在看哪个房间"的映射，收益不抵复杂度。
 *    ⚠️ 但这个做法**只适用于没有隐藏信息的游戏**（象棋、斗地主的部分阶段）。
 *    狼人杀那类需要按玩家视角裁剪状态，必须改成定向推送 —— 到那时再引入
 *    room→subscribers 的映射，不要现在预付。
 */
import { getDb, newId, now, transaction } from '../db.ts'
import { HttpError } from '../files.ts'
import {
  applyMove,
  deserializeBoard,
  evaluateResult,
  legalMoves,
  parseSquare,
  serializeBoard,
  squareName,
  initialBoard,
  type Color,
  type Move,
} from './xiangqi.ts'

export type RoomKind = 'xiangqi'
export type RoomStatus = 'waiting' | 'playing' | 'finished'

export interface RoomMove {
  from: string
  to: string
  color: Color
  piece: string
  captured: string | null
  /** 走完这一手之后是否形成将军 —— 前端用来提示"将军！" */
  check: boolean
  at: number
  by: string
  byName: string
}

export interface RoomView {
  id: string
  kind: RoomKind
  title: string
  status: RoomStatus
  createdBy: string
  creatorName: string
  redPlayer: string | null
  redName: string | null
  blackPlayer: string | null
  blackName: string | null
  board: string
  turn: Color
  moves: RoomMove[]
  result: { winner: Color | null; reason: string } | null
  /** 当前局面是否处于将军状态 */
  inCheck: boolean
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  /** 请求者视角：他坐哪一边（观战为 null）。 */
  mySide: Color | null
  /** 是否轮到请求者走。 */
  myTurn: boolean
}

interface RawRoom {
  id: string
  kind: RoomKind
  title: string
  status: RoomStatus
  created_by: string
  creator_name: string
  red_player: string | null
  red_name: string | null
  black_player: string | null
  black_name: string | null
  board: string
  turn: Color
  moves: string
  result: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

const ROOM_SELECT = `
  SELECT r.*, c.display_name AS creator_name,
         ru.display_name AS red_name, bu.display_name AS black_name
    FROM game_rooms r
    JOIN users c ON c.id = r.created_by
    LEFT JOIN users ru ON ru.id = r.red_player
    LEFT JOIN users bu ON bu.id = r.black_player
`

function toView(row: RawRoom, viewerId: string): RoomView {
  const board = deserializeBoard(row.board)
  const moves = JSON.parse(row.moves) as RoomMove[]
  const result = row.result ? (JSON.parse(row.result) as RoomView['result']) : null

  const mySide: Color | null =
    row.red_player === viewerId ? 'red' : row.black_player === viewerId ? 'black' : null

  // 只在未结束时算将军，避免对已结束的对局做无意义的计算
  const inCheck = row.status === 'finished' ? false : evaluateResult({ board, turn: row.turn, history: [] }).inCheck

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    redPlayer: row.red_player,
    redName: row.red_name,
    blackPlayer: row.black_player,
    blackName: row.black_name,
    board: row.board,
    turn: row.turn,
    moves,
    result,
    inCheck,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    mySide,
    myTurn: row.status === 'playing' && mySide === row.turn,
  }
}

function getRaw(id: string): RawRoom | null {
  const row = getDb().prepare(`${ROOM_SELECT} WHERE r.id = ?`).get(id) as RawRoom | undefined
  return row ?? null
}

export function getRoom(id: string, viewerId: string): RoomView {
  const row = getRaw(id)
  if (!row) throw new HttpError(404, '房间不存在')
  // 传进来一个别种游戏的房间 id（比如把狼人杀的房间 id 拼到这个路径上），
  // 应当按"没有这个棋局"处理。不拦的话会走到底下的 deserializeBoard，
  // 抛出一个"棋盘应有 10 行"的内部错误 —— 那是 500，而正确答案是 404。
  if (row.kind !== 'xiangqi') throw new HttpError(404, '房间不存在')
  return toView(row, viewerId)
}

export function listRooms(viewerId: string, options: { status?: RoomStatus; kind?: RoomKind } = {}): RoomView[] {
  const where: string[] = []
  const params: Array<string> = []
  if (options.status) {
    where.push('r.status = ?')
    params.push(options.status)
  }
  if (options.kind) {
    where.push('r.kind = ?')
    params.push(options.kind)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = getDb()
    .prepare(`${ROOM_SELECT} ${whereSql} ORDER BY r.updated_at DESC LIMIT 100`)
    .all(...params) as unknown as RawRoom[]

  /**
   * 逐行渲染，但**两种失败要区别对待**。
   *
   * 一、捞到别的游戏的房间 → **直接抛**，不要跳过。
   *    `game_rooms` 是三种游戏共用的表，而 board 列的语义不同：象棋写棋盘，
   *    斗地主/狼人杀写空串（局面在 state 列）。不过滤就会把它们也拿来
   *    `deserializeBoard('')`，而 `''.split('/')` 只有 1 段。
   *
   *    这**不是数据损坏，是调用方的错误**。曾经写成"跳过这一行 + 记日志"，
   *    结果很糟：接口返回 200 了、症状消失了，但每次打开象棋大厅都要白跑一遍
   *    所有斗地主和狼人杀的房间、刷一屏错误日志，而真正的错误（忘了限定 kind）
   *    谁都看不出来 —— 连回归测试都抓不到了。
   *    所以这里让它**大声炸掉**，错误信息直接点名该怎么改。
   *
   * 二、象棋房间但棋盘存坏了 → 跳过这一条。
   *    这是真的数据损坏，一行坏了不该让整个大厅打不开。
   */
  const views: RoomView[] = []
  for (const row of rows) {
    if (row.kind !== 'xiangqi') {
      throw new Error(
        `listRooms 捞到了非象棋房间 ${row.id}（kind=${row.kind}）。` +
          `调用方必须限定 kind —— 象棋、斗地主、狼人杀共用 game_rooms 表，board 列的语义不同。`,
      )
    }
    try {
      views.push(toView(row, viewerId))
    } catch (err) {
      console.error(
        `[棋局] 跳过无法渲染的房间 ${row.id}（棋盘数据有问题，board 长度 ${row.board?.length ?? 0}）：`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return views
}

export function createRoom(input: {
  kind: RoomKind
  title: string
  creatorId: string
  /** 创建者想坐哪一边；不指定就坐红方（红先走，通常是先手方）。 */
  side?: Color
}): RoomView {
  const title = input.title.trim() || '一盘象棋'
  if (title.length > 40) throw new HttpError(400, '房间名过长')

  const side: Color = input.side ?? 'red'
  const id = newId('room')
  const ts = now()

  getDb()
    .prepare(
      `INSERT INTO game_rooms
         (id, kind, title, status, created_by, red_player, black_player, board, turn, moves, created_at, updated_at)
       VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, 'red', '[]', ?, ?)`,
    )
    .run(
      id,
      input.kind,
      title,
      input.creatorId,
      side === 'red' ? input.creatorId : null,
      side === 'black' ? input.creatorId : null,
      serializeBoard(initialBoard()),
      ts,
      ts,
    )

  return getRoom(id, input.creatorId)
}

/**
 * 加入房间。
 *
 * 若两个座位都满了就拒绝 —— 不提供"顶替"能力，那会让正在下的人莫名其妙被换掉。
 * 想换人要先退出。
 */
export function joinRoom(roomId: string, userId: string, side?: Color): RoomView {
  return transaction(() => {
    const row = getRaw(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.status === 'finished') throw new HttpError(400, '这局已经结束了')
    if (row.red_player === userId || row.black_player === userId) {
      return toView(row, userId) // 已经在里面了，幂等返回
    }

    let target: Color
    if (side) {
      target = side
    } else if (!row.red_player) {
      target = 'red'
    } else if (!row.black_player) {
      target = 'black'
    } else {
      throw new HttpError(409, '两个座位都有人了，可以观战')
    }

    const taken = target === 'red' ? row.red_player : row.black_player
    if (taken) throw new HttpError(409, `${target === 'red' ? '红方' : '黑方'}已经有人了`)

    const otherSeat = target === 'red' ? row.black_player : row.red_player
    const ts = now()

    getDb()
      .prepare(
        `UPDATE game_rooms
            SET ${target === 'red' ? 'red_player' : 'black_player'} = ?,
                status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(userId, otherSeat ? 'playing' : 'waiting', ts, roomId)

    return getRoom(roomId, userId)
  })
}

/** 找房间里的另一方。 */
function opponentOf(row: RawRoom, userId: string): string | null {
  if (row.red_player === userId) return row.black_player
  if (row.black_player === userId) return row.black_player === userId ? row.red_player : null
  return null
}

export interface MoveResult {
  room: RoomView
  move: RoomMove
  /** 走完这一手之后对局是否结束 */
  finished: { winner: Color | null; reason: string } | null
}

/**
 * 走一步棋。
 *
 * 校验链条（任一环不过就拒绝）：
 *   1. 房间在对局中
 *   2. 你是这一局的参与者，不是观战者
 *   3. 现在轮到你走
 *   4. 这个走法在规则引擎给出的合法着法列表里
 *
 * 第 4 条是防作弊的关键：客户端提交的只是一个意图，合法性完全由服务端裁定。
 */
export function makeMove(
  roomId: string,
  userId: string,
  userName: string,
  fromName: string,
  toName: string,
): MoveResult {
  return transaction(() => {
    const row = getRaw(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.status !== 'playing') {
      throw new HttpError(400, row.status === 'waiting' ? '还在等人加入' : '这局已经结束了')
    }

    const mySide: Color | null =
      row.red_player === userId ? 'red' : row.black_player === userId ? 'black' : null
    if (!mySide) throw new HttpError(403, '你是观战者，不能走棋')
    if (mySide !== row.turn) throw new HttpError(400, '还没轮到你走')

    let from: number
    let to: number
    try {
      from = parseSquare(fromName)
      to = parseSquare(toName)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : '坐标不合法')
    }

    const board = deserializeBoard(row.board)
    const legal = legalMoves(board, mySide)
    const move = legal.find((m) => m.from === from && m.to === to)
    if (!move) {
      throw new HttpError(400, '这个走法不合法')
    }

    const next = applyMove({ board, turn: mySide, history: [] }, move)
    const verdict = evaluateResult(next)

    const record: RoomMove = {
      from: squareName(move.from),
      to: squareName(move.to),
      color: mySide,
      piece: move.piece.type,
      captured: move.captured ? move.captured.type : null,
      check: verdict.inCheck,
      at: now(),
      by: userId,
      byName: userName,
    }

    const moves = [...(JSON.parse(row.moves) as RoomMove[]), record]
    const ts = now()

    let status: RoomStatus = 'playing'
    let result: { winner: Color | null; reason: string } | null = null
    if (verdict.over) {
      status = 'finished'
      result = { winner: verdict.winner, reason: verdict.reason }
    }

    getDb()
      .prepare(
        `UPDATE game_rooms
            SET board = ?, turn = ?, moves = ?, status = ?, result = ?,
                updated_at = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        serializeBoard(next.board),
        next.turn,
        JSON.stringify(moves),
        status,
        result ? JSON.stringify(result) : null,
        ts,
        status === 'finished' ? ts : null,
        roomId,
      )

    return { room: getRoom(roomId, userId), move: record, finished: result }
  })
}

/** 认输。对手获胜。 */
export function resign(roomId: string, userId: string): RoomView {
  return transaction(() => {
    const row = getRaw(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.status !== 'playing') throw new HttpError(400, '对局未在进行中')

    const mySide: Color | null =
      row.red_player === userId ? 'red' : row.black_player === userId ? 'black' : null
    if (!mySide) throw new HttpError(403, '你不是对局参与者')

    const winner: Color = mySide === 'red' ? 'black' : 'red'
    const ts = now()
    getDb()
      .prepare(
        `UPDATE game_rooms SET status = 'finished', result = ?, updated_at = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify({ winner, reason: 'resign' }), ts, ts, roomId)

    return getRoom(roomId, userId)
  })
}

/**
 * 退出房间。
 *
 * 对局中的一方退出 = 判负。这不只是"座位空出来"，因为走了的人留下的是一个
 * 无法继续的残局 —— 与其让它永远卡在 playing 状态，不如明确判负。
 */
export function leaveRoom(roomId: string, userId: string): { room: RoomView | null; abandoned: boolean } {
  return transaction(() => {
    const row = getRaw(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const isRed = row.red_player === userId
    const isBlack = row.black_player === userId
    if (!isRed && !isBlack) {
      // 观战者退出：什么都不用做
      return { room: toView(row, userId), abandoned: false }
    }

    const ts = now()
    const wasPlaying = row.status === 'playing'

    if (wasPlaying) {
      const winner: Color = isRed ? 'black' : 'red'
      getDb()
        .prepare(
          `UPDATE game_rooms
              SET status = 'finished', result = ?, updated_at = ?, finished_at = ?,
                  ${isRed ? 'red_player' : 'black_player'} = NULL
            WHERE id = ?`,
        )
        .run(JSON.stringify({ winner, reason: 'abandon' }), ts, ts, roomId)
    } else {
      getDb()
        .prepare(
          `UPDATE game_rooms
              SET updated_at = ?, ${isRed ? 'red_player' : 'black_player'} = NULL
            WHERE id = ?`,
        )
        .run(ts, roomId)
    }

    // 如果房间已经空了（没人、也没结束），直接删掉，避免列表里堆满废弃房间
    const after = getRaw(roomId)
    if (after && !after.red_player && !after.black_player && after.status !== 'finished') {
      getDb().prepare('DELETE FROM game_rooms WHERE id = ?').run(roomId)
      return { room: null, abandoned: wasPlaying }
    }

    return { room: after ? toView(after, userId) : null, abandoned: wasPlaying }
  })
}

/** 清理：把超过 24 小时没有动静的 waiting 房间删掉，避免列表越来越长。 */
/**
 * 占座的人全部离线后，等多久才认定这个房间废了。
 *
 * 给 5 分钟是留出"断线重连"的余地：SSE 抖动、手机切后台、笔记本合盖再打开，
 * 都会让在线状态短暂变成离线，而人其实还在。5 分钟既能自愈，也不会让废弃房间
 * 挂太久。
 */
const OFFLINE_GRACE_MS = 5 * 60 * 1000

/**
 * 清理废弃房间。
 *
 * 两档：
 *
 * 1. **占座的人全离线了**（超过 OFFLINE_GRACE_MS 就删）。
 *    这一档专门为"用户直接关掉窗口/标签页"准备 —— 那种情况前端**根本没机会**
 *    调 leave 接口，房间会带着他的座位一直挂在那儿，而那个座位别人也坐不了。
 *    线上真堆了一排：8 个象棋房里 6 个是"红方被一个已经离线的人占着"。
 *
 * 2. 兜底：超过 24 小时没人动过的等待中房间，无论在线与否都删。
 *
 * ⚠️ 这个函数原来**从来没被任何地方调用过**（死代码）。房间之所以一直不消失，
 * 就是因为第 2 档只存在于设想里 —— 没有任何东西在跑它。
 * 现在它挂在 index.ts 的定时器上（每 2 分钟一次）。
 *
 * @param online 当前确实连着 SSE 的用户 id 集合（调用方传 connectedUserIds()）。
 */
export function cleanupStaleRooms(online: Set<string>): number {
  const db = getDb()
  let removed = 0

  // 第一档：座位都还在，但坐着的人全离线了
  const graceCutoff = now() - OFFLINE_GRACE_MS
  const waiting = db
    .prepare(
      "SELECT id, red_player, black_player FROM game_rooms WHERE kind = 'xiangqi' AND status = 'waiting' AND updated_at < ?",
    )
    .all(graceCutoff) as unknown as Array<{
    id: string
    red_player: string | null
    black_player: string | null
  }>
  for (const row of waiting) {
    const seated = [row.red_player, row.black_player].filter((x): x is string => x !== null)
    // 一个座位都没被占的等待房（理论上不该存在）也一并删掉 —— 它永远不会变成对局
    if (seated.every((id) => !online.has(id))) {
      db.prepare('DELETE FROM game_rooms WHERE id = ?').run(row.id)
      removed++
    }
  }

  // 第二档：兜底。人一直在线但就是不开局，24 小时后也收掉
  const hardCutoff = now() - 24 * 60 * 60 * 1000
  const result = db
    .prepare("DELETE FROM game_rooms WHERE status = 'waiting' AND updated_at < ?")
    .run(hardCutoff)
  removed += Number(result.changes ?? 0)

  return removed
}

/** 我的对局统计（用于"关于"或战绩展示）。 */
export function myStats(userId: string): { played: number; won: number; lost: number } {
  const rows = getDb()
    .prepare(
      `SELECT red_player, black_player, result FROM game_rooms
        WHERE status = 'finished' AND (red_player = ? OR black_player = ?)`,
    )
    .all(userId, userId) as unknown as Array<{
    red_player: string | null
    black_player: string | null
    result: string | null
  }>

  let won = 0
  let lost = 0
  for (const row of rows) {
    if (!row.result) continue
    const parsed = JSON.parse(row.result) as { winner: Color | null }
    if (!parsed.winner) continue
    const mySide: Color | null = row.red_player === userId ? 'red' : 'black'
    if (parsed.winner === mySide) won++
    else lost++
  }
  return { played: rows.length, won, lost }
}

/** 观战者可以看到的合法着法（前端高亮用；只有对局参与者才需要，但观战也不敏感）。 */
export function legalMovesFor(roomId: string, squareNameInput: string): string[] {
  const row = getRaw(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  const board = deserializeBoard(row.board)
  const from = parseSquare(squareNameInput)
  return legalMoves(board, row.turn)
    .filter((m: Move) => m.from === from)
    .map((m: Move) => squareName(m.to))
}
