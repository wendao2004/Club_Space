/**
 * 中国象棋规则引擎测试。
 *
 * 验证策略分两层：
 *
 *  1. **perft 着法计数**（最重要）。象棋初始局面的合法着法总数是公开的已知值：
 *     深度 1 = 44，深度 2 = 1920，深度 3 = 79666。能精确复现这三个数字，
 *     等价于同时验证了蹩马腿、塞象眼、九宫限制、过河限制、炮的隔子吃、
 *     将帅照面、以及"不能自送将军"这一整套规则。
 *     这比逐个规则写断言强得多 —— 规则之间的交互错误只有在计数上才暴露得出来。
 *
 *  2. 单条规则的定向断言。用于在 perft 失败时快速定位是哪条规则写错了。
 *
 * 【坐标约定】squareName() 的 rank **从底部数**（红方视角）：
 *   "e0" = 红方底线中列（红帅初始位置）
 *   "e9" = 黑方底线中列（黑将初始位置）
 *   棋盘字符串数组的下标是**从顶部数**的行号，两者差一个 9 - row 的翻转。
 *
 * 【构造测试局面的两个坑】
 *   ① 两个将帅不能在同一列且中间无子 —— 否则局面本身就非法，被判定为"被将军"，
 *      会导致所有着法都非法，测出来的数字全是 0。
 *   ② 更隐蔽的是：如果某个棋子恰好是两个将帅之间**唯一**的阻挡，那这个棋子一动
 *      就会造成照面，它的所有着法都会变成非法。这不是引擎的 bug，是测试局面没设计好。
 *   所以本文件里除专门测照面的用例之外，红帅一律放在 d0（与黑将的 e 列不同列）。
 *
 * 用法：node scripts/xiangqi-test.mjs
 *      XIANGQI_PERFT4=1 node scripts/xiangqi-test.mjs   # 额外跑深度 4（较慢）
 */

import {
  applyMove,
  deserializeBoard,
  evaluateResult,
  findKing,
  initialBoard,
  isInCheck,
  kingsFacing,
  legalMoves,
  legalMovesFrom,
  parseSquare,
  perft,
  serializeBoard,
  squareName,
} from '../server/src/games/xiangqi.ts'

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

/** 从 10 行字符串构造局面。每行 9 格，红方大写、黑方小写、空位用 . */
function board(rows) {
  if (rows.length !== 10) throw new Error(`测试局面必须有 10 行，收到 ${rows.length} 行`)
  for (const [i, row] of rows.entries()) {
    if (row.length !== 9) throw new Error(`第 ${i} 行应有 9 格，收到 ${row.length}：${row}`)
  }
  return deserializeBoard(rows.join('/'))
}

/** 数某个格子上的棋子有多少合法着法，返回目标格名字数组。 */
function movesFrom(b, square) {
  const piece = b[parseSquare(square)]
  if (!piece) {
    // 这个报错比"期望 8 实际 0"有用得多：直接指出是测试局面写错了
    throw new Error(`测试局面写错了：${square} 上没有棋子`)
  }
  return legalMovesFrom(b, parseSquare(square)).map((m) => squareName(m.to))
}

function countFrom(b, square) {
  return movesFrom(b, square).length
}

/** 红帅在 d0、黑将在 e9 的"安全"骨架：两个将帅不同列，不会有照面干扰。 */
function withKings(rows) {
  const next = [...rows]
  next[9] = '...K.....'
  next[0] = '....k....'
  return next
}

function main() {
  console.log('\n\x1b[1m中国象棋规则引擎测试\x1b[0m\n')

  // ================================================================
  console.log('【perft 着法计数（正确性的核心证据）】')

  const board0 = initialBoard()
  const t1 = Date.now()
  const d1 = perft(board0, 'red', 1)
  const d2 = perft(board0, 'red', 2)
  const d3 = perft(board0, 'red', 3)
  const elapsed = Date.now() - t1

  eq(d1, 44, 'perft(1) = 44')
  eq(d2, 1920, 'perft(2) = 1920')
  eq(d3, 79666, 'perft(3) = 79666')
  console.log(`      \x1b[90m（深度 3 共 ${d3} 个着法，耗时 ${elapsed}ms）\x1b[0m`)

  if (process.env.XIANGQI_PERFT4 === '1') {
    const t = Date.now()
    eq(perft(board0, 'red', 4), 3290240, 'perft(4) = 3290240')
    console.log(`      \x1b[90m（深度 4 耗时 ${Date.now() - t}ms）\x1b[0m`)
  } else {
    console.log('      \x1b[90m（深度 4 已跳过，设 XIANGQI_PERFT4=1 可启用）\x1b[0m')
  }

  // ================================================================
  console.log('\n【马的蹩腿】')

  // 红马在 e4（行 5 列 4）；黑卒在 e5（行 4 列 4）挡住"往上"的两条腿
  const horseLeg = board(
    withKings([
      '....k....', // 9
      '.........', // 8
      '.........', // 7
      '.........', // 6
      '....p....', // 5  ← 蹩马腿的子（e5）
      '....N....', // 4  ← 红马（e4）
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  eq(countFrom(horseLeg, 'e4'), 6, '马被蹩腿后少了向上两个着法（8 → 6）')

  const horseFree = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '....N....', // e4
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  eq(countFrom(horseFree, 'e4'), 8, '无阻挡时马有 8 个着法')

  const horseAllLegs = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '....p....', // 挡前
      '...pNp...', // 挡左右（马在 e4）
      '....p....', // 挡后
      '.........',
      '.........',
      '.........',
    ]),
  )
  eq(countFrom(horseAllLegs, 'e4'), 0, '四条马腿都被挡时马无路可走')

  // ================================================================
  console.log('\n【象的塞眼与不过河】')

  // 红相在 c4（行 5 列 2）：往上两个着法会过河（行 3 属黑方半场）→ 被禁
  const elephant = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '..B......', // c4
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  eq(countFrom(elephant, 'c4'), 2, '相不能过河：只能走己方半场的两个斜向')

  // 塞象眼：在 b3（行 6 列 1）放子，堵住往 a2（行 7 列 0）的路
  const elephantEye = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '..B......', // c4（行 5 列 2）
      '.p.......', // b3（行 6 列 1）= 象眼
      '.........',
      '.........',
      '.........',
    ]),
  )
  eq(countFrom(elephantEye, 'c4'), 1, '塞象眼后相少一个着法（2 → 1）')

  // ================================================================
  console.log('\n【九宫限制】')

  // 红帅在 d0（九宫左下角），黑将在 e9
  const kingCorner = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  const kingMoves = movesFrom(kingCorner, 'd0')
  assert(kingMoves.length > 0, '帅有可走的着法（不是空集）', kingMoves.join(','))
  assert(
    kingMoves.every((name) => {
      const col = name.charCodeAt(0) - 97
      const rank = Number(name.slice(1))
      return col >= 3 && col <= 5 && rank >= 0 && rank <= 2
    }),
    '帅的所有着法都在九宫内',
    kingMoves.join(','),
  )
  // 从 d0 可走 d1（向上）与 e0（向右）；但走到 e 列会与黑将照面 → 非法
  eq(kingMoves.length, 1, '帅在九宫角落且不能走到与对方将照面的列上（只剩 1 个着法）', kingMoves.join(','))
  assert(kingMoves.includes('d1'), '合法的那一步是 d1', kingMoves.join(','))

  // 仕在 e1（九宫中心）。红帅放 e0、黑将放 d9 —— 两者不同列，
  // 且都不在仕的四个斜向目标（d2/f2/d0/f0）上，这样仕才有完整的 4 个着法。
  const advisor = board([
    '...k.....', // 9  d9 黑将
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....A....', // 1  e1 红仕
    '....K....', // 0  e0 红帅
  ])
  const advisorMoves = movesFrom(advisor, 'e1')
  eq(advisorMoves.length, 4, '仕在九宫中心有 4 个斜向着法', advisorMoves.join(','))
  assert(
    advisorMoves.every((name) => {
      const col = name.charCodeAt(0) - 97
      const rank = Number(name.slice(1))
      return col >= 3 && col <= 5 && rank >= 0 && rank <= 2
    }),
    '仕的着法也都在九宫内',
    advisorMoves.join(','),
  )

  // ================================================================
  console.log('\n【炮的隔子吃】')

  // 空盘（只有两个将帅，且都避开 e 列，这样炮的四个方向都是干净的空线）：
  // 红炮在 e4。黑将放 f9、红帅放 d0 —— 两者都不在 e 列上。
  const cannonOpen = board([
    '.....k...', // 9  f9 黑将（避开 e 列）
    '.........',
    '.........',
    '.........',
    '.........',
    '....C....', // 4  e4 红炮
    '.........',
    '.........',
    '.........',
    '...K.....', // 0  d0 红帅
  ])
  eq(countFrom(cannonOpen, 'e4'), 17, '空盘上炮的着法与车相同（5 上 + 4 下 + 4 左 + 4 右 = 17）')

  // 炮架在 e7（行 2 列 4），目标黑车在 e9（行 0 列 4）
  const cannonScreen = board([
    '....r.k..', // 9  e9 黑车（目标） · g9 黑将
    '.........', // 8  e8 空格
    '....p....', // 7  e7 炮架
    '.........',
    '.........',
    '....C....', // 4  e4 红炮
    '.........',
    '.........',
    '.........',
    '...K.....', // 0  d0 红帅
  ])
  const cannonTargets = movesFrom(cannonScreen, 'e4')
  assert(cannonTargets.includes('e9'), '炮可以隔着炮架吃子', cannonTargets.join(','))
  assert(
    !cannonTargets.includes('e8'),
    '炮不能停在炮架后面的空格上（这是炮和车的区别）',
    cannonTargets.join(','),
  )
  assert(!cannonTargets.includes('e7'), '炮不能落在炮架所在的格子上', cannonTargets.join(','))
  assert(cannonTargets.includes('e6'), '炮架之前的空格仍可走', cannonTargets.join(','))
  eq(cannonTargets.length, 15, '带炮架时炮共 15 个着法（3 上 + 4 下 + 4 左 + 4 右）', cannonTargets.join(','))

  // 没有炮架：不能吃子，但能走到目标前的空格
  const cannonNoScreen = board([
    '....r.k..', // e9 黑车 · g9 黑将
    '.........',
    '.........',
    '.........',
    '.........',
    '....C....', // e4
    '.........',
    '.........',
    '.........',
    '...K.....', // d0
  ])
  const noScreen = movesFrom(cannonNoScreen, 'e4')
  assert(!noScreen.includes('e9'), '没有炮架时炮不能吃子', noScreen.join(','))
  assert(noScreen.includes('e8'), '没有炮架时炮可以走到目标前的空格', noScreen.join(','))
  eq(noScreen.length, 16, '没有炮架时炮共 16 个着法（4 上 + 4 下 + 4 左 + 4 右）', noScreen.join(','))

  // ================================================================
  console.log('\n【兵卒的行进】')

  // 红兵在 e3（行 6）：尚未过河（红方半场是行 5-9）
  const pawnOwn = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....P....', // e3
      '.........',
      '.........',
      '.........',
    ]),
  )
  const ownMoves = movesFrom(pawnOwn, 'e3')
  eq(ownMoves.length, 1, '兵未过河时只能向前一步', ownMoves.join(','))
  assert(ownMoves.includes('e4'), '且方向是向前（rank 增大）', ownMoves.join(','))

  // 红兵在 e5（行 4）：已过河
  const pawnCrossed = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '....P....', // e5
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  const crossedMoves = movesFrom(pawnCrossed, 'e5')
  eq(crossedMoves.length, 3, '兵过河后可以向前或左右（3 个着法）', crossedMoves.join(','))
  assert(crossedMoves.includes('e6'), '可以向前', crossedMoves.join(','))
  assert(
    crossedMoves.includes('d5') && crossedMoves.includes('f5'),
    '可以左右移动',
    crossedMoves.join(','),
  )
  assert(!crossedMoves.includes('e4'), '过河兵永远不能后退', crossedMoves.join(','))

  // 红兵在 e9（黑方底线）：向前已无路，只能左右
  // 黑将放在 e7（黑方九宫内），避免与兵在同一格
  const pawnEdge = board([
    '....P....', // 9  e9 红兵
    '.........', // 8
    '....k....', // 7  e7 黑将（黑方九宫是行 0-2）
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...K.....', // 0  d0 红帅
  ])
  const edgeMoves = movesFrom(pawnEdge, 'e9')
  eq(edgeMoves.length, 2, '兵到底线后只能左右移动（不能前进也不能后退）', edgeMoves.join(','))
  assert(!edgeMoves.includes('e8'), '不能后退', edgeMoves.join(','))

  // ================================================================
  console.log('\n【将帅照面】')

  const facing = board([
    '....k....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....K....',
  ])
  assert(kingsFacing(facing), '同列且中间无子时判定为将帅照面')
  assert(isInCheck(facing, 'red'), '将帅照面等价于被将军（红方）')
  assert(isInCheck(facing, 'black'), '将帅照面等价于被将军（黑方）')

  // 照面时帅可以**横移**到相邻列来解开（不是无路可走）。
  // 这是个容易被想当然的地方：照面不等于将死，它有解。
  const facingMoves = movesFrom(facing, 'e0')
  eq(facingMoves.length, 2, '照面时帅有两个解：横移到 d 列或 f 列', facingMoves.join(','))
  assert(
    facingMoves.every((name) => name[0] !== 'e'),
    '这两个着法都离开了 e 列（只有离开才能解开照面）',
    facingMoves.join(','),
  )

  const notFacing = board([
    '....k....',
    '.........',
    '.........',
    '.........',
    '....p....', // 中间有子
    '.........',
    '.........',
    '.........',
    '.........',
    '....K....',
  ])
  assert(!kingsFacing(notFacing), '中间有子时不算照面')
  assert(!isInCheck(notFacing, 'red'), '中间有子时红方未被将军')

  // 红帅在 d0、黑将在 e9：帅走到 e 列会造成照面
  const kingAvoidFacing = board(
    withKings([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ]),
  )
  const avoidMoves = movesFrom(kingAvoidFacing, 'd0')
  assert(!avoidMoves.includes('e0'), '帅不能走到与对方将照面的列上', avoidMoves.join(','))
  assert(avoidMoves.includes('d1'), '九宫内其它着法仍然可用', avoidMoves.join(','))
  eq(avoidMoves.length, 1, '所以帅只剩 1 个着法', avoidMoves.join(','))

  // ================================================================
  console.log('\n【不能自送将军（牵制）】')

  // 黑车在 e9、红车在 e4、红帅在 e0：红车被沿 e 列牵制
  const pinned = board([
    '....r....', // 9  e9 黑车
    '.........',
    '.........',
    '.........',
    '.........',
    '....R....', // 4  e4 红车（被牵制）
    '.........',
    '.........',
    '.........',
    '....K....', // 0  e0 红帅
  ])
  const pinnedMoves = movesFrom(pinned, 'e4')
  assert(
    pinnedMoves.every((name) => name[0] === 'e'),
    '被牵制的车只能沿牵制线（e 列）移动',
    pinnedMoves.join(','),
  )
  // e 列上：e5/e6/e7/e8 四个空格 + e9 吃黑车 + e3/e2/e1 三个空格 = 8
  eq(pinnedMoves.length, 8, '被牵制的车沿 e 列有 8 个着法（含吃对方车）', pinnedMoves.join(','))
  assert(pinnedMoves.includes('e9'), '可以吃掉牵制自己的黑车（合法且必要）', pinnedMoves.join(','))

  // ================================================================
  console.log('\n【将死】')

  // 黑将在 e9；红车在 e8 将军；底线两角各一个红车封住左右；
  // a8 的红车守住 e8，让黑将不能吃车
  const mate = board([
    'R...k...R', // 9  a9 红车 · e9 黑将 · i9 红车
    'R...R....', // 8  a8 红车（守 e8） · e8 红车（将军）
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...K.....', // 0  d0 红帅
  ])
  const mateResult = evaluateResult({ board: mate, turn: 'black', history: [] })
  assert(isInCheck(mate, 'black'), '黑方处于被将军状态')
  assert(mateResult.over === true, '黑方无着法可走，对局结束')
  if (mateResult.over) {
    assert(mateResult.winner === 'red', '红方获胜')
    assert(mateResult.reason === 'checkmate', '判定为将死', mateResult.reason)
  }

  // ================================================================
  console.log('\n【困毙（象棋特有：无棋可走判负，不是和棋）】')

  // 黑将没有被将军，但三个可走的格子全被红车控制
  const stalemate = board([
    '....k....', // 9  e9 黑将
    'R........', // 8  a8 红车（控制第 8 行，封住 e8）
    '...R.R...', // 7  d7 与 f7 红车（控制 d 列与 f 列，封住 d9 与 f9）
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...K.....', // 0  d0 红帅
  ])
  const staleResult = evaluateResult({ board: stalemate, turn: 'black', history: [] })
  assert(!isInCheck(stalemate, 'black'), '困毙局面下黑方并未被将军（这是它和将死的区别）')
  assert(staleResult.over === true, '黑方无着法可走，对局结束')
  if (staleResult.over) {
    assert(
      staleResult.winner === 'red',
      '困毙时无棋可走的一方判负（象棋规则，与国际象棋的和棋不同）',
      `胜方 ${staleResult.winner}`,
    )
    assert(staleResult.reason === 'stalemate', '原因标记为 stalemate（困毙）', staleResult.reason)
  }

  // ================================================================
  console.log('\n【开局局面判定】')

  const initialResult = evaluateResult({ board: initialBoard(), turn: 'red', history: [] })
  assert(initialResult.over === false, '开局局面未结束')
  assert(initialResult.inCheck === false, '开局红方未被将军')
  eq(legalMoves(initialBoard(), 'red').length, 44, '开局红方有 44 个合法着法')
  eq(legalMoves(initialBoard(), 'black').length, 44, '开局黑方也有 44 个合法着法（对称）')

  // ================================================================
  console.log('\n【序列化往返】')

  const serialized = serializeBoard(initialBoard())
  eq(
    serialized,
    'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR',
    '开局局面的序列化字符串正确（第 0 行是黑方底线）',
  )
  eq(serializeBoard(deserializeBoard(serialized)), serialized, '序列化再反序列化后完全一致')

  let rejectRows = false
  try {
    deserializeBoard('rnbakabnr/.........')
  } catch {
    rejectRows = true
  }
  assert(rejectRows, '行数不对的棋局字符串被拒绝')

  let rejectPiece = false
  try {
    deserializeBoard(
      'rnbakabnZ/........./........./........./........./........./........./........./........./RNBAKABNR',
    )
  } catch {
    rejectPiece = true
  }
  assert(rejectPiece, '含未知棋子的棋局字符串被拒绝')

  // ================================================================
  console.log('\n【执行着法】')

  const pos = { board: initialBoard(), turn: 'red', history: [] }
  // 炮二平五：红炮从 b2（行 7 列 1）平到 e2（行 7 列 4）
  const firstMove = legalMoves(pos.board, 'red').find(
    (m) => squareName(m.from) === 'b2' && squareName(m.to) === 'e2',
  )
  assert(firstMove !== undefined, '找得到「炮二平五」这类常见开局着法')

  if (firstMove) {
    const after = applyMove(pos, firstMove)
    eq(after.turn, 'black', '走子后轮到黑方')
    eq(after.history.length, 1, '历史记录增加一条')
    eq(
      serializeBoard(after.board),
      'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/....C..C./........./RNBAKABNR',
      '走子后的局面正确（第 7 行的炮从 b 列平到 e 列）',
    )
    eq(
      serializeBoard(pos.board),
      serializeBoard(initialBoard()),
      'applyMove 不修改原局面（不可变语义）',
    )
  }

  eq(squareName(findKing(initialBoard(), 'red')), 'e0', '红帅的坐标是 e0（rank 从底部数）')
  eq(squareName(findKing(initialBoard(), 'black')), 'e9', '黑将的坐标是 e9')
  eq(findKing(initialBoard(), 'red'), parseSquare('e0'), 'parseSquare 与 squareName 互逆')
  eq(findKing(initialBoard(), 'black'), parseSquare('e9'), 'parseSquare 与 squareName 互逆（黑方）')

  // ================================================================
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main()
