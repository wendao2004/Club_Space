/**
 * 桌面通知（浏览器级）与未读角标。
 *
 * **为什么不能只靠页面内的 Toast**：Toast 画在我们自己的 DOM 里，页面切到后台
 * （切标签、最小化、被别的应用盖住）时用户根本看不见 —— 而"有人找我"这件事
 * 恰恰最常发生在用户正在别的窗口里的时候。要让人真的感知到，就必须借用浏览器
 * 自己的通知系统（Windows 右下角那块）以及标签页标题。
 *
 * 三条约束：
 *   1. **权限只能由用户手势触发申请**。浏览器会忽略（甚至永久拉黑）没有手势的
 *      requestPermission。所以这里只提供函数，什么时候申请由设置页的按钮决定，
 *      绝不在收到消息时自作主张弹权限框。
 *   2. **声音不由这里负责**。系统通知自带提示音，而我们已经用 sfx 放了一声 ——
 *      两边都响就是"叮叮"两声。所以发通知时统一 `silent: true`。
 *   3. **必须能安全降级**。非安全上下文、浏览器不支持、权限被拒、构造抛错 ——
 *      一律当作"没有通知"，退回标题角标；绝不因为通知失败影响收消息。
 */

/** 'unsupported' 与 NotificationPermission 平级，省得调用方到处判空。 */
export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/** 默认标题。通知标题用应用名而不是会话名，多开会话时才分得清是哪个站。 */
const APP_TITLE = '社团空间'

/** 通知图标：内联 SVG，免得为了一个 32×32 的图标再进一次网络。 */
const ICON_URL = (() => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#2b6cf6"/>` +
    `<rect x="16" y="16" width="14" height="14" rx="3" fill="#fff"/>` +
    `<rect x="34" y="16" width="14" height="14" rx="3" fill="#ffffffb0"/>` +
    `<rect x="16" y="34" width="14" height="14" rx="3" fill="#ffffffb0"/>` +
    `<rect x="34" y="34" width="14" height="14" rx="3" fill="#fff"/>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
})()

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function'
}

/** 当前权限。不支持时返回 'unsupported'，调用方不必再判断。 */
export function notificationPermission(): NotifyPermission {
  if (!supported()) return 'unsupported'
  // 非安全上下文下 Notification 存在但 permission 恒为 'denied'，
  // 这里如实透出即可 —— 界面据此提示"需要 HTTPS"。
  return Notification.permission as NotifyPermission
}

export function notificationSupported(): boolean {
  return supported()
}

/**
 * 申请通知权限。**必须在用户点击的同一个调用栈里调用**，否则浏览器会忽略。
 *
 * 返回最终权限而不是 Promise<boolean>：被拒时界面要能说清"是你拒绝了"还是
 * "浏览器不支持"，这两种情况用户要做的事完全不同。
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (!supported()) return 'unsupported'
  try {
    return (await Notification.requestPermission()) as NotifyPermission
  } catch {
    // 老 Safari 的回调式签名、以及非安全上下文都会抛
    return notificationPermission()
  }
}

/**
 * 发一条桌面通知。**只在页面不在前台时调用** —— 前台有 Toast，再弹系统通知
 * 就是重复打扰（Windows 会在右下角弹出来，而用户正看着这个页面）。
 *
 * 返回 false 表示"没发出去"，调用方据此决定要不要退回标题角标（角标是无条件的，
 * 这里不负责）。
 */
export function showDesktopNotification(input: {
  title: string
  body?: string
  /** 同一 tag 的通知会互相替换而不是堆叠；用会话 id 正好。 */
  tag?: string
  onClick?: () => void
}): boolean {
  if (notificationPermission() !== 'granted') return false
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: ICON_URL,
      badge: ICON_URL,
      // 声音由 sfx 统一负责（它知道自己有没有被静音），这里静掉
      silent: true,
    })
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        /* 某些浏览器不允许脚本聚焦窗口，忽略 */
      }
      input.onClick?.()
      notification.close()
    }
    return true
  } catch {
    // 部分浏览器（尤其移动端）构造函数直接抛。当作没发出去。
    return false
  }
}

/** 页面是否"没在用户眼前"：切了标签、最小化、或被别的应用盖住。 */
export function isPageHidden(): boolean {
  if (typeof document === 'undefined') return false
  if (document.hidden) return true
  // document.hidden 只反映标签页是否可见：切到别的应用时它仍是 false，
  // 但 hasFocus() 会变 false —— 那种情况下用户同样看不到 Toast。
  try {
    return !document.hasFocus()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 标题与图标

let badgeCount = -1
let titleEl: HTMLElement | null = null
let iconLink: HTMLLinkElement | null = null
let iconCount = -1

function badgeSvg(count: number): string {
  const text = count > 99 ? '99+' : String(count)
  const fontSize = text.length >= 3 ? 15 : text.length === 2 ? 18 : 20
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#2b6cf6"/>` +
    `<rect x="10" y="10" width="16" height="16" rx="4" fill="#fff"/>` +
    `<rect x="38" y="10" width="16" height="16" rx="4" fill="#ffffffa0"/>` +
    `<rect x="10" y="38" width="16" height="16" rx="4" fill="#ffffffa0"/>` +
    `<rect x="38" y="38" width="16" height="16" rx="4" fill="#fff"/>` +
    `<circle cx="46" cy="18" r="15" fill="#e5484d" stroke="#fff" stroke-width="3"/>` +
    `<text x="46" y="18" dy="0.35em" text-anchor="middle" font-family="Segoe UI,sans-serif" ` +
    `font-size="${fontSize}" font-weight="700" fill="#fff">${text}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * 更新标签页标题上的未读数与 favicon 角标。
 *
 * 这是通知不可用时的**兜底**：哪怕用户拒绝了通知权限、或者处在非安全上下文，
 * 回到浏览器时至少能看到"这里有个 3"。理论上页面在后台时用户看不到标签上的
 * 数字，但那正是系统通知负责的场次；两者是互补而不是二选一。
 */
export function setTitleBadge(count: number): void {
  const next = Math.max(0, Math.floor(count))
  if (next === badgeCount) return
  badgeCount = next

  if (typeof document === 'undefined') return
  if (!titleEl) titleEl = document.querySelector('title')
  if (titleEl) titleEl.textContent = next > 0 ? `(${next > 99 ? '99+' : next}) ${APP_TITLE}` : APP_TITLE

  if (next === iconCount) return
  iconCount = next
  applyIcon(next)
}

function applyIcon(count: number): void {
  if (typeof document === 'undefined') return

  if (count <= 0) {
    // 清掉我们加的图标，浏览器回到默认（没有 favicon 就是空白页图标）
    iconLink?.remove()
    iconLink = null
    return
  }

  if (!iconLink) {
    iconLink = document.createElement('link')
    iconLink.rel = 'icon'
    iconLink.type = 'image/svg+xml'
    document.head.appendChild(iconLink)
  }
  iconLink.href = badgeSvg(count)
}

/** 退出登录 / 关闭所有聊天窗口时把角标彻底清掉。 */
export function clearTitleBadge(): void {
  setTitleBadge(0)
}
