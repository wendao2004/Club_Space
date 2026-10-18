<!--
  桌面图标区。

  Windows 的桌面图标是"网格吸附 + 自由摆放 + 双击打开 + 右键菜单"。
  这里实现到：网格排列、单击选中、双击打开、右键菜单（打开/新窗口）、
  以及键盘方向键导航（无障碍基本盘，也顺手支持了）。
-->
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { APPS, type AppDef } from '@/apps/registry'
import { shouldYieldKeyboard } from '@/desktop/keyboard'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useWindows } from '@/stores/windows'

const windows = useWindows()
const auth = useAuth()
const ui = useUi()

const selected = ref<string | null>(null)

const icons = computed<AppDef[]>(() =>
  APPS.filter((app) => app.onDesktop).filter((app) => !(app.adminOnly && !auth.isAdmin)),
)

function launch(app: AppDef, force = false): void {
  windows.open({
    appId: app.id,
    title: app.name,
    w: app.defaultSize?.w,
    h: app.defaultSize?.h,
    minW: app.minSize?.w,
    minH: app.minSize?.h,
    resizable: app.resizable,
    force,
  })
}

function onIconContextMenu(event: MouseEvent, app: AppDef): void {
  event.preventDefault()
  event.stopPropagation()
  selected.value = app.id
  ui.openContextMenu(event.clientX, event.clientY, [
    { label: '打开', icon: 'folder-open', action: () => launch(app) },
    { label: '在新窗口打开', icon: 'external', action: () => launch(app, true) },
    { separator: true, label: '' },
    { label: app.description, disabled: true },
  ])
}

function onDesktopContextMenu(event: MouseEvent): void {
  event.preventDefault()
  selected.value = null
  ui.openContextMenu(event.clientX, event.clientY, [
    {
      label: '刷新',
      icon: 'refresh',
      action: () => window.location.reload(),
    },
    { separator: true, label: '' },
    {
      label: ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
      icon: ui.theme === 'dark' ? 'sun' : 'moon',
      action: () => ui.toggleTheme(),
    },
    {
      label: '更换壁纸',
      icon: 'image',
      action: () => ui.setWallpaper((ui.wallpaper + 1) % 4),
    },
    { separator: true, label: '' },
    {
      label: '最小化全部窗口',
      icon: 'minimize',
      disabled: windows.windows.length === 0,
      action: () => windows.minimizeAll(),
    },
  ])
}

/** 点击桌面空白处取消选中。 */
function onDesktopClick(): void {
  selected.value = null
}

/** Delete 键删除？桌面图标是应用快捷方式，不可删——所以什么都不做，而不是给个假删除。 */
function onKeydown(event: KeyboardEvent): void {
  // ⚠️ 这一行是修一个真实故障的关键，不能省。
  //
  // 这个监听挂在 window 上，页面上任何地方敲键盘都会到达这里。图标一旦被点过
  // 就处于"选中"状态，于是**在聊天框里按回车发消息时，这里也会收到回车**，
  // 顺手把那个选中的图标启动起来 —— 用户看到的是"发消息的时候凭空多开一个窗口"。
  //
  // 聊天框里的 preventDefault() 挡不住这个：它只挡默认行为，不挡事件冒泡。
  // 所以必须由这边主动让路。
  if (shouldYieldKeyboard(event)) return

  if (!selected.value) return
  const index = icons.value.findIndex((a) => a.id === selected.value)
  if (index < 0) return
  const columns = Math.max(1, Math.floor((window.innerHeight - 140) / 92))

  if (event.key === 'Enter') {
    launch(icons.value[index]!)
    event.preventDefault()
  } else if (event.key === 'ArrowDown') {
    const next = icons.value[index + 1]
    if (next) selected.value = next.id
    event.preventDefault()
  } else if (event.key === 'ArrowUp') {
    const prev = icons.value[index - 1]
    if (prev) selected.value = prev.id
    event.preventDefault()
  } else if (event.key === 'ArrowRight') {
    const next = icons.value[index + columns]
    if (next) selected.value = next.id
    event.preventDefault()
  } else if (event.key === 'ArrowLeft') {
    const prev = icons.value[index - columns]
    if (prev) selected.value = prev.id
    event.preventDefault()
  } else if (event.key === 'Escape') {
    selected.value = null
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="desktop-icons" @click="onDesktopClick" @contextmenu="onDesktopContextMenu">
    <button
      v-for="app in icons"
      :key="app.id"
      class="icon"
      :class="{ 'icon--selected': selected === app.id }"
      @click.stop="selected = app.id"
      @dblclick="launch(app)"
      @contextmenu="onIconContextMenu($event, app)"
    >
      <span class="icon__glyph" :style="app.tint ? { background: app.tint } : undefined">
        <Icon :name="app.icon" :size="26" :stroke="1.4" />
      </span>
      <span class="icon__label">{{ app.name }}</span>
    </button>

    <p v-if="icons.length === 0" class="desktop-icons__hint">没有可用应用</p>
  </div>
</template>

<style scoped>
.desktop-icons {
  position: absolute;
  inset: 0;
  z-index: var(--z-desktop);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: var(--space-1);
  height: calc(100% - var(--taskbar-h));
}

.icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  width: 84px;
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.icon:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(6px);
}

.icon--selected {
  background: var(--selected);
  border-color: var(--accent);
}

.icon__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 10px;
  background: var(--surface-3);
  color: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
}

/* 图标文字在壁纸上，必须自己带可读性保障：文字阴影比背景块更不打扰视觉 */
.icon__label {
  font-size: 12px;
  line-height: 1.25;
  text-align: center;
  color: #fff;
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.85),
    0 0 2px rgba(0, 0, 0, 0.7);
  word-break: break-all;
}

.desktop-icons__hint {
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
}
</style>
