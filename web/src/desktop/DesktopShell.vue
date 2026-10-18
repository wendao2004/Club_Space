<!--
  桌面外壳：壁纸 + 图标 + 窗口层 + 任务栏 + 开始菜单 + 右键菜单 + 通知。

  这是"操作起来和 Windows 一致"这个需求的落点。已实现：多窗口自由重叠、
  任务栏切换、开始菜单、桌面图标、贴边分屏、最小化全部、右键菜单、刷新后
  恢复窗口布局。

  做不到的部分（要诚实）：浏览器无法拦截 Win 键、Alt+Tab 等系统级快捷键，
  所以"完全一致"在键位层面不成立。平台内的快捷键（下面 handleHotkey）都做了。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import DesktopIcons from './DesktopIcons.vue'
import StartMenu from './StartMenu.vue'
import Taskbar from './Taskbar.vue'
import WindowFrame from './WindowFrame.vue'
import ContextMenu from './ContextMenu.vue'
import ToastHost from './ToastHost.vue'
import { appComponents, findApp } from '@/apps/registry'
import { shouldYieldKeyboard } from '@/desktop/keyboard'
import { useUi } from '@/stores/ui'
import { useWindows } from '@/stores/windows'

const windows = useWindows()
const ui = useUi()

const startOpen = ref(false)

function toggleStart(): void {
  startOpen.value = !startOpen.value
}

function closeStart(): void {
  startOpen.value = false
}

/**
 * 平台内快捷键。
 *
 * 用 Ctrl+Alt 组合而不是 Win 键 / Alt+Tab：后两者浏览器不会交给我们，
 * 这在设计说明里已经写明是做不到的部分。
 */
function handleHotkey(event: KeyboardEvent): void {
  // Escape 不设守卫：它关的是开始菜单/右键菜单这类**覆盖层**，
  // 而覆盖层有没有开、该不该关，跟焦点在哪个输入框里无关。
  if (event.key === 'Escape') {
    if (startOpen.value) {
      closeStart()
      event.preventDefault()
      return
    }
    if (ui.contextMenu) {
      ui.closeContextMenu()
      event.preventDefault()
      return
    }
  }

  // ⚠️ 剩下的都是"打开应用 / 操作窗口"这类**桌面级**动作，焦点不在桌面时必须让路。
  //
  // 出过的问题：焦点在聊天框里按 Ctrl+W，本意可能是"删掉上一个词"之类的编辑器习惯，
  // 结果整个聊天窗口被关掉，草稿一起没了。同理 Ctrl+Alt+E/T 在输入框里也不该
  // 凭空弹出一个应用窗口来。
  if (shouldYieldKeyboard(event)) return

  // Ctrl+Alt+E 打开文件、Ctrl+Alt+T 打开工具集、Ctrl+Alt+M 最小化全部
  if (event.ctrlKey && event.altKey) {
    const map: Record<string, () => void> = {
      e: () => openApp('files', '文件'),
      t: () => openApp('tools', '工具集'),
      m: () => windows.minimizeAll(),
      s: () => windows.toggleMaximize(windows.activeId ?? ''),
    }
    const handler = map[event.key.toLowerCase()]
    if (handler) {
      handler()
      event.preventDefault()
    }
  }

  // Ctrl+W 关掉当前窗口
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'w' && windows.activeId) {
    windows.close(windows.activeId)
    event.preventDefault()
  }
}

function openApp(appId: string, fallbackTitle: string): void {
  const app = findApp(appId)
  windows.open({
    appId,
    title: app?.name ?? fallbackTitle,
    w: app?.defaultSize?.w,
    h: app?.defaultSize?.h,
    minW: app?.minSize?.w,
    minH: app?.minSize?.h,
  })
}

/** 点击桌面或任务栏空白处收起开始菜单。 */
function onGlobalPointerDown(event: PointerEvent): void {
  if (!startOpen.value) return
  const target = event.target as HTMLElement
  if (target.closest('.start') || target.closest('.taskbar__start')) return
  closeStart()
}

onMounted(() => {
  window.addEventListener('keydown', handleHotkey)
  window.addEventListener('pointerdown', onGlobalPointerDown)
  // 恢复上次的窗口布局：刷新页面不该丢掉工作区
  windows.restoreLayout()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleHotkey)
  window.removeEventListener('pointerdown', onGlobalPointerDown)
})
</script>

<template>
  <div class="desktop">
    <div class="desktop__wallpaper" :class="`desktop__wallpaper--${ui.wallpaper}`" />

    <DesktopIcons />

    <!-- 窗口层：所有打开的窗口 -->
    <div class="desktop__windows">
      <WindowFrame v-for="win in windows.windows" v-show="!win.minimized" :key="win.id" :win="win">
        <component :is="appComponents[win.appId]" :win="win" />
      </WindowFrame>
    </div>

    <Taskbar :start-open="startOpen" @toggle-start="toggleStart" />
    <StartMenu :open="startOpen" @close="closeStart" />
    <ContextMenu />
    <ToastHost />
  </div>
</template>

<style scoped>
.desktop {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 壁纸 */

.desktop__wallpaper {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(140deg, var(--wallpaper-1), var(--wallpaper-2) 45%, var(--wallpaper-3));
}

/* 换个层次感：叠一层极淡的径向高光，避免纯线性渐变显得平 */
.desktop__wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1200px 600px at 20% 10%, rgba(255, 255, 255, 0.1), transparent 60%),
    radial-gradient(900px 500px at 90% 90%, rgba(0, 0, 0, 0.28), transparent 60%);
}

.desktop__wallpaper--1 {
  background: linear-gradient(160deg, #2b1055 0%, #7597de 70%, #1b2a4a 100%);
}

.desktop__wallpaper--2 {
  background: linear-gradient(150deg, #0f2027 0%, #2c5364 55%, #203a43 100%);
}

.desktop__wallpaper--3 {
  background: linear-gradient(140deg, #3a1c37 0%, #8b5a6b 50%, #2b1b2e 100%);
}

/* ---------------------------------------------------------------- 窗口层 */

.desktop__windows {
  position: absolute;
  inset: 0;
  z-index: var(--z-window);
  /* 窗口层不能吃掉桌面的鼠标事件，否则点空白处选不中桌面图标 */
  pointer-events: none;
}

.desktop__windows :deep(.window) {
  pointer-events: auto;
}
</style>
