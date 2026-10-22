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

interface State {
  room: MusicRoomView | null
  loading: boolean
  error: string | null
  /** 排播候选（文件系统的音频）。 */
  tracks: Array<{ id: string; name: string; ownerName: string }>
  connected: boolean
}

export const useMusic = defineStore('music', {
  state: (): State => ({
    room: null,
    loading: false,
    error: null,
    tracks: [],
    connected: false,
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
      this.loading = true
      try {
        this.room = await api.music.room()
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加载听歌房失败')
      } finally {
        this.loading = false
      }
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
