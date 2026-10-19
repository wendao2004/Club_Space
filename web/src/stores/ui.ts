/**
 * 界面偏好与通知。
 */
import { defineStore } from 'pinia'
import { playSystem, type SystemSound } from '@/lib/sfx'

export type Theme = 'dark' | 'light'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  detail?: string
  /** 毫秒；0 表示不自动消失 */
  duration: number
  /** 可选：点击通知时执行（例如"跳到那条消息"），执行后通知自动收起 */
  onClick?: () => void
}

/**
 * 图片壁纸：只存引用（nodeId）与展示名，图片本体留在文件空间里。
 * 换设备 / 换浏览器时各自独立 —— 与"主题与壁纸仅影响本机显示"的既有设定一致。
 */
export interface WallpaperImage {
  nodeId: string
  name: string
}

const THEME_KEY = 'wl.theme'
const WALLPAPER_KEY = 'wl.wallpaper'
const WALLPAPER_IMAGE_KEY = 'wl.wallpaper.image'

let toastSeq = 0

/**
 * 通知默认配什么声音。
 *
 * 按 Toast 的类型走，而不是让 162 个调用点各自决定 —— 那样必然有人漏写、
 * 有人写错，最后听起来像随手乱响。需要特别指定的（比如聊天消息比普通通知
 * 更轻），在 options.sound 里单独覆盖。
 */
const DEFAULT_TOAST_SOUND: Record<Toast['kind'], SystemSound> = {
  info: 'notify',
  success: 'success',
  warning: 'warning',
  error: 'error',
}

/**
 * 通知音的节流。
 *
 * 一个批量操作可能连着弹好几条（批量删除、批量导入），每条都"叮"一下就
 * 变成噪音了。250ms 内只响第一声 —— 视觉上的通知一条不少，声音只留一个。
 */
let lastToastSoundAt = 0
const TOAST_SOUND_GAP = 250

interface State {
  theme: Theme
  /** 预设壁纸编号（0-3）；图片壁纸激活时它作为兜底背景仍在 */
  wallpaper: number
  wallpaperImage: WallpaperImage | null
  /** "更换壁纸"选择器是否打开（桌面右键 / 设置应用共用同一个） */
  wallpaperPickerOpen: boolean
  toasts: Toast[]
  /** 移动端壳：窄屏时由 App.vue 设置 */
  mobile: boolean
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null
}

export interface ContextMenuItem {
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  action?: () => void
}

export const useUi = defineStore('ui', {
  state: (): State => ({
    theme: 'dark',
    wallpaper: 0,
    wallpaperImage: null,
    wallpaperPickerOpen: false,
    toasts: [],
    mobile: false,
    contextMenu: null,
  }),

  actions: {
    initTheme(): void {
      // 浅色是主角：没有存过偏好时默认浅色，只有系统明确偏好深色才跟随
      let theme: Theme = 'light'
      try {
        const stored = localStorage.getItem(THEME_KEY)
        if (stored === 'light' || stored === 'dark') {
          theme = stored
        } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
          theme = 'dark'
        }
        const wp = localStorage.getItem(WALLPAPER_KEY)
        if (wp !== null) this.wallpaper = Number(wp) || 0
        const rawImage = localStorage.getItem(WALLPAPER_IMAGE_KEY)
        if (rawImage) {
          try {
            const parsed = JSON.parse(rawImage) as Partial<WallpaperImage>
            if (typeof parsed?.nodeId === 'string' && typeof parsed?.name === 'string') {
              this.wallpaperImage = { nodeId: parsed.nodeId, name: parsed.name }
            }
          } catch {
            // 坏数据当作没设过
          }
        }
      } catch {
        // localStorage 不可用时用默认值
      }
      this.setTheme(theme)
    },

    setTheme(theme: Theme): void {
      this.theme = theme
      document.documentElement.dataset.theme = theme
      try {
        localStorage.setItem(THEME_KEY, theme)
      } catch {
        // 忽略
      }
    },

    toggleTheme(): void {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark')
    },

    /** 选预设壁纸：图片壁纸同时被清掉（预设与图片互斥）。 */
    setWallpaper(index: number): void {
      this.wallpaper = index
      try {
        localStorage.setItem(WALLPAPER_KEY, String(index))
      } catch {
        // 忽略
      }
      this.setWallpaperImage(null)
    },

    setWallpaperImage(image: WallpaperImage | null): void {
      this.wallpaperImage = image
      try {
        if (image) localStorage.setItem(WALLPAPER_IMAGE_KEY, JSON.stringify(image))
        else localStorage.removeItem(WALLPAPER_IMAGE_KEY)
      } catch {
        // 忽略
      }
    },

    clearWallpaperImage(): void {
      this.setWallpaperImage(null)
    },

    openWallpaperPicker(): void {
      this.wallpaperPickerOpen = true
    },

    closeWallpaperPicker(): void {
      this.wallpaperPickerOpen = false
    },

    notify(
      kind: Toast['kind'],
      title: string,
      detail?: string,
      duration = 4000,
      options?: { onClick?: () => void; sound?: SystemSound | 'none' },
    ): number {
      const id = ++toastSeq
      this.toasts.push({ id, kind, title, detail, duration, onClick: options?.onClick })

      const sound = options?.sound ?? DEFAULT_TOAST_SOUND[kind]
      if (sound !== 'none') {
        const now = performance.now()
        // 出错必须让人听见：静默掉一条"保存失败"比多响一声危险得多
        if (kind === 'error' || now - lastToastSoundAt >= TOAST_SOUND_GAP) {
          lastToastSoundAt = now
          playSystem(sound)
        }
      }

      if (duration > 0) {
        window.setTimeout(() => this.dismiss(id), duration)
      }
      return id
    },

    dismiss(id: number): void {
      const index = this.toasts.findIndex((t) => t.id === id)
      if (index >= 0) this.toasts.splice(index, 1)
    },

    openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
      this.contextMenu = { x, y, items }
      playSystem('click')
    },

    closeContextMenu(): void {
      this.contextMenu = null
    },
  },
})
