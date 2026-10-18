/**
 * 界面偏好与通知。
 */
import { defineStore } from 'pinia'

export type Theme = 'dark' | 'light'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  detail?: string
  /** 毫秒；0 表示不自动消失 */
  duration: number
}

const THEME_KEY = 'wl.theme'
const WALLPAPER_KEY = 'wl.wallpaper'

let toastSeq = 0

interface State {
  theme: Theme
  wallpaper: number
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
    toasts: [],
    mobile: false,
    contextMenu: null,
  }),

  actions: {
    initTheme(): void {
      let theme: Theme = 'dark'
      try {
        const stored = localStorage.getItem(THEME_KEY)
        if (stored === 'light' || stored === 'dark') {
          theme = stored
        } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
          theme = 'light'
        }
        const wp = localStorage.getItem(WALLPAPER_KEY)
        if (wp !== null) this.wallpaper = Number(wp) || 0
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

    setWallpaper(index: number): void {
      this.wallpaper = index
      try {
        localStorage.setItem(WALLPAPER_KEY, String(index))
      } catch {
        // 忽略
      }
    },

    notify(kind: Toast['kind'], title: string, detail?: string, duration = 4000): number {
      const id = ++toastSeq
      this.toasts.push({ id, kind, title, detail, duration })
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
    },

    closeContextMenu(): void {
      this.contextMenu = null
    },
  },
})
