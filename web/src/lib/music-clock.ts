/**
 * 听歌房的服务端时钟基准。
 *
 * 为什么不再用 `Date.now() + offset`：
 *
 *  - `Date.now()` 是墙上时钟，NTP 步进、手动改表、合盖唤醒都会让它跳。
 *    跳一次，手里的 offset 就作废，而旧实现要等 **5 分钟**才重测。
 *  - 现在用 `performance.now()` 做本地时间轴（单调，不受步进影响），
 *    只在每次采样时记录一次"服务端时刻 ↔ 本机单调时刻"的对应关系。
 *
 * 三条硬规则（都是审计里确认过的真实故障）：
 *
 *  1. **采样失败绝不写 0。** 0 同时代表"没测到"和"真的没差"，把前者当成
 *     后者，等于静默退回裸墙钟 —— 两台机器差几秒就是两首歌。
 *  2. **没有有效锚点时不播放。** 宁可显示"正在对时"，也不要带着错误基准出声。
 *  3. **epoch 变化 = 锚点作废。** 服务端重启后所有绝对时间戳都换了历元。
 */

/** 每次校准采几个样本。 */
const SAMPLES = 5
/** 单次请求的超时。没有超时的 fetch 能把首次校时拖到几十秒。 */
const TIMEOUT_MS = 1200
/** RTT 超过这个值就不采信（说明这一发被排队或拥塞了）。 */
const MAX_RTT_MS = 2000
/** 采样失败后的快速重试间隔（而不是干等下一次 60 秒定时器）。 */
const RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000]

interface Anchor {
  /** 采样时刻对应的服务端毫秒。 */
  serverMs: number
  /** 与 serverMs 对应的本机 performance.now()。 */
  perfMs: number
}

let anchor: Anchor | null = null
/** 曾经成功过（用于区分"从未对时"和"曾经对时但现在失败"）。 */
let everCalibrated = false
/** 防止一轮慢采样覆盖掉后发起的快采样。 */
let generation = 0
/** 连续失败次数，决定下一次重试等多久。 */
let failures = 0
/** 服务端进程纪元；变化时必须丢弃锚点。 */
let epoch: string | null = null

/** 当前是否有可用的服务端时钟。 */
export function isCalibrated(): boolean {
  return anchor !== null
}

/** 是否曾经对时成功过（失联时用来区分提示文案）。 */
export function wasEverCalibrated(): boolean {
  return everCalibrated
}

/** 下一次校准失败后应该等多久再试。 */
export function nextRetryDelayMs(): number {
  const index = Math.max(0, Math.min(failures - 1, RETRY_STEPS_MS.length - 1))
  return RETRY_STEPS_MS[index] ?? 60_000
}

/**
 * 记录服务端纪元。返回 true 表示纪元变了 —— 调用方应当立刻重新校准，
 * 并且在成功之前不要播放。
 */
export function noteEpoch(next: string | null): boolean {
  if (!next) return false
  // 第一次拿到纪元只是"记住"，不是"变化"
  if (epoch === null) {
    epoch = next
    return false
  }
  if (next === epoch) return false
  epoch = next
  if (everCalibrated) {
    anchor = null
  }
  return true
}

/** 主动作废当前锚点（例如检测到系统休眠、或从后台回到前台）。 */
export function invalidate(): void {
  anchor = null
}

/**
 * 服务端此刻的毫秒数；没有有效锚点时返回 null。
 *
 * 调用方必须把 null 当成"现在不能判断进度"，而不是当成 0。
 */
export function serverNow(): number | null {
  if (!anchor) return null
  return anchor.serverMs + (performance.now() - anchor.perfMs)
}

/** 带超时的 fetch，避免一次挂起的请求拖死整轮校准。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('clock sample timeout')), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 采样若干次，取 RTT 最小的一次估计锚点。
 *
 * 取 min-RTT 的理由：RTT 越小，上下行越接近对称，`(t0+t1)/2` 这个中点
 * 假设才越成立。样本全失败时**保留旧锚点**并返回 false。
 */
export async function calibrate(fetchServerNow: () => Promise<number>): Promise<boolean> {
  const myGeneration = ++generation
  const samples: Array<{ rtt: number; serverMs: number; perfMs: number }> = []

  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now()
    try {
      const serverMs = await withTimeout(fetchServerNow(), TIMEOUT_MS)
      const t1 = performance.now()
      const rtt = t1 - t0
      if (!Number.isFinite(serverMs) || rtt <= 0 || rtt > MAX_RTT_MS) continue
      samples.push({ rtt, serverMs, perfMs: t0 + rtt / 2 })
    } catch {
      // 单次失败不影响其余样本；全部失败时走下面的保留分支
    }
  }

  // 这一轮已经被更新的一轮取代：不要用旧结果覆盖新结果
  if (myGeneration !== generation) return anchor !== null

  if (samples.length === 0) {
    failures++
    // 关键：不清空 anchor、不写 0。
    // 返回值只表示"这一轮有没有成功"，不表示"现在还有没有可用锚点" ——
    // 调用方要排重试，哪怕旧锚点还能用（它可能已经不准了）。
    return false
  }

  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
  anchor = { serverMs: best.serverMs, perfMs: best.perfMs }
  everCalibrated = true
  failures = 0
  return true
}

/**
 * 用墙钟与单调钟的增量差判断"刚才是不是休眠了"。
 *
 * 合盖唤醒时 `performance.now()` 是否继续走取决于平台；如果它冻结了，
 * 旧锚点会落后整个休眠时长。检测到就直接作废，等重新校准。
 */
export function detectSleep(wallDeltaMs: number, perfDeltaMs: number): boolean {
  if (Math.abs(wallDeltaMs - perfDeltaMs) > 5_000) {
    invalidate()
    return true
  }
  return false
}