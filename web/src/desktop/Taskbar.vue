<!--
  任务栏。

  用 Windows 11 的居中布局：开始按钮在左，应用按钮居中，系统托盘在右。
  点击行为遵循 Windows 惯例 —— 未激活则聚焦、已激活则最小化（见 windows store
  的 toggleFromTaskbar）。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { findApp } from '@/apps/registry'
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
        <span class="taskbar__app-icon" :style="group.tint ? { background: group.tint } : undefined">
          <Icon :name="group.icon" :size="16" />
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
  background: var(--surface-1);
  backdrop-filter: blur(40px) saturate(180%);
  border-top: 1px solid var(--border);
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
  border-radius: var(--radius-sm);
  color: var(--accent);
  transition: background var(--dur-fast) var(--ease-out);
}

.taskbar__start:hover,
.taskbar__start--open {
  background: var(--hover);
}

.taskbar__logo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  width: 16px;
  height: 16px;
}

.taskbar__logo-pane {
  background: currentColor;
  border-radius: 1px;
}

/* ---------------------------------------------------------------- 应用按钮 */

.taskbar__app {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 40px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}

.taskbar__app:hover {
  background: var(--hover);
}

.taskbar__app--active {
  background: var(--surface-3);
}

.taskbar__app-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--surface-3);
  color: #fff;
}

.taskbar__count {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  font-weight: 600;
}

/* 未读角标比窗口数角标更醒目：用 danger 色并带一点描边，让它在深色底上也跳出来 */
.taskbar__badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-weight: 700;
  box-shadow: 0 0 0 2px var(--surface-1);
}

/* 运行指示条：Windows 11 在图标下方一条短横线 */
.taskbar__indicator {
  position: absolute;
  bottom: 2px;
  left: 50%;
  width: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
  transform: translateX(-50%);
  transition: width var(--dur) var(--ease-out);
}

.taskbar__indicator--on {
  width: 16px;
}

/* ---------------------------------------------------------------- 托盘 */

.taskbar__tray {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
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
  height: 36px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  line-height: 1.25;
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
  border-radius: 50%;
  overflow: hidden;
}

.taskbar__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
</style>
