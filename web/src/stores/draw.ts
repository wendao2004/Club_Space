/**
 * 你画我猜的状态管理。
 *
 * 与斗地主（ddz.ts）同一套骨架：服务端权威、SSE 推送、按返回值整体覆盖。
 * 两个这个游戏特有的决策：
 *
 * 1. **画笔不进 store**。笔画是"绘制指令流"，不是状态 —— 它不需要参与
 *    Vue 的响应式（画布是 imperative 的 Canvas 2D），塞进 store 只会让
 *    每秒十条的笔迹事件触发一轮无意义的组件 diff。所以 draw-stroke 事件
 *    通过 onStroke() 直接分发给画布组件的回调，store 不碰。
 *
 * 2. **猜词聊天也不进独立 state**：它随 game-draw 事件的 room.chat 一起到，
 *    整体覆盖即可。一局几十条、每条都很小，没有优化价值。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type DrawRoom, type DrawStrokeBroadcast, type DrawStrokeInput } from '@/api'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'

const GAME_DRAW = 'game-draw' satisfies RealtimeEventName
const DRAW_STROKE = 'draw-stroke' satisfies RealtimeEventName

let offRealtime: Array<() => void> = []
/** 画布组件注册的笔迹回调（挂载时注册、卸载时取消）。 */
const strokeListeners = new Set<(op: DrawStrokeBroadcast) => void>()

interface State {
  rooms: DrawRoom[]
  room: DrawRoom | null
  loading: boolean
  submitting: boolean
  error: string | null
  connected: boolean
}

export const useDraw = defineStore('draw', {
  state: (): State => ({
    rooms: [],
    room: null,
    loading: false,
    submitting: false,
    error: null,
    connected: false,
  }),

  getters: {
    view: (state) => state.room?.view ?? null,
    chat: (state) => state.room?.chat ?? [],
    amDrawer: (state) => state.room?.view.iAmDrawer === true,
  },

  actions: {
    connectRealtime(): void {
      if (offRealtime.length > 0) {
        for (const off of offRealtime) off()
        offRealtime = []
      }

      const rt = useRealtime()
      rt.connect()
      this.connected = rt.connected

      offRealtime = [
        rt.onStatus((connected) => {
          this.connected = connected
        }),
        // 断线期间的事件丢了，重连后整体对齐
        rt.onResync(() => {
          void this.loadRooms()
          if (this.room) void this.reload()
        }),
        rt.on(GAME_DRAW, (data) => {
          const payload = data as { roomId?: string; room?: DrawRoom | null } | null
          if (!payload?.roomId) return
          // 房间被解散时 room 为 null：清掉本地，回大厅
          const room = payload.room
          if (!room) {
            if (this.room?.id === payload.roomId) this.room = null
            // 只从本地列表移除，不要 loadRooms()：解散推送会同时到达所有在看的
            // 人，一次全站重拉没有必要（画出 `room:null` 本来就已经够用）。
            this.rooms = this.rooms.filter((r) => r.id !== payload.roomId)
            return
          }
          if (this.room && this.room.id === payload.roomId) this.room = room
          this.upsertRoom(room)
        }),
        rt.on(DRAW_STROKE, (data) => {
          const op = data as DrawStrokeBroadcast | null
          if (!op) return
          for (const listener of strokeListeners) {
            // 逐个隔离：一个窗口的画布已经卸载（ctx() 为 null）时抛出的异常
            // 不能截断这个循环，否则同一用户的另一个窗口也收不到后续笔迹。
            try {
              listener(op)
            } catch (err) {
              console.error('[draw] 笔迹处理出错:', err)
            }
          }
        }),
      ]
    },

    /** 画布组件用：注册笔迹回调，返回取消函数。 */
    onStroke(listener: (op: DrawStrokeBroadcast) => void): () => void {
      strokeListeners.add(listener)
      return () => strokeListeners.delete(listener)
    },

    upsertRoom(room: DrawRoom): void {
      const index = this.rooms.findIndex((r) => r.id === room.id)
      if (index >= 0) this.rooms[index] = room
      else this.rooms.unshift(room)
    },

    async loadRooms(): Promise<void> {
      this.loading = true
      try {
        const { rooms } = await api.draw.rooms()
        this.rooms = rooms
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加载房间列表失败')
      } finally {
        this.loading = false
      }
    },

    async createRoom(title: string, rounds: number): Promise<void> {
      this.submitting = true
      try {
        const { room } = await api.draw.createRoom(title, rounds)
        this.room = room
        this.upsertRoom(room)
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '创建房间失败')
        throw err
      } finally {
        this.submitting = false
      }
    },

    async openRoom(id: string): Promise<void> {
      try {
        const { room } = await api.draw.getRoom(id)
        this.room = room
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '打开房间失败')
      }
    },

    async join(id: string): Promise<void> {
      this.submitting = true
      try {
        const { room } = await api.draw.join(id)
        this.room = room
        this.upsertRoom(room)
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加入失败')
        throw err
      } finally {
        this.submitting = false
      }
    },

    async start(): Promise<void> {
      const room = this.room
      if (!room) return
      this.submitting = true
      try {
        const { room: next } = await api.draw.start(room.id)
        this.room = next
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '开始失败')
      } finally {
        this.submitting = false
      }
    },

    async leave(): Promise<void> {
      const room = this.room
      if (!room) return
      try {
        await api.draw.leave(room.id)
        this.rooms = this.rooms.filter((r) => r.id !== room.id)
        this.room = null
        this.error = null
      } catch (err) {
        // 最后一人退房 = 解散（404）：本地同样清掉
        this.rooms = this.rooms.filter((r) => r.id !== room.id)
        this.room = null
        if (!(err instanceof ApiError && err.status === 404)) {
          this.error = messageOf(err, '退出失败')
        }
      }
    },

    async chooseWord(word: string): Promise<void> {
      const room = this.room
      if (!room) return
      try {
        const { room: next } = await api.draw.chooseWord(room.id, word)
        this.room = next
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '选词失败')
      }
    },

    async guess(text: string): Promise<void> {
      const room = this.room
      if (!room) return
      const trimmed = text.trim()
      if (!trimmed) return
      try {
        await api.draw.guess(room.id, trimmed)
        // room 与 chat 会随 game-draw 推送回来，这里不动本地
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '发送失败')
      }
    },

    /**
     * 画笔上报由画布组件的攒批定时器调用；失败静默（下一段笔画会继续）。
     * 参数是**纯 op**（不带 from）：发起人由服务端按登录态识别，不由客户端自报。
     */
    sendStroke(op: DrawStrokeInput): void {
      const room = this.room
      if (!room) return
      void api.draw.stroke(room.id, op).catch(() => {})
    },

    /**
 * 旁观者登记 / 续期。
 *
 * 玩家也会调用 —— 服务端收件人是「玩家 ∪ 观看者」并去重，重复登记无害。
 * 这样做的好处是身份变化（中途转正、被移出玩家列表）不需要客户端判断。
 */
    async watch(id: string): Promise<void> {
      try {
        const { room } = await api.draw.watch(id)
        // 登记成功时做一次对账：openRoom 的 GET 与这次 watch 生效之间，
        // 房间可能刚好发生了最后一次状态变化（例如进入 finished）。
        // 那条推送早于登记、收不到，之后也不会再有 —— 不在这里补一次，
        // 旁观者会永久停在旧阶段。
        if (this.room?.id !== id) return
        if (room.updatedAt >= this.room.updatedAt) this.room = room
      } catch {
        // 房间已经没了：下一次 game-draw 会带 room:null，或用户自己返回大厅
      }
    },

    async unwatch(id: string): Promise<void> {
      try {
        await api.draw.unwatch(id)
      } catch {
        // 房间已解散 / 离线：服务端有 TTL 兜底
      }
    },

    /** 清掉本地房间（旁观者返回大厅时用 —— 他不是成员，不该调用 leave）。 */
    clearRoom(): void {
      this.room = null
    },

    /** 刷新当前房间（重连 / 手动刷新）。 */
    async reload(): Promise<void> {
      const room = this.room
      if (!room) return
      try {
        const { room: next } = await api.draw.getRoom(room.id)
        this.room = next
        this.error = null
      } catch (err) {
        // 房间已经解散：清掉本地状态，让界面回大厅（而不是反复弹"刷新失败"）
        if (err instanceof ApiError && err.status === 404) {
          this.room = null
          return
        }
        this.error = messageOf(err, '刷新失败')
      }
    },
  },
})

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
