/**
 * 投票的状态。
 *
 * 与 board.ts 同一极简模式：一份列表 + 筛选，服务端广播 `poll` 事件就
 * 重拉 —— 投票没有"高频实时"的需求，增量同步不值得。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type Poll } from '@/api'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'

const POLL = 'poll' satisfies RealtimeEventName

let offRealtime: Array<() => void> = []

interface State {
  polls: Poll[]
  loading: boolean
  submitting: boolean
  error: string | null
  /** 只看进行中的。 */
  openOnly: boolean
  connected: boolean
}

export const usePoll = defineStore('poll', {
  state: (): State => ({
    polls: [],
    loading: false,
    submitting: false,
    error: null,
    openOnly: false,
    connected: false,
  }),

  getters: {
    /** 进行中的条数（给角标用）。 */
    openCount: (state) =>
      state.polls.filter((p) => p.closedAt === null && (p.deadlineAt === null || p.deadlineAt > Date.now()))
        .length,
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
        rt.on(POLL, () => {
          void this.load()
        }),
        // 断线期间可能漏了投票变化，重连补拉一次
        rt.onResync(() => {
          void this.load()
        }),
      ]
    },

    async load(): Promise<void> {
      this.loading = true
      try {
        const { polls } = await api.polls.list({ openOnly: this.openOnly })
        this.polls = polls
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加载投票失败')
      } finally {
        this.loading = false
      }
    },

    async create(input: {
      title: string
      description: string
      multi: boolean
      options: string[]
      deadlineInMs: number | null
    }): Promise<boolean> {
      if (this.submitting) return false
      this.submitting = true
      try {
        const { poll } = await api.polls.create(input)
        this.polls = [poll, ...this.polls.filter((p) => p.id !== poll.id)]
        this.error = null
        return true
      } catch (err) {
        this.error = messageOf(err, '创建失败')
        return false
      } finally {
        this.submitting = false
      }
    },

    /** 投票 / 改票（全量替换）。成功后用返回的 poll 原地更新列表。 */
    async vote(id: string, options: number[]): Promise<boolean> {
      try {
        const { poll } = await api.polls.vote(id, options)
        this.polls = this.polls.map((p) => (p.id === id ? poll : p))
        this.error = null
        return true
      } catch (err) {
        this.error = messageOf(err, '投票失败')
        return false
      }
    },

    async setClosed(id: string, closed: boolean): Promise<void> {
      try {
        const { poll } = await api.polls.setClosed(id, closed)
        this.polls = this.polls.map((p) => (p.id === id ? poll : p))
        this.error = null
      } catch (err) {
        this.error = messageOf(err, closed ? '关闭失败' : '重开失败')
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await api.polls.remove(id)
        this.polls = this.polls.filter((p) => p.id !== id)
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '删除失败')
      }
    },

    setFilter(openOnly: boolean): void {
      this.openOnly = openOnly
      void this.load()
    },
  },
})

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
