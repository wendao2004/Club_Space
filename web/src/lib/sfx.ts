/**
 * 音效（现场合成，仓库里不含任何音频文件）。
 *
 * **为什么不用 mp3**：本机拿不到任何素材（没有外网、没有素材库），而为了几声
 * "落子"往仓库里塞几个音频文件也不划算 —— 版权来源说不清，体积还不小。
 * 所以这里用 Web Audio 现场合成。合成还有个附带好处：**能跟着场景变**
 * （吃子比落子重、将军比落子尖），而不是回放同一段固定录音。
 *
 * **为什么照着 Windows 做**：需求是"操作习惯贴近 Windows"。声音是这套习惯的
 * 一部分 —— 开窗是一声轻快的上行、关窗是下行、出错是低沉的警示。用户不必
 * 盯着屏幕，听一耳朵就知道刚才那下成了没有。命名与触发点都按 Windows 的语义来：
 *
 * | 动作 | 声音 | 对应 Windows |
 * |---|---|---|
 * | 登录进桌面 | `startup` | 启动音 |
 * | 打开 / 关闭窗口 | `open` / `close` | 导航开始 / 结束 |
 * | 最小化 / 最大化 / 还原 | 同名 | 窗口状态切换 |
 * | 通知、聊天消息 | `notify` / `message` | 通知音 |
 * | 操作成功 / 警告 / 出错 | `success` / `warning` / `error` | 完成 / 警告 / 严重停止 |
 * | 菜单、任务栏点击 | `click` | 极轻的点击 |
 * | 删除文件 | `trash` | 回收站 |
 * | 退出登录 | `lock` | 注销 |
 *
 * 五条约束：
 *   1. **浏览器要求先有用户手势**才能出声。这里的做法是"第一次要出声时才建
 *      AudioContext"—— 那一刻几乎总是用户点出来的，所以不会被拦。
 *      万一被拦（比如对手的落子先到），静默失败即可，绝不能因此报错卡住界面。
 *   2. **偏好要持久化**：下棋时旁边有人睡觉、或者在图书馆，用户点一次静音
 *      就不该每次重开窗口再点一次。三个键：静音 / 系统音效开关 / 音量。
 *   3. **系统音效可以单独关**：有人喜欢棋子的"啪"但不想要每次开窗都响一声。
 *      所以"静音"是总闸，`systemOn` 只管外壳这一层。
 *   4. **防连响**：同一个音在极短时间内重复触发（开窗时既 open 又 focus、
 *      一连串到货的通知）只响一次，否则会叠成噪音。
 *   5. 整套东西必须**能安全降级**：老浏览器、被策略禁用、AudioContext 抛错 ——
 *      一律当作"没有声音"，不抛异常。
 */
import { reactive } from 'vue'

const MUTE_KEY = 'wl.sfx.muted'
const SYSTEM_KEY = 'wl.sfx.system'
const VOLUME_KEY = 'wl.sfx.volume'

/** 系统音效（外壳层）。棋牌自己的声音在下面单独导出。 */
export type SystemSound =
  | 'startup'
  | 'open'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'notify'
  | 'message'
  | 'success'
  | 'warning'
  | 'error'
  | 'click'
  | 'trash'
  | 'lock'

export const SYSTEM_SOUND_LABELS: Record<SystemSound, string> = {
  startup: '启动',
  open: '打开窗口',
  close: '关闭窗口',
  minimize: '最小化',
  maximize: '最大化',
  restore: '还原',
  notify: '通知',
  message: '新消息',
  success: '完成',
  warning: '警告',
  error: '出错',
  click: '点击',
  trash: '删除',
  lock: '退出登录',
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw === null) return 0.65
    const n = Number(raw)
    if (!Number.isFinite(n)) return 0.65
    return Math.min(1, Math.max(0, n))
  } catch {
    return 0.65
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写不进去，只是这一会话不记住而已 */
  }
}

/**
 * 声音偏好。做成响应式的，是为了让"设置页里拨的开关"与"游戏窗口里的那个喇叭
 * 图标"永远是同一个状态 —— 两处各自拿一个 ref 就会漂移。
 */
export const soundState = reactive({
  /** 总闸：所有声音（含棋牌）都不响 */
  muted: readBool(MUTE_KEY, false),
  /** 系统音效（开窗 / 通知 / 出错这些外壳声音）单独开关 */
  systemOn: readBool(SYSTEM_KEY, true),
  /** 0 - 1 */
  volume: readVolume(),
})

export function isMuted(): boolean {
  return soundState.muted
}

export function setMuted(next: boolean): void {
  soundState.muted = next
  write(MUTE_KEY, next ? '1' : '0')
}

export function toggleMuted(): boolean {
  setMuted(!soundState.muted)
  return soundState.muted
}

export function isSystemSoundOn(): boolean {
  return soundState.systemOn
}

export function setSystemSoundOn(next: boolean): void {
  soundState.systemOn = next
  write(SYSTEM_KEY, next ? '1' : '0')
  // 打开的时候顺手响一声，让用户立刻确认"确实有声音了"
  if (next) playSystem('notify', { force: true })
}

export function setVolume(next: number): void {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(next) ? next : 0))
  soundState.volume = clamped
  write(VOLUME_KEY, String(Math.round(clamped * 100)))
  applyVolume()
}

// ---------------------------------------------------------------- 音频图

let ctx: AudioContext | null = null
let master: GainNode | null = null
let unavailable = false

/**
 * 音量曲线。
 *
 * 滑块是线性的，但耳朵对响度不是线性的（约按幂函数感知）。直接拿滑块值当增益，
 * 中段听起来几乎和最大一样响、往小调又掉得太突然。这里取 1.7 次幂折中：
 * 一半的位置听起来差不多就是"一半"。
 */
function gainFor(volume: number): number {
  return volume <= 0 ? 0 : volume ** 1.7
}

function applyVolume(): void {
  if (!ctx || !master) return
  try {
    master.gain.setTargetAtTime(gainFor(soundState.volume), ctx.currentTime, 0.02)
  } catch {
    /* 忽略 */
  }
}

/** 拿 AudioContext 与总音量节点；拿不到就永久降级（不要每次调用都重试一遍）。 */
function rig(): { audio: AudioContext; out: GainNode } | null {
  if (unavailable || soundState.muted) return null
  if (ctx && master) {
    // 有些浏览器会把挂起的 context 留着（切后台、省电模式），恢复一下再发声
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return { audio: ctx, out: master }
  }
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      unavailable = true
      return null
    }
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = gainFor(soundState.volume)
    master.connect(ctx.destination)
    return { audio: ctx, out: master }
  } catch {
    unavailable = true
    return null
  }
}

interface ToneOptions {
  /** 频率（Hz） */
  freq: number
  /** 相对现在的起始秒数 */
  start: number
  /** 持续秒数 */
  duration: number
  /** 峰值增益（0-1） */
  gain: number
  type?: OscillatorType
  /** 起音时间；默认 12ms（够快，不会"咔"）。垫音色给 0.1-0.3 秒 */
  attack?: number
}

/** 一段带包络的振荡音。 */
function tone(audio: AudioContext, out: GainNode, options: ToneOptions): void {
  const osc = audio.createOscillator()
  const amp = audio.createGain()
  osc.type = options.type ?? 'triangle'
  osc.frequency.setValueAtTime(options.freq, audio.currentTime + options.start)

  const t0 = audio.currentTime + options.start
  const t1 = t0 + options.duration
  const attack = Math.min(options.attack ?? 0.012, options.duration * 0.6)
  // 用指数衰减而不是方波开关：直接开关会有一声"咔"（包络不连续）
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(Math.max(options.gain, 0.0002), t0 + attack)
  amp.gain.exponentialRampToValueAtTime(0.0001, t1)

  osc.connect(amp)
  amp.connect(out)
  osc.start(t0)
  osc.stop(t1 + 0.02)
}

interface NoiseOptions {
  start: number
  duration: number
  gain: number
  /** 带通中心频率 */
  freq: number
  /** 可选：噪声结束时中心频率滑到这里（"唰"的那种感觉） */
  sweepTo?: number
}

/** 一段噪声（"啪"的那一下，木头棋子落在棋盘上的质感）。 */
function noise(audio: AudioContext, out: GainNode, options: NoiseOptions): void {
  const frames = Math.max(1, Math.floor(audio.sampleRate * options.duration))
  const buffer = audio.createBuffer(1, frames, audio.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) {
    // 白噪声 + 快速衰减的包络：听起来像一次"敲击"而不是"沙沙声"
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3
  }
  const src = audio.createBufferSource()
  src.buffer = buffer

  const filter = audio.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 0.8
  const t0 = audio.currentTime + options.start
  filter.frequency.setValueAtTime(options.freq, t0)
  if (options.sweepTo) {
    filter.frequency.exponentialRampToValueAtTime(options.sweepTo, t0 + options.duration)
  }

  const amp = audio.createGain()
  amp.gain.value = options.gain

  src.connect(filter)
  filter.connect(amp)
  amp.connect(out)
  src.start(t0)
  src.stop(t0 + options.duration + 0.02)
}

// ---------------------------------------------------------------- 系统音效

/**
 * 每个音效的合成配方。
 *
 * 集中写在这里而不是散在调用点上，是为了"音色"只在一处定义：想统一调轻一点、
 * 或者换个和弦，改这一个表就行。
 */
const RECIPES: Record<SystemSound, (audio: AudioContext, out: GainNode) => void> = {
  /** 启动：低音垫 + 上行四音，像开机那一下 */
  startup(audio, out) {
    tone(audio, out, { freq: 196, start: 0, duration: 1.5, gain: 0.05, type: 'sine', attack: 0.3 })
    tone(audio, out, { freq: 392, start: 0.04, duration: 1.4, gain: 0.04, type: 'sine', attack: 0.35 })
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((freq, i) => {
      tone(audio, out, {
        freq,
        start: 0.14 + i * 0.14,
        duration: 1.05 - i * 0.12,
        gain: 0.07,
        type: 'sine',
        attack: 0.05,
      })
    })
  },

  /** 打开窗口：上行两音（「导航开始」的感觉） */
  open(audio, out) {
    tone(audio, out, { freq: 587.33, start: 0, duration: 0.1, gain: 0.075 })
    tone(audio, out, { freq: 880, start: 0.055, duration: 0.17, gain: 0.065 })
  },

  /** 关闭窗口：下行两音 */
  close(audio, out) {
    tone(audio, out, { freq: 880, start: 0, duration: 0.1, gain: 0.06 })
    tone(audio, out, { freq: 587.33, start: 0.06, duration: 0.15, gain: 0.07 })
  },

  /** 最小化：往下沉 */
  minimize(audio, out) {
    tone(audio, out, { freq: 523.25, start: 0, duration: 0.07, gain: 0.062, type: 'sine' })
    tone(audio, out, { freq: 392, start: 0.05, duration: 0.11, gain: 0.062, type: 'sine' })
  },

  /** 最大化：往上抬 */
  maximize(audio, out) {
    tone(audio, out, { freq: 392, start: 0, duration: 0.07, gain: 0.06, type: 'sine' })
    tone(audio, out, { freq: 523.25, start: 0.05, duration: 0.11, gain: 0.06, type: 'sine' })
  },

  /** 还原：比最大化更轻，避免"每次动窗口都在叫" */
  restore(audio, out) {
    tone(audio, out, { freq: 440, start: 0, duration: 0.08, gain: 0.045, type: 'sine' })
    tone(audio, out, { freq: 587.33, start: 0.05, duration: 0.12, gain: 0.04, type: 'sine' })
  },

  /** 通知：两声"叮—咚"，加一层高八度泛音做出钟的亮感 */
  notify(audio, out) {
    tone(audio, out, { freq: 1046.5, start: 0, duration: 0.45, gain: 0.085, type: 'sine' })
    tone(audio, out, { freq: 2093, start: 0, duration: 0.22, gain: 0.018, type: 'sine' })
    tone(audio, out, { freq: 1318.51, start: 0.11, duration: 0.5, gain: 0.07, type: 'sine' })
  },

  /** 新消息：单声、更短更轻 —— 聊天可能连着来好几条 */
  message(audio, out) {
    tone(audio, out, { freq: 987.77, start: 0, duration: 0.26, gain: 0.06, type: 'sine' })
    tone(audio, out, { freq: 1318.51, start: 0.085, duration: 0.3, gain: 0.045, type: 'sine' })
  },

  /** 操作完成：干净的两音上行，不带情绪 */
  success(audio, out) {
    tone(audio, out, { freq: 783.99, start: 0, duration: 0.1, gain: 0.055, type: 'sine' })
    tone(audio, out, { freq: 1046.5, start: 0.075, duration: 0.16, gain: 0.05, type: 'sine' })
  },

  /** 警告：同音两声，不刺耳但能注意到 */
  warning(audio, out) {
    tone(audio, out, { freq: 466.16, start: 0, duration: 0.11, gain: 0.055 })
    tone(audio, out, { freq: 466.16, start: 0.16, duration: 0.11, gain: 0.05 })
  },

  /** 出错：三个短促低音（「严重停止」的意思，但压低音量不吓人） */
  error(audio, out) {
    ;[0, 0.13, 0.26].forEach((start, i) => {
      tone(audio, out, {
        freq: i === 2 ? 233.08 : 311.13,
        start,
        duration: 0.11,
        gain: 0.06,
        type: 'triangle',
      })
    })
  },

  /** 点击：极轻的一记"哒"，只用在菜单这类高频动作上 */
  click(audio, out) {
    noise(audio, out, { start: 0, duration: 0.028, gain: 0.05, freq: 2600 })
    tone(audio, out, { freq: 1200, start: 0, duration: 0.02, gain: 0.02, type: 'sine' })
  },

  /** 删除：噪声往下扫 + 一记闷响，像东西掉进回收站 */
  trash(audio, out) {
    noise(audio, out, { start: 0, duration: 0.2, gain: 0.11, freq: 1700, sweepTo: 380 })
    tone(audio, out, { freq: 146.83, start: 0.02, duration: 0.16, gain: 0.07, type: 'sine' })
  },

  /** 退出登录：下行四音（与启动音成对） */
  lock(audio, out) {
    ;[659.25, 523.25, 440, 329.63].forEach((freq, i) => {
      tone(audio, out, {
        freq,
        start: i * 0.11,
        duration: 0.28,
        gain: 0.05,
        type: 'sine',
        attack: 0.03,
      })
    })
  },
}

/** 同一个音的连响保护：窗口 open + focus 常常在同一帧里一起触发。 */
const lastAt = new Map<SystemSound, number>()

/**
 * 播放一个系统音效。
 *
 * `force` 只给设置页的「试听」用：即使系统音效关着、或者全局静音，用户明确
 * 点了试听也该听到声音 —— 否则那个按钮看起来就是坏的。
 */
export function playSystem(name: SystemSound, options?: { force?: boolean }): void {
  const force = options?.force ?? false
  if (!force && !soundState.systemOn) return

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prev = lastAt.get(name) ?? 0
  // 90ms 内的同一个音只响一次：开窗那一下 open 与 focus 是连着调的
  if (!force && now - prev < 90) return
  lastAt.set(name, now)

  const r = rig()
  if (!r) return
  try {
    RECIPES[name](r.audio, r.out)
  } catch {
    /* 出声失败不影响界面 */
  }
}

/** 设置页的试听按钮。 */
export function previewSystem(name: SystemSound): void {
  playSystem(name, { force: true })
}

// ---------------------------------------------------------------- 棋牌音效

/** 落子：一记短促的敲击声。 */
export function playMove(): void {
  const r = rig()
  if (!r) return
  try {
    noise(r.audio, r.out, { start: 0, duration: 0.06, gain: 0.28, freq: 1200 })
    tone(r.audio, r.out, { freq: 190, start: 0, duration: 0.09, gain: 0.18, type: 'sine' })
  } catch {
    /* 出声失败不影响下棋 */
  }
}

/** 吃子：比落子更沉、更长一点，耳朵一听就知道"这步有东西被吃了"。 */
export function playCapture(): void {
  const r = rig()
  if (!r) return
  try {
    noise(r.audio, r.out, { start: 0, duration: 0.1, gain: 0.34, freq: 700 })
    tone(r.audio, r.out, { freq: 130, start: 0, duration: 0.16, gain: 0.24, type: 'sine' })
    tone(r.audio, r.out, { freq: 95, start: 0.02, duration: 0.18, gain: 0.16, type: 'sine' })
  } catch {
    /* 忽略 */
  }
}

/** 将军：两个上行音，和"落子"完全不同的音色，隔着房间也听得出来。 */
export function playCheck(): void {
  const r = rig()
  if (!r) return
  try {
    tone(r.audio, r.out, { freq: 880, start: 0, duration: 0.12, gain: 0.22, type: 'square' })
    tone(r.audio, r.out, { freq: 1320, start: 0.11, duration: 0.16, gain: 0.2, type: 'square' })
  } catch {
    /* 忽略 */
  }
}

/** 绝杀：一小段上行琶音，比将军更长更亮。 */
export function playMate(): void {
  const r = rig()
  if (!r) return
  try {
    const notes = [523, 659, 784, 1046]
    notes.forEach((freq, i) => {
      tone(r.audio, r.out, { freq, start: i * 0.09, duration: 0.22, gain: 0.2 })
    })
    noise(r.audio, r.out, { start: 0, duration: 0.12, gain: 0.25, freq: 900 })
  } catch {
    /* 忽略 */
  }
}

/** 赢了：上行三音。 */
export function playWin(): void {
  const r = rig()
  if (!r) return
  try {
    ;[523, 659, 880].forEach((freq, i) => {
      tone(r.audio, r.out, { freq, start: i * 0.1, duration: 0.24, gain: 0.18 })
    })
  } catch {
    /* 忽略 */
  }
}

/** 输了：下行三音。 */
export function playLose(): void {
  const r = rig()
  if (!r) return
  try {
    ;[440, 349, 262].forEach((freq, i) => {
      tone(r.audio, r.out, { freq, start: i * 0.12, duration: 0.26, gain: 0.16, type: 'sine' })
    })
  } catch {
    /* 忽略 */
  }
}

/** 和棋：（中性）两声同音。 */
export function playDraw(): void {
  const r = rig()
  if (!r) return
  try {
    tone(r.audio, r.out, { freq: 392, start: 0, duration: 0.18, gain: 0.16 })
    tone(r.audio, r.out, { freq: 392, start: 0.16, duration: 0.18, gain: 0.14 })
  } catch {
    /* 忽略 */
  }
}
