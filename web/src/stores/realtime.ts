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
   * 连续失败次数；达到阈值后停止自动重连。
   *
   * 存在的理由：服务端对实时连接有上限（超限返回 429），而 EventSource
   * 会按自己的节奏无限重试 —— 如果一直失败，就变成"客户端疯狂打服务端"，
   * 比原始问题更糟。到阈值后主动断开，让用户看到提示并手动重试。
   */
  consecutiveFailures: number
}

export const useRealtime = defineStore('realtime', {
  state: (): State => ({
    source: null,
    connected: false,
    handlers: {},
    statusHandlers: [],
    resyncHandlers: [],
    reconnects: 0,
    consecutiveFailures: 0,
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
      // 连续失败太多次就停下来，不要无限重连。
      //
      // 背景：服务端对实时连接有上限（每人 12 条、全站 500 条），
      // 超限返回 429。而 EventSource 遇到错误会**按自己的节奏无限重试** ——
      // 如果一直失败，就变成"客户端疯狂打服务端"，比原始问题更糟。
      // 所以这里加一道自己的闸门：连续失败若干次后暂停重连，
      // 让用户看到"连接已断开"的提示并可以手动重试。
      if (this.consecutiveFailures >= 5) return

      const source = new EventSource(api.chat.streamUrl())
      this.source = source

      for (const name of KNOWN_EVENTS) {
        source.addEventListener(name, (event) => {
          let payload: unknown = null
          try {
            payload = JSON.parse((event as MessageEvent).data)
          } catch {
            // 解析不了的事件忽略掉，不要让它打断后续事件的处理
            return
          }
          if (name === 'hello') {
            const wasConnected = this.connected
            this.connected = true
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
      }

      source.onerror = () => {
        // EventSource 会自动重连，这里只反映状态。
        // 但我们不再无条件信任它 —— 连续失败到一定次数就主动关掉，
        // 避免一边被服务端限流、一边无限重试。
        this.connected = false
        this.consecutiveFailures++
        for (const handler of this.statusHandlers) handler(false)

        if (this.consecutiveFailures >= 5) {
          this.disconnect()
        }
      }
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
