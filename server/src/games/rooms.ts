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
  initialBoard,
  legalMoves,
  parseSquare,
  serializeBoard,
  squareName,
  type Board,
  type Color,
  type Move,
} from './xiangqi.ts'
import { BOT_LEVEL_LABELS, positionKey, type BotLevel } from './xiangqi-ai.ts'
import { searchBotMove } from './bot-runner.ts'
import { classifyMate, type MatePattern } from './xiangqi-mates.ts'

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

export interface RoomResult {
  winner: Color | null
  reason: string
  /** 将死时给出的杀法（卧槽马、双车错……），认不出来就是 null。 */
  mate?: MatePattern | null
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
  result: RoomResult | null
  /** 当前局面是否处于将军状态 */
  inCheck: boolean
  /** 哪一边是电脑（人机对战）；两边都是人就为 null。 */
  botSide: Color | null
  /** 电脑的难度档位，用于显示与"再来一局"沿用同一档。 */
  botLevel: BotLevel | null
  /** 是否轮到电脑走 —— 前端据此显示"电脑思考中…"。 */
  botThinking: boolean
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
  bot_side: Color | null
  bot_level: BotLevel | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

/** 电脑的显示名。故意带上难度：用户想知道自己在跟什么水平的对手下。 */
export function botName(level: BotLevel): string {
  return `电脑（${BOT_LEVEL_LABELS[level]}）`
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
  const result = row.result ? (JSON.parse(row.result) as RoomResult) : null

  const mySide: Color | null =
    row.red_player === viewerId ? 'red' : row.black_player === viewerId ? 'black' : null

  // 只在未结束时算将军，避免对已结束的对局做无意义的计算
  const inCheck = row.status === 'finished' ? false : evaluateResult({ board, turn: row.turn, history: [] }).inCheck

  const botSide = row.bot_side ?? null
  const botLevel = row.bot_level ?? null
  const botLabel = botLevel ? botName(botLevel) : '电脑'

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    redPlayer: row.red_player,
    redName: botSide === 'red' ? botLabel : row.red_name,
    blackPlayer: row.black_player,
    blackName: botSide === 'black' ? botLabel : row.black_name,
    board: row.board,
    turn: row.turn,
    moves,
    result,
    inCheck,
    botSide,
    botLevel,
    botThinking: row.status === 'playing' && botSide === row.turn,
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
  /** 人机对战：电脑坐哪一边、什么难度。传了就是"坐下即开局"。 */
  bot?: { side: Color; level: BotLevel }
}): RoomView {
  const title = input.title.trim() || '一盘象棋'
  if (title.length > 40) throw new HttpError(400, '房间名过长')

  const side: Color = input.side ?? 'red'
  const id = newId('room')
  const ts = now()

  /**
   * 人机对战与人人对战走**同一条数据通路**，只在两处不同：
   *   - 电脑那一边不占 player 列（它不是一个用户），改记在 bot_side 上；
   *   - 座位一开始就是满的，所以直接进 playing，不用等人加入。
   *
   * 这样"走棋校验、认输、退出、大厅列表、战绩统计"都不用为机器人写特例 ——
   * 特例越少，越不容易出现"只有人机对战模式下某个功能坏掉"这种 bug。
   */
  const botSide = input.bot?.side ?? null
  const humanSide: Color = botSide ? (botSide === 'red' ? 'black' : 'red') : side
  const status: RoomStatus = botSide ? 'playing' : 'waiting'

  getDb()
    .prepare(
      `INSERT INTO game_rooms
         (id, kind, title, status, created_by, red_player, black_player, board, turn, moves,
          bot_side, bot_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'red', '[]', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      title,
      status,
      input.creatorId,
      humanSide === 'red' ? input.creatorId : null,
      humanSide === 'black' ? input.creatorId : null,
      serializeBoard(initialBoard()),
      botSide,
      botSide ? (input.bot?.level ?? 'normal') : null,
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
 *
 * 人机对战**不能被加入**：那是给一个人开的练习局。别人插进来坐不上座位
 * （电脑那一边不是用户），只会看到一个"对面是电脑"的棋局，白占一个座位。
 */
export function joinRoom(roomId: string, userId: string, side?: Color): RoomView {
  return transaction(() => {
    const row = getRaw(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.bot_side) throw new HttpError(409, '这是人机对战，不能加入 —— 你可以自己新开一局')
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
  finished: RoomResult | null
}

/**
 * 这个局面在这一局里出现过几次（含当前这一次）。
 *
 * 用于"同一局面出现三次判和"：一盘棋如果双方都不肯变着，会无限走下去，
 * 而**没有任何超时机制**的话就会一直挂在 playing 上，谁都不知道该干什么。
 *
 * ⚠️ 这是**简化版**的和棋规则。正式的中国象棋裁判还要区分"长将""长捉"
 * （单方面反复将军是要判负的），那需要逐着判定"是否在将军""是否在捉同一个子"，
 * 规则量很大。这里只做"三次重复即和"，两种情形都说清楚：
 * 机器人不会无谓重复（它在根节点会避开已经出现过的局面），
 * 所以真被判和的，基本都是人自己在下"磨棋"。
 */
function positionOccurrences(moves: RoomMove[], current: Board, currentTurn: Color): number {
  const target = positionKey(current, currentTurn)
  let board = initialBoard()
  let turn: Color = 'red'
  let count = positionKey(board, turn) === target ? 1 : 0

  for (const record of moves) {
    let from: number
    let to: number
    try {
      from = parseSquare(record.from)
      to = parseSquare(record.to)
    } catch {
      break // 历史里出现坏坐标就别再往下算了（宁可少算，不要抛异常打断走棋）
    }
    const piece = board[from]
    if (!piece) break
    const applied = applyMove(
      { board, turn, history: [] },
      { from, to, piece, captured: board[to] ?? null },
    )
    board = applied.board
    turn = applied.turn
    if (positionKey(board, turn) === target) count++
  }
  return count
}

/** 这一局里出现过的所有局面（给机器人用来避开无谓重复）。 */
function historyKeys(moves: RoomMove[]): string[] {
  const keys: string[] = [positionKey(initialBoard(), 'red')]
  let board = initialBoard()
  let turn: Color = 'red'
  for (const record of moves) {
    let from: number
    let to: number
    try {
      from = parseSquare(record.from)
      to = parseSquare(record.to)
    } catch {
      break
    }
    const piece = board[from]
    if (!piece) break
    const applied = applyMove(
      { board, turn, history: [] },
      { from, to, piece, captured: board[to] ?? null },
    )
    board = applied.board
    turn = applied.turn
    keys.push(positionKey(board, turn))
  }
  return keys
}

/**
 * 落子的**共同内核**：人类与机器人走的是同一段代码。
 *
 * 校验链条（任一环不过就拒绝）：
 *   1. 房间在对局中
 *   2. 走子的是这一局的参与者（调用方已经定好是哪一方）
 *   3. 现在轮到他走
 *   4. 这个走法在规则引擎给出的合法着法列表里
 *
 * 第 4 条是防作弊的关键：客户端提交的只是一个意图，合法性完全由服务端裁定。
 */
function applySideMove(
  roomId: string,
  row: RawRoom,
  side: Color,
  from: number,
  to: number,
  by: string,
  byName: string,
): MoveResult {
  if (side !== row.turn) throw new HttpError(400, '还没轮到你走')

  const board = deserializeBoard(row.board)
  const legal = legalMoves(board, side)
  const move = legal.find((m) => m.from === from && m.to === to)
  if (!move) {
    throw new HttpError(400, '这个走法不合法')
  }

  const next = applyMove({ board, turn: side, history: [] }, move)
  const verdict = evaluateResult(next)

  const record: RoomMove = {
    from: squareName(move.from),
    to: squareName(move.to),
    color: side,
    piece: move.piece.type,
    captured: move.captured ? move.captured.type : null,
    check: verdict.inCheck,
    at: now(),
    by,
    byName,
  }

  const moves = [...(JSON.parse(row.moves) as RoomMove[]), record]
  const ts = now()

  let status: RoomStatus = 'playing'
  let result: RoomResult | null = null

  if (verdict.over) {
    status = 'finished'
    result = {
      winner: verdict.winner,
      reason: verdict.reason,
      // 将死时把杀法认出来：用户看到的是「绝杀 · 卧槽马」，而不是干巴巴一句"你输了"。
      // 认不出来就是 null，前端照旧显示「将死」。
      mate: verdict.reason === 'checkmate' ? classifyMate(next.board, move, next.turn) : null,
    }
  } else if (positionOccurrences(moves, next.board, next.turn) >= 3) {
    // 三次重复判和（见 positionOccurrences 的说明）
    status = 'finished'
    result = { winner: null, reason: 'repetition', mate: null }
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

  return { room: getRoom(roomId, by), move: record, finished: result }
}

/** 人类走一步棋。 */
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

    let from: number
    let to: number
    try {
      from = parseSquare(fromName)
      to = parseSquare(toName)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : '坐标不合法')
    }

    return applySideMove(roomId, row, mySide, from, to, userId, userName)
  })
}

/**
 * 机器人走一步棋。
 *
 * 与 makeMove 的区别只有"谁在走"这一层：这里不接受任何外部输入的着法，
 * 一切由搜索决定；所以它**不是**一个可以被客户端调用的接口，
 * 只由服务端在"轮到机器人"时自己触发（见 index.ts 的 scheduleBotReply）。
 *
 * 返回 null 表示现在不该机器人走（比如人正好在同一瞬间也落了子、或者对局已经结束）。
 *
 * 这里有三道"绝不让对局冻住"的保险，都是针对"卡在思考中"这个真实故障加的：
 *
 *   1. 无棋可走 → **自己把对局判终局**（返回 move: null），不是安静地 return；
 *   2. 搜索失败 / 给出一个不在权威合法着法里的着法 → **改走一步合法棋**；
 *   3. 落子前**重新读一次库**，确认这局还在进行、还轮到它、局面没变 ——
 *      搜索在线程里要跑一秒多，这段时间里人可能已经认输了，不能把终局写回进行中。
 */
export interface BotMoveOutcome {
  room: RoomView
  /** 这一手棋；null 表示这一手不是走棋，而是"无棋可走"直接判了终局。 */
  move: RoomMove | null
  finished: RoomResult | null
}

export interface BotMoveOptions {
  /** 跳过搜索，直接挑一步合法棋（搜索出问题时的兜底路径）。 */
  force?: boolean
  /** 不允许早于这个时间点落子（毫秒时间戳）。纯粹是"像是想了一下"的节奏控制。 */
  notBefore?: number
}

/** 无棋可走：这一手不落子，直接把对局判成终局。 */
function finishWithoutMoves(roomId: string, row: RawRoom, side: Color): BotMoveOutcome {
  const verdict = evaluateResult({ board: deserializeBoard(row.board), turn: side, history: [] })
  // 正常路径下 verdict 一定是"已结束"（一步合法棋都走不出来 = 将死或困毙）。
  // 类型上是联合类型，所以这里写全两个分支；`no-legal-moves` 那个兜底分支
  // 在逻辑上到不了，但万一到了，也要给一个明确的终局而不是让房间悬着。
  const result: RoomResult = verdict.over
    ? { winner: verdict.winner, reason: verdict.reason, mate: null }
    : { winner: side === 'red' ? 'black' : 'red', reason: 'no-legal-moves', mate: null }
  const ts = now()
  getDb()
    .prepare(
      `UPDATE game_rooms SET status = 'finished', result = ?, updated_at = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(JSON.stringify(result), ts, ts, roomId)
  return { room: getRoom(roomId, 'bot'), move: null, finished: result }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function makeBotMove(
  roomId: string,
  options: BotMoveOptions = {},
): Promise<BotMoveOutcome | null> {
  const row = getRaw(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  if (!row.bot_side || !row.bot_level) return null
  if (row.status !== 'playing') return null

  const botSide = row.bot_side
  if (botSide !== row.turn) return null

  const board = deserializeBoard(row.board)
  const level: BotLevel = row.bot_level
  const legal = legalMoves(board, botSide)

  if (legal.length === 0) return finishWithoutMoves(roomId, row, botSide)

  let picked: Move | null = null
  if (!options.force) {
    try {
      const choice = await searchBotMove({
        board,
        side: botSide,
        level,
        seenKeys: historyKeys(JSON.parse(row.moves) as RoomMove[]),
      })
      if (choice) picked = legal.find((m) => m.from === choice.from && m.to === choice.to) ?? null
    } catch (err) {
      // searchBotMove 内部已经兜过一层，走到这里说明连降级路径也炸了 ——
      // 记一笔，下面照样用"随便挑一步合法棋"继续。
      console.error(`[棋局] 机器人搜索失败（房间 ${roomId}）：`, err instanceof Error ? err.message : err)
    }
  }

  if (options.notBefore) {
    const wait = options.notBefore - Date.now()
    if (wait > 0) await sleep(wait)
  }

  // 落子前重新读一次：搜索期间这一局可能已经结束、或者人已经走了别的。
  const fresh = getRaw(roomId)
  if (!fresh || fresh.status !== 'playing' || fresh.turn !== botSide) return null
  if (fresh.board !== row.board) return null

  // 用**权威规则引擎**再确认一次这一步真的合法。搜索用的是为速度另写的一份实现
  // （见 xiangqi-ai.ts 开头），两份实现万一在某个冷门局面上分叉，直接提交会被
  // applySideMove 以 400 拒掉 —— 那正是一个"机器人再也不落子"的死局。
  // 这里花几毫秒把它挡在落子之前：不在合法表里就换一步。
  const freshLegal = legalMoves(deserializeBoard(fresh.board), botSide)
  const finalMove =
    (picked && freshLegal.find((m) => m.from === picked.from && m.to === picked.to)) || freshLegal[0]
  if (!finalMove) return finishWithoutMoves(roomId, fresh, botSide)

  return transaction(() => {
    const result = applySideMove(
      roomId,
      fresh,
      botSide,
      finalMove.from,
      finalMove.to,
      'bot',
      botName(level),
    )
    return { room: result.room, move: result.move, finished: result.finished }
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

  /**
   * 第三档：**人机对战**的残局。
   *
   * 人机对战一坐下就是 playing（电脑那一半座位不需要等人），所以前两档都够不着它。
   * 而"人关掉窗口就走了"这件事在机器人那一边没有任何人来收尾 ——
   * 正常路径是前端关窗前自动退出（会判负并结束），但那需要前端真的执行到；
   * 浏览器崩溃、手机关掉、网断了都不会。
   *
   * 所以给一条 24 小时兜底：练习局而已，不值得为它保留残局，
   * 但要留够时间让人回来接着下（刷新页面就能继续）。
   */
  const botRooms = db
    .prepare(
      `DELETE FROM game_rooms
        WHERE kind = 'xiangqi' AND bot_side IS NOT NULL AND status = 'playing' AND updated_at < ?`,
    )
    .run(hardCutoff)
  removed += Number(botRooms.changes ?? 0)

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
