/**
 * 象棋机器人（评估 + 搜索）的测试。
 *
 * 这个文件里最要紧的是**第一组：差分测试**。
 *
 * 机器人用的是另一套为速度重写的走法生成与将军判定（见 server/src/games/xiangqi-ai.ts
 * 开头那段说明）。同一套规则的**两份实现**，最怕的就是悄悄分叉 ——
 * 分叉的后果不是"机器人下得臭"，而是"机器人走出规则不允许的着法"，
 * 而那种错误在一盘棋里可能几十步才露一次头。
 *
 * 所以这里不写"手挑几个局面看它对不对"，而是**在随机对局的每个局面逐一比对**：
 * 快实现给出的合法着法集合、将军判定，必须和权威实现（xiangqi.ts，由 perft 校验过）
 * 逐条相同。任何一边改了规则，这组测试立刻变红。
 *
 * 用法：node scripts/xiangqi-ai-test.mjs   （纯逻辑，不需要服务端）
 */

import {
  applyMove,
  deserializeBoard,
  evaluateResult,
  initialBoard,
  isInCheck,
  legalMoves,
  serializeBoard,
} from '../server/src/games/xiangqi.ts'
import {
  chooseMove,
  evaluateFast,
  fromFast,
  genLegalMoves,
  genPseudoMoves,
  inCheckFast,
  moveFrom,
  moveTo,
  positionKey,
  toFast,
} from '../server/src/games/xiangqi-ai.ts'

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

/** 固定种子的伪随机：同一批局面每次都一样，红了就能复现。 */
function makeRandom(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function keyOf(m) {
  return `${m.from}->${m.to}`
}

/** 权威实现的合法着法集合。 */
function legalSet(board, side) {
  return new Set(legalMoves(board, side).map(keyOf))
}

/** 快实现的合法着法集合。 */
function fastLegalSet(board, side) {
  const fast = toFast(board)
  return new Set(genLegalMoves(fast, side === 'red' ? 0 : 1).map((c) => `${moveFrom(c)}->${moveTo(c)}`))
}

// ================================================================ 差分测试

console.log('\n\x1b[1m【差分测试：快实现 vs 权威实现】\x1b[0m')

const random = makeRandom(20261019)
let positionsChecked = 0
let movesCompared = 0
let checkCompared = 0
let legalMismatch = null
let checkMismatch = null

// 随机对局：每一步都用**权威实现**走，所以局面的合法性由权威实现保证
for (let game = 0; game < 40 && !legalMismatch && !checkMismatch; game++) {
  let position = { board: initialBoard(), turn: 'red', history: [] }
  const plies = 6 + Math.floor(random() * 40)

  for (let ply = 0; ply < plies; ply++) {
    const moves = legalMoves(position.board, position.turn)
    if (moves.length === 0) break

    const side = position.turn
    const expected = legalSet(position.board, side)
    const actual = fastLegalSet(position.board, side)
    positionsChecked++
    movesCompared += expected.size

    if (expected.size !== actual.size) {
      legalMismatch = `着法数不同：权威 ${expected.size} / 快实现 ${actual.size}｜局面 ${serializeBoard(position.board)} 轮到 ${side}`
    } else {
      for (const key of expected) {
        if (!actual.has(key)) {
          legalMismatch = `快实现缺少着法 ${key}｜局面 ${serializeBoard(position.board)} 轮到 ${side}`
          break
        }
      }
    }

    const fast = toFast(position.board)
    const expectedCheck = isInCheck(position.board, side)
    const actualCheck = inCheckFast(fast, side === 'red' ? 0 : 1)
    checkCompared++
    if (expectedCheck !== actualCheck) {
      checkMismatch = `将军判定不同：权威 ${expectedCheck} / 快实现 ${actualCheck}｜局面 ${serializeBoard(position.board)} 轮到 ${side}`
    }
    if (legalMismatch || checkMismatch) break

    position = applyMove(position, moves[Math.floor(random() * moves.length)])
  }
}

assert(positionsChecked > 100, '随机局面样本量足够', `${positionsChecked} 个局面 / 累计 ${movesCompared} 条着法`)
assert(legalMismatch === null, '合法着法集合与权威实现逐条一致', legalMismatch ?? '')
assert(checkMismatch === null, '将军判定与权威实现逐条一致', checkMismatch ?? '')
assert(checkCompared === positionsChecked, '每个局面都比对过将军判定', `${checkCompared} / ${positionsChecked}`)

// 伪着法也要覆盖：静态搜索直接用它，而它不做"自送将军"过滤
{
  const position = { board: initialBoard(), turn: 'red', history: [] }
  const fast = toFast(position.board)
  const pseudo = []
  genPseudoMoves(fast, 0, pseudo)
  const pseudoSet = new Set(pseudo.map((c) => `${moveFrom(c)}->${moveTo(c)}`))
  const missing = legalMoves(position.board, 'red').filter((m) => !pseudoSet.has(keyOf(m)))
  assert(missing.length === 0, '开局所有合法着法都出现在伪着法里', `缺 ${missing.length} 条`)
  assert(pseudo.length >= 44, '伪着法数量不少于合法着法数（44）', `${pseudo.length} 条`)
}

// 评估函数的符号：红方多一个车，分数必须站在红方这边
{
  const board = initialBoard()
  board[8] = null // 去掉黑方一个车（row 0, col 8）
  assert(evaluateFast(toFast(board)) > 0, '红方多子时评估分为正（符号没搞反）')

  const board2 = initialBoard()
  board2[9 * 9 + 8] = null // 去掉红方一个车
  assert(evaluateFast(toFast(board2)) < 0, '红方少子时评估分为负')
}

// 棋盘 → 快盘 → 棋盘 来回转换不能丢子
{
  const board = initialBoard()
  assert(serializeBoard(fromFast(toFast(board))) === serializeBoard(board), '棋盘往返转换不改变局面')
}

// ================================================================ 棋力

console.log('\n\x1b[1m【棋力：该杀的要杀，该吃的要吃】\x1b[0m')

/**
 * 一步杀的局面（自己摆的，逐条说明为什么它确实是一步杀）：
 *
 *   row0  '4k4'   黑将 e9
 *   row2  '2N3N2' 红马 c7、g7 —— 两只马一起把 d9、f9、e8 三格全封死
 *   row4  '4p4'   黑卒 e5 —— 它挡在 e 线上，所以红车在 e1 时**不构成将军**（局面合法）
 *   row8  '4R4'   红车 e1
 *   row9  '3K5'   红帅 d0（不在 e 线，避免和黑将照面）
 *
 * 红走 车 e1×e5：吃掉挡路的卒，同时沿 e 线将军。
 * 黑方只剩一个将，且 d9 / f9 / e8 全被红马控制 → 将死。
 */
const MATE_IN_ONE = '....k..../........./..N...N../........./....p..../........./........./........./....R..../...K.....'

{
  const board = deserializeBoard(MATE_IN_ONE)
  const mates = legalMoves(board, 'red').filter((m) => {
    const next = applyMove({ board, turn: 'red', history: [] }, m)
    const verdict = evaluateResult(next)
    return verdict.over && verdict.reason === 'checkmate'
  })
  assert(mates.length > 0, '测试前提：这个局面里确实存在一步杀', `${mates.length} 步可杀：${mates.map(keyOf).join(', ')}`)

  // 三档都要验：简单档有 25% 的"故意乱走"，但**送到嘴边的一步杀不许放掉** ——
  // 那是最容易被用户当场发现的那种蠢，所以代码里专门给它开了后门（见 chooseMove）
  for (const level of ['easy', 'normal', 'hard']) {
    const choice = chooseMove({ board, side: 'red', level, seed: 7 })
    assert(choice !== null, `${level} 档在一步杀的局面里给出了着法`)
    if (choice) {
      assert(
        mates.some((m) => m.from === choice.from && m.to === choice.to),
        `${level} 档选中了一步杀（没有放过送到嘴边的杀棋）`,
        `走了 ${choice.from}->${choice.to}，可杀的是 ${mates.map(keyOf).join(', ')}`,
      )
    }
  }
}

/**
 * 白吃一个车：红车 a0 对着黑车 a9（无人保护）。
 * 好棋只有一步 —— 吃掉它。评估函数只认子力，所以这里验的是
 * "评估 + 搜索"这一整条链路能不能把送到嘴边的子吃掉。
 */
{
  const board = deserializeBoard('r...k..../........./........./........./........./........./........./........./........./R..K.....')
  // 红车在 a0（内部格号 81）、黑车在 a9（格号 0）
  const hangRook = legalMoves(board, 'red').some((m) => m.from === 81 && m.to === 0)
  assert(hangRook, '测试前提：黑车确实无保护地摆在红车面前')

  // 用困难档：这一组验的是"评估 + 搜索"，不该被"故意乱走"干扰
  const choice = chooseMove({ board, side: 'red', level: 'hard', seed: 3 })
  assert(choice !== null, '白吃车的局面里机器人给出了着法')
  if (choice) {
    assert(
      choice.from === 81 && choice.to === 0,
      '机器人吃掉了白送的车（子力评估生效）',
      `走了 ${choice.from}->${choice.to}`,
    )
  }
}

/** 被将军时必须应将：不能走出"假装无事发生"的着法。 */
{
  const board = deserializeBoard('....k..../........./........./........./........./........./........./........./....R..../....K....') // 红车 e1 正将军黑将 e9
  const inCheck = isInCheck(board, 'black')
  assert(inCheck, '测试前提：黑方确实被将军')

  const choice = chooseMove({ board, side: 'black', level: 'easy', seed: 5, timeMs: 200 })
  assert(choice !== null, '被将军时机器人给出了着法')
  if (choice) {
    const move = legalMoves(board, 'black').find((m) => m.from === choice.from && m.to === choice.to)
    assert(move !== undefined, '被将军时走的是合法着法', keyOf(choice))
    if (move) {
      const next = applyMove({ board, turn: 'black', history: [] }, move)
      assert(!isInCheck(next.board, 'black'), '走完之后自己不再被将军（真的应了将）', keyOf(choice))
    }
  }
}

// ================================================================ 性能与稳定性

console.log('\n\x1b[1m【性能与稳定性】\x1b[0m')

for (const level of ['easy', 'normal', 'hard']) {
  const board = initialBoard()
  const started = Date.now()
  const choice = chooseMove({ board, side: 'red', level, seed: 20261019 })
  const elapsed = Date.now() - started
  const legal = legalSet(board, 'red')
  assert(choice !== null, `${level} 档在开局给出了着法`, `${elapsed}ms / 深度 ${choice?.depth} / ${choice?.nodes} 节点`)
  assert(
    choice !== null && legal.has(keyOf(choice)),
    `${level} 档给出的着法合法`,
    choice ? keyOf(choice) : '',
  )
  // 时间上限是硬约束：这台 NAS 是 4 核 8G，还要同时服务别人
  const budget = level === 'easy' ? 900 : level === 'normal' ? 1800 : 3500
  assert(elapsed < budget, `${level} 档在时间预算内返回`, `${elapsed}ms（上限 ${budget}ms）`)
}

// 确定性：同一个种子必须给出同一着法，否则测试不可复现
{
  const a = chooseMove({ board: initialBoard(), side: 'red', level: 'normal', seed: 42 })
  const b = chooseMove({ board: initialBoard(), side: 'red', level: 'normal', seed: 42 })
  assert(
    a && b && a.from === b.from && a.to === b.to,
    '同种子同局面 → 同一着法（可复现）',
    a && b ? `${keyOf(a)} vs ${keyOf(b)}` : '',
  )
}

// 自对弈冒烟：连下若干手，每一手都必须合法，且不能卡死
{
  let position = { board: initialBoard(), turn: 'red', history: [] }
  const seen = []
  let illegal = null
  let plies = 0
  let ended = null
  const started = Date.now()

  for (let i = 0; i < 30; i++) {
    const moves = legalMoves(position.board, position.turn)
    if (moves.length === 0) break
    const legal = new Set(moves.map(keyOf))
    const choice = chooseMove({
      board: position.board,
      side: position.turn,
      level: 'easy',
      seed: 1000 + i,
      seenKeys: seen,
      timeMs: 250,
    })
    if (!choice) break
    if (!legal.has(keyOf(choice))) {
      illegal = `第 ${i + 1} 手 ${keyOf(choice)} 不合法（局面 ${serializeBoard(position.board)}）`
      break
    }
    position = applyMove(
      position,
      moves.find((m) => m.from === choice.from && m.to === choice.to),
    )
    seen.push(positionKey(position.board, position.turn))
    plies++
    const verdict = evaluateResult(position)
    if (verdict.over) {
      ended = verdict.reason
      break
    }
  }

  const elapsed = Date.now() - started
  assert(illegal === null, '自对弈 30 手里没有非法着法', illegal ?? '')
  assert(plies >= 20, '自对弈能持续推进（没有中途卡死）', `${plies} 手 / ${elapsed}ms${ended ? ` / 以${ended}结束` : ''}`)
  assert(elapsed < 30000, '自对弈总耗时在合理范围', `${elapsed}ms`)
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
