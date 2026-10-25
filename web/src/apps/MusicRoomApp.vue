<!--
  听歌房：全站一个厅，共享队列与**共享播放进度**。

  同步靠两层：
  - 时钟（web/src/lib/music-clock.ts）：用 performance.now() 锚定服务端时间，
    采样失败保留旧锚点、绝不写 0；没有有效锚点时**不出声**，显示"正在对时"。
  - 播放器（web/src/lib/music-player.ts）：每 500ms 对一次进度，
    偏差 40ms 内不动、400ms 内用 playbackRate 微调、再大才 seek。

  两条容易踩的线：
  - `playingToken` 是**这个 <audio> 元素自己**播的那一首的 token。上报播完
    时必须用它，不能用房间当前的 token —— 慢设备播完上一首时房间可能已经
    切到下一首了。
  - 换曲/掉出厅时先 `player.detach()` 再换 src：Vue 的 `:key` 只负责销毁
    DOM，不会替我们 pause 元素；脱离 DOM 的 <audio> 会继续出声。

  暂停/继续是厅级状态，所有人一起停、一起续。播完由任意客户端上报切歌
  （playedToken 防止旧上报错切新曲）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api } from '@/api'
import { SyncedPlayer } from '@/lib/music-player'
import {
  calibrate,
  detectSleep,
  isCalibrated,
  nextRetryDelayMs,
  wasEverCalibrated,
} from '@/lib/music-clock'
import { soundState, volumeGain } from '@/lib/sfx'
import { useMusic } from '@/stores/music'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

defineProps<{ win: WindowInstance }>()

const music = useMusic()
const auth = useAuth()
const ui = useUi()

// ---------------------------------------------------------------- 播放器

const audioEl = ref<HTMLAudioElement | null>(null)
/**
 * 在线曲库**单人试听**专用的独立 `<audio>`。
 *
 * 绝不与 audioEl 共用：audioEl 由 music-player 每 500ms 往房间目标位置校正一次，
 * 让一条随时会断/时长对不上的外网流去驱动它，等于把全厅的播放位置交给它。
 * 两个元素分开，房间同步与单人试听互不干扰。
 */
const previewEl = ref<HTMLAudioElement | null>(null)
/** 正在加载的曲目 id：换曲时用来触发 <audio> 重新拉流。 */
const playingNodeId = ref<string | null>(null)
/**
 * 这个 <audio> 元素**自己**在播的那一首的 token。
 *
 * 不能在上报时读 room.nowPlaying.playedToken：慢半拍的设备播完上一首时，
 * SSE 可能已经把房间推进到下一首了，用房间的 token 上报会被服务端当成
 * "下一首播完了"，于是全厅跳歌。
 */
const playingToken = ref<number | null>(null)

const player = new SyncedPlayer()

/**
 * 把全站音量接到听歌房的 `<audio>` 上。
 *
 * 任务栏喇叭与设置里的"声音"页调的是同一份 `soundState.volume`（总闸
 * `soundState.muted` 也是同一份）。以前它只作用于 WebAudio 音效 ——
 * 静音了，听歌房还在满音量播放。这里让音乐元素也走同一套感知曲线。
 *
 * 注意只改元素音量、不暂停：静音时歌曲仍然按时间线前进，取消静音后
 * 位置是对的（暂停会破坏同步）。
 */
function applyMusicVolume(): void {
  const el = audioEl.value
  if (el) {
    el.muted = soundState.muted
    el.volume = volumeGain()
  }
  // 试听是另一只 <audio>，总闸同样要管它 —— 否则静音了试听还在响，用户找不到原因
  const preview = previewEl.value
  if (preview) {
    preview.muted = soundState.muted
    preview.volume = volumeGain()
  }
}

watch(
  () => [soundState.volume, soundState.muted] as const,
  () => applyMusicVolume(),
)

/** 浏览器拦了自动播放时要显示"点一下开始"。 */
const blocked = ref(false)
/** 同步精度（毫秒）：给用户看"我们现在差多少"，也是空间声场的前提。 */
const syncOffsetMs = ref(0)
/** 服务端时钟是否已校准。未校准时**不出声**，显示"正在对时"。 */
const clockReady = ref(false)
/** 时钟校准失败过（用于文案：从未对时 vs 对时失联）。 */
const clockFailed = ref(false)

const nowPlaying = computed(() => music.room?.nowPlaying ?? null)
const queue = computed(() => music.room?.queue ?? [])
/** 在不在厅里：打开窗口**不等于**加入，得自己点。 */
const inRoom = computed(() => music.room?.inRoom ?? false)
const members = computed(() => music.room?.members ?? [])

/** 加入/离开。加入之后才开始同步播放与心跳。 */
async function joinRoom(): Promise<void> {
  await music.join()
}

async function leaveRoomAction(): Promise<void> {
  player.detach()
  playingNodeId.value = null
  playingToken.value = null
  await music.leave()
}

/**
 * 心跳：120 秒不续就算离开。
 *
 * 30 秒一次而不是 40 秒：后台标签页的定时器可能被压到 1 次/分钟，
 * 留出至少三次机会。心跳的返回值里带 inRoom —— 服务端如果已经把你判
 * 出去了，store 会自动重新加入，而不是让播放器被卸载。
 */
const heartbeatTimer = window.setInterval(() => {
  if (inRoom.value || music.desiredInRoom) void music.heartbeat()
}, 30_000)
onBeforeUnmount(() => {
  window.clearInterval(heartbeatTimer)
  // 关窗口 = 离开厅（异步发出去就行，不等结果）
  if (inRoom.value) void music.leave()
})

/** 界面上的"已播"进度（秒）。每 500ms 现算，不能放进 computed。 */
const displayProgress = ref(0)
/** 上一次 tick 的墙钟/单调钟，用来发现系统休眠。 */
let lastWall = 0
let lastPerf = 0
let clockRetryTimer: number | null = null

const progressTimer = window.setInterval(() => {
  const np = nowPlaying.value

  // 合盖唤醒：墙钟走了很多、单调钟没走（或反过来）—— 旧锚点已经不可信
  const wallNow = Date.now()
  const perfNow = performance.now()
  if (lastWall > 0 && detectSleep(wallNow - lastWall, perfNow - lastPerf)) {
    clockReady.value = false
    void syncClock()
  }
  lastWall = wallNow
  lastPerf = perfNow

  clockReady.value = isCalibrated()

  if (!np) {
    displayProgress.value = 0
    return
  }

  // 现算进度。以前这里是 computed，而 computed 只依赖 nowPlaying；
  // Date.now() 不是响应式依赖，于是整首歌的进度都是缓存值 —— 界面
  // 上的"已播 0:37"会一路冻结到下一次 SSE 事件。
  displayProgress.value = Math.max(0, player.targetMs(np) / 1000)

  // 没有服务端时钟就不出声：宁可显示"正在对时"，也不要带着错误基准播
  if (!isCalibrated()) return

  // 500ms 一次：偏差 40ms 内不动、400ms 内用速率微调、再大才 seek
  player.enforce(np)
  blocked.value = player.blocked
  syncOffsetMs.value = Math.abs(player.lastOffsetMs)
}, 500)

function formatTime(sec: number): string {
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 时钟对齐。
 *
 * 失败时**保留上一次有效锚点**（music-clock 里保证），并且立刻排一次
 * 快速重试（1/2/4/8… 秒），而不是干等 60 秒。一次 WiFi 漫游就能让
 * 5 次采样全部失败；旧实现会把 0 直接写进播放器，等于退回裸墙钟。
 */
async function syncClock(): Promise<void> {
  const ok = await calibrate(async () => (await api.music.time()).now)
  clockReady.value = isCalibrated()
  clockFailed.value = !ok
  // 失败就排重试，哪怕旧锚点还能用 —— 它可能已经不准了
  if (!ok && clockRetryTimer === null) {
    clockRetryTimer = window.setTimeout(() => {
      clockRetryTimer = null
      void syncClock()
    }, nextRetryDelayMs())
  }
}

const clockTimer = window.setInterval(() => void syncClock(), 60_000)

/** 回到前台/网络恢复：立刻重测时钟并补拉房间（后台期间可能全错过）。 */
function onWake(): void {
  void syncClock()
  void music.load()
  void music.heartbeat()
}

onBeforeUnmount(() => {
  window.clearInterval(clockTimer)
  window.clearInterval(progressTimer)
  if (clockRetryTimer !== null) window.clearTimeout(clockRetryTimer)
})

watch(
  audioEl,
  (el) => {
    if (!el) return
    player.attach(el)
    // 新元素挂载/换曲重建后，立刻套用当前的全站音量与静音状态
    applyMusicVolume()
    // 换曲/首次挂载后立刻对齐一次
    const np = nowPlaying.value
    if (np) player.enforce(np)
  },
  { immediate: true },
)

watch(
  nowPlaying,
  (np, old) => {
    if (!np) {
      // 停播：必须显式松开元素。只把引用置空的话，脱离 DOM 的元素还会
      // 继续出声，而界面里已经没有能停掉它的按钮了。
      player.detach()
      playingNodeId.value = null
      playingToken.value = null
      return
    }
    if (np.nodeId !== playingNodeId.value) {
      // :key 换曲会销毁旧元素。Vue 不会替我们 pause 它 —— 先松开，
      // 否则旧元素脱离 DOM 后继续播放，就是"两个声部叠在一起"。
      player.detach()
      playingToken.value = np.playedToken
      playingNodeId.value = np.nodeId
      return
    }
    if (np.playedToken !== old?.playedToken) {
      // 同一首歌重播（极少见）：token 变了，元素没重建，显式回到起点
      const el = audioEl.value
      if (el && Number.isFinite(el.duration)) el.currentTime = 0
      playingToken.value = np.playedToken
      player.enforce(np)
    }
  },
  { immediate: true },
)

/** 掉出厅（被 TTL 判离开、或自己点了离开）时立刻停声并松开元素。 */
watch(inRoom, (inside) => {
  if (inside) return
  player.detach()
  playingNodeId.value = null
  playingToken.value = null
})

function onLoadedMetadata(): void {
  const np = nowPlaying.value
  const el = audioEl.value
  if (!np || !el) return
  player.attach(el)
  player.enforce(np)
}

async function onEnded(): Promise<void> {
  const np = nowPlaying.value
  if (!np) return
  // 暂停状态下的 ended 不会推进（服务端也会拒绝），这里提前挡掉
  if (np.paused) return
  // 上报的是**这个元素**播的那一首的 token，不是房间当前的 token。
  // 慢设备播完上一首时，房间可能已经推进到下一首了 —— 用房间 token
  // 上报会被服务端接受，于是全厅跳掉刚开播的下一首。
  const token = playingToken.value
  if (token === null) return
  await music.ended(token)
}

/** 暂停/继续是**厅级操作**：影响所有人（按钮文案里写清楚）。 */
async function togglePlay(): Promise<void> {
  const np = nowPlaying.value
  if (!np) return
  if (np.paused) await music.resume()
  else await music.pause()
}

/** 浏览器拦截后，用户点这里的按钮 = 给了手势，可以正常播放。 */
async function unlockAudio(): Promise<void> {
  const np = nowPlaying.value
  const el = audioEl.value
  if (!el || !np) return
  el.currentTime = Math.min(player.targetMs(np) / 1000, el.duration || 0)
  await el.play().catch(() => undefined)
  player.blocked = false
  blocked.value = false
}



// ---------------------------------------------------------------- 队列操作

const picking = ref(false)

async function openPicker(): Promise<void> {
  picking.value = true
  await music.loadTracks()
}

async function enqueue(nodeId: string): Promise<void> {
  // 只有"从文件里挑"才会走到这里。在线曲库那条路径**没有** enqueue 调用 —— 见下面在线曲库一节。
  const ok = await music.enqueue(nodeId)
  if (ok) {
    closePicker()
  } else if (music.error) {
    ui.notify('error', '排播失败', music.error)
  }
}

async function removeQueued(itemId: string): Promise<void> {
  await music.removeQueued(itemId)
}

async function skip(): Promise<void> {
  await music.skip()
}

/**
 * 走听歌房自己的流通道（/api/music/stream）。
 *
 * 不能用 preview：preview 要求 canRead，而排歌只校验"排歌人自己能读"——
 * 私人目录里的歌，除上传者外所有人 403，<audio> 静默失败，表现就是
 * "只有上传者那台电脑有声音"。厅内流通道只认"这首歌在不在厅里"。
 */
function trackUrl(nodeId: string): string {
  return `/api/music/stream/${encodeURIComponent(nodeId)}`
}

/** <audio> 加载失败——之前是静默的，用户只感到"没声音"。 */
const audioError = ref<string | null>(null)

function onAudioError(): void {
  const el = audioEl.value
  const code = el?.error?.code
  audioError.value =
    code === 4
      ? '这首歌的格式浏览器放不了（试试 mp3 / m4a / wav）'
      : '音频加载失败 —— 可能已被移出听歌房，或者文件被删了'
  player.blocked = false
}


// ---------------------------------------------------------------- 在线曲库（只做单人试听）

/**
 * 一轮搜索 = 服务端聚合搜索（音源：哔哩哔哩）+ 服务端代理拉流，前端不直连外网 CDN。
 *
 * 一条硬规矩：**在线曲目永远不进队列**。厅里的播放进度是所有人共用的，
 * 一条外网流随时可能 404 / 断流 / 时长和服务端元数据对不上，混进队列就是
 * 全厅跳歌。所以这里只提供"试听"：独立的 <audio>，只响在点按钮的那台设备上。
 */
const pickerTab = ref<'files' | 'online'>('files')

/**
 * 服务端给的条目形状（契约：GET /api/music/online/search）。
 *
 * 语义上是**视频**而不是歌曲：name 是投稿标题，artist 是 UP 主名，
 * album 是分 P 之类的次要归属（可能为空）。durationMs 可能超过一小时。
 */
interface OnlineTrack {
  id: string
  name: string
  artist: string
  album: string
  durationMs: number
  playable: boolean
}

const onlineQuery = ref('')
const onlineLoading = ref(false)
/** 接口整体用不了（404 / 5xx / 断网）的文案 —— 和"搜不到"是两回事，要分开说。 */
const onlineUnavailableText = ref<string | null>(null)
/** 后端自己说这批结果不完整时给的提示（degraded + message）。 */
const onlineDegradedText = ref<string | null>(null)
const onlineResults = ref<OnlineTrack[]>([])
/** 搜过一轮没有：用来区分"还没搜"和"搜了但没结果"，两种空态文案不同。 */
const onlineSearched = ref(false)

/** 当前试听的是哪一首。null = 没在试听。 */
const previewId = ref<string | null>(null)
/** play() 还没返回（拉流慢的时候按钮要能显示"加载中"）。 */
const previewPending = ref(false)
/** 元素确实在出声。@playing / @pause 同步，避免按钮文案和实际状态不一致。 */
const previewing = ref(false)
const previewError = ref<string | null>(null)

/** 在线条目时长：不到一小时 m:ss，超过一小时 h:mm:ss（B 站长视频很常见）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  if (h === 0) return formatTime(total)
  const m = Math.floor((total % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * playable:false 的说明。B 站没有"会员才能播"的付费墙，取不到音轨通常意味着
 * 稿件已失效 / 被删，或者真需要大会员才能看 —— 两种情况对用户是同一句话。
 */
const notPlayableText = '这个条目取不到音轨（可能已失效或需要大会员）'

function previewUrl(id: string): string {
  return `/api/music/online/stream?id=${encodeURIComponent(id)}`
}

/**
 * 搜索在线曲库。
 *
 * 这里直接 fetch 而不是走 api.ts 的 request()：一是 request() 没有导出，本轮
 * 改动只在这一个文件里；二是这里要按状态码分档 —— 404 是"这个路由还没上线"，
 * 5xx 是"后端挂了"，文案不同，而 request() 只会抛同一个 ApiError。
 *
 * 任何失败都必须落成界面上的一句人话：弹层不许白屏，也不许冒出未捕获异常。
 */
async function searchOnline(): Promise<void> {
  const q = onlineQuery.value.trim()
  onlineUnavailableText.value = null
  if (!q) {
    onlineResults.value = []
    onlineSearched.value = false
    return
  }
  onlineLoading.value = true
  try {
    const resp = await fetch(`/api/music/online/search?q=${encodeURIComponent(q)}&limit=20`, {
      credentials: 'same-origin',
    })
    if (!resp.ok) {
      onlineResults.value = []
      onlineSearched.value = false
      onlineDegradedText.value = null
      onlineUnavailableText.value =
        resp.status === 404
          ? '在线曲库暂时不可用：服务端还没有这个接口。先在「从文件里挑」里排歌。'
          : `在线曲库暂时不可用：服务端返回 ${resp.status}。先在「从文件里挑」里排歌。`
      return
    }
    const data = (await resp.json()) as {
      results?: OnlineTrack[]
      degraded?: boolean
      message?: string
    }
    onlineResults.value = Array.isArray(data.results) ? data.results : []
    onlineDegradedText.value = data.degraded ? (data.message ?? '这批结果可能不完整') : null
    onlineSearched.value = true
  } catch {
    // 断网、JSON 解析失败、跨域 —— 一律当成"现在用不了"，不往上抛
    onlineResults.value = []
    onlineSearched.value = false
    onlineDegradedText.value = null
    onlineUnavailableText.value = '在线曲库暂时不可用：连不上服务端。先在「从文件里挑」里排歌。'
  } finally {
    onlineLoading.value = false
  }
}

/** 停止试听并清空状态。切页签、关弹层、卸载窗口都走这里。 */
function stopPreview(): void {
  const el = previewEl.value
  // 必须先 pause：弹层是 v-if 关掉的，元素脱离 DOM 之后照样会继续出声
  if (el) el.pause()
  previewId.value = null
  previewing.value = false
  previewPending.value = false
  previewError.value = null
}

/**
 * 试听 / 停止。
 *
 * 只动 previewEl，从不碰 audioEl，也从不调用 music.enqueue —— 这条路径上
 * 没有任何能让房间状态变化的调用。
 */
async function togglePreview(track: OnlineTrack): Promise<void> {
  if (!track.playable) return
  if (previewId.value === track.id && (previewing.value || previewPending.value)) {
    stopPreview()
    return
  }
  previewError.value = null
  previewId.value = track.id
  previewPending.value = true
  // 等 Vue 把 :src 换到这一首再 play()，否则 play() 起的是上一首的流
  await nextTick()
  const el = previewEl.value
  if (!el) {
    previewPending.value = false
    return
  }
  el.muted = soundState.muted
  el.volume = volumeGain()
  try {
    await el.play()
    // play() 是异步的：等待期间用户可能已经点了停止或换了另一首，
    // 那时 previewId 已经不是这一首了，不能把状态改回"正在放"
    if (previewId.value === track.id) previewing.value = true
  } catch {
    // 没拿到用户手势，或者流接口还没就绪（404 → 元素直接报错）都会走到这里
    previewError.value = '试听没能开始 —— 在线流接口可能还没就绪，再点一次试试'
  } finally {
    previewPending.value = false
  }
}

function onPreviewEnded(): void {
  previewing.value = false
  previewId.value = null
}

function onPreviewError(): void {
  // 主动清空 src 也会触发 error，那种不算失败
  if (!previewId.value) return
  previewing.value = false
  previewPending.value = false
  previewError.value = '试听加载失败 —— 在线流接口可能还没就绪（后端 404），或者这首拿不到真实播放地址'
}

function switchPickerTab(next: 'files' | 'online'): void {
  if (pickerTab.value === next) return
  pickerTab.value = next
  // 切回文件区就不再需要试听了。留着它在后台接着放，用户会以为全厅在放 —— 其实只有他自己听得到
  if (next === 'files') stopPreview()
}

function closePicker(): void {
  stopPreview()
  picking.value = false
}

onMounted(() => {
  music.connectRealtime()
  void syncClock()
  void music.load()
  // SSE 之外的兜底：断线/半开时房间状态仍然能追上
  music.startPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pageshow', onWake)
  window.addEventListener('online', onWake)
})

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') onWake()
}

onBeforeUnmount(() => {
  // 关窗口时试听元素会被一起销毁，但它脱离 DOM 后仍会出声 —— 先停
  stopPreview()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('pageshow', onWake)
  window.removeEventListener('online', onWake)
  music.stopPolling()
  player.dispose()
})

watch(
  () => music.error,
  (err) => {
    if (err) ui.notify('error', '听歌房', err)
  },
)
</script>

<template>
  <div class="music-app">
    <header class="bar">
      <div class="bar-title"><Icon name="audio" :size="18" />听歌房</div>
      <span v-if="!music.connected" class="wl-badge wl-badge--muted">连接断开</span>
      <div class="spacer" />
      <button class="wl-icon-btn" :disabled="music.loading" title="刷新" @click="music.load()">
        <Icon name="refresh" :size="16" :class="{ spin: music.loading }" />
      </button>
      <span v-if="members.length > 0" class="member-chip" :title="`在厅里：${members.map((m) => m.name).join('、')}`">
        <Icon name="users" :size="12" />{{ members.length }} 人在厅
      </span>
      <button
        v-if="inRoom"
        class="wl-btn wl-btn--sm"
        title="离开听歌房（不再跟着同步播放）"
        @click="leaveRoomAction"
      >
        离开
      </button>
      <button class="wl-btn wl-btn--primary" :disabled="!inRoom" :title="inRoom ? '' : '先加入听歌房'" @click="openPicker">
        <Icon name="plus" :size="14" />排首歌
      </button>
    </header>

    <!-- 正在播 -->
    <section class="now" :class="{ 'now--idle': !nowPlaying }">
      <!-- 没加入：只旁听信息，不参与同步播放（否则等于默认全员在厅里） -->
      <div v-if="!inRoom" class="join-panel">
        <Icon name="audio" :size="30" class="join-icon" />
        <p class="join-title">你还没加入听歌房</p>
        <p class="join-sub">
          <template v-if="nowPlaying">正在放「{{ nowPlaying.name }}」·</template>
          <template v-else>厅里现在没在放歌 ·</template>
          {{ members.length }} 人在厅里
        </p>
        <button class="wl-btn wl-btn--primary" @click="joinRoom">加入听歌房</button>
        <p class="join-note">加入后你的设备会和大家同步播放 —— 每台电脑都是一只音箱</p>
      </div>

      <template v-else-if="nowPlaying">
        <div class="now-info">
          <Icon name="audio" :size="26" class="now-icon" :class="{ 'now-icon--paused': nowPlaying.paused }" />
          <div class="now-text">
            <strong class="now-name">{{ nowPlaying.name }}</strong>
            <span class="now-meta">
              {{ nowPlaying.startedByName }} 排的 ·
              <template v-if="nowPlaying.paused">
                已暂停（{{ nowPlaying.pausedByName ?? '有人' }} 按的）· 停在 {{ formatTime(displayProgress) }}
              </template>
              <template v-else>已播 {{ formatTime(displayProgress) }} · 全厅同步播放（每台电脑都是一只音箱）</template>
            </span>
          </div>
          <div class="spacer" />
          <button
            v-if="blocked"
            class="wl-btn wl-btn--sm wl-btn--primary"
            title="浏览器需要一次点击才允许放声音"
            @click="unlockAudio"
          >
            点一下开始
          </button>
          <button
            class="wl-icon-btn"
            :title="nowPlaying.paused ? '继续播放（所有人）' : '暂停（所有人一起停）'"
            @click="togglePlay"
          >
            <Icon :name="nowPlaying.paused ? 'chevron-right' : 'minus'" :size="16" />
          </button>
          <button class="wl-btn wl-btn--sm" title="所有人切到下一首" @click="skip">
            <Icon name="chevron-right" :size="14" />切歌
          </button>
          <span
            v-if="!clockReady"
            class="sync-chip sync-chip--loose"
            :title="
              clockFailed && !wasEverCalibrated()
                ? '还没和服务端对上时间，暂时不会出声（避免各播各的）'
                : '和服务端对时失联，正在重试；恢复前不会用错误的基准播放'
            "
          >
            <Icon name="refresh" :size="12" />正在对时…
          </span>
          <span
            v-else
            class="sync-chip"
            :class="{ 'sync-chip--loose': syncOffsetMs > 120 }"
            :title="`本机控制残差：${syncOffsetMs}ms（本机播放位置与本机推算目标的差，**不代表两台设备之间的实际差**；时钟基准和输出设备延迟不在这个数字里）`"
          >
            <Icon name="check" :size="12" />同步 ±{{ syncOffsetMs }}ms
          </span>
        </div>
        <div class="now-progress">
          <div class="now-progress-bar" :style="{ width: '100%' }">
            <!-- 进度条没有总时长就不算百分比，纯视觉刻度即可 -->
          </div>
        </div>
        <audio
          ref="audioEl"
          :key="playingNodeId ?? 'none'"
          :src="playingNodeId ? trackUrl(playingNodeId) : undefined"
          preload="auto"
          @loadedmetadata="onLoadedMetadata"
          @ended="onEnded"
          @error="onAudioError"
          @playing="audioError = null"
        />
        <p v-if="audioError" class="now-warn">
          <Icon name="alert" :size="13" />{{ audioError }}
        </p>
      </template>
      <template v-else>
        <div class="now-idle">
          <Icon name="audio" :size="28" />
          <p>现在没有歌 —— 点右上角「排首歌」，队列里的第一首会立刻开播</p>
        </div>
      </template>
    </section>

    <!-- 队列 -->
    <div class="queue-head">队列（{{ queue.length }}）</div>
    <div class="queue">
      <p v-if="queue.length === 0" class="empty">队列空空的，排一首吧</p>
      <div v-for="item in queue" :key="item.id" class="qrow">
        <Icon name="audio" :size="14" class="qrow-icon" />
        <span class="qrow-name">{{ item.name }}</span>
        <span class="qrow-meta">{{ item.addedByName }}</span>
        <button
          v-if="item.addedBy === auth.user?.id"
          class="wl-icon-btn"
          title="撤下这首歌"
          @click="removeQueued(item.id)"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>
    </div>

    <!-- 选歌弹层：两个页签 —— 排歌（进队列） / 在线曲库（只能单人试听） -->
    <div v-if="picking" class="mask" @click.self="closePicker">
      <div class="picker">
        <header class="picker-bar">
          <strong>{{ pickerTab === 'files' ? '从文件里挑一首' : '在线曲库' }}</strong>
          <div class="spacer" />
          <button class="wl-icon-btn" title="关闭" @click="closePicker">
            <Icon name="close" :size="15" />
          </button>
        </header>

        <div class="picker-tabs">
          <button
            class="ptab"
            :class="{ 'ptab--active': pickerTab === 'files' }"
            @click="switchPickerTab('files')"
          >
            从文件里挑
          </button>
          <button
            class="ptab"
            :class="{ 'ptab--active': pickerTab === 'online' }"
            @click="switchPickerTab('online')"
          >
            在线曲库
          </button>
        </div>

        <div v-if="pickerTab === 'files'" class="picker-list">
          <p class="picker-note">
            排进听歌房 = 这首歌会共享给全厅收听（私人目录里的也行，撤下就不再共享）
          </p>
          <p v-if="music.tracks.length === 0" class="empty">文件区里还没有你能访问的音频文件</p>
          <button v-for="t in music.tracks" :key="t.id" class="pick" @click="enqueue(t.id)">
            <Icon name="audio" :size="14" />
            <span class="pick-name">{{ t.name }}</span>
            <span class="pick-meta">{{ t.ownerName }}</span>
          </button>
        </div>

        <!-- 在线曲库：这条路径上没有 enqueue —— 只能试听，绝不进队列 -->
        <div v-else class="picker-list">
          <form class="online-search" @submit.prevent="searchOnline">
            <input
              v-model="onlineQuery"
              class="wl-input"
              type="search"
              placeholder="视频标题 / UP 主，回车搜索"
              :disabled="onlineLoading"
            />
            <button class="wl-btn" type="submit" :disabled="onlineLoading || !onlineQuery.trim()">
              <Icon name="search" :size="13" />搜索
            </button>
          </form>

          <p class="picker-note">
            <Icon name="volume" :size="11" />
            音源来自哔哩哔哩；只你自己能听到，不会排进队列，也不影响房间的同步播放。
          </p>

          <p v-if="onlineUnavailableText" class="online-state online-state--warn">
            <Icon name="alert" :size="12" />{{ onlineUnavailableText }}
          </p>
          <p v-else-if="onlineLoading" class="online-state">
            <span class="wl-spinner" />正在搜索…
          </p>
          <p v-else-if="onlineDegradedText" class="online-state online-state--warn">
            <Icon name="info" :size="12" />{{ onlineDegradedText }}
          </p>
          <p v-else-if="!onlineSearched" class="online-state">
            输入关键词回车，在哔哩哔哩里找找看
          </p>
          <p v-else-if="onlineResults.length === 0" class="online-state">
            没搜到「{{ onlineQuery.trim() }}」，换个关键词，或者回「从文件里挑」排一首
          </p>

          <div
            v-for="t in onlineResults"
            :key="t.id"
            class="pick pick--online"
            :class="{ 'pick--active': previewId === t.id, 'pick--locked': !t.playable }"
          >
            <Icon name="audio" :size="14" class="pick-icon" />
            <div class="pick-main">
              <span class="pick-name">{{ t.name }}</span>
              <span class="pick-sub">
                {{ t.artist }}<template v-if="t.album"> · {{ t.album }}</template>
                <template v-if="formatDuration(t.durationMs)"> · {{ formatDuration(t.durationMs) }}</template>
                <template v-if="!t.playable"> · {{ notPlayableText }}</template>
              </span>
            </div>
            <button
              class="wl-btn wl-btn--sm pick-play"
              :disabled="!t.playable"
              :title="t.playable ? '只在你自己的设备上播放，不进队列' : notPlayableText"
              @click="togglePreview(t)"
            >
              {{
                !t.playable
                  ? '不可试听'
                  : previewId === t.id && (previewing || previewPending)
                    ? previewPending
                      ? '加载中…'
                      : '停止'
                    : '试听'
              }}
            </button>
          </div>

          <p v-if="previewError" class="online-state online-state--warn">
            <Icon name="alert" :size="12" />{{ previewError }}
          </p>
        </div>

        <!--
          试听用的**独立** <audio>：与房间播放器那个 audioEl 完全是两个元素。
          audioEl 每 500ms 被 music-player 往房间目标位置校正一次，共用会让
          一条外网流直接改写全厅的播放位置。
        -->
        <audio
          ref="previewEl"
          :src="previewId ? previewUrl(previewId) : undefined"
          preload="none"
          @playing="previewing = true"
          @pause="previewing = false"
          @ended="onPreviewEnded"
          @error="onPreviewError"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.music-app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  flex: none;
}

.bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 600;
}

.spacer {
  flex: 1;
}

/* ---------------- 正在播 */

.now {
  flex: none;
  padding: var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.now--idle {
  padding: var(--space-4);
}

.join-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-4);
  text-align: center;
}

.join-icon {
  color: var(--text-3);
}

.join-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.join-sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}

.join-note {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}

.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--surface-2);
}

.sync-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-family: monospace;
  color: var(--text-3);
  background: var(--surface-2);
}

.sync-chip--loose {
  color: var(--warning, #b06d00);
  background: color-mix(in srgb, var(--warning, #b06d00) 12%, transparent);
}

.now-warn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger, #c0392b) 10%, transparent);
  color: var(--danger, #c0392b);
  font-size: 12px;
}

.now-icon--paused {
  opacity: 0.45;
}

.now-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.now-icon {
  color: var(--accent);
  flex: none;
}

.now-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.now-name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-meta {
  font-size: 11px;
  color: var(--text-3);
}

.now-progress {
  margin-top: var(--space-2);
  height: 4px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}

.now-progress-bar {
  height: 100%;
  background: var(--accent);
  opacity: 0.6;
}

.now-idle {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-3);
  font-size: 13px;
}

.now-idle p {
  margin: 0;
}

/* ---------------- 队列 */

.queue-head {
  flex: none;
  padding: var(--space-2) var(--space-3);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  border-bottom: 1px solid var(--line-hair);
}

.queue {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.empty {
  margin: auto;
  color: var(--text-3);
  font-size: 13px;
}

.qrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: 8px;
}

.qrow:hover {
  background: var(--surface-2);
}

.qrow-icon {
  color: var(--text-3);
  flex: none;
}

.qrow-name {
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qrow-meta {
  font-size: 11px;
  color: var(--text-3);
  flex: none;
}

/* ---------------- 选歌弹层 */

.mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 手机壳里窗口会被撑满：留出边距，弹层才不会贴着屏幕边缘溢出 */
  padding: var(--space-3);
  z-index: 10;
}

.picker {
  width: min(480px, 100%);
  max-height: 70%;
  background: var(--surface-1);
  border: 1px solid var(--line-hair);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.picker-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  font-size: 13px;
}

.picker-note {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}

.picker-list {
  /* min-height: 0 是 flex 里能真正收缩/滚动的必要条件，否则窄屏下弹层会被内容顶破 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  border: 1px solid var(--line-hair);
  border-radius: 8px;
  background: var(--surface-2);
  text-align: left;
  cursor: pointer;
}

.pick:hover {
  border-color: var(--accent);
}

.pick-name {
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-meta {
  font-size: 11px;
  color: var(--text-3);
  flex: none;
}

/* ---------------- 弹层页签 */

.picker-tabs {
  flex: none;
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) 0;
}

.ptab {
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ptab:hover {
  background: var(--surface-2);
}

.ptab--active {
  background: var(--surface-2);
  border-color: var(--line);
  color: var(--text);
  font-weight: 600;
}

/* ---------------- 在线曲库（只试听，不进队列） */

.online-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.online-search .wl-input {
  flex: 1;
  min-width: 0;
}

.online-search .wl-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.online-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: var(--space-1) 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
  background: var(--surface-2);
}

.online-state--warn {
  color: var(--warning, #b06d00);
  background: color-mix(in srgb, var(--warning, #b06d00) 12%, transparent);
}

.pick-icon {
  color: var(--text-tertiary);
  flex: none;
}

.pick--online {
  /* 这是"行"，不是"可点的整行按钮" —— 唯一能点的是右边的试听键 */
  cursor: default;
}

.pick--online:hover {
  border-color: var(--line);
}

.pick--active {
  border-color: var(--accent);
}

.pick--locked {
  opacity: 0.7;
}

.pick-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.pick-main .pick-name {
  /* 列向 flex 容器里 flex:1 会撑高度，这里只保留单行省略 */
  flex: none;
  min-width: 0;
  max-width: 100%;
}

.pick-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-play {
  flex: none;
}
</style>
