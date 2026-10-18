/**
 * 斗地主规则引擎。
 *
 * 和象棋一样自研，理由也一样：上游库的版本线无法核实，而"牌型判得对不对"
 * 是这类游戏的命脉。而且斗地主的**牌型识别**有一套边界情况（顺子不能含 2、
 * 飞机带翅膀、四带二的两种形态），自己写清楚比查证一个陌生库更快。
 *
 * 正确性怎么保证：见 scripts/doudizhu-test.mjs —— 每个牌型都有正例与反例，
 * 比较规则（炸弹压一切、王炸最大、同型比大小）逐条断言。
 *
 * ============================================================================
 * 牌面表示
 * ============================================================================
 * 花色只影响发牌，不影响大小。大小只由 rank 决定：
 *   3,4,5,6,7,8,9,10 = 3..10
 *   J=11  Q=12  K=13  A=14  2=15
 *   小王=16  大王=17
 *
 * 顺子只在 3..A（5..14）之间成立 —— **2 和王不能进顺子**，这是最常见的写错点。
 */

export type Suit = 'spade' | 'heart' | 'club' | 'diamond' | 'joker'

export interface Card {
  /** 唯一 id，用于前端跟踪选中的牌。 */
  id: number
  /** 大小值，见上面的映射。 */
  rank: number
  /** 显示用的牌面，例如 "3"、"10"、"J"、"小王"。 */
  label: string
  suit: Suit
}

export const RANK_LABELS: Record<number, string> = {
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '2',
  16: '小王',
  17: '大王',
}

/** 顺子的最大 rank（A）。2 与王不能进顺子。 */
export const STRAIGHT_MAX = 14
/** 顺子的最小长度。 */
export const STRAIGHT_MIN_LENGTH = 5
/** 连对的最小对数。 */
export const STRAIGHT_PAIR_MIN = 3

const NORMAL_SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']

let nextCardId = 1

/** 生成一副 54 张的牌。 */
export function createDeck(): Card[] {
  nextCardId = 1
  const deck: Card[] = []
  for (let rank = 3; rank <= 15; rank++) {
    for (const suit of NORMAL_SUITS) {
      deck.push({ id: nextCardId++, rank, label: RANK_LABELS[rank]!, suit })
    }
  }
  deck.push({ id: nextCardId++, rank: 16, label: '小王', suit: 'joker' })
  deck.push({ id: nextCardId++, rank: 17, label: '大王', suit: 'joker' })
  return deck
}

/**
 * 洗牌。
 *
 * 接受一个可选种子，让它**可复现** —— 测试与复盘都需要"同样的种子出同样的牌"。
 * 用 mulberry32 而不是 Math.random：后者无法播种，导致测试里"偶尔失败"。
 */
export function shuffle(deck: Card[], seed: number): Card[] {
  const result = [...deck]
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = result[i]!
    result[i] = result[j]!
    result[j] = tmp
  }
  return result
}

export interface DealResult {
  hands: [Card[], Card[], Card[]]
  /** 三张底牌。 */
  bottom: Card[]
}

/** 发牌：三家各 17 张，留 3 张底牌。 */
export function deal(deck: Card[]): DealResult {
  if (deck.length !== 54) throw new Error(`一副牌应有 54 张，收到 ${deck.length} 张`)
  const hands: [Card[], Card[], Card[]] = [[], [], []]
  for (let i = 0; i < 51; i++) {
    hands[i % 3]!.push(deck[i]!)
  }
  return { hands, bottom: deck.slice(51) }
}

/** 把一手牌按大小从大到小排好（前端展示用）。 */
export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank || a.suit.localeCompare(b.suit))
}

// ============================================================================
// 牌型识别
// ============================================================================

export type ComboType =
  | 'single'
  | 'pair'
  | 'triplet'
  | 'triplet-single'
  | 'triplet-pair'
  | 'straight'
  | 'straight-pair'
  | 'plane'
  | 'plane-single'
  | 'plane-pair'
  | 'four-two-single'
  | 'four-two-pair'
  | 'bomb'
  | 'rocket'

export const COMBO_LABELS: Record<ComboType, string> = {
  single: '单张',
  pair: '对子',
  triplet: '三张',
  'triplet-single': '三带一',
  'triplet-pair': '三带二',
  straight: '顺子',
  'straight-pair': '连对',
  plane: '飞机',
  'plane-single': '飞机带单',
  'plane-pair': '飞机带对',
  'four-two-single': '四带二',
  'four-two-pair': '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
}

export interface Combo {
  type: ComboType
  /** 用于比大小的主牌 rank。 */
  rank: number
  /** 顺子/连对/飞机的长度（张数或对数），其它为 1。 */
  length: number
  cards: Card[]
}

/** 按 rank 统计张数。 */
function countByRank(cards: Card[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1)
  }
  return counts
}

/** 是否是从 start 开始、长度 length 的连续段（且不越过 A）。 */
function isConsecutive(ranks: number[], minLength: number): boolean {
  if (ranks.length < minLength) return false
  const sorted = [...ranks].sort((a, b) => a - b)
  // 顺子类牌型不能包含 2 与王
  if (sorted[sorted.length - 1]! > STRAIGHT_MAX) return false
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1) return false
  }
  return true
}

/**
 * 识别牌型。
 *
 * 返回 null 表示这不是一手合法牌。
 *
 * **匹配顺序是有讲究的**：先按张数分流，再在每种张数下按"越特殊越优先"判断。
 * 例如 6 张牌可能是顺子、连对、飞机、四带二 —— 它们的统计特征互斥
 * （顺子全是单张、连对全是两张、飞机含三个连号的三张、四带二含四张），
 * 所以按特征判断不会歧义。
 */
export function parseCombo(cards: Card[]): Combo | null {
  const n = cards.length
  if (n === 0) return null

  const counts = countByRank(cards)
  const entries = [...counts.entries()] // [rank, count][]
  const ranks = entries.map(([r]) => r)
  const byCount = (c: number) => entries.filter(([, v]) => v === c).map(([r]) => r).sort((a, b) => a - b)

  // 一副牌里大小王各只有一张，所以"两张同款王"在物理上不可能存在。
  // 引擎只按点数判断，不做这个检查就会把 [小王,小王] 当成对子收下 ——
  // 客户端伪造出牌时这正是会被利用的缝隙。
  for (const [rank, count] of entries) {
    if (rank >= 16 && count > 1) return null
  }

  // ---- 王炸 ----
  if (n === 2 && counts.has(16) && counts.has(17)) {
    return { type: 'rocket', rank: 17, length: 1, cards }
  }

  // ---- 炸弹 ----
  if (n === 4 && entries.length === 1) {
    return { type: 'bomb', rank: ranks[0]!, length: 1, cards }
  }

  // ---- 单张 / 对子 / 三张 ----
  if (n === 1) return { type: 'single', rank: ranks[0]!, length: 1, cards }
  if (n === 2 && entries.length === 1) return { type: 'pair', rank: ranks[0]!, length: 1, cards }
  if (n === 3 && entries.length === 1) return { type: 'triplet', rank: ranks[0]!, length: 1, cards }

  // ---- 三带一 / 三带二 ----
  if (n === 4) {
    const triples = byCount(3)
    if (triples.length === 1) return { type: 'triplet-single', rank: triples[0]!, length: 1, cards }
  }
  if (n === 5) {
    const triples = byCount(3)
    const pairs = byCount(2)
    if (triples.length === 1 && pairs.length === 1) {
      return { type: 'triplet-pair', rank: triples[0]!, length: 1, cards }
    }
  }

  // ---- 顺子（全是单张、连续、至少 5 张、不含 2 与王）----
  if (entries.length === n && n >= STRAIGHT_MIN_LENGTH && isConsecutive(ranks, STRAIGHT_MIN_LENGTH)) {
    return { type: 'straight', rank: Math.max(...ranks), length: n, cards }
  }

  // ---- 连对（全是两张、连续、至少 3 对）----
  if (n >= STRAIGHT_PAIR_MIN * 2 && n % 2 === 0 && entries.length === n / 2 && byCount(2).length === entries.length) {
    if (isConsecutive(ranks, STRAIGHT_PAIR_MIN)) {
      return { type: 'straight-pair', rank: Math.max(...ranks), length: entries.length, cards }
    }
  }

  // ---- 四带二 / 四带两对 ----
  const fours = byCount(4)
  if (fours.length === 1) {
    const four = fours[0]!
    // 四带两单：6 张。注意"两单"允许碰巧是一对（8888+33 只有 2 个不同点数），
    // 所以这里不能要求 entries.length === 3。
    if (n === 6 && (entries.length === 2 || entries.length === 3)) {
      return { type: 'four-two-single', rank: four, length: 1, cards }
    }
    // 四带两对：8 张，另外四张恰好是两对
    if (n === 8 && byCount(2).length === 2 && entries.length === 3) {
      return { type: 'four-two-pair', rank: four, length: 1, cards }
    }
  }

  // ---- 飞机（连续的三张，可带单或带对）----
  const tripleRanks = byCount(3).sort((a, b) => a - b)
  if (tripleRanks.length >= 2) {
    // 找出最长的连续三张段
    for (let len = tripleRanks.length; len >= 2; len--) {
      for (let start = 0; start + len <= tripleRanks.length; start++) {
        const segment = tripleRanks.slice(start, start + len)
        if (!isConsecutive(segment, 2)) continue
        const bodyCards = 3 * len

        // 纯飞机
        if (n === bodyCards && entries.length === len) {
          return { type: 'plane', rank: Math.max(...segment), length: len, cards }
        }
        // 飞机带单：每个三张配一张单牌
        if (n === bodyCards + len) {
          // 翅膀不能含 2 与王？规则上多数允许，这里允许（只要求张数对）
          const wingCounts = entries.filter(([r]) => !segment.includes(r))
          const wingCards = wingCounts.reduce((sum, [, c]) => sum + c, 0)
          if (wingCards === len) {
            return { type: 'plane-single', rank: Math.max(...segment), length: len, cards }
          }
        }
        // 飞机带对：每个三张配一对
        if (n === bodyCards + len * 2) {
          const wingEntries = entries.filter(([r]) => !segment.includes(r))
          const wingCards = wingEntries.reduce((sum, [, c]) => sum + c, 0)
          const allWingsArePairs = wingEntries.every(([, c]) => c === 2 || c === 4)
          if (wingCards === len * 2 && allWingsArePairs) {
            return { type: 'plane-pair', rank: Math.max(...segment), length: len, cards }
          }
        }
      }
    }
  }

  return null
}

// ============================================================================
// 比大小
// ============================================================================

/**
 * combo 能否压过 prev。
 *
 * 规则：
 *   - prev 为 null（本轮首出）→ 任何合法牌型都可以
 *   - 王炸压一切
 *   - 炸弹压除王炸与更大炸弹之外的一切
 *   - 同类型同长度 → 比主牌大小
 *   - 其余情况不能压
 */
export function canBeat(combo: Combo, prev: Combo | null): boolean {
  if (!prev) return true
  if (combo.type === 'rocket') return true
  if (prev.type === 'rocket') return false

  if (combo.type === 'bomb') {
    if (prev.type !== 'bomb') return true
    return combo.rank > prev.rank
  }
  if (prev.type === 'bomb') return false

  if (combo.type !== prev.type) return false
  // 顺子/连对/飞机必须长度一致才能比
  if (combo.length !== prev.length) return false
  return combo.rank > prev.rank
}

/**
 * 给一手牌找可以压过 prev 的出法（前端"提示"按钮用）。
 *
 * 实现策略是**穷举候选组合再筛**，而不是写一套精巧的启发式：
 * 一手牌最多 20 张，候选组合的数量在可接受范围内，而穷举不会漏。
 * 优先返回"最省"的那一手（同类型里最小的），把大牌留给后面。
 */
export function findPlays(hand: Card[], prev: Combo | null, limit = 5): Combo[] {
  const candidates: Combo[] = []
  const sorted = sortCards(hand)

  // 按 rank 分组
  const byRank = new Map<number, Card[]>()
  for (const card of sorted) {
    const list = byRank.get(card.rank) ?? []
    list.push(card)
    byRank.set(card.rank, list)
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b)

  const take = (rank: number, count: number): Card[] => (byRank.get(rank) ?? []).slice(0, count)
  const push = (cards: Card[]) => {
    const combo = parseCombo(cards)
    if (combo && canBeat(combo, prev)) candidates.push(combo)
  }

  // 单张 / 对子 / 三张 / 炸弹
  for (const rank of ranks) {
    const group = byRank.get(rank)!
    push(take(rank, 1))
    if (group.length >= 2) push(take(rank, 2))
    if (group.length >= 3) {
      push(take(rank, 3))
      // 三带一：找一张最小的单牌（不拆三张和对子）
      const single = sorted.find((c) => c.rank !== rank && (byRank.get(c.rank)?.length ?? 0) === 1)
      if (single) push([...take(rank, 3), single])
      // 三带二
      const pairRank = ranks.find((r) => r !== rank && (byRank.get(r)?.length ?? 0) >= 2)
      if (pairRank !== undefined) push([...take(rank, 3), ...take(pairRank, 2)])
    }
    if (group.length === 4) push(take(rank, 4))
  }

  // 王炸
  if (byRank.has(16) && byRank.has(17)) push([...take(16, 1), ...take(17, 1)])

  // 顺子
  const straightRanks = ranks.filter((r) => r <= STRAIGHT_MAX)
  for (let start = 0; start < straightRanks.length; start++) {
    const run: number[] = [straightRanks[start]!]
    for (let i = start + 1; i < straightRanks.length; i++) {
      if (straightRanks[i]! === run[run.length - 1]! + 1) {
        run.push(straightRanks[i]!)
        if (run.length >= STRAIGHT_MIN_LENGTH) {
          push(run.flatMap((r) => take(r, 1)))
        }
      } else if (straightRanks[i]! > run[run.length - 1]! + 1) {
        break
      }
    }
  }

  // 连对
  const pairRanks = ranks.filter((r) => r <= STRAIGHT_MAX && (byRank.get(r)?.length ?? 0) >= 2)
  for (let start = 0; start < pairRanks.length; start++) {
    const run: number[] = [pairRanks[start]!]
    for (let i = start + 1; i < pairRanks.length; i++) {
      if (pairRanks[i]! === run[run.length - 1]! + 1) {
        run.push(pairRanks[i]!)
        if (run.length >= STRAIGHT_PAIR_MIN) {
          push(run.flatMap((r) => take(r, 2)))
        }
      } else if (pairRanks[i]! > run[run.length - 1]! + 1) {
        break
      }
    }
  }

  // 飞机（纯的，不带翅膀）—— 带翅膀的组合数量大且实战里提示价值低，先不做
  const tripleRanks = ranks.filter((r) => r <= STRAIGHT_MAX && (byRank.get(r)?.length ?? 0) >= 3)
  for (let start = 0; start < tripleRanks.length; start++) {
    const run: number[] = [tripleRanks[start]!]
    for (let i = start + 1; i < tripleRanks.length; i++) {
      if (tripleRanks[i]! === run[run.length - 1]! + 1) {
        run.push(tripleRanks[i]!)
        if (run.length >= 2) {
          push(run.flatMap((r) => take(r, 3)))
        }
      } else if (tripleRanks[i]! > run[run.length - 1]! + 1) {
        break
      }
    }
  }

  // 排序：同类型按主牌从小到大，炸弹与王炸放最后（提示时优先给普通牌型）
  const priority: Record<string, number> = { rocket: 10, bomb: 9 }
  candidates.sort((a, b) => {
    const pa = priority[a.type] ?? 0
    const pb = priority[b.type] ?? 0
    if (pa !== pb) return pa - pb
    if (a.type !== b.type) return COMBO_LABELS[a.type].localeCompare(COMBO_LABELS[b.type])
    if (a.length !== b.length) return a.length - b.length
    return a.rank - b.rank
  })

  // 去重：同一手牌的相同出法只留一个
  const seen = new Set<string>()
  const unique: Combo[] = []
  for (const combo of candidates) {
    const key = `${combo.type}:${combo.rank}:${combo.length}:${combo.cards.map((c) => c.id).sort().join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(combo)
    if (unique.length >= limit) break
  }
  return unique
}

/** 校验一组牌是否确实在手里（防止客户端伪造）。 */
export function handContains(hand: Card[], cards: Card[]): boolean {
  const owned = new Set(hand.map((c) => c.id))
  return cards.every((c) => owned.has(c.id))
}
