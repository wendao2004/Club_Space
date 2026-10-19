/**
 * 绝杀名局识别（杀法分类）。
 *
 * 将死之后，除了"红方获胜"之外还能说得更具体一点：这一手到底是
 * 卧槽马、双车错、还是对面笑？社团里的人下棋图的就是这个 ——
 * "被卧槽马将死了"比"你输了"有意思得多。
 *
 * 设计上的两条：
 *
 * 1. **只认几何上说得清的那几种。** 每个杀法都写成一条能指到具体格子的判据
 *    （"马落在对方 3/7 路 7 线"这种），而不是"看起来像卧槽马就报卧槽马"。
 *    认不出来就老实报「将死」，不硬凑名字。
 *
 * 2. **名字有流派差异，这里给的是最常见的那一种。** 象棋杀法的命名在各地棋书里
 *    并不统一（比如"立马车/列马车"、"对面笑/白脸将"是同一件事的两种叫法），
 *    所以下面每种都写清了自己的判据，并在 detail 里把几何关系说给用户听 ——
 *    名字对不对，用户自己一眼就能判断。
 *
 * ⚠️ 判据里用的"格号"是内部一维坐标（row * 9 + col）：
 *   row 0 = 黑方底线、row 9 = 红方底线；col 0 = a 列（最左）。
 *   所以"对方 3 路 7 线"= 黑方视角的 c7 = (row 2, col 2)。
 */

import {
  COLS,
  colOf,
  findKing,
  legalMoves,
  rowOf,
  type Board,
  type Color,
  type Move,
  type PieceType,
} from './xiangqi.ts'

export interface MatePattern {
  /** 杀法名，例如「卧槽马」。 */
  name: string
  /** 一句话说明这一手是怎么成的杀（给用户看，也用来核对名字对不对）。 */
  detail: string
}

const PIECE_WORD: Record<PieceType, string> = {
  K: '帅/将',
  A: '仕/士',
  B: '相/象',
  N: '马',
  R: '车',
  C: '炮',
  P: '兵/卒',
}

function other(color: Color): Color {
  return color === 'red' ? 'black' : 'red'
}

/**
 * 某方"控制"这一格的棋子（含只能吃掉对方子才走得到的那种）。
 *
 * ⚠️ 探测时把这一格**临时当成空的**再算一遍。不这么做的话，
 * "马护着车"这类关系根本看不出来：车就占在那一格上，马自然走不过去
 * （不能吃自己的子），于是 legalMoves 里什么都没有 —— 立马车会被误判成普通车杀。
 * 把格子当空的再问一次，得到的才是"谁在管这一格"。
 */
function attackersOf(board: Board, side: Color, target: number): Move[] {
  const probe = board.slice()
  probe[target] = null
  return legalMoves(probe, side).filter((m) => m.to === target)
}

/** 把格号描述成用户看得懂的话：「黑方底线 c 路」。 */
function squareWord(square: number, matedSide: Color): string {
  const row = rowOf(square)
  const col = colOf(square)
  const file = String.fromCharCode(97 + col)
  const fromMated = matedSide === 'black' ? row : 9 - row // 从被将死一方的底线数
  const rankWord =
    fromMated === 0 ? '底线' : fromMated === 1 ? '二线' : fromMated === 2 ? '三线' : `${fromMated + 1} 线`
  return `${matedSide === 'black' ? '黑' : '红'}方${rankWord} ${file} 路`
}

/**
 * 识别将死的杀法。
 *
 * @param after 将死之后的棋盘（轮次是被将死的一方）
 * @param last  最后一手（就是成杀的那一手）
 * @param matedSide 被将死的一方
 */
export function classifyMate(after: Board, last: Move, matedSide: Color): MatePattern | null {
  const winner = other(matedSide)
  const kingSquare = findKing(after, matedSide)
  if (kingSquare < 0) return null

  const kingRow = rowOf(kingSquare)
  const kingCol = colOf(kingSquare)
  const lastPiece = after[last.to] // 落子之后，杀子就在目标格上
  if (!lastPiece) return null
  const lastWord = PIECE_WORD[lastPiece.type]

  // 被将死一方的将在此局面下的所有逃格（含被己方子占着的，用于描述）
  const escapeSquares = adjacentKingSquares(kingSquare, matedSide)

  /**
   * ---- 1. 对面笑（白脸将）
   *
   * ⚠️ 判据**不是**"最后一步之后两将照面" —— 那种局面根本不可能出现：
   * 规则禁止走出"两将照面"，所以它自己就是非法局面（本引擎里
   * `kingsFacing` 为真的局面视同被将军，双方都走不进去）。
   *
   * 真正的对面笑是这样成立的：**被将死的将有一个逃格在对方将的那条竖线上，
   * 而这条线上没有别的子** —— 于是它一步都不敢往那儿走，因为走过去就和对方将照面了。
   * 换句话说，是"对面"这条规则替赢家封死了最后一个逃格。
   */
  if (facingDeniesEscape(after, matedSide, kingSquare)) {
    return {
      name: '对面笑',
      detail: '对面笑（白脸将）——将的一个退路正好在对方将的同一条竖线上，走过去就照面，等于被自家规则封死',
    }
  }

  // ---- 2/3/4. 马系杀法：看最后一手落子的位置（这是杀法命名的依据）
  if (lastPiece.type === 'N') {
    // 马杀法的判定要换算到"被将死一方的视角"：用它的底线做参照，
    // 于是红方坐上方/黑方坐下方的镜像局面也能认出来。
    const relRow = matedSide === 'black' ? rowOf(last.to) : 9 - rowOf(last.to)
    const col = colOf(last.to)

    if (relRow === 2 && (col === 2 || col === 6)) {
      return {
        name: '卧槽马',
        detail: `马落${squareWord(last.to, matedSide)}（对方 3/7 路 7 线的"槽"位）将军，将的左右逃格全被这匹马封住`,
      }
    }
    if (relRow === 1 && (col === 2 || col === 6)) {
      return {
        name: '钓鱼马',
        detail: `马落${squareWord(last.to, matedSide)}（对方 3/7 路 8 线），钩住九宫上角，将无路可退`,
      }
    }
    if (relRow === 2 && (col === 3 || col === 5)) {
      return {
        name: '挂角马',
        detail: `马挂${squareWord(last.to, matedSide)}（对方九宫两角的斜下方）将军，将出不了九宫`,
      }
    }
    return {
      name: '马杀',
      detail: `马从${squareWord(last.from, matedSide)}跳到${squareWord(last.to, matedSide)}将军，将无路可走`,
    }
  }

  // ---- 5. 双车错：最后是车将军，且另一只车也参与封锁（同线或控制逃格）
  if (lastPiece.type === 'R') {
    const rooks = allSquaresOf(after, winner, 'R')
    if (rooks.length >= 2) {
      const others = rooks.filter((s) => s !== last.to)
      // 另一只车"参与"的两种形态：跟将同一条横线/竖线（照着将的退路），
      // 或者它的着法正好覆盖将的一个逃格
      const onKingLine = others.some((sq) => rowOf(sq) === kingRow || colOf(sq) === kingCol)
      const coversEscape = others.some((sq) =>
        escapeSquares.some((e) => attackersOf(after, winner, e).some((m) => m.from === sq)),
      )
      if (onKingLine || coversEscape) {
        return {
          name: '双车错',
          detail: '两只车一前一后错开将军：一只车照将，另一只车封住将的所有退路',
        }
      }
    }

    // ---- 6. 立马车（也叫列马车）：车在马的保护下将军
    const horses = allSquaresOf(after, winner, 'N')
    const guarded = horses.some((sq) => attackersOf(after, winner, last.to).some((m) => m.from === sq))
    if (guarded) {
      return {
        name: '立马车',
        detail: '车借马力：马护住这辆车，将吃不动它，于是被将死',
      }
    }

    // ---- 沉底车：车杀到对方底线
    const relRow = matedSide === 'black' ? rowOf(last.to) : 9 - rowOf(last.to)
    if (relRow === 0) {
      return {
        name: '沉底车',
        detail: `车杀到${squareWord(last.to, matedSide)}，贴着底线将军，将退无可退`,
      }
    }
    return { name: '车杀', detail: `车在${squareWord(last.to, matedSide)}将军，将无处可逃` }
  }

  // ---- 7/8. 炮系杀法：看炮架是什么
  if (lastPiece.type === 'C') {
    const screen = screenFor(after, last.to, kingSquare)
    if (screen !== -1) {
      const screenPiece = after[screen]
      if (screenPiece?.type === 'N') {
        return { name: '马后炮', detail: '马在前、炮在后：马当炮架照将，将挪不开又被马封着退路' }
      }
      if (screenPiece?.type === 'C') {
        return { name: '重炮', detail: '两只炮叠在一条线上，前炮当炮架，将防不住也躲不开' }
      }
    }
    return { name: '炮杀', detail: `炮隔着${screen === -1 ? '子' : '一个子'}将军，将无路可走` }
  }

  // ---- 兵/卒杀：小兵立功
  if (lastPiece.type === 'P') {
    return {
      name: '小兵杀',
      detail: `${matedSide === 'black' ? '兵' : '卒'}顶到${squareWord(last.to, matedSide)}将军 —— 小兵也能定胜负`,
    }
  }

  // ---- 兜底：认不出具体杀法，就照实说是"将死"
  const checkers = attackersOf(after, winner, kingSquare).length
  return {
    name: '将死',
    detail:
      checkers > 1
        ? `最后一手用${lastWord}成杀，同时有 ${checkers} 个棋子照着将`
        : `最后一手用${lastWord}成杀，将无路可走`,
  }
}

// ---------------------------------------------------------------- 小工具

/** 某个棋子在棋盘上的全部位置。 */
function allSquaresOf(board: Board, side: Color, type: PieceType): number[] {
  const out: number[] = []
  for (let i = 0; i < board.length; i++) {
    const p = board[i]
    if (p && p.color === side && p.type === type) out.push(i)
  }
  return out
}

/** 九宫内外的邻格（将可能走到的格子），用于描述逃路。 */
function adjacentKingSquares(king: number, side: Color): number[] {
  const row = rowOf(king)
  const col = colOf(king)
  const out: number[] = []
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as Array<[number, number]>) {
    const r = row + dr
    const c = col + dc
    if (r < 0 || r > 9 || c < 0 || c > 8) continue
    const inPalace = c >= 3 && c <= 5 && (side === 'red' ? r >= 7 && r <= 9 : r >= 0 && r <= 2)
    if (inPalace) out.push(r * COLS + c)
  }
  return out
}

/**
 * 对面笑的核心判据：将的某个逃格落在**对方将所在的竖线**上，且两者之间没有别的子。
 * 那个格子因此变成"走不得"（走过去两将照面），也就是被这条规则封死的退路。
 *
 * 只看九宫内的邻格（将本来只能走到这些地方），所以不会把无关的格子算进来。
 */
function facingDeniesEscape(after: Board, matedSide: Color, kingSquare: number): boolean {
  const enemyKing = findKing(after, other(matedSide))
  if (enemyKing < 0) return false
  const enemyCol = colOf(enemyKing)

  for (const square of adjacentKingSquares(kingSquare, matedSide)) {
    if (colOf(square) !== enemyCol) continue

    // 被自己的子占着 —— 本来就过不去，跟照面无关
    const occupant = after[square]
    if (occupant && occupant.color === matedSide) continue
    if (!fileClearBetween(after, square, enemyKing)) continue

    /**
     * ⚠️ 还要**排除"别的子也管着这一格"的情形**。
     *
     * 不然会大面积误判：随便一个"将的逃格恰好在对方将那条竖线上"的杀局，
     * 都会被认成对面笑 —— 哪怕真正封死它的是卧槽马或者另一只车。
     * 对面笑的定义是"**靠照面这条规则**封死了最后一个退路"，
     * 所以只有"除了照面规则，没有任何一个棋子能打到这一格"才算数。
     * （否则那盘棋的杀法另有其名，别去抢人家的名字。）
     */
    if (attackersOf(after, other(matedSide), square).length > 0) continue

    return true
  }
  return false
}

/** 同一竖线上两点之间是否没有子（不含两端）。两点的列必须相同。 */
function fileClearBetween(board: Board, a: number, b: number): boolean {
  if (colOf(a) !== colOf(b)) return false
  const col = colOf(a)
  const from = Math.min(rowOf(a), rowOf(b)) + 1
  const to = Math.max(rowOf(a), rowOf(b))
  for (let row = from; row < to; row++) {
    if (board[row * COLS + col]) return false
  }
  return true
}

/**
 * 找出"从 `from` 打到 `target` 时中间那个炮架"的位置；没有就返回 -1。
 * 只处理直线（炮只会直线打）。
 */
function screenFor(board: Board, from: number, target: number): number {
  const fr = rowOf(from)
  const fc = colOf(from)
  const tr = rowOf(target)
  const tc = colOf(target)
  if (fr !== tr && fc !== tc) return -1

  const dr = Math.sign(tr - fr)
  const dc = Math.sign(tc - fc)
  let r = fr + dr
  let c = fc + dc
  let screen = -1
  while (r !== tr || c !== tc) {
    if (board[r * COLS + c]) {
      if (screen !== -1) return -1 // 中间超过一个子，炮打不过去
      screen = r * COLS + c
    }
    r += dr
    c += dc
  }
  return screen
}
