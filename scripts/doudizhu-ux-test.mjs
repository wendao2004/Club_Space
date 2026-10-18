/**
 * 斗地主"反馈效果"回归测试。
 *
 * 为什么要有这个文件：这轮加的全是动画 —— 而动画本身在无浏览器环境里测不了
 * （Vue 的 <Transition>/<TransitionGroup> 需要真实 DOM）。但动画背后有两块**纯逻辑**
 * 是可以、也必须回归的：
 *
 *   1. **驱动"这一手"的标识。** 前一轮的评审专门指出过一个坑：不能拿
 *      room.history.length（或牌面 join）当触发源 —— 服务端用 slice(-40) 把
 *      history 封了顶，打到 40 手之后长度恒定不变，动画会突然不再触发，
 *      而且只在长局里冒头，线上极难复现。所以这里把"同一局越打越久、但
 *      history 长度已经顶格"的场景造出来，断言标识**仍然在变**，同时断言
 *      长度 / join 这类朴素写法**在同样的场景下确实不变**（把坑本身钉住）。
 *
 *   2. **结算原因的中文映射。** 服务端发的是 'emptied' / 'abandon' 这类英文码，
 *      直接显示给用户是英文，得翻。
 *
 * 这些函数定义在 web/src/apps/DoudizhuApp.vue 的「反馈纯函数区」里（有明确注释
 * 标记）。测试**直接把那段源码抽出来**、用 Node 的类型剥离跑 —— 这样测的就是
 * 真正在跑的那段逻辑，而不是测试里另抄一份（另抄一份的话，改了实现测试还绿）。
 *
 * 用法：node scripts/doudizhu-ux-test.mjs
 */

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SFC = join(HERE, '..', 'web', 'src', 'apps', 'DoudizhuApp.vue')

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
  assert(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

console.log('\n\x1b[1m斗地主反馈效果测试\x1b[0m\n')

// ================================================================
// 1. 从 SFC 里抽出「反馈纯函数区」
// ================================================================

const START_MARKER =
  '/* ==== 反馈纯函数区：scripts/doudizhu-ux-test.mjs 会整段抽出来跑，改动请保持无外部依赖 ==== */'
const END_MARKER = '/* ==== 反馈纯函数区 结束 ==== */'

const source = readFileSync(SFC, 'utf8')
const startAt = source.indexOf(START_MARKER)
const endAt = source.indexOf(END_MARKER)

console.log('【抽取源码】')

if (startAt === -1 || endAt === -1 || endAt <= startAt) {
  bad(
    '在 DoudizhuApp.vue 里找到纯函数区的起止标记',
    `startAt=${startAt} endAt=${endAt}（注释标记被改动或删除会导致本测试整段失效）`,
  )
} else {
  ok('在 DoudizhuApp.vue 里找到纯函数区的起止标记', `区间 ${endAt - startAt} 字符`)
}

const rawRegion = startAt !== -1 && endAt > startAt ? source.slice(startAt + START_MARKER.length, endAt) : ''

let helpers = null
if (rawRegion.trim().length > 0) {
  // Node 24 的原生类型剥离：把函数签名上的 TS 注解去掉，得到可直接 eval 的 JS。
  // 这样测试不需要任何构建步骤，也和线上跑的是同一份逻辑。
  const plainJs = stripTypeScriptTypes(rawRegion, { mode: 'strip' })
  const factory = new Function(
    `${plainJs}\nreturn { findLastPlayEntry, thisHandKey, bombFlavor, countBadgeOf, reasonLabel }`,
  )
  helpers = factory()
  ok('纯函数区能剥离 TS 类型并求值', Object.keys(helpers).join(', '))
} else {
  bad('纯函数区非空', '抽取到的源码为空，后面的断言无法进行')
}

const { findLastPlayEntry, thisHandKey, bombFlavor, countBadgeOf, reasonLabel } = helpers ?? {}

// ================================================================
// 2. 造数据的小工具
// ================================================================

/** 递增的时间戳：模拟服务端 now()，每一手都拿到不同（且稳定递增）的毫秒数。 */
let clock = 1_700_000_000_000
function at() {
  clock += 7
  return clock
}

/** 造一条出牌记录。cards 为空即"要不起"。 */
function entry(seat, cards, type, typeLabel) {
  return { seat, cards, type, typeLabel, at: at() }
}

function single(seat, card) {
  return entry(seat, [card], 'single', '单张')
}
function pass(seat) {
  return entry(seat, [], 'pass', '要不起')
}

/** 视图里 lastPlay 的形状（注意：没有 type 字段，只有 typeLabel）。 */
function lastPlayOf(record) {
  return { seat: record.seat, cards: record.cards, typeLabel: record.typeLabel }
}

/** 只保留纯函数真正读到的字段即可（history + lastPlay）。 */
function room(history, lastPlay) {
  return { history, lastPlay }
}

/** 从 history 末位推出 lastPlay，方便构造"刚打完一手"的房间。 */
function roomAfter(history) {
  const rec = history[history.length - 1]
  return room(history, lastPlayOf(rec))
}

// ================================================================
// 3. 核心回归：驱动动画的"这一手"标识必须随每一手变化
// ================================================================

console.log('\n【驱动动画的"这一手"标识】')

if (helpers) {
  const h1 = [single(0, '3')]
  const h2 = [single(0, '3'), single(1, '4')]
  const k1 = thisHandKey(roomAfter(h1))
  const k2 = thisHandKey(roomAfter(h2))
  assert(k1 !== '' && k2 !== '', '有上一手时标识非空', `k1=${k1}`)
  assert(k1 !== k2, '相邻两手（3 → 4）的标识不同')

  // ---- 关键：history 被 slice(-40) 封顶后的场景 ----------------------------
  // 打到后期，history 永远是 40 条；每出一手，最老的被挤掉、最新的补进来，
  // 长度纹丝不动。以长度当 key 的写法到这里就瞎了 —— 这正是评审点名的坑。
  const filler = Array.from({ length: 39 }, (_, i) => single(i % 3, '5'))
  const defA = single(0, '6')
  const defB = single(1, '7')
  const capped1 = roomAfter([...filler, defA]) // length === 40
  const capped2 = roomAfter([...filler, defB]) // length === 40（长度没变！）
  eq(capped1.history.length, 40, '封顶场景：history 长度确为 40')
  eq(capped2.history.length, 40, '封顶场景：下一手之后长度仍是 40')

  const capKey1 = thisHandKey(capped1)
  const capKey2 = thisHandKey(capped2)
  assert(capKey1 !== capKey2, '封顶后标识依然随新的一手变化（回归：不受 length 封顶影响）', `${capKey1} → ${capKey2}`)

  // 把"错误写法"的效果也钉住：长度 / 牌面 join 在这个场景下是**不变**的。
  // 如果哪天有人把实现改回这些朴素写法，上面的断言会红，这条注释解释它是为什么红。
  const naiveLength1 = String(capped1.history.length)
  const naiveLength2 = String(capped2.history.length)
  eq(naiveLength1, naiveLength2, '（反例）按 history.length 当 key 时，这两手会得到同一个 key')

  // ---- 同一个人重复出同样的牌：join 会撞，时间戳不会 ----------------------
  const repeatA = roomAfter([single(0, 'K')])
  const repeatB = roomAfter([...repeatA.history, pass(2), single(0, 'K')])
  const naiveJoinA = `0-${repeatA.lastPlay.cards.join(',')}-单张`
  const naiveJoinB = `0-${repeatB.lastPlay.cards.join(',')}-单张`
  eq(naiveJoinA, naiveJoinB, '（反例）按"座位+牌面 join"当 key 时，重复出同一张牌会撞 key')
  assert(
    thisHandKey(repeatA) !== thisHandKey(repeatB),
    '时间戳标识能区分"重复出同一张牌"的两个不同时刻',
  )

  // ---- 别人"要不起"不应该重放上一手的动画 --------------------------------
  const beforePass = roomAfter([entry(0, ['9', '9'], 'pair', '对子')])
  const afterPass = room(beforePass.history.concat([pass(1)]), beforePass.lastPlay)
  eq(
    thisHandKey(afterPass),
    thisHandKey(beforePass),
    '别人要不起时，lastPlay 未变 → 标识不变（不会误触发重放）',
  )
  assert(
    findLastPlayEntry(afterPass)?.at === beforePass.history[0].at,
    'findLastPlayEntry 跳过了末位的 pass，找到真正那一手',
  )

  // ---- 首出（没有 lastPlay）时标识为空 -----------------------------------
  eq(thisHandKey(room([], null)), '', '首出（无上一手）时标识为空串')

  // ================================================================
  // 4. 炸弹 / 王炸识别
  // ================================================================

  console.log('\n【炸弹 / 王炸识别】')

  const bombRoom = roomAfter([entry(1, ['7', '7', '7', '7'], 'bomb', '炸弹')])
  eq(bombFlavor(bombRoom), 'bomb', '四张同点为炸弹')
  const rocketRoom = roomAfter([entry(2, ['小王', '大王'], 'rocket', '王炸')])
  eq(bombFlavor(rocketRoom), 'rocket', '双王为王炸')
  const plainRoom = roomAfter([entry(0, ['3', '3'], 'pair', '对子')])
  eq(bombFlavor(plainRoom), '', '普通牌型不触发特效')
  eq(bombFlavor(room([], null)), '', '没有上一手时不触发特效')

  // ================================================================
  // 5. 报单 / 报双
  // ================================================================

  console.log('\n【报单 / 报双】')

  eq(countBadgeOf(1), '报单', '剩 1 张 → 报单')
  eq(countBadgeOf(2), '报双', '剩 2 张 → 报双')
  eq(countBadgeOf(0), '', '剩 0 张（已出完）不显示')
  eq(countBadgeOf(17), '', '开局 17 张不显示')
  eq(countBadgeOf(3), '', '剩 3 张不显示')

  // ================================================================
  // 6. 结算原因中文映射
  // ================================================================

  console.log('\n【结算原因中文映射】')

  eq(reasonLabel('emptied'), '出完了所有手牌', "服务器 'emptied' → 中文")
  eq(reasonLabel('abandon'), '有人中途退出', "服务器 'abandon' → 中文")
  eq(reasonLabel('unknown_future_code'), 'unknown_future_code', '未知码原样透出，不静默丢失')
  assert(
    !/[a-z]/.test(reasonLabel('emptied')) && !/[a-z]/.test(reasonLabel('abandon')),
    '已知原因码的展示文案里不含英文字母',
  )
} else {
  bad('跳过所有断言', '纯函数区未能抽取，无法继续')
}

// ================================================================
console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
