<!--
  通知中心。

  两件事要注意：

  1. 内网无公网，浏览器 Web Push 依赖 FCM/Mozilla 的公网推送端点，架构上
     不可用。所以通知只在页面打开时通过这里给出，不做"关了标签页也能收到"的
     虚假承诺。

  2. 页面在后台时，如果浏览器支持且已进入安全上下文，用 Notification API
     补一条系统通知 —— 这条路在装好内网根证书之后是可用的（Service Worker
     与 Notification 都要求安全上下文）。
-->
<script setup lang="ts">
import { watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { useUi, type Toast } from '@/stores/ui'

const ui = useUi()

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

// 有新通知且页面在后台时，尝试发一条系统级通知
watch(
  () => ui.toasts.length,
  (length, previous) => {
    if (length <= (previous ?? 0)) return
    const latest = ui.toasts[ui.toasts.length - 1]
    if (!latest) return
    if (document.visibilityState === 'visible') return
    if (!('Notification' in window)) return
    if (window.isSecureContext === false) return
    if (Notification.permission !== 'granted') return
    try {
      new Notification(latest.title, { body: latest.detail ?? '', tag: String(latest.id) })
    } catch {
      // 通知失败不该影响主流程
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div class="toasts">
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
