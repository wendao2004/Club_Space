<!--
  弹层外壳：Esc / 点遮罩关闭、焦点陷阱、关闭后归还焦点。

  为什么要抽出来：记账与财物的编辑弹层此前各自手写遮罩点击，既没有 Esc，
  也没有焦点约束 —— Tab 会一路跑到弹层背后的列表上，关掉之后焦点直接丢到
  body，键盘用户得从头 Tab 一遍才能回到原来的按钮。

  这里**只管"怎么关"和"焦点在哪"**，不管长什么样：外观类名由调用方通过
  overlay-class / panel-class 传进来，表单内容原样放进默认插槽，业务逻辑
  一行都不用改。

  关闭是"请求"而不是命令：Esc / 点遮罩都只 emit('close')，由父组件决定
  是立即关闭、弹确认、还是因为正在提交而拒绝 —— 有未保存内容时先确认，
  正是靠这层间接才做得到。

  嵌套：同一时刻可能有多个弹层（例如编辑表单里再开文件选择器）。用模块级
  的栈记录挂载顺序，只有最上面那层响应 Esc / Tab，底下那层不会跟着一起关。

  刻意不引第三方 focus-trap：这里需要的只是 Tab 循环 + Esc + 焦点归还，
  几十行足够，而多一个依赖就多一份升级和体积成本。
-->
<script lang="ts">
/**
 * 挂载顺序栈。必须是**模块级**的：`<script setup>` 里的顶层变量每个组件实例
 * 各有一份，那样每个弹层都以为自己是栈顶，嵌套时按一次 Esc 会关掉两层。
 */
const modalStack: string[] = []
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 标题元素的 id；与调用方的标题节点对应，保证对话框有可读的名字 */
    labelledby?: string
    /** 没有 labelledby 时的兜底名字 */
    label?: string
    /** false 表示当前不允许关闭（比如正在提交），Esc 与遮罩都不响应 */
    closable?: boolean
    /** 打开时优先聚焦的选择器；缺省聚焦第一个可聚焦元素 */
    initialFocus?: string
    overlayClass?: string
    panelClass?: string
    backdropClass?: string
    /** 是否额外渲染一层独立遮罩（财物/管理后台那种 .dialog__backdrop 结构） */
    backdrop?: boolean
    /** card：由本组件提供一张通用的卡片面板样式（确认框用） */
    variant?: 'bare' | 'card'
  }>(),
  {
    labelledby: '',
    label: '',
    closable: true,
    initialFocus: '',
    overlayClass: '',
    panelClass: '',
    backdropClass: '',
    backdrop: false,
    variant: 'bare',
  },
)

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
/** 全局唯一标识，用来判断自己是不是模态栈的栈顶 */
const id = useId()

/** 打开这个弹层之前焦点在哪 —— 关闭时还回去。 */
let previouslyFocused: HTMLElement | null = null

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isTop(): boolean {
  return modalStack[modalStack.length - 1] === id
}

/**
 * 元素是不是真的能被 Tab 到。
 *
 * 只用 getClientRects() 不够：`<details>` 收起时，里面的内容在 Chrome 里仍然
 * 有布局盒（chrome 用的是 content-visibility 而不是 display:none），会被算成
 * 可聚焦，于是"最后一个可聚焦元素"指到一个 Tab 不到的地方 —— 焦点陷阱就在
 * 那里漏了，Tab 直接跑到任务栏上。checkVisibility 会把这些算进去。
 */
function isTabbable(node: HTMLElement): boolean {
  if (node.getAttribute('aria-hidden') === 'true') return false
  if (node.tabIndex < 0) return false
  const check = (
    node as HTMLElement & { checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean }
  ).checkVisibility
  if (typeof check === 'function') {
    return check.call(node, { checkVisibilityCSS: true })
  }
  return node.getClientRects().length > 0
}

/** 真正能 Tab 到的元素：过滤掉不可见（含被折叠容器藏住）的。 */
function focusables(): HTMLElement[] {
  const el = panel.value
  if (!el) return []
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabbable)
}

function focusInitial(): void {
  const el = panel.value
  if (!el) return
  let target: HTMLElement | null = null
  if (props.initialFocus) {
    target = el.querySelector<HTMLElement>(props.initialFocus)
  }
  if (!target) {
    const list = focusables()
    target = list[0] ?? el
  }
  target.focus()
}

function onKeydown(event: KeyboardEvent): void {
  // 下层弹层不处理键盘：Esc 只关最上面那层
  if (!isTop()) return

  if (event.key === 'Escape') {
    // 拦在 document 捕获阶段：桌面外壳在 window 上也监听 Escape，不拦会连带
    // 关窗口/开始菜单。用 stopImmediate 而不是 stopPropagation —— 同一个
    // document 上还挂着下层弹层的监听，stopPropagation 拦不住它。
    event.preventDefault()
    event.stopImmediatePropagation()
    if (props.closable) emit('close')
    return
  }

  if (event.key !== 'Tab') return

  const list = focusables()
  const el = panel.value
  if (!el) return
  if (list.length === 0) {
    event.preventDefault()
    el.focus()
    return
  }

  const first = list[0] as HTMLElement
  const last = list[list.length - 1] as HTMLElement
  const active = document.activeElement as HTMLElement | null

  // 焦点跑到面板外（点过背景、或 JS 移动过焦点）：先拉回面板内
  if (!active || active === el || !el.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function requestClose(): void {
  if (props.closable) emit('close')
}

onMounted(() => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  modalStack.push(id)
  // 捕获阶段：比桌面外壳挂在 window 上的监听更早拿到事件
  document.addEventListener('keydown', onKeydown, true)
  void nextTick(focusInitial)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  const idx = modalStack.lastIndexOf(id)
  if (idx >= 0) modalStack.splice(idx, 1)

  // 焦点归还：延后一拍再判断。
  //
  // 关闭可能连着关闭两层（编辑弹层 + 它上面的确认框）：两层在同一个 flush 里
  // 卸载，谁先谁后不确定。此时被聚焦的节点会先被移除、activeElement 落回 body，
  // 等这一轮 DOM 更新结束再看，才能分清"焦点是掉到 body 了"还是"用户已经
  // 主动点到别处了"。只有前者才把焦点还给打开它的那个按钮。
  const target = previouslyFocused
  if (!target) return
  void nextTick(() => {
    if (!target.isConnected) return
    const active = document.activeElement
    if (active === null || active === document.body) target.focus({ preventScroll: true })
  })
})
</script>

<template>
  <div class="wl-modal" :class="overlayClass" @click.self="requestClose">
    <div v-if="backdrop" :class="['wl-modal__backdrop', backdropClass]" @click="requestClose" />
    <div
      ref="panel"
      class="wl-modal__panel"
      :class="[panelClass, variant === 'card' ? 'wl-modal__panel--card' : '']"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="labelledby || undefined"
      :aria-label="labelledby ? undefined : label || undefined"
      tabindex="-1"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.wl-modal {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.wl-modal__backdrop {
  position: absolute;
  inset: 0;
}

.wl-modal__panel {
  position: relative;
  outline: none;
}

/* 确认框用的通用卡片；带业务外观的弹层自己传 panel-class，不会走到这里 */
.wl-modal__panel--card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: min(400px, 100%);
  padding: var(--space-4);
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popup);
}
</style>
