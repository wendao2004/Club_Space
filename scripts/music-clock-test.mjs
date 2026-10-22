/**
 * 听歌房的服务端时钟基准。
 *
 * 为什么值得单独测：旧实现里，5 次采样全失败时 `measureClockOffset` 返回 0，
 * 调用方又无条件把它写进播放器 —— 0 同时代表"没测到"和"真的没差"，
 * 于是一次 WiFi 漫游就能让这台机器的同步基准悄悄退回**裸墙钟**。
 * 两台机器的墙钟差多少，两首歌就差多少。
 *
 * 这里 import 的就是 `web/src/lib/music-clock.ts` 本体（Node 22.18+ 默认
 * 剥离类型），跑的是界面用的那份代码，不是复制品。
 *
 * 用法：node scripts/music-clock-test.mjs
 */

import {
  calibrate,
  detectSleep,
  isCalibrated,
  nextRetryDelayMs,
  noteEpoch,
  serverNow,
  wasEverCalibrated,
} from '../web/src/lib/music-clock.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}` : ''}`)
}

function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

// ---------------------------------------------------------------- 初始状态

console.log('【初始状态】')

assert(!isCalibrated(), '还没采样时未校准')
assert(serverNow() === null, '未校准时 serverNow() 是 null（不是 0）', String(serverNow()))
assert(!wasEverCalibrated(), '还没成功过')

// ---------------------------------------------------------------- 全部失败

console.log('\n【采样全失败：保留旧值，绝不写 0】')

{
  const fail = async () => {
    throw new Error('模拟网络失败')
  }
  const result = await calibrate(fail)
  assert(result === false, '五次全失败返回 false')
  assert(!isCalibrated(), '全失败后仍未校准')
  assert(serverNow() === null, '全失败后 serverNow() 仍是 null，没有被写成 0')
  const firstDelay = nextRetryDelayMs()
  assert(firstDelay === 1_000, '第一次失败后 1 秒重试', `${firstDelay}ms`)

  await calibrate(fail)
  assert(nextRetryDelayMs() === 2_000, '连续失败后重试间隔退避到 2 秒', `${nextRetryDelayMs()}ms`)
}

// ---------------------------------------------------------------- 成功校准

console.log('\n【成功校准】')

const BASE = 1_000_000
{
  const fetchNow = async () => {
    await sleep(2)
    return BASE
  }
  const result = await calibrate(fetchNow)
  assert(result === true, '采样成功返回 true')
  assert(isCalibrated(), '校准后 isCalibrated() 为真')
  const now = serverNow()
  assert(typeof now === 'number' && Math.abs(now - BASE) < 200, 'serverNow() 落在服务端时间附近', `${now}`)
  assert(wasEverCalibrated(), '记录"曾经成功过"')
  assert(nextRetryDelayMs() === 1_000, '成功后失败计数归零')
}

// ---------------------------------------------------------------- 成功后失败

console.log('\n【成功后采样失败：保留旧锚点】')

{
  const before = serverNow()
  const result = await calibrate(async () => {
    throw new Error('模拟漫游')
  })
  assert(result === false, '这一轮返回 false')
  assert(isCalibrated(), '仍然保持校准状态（没有作废锚点）')
  const after = serverNow()
  assert(after !== null && Math.abs(after - before) < 1_000, '旧锚点保留，没有跳回 0', `${before} → ${after}`)
}

// ---------------------------------------------------------------- min-RTT

console.log('\n【min-RTT：慢样本不能污染估计】')

{
  let call = 0
  const fetchNow = async () => {
    const i = call++
    if (i === 0) {
      // 慢且撒谎：RTT 60ms，返回一个明显错误的时间
      await sleep(60)
      return BASE + 999_999
    }
    await sleep(1)
    return BASE
  }
  await calibrate(fetchNow)
  const now = serverNow()
  assert(
    typeof now === 'number' && Math.abs(now - BASE) < 300,
    '选择了 RTT 最小的样本，没有被慢样本带偏',
    `${now} 对比期望 ${BASE}`,
  )
}

// ---------------------------------------------------------------- 纪元变化

console.log('\n【服务端重启：epoch 变化作废锚点】')

{
  const first = noteEpoch('epoch-a')
  assert(first === false, '第一次记录 epoch 不算变化')
  assert(noteEpoch('epoch-a') === false, '同一个 epoch 不变')
  const changed = noteEpoch('epoch-b')
  assert(changed === true, 'epoch 变化被识别')
  assert(!isCalibrated(), 'epoch 变化后锚点作废（需要重新对时）')
}

// ---------------------------------------------------------------- 休眠检测

console.log('\n【休眠检测】')

{
  await calibrate(async () => BASE)
  assert(isCalibrated(), '先重新校准')

  const slept = detectSleep(120_000, 1_000)
  assert(slept === true, '墙钟走了 120s、单调钟只走 1s → 判定休眠')
  assert(!isCalibrated(), '休眠后锚点作废')

  await calibrate(async () => BASE)
  const normal = detectSleep(1_000, 995)
  assert(normal === false, '正常 5ms 抖动不算休眠')
  assert(isCalibrated(), '正常抖动不作废锚点')
}

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
process.exitCode = failed === 0 ? 0 : 1