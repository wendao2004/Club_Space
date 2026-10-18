/**
 * 斗地主规则引擎测试。
 *
 * 牌型识别是这类游戏的命脉：判错一个边界情况（例如顺子里混进了 2、
 * 或者把 333444 判成了别的东西），整局游戏就错了，而且很难查。
 * 所以这里对**每个牌型都写了正例与反例**，比较规则逐条断言。
 *
 * 用法：node scripts/doudizhu-test.mjs
 */

import {
  canBeat,
  createDeck,
  deal,
  findPlays,
  handContains,
  parseCombo,
  shuffle,
  sortCards,
} from '../server/src/games/doudizhu.ts'

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

/** 用 rank 列表造牌（花色不重要，大小只看 rank）。 */
let fakeId = 1000
function cards(...ranks) {
  return ranks.map((rank) => ({
    id: fakeId++,
    rank,
    label: String(rank),
    suit: 'spade',
  }))
}

/** 断言某组牌被识别为指定牌型。 */
function expectType(ranks, type, name) {
  const combo = parseCombo(cards(...ranks))
  assert(combo?.type === type, name, combo ? `识别为 ${combo.type}` : '识别为非法牌型')
}

/** 断言某组牌不是合法牌型。 */
function expectInvalid(ranks, name) {
  const combo = parseCombo(cards(...ranks))
  assert(combo === null, name, combo ? `竟然识别为 ${combo.type}` : '')
}

console.log('\n\x1b[1m斗地主规则引擎测试\x1b[0m\n')

// ================================================================
console.log('【牌与发牌】')

const deck = createDeck()
eq(deck.length, 54, '一副牌 54 张')
eq(new Set(deck.map((c) => c.id)).size, 54, '每张牌的 id 唯一')
eq(deck.filter((c) => c.rank <= 15).length, 52, '普通牌 52 张（13 个点数 × 4 花色）')
eq(deck.filter((c) => c.rank === 16 || c.rank === 17).length, 2, '大小王各一张')
for (let rank = 3; rank <= 15; rank++) {
  eq(deck.filter((c) => c.rank === rank).length, 4, `rank=${rank} 有 4 张`)
}

const dealt = deal(deck)
eq(dealt.hands[0].length, 17, '第一家 17 张')
eq(dealt.hands[1].length, 17, '第二家 17 张')
eq(dealt.hands[2].length, 17, '第三家 17 张')
eq(dealt.bottom.length, 3, '底牌 3 张')
const allDealt = [...dealt.hands.flat(), ...dealt.bottom]
eq(new Set(allDealt.map((c) => c.id)).size, 54, '发出去之后 54 张牌无重复无遗漏')

// 洗牌可复现
const shuffled1 = shuffle(deck, 12345).map((c) => c.id)
const shuffled2 = shuffle(deck, 12345).map((c) => c.id)
const shuffled3 = shuffle(deck, 99999).map((c) => c.id)
assert(JSON.stringify(shuffled1) === JSON.stringify(shuffled2), '同一个种子洗出同样的顺序（可复现，便于测试与复盘）')
assert(JSON.stringify(shuffled1) !== JSON.stringify(shuffled3), '不同种子洗出不同顺序')
assert(new Set(shuffled1).size === 54, '洗牌不丢牌')

const sorted = sortCards(cards(3, 17, 10, 15, 4))
eq(sorted[0].rank, 17, '排序后最大的在最前（大王）')
eq(sorted[sorted.length - 1].rank, 3, '最小的在最后')

// ================================================================
console.log('\n【基础牌型】')

expectType([5], 'single', '单张')
expectType([17], 'single', '单张（大王）')
expectType([7, 7], 'pair', '对子')
expectType([15, 15], 'pair', '对 2')
expectType([9, 9, 9], 'triplet', '三张')

expectInvalid([5, 6], '两张不同点数是非法牌型')
expectInvalid([5, 5, 6], '对子加单张是非法牌型（不是三带一）')
expectInvalid([], '空牌是非法牌型')

// ================================================================
console.log('\n【三带】')

expectType([9, 9, 9, 3], 'triplet-single', '三带一')
expectType([9, 9, 9, 15], 'triplet-single', '三带一（带 2 也可以）')
expectType([9, 9, 9, 3, 3], 'triplet-pair', '三带二')

expectInvalid([9, 9, 9, 4, 4, 4], '两组三张不是三带（那是飞机）')
expectInvalid([9, 9, 9, 3, 4], '三带两单张是非法牌型（要么带一要么带一对）')

// 三带一对里的对子必须真的是对
const tripletPairWrong = parseCombo(cards(9, 9, 9, 3, 4))
eq(tripletPairWrong, null, '三张 + 两张不同点数 → 非法')

// ================================================================
console.log('\n【顺子】')

expectType([3, 4, 5, 6, 7], 'straight', '最小的顺子（3-7）')
expectType([10, 11, 12, 13, 14], 'straight', '最大的顺子（10-A）')
expectType([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'straight', '最长的顺子（3-A，12 张）')

// 这是最常见的写错点：2 和王不能进顺子
expectInvalid([11, 12, 13, 14, 15], '顺子不能包含 2')
expectInvalid([12, 13, 14, 15, 16], '顺子不能包含 2 与王')
expectInvalid([13, 14, 15, 16, 17], '顺子不能包含王')
expectInvalid([3, 4, 5, 6], '顺子至少 5 张')
expectInvalid([3, 4, 5, 6, 8], '顺子必须连续（3-6-8 有断档）')
expectInvalid([3, 3, 4, 5, 6], '顺子里不能有重复点数')

// ================================================================
console.log('\n【连对】')

expectType([3, 3, 4, 4, 5, 5], 'straight-pair', '最小的连对（33 44 55）')
expectType([10, 10, 11, 11, 12, 12, 13, 13], 'straight-pair', '四连对')
expectType([12, 12, 13, 13, 14, 14], 'straight-pair', '连对可以到 A（QQ KK AA）')

// 和顺子一样：连对不能包含 2（这是最容易被写错的地方之一）
expectInvalid([13, 13, 14, 14, 15, 15], '连对不能包含 2（KK AA 22 不合法）')

expectInvalid([3, 3, 4, 4], '连对至少 3 对')
expectInvalid([3, 3, 4, 4, 6, 6], '连对必须连续（33 44 66 有断档）')
expectInvalid([3, 3, 4, 5, 5, 6], '连对里每对必须真的是对')

// ================================================================
console.log('\n【炸弹与王炸】')

expectType([8, 8, 8, 8], 'bomb', '炸弹')
expectType([15, 15, 15, 15], 'bomb', '四个 2 也是炸弹（不比别的炸弹大）')
expectType([16, 17], 'rocket', '王炸')

expectInvalid([16, 16], '两个小王不存在（一副牌只有一个）')
expectInvalid([8, 8, 8, 8, 8], '五张相同点数不存在（一副牌只有四张）')

// ================================================================
console.log('\n【四带二】')

expectType([8, 8, 8, 8, 3, 4], 'four-two-single', '四带两单')
expectType([8, 8, 8, 8, 3, 3], 'four-two-single', '四带两张（碰巧是一对，仍按四带二算）')
expectType([8, 8, 8, 8, 3, 3, 4, 4], 'four-two-pair', '四带两对')

expectInvalid([8, 8, 8, 8, 3], '四带一不是合法牌型')
expectInvalid([8, 8, 8, 8, 3, 3, 4], '四带两对少一张不合法')

// ================================================================
console.log('\n【飞机】')

expectType([3, 3, 3, 4, 4, 4], 'plane', '纯飞机（333 444）')
expectType([3, 3, 3, 4, 4, 4, 5, 5, 5], 'plane', '三连飞机（333 444 555）')
expectType([3, 3, 3, 4, 4, 4, 6, 8], 'plane-single', '飞机带两个单张')
expectType([3, 3, 3, 4, 4, 4, 6, 6, 7, 7], 'plane-pair', '飞机带两对')
expectType([13, 13, 13, 14, 14, 14], 'plane', '飞机可以是 KKK AAA')

expectInvalid([3, 3, 3, 5, 5, 5], '飞机必须连续（333 555 有断档）')
expectInvalid([3, 3, 3, 4, 4, 4, 6], '飞机带一个单张不合法（要带就得每个三张配一张）')

// 这是最容易搞错的一条：飞机不能包含 2
expectInvalid([14, 14, 14, 15, 15, 15], '飞机不能包含 2（AAA 222 不合法）')

// ================================================================
console.log('\n【比大小】')

function combo(...ranks) {
  const parsed = parseCombo(cards(...ranks))
  if (!parsed) throw new Error(`测试写错了：${ranks.join(',')} 不是合法牌型`)
  return parsed
}

// 首出
assert(canBeat(combo(3), null), '本轮首出：任何合法牌型都可以')

// 同型比大小
assert(canBeat(combo(9), combo(5)), '单张 9 能压单张 5')
assert(!canBeat(combo(5), combo(9)), '单张 5 压不过单张 9')
assert(!canBeat(combo(5), combo(5)), '同点数的单张压不过（必须更大）')
assert(canBeat(combo(9, 9), combo(5, 5)), '对子 99 能压 55')
assert(canBeat(combo(9, 9, 9, 3), combo(5, 5, 5, 4)), '三带一比三张的大小')

// 不同类型不能互相压
assert(!canBeat(combo(9, 9), combo(5)), '对子压不过单张')
assert(!canBeat(combo(9), combo(5, 5)), '单张压不过对子')
assert(!canBeat(combo(9, 9, 9), combo(9, 9)), '三张压不过对子')

// 顺子必须长度一致
assert(canBeat(combo(4, 5, 6, 7, 8), combo(3, 4, 5, 6, 7)), '同长度顺子比大小')
assert(!canBeat(combo(4, 5, 6, 7, 8, 9), combo(3, 4, 5, 6, 7)), '长度不同的顺子不能互相压')

// 炸弹
assert(canBeat(combo(3, 3, 3, 3), combo(15)), '炸弹能压单张 2')
assert(canBeat(combo(3, 3, 3, 3), combo(14, 13, 12, 11, 10)), '炸弹能压顺子')
assert(canBeat(combo(9, 9, 9, 9), combo(3, 3, 3, 3)), '大炸弹压小炸弹')
assert(!canBeat(combo(3, 3, 3, 3), combo(9, 9, 9, 9)), '小炸弹压不过大炸弹')

// 王炸
assert(canBeat(combo(16, 17), combo(15, 15, 15, 15)), '王炸压四个 2')
assert(canBeat(combo(16, 17), combo(3, 3, 3, 3)), '王炸压炸弹')
assert(!canBeat(combo(15, 15, 15, 15), combo(16, 17)), '炸弹压不过王炸')
assert(!canBeat(combo(3, 3, 3, 3), combo(16, 17)), '任何炸弹都压不过王炸')

// 三带二的比较
assert(canBeat(combo(9, 9, 9, 3, 3), combo(5, 5, 5, 4, 4)), '三带二比三张的大小')
assert(!canBeat(combo(9, 9, 9, 3, 3), combo(5, 5, 5, 4)), '三带二压不过三带一（类型不同）')

// ================================================================
console.log('\n【出牌提示】')

const hand = cards(3, 4, 5, 6, 7, 9, 9, 13, 13, 13, 15, 16, 17)

const hintsSingle = findPlays(hand, combo(5))
assert(hintsSingle.length > 0, '能提示出可以压过单张 5 的牌', `${hintsSingle.length} 种`)
assert(
  hintsSingle.every((c) => canBeat(c, combo(5))),
  '提示出来的每一手都能压过对方',
)

const hintsNone = findPlays(cards(3, 4), combo(17))
assert(hintsNone.length === 0, '手里没有能压过大王的牌时提示为空')

const hintsRocket = findPlays(cards(16, 17, 3), combo(15, 15, 15, 15))
assert(
  hintsRocket.some((c) => c.type === 'rocket'),
  '对方出四个 2 时，提示里有王炸',
)

const hintsBomb = findPlays(cards(3, 3, 3, 3, 5), combo(14))
assert(
  hintsBomb.some((c) => c.type === 'bomb'),
  '对方出单张 A 时，提示里有炸弹',
)

// 提示要优先给"省牌"的选项：炸弹/王炸排在普通牌型之后
const mixed = findPlays(cards(3, 3, 3, 3, 16, 17, 9), combo(5), 10)
if (mixed.length >= 2) {
  const firstBombIndex = mixed.findIndex((c) => c.type === 'bomb' || c.type === 'rocket')
  const firstNormalIndex = mixed.findIndex((c) => c.type !== 'bomb' && c.type !== 'rocket')
  assert(
    firstNormalIndex === -1 || firstBombIndex === -1 || firstNormalIndex < firstBombIndex,
    '提示里普通牌型排在炸弹之前（别一上来就让人炸）',
    mixed.map((c) => c.type).join(','),
  )
}

// ================================================================
console.log('\n【手牌校验（防伪造）】')

const owned = cards(3, 4, 5)
assert(handContains(owned, [owned[0]]), '手里的牌能被校验通过')
const foreign = cards(99)
assert(!handContains(owned, [foreign[0]]), '不在手里的牌被拒绝（客户端伪造出牌会被挡住）')
assert(!handContains(owned, [...owned, foreign[0]]), '部分不在手里也会被拒绝')

// ================================================================
console.log('\n【综合：一局模拟】')

// 用固定种子发牌，然后每轮用 findPlays 选一手最小的合法出法，
// 一直出到某一方手牌清空。这能顺带验证"提示出来的牌确实在手里"。
const gameDeck = shuffle(createDeck(), 20261017)
const { hands } = deal(gameDeck)
const players = [sortCards(hands[0]), sortCards(hands[1]), sortCards(hands[2])]

let plies = 0
let illegal = 0
let notInHand = 0
let lastCombo = null
let current = 0
let passes = 0
const MAX_PLIES = 400

while (plies < MAX_PLIES && players.every((h) => h.length > 0) && passes < 3) {
  const hand = players[current]
  const options = findPlays(hand, lastCombo, 1)
  if (options.length === 0) {
    // 要不起
    passes++
    current = (current + 1) % 3
    if (passes >= 2) lastCombo = null // 两家都过，轮到出牌方重新首出
    continue
  }

  const play = options[0]
  // 断言：提示出的牌确实在手里
  if (!handContains(hand, play.cards)) notInHand++
  // 断言：确实是合法牌型且能压过上一手
  const reParsed = parseCombo(play.cards)
  if (!reParsed || !canBeat(reParsed, lastCombo)) illegal++

  // 从手里移除
  const ids = new Set(play.cards.map((c) => c.id))
  players[current] = hand.filter((c) => !ids.has(c.id))

  lastCombo = reParsed
  passes = 0
  plies++
  current = (current + 1) % 3
}

assert(plies > 5, '模拟对局走了 5 手以上', `${plies} 手`)
eq(notInHand, 0, '模拟过程中提示的牌始终在手里')
eq(illegal, 0, '模拟过程中出的牌始终合法且能压过上一手')
assert(
  players.some((h) => h.length === 0) || plies >= MAX_PLIES || passes >= 3,
  '模拟能正常终止（有人出完 / 到达上限 / 连续要不起）',
  `剩余手牌 ${players.map((h) => h.length).join('/')}`,
)

console.log(
  `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
)
process.exit(failed === 0 ? 0 : 1)
