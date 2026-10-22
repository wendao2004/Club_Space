/**
 * 听歌房的同步播放引擎。
 *
 * 目标不是"能出声"，而是**多台电脑同时出声听起来像一个声场** ——
 * 每台电脑都是一只音箱，靠的都是同一份时间基准：
 *
 * 1. **时钟对齐**：`/api/music/time` 采样 5 次，取 RTT 最小的一次估
 *    "服务端时钟 - 本地时钟"的偏移。绝不能拿本地 `Date.now()` 直接减
 *    服务端的 `startedAt`（两台机器差几秒，就是两首歌）。
 * 2. **三级校正**（人耳对"同时发声"的容忍度大约是 30-40ms）：
 *    - 偏差 < 40ms：不动（听不出来，动了反而抖）
 *    - 40ms ~ 400ms：**改 playbackRate 微调**追平（±4% 以内，音高变化
 *      约 0.7 半音以内，几乎听不出；避免了频繁 seek 的"咔哒"感）
 *    - > 400ms：直接 seek（宁可跳一下，也不能长期跑偏）
 * 3. **共享暂停**：暂停是厅级状态（服务端存 paused_position_ms），
 *    所有人一起停、一起续，续播时把 started_at 往回拨已播时长。
 *
 * 注意：不做任何"混响/声像"效果 —— 空间感来自多台设备在物理空间里的
 * 位置差异，前提就是同步足够准。
 */

/** 播放状态（服务端给的权威数据）。 */
export interface SyncSource {
  nodeId: string
  playedToken: number
  startedAt: number
  paused: boolean
  positionMs: number
}

/** 小于这个偏差就不管（人耳分辨不了，频繁微调反而像抖）。 */
const TOLERANCE_SEC = 0.04
/** 超过这个偏差就不再微调，直接 seek。 */
const HARD_SEEK_SEC = 0.4
/** 微调时允许的最大倍速偏移（4% ≈ 0.7 半音，基本听不出）。 */
const MAX_RATE_ADJUST = 0.04

/**
 * 估算服务端时钟偏移（毫秒）。取五次采样里 RTT 最小的那次 ——
 * 网络越顺，`serverNow - (发送+接收)/2` 越准。
 */
export async function measureClockOffset(fetchNow: () => Promise<number>): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 }
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    try {
      const serverNow = await fetchNow()
      const t1 = Date.now()
      const rtt = t1 - t0
      if (rtt < best.rtt) best = { rtt, offset: serverNow - (t0 + rtt / 2) }
    } catch {
      // 单次失败无所谓，其他采样还有机会
    }
  }
  return Number.isFinite(best.rtt) ? best.offset : 0
}

export class SyncedPlayer {
  private el: HTMLAudioElement | null = null
  private clockOffset = 0
  /** 最近一次测得的偏差（毫秒，正数=本地落后）。界面用它显示同步精度。 */
  lastOffsetMs = 0
  /** 浏览器拦了自动播放（没有用户手势）时置位。 */
  blocked = false

  attach(el: HTMLAudioElement): void {
    this.el = el
  }

  setClockOffset(offset: number): void {
    this.clockOffset = offset
  }

  serverNow(): number {
    return Date.now() + this.clockOffset
  }

  /** 目标进度（毫秒）：暂停时是固定值，播放中由服务端时钟推算。 */
  targetMs(src: SyncSource): number {
    return src.paused ? src.positionMs : Math.max(0, this.serverNow() - src.startedAt)
  }

  /**
   * 把播放器拉到目标状态。每 500ms 调一次。
   * 返回 true 表示这次动过（seek 或改了速率）。
   */
  enforce(src: SyncSource): boolean {
    const el = this.el
    if (!el) return false
    if (!Number.isFinite(el.duration) || el.duration <= 0) return false

    const target = this.targetMs(src) / 1000

    if (src.paused) {
      el.playbackRate = 1
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - target) > 1) el.currentTime = Math.min(target, el.duration)
      this.lastOffsetMs = 0
      return false
    }

    if (el.paused) {
      el.currentTime = Math.min(target, el.duration)
      el.playbackRate = 1
      void el.play().then(
        () => {
          this.blocked = false
        },
        () => {
          this.blocked = true
        },
      )
      return true
    }

    // 播放中：算偏差（正数 = 本地落后于服务端）
    const drift = target - el.currentTime
    this.lastOffsetMs = Math.round(drift * 1000)

    if (Math.abs(drift) <= TOLERANCE_SEC) {
      if (el.playbackRate !== 1) el.playbackRate = 1
      return false
    }

    if (Math.abs(drift) > HARD_SEEK_SEC) {
      el.playbackRate = 1
      el.currentTime = Math.min(target, el.duration)
      return true
    }

    // 中间地带：用速率微调慢慢追，听不出"跳"
    const rate = 1 + Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, drift))
    if (Math.abs(el.playbackRate - rate) > 0.002) {
      el.playbackRate = rate
      return true
    }
    return false
  }

  dispose(): void {
    const el = this.el
    if (el) {
      el.playbackRate = 1
      el.pause()
    }
    this.el = null
  }
}
