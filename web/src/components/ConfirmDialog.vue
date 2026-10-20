<!--
  统一确认框。

  记账/财物在"有未保存修改时要关闭弹层"这个场景里需要问一句。用一个组件而
  不是各自的 `<div class="overlay">`，是为了让确认框也自动拥有焦点陷阱与
  Esc 处理 —— 否则会出现"主弹层补了键盘可达性、确认框又把焦点漏出去"。

  点确定/取消/按 Esc 都只是发事件，不自己关自己：开关状态由调用方持有，
  这样"确认后关掉编辑弹层"这种连续动作的顺序是明确的。
-->
<script setup lang="ts">
import { useId } from 'vue'
import ModalShell from '@/components/ModalShell.vue'

withDefaults(
  defineProps<{
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }>(),
  { confirmText: '确定', cancelText: '取消', danger: false },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

// 同一个页面里可能同时存在多个确认框实例，用 useId 避免标题 id 撞车
const titleId = useId()
</script>

<template>
  <ModalShell
    overlay-class="wl-confirm"
    variant="card"
    :labelledby="titleId"
    initial-focus=".wl-btn"
    @close="emit('cancel')"
  >
    <h3 :id="titleId" class="wl-confirm__title">{{ title }}</h3>
    <p class="wl-confirm__message">{{ message }}</p>
    <div class="wl-confirm__actions">
      <button class="wl-btn" @click="emit('cancel')">{{ cancelText }}</button>
      <button
        class="wl-btn"
        :class="danger ? 'wl-btn--danger' : 'wl-btn--primary'"
        @click="emit('confirm')"
      >
        {{ confirmText }}
      </button>
    </div>
  </ModalShell>
</template>

<style scoped>
/* 盖在编辑弹层之上（记账 .overlay 是 20，财物 .dialog 是 30） */
.wl-confirm.wl-modal {
  z-index: 40;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--surface-solid) 66%, transparent);
}

.wl-confirm__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.wl-confirm__message {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-line;
}

.wl-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
