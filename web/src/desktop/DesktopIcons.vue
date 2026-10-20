<!--
  桌面图标区。

  Windows 的桌面图标是"网格吸附 + 自由摆放 + 双击打开 + 右键菜单"。
  这里实现到：网格排列、单击选中、双击打开、右键菜单（打开/新窗口）、
  以及键盘方向键导航（无障碍基本盘，也顺手支持了）。

  视觉（评审团定稿 + 二轮打磨）：白玻璃底座 + 主色线性字形。
  底座是"纸"，字形才是"墨"——比高饱和色块安静，比纯色字形更挺。
  标签颜色跟随主题（浅色主题深字、深色主题白字），都带反向文字阴影，
  保证在任何壁纸（含图片壁纸）上可读。

  未读红点：聊天有未读时在底座右上角标数字（与任务栏角标、右下角提示
  组成三层反馈；数字来自服务端 totalUnread，不在前端估算）。
-->
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { APPS, type AppDef } from '@/apps/registry'
import { shouldYieldKeyboard } from '@/desktop/keyboard'
import { useAuth } from '@/stores/auth'
import { useChat } from '@/stores/chat'
import { badgeText, useTodos } from '@/stores/todos'
import { useUi } from '@/stores/ui'
import { useWindows } from '@/stores/windows'

const windows = useWindows()
const auth = useAuth()
const ui = useUi()
const chat = useChat()
const todos = useTodos()

const selected = ref<string | null>(null)

const icons = computed<AppDef[]>(() =>
  APPS.filter((app) => app.onDesktop).filter((app) => !(app.adminOnly && !auth.isAdmin)),
)

/**
 * 图标右上角的数字。
 *
 * 聊天走自己的未读计数（服务端 totalUnread），记账/财物走待办接口。
 * 两套数字都是服务端算的 —— 前端不在这里"顺手估算"，否则角标和列表迟早对不上。
 */
function badgeOf(appId: string): number {
  if (appId === 'chat') return chat.totalUnread
  return todos.badgeFor(appId)
}

function badgeTitle(app: AppDef): string {
  const count = badgeOf(app.id)
  if (app.id === 'chat') return `${count} 条未读消息`
  if (app.id === 'ledger') return `${count} 项待办：待审批 / 被驳回待修改`
  if (app.id === 'assets') return `${count} 项待办：逾期未还 / ${todos.dueSoonDays} 天内到期`
  return `${count} 项待办`
}

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
      label: '更换壁纸…',
      icon: 'image',
      action: () => ui.openWallpaperPicker(),
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
      :style="app.tint ? { '--tint': app.tint } : undefined"
      @click.stop="selected = app.id"
      @dblclick="launch(app)"
      @contextmenu="onIconContextMenu($event, app)"
    >
      <span class="icon__glyph">
        <Icon :name="app.icon" :size="26" :stroke="1.6" />
        <!-- 角标：聊天是未读数；记账/财物是"等我处理的事"（数字都来自服务端，0 不显示） -->
        <span
          v-if="badgeOf(app.id) > 0"
          class="icon__badge"
          :title="badgeTitle(app)"
        >
          {{ badgeText(badgeOf(app.id)) }}
        </span>
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
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 2px;
  height: calc(100% - var(--taskbar-h));
}

.icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  width: 88px;
  padding: 10px var(--space-1) var(--space-2);
  border-radius: 8px;
  border: 1px solid transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/* 悬浮与选中都用"中性色的低透明度"——在明暗壁纸、图片壁纸上都自然 */
.icon:hover {
  background: rgba(127, 140, 156, 0.16);
  border-color: rgba(127, 140, 156, 0.2);
}

.icon--selected {
  background: rgba(127, 140, 156, 0.24);
  border-color: rgba(127, 140, 156, 0.34);
}

/* 白玻璃底座 + 主色字形 */
.icon__glyph {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.66);
  color: var(--tint, #6b7686);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.75),
    0 1px 2px rgba(16, 40, 72, 0.12),
    0 4px 14px rgba(16, 40, 72, 0.14);
  transition: transform var(--dur-fast) var(--ease-out);
}

.icon:hover .icon__glyph {
  transform: translateY(-1px);
}

[data-theme='dark'] .icon__glyph {
  background: rgba(255, 255, 255, 0.08);
  color: color-mix(in srgb, var(--tint, #9aa5b1) 62%, #ffffff);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 4px 14px rgba(0, 0, 0, 0.35);
}

/* 未读红点：坐在底座右上角，带一圈描边让它从底座上"浮"出来 */
.icon__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--danger);
  color: #ffffff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

[data-theme='dark'] .icon__badge {
  color: #3a1116;
  box-shadow: 0 0 0 2px rgba(22, 26, 34, 0.85);
}

/* 图标文字在壁纸上，必须自己带可读性保障：文字颜色跟主题 + 反向阴影 */
.icon__label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  color: var(--desktop-label);
  text-shadow: var(--desktop-label-shadow);
  word-break: break-all;
}

.desktop-icons__hint {
  color: var(--desktop-label);
  opacity: 0.7;
  font-size: 13px;
}
</style>
