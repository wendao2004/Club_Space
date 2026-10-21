/**
 * 留言板的状态。
 *
 * 极简：一份列表 + 筛选条件。服务端在留言变化时广播 `board` 事件，
 * 这里收到就重拉一次 —— 几十条数据的列表，增量同步不值得。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type BoardKind, type BoardPost } from '@/api'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'

const BOARD = 'board' satisfies RealtimeEventName

let offRealtime: Array<() => void> = []

interface State {
  posts: BoardPost[]
  loading: boolean
  submitting: boolean
  error: string | null
  /** 只看未处理的。 */
  openOnly: boolean
  /** 类型筛选，null = 全部。 */
  kind: BoardKind | null
  connected: boolean
}

export const useBoard = defineStore('board', {
  state: (): State => ({
    posts: [],
    loading: false,
    submitting: false,
    error: null,
    openOnly: false,
    kind: null,
    connected: false,
  }),

  getters: {
    /** 未处理条数（给角标用）。 */
    openCount: (state) => state.posts.filter((p) => p.resolvedAt === null).length,
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
        rt.on(BOARD, () => {
          void this.load()
        }),
        // 断线期间可能漏了留言，重连补拉一次
        rt.onResync(() => {
          void this.load()
        }),
      ]
    },

    async load(): Promise<void> {
      this.loading = true
      try {
        const { posts } = await api.board.posts({ openOnly: this.openOnly, kind: this.kind ?? undefined })
        this.posts = posts
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加载留言失败')
      } finally {
        this.loading = false
      }
    },

    async create(kind: BoardKind, body: string): Promise<boolean> {
      if (this.submitting) return false
      this.submitting = true
      try {
        const { post } = await api.board.create(kind, body)
        // 自己发的立刻出现在顶部（广播会再拉一次，这里先给即时反馈）
        this.posts = [post, ...this.posts.filter((p) => p.id !== post.id)]
        this.error = null
        return true
      } catch (err) {
        this.error = messageOf(err, '发送失败')
        return false
      } finally {
        this.submitting = false
      }
    },

    async resolve(id: string, resolved: boolean, resolution?: string | null): Promise<void> {
      try {
        const { post } = await api.board.resolve(id, resolved, resolution)
        this.posts = this.posts.map((p) => (p.id === id ? post : p))
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '标记失败')
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await api.board.remove(id)
        this.posts = this.posts.filter((p) => p.id !== id)
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '撤回失败')
      }
    },

    setFilter(next: { openOnly?: boolean; kind?: BoardKind | null }): void {
      if (next.openOnly !== undefined) this.openOnly = next.openOnly
      if (next.kind !== undefined) this.kind = next.kind
      void this.load()
    },
  },
})

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
