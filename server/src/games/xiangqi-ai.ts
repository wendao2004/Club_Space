/**
 * 象棋机器人：评估 + alpha-beta 搜索。
 *
 * 为什么不直接用 `xiangqi.ts` 里的 legalMoves 来搜：
 * 那份实现是**给规则校验用的**，为可读性做了取舍 —— 每个候选着法都要重建一次
 * 棋盘对象、调一次 `isInCheck`，而 `isInCheck` 内部又会把对方的**所有**伪着法
 * 生成一遍。也就是每个节点 O(着法数 × 着法数)，深度 4 就是几百万次这种操作。
 * 实测那样搜一层就要几百毫秒，根本下不了棋。
 *
 * 所以这里另写一份**为速度服务的内部实现**：
 *   - 棋盘是 `Int8Array(90)`，棋子编码成小整数（高 3 位颜色、低 3 位兵种）；
 *   - 走法用单个整数表示（`from * 90 + to`），不分配对象；
 *   - 将军判定**从将出发反查**（车/炮/马/兵/将对脸五类攻击者），
 *     而不是"生成对方全部着法看有没有吃到将"。
 *
 * ⚠️ **两份实现并存，就必须有人盯着它们不许分叉。**
 * 走法生成与将军判定在 tests 里做了**差分测试**：随机局面下，
 * 这里的合法着法集合与 `xiangqi.ts` 的 legalMoves 必须逐条相同（顺序无关），
 * 将军判定也必须一致。任何一边改了规则，那组测试立刻会红。
 */

import {
  COLS,
  ROWS,
  type Board,
  type Color,
  type PieceType,
} from './xiangqi.ts'

// ---------------------------------------------------------------- 内部表示

/**
 * 棋子编码：`type | (color << 3)`。
 *   空 = 0；红方 1..7；黑方 9..15。
 * 颜色取 0 = 红（下方）、1 = 黑（上方），与 xiangqi.ts 的 row 方向一致
 * （row 0 是黑方底线）。
 */
export const EMPTY = 0
export const RED = 0
export const BLACK = 1

/** 兵种编码，与 PieceType 一一对应。 */
const T_K = 1
const T_A = 2
const T_B = 3
const T_N = 4
const T_R = 5
const T_C = 6
const T_P = 7

const TYPE_CODE: Record<PieceType, number> = { K: T_K, A: T_A, B: T_B, N: T_N, R: T_R, C: T_C, P: T_P }
const CODE_TYPE: Record<number, PieceType> = { 1: 'K', 2: 'A', 3: 'B', 4: 'N', 5: 'R', 6: 'C', 7: 'P' }

export type FastBoard = Int8Array

export function toFast(board: Board): FastBoard {
  const out = new Int8Array(ROWS * COLS)
  for (let i = 0; i < board.length; i++) {
    const p = board[i]
    if (p) out[i] = TYPE_CODE[p.type] | ((p.color === 'red' ? RED : BLACK) << 3)
  }
  return out
}

export function fromFast(fast: FastBoard): Board {
  const board: Board = new Array(ROWS * COLS).fill(null)
  for (let i = 0; i < fast.length; i++) {
    const pc = fast[i]!
    if (!pc) continue
    board[i] = {
      color: (pc >> 3) === RED ? 'red' : 'black',
      type: CODE_TYPE[pc & 7]!,
    }
  }
  return board
}

function sideIndex(side: Color): number {
  return side === 'red' ? RED : BLACK
}

function otherSide(side: number): number {
  return side === RED ? BLACK : RED
}

// ---------------------------------------------------------------- 常量表

/** 兵种基础价值（"分"）。车 > 炮 > 马 > 士象 > 兵，是象棋界的通行排序。 */
const VALUE: Record<number, number> = {
  [T_K]: 60000,
  [T_R]: 900,
  [T_C]: 450,
  [T_N]: 400,
  [T_A]: 200,
  [T_B]: 200,
  [T_P]: 100,
}

/**
 * 位置价值表（红方视角，下标 [row][col]，row 0 是黑方底线）。
 * 黑方取上下镜像。
 *
 * ⚠️ 这组数字是**手调的**，不是从哪份公开棋谱里抄的：目标只是让机器
 * 有基本的"占中路、车马炮出动、兵过河"的常识，而不是追求棋力上限。
 * 谁想变强，改这里的数就是最直接的入口。
 */
const PST_P = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [90, 90, 110, 120, 120, 120, 110, 90, 90],
  [90, 100, 120, 140, 150, 140, 120, 100, 90],
  [70, 90, 110, 130, 140, 130, 110, 90, 70],
  [50, 70, 80, 90, 100, 90, 80, 70, 50],
  [0, 0, 0, 20, 30, 20, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const PST_N = [
  [0, -20, -10, -10, -10, -10, -10, -20, 0],
  [-10, 0, 10, 10, 10, 10, 10, 0, -10],
  [-10, 10, 20, 25, 25, 25, 20, 10, -10],
  [-10, 10, 25, 30, 35, 30, 25, 10, -10],
  [-10, 10, 25, 35, 40, 35, 25, 10, -10],
  [-10, 10, 25, 30, 35, 30, 25, 10, -10],
  [-10, 10, 20, 25, 25, 25, 20, 10, -10],
  [-10, 0, 15, 20, 20, 20, 15, 0, -10],
  [-20, -10, 0, 5, 5, 5, 0, -10, -20],
  [-30, -20, -10, -5, -5, -5, -10, -20, -30],
]

const PST_R = [
  [10, 12, 14, 16, 16, 16, 14, 12, 10],
  [12, 16, 18, 22, 24, 22, 18, 16, 12],
  [12, 16, 18, 22, 24, 22, 18, 16, 12],
  [14, 18, 20, 26, 28, 26, 20, 18, 14],
  [14, 18, 20, 26, 28, 26, 20, 18, 14],
  [14, 18, 20, 26, 28, 26, 20, 18, 14],
  [12, 16, 18, 22, 24, 22, 18, 16, 12],
  [10, 14, 16, 20, 22, 20, 16, 14, 10],
  [10, 12, 14, 18, 20, 18, 14, 12, 10],
  [10, 12, 14, 16, 18, 16, 14, 12, 10],
]

const PST_C = [
  [6, 4, 0, -10, -12, -10, 0, 4, 6],
  [2, 2, 0, -4, -14, -4, 0, 2, 2],
  [2, 2, 0, -10, -8, -10, 0, 2, 2],
  [0, 0, -2, 4, 10, 4, -2, 0, 0],
  [0, 0, 0, 2, 8, 2, 0, 0, 0],
  [-2, 0, 4, 2, 6, 2, 4, 0, -2],
  [0, 0, 0, 2, 4, 2, 0, 0, 0],
  [4, 0, 8, 6, 10, 6, 8, 0, 4],
  [0, 2, 4, 6, 6, 6, 4, 2, 0],
  [0, 0, 2, 6, 6, 6, 2, 0, 0],
]

const PST_A = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 6, 0, 0, 0, 0],
  [0, 0, 0, 0, 12, 0, 0, 0, 0],
]

const PST_B = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 8, 0, 0, 0, 8, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 2, 0, 0, 0, 2, 0, 0],
]

const PST_K = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 4, 6, 4, 0, 0, 0],
  [0, 0, 0, 4, 8, 4, 0, 0, 0],
  [0, 0, 0, 8, 12, 8, 0, 0, 0],
]

const PST: Record<number, number[][]> = {
  [T_P]: PST_P,
  [T_N]: PST_N,
  [T_R]: PST_R,
  [T_C]: PST_C,
  [T_A]: PST_A,
  [T_B]: PST_B,
  [T_K]: PST_K,
}

/** 取位置价值。红方查原表，黑方上下镜像。 */
function pstValue(type: number, side: number, row: number, col: number): number {
  const table = PST[type]!
  return side === RED ? table[row]![col]! : table[ROWS - 1 - row]![col]!
}

// ---------------------------------------------------------------- 走法生成

/**
 * 走法编码成一个整数：`from * 90 + to`。
 * 不分配对象是搜索速度的关键 —— 每个节点要生成几十个着法，
 * 分配几十个小对象会让 GC 成为热点。
 */
function encode(from: number, to: number): number {
  return from * 90 + to
}

export function moveFrom(code: number): number {
  return Math.floor(code / 90)
}

export function moveTo(code: number): number {
  return code % 90
}

const ORTHO: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]

function inPalaceFast(side: number, row: number, col: number): boolean {
  if (col < 3 || col > 5) return false
  return side === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2
}

function ownHalfFast(side: number, row: number): boolean {
  return side === RED ? row >= 5 : row <= 4
}

/** 生成伪合法着法（不检查走完之后自己是否被将军）。与 xiangqi.ts 的规则逐条对应。 */
export function genPseudoMoves(board: FastBoard, side: number, out: number[]): void {
  out.length = 0
  for (let from = 0; from < 90; from++) {
    const pc = board[from]!
    if (!pc || pc >> 3 !== side) continue
    const type = pc & 7
    const row = (from / 9) | 0
    const col = from % 9

    switch (type) {
      case T_K: {
        for (const [dr, dc] of ORTHO) {
          const r = row + dr
          const c = col + dc
          if (!inPalaceFast(side, r, c)) continue
          const to = r * 9 + c
          const target = board[to]!
          if (target && target >> 3 === side) continue
          out.push(from * 90 + to)
        }
        break
      }
      case T_A: {
        for (const [dr, dc] of [
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
        ] as Array<[number, number]>) {
          const r = row + dr
          const c = col + dc
          if (!inPalaceFast(side, r, c)) continue
          const to = r * 9 + c
          const target = board[to]!
          if (target && target >> 3 === side) continue
          out.push(from * 90 + to)
        }
        break
      }
      case T_B: {
        for (const [dr, dc] of [
          [-2, -2],
          [-2, 2],
          [2, -2],
          [2, 2],
        ] as Array<[number, number]>) {
          const r = row + dr
          const c = col + dc
          if (r < 0 || r > 9 || c < 0 || c > 8) continue
          if (!ownHalfFast(side, r)) continue
          if (board[(row + dr / 2) * 9 + (col + dc / 2)]) continue // 塞象眼
          const to = r * 9 + c
          const target = board[to]!
          if (target && target >> 3 === side) continue
          out.push(from * 90 + to)
        }
        break
      }
      case T_N: {
        for (const [dr, dc, lr, lc] of KNIGHT_JUMPS) {
          const r = row + dr
          const c = col + dc
          if (r < 0 || r > 9 || c < 0 || c > 8) continue
          if (board[(row + lr) * 9 + (col + lc)]) continue // 蹩马腿
          const to = r * 9 + c
          const target = board[to]!
          if (target && target >> 3 === side) continue
          out.push(from * 90 + to)
        }
        break
      }
      case T_R: {
        for (const [dr, dc] of ORTHO) {
          let r = row + dr
          let c = col + dc
          while (r >= 0 && r <= 9 && c >= 0 && c <= 8) {
            const to = r * 9 + c
            const target = board[to]!
            if (!target) {
              out.push(from * 90 + to)
            } else {
              if (target >> 3 !== side) out.push(from * 90 + to)
              break
            }
            r += dr
            c += dc
          }
        }
        break
      }
      case T_C: {
        for (const [dr, dc] of ORTHO) {
          let r = row + dr
          let c = col + dc
          while (r >= 0 && r <= 9 && c >= 0 && c <= 8 && !board[r * 9 + c]) {
            out.push(from * 90 + (r * 9 + c))
            r += dr
            c += dc
          }
          // 撞到的第一个子就是炮架，跳过它继续找可吃的目标
          if (r < 0 || r > 9 || c < 0 || c > 8) continue
          r += dr
          c += dc
          while (r >= 0 && r <= 9 && c >= 0 && c <= 8) {
            const target = board[r * 9 + c]!
            if (target) {
              if (target >> 3 !== side) out.push(from * 90 + (r * 9 + c))
              break
            }
            r += dr
            c += dc
          }
        }
        break
      }
      case T_P: {
        const forward = side === RED ? -1 : 1
        const r = row + forward
        if (r >= 0 && r <= 9) {
          const to = r * 9 + col
          const target = board[to]!
          if (!target || target >> 3 !== side) out.push(from * 90 + to)
        }
        const crossed = side === RED ? row <= 4 : row >= 5
        if (crossed) {
          for (const dc of [-1, 1]) {
            const c = col + dc
            if (c < 0 || c > 8) continue
            const to = row * 9 + c
            const target = board[to]!
            if (!target || target >> 3 !== side) out.push(from * 90 + to)
          }
        }
        break
      }
      default:
        break
    }
  }
}

const KNIGHT_JUMPS: Array<[number, number, number, number]> = [
  [-2, -1, -1, 0],
  [-2, 1, -1, 0],
  [2, -1, 1, 0],
  [2, 1, 1, 0],
  [-1, -2, 0, -1],
  [1, -2, 0, -1],
  [-1, 2, 0, 1],
  [1, 2, 0, 1],
]

// ---------------------------------------------------------------- 将军判定

function findKingFast(board: FastBoard, side: number): number {
  const want = T_K | (side << 3)
  for (let i = 0; i < 90; i++) if (board[i] === want) return i
  return -1
}

/**
 * `side` 的将是否被攻击（含将帅照面）。
 *
 * **从将出发反查**，而不是生成对方全部着法：五次射线（车/炮/对脸）+ 八个马位 + 三个兵位。
 * 士和象不可能攻击到对方将（士出不了九宫，象过不了河，而两边将分处两个九宫），
 * 所以这两类不用查 —— 这是标准优化，漏了会漏判，多查了只是白费时间。
 */
export function inCheckFast(board: FastBoard, side: number): boolean {
  const king = findKingFast(board, side)
  if (king < 0) return true // 将没了，保守当作被将军
  const enemy = otherSide(side)
  const kr = (king / 9) | 0
  const kc = king % 9

  // 一、四个方向的直线：第一个子若是对方车（或紧邻的对方将）→ 被将；
  //     第一个子是任意子（炮架）时，再往后的第一个子若是对方炮 → 被将。
  for (const [dr, dc] of ORTHO) {
    let r = kr + dr
    let c = kc + dc
    let screen = false
    while (r >= 0 && r <= 9 && c >= 0 && c <= 8) {
      const pc = board[r * 9 + c]!
      if (pc) {
        const type = pc & 7
        const owner = pc >> 3
        if (!screen) {
          if (owner === enemy) {
            if (type === T_R) return true
            // 将帅照面：同一列上中间无子，对方的将"攻击"到我
            if (type === T_K && c === kc) return true
          }
          screen = true
        } else {
          if (owner === enemy && type === T_C) return true
          break // 第二个子之后不再有炮击
        }
      }
      r += dr
      c += dc
    }
  }

  // 二、马：八个可能的马位，逐个验"蹩马腿"。
  //     马在 H、将在 K 时，马腿是紧贴 H、朝 K 方向的那一格。
  for (const [dr, dc, lr, lc] of KNIGHT_JUMPS) {
    const r = kr + dr
    const c = kc + dc
    if (r < 0 || r > 9 || c < 0 || c > 8) continue
    const pc = board[r * 9 + c]!
    if (!pc || (pc & 7) !== T_N || pc >> 3 !== enemy) continue
    // 马腿：从马的位置出发，朝将的方向退回一格（长边方向）
    const legR = r - (dr > 0 ? 1 : dr < 0 ? -1 : 0)
    const legC = c - (dc > 0 ? 1 : dc < 0 ? -1 : 0)
    if (board[legR * 9 + legC]) continue
    return true
  }

  // 三、兵/卒：红兵向上走，所以红兵在将的**下方**一格能吃到；
  //     过河后还能横吃，即左右两侧各一格。
  if (enemy === RED) {
    if (kr + 1 <= 9 && board[(kr + 1) * 9 + kc] === (T_P | (RED << 3))) return true
    for (const dc of [-1, 1]) {
      const c = kc + dc
      if (c < 0 || c > 8) continue
      const pc = board[kr * 9 + c]!
      if (pc === (T_P | (RED << 3)) && kr <= 4) return true // 红兵过河（row ≤ 4）才能横吃
    }
  } else {
    if (kr - 1 >= 0 && board[(kr - 1) * 9 + kc] === (T_P | (BLACK << 3))) return true
    for (const dc of [-1, 1]) {
      const c = kc + dc
      if (c < 0 || c > 8) continue
      const pc = board[kr * 9 + c]!
      if (pc === (T_P | (BLACK << 3)) && kr >= 5) return true
    }
  }

  return false
}

/** 在快盘上落子/撤销。返回被吃的子（0 表示空），供撤销时还原。 */
function doMove(board: FastBoard, code: number): number {
  const from = moveFrom(code)
  const to = moveTo(code)
  const captured = board[to]!
  board[to] = board[from]!
  board[from] = 0
  return captured
}

function undoMove(board: FastBoard, code: number, captured: number): void {
  const from = moveFrom(code)
  const to = moveTo(code)
  board[from] = board[to]!
  board[to] = captured
}

/** 生成完全合法着法（过滤掉走完自送将军的）。与 xiangqi.ts 的 legalMoves 等价。 */
export function genLegalMoves(board: FastBoard, side: number): number[] {
  const pseudo: number[] = []
  genPseudoMoves(board, side, pseudo)
  const legal: number[] = []
  for (const code of pseudo) {
    const captured = doMove(board, code)
    if (!inCheckFast(board, side)) legal.push(code)
    undoMove(board, code, captured)
  }
  return legal
}

// ---------------------------------------------------------------- 局面评估

/**
 * 从 `side`（红方）视角评估局面，返回"分"。正值对红方有利。
 *
 * 子力 + 位置表。没有引入"棋子协调""将的安全"这类高阶项 ——
 * 那些要调的东西太多，而这里的定位是"能陪社团里的人下得有来有回"。
 */
export function evaluateFast(board: FastBoard): number {
  let score = 0
  for (let i = 0; i < 90; i++) {
    const pc = board[i]!
    if (!pc) continue
    const type = pc & 7
    const side = pc >> 3
    const value = VALUE[type]! + pstValue(type, side, (i / 9) | 0, i % 9)
    score += side === RED ? value : -value
  }
  return score
}

// ---------------------------------------------------------------- 搜索

/** 将死的分值（减去层数，越早将死分越高）。 */
const MATE = 30000
/** 单步搜索的时间上限兜底，防止某个局面把 CPU 咬住不放。 */
const MAX_PLIES = 64

interface SearchContext {
  board: FastBoard
  /** 当前要搜索的一方（0 红 / 1 黑）。 */
  root: number
  deadline: number
  nodes: number
  /** 杀手着法：同一层里造成剪枝的着法，优先试。 */
  killers: Int32Array
  /** 历史启发：某着法在浅层剪枝中的累计贡献。 */
  history: Int32Array
  stopped: boolean
}

/** 给着法打一个"先试哪个"的分数，大的先试。 */
function scoreMove(ctx: SearchContext, code: number, ply: number): number {
  const to = moveTo(code)
  const captured = ctx.board[to]!
  if (captured) {
    // MVV-LVA：吃大子优先、用小子吃更优先
    const victim = VALUE[captured & 7]!
    const attacker = VALUE[ctx.board[moveFrom(code)]! & 7]!
    return 1_000_000 + victim * 10 - attacker
  }
  if (ctx.killers[ply * 2] === code) return 900_000
  if (ctx.killers[ply * 2 + 1] === code) return 800_000
  const from = moveFrom(code)
  return ctx.history[from * 90 + to]!
}

function sortMoves(ctx: SearchContext, moves: number[], ply: number): void {
  const scores = new Map<number, number>()
  for (const m of moves) scores.set(m, scoreMove(ctx, m, ply))
  moves.sort((a, b) => scores.get(b)! - scores.get(a)!)
}

/**
 * 静态搜索（quiescence）：只搜吃子，直到局面"安静"下来。
 *
 * 没有它的话，搜索会在"我吃了你一个车"这一层就停住并给出高分 ——
 * 而下一步你就能吃回来。这是象棋程序最经典的错觉来源（"地平线效应"）。
 */
function quiesce(ctx: SearchContext, side: number, alpha: number, beta: number, depth: number): number {
  ctx.nodes++
  if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) ctx.stopped = true
  if (ctx.stopped) return 0

  // 站住分：不吃子的情况下，当前局面值多少
  const stand = (side === RED ? 1 : -1) * evaluateFast(ctx.board)
  // ⚠️ fail-soft：超界时返回**真实分数**而不是窗口边界 beta。
  // 返回 beta 在内部节点上没错（那只是一个下界），但根节点会把返回值当成
  // 精确分，于是"任何一步都会看起来和当前最好的一步一样好" —— 曾经因此
  // 让机器人放着一步杀不走，去走别的（见 chooseMove 根节点那段注释）。
  if (stand >= beta) return stand
  if (stand > alpha) alpha = stand

  const pseudo: number[] = []
  genPseudoMoves(ctx.board, side, pseudo)
  const captures = pseudo.filter((m) => ctx.board[moveTo(m)]! !== 0)
  const scores = new Map<number, number>()
  for (const m of captures) scores.set(m, scoreMove(ctx, m, Math.min(depth, 30)))
  captures.sort((a, b) => scores.get(b)! - scores.get(a)!)

  for (const code of captures) {
    const captured = doMove(ctx.board, code)
    if (inCheckFast(ctx.board, side)) {
      undoMove(ctx.board, code, captured)
      continue
    }
    const score = -quiesce(ctx, otherSide(side), -beta, -alpha, depth + 1)
    undoMove(ctx.board, code, captured)
    if (ctx.stopped) return 0
    if (score >= beta) return score
    if (score > alpha) alpha = score
  }
  return alpha
}

/**
 * 负极大搜索。
 *
 * 用负极大（negamax）而不是"最大最小"两套分支：象棋是零和的，
 * 一方的分数取反就是另一方的分数，代码少一半，也不容易出现
 * "红方分支算错了符号"这种只在一边出现的怪 bug。
 */
function negamax(ctx: SearchContext, side: number, depth: number, alpha: number, beta: number, ply: number): number {
  ctx.nodes++
  if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) {
    ctx.stopped = true
    return 0
  }
  if (ctx.stopped) return 0
  if (ply >= MAX_PLIES) return 0

  const pseudo: number[] = []
  genPseudoMoves(ctx.board, side, pseudo)

  if (depth <= 0) {
    /**
     * 走到叶子。
     *
     * 这里**只判断"还有没有棋可走"，找到第一个合法着法就收手** ——
     * 不走"生成全部合法着法"那一步。差别很大：叶子节点占搜索量的绝大多数，
     * 而每个叶子都做完整合法性过滤等于白烧一遍 CPU（每个候选都要落子 + 查将）。
     * 但"一步都走不了 = 将死/困毙"又必须判 —— 否则机器人会漏掉一目了然的杀棋，
     * 那是最容易被用户当场发现的那种蠢。
     */
    let hasLegal = false
    for (const code of pseudo) {
      const captured = doMove(ctx.board, code)
      const ok = !inCheckFast(ctx.board, side)
      undoMove(ctx.board, code, captured)
      if (ok) {
        hasLegal = true
        break
      }
    }
    if (!hasLegal) return -MATE + ply
    return quiesce(ctx, side, alpha, beta, 0)
  }

  // 内部节点：需要完整的合法着法列表来排序与遍历
  const legal: number[] = []
  for (const code of pseudo) {
    const captured = doMove(ctx.board, code)
    if (!inCheckFast(ctx.board, side)) legal.push(code)
    undoMove(ctx.board, code, captured)
  }
  if (legal.length === 0) return -MATE + ply // 被将死或困毙，越晚发生越"不那么糟"

  sortMoves(ctx, legal, ply)

  let best = -Infinity
  for (const code of legal) {
    const captured = doMove(ctx.board, code)
    const score = -negamax(ctx, otherSide(side), depth - 1, -beta, -alpha, ply + 1)
    undoMove(ctx.board, code, captured)
    if (ctx.stopped) return 0

    if (score > best) best = score
    if (score > alpha) alpha = score
    if (alpha >= beta) {
      // 剪枝。记下"这个着法在这一层很凶"，下次先试它
      if (!captured) {
        if (ctx.killers[ply * 2] !== code) {
          ctx.killers[ply * 2 + 1] = ctx.killers[ply * 2]!
          ctx.killers[ply * 2] = code
        }
        ctx.history[moveFrom(code) * 90 + moveTo(code)]! += depth * depth
      }
      break
    }
  }
  return best
}

// ---------------------------------------------------------------- 对外接口

export type BotLevel = 'easy' | 'normal' | 'hard'

export const BOT_LEVEL_LABELS: Record<BotLevel, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
}

export const BOT_LEVELS: BotLevel[] = ['easy', 'normal', 'hard']

/** 各档位的搜索参数。时间上限是**硬约束**：这台 NAS 只有 4 核且要同时服务别人。 */
interface LevelConfig {
  maxDepth: number
  timeMs: number
  /** 随机"走漏着"的概率 —— 简单档要让人赢得下来，不然没人愿意玩。 */
  blunderChance: number
}

const LEVEL_CONFIG: Record<BotLevel, LevelConfig> = {
  easy: { maxDepth: 2, timeMs: 120, blunderChance: 0.25 },
  normal: { maxDepth: 5, timeMs: 450, blunderChance: 0.04 },
  hard: { maxDepth: 7, timeMs: 1200, blunderChance: 0 },
}

/**
 * 某一档的时间预算。给"把搜索放到 worker 线程"的那一层用 —— 它要按同一档位
 * 设超时，不能自己拍一个数字（两处各写一份迟早会对不上）。
 */
export function timeBudgetMs(level: BotLevel): number {
  return LEVEL_CONFIG[level].timeMs
}

/** 可复现的伪随机（xorshift32），测试里靠它拿到确定的结果。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

/**
 * 就地洗牌（Fisher-Yates）。`keepFirst` 表示前几个位置不动
 * —— 根节点用 1，把"上一层算出来的首选着法"钉在第一位。
 */
function shuffle(arr: number[], random: () => number, keepFirst = 0): void {
  for (let i = arr.length - 1; i > keepFirst; i--) {
    const j = keepFirst + Math.floor(random() * (i - keepFirst + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
}

export interface ChooseOptions {
  board: Board
  side: Color
  level: BotLevel
  /** 已经走过的局面（序列化棋盘 + 轮到谁），用于躲开重复。 */
  seenKeys?: string[]
  /** 固定随机种子 = 可复现（测试用）。 */
  seed?: number
  /** 覆盖时间上限（测试用，传 0 表示不限时但要靠 maxDepth 收住）。 */
  timeMs?: number
}

export interface Choice {
  from: number
  to: number
  /** 搜索用掉的节点数，测试与调优时看它 */
  nodes: number
  depth: number
  score: number
}

/**
 * 选一步棋。返回 null 表示没有合法着法（已被将死或困毙）。
 *
 * 迭代加深 + alpha-beta：从深度 1 开始逐层加深，时间不够就用**上一次完整算完**
 * 的那一层结果。这样即使这档的时间只够算 3 层，也不会因为"第 4 层没算完"而弃权。
 */
export function chooseMove(options: ChooseOptions): Choice | null {
  const { board, side, level } = options
  const fast = toFast(board)
  const rootSide = sideIndex(side)
  const config = LEVEL_CONFIG[level]
  const random = makeRandom(options.seed ?? Date.now())

  const rootMoves = genLegalMoves(fast, rootSide)
  if (rootMoves.length === 0) return null

  /**
   * 送到嘴边的一步杀**永远不许放掉**。
   *
   * 上面"偶尔乱走"是为了让新手赢得下来，但如果乱走的那一步正好是
   * "本来一步就能将死对手"的局面，用户会当场认定这机器是坏的 ——
   * 那是所有失误里最扎眼的一种。所以乱走之前先花极小代价扫一眼：
   * 有一步杀就老老实实走它。（~40 次落子 + 判负，几十微秒的事。）
   */
  const hasMateInOne = (): boolean => {
    for (const code of rootMoves) {
      const captured = doMove(fast, code)
      const mate = inCheckFast(fast, otherSide(rootSide)) && genLegalMoves(fast, otherSide(rootSide)).length === 0
      undoMove(fast, code, captured)
      if (mate) return true
    }
    return false
  }

  // 简单档偶尔故意乱走：不是 bug，是让新手能赢。
  if (config.blunderChance > 0 && random() < config.blunderChance && !hasMateInOne()) {
    const pick = rootMoves[Math.floor(random() * rootMoves.length)]!
    return { from: moveFrom(pick), to: moveTo(pick), nodes: 0, depth: 0, score: 0 }
  }

  const ctx: SearchContext = {
    board: fast,
    root: rootSide,
    deadline: Date.now() + (options.timeMs ?? config.timeMs),
    nodes: 0,
    killers: new Int32Array(MAX_PLIES * 2),
    history: new Int32Array(90 * 90),
    stopped: false,
  }

  /**
   * 已经出现过的局面。**只在根节点**用它做一次惩罚，不进搜索树内部：
   * 树内做重复检测要给每个节点算一次局面哈希，代价与收益不成比例；
   * 而"机器人赢着赢着开始来回晃"这种毛病，在根上避一下基本就没有了。
   * （真正防住无限对局的是房间层的"同一局面出现三次判和"，见 rooms.ts。）
   */
  const seen = new Set(options.seenKeys ?? [])
  const REPEAT_PENALTY = 60

  let bestMove = -1
  let bestScore = -Infinity
  let reachedDepth = 0

  for (let depth = 1; depth <= config.maxDepth; depth++) {
    let alpha = -Infinity
    let localMove = -1
    let aborted = false

    /**
     * 根节点的着法顺序：上一层的首选先试（它最可能是最好的），其余按启发排序。
     *
     * 排序**之前**先打乱一次，是为了让"同分着法"每盘不一样（否则开局的每一步
     * 都会走出同一盘棋）。打乱之后根节点就能用严格的 `>` 比较，
     * 不必再靠"分数相等就随机挑"——那种写法会被 fail-high 返回的**边界值**骗到：
     * 零窗口搜出来的"不比我最好的一步好"可能是恰好等于 alpha 的边界值，
     * 于是看起来和真正的首选同分，把首选取代掉。这个坑真实发生过：
     * 机器人放着一目了然的杀棋不走，去走别的。
     */
    const ordered = [
      ...(bestMove >= 0 ? [bestMove] : []),
      ...rootMoves.filter((m) => m !== bestMove),
    ]
    shuffle(ordered, random, bestMove >= 0 ? 1 : 0)
    sortMoves(ctx, ordered, 0)

    let index = 0
    for (const code of ordered) {
      const captured = doMove(ctx.board, code)
      let score: number
      let exact = true

      if (index === 0) {
        // 第一步用完整窗口，拿一个精确分当基准
        score = -negamax(ctx, otherSide(rootSide), depth - 1, -Infinity, -alpha, 1)
      } else {
        // 其余先零窗口试探："比现在最好的还好吗" —— 只回答这一个问题，快得多
        score = -negamax(ctx, otherSide(rootSide), depth - 1, -alpha - 1, -alpha, 1)
        if (score > alpha && !ctx.stopped) {
          // 真的更好：重搜一次拿精确分（零窗口返回的是界，不是分数）
          score = -negamax(ctx, otherSide(rootSide), depth - 1, -Infinity, -alpha, 1)
        } else {
          exact = false
        }
      }
      index++

      // 走完回到出现过的局面：轻微扣分，让机器人优先走别的路。
      // 只加在**精确分**上 —— 界上面加东西只会污染判断。
      if (!ctx.stopped && exact && seen.size > 0 && Math.abs(score) < MATE - 100) {
        const nextTurn: Color = otherSide(rootSide) === RED ? 'red' : 'black'
        if (seen.has(positionKey(fromFast(ctx.board), nextTurn))) score -= REPEAT_PENALTY
      }
      undoMove(ctx.board, code, captured)
      if (ctx.stopped) {
        aborted = true
        break
      }
      if (score > alpha) {
        alpha = score
        localMove = code
      }
    }

    if (aborted) break
    if (localMove >= 0) {
      bestMove = localMove
      bestScore = alpha
      reachedDepth = depth
    }
    // 已经算出必杀（或被杀），再深也没意义
    if (Math.abs(bestScore) > MATE - 100) break
  }

  // 兜底：任何情况下都得还一个合法着法回去（搜索被时间打断到一步没算完时）
  if (bestMove < 0) bestMove = rootMoves[0]!

  return {
    from: moveFrom(bestMove),
    to: moveTo(bestMove),
    nodes: ctx.nodes,
    depth: reachedDepth,
    score: bestScore,
  }
}

/** 供房间层构造"已出现局面"集合时使用：棋盘 + 轮次一起作为 key。 */
export function positionKey(board: Board, turn: Color): string {
  return `${board.map((p) => (p ? (p.color === 'red' ? p.type : p.type.toLowerCase()) : '.')).join('')}|${turn}`
}
