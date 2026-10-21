<!--
  听歌房（轻量版）。

  全站一个厅：共享队列，谁都能排歌、切歌。播放器是"各播各的"——
  加载完 seek 到服务端记录的起播位置，误差就是各自的加载耗时。
  播完由任意客户端上报切歌（playedToken 防止旧上报错切新曲）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api } from '@/api'
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
const localPaused = ref(false)
/** 本会话是否已经对这个 token 做过 seek 对齐（避免 loop 里反复 seek）。 */
const syncedToken = ref(-1)

const now = ref(Date.now())
const tick = window.setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => window.clearInterval(tick))

const nowPlaying = computed(() => music.room?.nowPlaying ?? null)
const queue = computed(() => music.room?.queue ?? [])

/** 按服务端起播时间算的当前进度（秒）。 */
const progressSec = computed(() => {
  const np = nowPlaying.value
  if (!np) return 0
  return Math.max(0, (now.value - np.startedAt) / 1000)
})

function formatTime(sec: number): string {
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

watch(
  nowPlaying,
  (np, old) => {
    if (!np) {
      playingNodeId.value = null
      return
    }
    if (np.nodeId !== playingNodeId.value) {
      playingNodeId.value = np.nodeId
      syncedToken.value = -1
      localPaused.value = false
      // src 换了 <audio> 会自动重拉；seek 在 loadedmetadata 里做（此时才知道可播）
    } else if (np.playedToken !== old?.playedToken) {
      syncedToken.value = -1
    }
  },
  { immediate: true },
)

function onLoadedMetadata(): void {
  const np = nowPlaying.value
  const el = audioEl.value
  if (!np || !el || syncedToken.value === np.playedToken) return
  syncedToken.value = np.playedToken
  // 对齐到服务端起播位置 —— 这就是"轻量同步"的全部：误差 = 各自加载耗时
  const target = Math.max(0, (Date.now() - np.startedAt) / 1000)
  if (Number.isFinite(el.duration) && target < el.duration) {
    el.currentTime = target
    void el.play().catch(() => {
      // 浏览器自动播放策略拦了（无用户手势）—— 显示播放按钮让用户点一下
      localPaused.value = true
    })
  }
}

async function onEnded(): Promise<void> {
  const np = nowPlaying.value
  if (!np) return
  const advanced = await music.ended(np.playedToken)
  if (!advanced) {
    // 别的客户端先报了 —— store 会收到广播并换曲，这里不用动
  }
}

async function togglePlay(): Promise<void> {
  const el = audioEl.value
  if (!el) return
  if (el.paused) {
    await el.play().catch(() => undefined)
    localPaused.value = false
  } else {
    el.pause()
    localPaused.value = true
  }
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

function trackUrl(nodeId: string): string {
  return api.previewUrl(nodeId)
}

onMounted(() => {
  music.connectRealtime()
  void music.load()
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
          <Icon name="audio" :size="26" class="now-icon" />
          <div class="now-text">
            <strong class="now-name">{{ nowPlaying.name }}</strong>
            <span class="now-meta">{{ nowPlaying.startedByName }} 排的 · 已播 {{ formatTime(progressSec) }}</span>
          </div>
          <div class="spacer" />
          <button class="wl-icon-btn" :title="localPaused ? '播放' : '暂停（只影响自己）'" @click="togglePlay">
            <Icon :name="localPaused ? 'chevron-right' : 'minus'" :size="16" />
          </button>
          <button class="wl-btn wl-btn--sm" title="所有人切到下一首" @click="skip">
            <Icon name="chevron-right" :size="14" />切歌
          </button>
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
        />
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
