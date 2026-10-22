/**
 * 听歌房的同步播放引擎。
 *
 * 为什么需要它：之前是"各播各的" —— 客户端拿**自己的** `Date.now()` 去减
 * 服务端的 `startedAt`，两台机器时钟差几秒，听到的就是两首歌。真正的同步
 * 要解决三件事：
 *
 * 1. **时钟对齐**：用 `/api/music/time` 采样几次，按 RTT 最小的一次估出
 *    "服务端时钟 - 本地时钟"的偏移。之后所有进度推算都走 `serverNow()`。
 * 2. **漂移校正**：浏览器缓冲、切后台、网络抖动都会让进度慢慢跑偏。每秒
 *    对一次目标位置，偏差超过 0.45 秒才 seek（阈值太小会不停抽搐）。
 * 3. **共享暂停**：暂停是厅级状态（服务端存 paused_position_ms），
 *    所有人一起停、一起续，续播时把 started_at 往回拨已播时长。
 *
 * 另外提供可选的"房间音效"：同一路音频过一个短混响 + 按座位分配的声像，
 * 听起来像坐在同一个房间里。注意这是**听感效果**，不是多路音源。
 */

/** 播放状态（服务端给的权威数据）。 */
export interface SyncSource {
  nodeId: string
  playedToken: number
  startedAt: number
  paused: boolean
  positionMs: number
}

/** 允许多大偏差（秒）才触发 seek。太小会因为缓冲抖动来回跳。 */
const DRIFT_TOLERANCE_SEC = 0.45

/**
 * 估算服务端时钟偏移（毫秒）。取三次采样里 RTT 最小的那次 ——
 * 网络越顺，`serverNow - (发送+接收)/2` 越准。
 */
export async function measureClockOffset(fetchNow: () => Promise<number>): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 }
  for (let i = 0; i < 3; i++) {
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

/** 生成一段"房间"脉冲响应：指数衰减的噪声，越靠后越弱。 */
function roomImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.max(1, Math.floor(rate * seconds))
  const buffer = ctx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      const decay = (1 - i / len) ** 2.6
      data[i] = (Math.random() * 2 - 1) * decay * 0.6
    }
  }
  return buffer
}

/** 稳定地把一个字符串映射到 [-1, 1] 的声像位置（同一个人每次都在同一侧）。 */
export function seatPan(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const norm = ((hash >>> 0) % 1000) / 1000 // 0..1
  return Number((norm * 1.4 - 0.7).toFixed(2)) // -0.7..0.7，贴边太假
}

export class SyncedPlayer {
  private el: HTMLAudioElement | null = null
  private clockOffset = 0
  private fxOn = false
  private ctx: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private nodes: AudioNode[] = []
  /** 浏览器拦了自动播放（没有用户手势）时置位，界面据此显示"点一下开始"。 */
  blocked = false
  /** 空间音效的声像位置（由座位决定）。 */
  pan = 0

  attach(el: HTMLAudioElement): void {
    this.el = el
    // 换源之后（<audio> 用了 :key 重建）要重新接音频图
    if (this.fxOn && el) this.rebuildFx()
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
   * 把播放器拉到目标状态。每秒调一次（tick 里）。
   * 返回 true 表示这次做过校正（界面可以用来显示"已对齐"）。
   */
  enforce(src: SyncSource): boolean {
    const el = this.el
    if (!el) return false
    const target = this.targetMs(src) / 1000
    if (!Number.isFinite(el.duration) || el.duration <= 0) return false

    if (src.paused) {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - target) > 1) el.currentTime = Math.min(target, el.duration)
      return false
    }

    if (el.paused) {
      el.currentTime = Math.min(target, el.duration)
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

    if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE_SEC) {
      el.currentTime = Math.min(target, el.duration)
      return true
    }
    return false
  }

  /** 换曲时调用：重置播放位置（进度由随后的 enforce 校正）。 */
  resetTo(src: SyncSource): void {
    const el = this.el
    if (!el) return
    this.blocked = false
    el.currentTime = Math.min(this.targetMs(src) / 1000, Number.isFinite(el.duration) ? el.duration : 0)
  }

  /**
   * 开关"房间音效"。
   *
   * 关了之后会把 <audio> 重新加载一次 —— MediaElementSource 一旦建出来就
   * 无法撤销，想回到原生输出只能重载媒体元素（会短暂中断，可接受）。
   */
  setRoomFx(on: boolean): void {
    if (on === this.fxOn) return
    this.fxOn = on
    if (on) this.rebuildFx()
    else this.teardownFx()
  }

  private rebuildFx(): void {
    const el = this.el
    if (!el) return
    this.teardownFx(false)
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(el)
      const panner = ctx.createStereoPanner()
      panner.pan.value = this.pan
      const dry = ctx.createGain()
      dry.gain.value = 0.85
      const wet = ctx.createGain()
      wet.gain.value = 0.22
      const conv = ctx.createConvolver()
      conv.buffer = roomImpulse(ctx, 0.7)

      source.connect(panner)
      panner.connect(dry)
      dry.connect(ctx.destination)
      panner.connect(conv)
      conv.connect(wet)
      wet.connect(ctx.destination)

      this.ctx = ctx
      this.source = source
      this.nodes = [panner, dry, wet, conv]
      void ctx.resume()
    } catch {
      // 某些浏览器在无手势时不让建 AudioContext —— 静默退回原生输出
      this.fxOn = false
      this.teardownFx()
    }
  }

  /** 拆图。`reload` 为 true 时重载媒体元素以恢复原生输出。 */
  private teardownFx(reload = true): void {
    for (const node of this.nodes) {
      try {
        node.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    this.nodes = []
    try {
      this.source?.disconnect()
    } catch {
      /* 已断开 */
    }
    this.source = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    if (reload && this.el) {
      const el = this.el
      const at = el.currentTime
      el.load()
      el.addEventListener(
        'loadedmetadata',
        () => {
          el.currentTime = at
          void el.play().catch(() => undefined)
        },
        { once: true },
      )
    }
  }

  dispose(): void {
    this.teardownFx(false)
    this.el = null
  }
}
