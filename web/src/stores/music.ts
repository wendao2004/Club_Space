/**
 * 听歌房的状态。
 *
 * 服务端变化广播 `music` 事件就重拉整个房间。播放器本身在组件里
 * （HTMLAudioElement 不进 store —— 它是 DOM 资源，不是共享状态）。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type MusicRoomView } from '@/api'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'

const MUSIC = 'music' satisfies RealtimeEventName

let offRealtime: Array<() => void> = []

/** 轮询兜底：SSE 断了/半死时，房间状态仍然能自己追上。 */
let pollTimer: number | null = null

interface State {
  room: MusicRoomView | null
  loading: boolean
  error: string | null
  /** 排播候选（文件系统的音频）。 */
  tracks: Array<{ id: string; name: string; ownerName: string }>
  connected: boolean
  /**
   * 自己是不是**想**留在厅里。
   *
   * 与 room.inRoom 分开：服务端可能因为心跳过期把你判离开，但用户的
   * 意图仍然是"我在听"。下一次心跳发现 inRoom=false 时据此自动重进。
   */
  desiredInRoom: boolean
  /**
   * 请求序号。
   *
   * 每个 SSE 事件都会触发一次全量 load；并发时旧响应可能后到，把界面
   * 回退到上一首歌（<audio> 跟着重建）。只应用最新一次的结果。
   */
  loadSeq: number
}

export const useMusic = defineStore('music', {
  state: (): State => ({
    room: null,
    loading: false,
    error: null,
    tracks: [],
    connected: false,
    desiredInRoom: false,
    loadSeq: 0,
  }),

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
        rt.on(MUSIC, () => {
          void this.load()
        }),
        rt.onResync(() => {
          void this.load()
        }),
      ]
    },

    async load(): Promise<void> {
      const seq = ++this.loadSeq
      this.loading = true
      try {
        const view = await api.music.room()
        // 旧响应：丢弃。否则并发 load 乱序时会把界面回退到上一首歌。
        if (seq !== this.loadSeq) return
        this.room = view
        // 只记"想留下"这一个方向：服务端可能因为 TTL 把你判出去，
        // 这时候不能把用户自己的意图也一起清掉（否则心跳不会再自动重进）。
        // "不想留下"只由显式的 leave() 设置。
        if (view.inRoom) this.desiredInRoom = true
        this.error = null
      } catch (err) {
        if (seq !== this.loadSeq) return
        this.error = messageOf(err, '加载听歌房失败')
      } finally {
        if (seq === this.loadSeq) this.loading = false
      }
    },

    /**
     * 轮询兜底。
     *
     * SSE 是主通道，但它可能永久断线、也可能半开（连接还在，收不到东西）。
     * 没有兜底时，这台设备会一直停在旧状态，直到用户手动刷新 —— 表现就是
     * "别人都换歌了，我这儿还在放上一首"。
     */
    startPolling(): void {
      if (pollTimer !== null) return
      pollTimer = window.setInterval(() => {
        // 隐藏页的定时器会被节流，这里不强求；可见时一律补拉
        if (document.visibilityState === 'visible') void this.load()
      }, 20_000)
    },

    stopPolling(): void {
      if (pollTimer === null) return
      window.clearInterval(pollTimer)
      pollTimer = null
    },

    async loadTracks(): Promise<void> {
      try {
        const { tracks } = await api.music.tracks()
        this.tracks = tracks
      } catch (err) {
        this.error = messageOf(err, '加载音频列表失败')
      }
    },

    async enqueue(nodeId: string): Promise<boolean> {
      try {
        this.room = await api.music.enqueue(nodeId)
        this.error = null
        return true
      } catch (err) {
        this.error = messageOf(err, '排播失败')
        return false
      }
    },

    async removeQueued(itemId: string): Promise<void> {
      try {
        this.room = await api.music.removeQueued(itemId)
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '撤下失败')
      }
    },

    /** 加入听歌房（打开窗口不等于在厅里）。 */
    async join(): Promise<void> {
      this.desiredInRoom = true
      try {
        const view = await api.music.join()
        this.room = view
        this.error = null
      } catch (err) {
        this.desiredInRoom = false
        this.error = messageOf(err, '加入失败')
      }
    },

    async leave(): Promise<void> {
      this.desiredInRoom = false
      try {
        const view = await api.music.leave()
        this.room = view
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '离开失败')
      }
    },

    /**
     * 心跳：纯续期，不广播。
     *
     * 服务端返回 inRoom 之后，客户端才知道自己有没有被 TTL 判出去。后台
     * 标签页的定时器可能被节流到 1 次/分钟，120 秒 TTL 仍可能先到期 ——
     * 这时如果用户本来就在厅里，就自动重新加入，而不是让播放器被卸载。
     */
    async heartbeat(): Promise<void> {
      try {
        const { inRoom } = await api.music.heartbeat()
        if (!inRoom && this.desiredInRoom) {
          const view = await api.music.join()
          this.room = view
          return
        }
        if (this.room && this.room.inRoom !== inRoom) this.room.inRoom = inRoom
      } catch {
        // 心跳失败不打扰用户，下一轮再试
      }
    },

    /** 暂停/继续（厅级状态，影响所有人）。 */
    async pause(): Promise<void> {
      try {
        this.room = await api.music.pause()
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '暂停失败')
      }
    },

    async resume(): Promise<void> {
      try {
        this.room = await api.music.resume()
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '继续播放失败')
      }
    },

    async skip(): Promise<void> {
      try {
        this.room = await api.music.skip()
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '切歌失败')
      }
    },

    /** 返回 true 表示真的切歌了（组件据此换 src）。 */
    async ended(playedToken: number): Promise<boolean> {
      try {
        const { advanced } = await api.music.ended(playedToken)
        if (advanced) await this.load()
        return advanced
      } catch {
        return false
      }
    },
  },
})

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
