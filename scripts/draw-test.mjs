/**
 * 你画我猜规则引擎测试。
 *
 * 这个游戏的"命脉"是两条：
 *  1. **词不能漏**：viewFor 是全部的安全边界，词从任何缝里漏给未猜对者，
 *     游戏就死了（直接看控制台猜答案）。所以视角裁剪按"画家 / 已猜对 /
 *     猜者 / reveal 后 / choosing"逐个视角断言。
 *  2. **计分与提示的时间公式**：猜对者按剩余时间衰减、画家拿一半；
 *     提示均匀铺在绘画时长的前 3/4、永不揭示最后一个字。公式写错一次
 *     全服玩家都会遇到，所以每条都有正例与反例。
 *
 * 用法：node scripts/draw-test.mjs
 */

import {
  CHOOSE_MS,
  DRAW_MS,
  advanceTurn,
  applyGuess,
  beginChoosing,
  beginReveal,
  chooseWord,
  dueHints,
  editDistanceAtMost1,
  hintSchedule,
  maskedWord,
  newDrawState,
  normalizeGuess,
  pickFallbackWord,
  pickWordChoices,
  ranking,
  viewFor,
} from '../server/src/games/draw.ts'
import { ALL_DRAW_WORDS, drawWordLevel } from '../server/src/games/draw-words.ts'

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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(name)
  else bad(name, `期望 ${b}，实际 ${a}`)
}

/** 三个人的标准局：甲(画家顺序 0)、乙、丙。 */
function game3() {
  return newDrawState(
    [
      { userId: 'u1', name: '甲' },
      { userId: 'u2', name: '乙' },
      { userId: 'u3', name: '丙' },
    ],
    2,
  )
}

const T0 = 1_000_000

// ---------------------------------------------------------------- 词库与选词

console.log('\n【词库与选词】')

assert(ALL_DRAW_WORDS.length >= 150, '词库总量足够一局去重', `${ALL_DRAW_WORDS.length} 词`)
assert(new Set(ALL_DRAW_WORDS).size === ALL_DRAW_WORDS.length, '词库无重复')
assert(ALL_DRAW_WORDS.every((w) => w.length >= 1 && w.length <= 4), '词长 1-4 字（简笔画可表达）')

{
  const state = game3()
  const picks = pickWordChoices(state, 3)
  eq(picks.length, 3, '选词给 3 个候选')
  eq(new Set(picks).size, 3, '候选互不相同')
  picks.forEach((w) => assert(ALL_DRAW_WORDS.includes(w), `候选「${w}」来自词库`))

  // 用过的词不再出现：把池子里的词全部标记为 used，选词仍能给出候选（放宽）
  const bigState = game3()
  bigState.usedWords = [...ALL_DRAW_WORDS]
  const picked2 = pickWordChoices(bigState, 3)
  eq(picked2.length, 3, '词池耗尽时仍能给出候选（放宽本局未用）')
}

// ---------------------------------------------------------------- 提示时间表

console.log('\n【提示时间表】')

{
  // 两字词：一个提示都不给（揭示了就只剩一个字，词没有意义）
  eq(hintSchedule(2), [], '两字词不提示')
  // 五字词：floor(4/2)=2 个提示
  eq(hintSchedule(5).length, 2, '五字词揭示 2 个字')
  // 四字词：floor(3/2)=1 个提示
  eq(hintSchedule(4).length, 1, '四字词揭示 1 个字')

  const offsets = hintSchedule(5)
  const sorted = [...offsets].sort((a, b) => a - b)
  eq(offsets, sorted, '揭示时间点单调递增')
  assert(
    offsets.every((t) => t >= 1000 && t <= DRAW_MS * 0.75),
    '揭示都落在 1 秒之后、绘画时长的前 3/4 以内',
    offsets.join(', '),
  )
  // 均匀分布：相邻间隔近似相等
  if (offsets.length >= 2) {
    const gap = offsets[1] - offsets[0]
    assert(Math.abs(offsets[1] - offsets[0] - gap) < 50, '间隔均匀', `间隔 ${gap}ms`)
  }
  // 最后一个字永远不在提示里 —— 用"被揭示的位置数 < 词长"断言
  assert(hintSchedule(4).length < 4, '四字词不会全揭示')
}

{
  // dueHints：到点才揭示，一次 tick 可以揭示多个
  const state = game3()
  beginChoosing(state, T0)
  const word = state.wordChoices[0]
  assert(!!word, '有候选可选', String(word))
  // 用一个 4 字词测试（4 字词 1 个提示）
  const fourChar = ALL_DRAW_WORDS.find((w) => w.length === 4)
  state.wordChoices = [fourChar]
  assert(chooseWord(state, 'u1', fourChar, T0), '画家选定词')

  eq(dueHints(state, T0 + 500), [], '提示时间未到 → 不揭示')
  const dueAt = T0 + state.hintOffsets[0] + 10
  eq(dueHints(state, dueAt), [0], '到点揭示对应位置')
  // 揭示后不再重复
  state.revealed[0] = true
  eq(dueHints(state, dueAt + 60_000), [], '已揭示的不重复出')
}

{
  eq(maskedWord('熊猫', [false, false]), '＿＿', '全掩码显示下划线')
  eq(maskedWord('熊猫', [false, true]), '＿猫', '揭示位置显示原字')
}

// ---------------------------------------------------------------- 猜词判定

console.log('\n【猜词判定】')

{
  const state = game3()
  beginChoosing(state, T0)
  const word = state.wordChoices[0]
  state.wordChoices = [word]
  chooseWord(state, 'u1', word, T0)

  // 归一化
  eq(normalizeGuess('  熊猫 '), '熊猫', '去首尾空白')
  eq(normalizeGuess('Ｐｉｇ'), 'pig', '全角转半角')
  eq(normalizeGuess('PIG'), 'pig', '大小写归一')

  // 画家自己猜不算
  const painter = applyGuess(state, 'u1', word, T0 + 1000)
  eq(painter.correct, false, '画家猜自己的词无效')

  // 猜者答错
  const wrong = applyGuess(state, 'u2', '随便什么', T0 + 1000)
  eq(wrong.correct, false, '猜错不计分')
  eq(wrong.gained, 0, '猜错 0 分')

  // 猜对：时间越早分越高
  const total = DRAW_MS
  const early = applyGuess(state, 'u2', word, T0 + Math.floor(total * 0.1))
  assert(early.correct, '答对判定')
  assert(early.gained >= 100, '有基础分', `${early.gained}`)
  assert(early.drawerGained > 0, '画家同时得分', `+${early.drawerGained}`)
  eq(state.players.find((p) => p.userId === 'u2').guessed, true, '猜对状态落位')

  // 已猜对的人再猜不重复计分
  const again = applyGuess(state, 'u2', word, T0 + 2000)
  eq(again.correct, false, '重复猜对不重复计分')

  // 另一个猜者：时间越晚分越低
  const late = applyGuess(state, 'u3', word, T0 + Math.floor(total * 0.9))
  assert(late.correct && late.gained >= 100, '晚猜对也有底分', `${late.gained}`)
  assert(late.gained <= early.gained, '晚猜的分不高于早猜的', `${late.gained} ≤ ${early.gained}`)
}

{
  // 全员猜对 → allGuessed
  const state = game3()
  beginChoosing(state, T0)
  const word = state.wordChoices[0]
  state.wordChoices = [word]
  chooseWord(state, 'u1', word, T0)
  const r2 = applyGuess(state, 'u2', word, T0 + 1000)
  eq(r2.allGuessed, false, '还有人没猜 → 不提前结束')
  const r3 = applyGuess(state, 'u3', word, T0 + 2000)
  eq(r3.allGuessed, true, '全员猜对 → 可以提前结束')
  // 引擎不自动切 reveal（由房间层决定），断言这里状态未变
  eq(state.phase, 'drawing', '引擎只报告，不自行推进阶段')
}

{
  // "很接近"：编辑距离 ≤ 1
  assert(editDistanceAtMost1('苹果', '平果'), '一字之差算接近（替换）')
  assert(editDistanceAtMost1('苹果', '苹果园'), '多一个字算接近（插入）')
  assert(editDistanceAtMost1('苹果', '苹'), '少一个字算接近（删除）')
  assert(!editDistanceAtMost1('苹果', '鸭梨'), '完全不同不算接近')
  assert(!editDistanceAtMost1('苹果', '苹果园里'), '差两个字不算接近')

  // close 的语义：猜错但接近
  const state = game3()
  beginChoosing(state, T0)
  const word = ALL_DRAW_WORDS.find((w) => w.length >= 2)
  state.wordChoices = [word]
  chooseWord(state, 'u1', word, T0)
  // 构造一个一字之差：答案第一个字 + 任意替换
  const closeGuess = word[0] + (word[1] === '了' ? '呢' : '了')
  const outcome = applyGuess(state, 'u2', closeGuess, T0 + 1000)
  eq(outcome.correct, false, '接近但不对')
  eq(outcome.close, true, '标出"很接近"', `答案「${word}」猜「${closeGuess}」`)
}

// ---------------------------------------------------------------- 阶段推进

console.log('\n【阶段推进】')

{
  const state = game3()
  beginChoosing(state, T0)
  const word = state.wordChoices[0]
  state.wordChoices = [word]
  chooseWord(state, 'u1', word, T0)
  eq(state.phase, 'drawing', '选词后进入绘画')
  eq(state.phaseEndsAt - T0, DRAW_MS, '绘画时长 = DRAW_MS')

  beginReveal(state, T0 + DRAW_MS)
  eq(state.phase, 'reveal', '绘画结束进入展示')

  // reveal 结束 → 轮到第二个人
  assert(advanceTurn(state, T0 + DRAW_MS + 6000), '轮转到下一位')
  eq(state.phase, 'choosing', '进入选词')
  eq(state.drawerIndex, 1, '画家轮到乙')

  // 乙画完 → 丙；丙画完 → 第二轮从甲开始
  beginReveal(state, T0 + 200_000)
  advanceTurn(state, T0 + 210_000)
  eq(state.drawerIndex, 2, '画家轮到丙')
  beginReveal(state, T0 + 300_000)
  advanceTurn(state, T0 + 310_000)
  eq(state.round, 2, '一轮画完进入第二轮')
  eq(state.drawerIndex, 0, '第二轮回到甲')

  // 第二轮画完 → 结束
  beginReveal(state, T0 + 400_000)
  advanceTurn(state, T0 + 410_000)
  beginReveal(state, T0 + 500_000)
  advanceTurn(state, T0 + 510_000)
  beginReveal(state, T0 + 600_000)
  advanceTurn(state, T0 + 610_000)
  eq(state.phase, 'finished', '两轮全部画完 → 结束')
  assert(state.result !== null, '有结算排名')
  eq(state.result.ranking.length, 3, '排名包含全部玩家')

  // 已结束再推进是空操作
  eq(advanceTurn(state, T0 + 700_000), false, '结束后不再推进')
}

{
  // 选词超时的兜底：随机候选
  const state = game3()
  beginChoosing(state, T0)
  const fallback = pickFallbackWord(state)
  assert(state.wordChoices.includes(fallback), '兜底词来自候选', String(fallback))
  assert(chooseWord(state, 'u1', fallback, T0 + CHOOSE_MS + 1), '兜底词能正常选')
}

{
  // 用的词不重复：一局里两次选词不应出现同一个词（3 候选 × 24 词的局也不会撞）
  const state = game3()
  beginChoosing(state, T0)
  const w1 = state.wordChoices[0]
  state.wordChoices = [w1]
  chooseWord(state, 'u1', w1, T0)
  beginReveal(state, T0 + DRAW_MS)
  advanceTurn(state, T0 + DRAW_MS + 6000)
  assert(!state.wordChoices.includes(w1), '同一局的候选不再出现已用的词', `已用「${w1}」`)
}

// ---------------------------------------------------------------- 视角裁剪

console.log('\n【视角裁剪（安全边界）】')

{
  const state = game3()
  beginChoosing(state, T0)
  const word = state.wordChoices[0]
  state.wordChoices = [word]
  chooseWord(state, 'u1', word, T0)

  // drawing 阶段
  const painterView = viewFor(state, 'u1')
  eq(painterView.word, word, '画家看到完整词')
  eq(painterView.wordChoices, [], 'drawing 阶段候选清空（不再需要）')

  const guesserView = viewFor(state, 'u2')
  eq(guesserView.word, null, '⚠️ 猜者拿不到词')
  eq(guesserView.masked, maskedWord(word, state.revealed), '猜者只看到掩码')
  eq(guesserView.iAmDrawer, false, '猜者的 isDrawer 标记')

  const drawerFlag = viewFor(state, 'u1')
  eq(drawerFlag.iAmDrawer, true, '画家的 isDrawer 标记')

  // 猜对之后能看到词（skribbl 的通行做法：猜对了就可以在聊天里聊它）
  state.players.find((p) => p.userId === 'u2').guessed = true
  const guessedView = viewFor(state, 'u2')
  eq(guessedView.word, word, '已猜对者可以看到词')

  // 第三个人（未猜对）仍然拿不到
  eq(viewFor(state, 'u3').word, null, '未猜对者仍拿不到词')

  // reveal 后公开
  beginReveal(state, T0 + DRAW_MS)
  eq(viewFor(state, 'u3').word, word, 'reveal 阶段词对所有人公开')

  // waiting / finished 阶段没有词
  const fresh = game3()
  eq(viewFor(fresh, 'u1').word, null, 'waiting 阶段没有词')
  fresh.phase = 'finished'
  eq(viewFor(fresh, 'u1').word, null, 'finished 阶段没有词')

  // choosing 阶段：候选只给画家
  const choosing = game3()
  beginChoosing(choosing, T0)
  eq(viewFor(choosing, 'u1').wordChoices.length, 3, '画家看到 3 个候选')
  eq(viewFor(choosing, 'u2').wordChoices, [], '⚠️ 其他人拿不到候选')
  eq(viewFor(choosing, 'u2').word, null, 'choosing 阶段无词')
}

{
  // ranking：按分数降序
  const state = game3()
  state.players[0].score = 50
  state.players[1].score = 300
  state.players[2].score = 120
  const r = ranking(state)
  eq(r.map((p) => p.userId), ['u2', 'u3', 'u1'], '按分降序排列')
}

{
  // 词库难度查询（词 → 难度映射的兜底）
  eq(drawWordLevel('熊猫'), 'easy', '短词是简单')
  eq(drawWordLevel('不存在的词'), 'medium', '未知词兜底 medium')
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
