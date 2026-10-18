/**
 * 中国象棋规则引擎。
 *
 * 为什么自己写而不是用 npm 上的象棋库：
 * 评审团核实过，这类库要么版本线无法确认（本机拿不到 GitHub 与 npm 官方源），
 * 要么上游多年未更新。把"走法是否合法"这种正确性命脉押在一个无法核实的包上
 * 是不划算的 —— 而且象棋规则本身并不复杂，写清楚比查证一个陌生库更快。
 *
 * 正确性怎么保证：**perft 着法计数**。象棋初始局面的合法着法数是公开的已知值
 * （深度 1 = 44、深度 2 = 1920、深度 3 = 79666），如果引擎能精确复现这些数字，
 * 说明走法生成、蹩马腿/塞象眼、九宫限制、过河限制、将帅照面全都对了。
 * 这比"看起来能走"强得多 —— 见 scripts/xiangqi-test.mjs。
 *
 * 棋盘表示：90 格的一维数组，index = row * 9 + col。
 *   row 0 = 黑方底线（棋盘上方），row 9 = 红方底线（棋盘下方）。
 *   红方在下、黑方在上，与所有象棋界面的习惯一致。
 */

export type Color = 'red' | 'black'
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P'

export interface Piece {
  color: Color
  type: PieceType
}

export type Square = number // 0..89，-1 表示无子（用 null 更清晰，见 Board）

/** 90 格棋盘，每格是棋子或 null。 */
export type Board = Array<Piece | null>

export const COLS = 9
export const ROWS = 10

export function idx(row: number, col: number): number {
  return row * COLS + col
}

export function rowOf(square: number): number {
  return Math.floor(square / COLS)
}

export function colOf(square: number): number {
  return square % COLS
}

export function inBoard(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS
}

export const PIECE_NAMES: Record<Color, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
}

/** 初始局面。红方在下（row 7-9），黑方在上（row 0-2）。 */
export function initialBoard(): Board {
  const board: Board = new Array<Piece | null>(ROWS * COLS).fill(null)
  const back: PieceType[] = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R']

  for (let col = 0; col < COLS; col++) {
    board[idx(0, col)] = { color: 'black', type: back[col]! }
    board[idx(9, col)] = { color: 'red', type: back[col]! }
  }
  board[idx(2, 1)] = { color: 'black', type: 'C' }
  board[idx(2, 7)] = { color: 'black', type: 'C' }
  board[idx(7, 1)] = { color: 'red', type: 'C' }
  board[idx(7, 7)] = { color: 'red', type: 'C' }

  for (let col = 0; col < COLS; col += 2) {
    board[idx(3, col)] = { color: 'black', type: 'P' }
    board[idx(6, col)] = { color: 'red', type: 'P' }
  }
  return board
}

export function cloneBoard(board: Board): Board {
  return board.map((p) => (p ? { color: p.color, type: p.type } : null))
}

// ---------------------------------------------------------------- 局面

export interface Position {
  board: Board
  /** 该谁走。 */
  turn: Color
  /** 走子历史，用于判定重复局面与悔棋。 */
  history: Move[]
}

export interface Move {
  from: number
  to: number
  piece: Piece
  captured: Piece | null
}

export function initialPosition(): Position {
  return { board: initialBoard(), turn: 'red', history: [] }
}

// ---------------------------------------------------------------- 基本工具

const ORTHOGONAL: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]

/**
 * 九宫范围。红方在 row 7-9 / col 3-5，黑方在 row 0-2 / col 3-5。
 * 帅与仕不能出九宫。
 */
export function inPalace(color: Color, row: number, col: number): boolean {
  if (col < 3 || col > 5) return false
  return color === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2
}

/** 是否在己方半场（相/象不能过河）。红方半场是 row 5-9。 */
export function ownHalf(color: Color, row: number): boolean {
  return color === 'red' ? row >= 5 : row <= 4
}

export function findKing(board: Board, color: Color): number {
  for (let i = 0; i < board.length; i++) {
    const piece = board[i]
    if (piece && piece.color === color && piece.type === 'K') return i
  }
  return -1
}

/**
 * 将帅照面：两个将在同一列上、中间没有任何棋子。
 *
 * 这不是"不能走的着法"，而是**当前局面本身就非法** —— 等价于被将军。
 * 所以它同时影响"走法生成"（走完不能造成照面）和"将军判定"。
 */
export function kingsFacing(board: Board): boolean {
  const redKing = findKing(board, 'red')
  const blackKing = findKing(board, 'black')
  if (redKing < 0 || blackKing < 0) return false

  const redCol = colOf(redKing)
  const blackCol = colOf(blackKing)
  if (redCol !== blackCol) return false

  const from = Math.min(rowOf(redKing), rowOf(blackKing)) + 1
  const to = Math.max(rowOf(redKing), rowOf(blackKing))
  for (let row = from; row < to; row++) {
    if (board[idx(row, redCol)]) return false
  }
  return true
}

// ---------------------------------------------------------------- 走法生成

/**
 * 生成某个棋子的**伪合法**着法（不考虑走完之后自己是否被将军）。
 *
 * 拆成伪合法 + 过滤两步是标准做法：直接生成完全合法着法会把
 * "移动后是否被将军"的判断散落到每种棋子里，很难保证不漏。
 */
function pseudoMovesFor(board: Board, from: number): number[] {
  const piece = board[from]
  if (!piece) return []

  const row = rowOf(from)
  const col = colOf(from)
  const moves: number[] = []

  const push = (r: number, c: number): void => {
    if (!inBoard(r, c)) return
    const target = board[idx(r, c)]
    if (target && target.color === piece.color) return // 不能吃自己的子
    moves.push(idx(r, c))
  }

  switch (piece.type) {
    case 'K': {
      // 帅/将：九宫内上下左右各走一步
      for (const [dr, dc] of ORTHOGONAL) {
        const r = row + dr
        const c = col + dc
        if (inPalace(piece.color, r, c)) push(r, c)
      }
      break
    }

    case 'A': {
      // 仕/士：九宫内斜走一步
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ] as Array<[number, number]>) {
        const r = row + dr
        const c = col + dc
        if (inPalace(piece.color, r, c)) push(r, c)
      }
      break
    }

    case 'B': {
      // 相/象：斜走两格，不能过河，且"象眼"被占则不能走
      for (const [dr, dc] of [
        [-2, -2],
        [-2, 2],
        [2, -2],
        [2, 2],
      ] as Array<[number, number]>) {
        const r = row + dr
        const c = col + dc
        if (!inBoard(r, c)) continue
        if (!ownHalf(piece.color, r)) continue // 不能过河
        const eyeRow = row + dr / 2
        const eyeCol = col + dc / 2
        if (board[idx(eyeRow, eyeCol)]) continue // 塞象眼
        push(r, c)
      }
      break
    }

    case 'N': {
      // 马：走"日"字，蹩马腿则不能走
      const jumps: Array<[number, number, number, number]> = [
        [-2, -1, -1, 0],
        [-2, 1, -1, 0],
        [2, -1, 1, 0],
        [2, 1, 1, 0],
        [-1, -2, 0, -1],
        [1, -2, 0, -1],
        [-1, 2, 0, 1],
        [1, 2, 0, 1],
      ]
      for (const [dr, dc, legDr, legDc] of jumps) {
        const r = row + dr
        const c = col + dc
        if (!inBoard(r, c)) continue
        if (board[idx(row + legDr, col + legDc)]) continue // 蹩马腿
        push(r, c)
      }
      break
    }

    case 'R': {
      // 车：直线走到底，遇到第一个子为止
      for (const [dr, dc] of ORTHOGONAL) {
        let r = row + dr
        let c = col + dc
        while (inBoard(r, c)) {
          const target = board[idx(r, c)]
          if (!target) {
            moves.push(idx(r, c))
          } else {
            if (target.color !== piece.color) moves.push(idx(r, c))
            break
          }
          r += dr
          c += dc
        }
      }
      break
    }

    case 'C': {
      // 炮：不吃子时同车；吃子必须且只能隔一个子（炮架）
      for (const [dr, dc] of ORTHOGONAL) {
        let r = row + dr
        let c = col + dc
        // 第一阶段：空格，直接走
        while (inBoard(r, c) && !board[idx(r, c)]) {
          moves.push(idx(r, c))
          r += dr
          c += dc
        }
        // 到这里撞到了第一个子（炮架），跳过它继续找可吃的目标
        if (!inBoard(r, c)) continue
        r += dr
        c += dc
        while (inBoard(r, c)) {
          const target = board[idx(r, c)]
          if (target) {
            if (target.color !== piece.color) moves.push(idx(r, c))
            break // 隔了两个子就不能再吃
          }
          r += dr
          c += dc
        }
      }
      break
    }

    case 'P': {
      // 兵/卒：只能向前；过河后可以左右走，但永远不能后退
      const forward = piece.color === 'red' ? -1 : 1
      push(row + forward, col)

      const crossedRiver = piece.color === 'red' ? row <= 4 : row >= 5
      if (crossedRiver) {
        push(row, col - 1)
        push(row, col + 1)
      }
      break
    }
  }

  return moves
}

/** 该方是否正被将军（含将帅照面）。 */
export function isInCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color)
  if (king < 0) return true // 帅没了 —— 理论上不会发生，保守地当作被将军
  if (kingsFacing(board)) return true

  const opponent: Color = color === 'red' ? 'black' : 'red'
  for (let i = 0; i < board.length; i++) {
    const piece = board[i]
    if (!piece || piece.color !== opponent) continue
    if (pseudoMovesFor(board, i).includes(king)) return true
  }
  return false
}

/** 在给定局面上生成完全合法的着法（过滤掉会让自己被将军的）。 */
export function legalMoves(board: Board, color: Color): Move[] {
  const result: Move[] = []
  for (let from = 0; from < board.length; from++) {
    const piece = board[from]
    if (!piece || piece.color !== color) continue
    for (const to of pseudoMovesFor(board, from)) {
      const captured = board[to]
      board[to] = piece
      board[from] = null
      const illegal = isInCheck(board, color)
      board[from] = piece
      board[to] = captured ?? null
      if (!illegal) {
        result.push({ from, to, piece, captured: captured ?? null })
      }
    }
  }
  return result
}

/** 只给某个格子上的子生成合法着法（前端高亮用）。 */
export function legalMovesFrom(board: Board, from: number): Move[] {
  const piece = board[from]
  if (!piece) return []
  return legalMoves(board, piece.color).filter((m) => m.from === from)
}

// ---------------------------------------------------------------- 执行着法

export function applyMove(position: Position, move: Move): Position {
  const board = cloneBoard(position.board)
  const piece = board[move.from]
  if (!piece) throw new Error('起点没有棋子')

  board[move.to] = piece
  board[move.from] = null

  return {
    board,
    turn: position.turn === 'red' ? 'black' : 'red',
    history: [...position.history, { ...move, piece: { ...piece } }],
  }
}

// ---------------------------------------------------------------- 局面判定

export type GameResult =
  | { over: false; inCheck: boolean }
  | { over: true; winner: Color; reason: 'checkmate' | 'stalemate' | 'resign' | 'timeout' | 'no-legal-moves'; inCheck: boolean }

/**
 * 判定当前局面。
 *
 * **注意象棋特有的规则：无棋可走的一方判负，不是和棋。**
 * 这和国象的 stalemate（和棋）完全相反，是最容易做错的一条。
 */
export function evaluateResult(position: Position): GameResult {
  const inCheck = isInCheck(position.board, position.turn)
  const moves = legalMoves(position.board, position.turn)

  if (moves.length === 0) {
    const winner: Color = position.turn === 'red' ? 'black' : 'red'
    return {
      over: true,
      winner,
      // 被将军且无棋可走 = 将死；没被将军但无棋可走 = 困毙，同样判负
      reason: inCheck ? 'checkmate' : 'stalemate',
      inCheck,
    }
  }

  return { over: false, inCheck }
}

// ---------------------------------------------------------------- 序列化

/**
 * 序列化成紧凑字符串，用于存档与前端渲染。
 *
 * 格式：每行 9 个字符，红方大写、黑方小写，空位用 "."。
 * 例如 "rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR"
 */
export function serializeBoard(board: Board): string {
  const rows: string[] = []
  for (let row = 0; row < ROWS; row++) {
    let line = ''
    for (let col = 0; col < COLS; col++) {
      const piece = board[idx(row, col)]
      if (!piece) {
        line += '.'
      } else {
        line += piece.color === 'red' ? piece.type : piece.type.toLowerCase()
      }
    }
    rows.push(line)
  }
  return rows.join('/')
}

export function deserializeBoard(text: string): Board {
  const rows = text.split('/')
  if (rows.length !== ROWS) throw new Error(`棋盘应有 ${ROWS} 行，收到 ${rows.length} 行`)

  const board: Board = new Array<Piece | null>(ROWS * COLS).fill(null)
  for (let row = 0; row < ROWS; row++) {
    const line = rows[row]!
    if (line.length !== COLS) throw new Error(`第 ${row} 行应有 ${COLS} 格，收到 ${line.length} 格`)
    for (let col = 0; col < COLS; col++) {
      const ch = line[col]!
      if (ch === '.') continue
      const upper = ch.toUpperCase()
      if (!'KABNRCP'.includes(upper)) throw new Error(`未知棋子：${ch}`)
      board[idx(row, col)] = {
        color: ch === upper ? 'red' : 'black',
        type: upper as PieceType,
      }
    }
  }
  return board
}

/**
 * 把格号转成人类可读的坐标，例如 "e0"（红帅初始位置）、"e9"（黑将初始位置）。
 *
 * **rank 从底部数**（红方视角），所以 rank 0 是红方底线、rank 9 是黑方底线 ——
 * 与象棋惯例一致。内部存储的行号是从顶部数的（row 0 = 棋盘最上方 = 黑方底线），
 * 所以这里要做一次 9 - row 的翻转。
 *
 * 这个翻转不是可有可无的：如果直接暴露内部行号，就会出现"红帅在 e9、黑将在 e0"
 * 这种与所有象棋资料都相反的坐标，写测试和读代码时极易出错。
 */
export function squareName(square: number): string {
  return `${String.fromCharCode(97 + colOf(square))}${ROWS - 1 - rowOf(square)}`
}

export function parseSquare(name: string): number {
  const match = name.match(/^([a-i])(\d)$/)
  if (!match) throw new Error(`无法解析坐标：${name}`)
  const col = match[1]!.charCodeAt(0) - 97
  const rank = Number.parseInt(match[2]!, 10)
  const row = ROWS - 1 - rank
  if (!inBoard(row, col)) throw new Error(`坐标越界：${name}`)
  return idx(row, col)
}

// ---------------------------------------------------------------- perft

/**
 * perft：统计给定深度下的合法着法总数。
 *
 * 这是验证走法生成正确性的标准手段。象棋初始局面的已知值：
 *   深度 1 = 44，深度 2 = 1920，深度 3 = 79666
 * 能精确复现这些数字，说明所有规则（蹩马腿、塞象眼、九宫、过河、
 * 炮的隔子吃、将帅照面、不能自送将军）都实现对了。
 */
export function perft(board: Board, color: Color, depth: number): number {
  if (depth === 0) return 1

  const moves = legalMoves(board, color)
  if (depth === 1) return moves.length

  let total = 0
  const next: Color = color === 'red' ? 'black' : 'red'
  for (const move of moves) {
    const piece = board[move.from]!
    const captured = board[move.to]
    board[move.to] = piece
    board[move.from] = null
    total += perft(board, next, depth - 1)
    board[move.from] = piece
    board[move.to] = captured ?? null
  }
  return total
}
