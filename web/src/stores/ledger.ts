/**
 * 记账 store —— 记账模块**唯一**的写入口。
 *
 * 组件（LedgerApp.vue）只管表单状态和 UI，任何一次落库都必须走这里的 action。
 * 从前组件里还有一份并行的 `api.ledger.* + notify + reload` 写法，两边一旦
 * 只改一边，某个入口就会悄悄不一样（不报错、只表现为"这个按钮的提示怎么变了"）。
 *
 * 三条不能违背的规则，贯穿整个文件：
 *  1. 金额永远是字符串。求和一律走整数分，绝不用浮点，否则几十笔之后账就对不上。
 *  2. 状态机由服务端说了算。任何写操作成功后都走 reload()（列表 + 统计 + 待结算 +
 *     活动列表 + 活动汇总），不做本地乐观更新 —— 统计只算「已通过 / 已支付」，
 *     本地改一改就会和真实账目漂移；活动卡片的笔数/合计也只认服务端。
 *  3. 错误的呈现分三档，别混：
 *     - 读操作失败 → 写 this.error（列表区的"加载失败/重试"就靠它）并弹通知；
 *     - 行内操作（提交/撤回/审批/驳回/支付/删除/结清）失败 → 只弹通知，**不写
 *       this.error**，否则整张列表会被错误态顶掉，用户连"再试一次"的按钮都没了；
 *     - 表单提交（createEntry/updateEntry）失败 → 不弹通知，直接抛出，由弹窗
 *       内联展示（关掉弹窗用户填的东西就没了）。
 *
 *     活动类写操作（createEvent/updateEvent/closeEvent）沿用旧写法：失败时写
 *     this.error —— 它们只在活动视图里触发，而 error 只在流水视图渲染成错误态。
 */
import { defineStore } from 'pinia'
import { api, ApiError } from '@/api'
import type {
  LedgerCategory,
  LedgerDebt,
  LedgerEntry,
  LedgerEntryInput,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventSummary,
  LedgerKind,
  LedgerQueryOptions,
  LedgerStatus,
  LedgerSummary,
} from '@/api'
import { useUi } from '@/stores/ui'

export interface LedgerFilters {
  from: string | null
  to: string | null
  kind: LedgerKind | null
  categoryId: string | null
  status: LedgerStatus | null
  /** 只看某个活动（比赛/一次活动）下的账目 */
  eventId: string | null
  /** 标题 / 备注模糊搜索 */
  search: string
  mine: boolean
  pending: boolean
}

interface State {
  entries: LedgerEntry[]
  total: number
  categories: LedgerCategory[]
  summary: LedgerSummary | null
  debts: LedgerDebt[]
  events: LedgerEvent[]
  eventSummary: LedgerEventSummary | null
  loading: boolean
  saving: boolean
  error: string | null
  filters: LedgerFilters
}

function emptyFilters(): LedgerFilters {
  return {
    from: null,
    to: null,
    kind: null,
    categoryId: null,
    status: null,
    eventId: null,
    search: '',
    mine: false,
    pending: false,
  }
}

/** 把未知异常转成可直接展示的文案；后端返回的真实 message 优先。 */
function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** 由筛选条件拼出列表查询参数。导出的下载地址也用这一份（见下面的 exportUrl）。 */
function entryQuery(filters: LedgerFilters): LedgerQueryOptions {
  return {
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    kind: filters.kind ?? undefined,
    categoryId: filters.categoryId ?? undefined,
    status: filters.status ?? undefined,
    eventId: filters.eventId ?? undefined,
    search: filters.search.trim() || undefined,
    mine: filters.mine,
    pending: filters.pending,
  }
}

export const useLedger = defineStore('ledger', {
  state: (): State => ({
    entries: [],
    total: 0,
    categories: [],
    summary: null,
    debts: [],
    events: [],
    eventSummary: null,
    loading: false,
    saving: false,
    error: null,
    filters: emptyFilters(),
  }),

  getters: {
    /**
     * 导出 CSV 的下载地址。
     *
     * **必须和列表用同一套筛选条件**（同一个 entryQuery）。这不是"顺便对齐一下"：
     * 导出按钮就挂在筛选栏旁边、筛选摘要的下面，用户点它时的心理预期是
     * "把我现在看到的这张表导出来"。只对齐日期区间是不够的 ——
     * 搜索词/分类/状态/只看我的/待我审批 少一个，导出的表里就会多出东西，
     * 而多出来的行不会报错，只能靠对账时人肉发现。
     */
    exportUrl: (state): string => api.ledger.exportUrl(entryQuery(state.filters)),

    /** 当前打开的活动明细 CSV。活动汇总页的「导出明细」用它。 */
    eventExportUrl: (state): string =>
      state.eventSummary ? api.ledger.eventExportUrl(state.eventSummary.event.id) : '#',

    /** 未归档的收入分类 */
    incomeCategories: (state): LedgerCategory[] =>
      state.categories.filter((category) => category.kind === 'income' && !category.archived),

    /** 未归档的支出分类 */
    expenseCategories: (state): LedgerCategory[] =>
      state.categories.filter((category) => category.kind === 'expense' && !category.archived),

    /** 当前列表里「待审批」的条数 */
    pendingCount: (state): number =>
      state.entries.filter((entry) => entry.status === 'submitted').length,

    /** 当前列表的收入合计（整数分相加，金额字段本身就是整数分） */
    totalIncomeCents: (state): number =>
      state.entries.reduce((sum, entry) => (entry.kind === 'income' ? sum + entry.amountCents : sum), 0),

    /** 当前列表的支出合计（整数分相加） */
    totalExpenseCents: (state): number =>
      state.entries.reduce((sum, entry) => (entry.kind === 'expense' ? sum + entry.amountCents : sum), 0),
  },

  actions: {
    async loadCategories(includeArchived = false): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const result = await api.ledger.categories(includeArchived)
        this.categories = result.categories
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载分类失败', message)
      } finally {
        this.loading = false
      }
    },

    async loadEntries(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const result = await api.ledger.entries(entryQuery(this.filters))
        this.entries = result.entries
        this.total = result.total
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载账目失败', message)
      } finally {
        this.loading = false
      }
    },

    async loadSummary(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const result = await api.ledger.summary({
          from: this.filters.from ?? undefined,
          to: this.filters.to ?? undefined,
        })
        this.summary = result.summary
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载统计失败', message)
      } finally {
        this.loading = false
      }
    },

    async loadDebts(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const result = await api.ledger.debts(this.filters.eventId ?? undefined)
        this.debts = result.debts
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载待结算失败', message)
      } finally {
        this.loading = false
      }
    },

    /** 加载活动列表（含每个活动的收支合计与笔数）。 */
    async loadEvents(openOnly = false): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const result = await api.ledger.events({ openOnly })
        this.events = result.events
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载活动失败', message)
      } finally {
        this.loading = false
      }
    },

    /** 加载某个活动的完整汇总（收支合计 + 按分类 + 按人 + 逐笔明细）。 */
    async loadEventSummary(eventId: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.eventSummary = await api.ledger.eventSummary(eventId)
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '加载活动汇总失败', message)
      } finally {
        this.loading = false
      }
    },

    async createEvent(input: LedgerEventInput): Promise<LedgerEvent | null> {
      this.saving = true
      this.error = null
      try {
        const { event } = await api.ledger.createEvent(input)
        useUi().notify('success', '活动已创建', event.name)
        await this.loadEvents()
        return event
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '创建活动失败', message)
        return null
      } finally {
        this.saving = false
      }
    },

    async updateEvent(id: string, input: Partial<LedgerEventInput>): Promise<LedgerEvent | null> {
      this.saving = true
      this.error = null
      try {
        const { event } = await api.ledger.updateEvent(id, input)
        useUi().notify('success', '活动已更新', event.name)
        await this.loadEvents()
        if (this.eventSummary?.event.id === id) await this.loadEventSummary(id)
        return event
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '更新活动失败', message)
        return null
      } finally {
        this.saving = false
      }
    },

    /** 封账 / 解封。封账后该活动不能再新增或修改账目（历史不受影响）。 */
    async closeEvent(id: string, closed: boolean): Promise<LedgerEvent | null> {
      this.saving = true
      this.error = null
      try {
        const { event } = await api.ledger.closeEvent(id, closed)
        useUi().notify('success', closed ? '活动已封账' : '活动已解封', event.name)
        await this.loadEvents()
        return event
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', closed ? '封账失败' : '解封失败', message)
        return null
      } finally {
        this.saving = false
      }
    },

    /** 顺序刷新所有数据源，避免并发把后端打爆。 */
    async reload(): Promise<void> {
      await this.loadCategories()
      await this.loadEvents()
      await this.loadEntries()
      await this.loadSummary()
      await this.loadDebts()
      // 正在看某个活动的汇总时必须重拉它 —— 活动汇总页整页都由 eventSummary
      // 渲染，漏掉这一步就会出现"刚加了收入，数字不动"（用户报的 bug）。
      if (this.eventSummary) await this.loadEventSummary(this.eventSummary.event.id)
    },

    /**
     * 新建账目。
     *
     * 失败时**抛出**、且不弹通知：调用方是编辑弹窗，错误要内联显示在表单里
     * （弹窗一关，用户刚填的一整页都没了 —— 拿弹窗去换一个 3 秒就消失的 toast 不值）。
     */
    async createEntry(input: LedgerEntryInput): Promise<LedgerEntry> {
      this.saving = true
      try {
        const { entry } = await api.ledger.createEntry(input)
        useUi().notify('success', '已创建')
        await this.reload()
        return entry
      } finally {
        this.saving = false
      }
    },

    /** 编辑账目。失败语义同 createEntry。 */
    async updateEntry(id: string, input: Partial<LedgerEntryInput>): Promise<LedgerEntry> {
      this.saving = true
      try {
        const { entry } = await api.ledger.updateEntry(id, input)
        useUi().notify('success', '已保存')
        await this.reload()
        return entry
      } finally {
        this.saving = false
      }
    },

    /**
     * 删除账目。返回是否成功 —— 调用方要拿它决定"关掉详情面板"还是"留在原地再试"。
     */
    async deleteEntry(id: string): Promise<boolean> {
      this.saving = true
      try {
        await api.ledger.deleteEntry(id)
        useUi().notify('success', '已删除')
        await this.reload()
        return true
      } catch (err) {
        useUi().notify('error', '删除失败', describe(err))
        return false
      } finally {
        this.saving = false
      }
    },

    async submitEntry(id: string): Promise<void> {
      this.saving = true
      try {
        await api.ledger.submitEntry(id)
        useUi().notify('success', '操作已完成')
        await this.reload()
      } catch (err) {
        useUi().notify('error', '操作失败', describe(err))
      } finally {
        this.saving = false
      }
    },

    async withdrawEntry(id: string): Promise<void> {
      this.saving = true
      try {
        await api.ledger.withdrawEntry(id)
        useUi().notify('success', '操作已完成')
        await this.reload()
      } catch (err) {
        useUi().notify('error', '操作失败', describe(err))
      } finally {
        this.saving = false
      }
    },

    /**
     * 审批（通过/驳回）。驳回的弹窗要靠返回值决定"留着让人改理由"还是"关掉"。
     */
    async decideEntry(id: string, decision: 'approve' | 'reject', note?: string): Promise<boolean> {
      this.saving = true
      try {
        await api.ledger.decideEntry(id, decision, note)
        useUi().notify('success', decision === 'approve' ? '操作已完成' : '已驳回')
        await this.reload()
        return true
      } catch (err) {
        useUi().notify('error', decision === 'approve' ? '操作失败' : '驳回失败', describe(err))
        return false
      } finally {
        this.saving = false
      }
    },

    async payEntry(id: string): Promise<void> {
      this.saving = true
      try {
        await api.ledger.payEntry(id)
        useUi().notify('success', '操作已完成')
        await this.reload()
      } catch (err) {
        useUi().notify('error', '操作失败', describe(err))
      } finally {
        this.saving = false
      }
    },

    /**
     * 标记/取消某人的分摊已结清。
     *
     * 成功时不弹通知：结清状态就在详情面板那一行上，点完立刻变成"已结清"，
     * 再弹一个 toast 是噪声（这条在合并前就是这样，保持原样）。
     */
    async settleSplit(entryId: string, userId: string, settled: boolean): Promise<void> {
      this.saving = true
      try {
        await api.ledger.settleSplit(entryId, userId, settled)
        await this.reload()
      } catch (err) {
        useUi().notify('error', '更新结清状态失败', describe(err))
      } finally {
        this.saving = false
      }
    },

    async createCategory(input: { name: string; kind: LedgerKind; icon?: string }): Promise<void> {
      this.saving = true
      this.error = null
      try {
        const { category } = await api.ledger.createCategory(input)
        useUi().notify('success', '分类已创建', category.name)
        await this.loadCategories()
        await this.loadEntries()
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', '创建分类失败', message)
      } finally {
        this.saving = false
      }
    },

    async archiveCategory(id: string, archived: boolean): Promise<void> {
      this.saving = true
      this.error = null
      try {
        await api.ledger.archiveCategory(id, archived)
        useUi().notify('success', archived ? '分类已归档' : '分类已恢复')
        await this.loadCategories()
        await this.loadEntries()
      } catch (err) {
        const message = describe(err)
        this.error = message
        useUi().notify('error', archived ? '归档失败' : '恢复失败', message)
      } finally {
        this.saving = false
      }
    },

    /**
     * 合并筛选条件后自动重新拉数据。
     * 区间（from/to）影响统计，变动时要连统计一起刷新；其余条件只影响列表。
     */
    setFilters(patch: Partial<LedgerFilters>): void {
      const prevFrom = this.filters.from
      const prevTo = this.filters.to
      this.filters = { ...this.filters, ...patch }
      const rangeChanged = prevFrom !== this.filters.from || prevTo !== this.filters.to
      void this.loadEntries()
      if (rangeChanged) void this.loadSummary()
    },

    resetFilters(): void {
      this.filters = emptyFilters()
      void this.loadEntries()
      void this.loadSummary()
    },
  },
})
