<!--
  听歌房：全站一个厅，共享队列与**共享播放进度**。

  同步靠 engine（web/src/lib/music-player.ts）：
  - 服务端时间是唯一权威（客户端采样算时钟偏移，不用自己的 Date.now()）
  - 每秒对一次进度，偏差 > 0.45s 才 seek（阈值小会不停抽搐）
  - 暂停/继续是厅级状态，所有人一起停、一起续
  - 可选"房间音效"：短混响 + 按座位分声像（听感效果，不是多路音源）
  播完由任意客户端上报切歌（playedToken 防止旧上报错切新曲）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api } from '@/api'
import { SyncedPlayer, measureClockOffset } from '@/lib/music-player'
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
/** 正在加载的曲目 id：换曲时用来触发 <audio> 重新拉流。 */
const playingNodeId = ref<string | null>(null)

const player = new SyncedPlayer()
/** 浏览器拦了自动播放时要显示"点一下开始"。 */
const blocked = ref(false)
/** 同步精度（毫秒）：给用户看"我们现在差多少"，也是空间声场的前提。 */
const syncOffsetMs = ref(0)

const nowPlaying = computed(() => music.room?.nowPlaying ?? null)
const queue = computed(() => music.room?.queue ?? [])

/** 当前进度（秒）：读服务端权威进度，再加本地这一秒的推进。 */
const progressSec = computed(() => {
  const np = nowPlaying.value
  if (!np) return 0
  return Math.max(0, player.targetMs(np) / 1000)
})

const displayProgress = ref(0)
const progressTimer = window.setInterval(() => {
  displayProgress.value = progressSec.value
  const np = nowPlaying.value
  if (!np) return
  // 500ms 一次：偏差 40ms 内不动、400ms 内用速率微调、再大才 seek
  player.enforce(np)
  blocked.value = player.blocked
  syncOffsetMs.value = Math.abs(player.lastOffsetMs)
}, 500)
onBeforeUnmount(() => window.clearInterval(progressTimer))

function formatTime(sec: number): string {
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 时钟对齐：进房间时测一次，之后每 5 分钟重测（笔记本休眠会漂）。 */
async function syncClock(): Promise<void> {
  const offset = await measureClockOffset(async () => (await api.music.time()).now)
  player.setClockOffset(offset)
}
const clockTimer = window.setInterval(() => void syncClock(), 5 * 60_000)
onBeforeUnmount(() => window.clearInterval(clockTimer))

watch(
  audioEl,
  (el) => {
    if (!el) return
    player.attach(el)
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
      playingNodeId.value = null
      return
    }
    if (np.nodeId !== playingNodeId.value) {
      playingNodeId.value = np.nodeId
      return
    }
    if (np.playedToken !== old?.playedToken) {
      // 同一首歌重播（极少见）：重新对齐
      player.enforce(np)
    }
  },
  { immediate: true },
)

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
  await music.ended(np.playedToken)
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
  const ok = await music.enqueue(nodeId)
  if (ok) {
    picking.value = false
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

onMounted(() => {
  music.connectRealtime()
  void syncClock()
  void music.load()
})

onBeforeUnmount(() => {
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
      <button class="wl-btn wl-btn--primary" @click="openPicker">
        <Icon name="plus" :size="14" />排首歌
      </button>
    </header>

    <!-- 正在播 -->
    <section class="now" :class="{ 'now--idle': !nowPlaying }">
      <template v-if="nowPlaying">
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
            class="sync-chip"
            :class="{ 'sync-chip--loose': syncOffsetMs > 120 }"
            :title="`本机与服务端播放进度的偏差：${syncOffsetMs}ms。全厅每台电脑都对准同一进度，多设备一起出声才像一个声场`"
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

    <!-- 选歌弹层 -->
    <div v-if="picking" class="mask" @click.self="picking = false">
      <div class="picker">
        <header class="picker-bar">
          <strong>从文件里挑一首</strong>
          <div class="spacer" />
          <button class="wl-icon-btn" @click="picking = false"><Icon name="close" :size="15" /></button>
        </header>
        <div class="picker-list">
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
  z-index: 10;
}

.picker {
  width: min(480px, 90%);
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
</style>
