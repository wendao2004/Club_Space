/**
 * 你画我猜规则引擎。
 *
 * 纯函数、不碰 DB/HTTP —— 与 doudizhu.ts / werewolf.ts 同一分工：这里只管
 * "状态怎么合法地迁移"，房间层（draw-rooms.ts）管存储、广播和身份校验。
 *
 * ============================================================================
 * 规则蓝本与出处
 * ============================================================================
 * 机制细节参考了几个开源实现的**公开规则**（skribbl.io 类游戏的事实性玩法），
 * 注意许可边界：
 *  - classGame 实际是 GPL-3（README 写 MIT 已过时）—— 它的代码一个字都不能搬，
 *    但"猜对者按剩余时间线性计分、画家拿 50%"这类玩法本身是事实，不受版权保护；
 *  - RubStadel/Skribble 无 license —— 同样只参考它 README 里的公式描述；
 *  - scribble.rs 是 BSD-3，本次没有直接翻译它的 Go 代码。
 * 所有代码都是从规则出发自己写的，测试（scripts/draw-test.mjs）逐条断言。
 *
 * 计分（数值取自 skribbl 类游戏的通行设定）：
 *   猜对者 = max(100, round(2000 × 剩余时间比例))
 *   画家   = 每有一人猜对，加该人分数的一半（四舍五入）
 * 没人猜对画家 0 分。数值刻意压在几百的量级 —— 和狼人杀、斗地主的"一局"
 * 记分感一致，不值得为它做归一化。
 *
 * ============================================================================
 * 阶段机
 * ============================================================================
 *   waiting → choosing（画家 10s 选词）→ drawing（80s 画与猜）
 *           → reveal（6s 公布答案）→ choosing（下一个画家）… → finished
 *
 * drawing 阶段可以在任何人还没超时的情况下提前结束：全员猜对。
 * choosing 超时由扫描器随机选一个候选 —— 这也来自 skribbl 的通行做法，
 * 否则画家卡住会让所有人干等。
 *
 * ============================================================================
 * 状态里有什么、没有什么
 * ============================================================================
 * state 会整个 JSON 序列化进 game_rooms.state 列并在**每次变更后全量覆盖写**，
 * 所以它只装"小而必要"的东西。两条刻意不进 state：
 *  - 画笔笔画：append-only 会无限增长，且历史笔画只需要给"中途进来的/刷新的"
 *    人补发一次。它住在 draw-rooms.ts 的进程内存里（Map<roomId, strokes>），
 *    重启丢失可接受 —— 丢的只是"当前这一笔"，回合该超时照样超时。
 *  - 房内聊天/猜词流：一局能有几十条，同理住内存（截断保留最近 50 条）。
 */

export type DrawPhase = 'waiting' | 'choosing' | 'drawing' | 'reveal' | 'finished'

import { DRAW_WORDS as WORD_POOL } from './draw-words.ts'

const DRAW_WORDS_EASY = WORD_POOL.easy
const DRAW_WORDS_MEDIUM = WORD_POOL.medium
const DRAW_WORDS_HARD = WORD_POOL.hard

export interface DrawPlayer {
  userId: string
  name: string
  score: number
  online: boolean
  /** 本回合是否已猜对（drawing 阶段用；每回合重置）。 */
  guessed: boolean
}

export interface DrawChatMsg {
  userId: string
  name: string
  text: string
  at: number
  /** 猜对时服务端置 true —— 前端据此高亮，且**不再向未猜对者重复透出词**。 */
  correct?: boolean
  /** 很接近（编辑距离 ≤1）—— 只对猜的人自己可见，见 viewFor。 */
  close?: boolean
}

export interface DrawState {
  phase: DrawPhase
  /** 座位顺序即画家顺序。 */
  players: DrawPlayer[]
  /** 当前画家的下标（drawing/choosing/reveal 阶段有效）。 */
  drawerIndex: number
  /** 第几轮（1 起）。一轮 = 每个在场玩家画一次。 */
  round: number
  totalRounds: number
  /** 当前要画的词。choosing 阶段为 null；reveal 后公开。 */
  word: string | null
  /** choosing 阶段的候选词，只发给画家本人。 */
  wordChoices: string[]
  /** revealed[i] === true 表示词的第 i 个字已作为提示公开。 */
  revealed: boolean[]
  /** 每个提示应该在 drawing 开始后多少毫秒揭示（均匀分布，见 hintSchedule）。 */
  hintOffsets: number[]
  /** 本局已经用过的词，选词时排除（一局内不重复）。 */
  usedWords: string[]
  /** drawing 的开始时间，提示揭示与计分的时间基准。 */
  drawingStartedAt: number
  /** 当前阶段的截止时间。扫描器（index.ts 的 2 秒 tick）据此推进。 */
  phaseEndsAt: number
  result: { ranking: Array<{ userId: string; name: string; score: number }> } | null
}

// ---------------------------------------------------------------- 常量

export const DRAW_MIN_PLAYERS = 2
export const DRAW_MAX_PLAYERS = 8
export const WORD_CHOICES = 3
/** 选词限时。超时随机选 —— 画家卡住不能让全屋人陪等。 */
export const CHOOSE_MS = 10_000
/** 每回合绘画时长。 */
export const DRAW_MS = 80_000
/** 公布答案的展示时长，之后进下一回合。 */
export const REVEAL_MS = 6_000
/** 猜词提示：最多揭示 floor((len-1)/2) 个字 —— 两字词一个都不提示。 */
export const MAX_HINT_RATIO = 0.5

// ---------------------------------------------------------------- 建局

export function newDrawState(names: Array<{ userId: string; name: string }>, totalRounds: number): DrawState {
  return {
    phase: 'waiting',
    players: names.map((p) => ({ userId: p.userId, name: p.name, score: 0, online: true, guessed: false })),
    drawerIndex: 0,
    round: 1,
    totalRounds,
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

// ---------------------------------------------------------------- 选词

/** 从词池里挑 n 个不重复、且本局没用过的候选。 */
export function pickWordChoices(state: DrawState, count = WORD_CHOICES): string[] {
  const all = [...DRAW_WORDS_EASY, ...DRAW_WORDS_MEDIUM, ...DRAW_WORDS_HARD]
  const pool = all.filter((w) => !state.usedWords.includes(w))
  const picked: string[] = []
  // 池子耗尽（不太可能：词库 200+，一局最多 8×3=24 词）就放宽"本局未用"
  const source = pool.length >= count ? pool : all.filter((w) => !picked.includes(w))
  while (picked.length < count && source.length > 0) {
    const index = Math.floor(Math.random() * source.length)
    const word = source.splice(index, 1)[0]!
    if (!picked.includes(word)) picked.push(word)
  }
  return picked
}

/** 进入 choosing：清上一回合痕迹，生成候选。调用方负责设置 phaseEndsAt。 */
export function beginChoosing(state: DrawState, now: number): void {
  state.phase = 'choosing'
  state.word = null
  state.revealed = []
  state.hintOffsets = []
  state.wordChoices = pickWordChoices(state)
  state.phaseEndsAt = now + CHOOSE_MS
  for (const p of state.players) p.guessed = false
}

/**
 * 画家选定词。返回 false 表示调用非法（不是画家 / 不在 choosing / 词不在候选里）。
 * 超时兜底走 pickFallbackWord + 这一个函数，路径只有一条。
 */
export function chooseWord(state: DrawState, userId: string, word: string, now: number): boolean {
  if (state.phase !== 'choosing') return false
  if (state.players[state.drawerIndex]?.userId !== userId) return false
  if (!state.wordChoices.includes(word)) return false

  state.word = word
  state.usedWords.push(word)
  state.revealed = word.split('').map(() => false)
  state.hintOffsets = hintSchedule(word.length)
  state.phase = 'drawing'
  state.drawingStartedAt = now
  state.phaseEndsAt = now + DRAW_MS
  return true
}

/** 选词超时的兜底：随机选一个候选。 */
export function pickFallbackWord(state: DrawState): string | null {
  return state.wordChoices[Math.floor(Math.random() * state.wordChoices.length)] ?? null
}

// ---------------------------------------------------------------- 提示

/**
 * 提示揭示的时间表：均匀铺在绘画时长的前 3/4 里（最后 1/4 不再揭示 ——
 * 最后几秒才亮出来的字等于白给），并且**永远不揭示最后一个字**。
 * 两字词 hints = 0：一个字都不给（不然词就没意义了）。
 */
export function hintSchedule(wordLength: number, drawMs = DRAW_MS): number[] {
  const hints = Math.floor((wordLength - 1) * MAX_HINT_RATIO)
  const schedule: number[] = []
  for (let i = 1; i <= hints; i++) {
    schedule.push(Math.max(1000, Math.floor(((drawMs * 3) / 4) * (i / (hints + 1)))))
  }
  return schedule
}

/** 现在到点该揭示哪些字（可能一次揭示多个 —— 扫描间隔 2 秒）。 */
export function dueHints(state: DrawState, now: number): number[] {
  if (state.phase !== 'drawing') return []
  const elapsed = now - state.drawingStartedAt
  const due: number[] = []
  state.hintOffsets.forEach((offset, i) => {
    if (!state.revealed[i] && elapsed >= offset) due.push(i)
  })
  return due
}

/** 猜者视角看到的词：未揭示的字以下划线占位。 */
export function maskedWord(word: string, revealed: boolean[]): string {
  return word
    .split('')
    .map((ch, i) => (revealed[i] ? ch : '＿'))
    .join('')
}

// ---------------------------------------------------------------- 猜词

/** 归一化：去所有空白、转小写、全角转半角。中文没有大小写问题，规则对两种都成立。 */
export function normalizeGuess(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** 编辑距离（≤1 判"很接近"）。词长差距超过 1 直接判远，不用跑 DP。 */
export function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  // 前缀对齐：跳过相同开头，剩下的比较是否只差一处
  let i = 0
  let j = 0
  let diff = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else {
      diff += 1
      if (diff > 1) return false
      // 尝试"删/插"与"替换"两条路：长度相等按替换，不等则长串指针后移
      if (a.length === b.length) {
        i += 1
        j += 1
      } else if (a.length > b.length) {
        i += 1
      } else {
        j += 1
      }
    }
  }
  // 结尾剩余（例如 a 比 b 多一个尾字）也算一处差异
  if (i < a.length || j < b.length) diff += 1
  return diff <= 1
}

export interface GuessOutcome {
  correct: boolean
  close: boolean
  /** 全员（除画家）都猜对了 —— drawing 可以提前结束。 */
  allGuessed: boolean
  gained: number
  drawerGained: number
}

/** 应用一次猜词。猜对就计分（时间衰减）；错误只返回 close 与否，由房间层决定放进聊天流。 */
export function applyGuess(state: DrawState, userId: string, text: string, now: number): GuessOutcome {
  const outcome: GuessOutcome = { correct: false, close: false, allGuessed: false, gained: 0, drawerGained: 0 }
  if (state.phase !== 'drawing' || !state.word) return outcome

  const player = state.players.find((p) => p.userId === userId)
  // 画家不参与猜（他的输入只可能是选词/画笔/清空）；已猜对的不重复计分
  if (!player || player.guessed) return outcome
  if (state.players[state.drawerIndex]?.userId === userId) return outcome

  const guess = normalizeGuess(text)
  const answer = normalizeGuess(state.word)
  if (!guess) return outcome

  if (guess === answer) {
    outcome.correct = true
    const total = state.phaseEndsAt - state.drawingStartedAt
    const remain = Math.max(0, state.phaseEndsAt - now)
    outcome.gained = Math.max(100, Math.round((2000 * remain) / total))
    player.score += outcome.gained
    player.guessed = true

    const drawer = state.players[state.drawerIndex]
    outcome.drawerGained = Math.round(outcome.gained / 2)
    if (drawer) drawer.score += outcome.drawerGained

    outcome.allGuessed = state.players
      .filter((_, i) => i !== state.drawerIndex)
      .every((p) => p.guessed)
  } else {
    outcome.close = answer.length >= 2 && editDistanceAtMost1(guess, answer)
  }
  return outcome
}

// ---------------------------------------------------------------- 阶段推进

/** drawing 结束（超时或全对）→ reveal。调用方负责广播。 */
export function beginReveal(state: DrawState, now: number): void {
  state.phase = 'reveal'
  state.phaseEndsAt = now + REVEAL_MS
  // 词公开：viewFor 在 reveal 阶段对所有人放行完整词
}

/**
 * reveal 结束 → 下一个画家；一轮画完进下一轮；全部画完 → finished。
 * 返回 false 表示已经结束（finished）。
 *
 * 画家断线的回合也会走到这里 —— 断线的人那回合没人能猜对（房间层会拦掉
 * 他的画笔），照常轮转，不重置分数：skribbl 类游戏对挂机就是这么处理的。
 */
export function advanceTurn(state: DrawState, now: number): boolean {
  if (state.phase === 'finished') return false

  const nextIndex = state.drawerIndex + 1
  if (nextIndex < state.players.length) {
    state.drawerIndex = nextIndex
  } else if (state.round < state.totalRounds) {
    state.round += 1
    state.drawerIndex = 0
  } else {
    state.phase = 'finished'
    state.word = null
    state.wordChoices = []
    state.result = { ranking: ranking(state) }
    return true
  }
  beginChoosing(state, now)
  return true
}

/** 按分排名（并列同名次：分一样的按出场顺序，界面自己决定怎么展示）。 */
export function ranking(state: DrawState): Array<{ userId: string; name: string; score: number }> {
  return [...state.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ userId: p.userId, name: p.name, score: p.score }))
}

// ---------------------------------------------------------------- 视角裁剪

export interface DrawView {
  phase: DrawPhase
  players: Array<{ userId: string; name: string; score: number; online: boolean; guessed: boolean; isDrawer: boolean }>
  drawerIndex: number
  drawerName: string
  round: number
  totalRounds: number
  /** 画家的完整词 / 已猜对者的词 / reveal 后的词；其余是掩码。 */
  word: string | null
  masked: string | null
  revealed: boolean[]
  wordChoices: string[]
  /** 我是否已经猜对（drawing 阶段）。 */
  iGuessed: boolean
  /** 我是否是画家。 */
  iAmDrawer: boolean
  phaseEndsAt: number
  result: DrawState['result']
}

/**
 * 视角裁剪：词只对"画家 / 本回合已猜对的人 / reveal 之后"可见。
 *
 * ⚠️ 这是这个游戏的**全部安全边界**：词一旦从这条缝里漏给未猜对者，
 * 直接猜答案就赢了。web 的 view 只从这一个函数出来，测试逐视角断言。
 */
export function viewFor(state: DrawState, userId: string): DrawView {
  const drawer = state.players[state.drawerIndex] ?? null
  const me = state.players.find((p) => p.userId === userId) ?? null
  const iAmDrawer = !!me && state.phase !== 'waiting' && state.phase !== 'finished' && drawer?.userId === userId
  const iGuessed = !!me?.guessed
  const canSeeWord =
    state.word !== null && (state.phase === 'reveal' || iAmDrawer || (state.phase === 'drawing' && iGuessed))

  return {
    phase: state.phase,
    players: state.players.map((p, i) => ({
      userId: p.userId,
      name: p.name,
      score: p.score,
      online: p.online,
      guessed: p.guessed,
      isDrawer: state.phase !== 'waiting' && state.phase !== 'finished' && i === state.drawerIndex,
    })),
    drawerIndex: state.drawerIndex,
    drawerName: drawer?.name ?? '',
    round: state.round,
    totalRounds: state.totalRounds,
    word: canSeeWord ? state.word : null,
    masked: state.word ? maskedWord(state.word, state.revealed) : null,
    revealed: [...state.revealed],
    // 候选词只发给画家本人 —— 其他人拿到空数组
    wordChoices: iAmDrawer && state.phase === 'choosing' ? state.wordChoices : [],
    iGuessed,
    iAmDrawer,
    phaseEndsAt: state.phaseEndsAt,
    result: state.result,
  }
}
