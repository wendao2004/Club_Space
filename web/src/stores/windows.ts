/**
 * 窗口管理器状态。
 *
 * 这是整个桌面外壳的核心：谁在上面、窗口在哪、多大、最小化还是最大化。
 * 定位/缩放的低层手势交给 interact.js（见 WindowFrame.vue），这里只管状态。
 *
 * 刻意自己写而不是用现成库：评审团核实过 winbox（2023-07 停更且缺桌面级设施）、
 * golden-layout（2022-09 停更）、OS.js（强锁定）都无法满足"自由重叠窗口 +
 * 任务栏 + 多桌面 + 贴边分屏"这一组需求，皮肤类库（98.css / React95）只是外观。
 */
import { defineStore } from 'pinia'
import { playSystem } from '@/lib/sfx'

export type SnapZone = 'none' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface WindowInstance {
  id: string
  /** 应用标识，决定用哪个组件渲染内容。 */
  appId: string
  title: string
  /** 打开时传入的参数（例如"打开这个目录""对这个文件运行工具"）。 */
  args: Record<string, unknown>
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
  /** 最大化之前的位置尺寸，用于还原。 */
  restore: { x: number; y: number; w: number; h: number } | null
  /** 贴边状态；非 none 时窗口被吸附到屏幕一侧。 */
  snap: SnapZone
  resizable: boolean
  minW: number
  minH: number
}

/** 任务栏高度，参与可用工作区计算。 */
export const TASKBAR_HEIGHT = 48

/**
 * 关闭守卫（窗口 id → 钩子）。
 *
 * 放在 store 外面、刻意**不进 state**：它是一组函数，参与响应式追踪没有任何好处，
 * 反而会让 Pinia 尝试代理这些闭包。它也不需要被持久化 —— 窗口都关了，
 * 守卫自然无处可挂。
 */
const closeGuards = new Map<string, () => boolean | Promise<boolean>>()

let seq = 0
function nextId(): string {
  seq += 1
  return `w${Date.now().toString(36)}${seq}`
}

interface State {
  windows: WindowInstance[]
  activeId: string | null
  topZ: number
  /** 离开页面前的布局快照，刷新后恢复。 */
  savedLayout: Array<Pick<WindowInstance, 'appId' | 'title' | 'args' | 'x' | 'y' | 'w' | 'h' | 'maximized'>> | null
}

const LAYOUT_KEY = 'wl.desktop.layout'

/** 工作区尺寸（排除任务栏）。移动端会把任务栏换成底部 Tab，高度仍按 TASKBAR_HEIGHT 算。 */
function workArea(): { w: number; h: number } {
  return {
    w: window.innerWidth,
    h: Math.max(240, window.innerHeight - TASKBAR_HEIGHT),
  }
}

export const useWindows = defineStore('windows', {
  state: (): State => ({
    windows: [],
    activeId: null,
    topZ: 10,
    savedLayout: null,
  }),

  getters: {
    /** 任务栏顺序按打开顺序，而不是 z 序 —— 否则图标会随点击乱跳。 */
    ordered: (state): WindowInstance[] => state.windows,

    active(state): WindowInstance | null {
      return state.windows.find((w) => w.id === state.activeId) ?? null
    },

    hasVisible(state): boolean {
      return state.windows.some((w) => !w.minimized)
    },
  },

  actions: {
    /**
     * 打开一个窗口。
     *
     * 若同一应用且参数相同的窗口已存在，就不开新的，而是把已有的拉出来 ——
     * 这是 Windows 里"再次点击图标聚焦已有窗口"的行为，也是用户默认的预期。
     */
    open(input: {
      appId: string
      title: string
      args?: Record<string, unknown>
      w?: number
      h?: number
      resizable?: boolean
      minW?: number
      minH?: number
      /** 强制开新窗口（例如同时打开两个不同目录） */
      force?: boolean
    }): string {
      const args = input.args ?? {}
      const sameApp = this.windows.filter((w) => w.appId === input.appId)
      // 听歌房始终单例：两个窗口 = 两个 <audio> 同时出声，相位差会让音量
      // 翻倍或产生梳状滤波，听起来就是"声音怪怪的"。右键"在新窗口打开"
      // 也一样聚焦已有窗口。
      //
      // 画桌同理：music/draw 的 store 都只有一条全局 room 状态，两个窗口会
      // 互相覆盖；而且 draw 的 from === myId 过滤会让另一个窗口漏掉自己的笔画。
      const alwaysSingleton = input.appId === 'music' || input.appId === 'draw'
      const singleton = sameApp.length > 0 &&
        (alwaysSingleton ||
          (!input.force &&
            (input.appId === 'settings' || input.appId === 'admin' || input.appId === 'tools')))

      const existing = singleton ? sameApp[0] : undefined
      if (existing) {
        // 从最小化里叫回来是"还原"，本来就开着只是抬到前面是"点击"——
        // 两者声音不同，用户能听出"到底开没开新窗口"
        const wasMinimized = existing.minimized
        existing.minimized = false
        if (Object.keys(args).length > 0) existing.args = args
        this.focus(existing.id)
        playSystem(wasMinimized ? 'restore' : 'click')
        return existing.id
      }

      const area = workArea()
      const w = Math.min(input.w ?? 880, Math.max(320, area.w - 32))
      const h = Math.min(input.h ?? 560, Math.max(240, area.h - 32))
      // 层叠式偏移开窗，避免多个窗口完全重叠成一个
      const offset = (this.windows.length % 6) * 28

      const id = nextId()
      this.windows.push({
        id,
        appId: input.appId,
        title: input.title,
        args,
        x: Math.max(8, Math.round((area.w - w) / 2 - 60) + offset),
        y: Math.max(8, Math.round((area.h - h) / 2 - 40) + offset),
        w,
        h,
        z: ++this.topZ,
        minimized: false,
        maximized: false,
        restore: null,
        snap: 'none',
        resizable: input.resizable ?? true,
        minW: input.minW ?? 380,
        minH: input.minH ?? 260,
      })
      this.activeId = id
      this.persist()
      playSystem('open')
      return id
    },

    /**
     * 注册一个"关闭前询问"的钩子。
     *
     * 为什么需要它：编辑器里改了几处还没保存，点窗口右上角的 × ——
     * 在桌面隐喻里"关掉窗口"说的是"这事做完了"，没人会预期它等于"丢弃改动"。
     * 而窗口框架本身不知道内容脏不脏，所以把这个判断交给内容自己：
     * 返回 false 就不关。
     *
     * 只在真的需要时才注册（编辑器在加载完成后挂上，卸载时摘掉），
     * 没有守卫的窗口行为完全不变。
     */
    setCloseGuard(id: string, guard: (() => boolean | Promise<boolean>) | null): void {
      if (guard) closeGuards.set(id, guard)
      else closeGuards.delete(id)
    },

    async close(id: string): Promise<void> {
      const guard = closeGuards.get(id)
      if (guard) {
        const mayClose = await guard()
        // 守卫说"先别关" —— 窗口留在原处，焦点也不动
        if (!mayClose) return
        closeGuards.delete(id)
      }
      const index = this.windows.findIndex((w) => w.id === id)
      if (index < 0) return
      this.windows.splice(index, 1)
      if (this.activeId === id) {
        // 关掉当前窗口后，焦点交给 z 序最高的那个
        const next = [...this.windows].sort((a, b) => b.z - a.z)[0]
        this.activeId = next?.id ?? null
      }
      this.persist()
      playSystem('close')
    },

    focus(id: string): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      win.minimized = false
      // 已经是最高层就不重复抬高，避免 z 无限增长
      if (win.z !== this.topZ) win.z = ++this.topZ
      this.activeId = id
    },

    minimize(id: string): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      if (win.minimized) return
      win.minimized = true
      if (this.activeId === id) {
        const next = [...this.windows]
          .filter((w) => !w.minimized)
          .sort((a, b) => b.z - a.z)[0]
        this.activeId = next?.id ?? null
      }
      this.persist()
      playSystem('minimize')
    },

    /**
     * 任务栏点击行为：未激活 → 聚焦；已激活 → 最小化。
     * 这是 Windows 的任务栏语义，用户的手是记住这个的。
     */
    toggleFromTaskbar(id: string): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      if (win.minimized) {
        this.focus(id)
      } else if (this.activeId === id) {
        this.minimize(id)
      } else {
        this.focus(id)
      }
    },

    toggleMaximize(id: string): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      const area = workArea()
      if (win.maximized) {
        const restore = win.restore
        win.maximized = false
        win.snap = 'none'
        if (restore) Object.assign(win, restore)
        win.restore = null
      } else {
        win.restore = { x: win.x, y: win.y, w: win.w, h: win.h }
        win.maximized = true
        win.snap = 'none'
        win.x = 8
        win.y = 8
        win.w = area.w - 16
        win.h = area.h - 16
      }
      this.persist()
      playSystem(win.maximized ? 'maximize' : 'restore')
    },

    /**
     * 贴边分屏（Windows 的 Aero Snap）。
     *
     * 拖到屏幕边缘松手时调用。会记住贴边前的位置，方便再拖回来还原。
     */
    snapTo(id: string, zone: SnapZone): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      const area = workArea()
      const gap = 8

      if (zone === 'none') return
      if (!win.snap && !win.maximized) {
        win.restore = { x: win.x, y: win.y, w: win.w, h: win.h }
      }
      win.maximized = false
      win.snap = zone

      const halfW = Math.round((area.w - gap * 3) / 2)
      const halfH = Math.round((area.h - gap * 3) / 2)
      const fullW = area.w - gap * 2
      const fullH = area.h - gap * 2

      switch (zone) {
        case 'left':
          Object.assign(win, { x: gap, y: gap, w: halfW, h: fullH })
          break
        case 'right':
          Object.assign(win, { x: gap * 2 + halfW, y: gap, w: halfW, h: fullH })
          break
        case 'top-left':
          Object.assign(win, { x: gap, y: gap, w: halfW, h: halfH })
          break
        case 'top-right':
          Object.assign(win, { x: gap * 2 + halfW, y: gap, w: halfW, h: halfH })
          break
        case 'bottom-left':
          Object.assign(win, { x: gap, y: gap * 2 + halfH, w: halfW, h: halfH })
          break
        case 'bottom-right':
          Object.assign(win, { x: gap * 2 + halfW, y: gap * 2 + halfH, w: halfW, h: halfH })
          break
      }
      this.persist()
      playSystem('maximize')
    },

    move(id: string, x: number, y: number): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      win.x = x
      win.y = y
    },

    resize(id: string, x: number, y: number, w: number, h: number): void {
      const win = this.windows.find((w) => w.id === id)
      if (!win) return
      Object.assign(win, { x, y, w, h })
    },

    /** 提交位置变更后落盘（拖动过程中不写，避免频繁 IO）。 */
    commit(): void {
      // 拖出屏幕外会让窗口"消失"，这里把它拉回可见区域
      const area = workArea()
      for (const win of this.windows) {
        if (win.maximized) continue
        const maxX = area.w - 80
        const maxY = area.h - 40
        win.x = Math.min(Math.max(win.x, -win.w + 80), maxX)
        win.y = Math.min(Math.max(win.y, 0), maxY)
      }
      this.persist()
    },

    setTitle(id: string, title: string): void {
      const win = this.windows.find((w) => w.id === id)
      if (win) win.title = title
    },

    minimizeAll(): void {
      const had = this.windows.some((w) => !w.minimized)
      for (const win of this.windows) win.minimized = true
      this.activeId = null
      this.persist()
      if (had) playSystem('minimize')
    },

    /** 同应用多窗口时循环切换。 */
    cycleSameApp(appId: string): void {
      const group = this.windows.filter((w) => w.appId === appId)
      if (group.length === 0) return
      const currentIndex = group.findIndex((w) => w.id === this.activeId)
      const next = group[(currentIndex + 1) % group.length]
      if (next) this.focus(next.id)
    },

    /**
     * 布局持久化。
     *
     * 只存"打开了哪些窗口、在哪"，不存窗口内部状态 —— 后者由各应用自己负责，
     * 否则外壳要了解每个应用的内部结构，耦合会失控。
     */
    persist(): void {
      try {
        const layout = this.windows.map((w) => ({
          appId: w.appId,
          title: w.title,
          args: w.args,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          maximized: w.maximized,
        }))
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
      } catch {
        // 隐私模式下 localStorage 可能不可用，静默降级即可
      }
    },

    /** 启动时恢复上次的窗口布局。 */
    restoreLayout(): void {
      try {
        const raw = localStorage.getItem(LAYOUT_KEY)
        if (!raw) return
        const layout = JSON.parse(raw) as State['savedLayout']
        if (!Array.isArray(layout)) return
        const area = workArea()
        // 恢复时也要去重：restoreLayout 不经过 open()，旧布局里如果存了
        // 两个听歌房窗口，会绕过单例直接恢复出两份播放器。
        const singletons = new Set(['settings', 'admin', 'tools', 'music', 'draw'])
        const restored = new Set<string>()
        for (const item of layout.slice(0, 8)) {
          if (singletons.has(item.appId)) {
            if (restored.has(item.appId)) continue
            restored.add(item.appId)
          }
          const id = nextId()
          const w = Math.min(item.w, area.w - 16)
          const h = Math.min(item.h, area.h - 16)
          this.windows.push({
            id,
            appId: item.appId,
            title: item.title,
            args: (item.args ?? {}) as Record<string, unknown>,
            x: Math.min(Math.max(item.x, 0), Math.max(0, area.w - 120)),
            y: Math.min(Math.max(item.y, 0), Math.max(0, area.h - 60)),
            w,
            h,
            z: ++this.topZ,
            minimized: false,
            maximized: item.maximized,
            restore: null,
            snap: 'none',
            resizable: true,
            minW: 380,
            minH: 260,
          })
        }
        const top = [...this.windows].sort((a, b) => b.z - a.z)[0]
        this.activeId = top?.id ?? null
      } catch {
        // 布局坏了不该让桌面起不来
        this.windows = []
      }
    },

    clearLayout(): void {
      try {
        localStorage.removeItem(LAYOUT_KEY)
      } catch {
        // 忽略
      }
    },
  },
})
