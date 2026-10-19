/**
 * 音效。
 *
 * **没有用音频文件**：本机拿不到任何素材（没有外网、没有素材库），
 * 而为了几声"落子"去塞几个 mp3 进仓库也不划算。
 * 所以这里用 Web Audio 现场合成 —— 落子是一记"啪"，将军是两个上行音，
 * 绝杀是一小段琶音。合成的好处还有一条：**能跟着场景变**
 * （吃子比落子重、将军比落子尖），而不是回放同一段固定录音。
 *
 * 三条约束：
 *   1. **浏览器要求先有用户手势**才能出声。这里的做法是"第一次要出声时才建
 *      AudioContext"—— 那一刻几乎总是用户点棋盘触发的，所以不会被拦。
 *      万一被拦（比如对手的落子先到），静默失败即可，绝不能因此报错卡住界面。
 *   2. **静音开关要持久化**：下棋时旁边有人睡觉、或者在图书馆，用户点一次
 *      就不该每次重开窗口再点一次。
 *   3. 整套东西必须**能安全降级**：老浏览器、被策略禁用、AudioContext 抛错 ——
 *      一律当作"没有声音"，不抛异常。
 */

const STORAGE_KEY = 'wl.sfx.muted'

let ctx: AudioContext | null = null
let unavailable = false
let muted = readMuted()

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(next: boolean): void {
  muted = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    /* 隐私模式下写不进去，只是这一会话不记住而已 */
  }
}

export function toggleMuted(): boolean {
  setMuted(!muted)
  return muted
}

/** 拿 AudioContext；拿不到就永久降级（不要每次调用都重试一遍）。 */
function context(): AudioContext | null {
  if (unavailable || muted) return null
  if (ctx) {
    // 有些浏览器会把挂起的 context 留着（切后台、省电模式），恢复一下再发声
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      unavailable = true
      return null
    }
    ctx = new Ctor()
    return ctx
  } catch {
    unavailable = true
    return null
  }
}

/** 一段带包络的振荡音（"嘀"）。 */
function tone(
  audio: AudioContext,
  options: { freq: number; start: number; duration: number; gain: number; type?: OscillatorType },
): void {
  const osc = audio.createOscillator()
  const amp = audio.createGain()
  osc.type = options.type ?? 'triangle'
  osc.frequency.setValueAtTime(options.freq, audio.currentTime + options.start)

  const t0 = audio.currentTime + options.start
  const t1 = t0 + options.duration
  // 用指数衰减而不是方波开关：直接开关会有一声"咔"（包络不连续）
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(options.gain, t0 + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, t1)

  osc.connect(amp)
  amp.connect(audio.destination)
  osc.start(t0)
  osc.stop(t1 + 0.02)
}

/** 一段噪声（"啪"的那一下，木头棋子落在棋盘上的质感）。 */
function noise(
  audio: AudioContext,
  options: { start: number; duration: number; gain: number; freq: number },
): void {
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
  filter.frequency.value = options.freq
  filter.Q.value = 0.8

  const amp = audio.createGain()
  amp.gain.value = options.gain

  const t0 = audio.currentTime + options.start
  src.connect(filter)
  filter.connect(amp)
  amp.connect(audio.destination)
  src.start(t0)
  src.stop(t0 + options.duration + 0.02)
}

/** 落子：一记短促的敲击声。 */
export function playMove(): void {
  const audio = context()
  if (!audio) return
  try {
    noise(audio, { start: 0, duration: 0.06, gain: 0.28, freq: 1200 })
    tone(audio, { freq: 190, start: 0, duration: 0.09, gain: 0.18, type: 'sine' })
  } catch {
    /* 出声失败不影响下棋 */
  }
}

/** 吃子：比落子更沉、更长一点，耳朵一听就知道"这步有东西被吃了"。 */
export function playCapture(): void {
  const audio = context()
  if (!audio) return
  try {
    noise(audio, { start: 0, duration: 0.1, gain: 0.34, freq: 700 })
    tone(audio, { freq: 130, start: 0, duration: 0.16, gain: 0.24, type: 'sine' })
    tone(audio, { freq: 95, start: 0.02, duration: 0.18, gain: 0.16, type: 'sine' })
  } catch {
    /* 忽略 */
  }
}

/** 将军：两个上行音，和"落子"完全不同的音色，隔着房间也听得出来。 */
export function playCheck(): void {
  const audio = context()
  if (!audio) return
  try {
    tone(audio, { freq: 880, start: 0, duration: 0.12, gain: 0.22, type: 'square' })
    tone(audio, { freq: 1320, start: 0.11, duration: 0.16, gain: 0.2, type: 'square' })
  } catch {
    /* 忽略 */
  }
}

/** 绝杀：一小段上行琶音，比将军更长更亮。 */
export function playMate(): void {
  const audio = context()
  if (!audio) return
  try {
    const notes = [523, 659, 784, 1046]
    notes.forEach((freq, i) => {
      tone(audio, { freq, start: i * 0.09, duration: 0.22, gain: 0.2 })
    })
    noise(audio, { start: 0, duration: 0.12, gain: 0.25, freq: 900 })
  } catch {
    /* 忽略 */
  }
}

/** 赢了：上行三音。 */
export function playWin(): void {
  const audio = context()
  if (!audio) return
  try {
    ;[523, 659, 880].forEach((freq, i) => {
      tone(audio, { freq, start: i * 0.1, duration: 0.24, gain: 0.18 })
    })
  } catch {
    /* 忽略 */
  }
}

/** 输了：下行三音。 */
export function playLose(): void {
  const audio = context()
  if (!audio) return
  try {
    ;[440, 349, 262].forEach((freq, i) => {
      tone(audio, { freq, start: i * 0.12, duration: 0.26, gain: 0.16, type: 'sine' })
    })
  } catch {
    /* 忽略 */
  }
}

/** 和棋：（中性）两声同音。 */
export function playDraw(): void {
  const audio = context()
  if (!audio) return
  try {
    tone(audio, { freq: 392, start: 0, duration: 0.18, gain: 0.16 })
    tone(audio, { freq: 392, start: 0.16, duration: 0.18, gain: 0.14 })
  } catch {
    /* 忽略 */
  }
}
