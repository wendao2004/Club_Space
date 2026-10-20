/**
 * 待办角标。
 *
 * 记账的「待审批 / 被驳回待改」和财物的「逾期 / 即将到期」过去都是沉默的：
 * 状态变了只写一条审计，人得自己打开应用翻到那一页才知道。这个 store 负责
 * 把 `GET /api/todos` 的一个数字搬到桌面图标、开始菜单、任务栏和移动端。
 *
 * 三条刻意的取舍：
 *
 * 1. **数字一律来自服务端，前端不自己数**。列表页的筛选条件和服务端那份是
 *    同一套（见 server/src/ledger.ts 的 entryWhere、assets.ts 的 loanWhere），
 *    前端再算一遍迟早会分叉，而"角标 3、点进去 2 条"是用户直接判定"坏了"的那类错。
 *
 * 2. **不轮询**。刷新时机只有四个：登录进桌面、打开记账/财物应用、窗口重新获得
 *    焦点（切回来）、以及各模块自己写操作成功后。没有账目/借还变化的 SSE 事件 ——
 *    现有推送里只有聊天和棋牌，所以这里按保守策略走"打开应用 + 聚焦时刷新"，
 *    宁可晚几秒，也不给 NAS 每秒钟记一次 COUNT。
 *
 * 3. **失败是静默的**。角标只是提示，拿不到就不显示；绝不能因为一个角标请求
 *    失败就弹一个 toast，把人从正在做的事里打断。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type TodoPayload } from '@/api'
import { useAuth } from '@/stores/auth'
import { useRealtime } from '@/stores/realtime'

// 类型定义在 api.ts（HTTP 契约都在那里），这里转出去，组件不必知道该从哪 import。
export type { TodoBucket, LedgerTodo, AssetsTodo, TodoPayload } from '@/api'

function emptyBucket(): TodoBucket {
  return { count: 0, ids: [] }
}

function emptyPayload(): TodoPayload {
  return {
    ledger: { review: emptyBucket(), rejected: emptyBucket(), total: 0 },
    assets: { overdue: emptyBucket(), dueSoon: emptyBucket(), dueSoonDays: 3, total: 0 },
  }
}

/**
 * 两次拉取之间的最小间隔（毫秒）。
 *
 * 窗口 focus / visibilitychange / 连续开关应用会在几秒内触发好几次，
 * 每次都打一次接口纯属浪费。5 秒足够把这类抖动合并成一次，
 * 又短到不会让人等太久才看到新数字。
 */
const MIN_INTERVAL_MS = 5_000

interface State {
  data: TodoPayload
  /** 至少成功拉过一次。没拉到之前角标一律不显示，不显示 0。 */
  loaded: boolean
  loading: boolean
  /** 最后一次成功拉取的时间戳（节流用） */
  fetchedAt: number
  /** 最近一次失败原因（只用于诊断，不弹提示） */
  error: string | null
  /** 是否已经挂上事件监听（重复 start 要幂等） */
  started: boolean
}

interface SyncHandle {
  onResync: () => void
  onFocus: () => void
  onVisibility: () => void
  offResync: () => void
}

/** 事件监听不放进 Pinia state：它们是宿主对象，不需要响应式也不需要被持久化。 */
let handle: SyncHandle | null = null

export const useTodos = defineStore('todos', {
  state: (): State => ({
    data: emptyPayload(),
    loaded: false,
    loading: false,
    fetchedAt: 0,
    error: null,
    started: false,
  }),

  getters: {
    /**
     * 某个应用图标上该显示的数字。
     *
     * 只认账本/财物两个应用：聊天未读有自己的计数（chat.totalUnread），
     * 在这里合并会让两套口径互相污染。
     */
    badgeFor: (state) => (appId: string): number => {
      if (!state.loaded) return 0
      if (appId === 'ledger') return state.data.ledger.total
      if (appId === 'assets') return state.data.assets.total
      return 0
    },

    /** 「即将到期」的窗口天数，由服务端给 —— 前端不硬编码，否则两边会漂。 */
    dueSoonDays: (state): number => state.data.assets.dueSoonDays,

    /** 全部应用的待办合计（移动端「应用」Tab 的角标用）。 */
    overall: (state): number =>
      state.loaded ? state.data.ledger.total + state.data.assets.total : 0,
  },

  actions: {
    /**
     * 拉取待办。`force` 用于写操作之后 —— 刚提交/刚审批完，用户正盯着屏幕，
     * 这时被 5 秒节流挡住会让人以为角标没更新。
     */
    async refresh(force = false): Promise<void> {
      if (!useAuth().loggedIn) return
      if (this.loading) return
      const now = Date.now()
      if (!force && this.fetchedAt > 0 && now - this.fetchedAt < MIN_INTERVAL_MS) return

      this.loading = true
      try {
        const payload = await api.todos()
        if (!payload.todos) {
          throw new ApiError(500, '待办接口返回的数据不完整')
        }
        this.data = payload.todos
        this.loaded = true
        this.error = null
        this.fetchedAt = Date.now()
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // 会话没了：让 auth 把界面切回登录页，别在这里自己吞掉
          useAuth().handleUnauthorized()
          return
        }
        // 角标是装饰性的：失败就保持上一次的数字（或 0），不打断用户
        this.error = err instanceof Error ? err.message : String(err)
      } finally {
        this.loading = false
      }
    },

    /**
     * 挂上刷新时机。在桌面/移动外壳挂载时调用（此时已经登录）。
     *
     * 幂等：两个外壳在窗口宽度变化时可能交替挂载，重复调用不会叠加监听。
     */
    start(): void {
      if (this.started) {
        void this.refresh()
        return
      }
      this.started = true

      const realtime = useRealtime()
      const offResync = realtime.onResync(() => void this.refresh(true))
      handle = {
        // SSE 断线重连成功 = 断线期间可能漏了变化，补拉一次；
        // 现有的实时事件里没有"账目/借还变化"，所以只能靠这个 + 焦点刷新。
        onResync: () => void this.refresh(true),
        onFocus: () => void this.refresh(),
        onVisibility: () => {
          if (document.visibilityState === 'visible') void this.refresh()
        },
        offResync,
      }
      window.addEventListener('focus', handle.onFocus)
      document.addEventListener('visibilitychange', handle.onVisibility)

      void this.refresh(true)
    },

    /** 卸掉监听（登出 / 换外壳时）。 */
    stop(): void {
      if (handle) {
        window.removeEventListener('focus', handle.onFocus)
        document.removeEventListener('visibilitychange', handle.onVisibility)
        handle.offResync()
        handle = null
      }
      this.started = false
      this.data = emptyPayload()
      this.loaded = false
      this.fetchedAt = 0
      this.error = null
    },
  },
})

/**
 * 角标文案：0 不显示、超过 99 显示 "99+"（与任务栏聊天未读的既有约定一致）。
 * 放在这里而不是每个组件各写一遍 —— 四个入口各抄一次，迟早有一个忘记 99。
 */
export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
