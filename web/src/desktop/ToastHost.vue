<!--
  通知中心。

  两件事要注意：

  1. 内网无公网，浏览器 Web Push 依赖 FCM/Mozilla 的公网推送端点，架构上
     不可用。所以通知只在页面打开时通过这里给出，不做"关了标签页也能收到"的
     虚假承诺。

  2. **系统级通知不在这里发**。这里曾经有一个 watcher：只要有新 Toast 且页面
     不可见，就 `new Notification(...)`。它有两个问题 ——
        - 覆盖太宽：连"已出牌""文件已保存"这类几百毫秒就过期的回执也会推到
          系统通知中心，一天下来能把通知栏刷满；
        - 判据不全：只看 `document.visibilityState`，而切到别的应用（浏览器在
          后台但标签页仍 visible）时 `hasFocus()` 才是 false，那时用户同样看不到。
     现在统一由 `@/lib/notify` 提供能力、由**具体业务**决定要不要通知
     （目前只有聊天新消息），见 stores/chat.ts 的 notifyIncoming。
-->
<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { useUi, type Toast } from '@/stores/ui'

const ui = useUi()

/**
 * 移动端的通知要躲开底部 Tab 栏。
 *
 * 桌面外壳的定位是 bottom: taskbar-h + space-4（任务栏 48px），但移动壳底部
 * 是一条 56px + 安全区的 Tab 栏，48px 的偏移量不够，toast 会被压住半截。
 * 这里只调底部偏移量，其余（宽度 340px 收成 max-width: 100vw - 32px、右下角
 * 对齐）在手机上都本来就合适。
 */
const bottomInset = computed(() =>
  ui.mobile
    ? 'calc(56px + env(safe-area-inset-bottom) + var(--space-4))'
    : 'calc(var(--taskbar-h) + var(--space-4))',
)

const icons: Record<string, string> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  error: 'alert',
}

/**
 * 可点击的通知：点一下执行动作（比如"跳到那条消息"）并收起。
 * 带 onClick 的通知在视觉上也是可点的（手型光标 + 悬浮边框）。
 */
function onToastClick(toast: Toast): void {
  if (!toast.onClick) return
  const action = toast.onClick
  ui.dismiss(toast.id)
  action()
}
</script>

<template>
  <Teleport to="body">
    <div class="toasts" :style="{ bottom: bottomInset }">
      <TransitionGroup name="toast">
        <div
          v-for="toast in ui.toasts"
          :key="toast.id"
          class="toast"
          :class="[`toast--${toast.kind}`, { 'toast--clickable': !!toast.onClick }]"
          :role="toast.onClick ? 'button' : undefined"
          :tabindex="toast.onClick ? 0 : undefined"
          @click="onToastClick(toast)"
          @keydown.enter="onToastClick(toast)"
        >
          <span class="toast__icon">
            <Icon :name="icons[toast.kind] ?? 'info'" :size="16" />
          </span>
          <div class="toast__text">
            <div class="toast__title">{{ toast.title }}</div>
            <div v-if="toast.detail" class="toast__detail">{{ toast.detail }}</div>
          </div>
          <button class="toast__close" title="关闭" @click.stop="ui.dismiss(toast.id)">
            <Icon name="close" :size="13" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--taskbar-h) + var(--space-4));
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 340px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  backdrop-filter: blur(40px) saturate(1.8);
  box-shadow: var(--shadow-popup);
  pointer-events: auto;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

/* 可点击的通知：手型光标 + 悬浮反馈，让它"看起来能点" */
.toast--clickable {
  cursor: pointer;
}

.toast--clickable:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.toast__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  background: var(--chip-bg);
  color: var(--text-secondary);
}

.toast--success .toast__icon {
  background: var(--success-soft);
  color: var(--success);
}
.toast--warning .toast__icon {
  background: var(--warning-soft);
  color: var(--warning);
}
.toast--error .toast__icon {
  background: var(--danger-soft);
  color: var(--danger);
}

.toast__text {
  flex: 1;
  min-width: 0;
  padding-top: 2px;
}

.toast__title {
  font-size: var(--fs-body);
  font-weight: 600;
}

.toast__detail {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  word-break: break-word;
}

.toast__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
}

.toast__close:hover {
  background: var(--hover);
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-spring);
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(24px) scale(0.96);
}
</style>
