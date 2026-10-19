<!--
  任务栏。

  用 Windows 11 的居中布局：开始按钮在左，应用按钮居中，系统托盘在右。
  点击行为遵循 Windows 惯例 —— 未激活则聚焦、已激活则最小化（见 windows store
  的 toggleFromTaskbar）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { findApp } from '@/apps/registry'
import { previewSystem, setMuted, setVolume, soundState } from '@/lib/sfx'
import { useAuth } from '@/stores/auth'
import { useChat } from '@/stores/chat'
import { useUi } from '@/stores/ui'
import { useWindows, type WindowInstance } from '@/stores/windows'

defineProps<{ startOpen: boolean }>()
const emit = defineEmits<{ (e: 'toggle-start', anchor: DOMRect): void }>()

const windows = useWindows()
const auth = useAuth()
const ui = useUi()
const chat = useChat()

// 未读角标：连接一次就够，任务栏是常驻的。
// 放在 onMounted 而不是 setup 里，避免组件还没挂载就发起网络请求。
onMounted(() => {
  void chat.connect()
  void chat.loadConversations().catch(() => {
    // 任务栏的角标拿不到不该影响界面其它部分，静默即可
  })
})

const startButton = ref<HTMLElement | null>(null)
const clock = ref(formatClock())

function formatClock(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

// 每分钟更新一次时钟就够了，没必要每秒唤醒渲染
window.setInterval(() => {
  clock.value = formatClock()
}, 30_000)

/** 同一应用开多个窗口时，任务栏只显示一个按钮并标数量 —— 和 Windows 一致。 */
interface TaskGroup {
  appId: string
  name: string
  icon: string
  tint?: string
  windows: WindowInstance[]
  /** 组内是否有已激活窗口 */
  active: boolean
  minimized: boolean
}

const groups = computed<TaskGroup[]>(() => {
  const map = new Map<string, TaskGroup>()
  for (const win of windows.windows) {
    const app = findApp(win.appId)
    let group = map.get(win.appId)
    if (!group) {
      group = {
        appId: win.appId,
        name: app?.name ?? win.title,
        icon: app?.icon ?? 'file',
        tint: app?.tint,
        windows: [],
        active: false,
        minimized: true,
      }
      map.set(win.appId, group)
    }
    group.windows.push(win)
    if (win.id === windows.activeId && !win.minimized) group.active = true
    if (!win.minimized) group.minimized = false
  }
  return [...map.values()]
})

function onGroupClick(group: TaskGroup): void {
  if (group.windows.length === 1) {
    windows.toggleFromTaskbar(group.windows[0]!.id)
    return
  }
  // 多窗口：点击循环切换，右键出列表 —— 简化处理，这里用循环
  windows.cycleSameApp(group.appId)
}

function onStartClick(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('toggle-start', rect)
}

/** 在 32px 高度里塞下时钟 + 日期，Windows 是上下两行的紧凑排版。 */
const today = computed(() => {
  const d = new Date()
  return `${d.getMonth() + 1}/${d.getDate()}`
})

// ---------------------------------------------------------------- 音量浮窗
//
// 参考 Windows 的做法：点托盘上的喇叭，弹出一小块音量面板，拖完立刻能听见。
// 和「设置 → 声音」共用同一份 soundState，两处永远同步（不存在各存一个 ref）。

const volumeOpen = ref(false)
const volumeAnchor = ref<HTMLElement | null>(null)
const volumePanel = ref<HTMLElement | null>(null)

const volumePercent = computed(() => Math.round(soundState.volume * 100))
/** 静音或拉到 0 都显示带叉的喇叭 */
const volumeIcon = computed(() => (soundState.muted || soundState.volume <= 0 ? 'volume-off' : 'volume'))
const volumeTitle = computed(() => {
  if (soundState.muted) return '已静音（点击调音量）'
  return `音量 ${volumePercent.value}%`
})

let previewTimer = 0

/**
 * 调整音量时给一声"叮"作为确认 —— 但滚轮一格一个音会吵，所以合并：
 * 停下来 160ms 后才响一次。
 */
function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => previewSystem('notify'), 160)
}

function toggleVolume(): void {
  volumeOpen.value = !volumeOpen.value
}

function onVolumeInput(event: Event): void {
  const el = event.target as HTMLInputElement
  // Windows 的行为：静音状态下拖动音量条会自动取消静音
  if (soundState.muted) setMuted(false)
  setVolume(Number(el.value) / 100)
  schedulePreview()
}

/** 拖动结束（松手 / 键盘松开）响一声确认最终音量 */
function onVolumeCommit(): void {
  window.clearTimeout(previewTimer)
  previewSystem('notify')
}

function toggleMute(): void {
  setMuted(!soundState.muted)
  // 从静音恢复时响一声，让用户确认真的有声音了
  if (!soundState.muted) previewSystem('notify')
}

/** 滚轮直接调音量 —— Windows 上鼠标停在喇叭图标上滚轮就是这个行为 */
function onVolumeWheel(event: WheelEvent): void {
  const step = event.deltaY > 0 ? -0.05 : 0.05
  setVolume(soundState.volume + step)
  schedulePreview()
}

function openSoundSettings(): void {
  volumeOpen.value = false
  windows.open({ appId: 'settings', title: '设置', args: { tab: 'sound' } })
}

function onGlobalPointerDown(event: PointerEvent): void {
  if (!volumeOpen.value) return
  const target = event.target as Node | null
  if (volumePanel.value?.contains(target) || volumeAnchor.value?.contains(target)) return
  volumeOpen.value = false
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && volumeOpen.value) volumeOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onGlobalPointerDown)
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('keydown', onGlobalKeydown)
  window.clearTimeout(previewTimer)
})
</script>

<template>
  <footer class="taskbar">
    <!-- 左：开始按钮 + 快速搜索 -->
    <div class="taskbar__left">
      <button
        ref="startButton"
        class="taskbar__start"
        :class="{ 'taskbar__start--open': startOpen }"
        title="开始"
        @click="onStartClick"
      >
        <span class="taskbar__logo">
          <span v-for="i in 4" :key="i" class="taskbar__logo-pane" />
        </span>
      </button>
    </div>

    <!-- 中：已打开的应用 -->
    <div class="taskbar__center">
      <button
        v-for="group in groups"
        :key="group.appId"
        class="taskbar__app"
        :class="{ 'taskbar__app--active': group.active }"
        :title="group.name"
        @click="onGroupClick(group)"
      >
        <span class="taskbar__app-icon" :style="group.tint ? { '--tint': group.tint } : undefined">
          <Icon :name="group.icon" :size="20" />
        </span>
        <!-- 聊天未读角标：直接读服务端算的 totalUnread，不在前端自己估算 -->
        <span
          v-if="group.appId === 'chat' && chat.totalUnread > 0"
          class="taskbar__badge"
          :title="`${chat.totalUnread} 条未读消息`"
        >
          {{ chat.totalUnread > 99 ? '99+' : chat.totalUnread }}
        </span>
        <span v-else-if="group.windows.length > 1" class="taskbar__count">{{ group.windows.length }}</span>
        <span class="taskbar__indicator" :class="{ 'taskbar__indicator--on': !group.minimized }" />
      </button>
    </div>

    <!-- 右：托盘 -->
    <div class="taskbar__right">
      <button
        ref="volumeAnchor"
        class="taskbar__tray"
        :title="volumeTitle"
        aria-label="音量"
        :aria-expanded="volumeOpen"
        @click="toggleVolume"
        @wheel.prevent="onVolumeWheel"
      >
        <Icon :name="volumeIcon" :size="15" />
      </button>

      <!-- 音量浮窗：点喇叭弹出，行为和 Windows 一致（点别处 / Esc 关闭） -->
      <div v-if="volumeOpen" ref="volumePanel" class="volfly" role="dialog" aria-label="音量">
        <div class="volfly__head">
          <span class="volfly__title">扬声器</span>
          <span class="volfly__value">{{ soundState.muted ? '静音' : `${volumePercent}%` }}</span>
        </div>
        <div class="volfly__row">
          <button
            class="volfly__mute"
            :title="soundState.muted ? '取消静音' : '静音'"
            :aria-pressed="soundState.muted"
            @click="toggleMute"
          >
            <Icon :name="volumeIcon" :size="18" />
          </button>
          <input
            class="volfly__range"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="volumePercent"
            aria-label="音量"
            @input="onVolumeInput"
            @change="onVolumeCommit"
          />
        </div>
        <div class="volfly__hint">滚轮停在喇叭图标上也能调</div>
        <button class="volfly__link" @click="openSoundSettings">声音设置</button>
      </div>

      <button class="taskbar__tray" title="切换主题" @click="ui.toggleTheme()">
        <Icon :name="ui.theme === 'dark' ? 'moon' : 'sun'" :size="15" />
      </button>
      <button class="taskbar__tray" :title="`显示桌面`" @click="windows.minimizeAll()">
        <Icon name="layout" :size="15" />
      </button>
      <div class="taskbar__clock" :title="new Date().toLocaleString('zh-CN')">
        <span>{{ clock }}</span>
        <span class="taskbar__date">{{ today }}</span>
      </div>
      <button class="taskbar__user" :title="auth.user?.displayName" @click="windows.open({ appId: 'settings', title: '设置', args: { tab: 'account' } })">
        <span class="taskbar__avatar">{{ (auth.user?.displayName ?? '?').slice(0, 1) }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.taskbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-taskbar);
  display: flex;
  align-items: center;
  height: var(--taskbar-h);
  padding: 0 var(--space-2);
  background: var(--surface-raised);
  backdrop-filter: blur(30px) saturate(1.8);
  border-top: 1px solid var(--line-hair);
}

.taskbar__left,
.taskbar__right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  /* 三等分保证中间的按钮组真正居中 */
  flex: 1 1 0;
}

.taskbar__right {
  justify-content: flex-end;
  gap: var(--space-2);
  /* 音量浮窗以这里为定位基准 */
  position: relative;
}

.taskbar__center {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 0 auto;
}

/* ---------------------------------------------------------------- 开始按钮 */

.taskbar__start {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  color: var(--accent);
  transition: background var(--dur-fast) var(--ease-out);
}

.taskbar__start:hover,
.taskbar__start--open {
  background: var(--hover);
}

.taskbar__start:active {
  background: var(--pressed);
}

.taskbar__logo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  width: 18px;
  height: 18px;
}

.taskbar__logo-pane {
  background: currentColor;
  border-radius: 1.5px;
}

/* ---------------------------------------------------------------- 应用按钮 */

.taskbar__app {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  transition: background var(--dur-fast) var(--ease-out);
}

.taskbar__app:hover {
  background: var(--hover);
}

.taskbar__app--active {
  background: var(--hover);
}

/* 图标不再坐色块：主色线性字形直接落在任务栏上 */
.taskbar__app-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--tint, var(--text-secondary));
}

[data-theme='dark'] .taskbar__app-icon {
  color: color-mix(in srgb, var(--tint, #b7c0cd) 62%, #ffffff);
}

.taskbar__count {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--surface-3);
  color: var(--text-secondary);
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  font-weight: 600;
}

/* 未读角标：danger 底；暗色下 danger 是浅粉，改深字保证对比度 */
.taskbar__badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger);
  color: #ffffff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-weight: 700;
  box-shadow: 0 0 0 2px var(--surface-1);
}

[data-theme='dark'] .taskbar__badge {
  color: #3a1116;
}

/* 运行指示条：未激活=短点、激活=短胶囊（Windows 11 的双态） */
.taskbar__indicator {
  position: absolute;
  bottom: 2px;
  left: 50%;
  width: 6px;
  height: 3px;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0.5;
  transform: translateX(-50%);
  transition:
    width var(--dur) var(--ease-out),
    opacity var(--dur) var(--ease-out);
}

.taskbar__indicator--on {
  width: 16px;
  opacity: 1;
}

/* ---------------------------------------------------------------- 托盘 */

.taskbar__tray {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--text-secondary);
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.taskbar__tray:hover {
  background: var(--hover);
  color: var(--text);
}

.taskbar__clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  padding: 0 var(--space-2);
  height: 40px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  cursor: default;
}

.taskbar__clock:hover {
  background: var(--hover);
}

.taskbar__date {
  font-size: 10.5px;
  color: var(--text-tertiary);
}

.taskbar__user {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
}

.taskbar__user:hover {
  background: var(--hover);
}

.taskbar__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
}

/* ---------------------------------------------------------------- 音量浮窗 */

.volfly {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 10;
  width: 232px;
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-popup);
  backdrop-filter: blur(24px) saturate(1.6);
  /* 出现时轻微上浮，和开始菜单保持同一种动效语言 */
  animation: volfly-in var(--dur-fast) var(--ease-out);
}

@keyframes volfly-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.volfly__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.volfly__title {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  color: var(--text);
}

.volfly__value {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.volfly__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.volfly__mute {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 6px;
  color: var(--text-secondary);
}

.volfly__mute:hover {
  background: var(--hover);
  color: var(--text);
}

/* 用原生滑块 + accent-color：拖动手感、键盘操作、无障碍都由浏览器负责，
   自己画一个反而容易丢掉这些 */
.volfly__range {
  flex: 1;
  height: 20px;
  accent-color: var(--accent);
  cursor: pointer;
}

.volfly__hint {
  margin-top: var(--space-2);
  font-size: 10.5px;
  color: var(--text-tertiary);
}

.volfly__link {
  margin-top: var(--space-2);
  padding: 5px 0;
  width: 100%;
  border-top: 1px solid var(--line-hair);
  color: var(--accent);
  font-size: var(--fs-caption);
  text-align: left;
}

.volfly__link:hover {
  text-decoration: underline;
}
</style>
