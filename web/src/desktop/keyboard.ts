/**
 * 全局键盘事件的守卫。
 *
 * ============================================================================
 * 为什么需要这个文件
 * ============================================================================
 *
 * 桌面外壳有两个挂在 `window` 上的 keydown 监听：桌面图标的导航
 * （DesktopIcons.vue）与系统快捷键（DesktopShell.vue）。它们是**全局**的，
 * 也就是说页面上任何地方敲键盘都会触发。
 *
 * 这本身没错 —— 桌面外壳本来就该在没有焦点归属时接管键盘。但有一类事件
 * 必须放过去：**焦点在输入框里的那些**。
 *
 * 出过的真实故障：桌面图标选中之后（点一下图标就会选中），在聊天框里按回车
 * 发消息，消息确实发出去了，但**同时也"打开"了那个选中的桌面图标**，
 * 凭空多弹一个窗口出来。原因是事件冒泡：
 *
 *   输入框自己的 keydown 处理器 → ... → window 上的处理器
 *
 * 聊天框里调用 `event.preventDefault()` 只挡得住**默认行为**，
 * 挡不住事件继续冒泡到 window。于是桌面图标那边照样收到回车并执行了启动。
 *
 * 用户描述成"回车发送消息会单开页面"，看代码时很容易去怀疑表单提交，
 * 但真正的原因是另一个组件在旁边抢同一个按键。
 */

/** 焦点是否落在一个"正在输入"的元素上。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // 富文本编辑器（contenteditable）也要算
  if (el.isContentEditable) return true
  return false
}

/** 焦点是否落在某个应用窗口内部（不管是不是输入框）。 */
export function isInsideWindow(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('.window') !== null
}

/**
 * 全局快捷键是否应该**放弃**处理这个事件。
 *
 * 两种情况都放弃：
 *   1. 焦点在输入框里 —— 这个按键属于那个输入框。在聊天框按回车是"发送"，
 *      在文件管理里按回车是"重命名"，都不是"打开桌面图标"。
 *   2. 焦点在某个应用窗口里 —— 窗口内部有自己的按键语义。窗口没处理掉的按键
 *      也不该漏到桌面层去执行一个不相干的动作。
 *
 * 只有焦点确实在桌面本身（点了桌面空白处、或窗口全关）时，
 * 桌面图标导航与系统快捷键才该生效。
 */
export function shouldYieldKeyboard(event: KeyboardEvent): boolean {
  return isTypingTarget(event.target) || isInsideWindow(event.target)
}
