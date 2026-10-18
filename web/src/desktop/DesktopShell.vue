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
import WallpaperPicker from './WallpaperPicker.vue'
import { api } from '@/api'
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
 * 图片壁纸加载失败（文件被删 / 无权限）时回退。
 *
 * 壁纸只是装饰，不能因为一张图挂了就让用户对着空白桌面 —— 静默清掉引用，
 * 底下那层预设渐变壁纸还在，再给一条通知说明原因。
 */
function onWallpaperImageError(): void {
  if (!ui.wallpaperImage) return
  ui.clearWallpaperImage()
  ui.notify('warning', '壁纸图片已不可用', '文件可能已被删除或没有权限，已恢复预设壁纸')
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
    if (ui.wallpaperPickerOpen) {
      ui.closeWallpaperPicker()
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
    <!--
      壁纸分两层：底是预设光斑（wl-wall-N 全局类，与设置里的缩略图同源），
      上面可选叠一张来自文件空间的图片；图片加载失败时 @error 回退到预设。
    -->
    <div class="desktop__wallpaper" :class="`wl-wall-${ui.wallpaper}`">
      <img
        v-if="ui.wallpaperImage"
        class="desktop__wallpaper-photo"
        :src="api.previewUrl(ui.wallpaperImage.nodeId)"
        :alt="ui.wallpaperImage.name"
        draggable="false"
        @error="onWallpaperImageError"
      />
    </div>

    <DesktopIcons />

    <!-- 窗口层：所有打开的窗口 -->
    <div class="desktop__windows">
      <WindowFrame v-for="win in windows.windows" v-show="!win.minimized" :key="win.id" :win="win">
        <component :is="appComponents[win.appId]" :win="win" />
      </WindowFrame>
    </div>

    <Taskbar :start-open="startOpen" @toggle-start="toggleStart" />
    <StartMenu :open="startOpen" @close="closeStart" />
    <WallpaperPicker v-if="ui.wallpaperPickerOpen" />
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
 * 底色与光斑由全局类 wl-wall-N 提供（base.css，与设置/更换壁纸弹层共用）；
 * 这里只管定位、图片壁纸的铺法、以及一层光晕 + 暗角。
 */

.desktop__wallpaper {
  position: absolute;
  inset: 0;
  z-index: 0;
  /* ⚠️ 这里**不能**写 background：
   * 底色与光斑由全局类 wl-wall-N（base.css）提供，而作用域样式会给选择器
   * 加上 [data-v-xxx]，特异性永远高于全局类 —— 一旦在这里补"兜底背景"，
   * 它就会把四套预设壁纸全部盖住（localStorage 变了、画面不变）。
   * 曾经的兜底需求由 body 的 --bg-desktop 承担。 */
}

/* 图片壁纸：用户在文件空间里挑的那张，铺满裁剪 */
.desktop__wallpaper-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
  pointer-events: none;
}

/* 一层柔和光晕 + 一层极淡暗角，让平铺渐变有纵深 */
.desktop__wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255, 255, 255, 0.35), transparent 60%),
    radial-gradient(110% 70% at 50% 115%, rgba(16, 40, 72, 0.08), transparent 62%);
}

/* 图片壁纸时暗角稍重一点，保证桌面标签可读 */
.desktop__wallpaper:has(.desktop__wallpaper-photo)::after {
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255, 255, 255, 0.12), transparent 60%),
    radial-gradient(110% 70% at 50% 115%, rgba(16, 40, 72, 0.18), transparent 62%);
}

[data-theme='dark'] .desktop__wallpaper::after {
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255, 255, 255, 0.06), transparent 60%),
    radial-gradient(110% 70% at 50% 115%, rgba(0, 0, 0, 0.35), transparent 62%);
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
