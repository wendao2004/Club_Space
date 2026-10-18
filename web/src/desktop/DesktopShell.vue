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

/* ---------------------------------------------------------------- 壁纸
 *
 * 全部用 CSS 绘制（层叠径向渐变模拟 Windows 11 的 Bloom 光斑），不引入图片：
 * 内网部署不需要任何外部资源，也不会因为缺文件而"开天窗"。
 * 四套壁纸在明暗两个主题下各有一版，浅色全部保持浅底，保证桌面标签可读。
 */

.desktop__wallpaper {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(158deg, #eaf3fc 0%, #d9e9f8 48%, #eef5fb 100%);
}

/* 一层柔和光晕 + 一层极淡暗角，让平铺渐变有纵深 */
.desktop__wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1400px 900px at 50% -12%, rgba(255, 255, 255, 0.35), transparent 60%),
    radial-gradient(1200px 800px at 50% 118%, rgba(16, 40, 72, 0.06), transparent 62%);
}

/* ---- 壁纸 0（默认）：晨雾蓝 ---- */
.desktop__wallpaper--0 {
  background:
    radial-gradient(1100px 620px at 78% 14%, rgba(116, 178, 235, 0.5), transparent 62%),
    radial-gradient(880px 520px at 12% 88%, rgba(150, 196, 240, 0.45), transparent 66%),
    radial-gradient(700px 420px at 55% 62%, rgba(255, 255, 255, 0.65), transparent 70%),
    linear-gradient(158deg, #eaf3fc 0%, #d9e9f8 48%, #eef5fb 100%);
}

/* ---- 壁纸 1：青澜 ---- */
.desktop__wallpaper--1 {
  background:
    radial-gradient(1000px 600px at 22% 18%, rgba(96, 190, 196, 0.42), transparent 60%),
    radial-gradient(900px 560px at 82% 78%, rgba(120, 170, 230, 0.4), transparent 64%),
    radial-gradient(760px 460px at 50% 50%, rgba(255, 255, 255, 0.6), transparent 70%),
    linear-gradient(160deg, #e9f6f6 0%, #d8ecf2 50%, #eef7f9 100%);
}

/* ---- 壁纸 2：暮山（克制的紫灰，给喜欢一点色彩的人） ---- */
.desktop__wallpaper--2 {
  background:
    radial-gradient(1000px 600px at 80% 22%, rgba(186, 160, 226, 0.38), transparent 62%),
    radial-gradient(860px 520px at 18% 82%, rgba(236, 178, 190, 0.35), transparent 66%),
    radial-gradient(720px 440px at 48% 55%, rgba(255, 255, 255, 0.62), transparent 70%),
    linear-gradient(158deg, #f3f0f9 0%, #e7e3f3 50%, #f7f4fa 100%);
}

/* ---- 壁纸 3：深湖（蓝调更重，但仍保持浅色系） ---- */
.desktop__wallpaper--3 {
  background:
    radial-gradient(1000px 620px at 70% 18%, rgba(84, 150, 214, 0.5), transparent 62%),
    radial-gradient(900px 560px at 20% 85%, rgba(60, 120, 190, 0.35), transparent 66%),
    linear-gradient(160deg, #dfeaf6 0%, #c9dcf0 55%, #e3eef8 100%);
}

/* ---- 暗色版：四套壁纸的"夜航"变体 ---- */

[data-theme='dark'] .desktop__wallpaper,
[data-theme='dark'] .desktop__wallpaper--0 {
  background:
    radial-gradient(1100px 620px at 78% 12%, rgba(52, 104, 168, 0.55), transparent 62%),
    radial-gradient(880px 520px at 14% 86%, rgba(30, 64, 110, 0.5), transparent 66%),
    linear-gradient(158deg, #0d1420 0%, #101c2e 50%, #0c1119 100%);
}

[data-theme='dark'] .desktop__wallpaper--1 {
  background:
    radial-gradient(1000px 600px at 24% 16%, rgba(38, 120, 124, 0.45), transparent 60%),
    radial-gradient(900px 560px at 80% 80%, rgba(44, 86, 150, 0.45), transparent 64%),
    linear-gradient(160deg, #0b1518 0%, #0f1e26 52%, #0b1216 100%);
}

[data-theme='dark'] .desktop__wallpaper--2 {
  background:
    radial-gradient(1000px 600px at 78% 20%, rgba(96, 74, 150, 0.5), transparent 62%),
    radial-gradient(860px 520px at 16% 82%, rgba(120, 70, 110, 0.4), transparent 66%),
    linear-gradient(158deg, #120f1c 0%, #1a1426 52%, #100d18 100%);
}

[data-theme='dark'] .desktop__wallpaper--3 {
  background:
    radial-gradient(1000px 620px at 70% 16%, rgba(70, 96, 130, 0.4), transparent 62%),
    radial-gradient(900px 560px at 22% 84%, rgba(40, 60, 90, 0.4), transparent 66%),
    linear-gradient(160deg, #10141a 0%, #171d26 55%, #0e1218 100%);
}

[data-theme='dark'] .desktop__wallpaper::after {
  background:
    radial-gradient(1400px 900px at 50% -12%, rgba(255, 255, 255, 0.06), transparent 60%),
    radial-gradient(1200px 800px at 50% 118%, rgba(0, 0, 0, 0.35), transparent 62%);
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
