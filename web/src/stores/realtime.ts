/**
 * 共享的实时连接（SSE）。
 *
 * 为什么要有这一层：聊天和游戏都需要服务端推送。如果各自 new 一个 EventSource，
 * 浏览器对同一域名的并发连接数有限制（HTTP/1.1 下通常 6 个），而且断线重连
 * 会有两条独立的连接各自抖动。所以整个应用只维持**一条** SSE 连接，
 * 各模块通过 on() 注册事件处理器。
 *
 * 用 SSE 而不是 WebSocket 的理由见 server/src/realtime.ts 的注释：
 * 零依赖、EventSource 自带断线重连、绕开 WebSocket 的代理 Upgrade 配置坑。
 */
import { defineStore } from 'pinia'
import { api } from '@/api'

export type RealtimeHandler = (data: unknown) => void

/** 服务端会发的事件名（与 server/src/realtime.ts 的 RealtimeEvent 对应）。 */
const KNOWN_EVENTS = [
  'hello',
  'ping',
  'message',
  'message-updated',
  'conversation',
  'read',
  'typing',
  'presence',
  'unread',
  'game',
  'game-move',
  'game-play',
  'game-werewolf',
  'game-werewolf-chat',
  'game-werewolf-lobby',
  'game-draw',
  'draw-stroke',
  'board',
  'poll',
  'music',
  'whiteboard',
] as const

export type RealtimeEventName = (typeof KNOWN_EVENTS)[number]

interface State {
  source: EventSource | null
  connected: boolean
  /** 事件名 → 处理器集合。用普通对象而不是 Map，Pinia 对普通对象更友好。 */
  handlers: Record<string, RealtimeHandler[]>
  /** 连接状态变化时的回调（组件可以据此显示"连接已断开"）。 */
  statusHandlers: Array<(connected: boolean) => void>
  /** 重连成功后的回调：断线期间可能漏了事件，各模块应在这里补拉。 */
  resyncHandlers: Array<() => void>
  /** 累计重连次数，用于在界面上体现"网络不稳"。 */
  reconnects: number
  /**
   * 连续失败次数。**只用于显示，不再用来停止重连。**
   *
   * 以前的规则是"连续 5 次失败就 disconnect 且永不重连"，理由是防止
   * 客户端疯狂重试。但一次部署/重启只需 15 秒左右就能凑满 5 次失败，
   * 之后这台设备会永久停在旧状态 —— 用户看到的是"歌还在放，但和全厅
   * 不一样了"，而且没有任何提示。现在改成永远重试（浏览器自带退避），
   * 由 45 秒看门狗负责处理"连接还开着但早已半死"的情况。
   */
  consecutiveFailures: number
  /** 最近一次收到任何事件（含 ping）的本机时刻，看门狗用它判半开。 */
  lastEventAt: number
  /** 服务端进程纪元：变化说明服务端重启过，时钟锚点必须作废。 */
  epoch: string | null
  /** 最近一次 ping 里带的服务端时间（免费时钟样本）。 */
  lastServerTime: number
}

/** 看门狗定时器（模块级：它不是响应式状态，也不该被持久化）。 */
let watchdogTimer: number | null = null

export const useRealtime = defineStore('realtime', {
  state: (): State => ({
    source: null,
    connected: false,
    handlers: {},
    statusHandlers: [],
    resyncHandlers: [],
    reconnects: 0,
    consecutiveFailures: 0,
    lastEventAt: 0,
    epoch: null,
    lastServerTime: 0,
  }),

  actions: {
    /**
     * 建立连接。重复调用是安全的 —— 已经连着就直接返回。
     *
     * 注意不要自己写重连循环：EventSource 自带重连（服务端断开后浏览器会
     * 自动按退避策略重试）。我们要做的只是监听 onopen/onerror 来更新状态，
     * 并在每次重连成功时触发一次 resync（补拉断线期间可能漏掉的数据）。
     */
    connect(): void {
      if (this.source) return

      const source = new EventSource(api.chat.streamUrl())
      this.source = source
      this.lastEventAt = Date.now()
      this.startWatchdog()

      for (const name of KNOWN_EVENTS) {
        source.addEventListener(name, (event) => {
          let payload: unknown = null
          try {
            payload = JSON.parse((event as MessageEvent).data)
          } catch {
            // 解析不了的事件忽略掉，不要让它打断后续事件的处理
            return
          }
          // 任何事件都算"这条连接还活着"
          this.lastEventAt = Date.now()

          if (name === 'hello' || name === 'ping') {
            const data = payload as { serverTime?: number; epoch?: string } | null
            if (typeof data?.epoch === 'string') this.epoch = data.epoch
            if (typeof data?.serverTime === 'number') this.lastServerTime = data.serverTime
          }

          if (name === 'hello') {
            const wasConnected = this.connected
            this.connected = true
            this.consecutiveFailures = 0
            if (wasConnected) this.reconnects++
            // hello 是服务端在（重新）建立连接时发的第一条 —— 正是补拉的时机
            for (const handler of this.resyncHandlers) {
              try {
                handler()
              } catch (err) {
                console.error('[realtime] resync 处理器出错:', err)
              }
            }
            return
          }

          for (const handler of this.handlers[name] ?? []) {
            try {
              handler(payload)
            } catch (err) {
              // 一个处理器出错不该影响其它处理器
              console.error(`[realtime] 处理 ${name} 事件出错:`, err)
            }
          }
        })
      }

      source.onopen = () => {
        this.connected = true
        this.consecutiveFailures = 0
        this.lastEventAt = Date.now()
      }

      source.onerror = () => {
        // EventSource 会自动重连，这里只反映状态。
        // **不再主动 disconnect**：一次部署只要 15 秒就能凑满 5 次失败，
        // 永久断开等于让这台设备从此停在旧状态。重试交给浏览器，
        // 半开连接交给看门狗。
        this.connected = false
        this.consecutiveFailures++
        for (const handler of this.statusHandlers) handler(false)
      }
    },

    /**
     * 半开连接看门狗。
     *
     * EventSource 的 onerror 只在连接**真的断了**时触发；网络路径变化
     * （WiFi 漫游、NAT 超时）时连接会一直"开着"但收不到任何东西，
     * onerror 不响、connected 还是 true —— 这是最危险的静默故障。
     * 服务端每 25 秒发一次具名 ping，45 秒收不到任何事件就重建连接。
     */
    startWatchdog(): void {
      if (watchdogTimer !== null) return
      watchdogTimer = window.setInterval(() => {
        if (!this.source) return
        if (Date.now() - this.lastEventAt <= 45_000) return
        this.reconnect()
      }, 10_000)
    },

    /** 手动重连（界面上给一个"重试"按钮用）。 */
    reconnect(): void {
      this.disconnect()
      this.consecutiveFailures = 0
      this.connect()
    },

    disconnect(): void {
      this.source?.close()
      this.source = null
      this.connected = false
      this.lastEventAt = 0
      if (watchdogTimer !== null) {
        window.clearInterval(watchdogTimer)
        watchdogTimer = null
      }
    },

    /**
     * 注册事件处理器，返回一个取消注册的函数。
     *
     * 返回取消函数是刻意的：组件在 onBeforeUnmount 里调用它，
     * 比"记住自己注册了什么再手动 off"更不容易漏。
     */
    on(event: RealtimeEventName, handler: RealtimeHandler): () => void {
      const list = this.handlers[event] ?? []
      list.push(handler)
      this.handlers[event] = list
      return () => this.off(event, handler)
    },

    off(event: RealtimeEventName, handler: RealtimeHandler): void {
      const list = this.handlers[event]
      if (!list) return
      this.handlers[event] = list.filter((h) => h !== handler)
    },

    /** 监听连接状态变化。 */
    onStatus(handler: (connected: boolean) => void): () => void {
      this.statusHandlers.push(handler)
      return () => {
        this.statusHandlers = this.statusHandlers.filter((h) => h !== handler)
      }
    },

    /** 监听"重连成功"。用于补拉断线期间漏掉的数据。 */
    onResync(handler: () => void): () => void {
      this.resyncHandlers.push(handler)
      return () => {
        this.resyncHandlers = this.resyncHandlers.filter((h) => h !== handler)
      }
    },
  },
})
