<!--
  全局右键菜单。

  用 @floating-ui/dom 做边界翻转：菜单在屏幕右下角弹出时会被裁掉，浮层库
  会把它翻到反方向。这比手写边界计算可靠得多。
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import Icon from '@/components/Icon.vue'
import { useUi } from '@/stores/ui'

const ui = useUi()
const menuRef = ref<HTMLElement | null>(null)

watch(
  () => ui.contextMenu,
  async (menu) => {
    if (!menu) return
    // 先渲染到指针位置，再用浮层库修正边界
    await Promise.resolve()
    const el = menuRef.value
    if (!el) return
    const virtual = {
      getBoundingClientRect: () => ({
        x: menu.x,
        y: menu.y,
        top: menu.y,
        left: menu.x,
        bottom: menu.y,
        right: menu.x,
        width: 0,
        height: 0,
      }),
    }
    const { x, y } = await computePosition(virtual as unknown as Element, el, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
    })
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  },
)

function run(action?: () => void): void {
  const callback = action
  ui.closeContextMenu()
  callback?.()
}

function onGlobalPointerDown(): void {
  if (ui.contextMenu) ui.closeContextMenu()
}

window.addEventListener('pointerdown', onGlobalPointerDown)
window.addEventListener('blur', onGlobalPointerDown)
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('blur', onGlobalPointerDown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.contextMenu"
      ref="menuRef"
      class="ctx"
      :style="{ left: `${ui.contextMenu.x}px`, top: `${ui.contextMenu.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <template v-for="(item, index) in ui.contextMenu.items" :key="index">
        <div v-if="item.separator" class="ctx__sep" />
        <button
          v-else
          class="ctx__item"
          :class="{ 'ctx__item--danger': item.danger, 'ctx__item--disabled': item.disabled }"
          :disabled="item.disabled"
          @click="run(item.action)"
        >
          <span class="ctx__icon">
            <Icon v-if="item.icon" :name="item.icon" :size="15" />
          </span>
          <span class="ctx__label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx {
  position: fixed;
  z-index: var(--z-contextmenu);
  min-width: 180px;
  padding: var(--space-1);
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--surface-raised);
  backdrop-filter: blur(40px) saturate(180%);
  box-shadow: var(--shadow-popup);
  animation: ctx-in var(--dur-fast) var(--ease-out);
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(-2px);
  }
}

.ctx__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 30px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.ctx__item:hover:not(:disabled) {
  background: var(--hover);
}

.ctx__item:disabled,
.ctx__item--disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.ctx__item--danger {
  color: var(--danger);
}

.ctx__item--danger:hover:not(:disabled) {
  background: var(--danger-soft);
}

.ctx__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex: none;
  color: currentColor;
  opacity: 0.85;
}

.ctx__label {
  flex: 1;
  white-space: nowrap;
}

.ctx__sep {
  height: 1px;
  margin: var(--space-1) var(--space-2);
  background: var(--border);
}
</style>
