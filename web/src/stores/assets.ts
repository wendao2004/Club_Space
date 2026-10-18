/**
 * 财物管理（物品台账 + 借还记录）的状态管理。
 *
 * 与服务端的分工：**可用量、在外数量、逾期与否全部由服务端算**，
 * 前端只负责显示。本地绝不自己"推算"一遍可用量 ——
 * 两边各算一套的话，界面上的数字和图腾上的数字迟早会不一样，
 * 而用户只会觉得"这软件算错了"。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type AssetCategory, type AssetItem, type AssetItemInput, type AssetLoan, type AssetSummary } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : '未知错误'
}

export interface AssetFilters {
  q: string
  categoryId: string
  status: 'active' | 'retired'
  onlyAvailable: boolean
  onlyOnLoan: boolean
}

interface State {
  categories: AssetCategory[]
  items: AssetItem[]
  /** 当前打开的物品详情；为 null 时显示列表。 */
  detail: { item: AssetItem; loans: AssetLoan[] } | null
  loans: AssetLoan[]
  /** 借还记录的视图：全部 / 未归还 / 逾期 / 我借的。 */
  loanFilter: 'all' | 'open' | 'overdue' | 'mine'
  /** 借还记录的搜索词（物品名/编号、借用人、用途）。 */
  loanQ: string
  summary: AssetSummary | null
  overdue: AssetLoan[]
  filters: AssetFilters
  /** 可选的借用人（用于"代谁借"）。拿不到时退化成只有自己。 */
  members: Array<{ id: string; name: string }>
  loading: boolean
  error: string | null
}

export const useAssets = defineStore('assets', {
  state: (): State => ({
    categories: [],
    items: [],
    detail: null,
    loans: [],
    loanFilter: 'all',
    loanQ: '',
    summary: null,
    overdue: [],
    filters: { q: '', categoryId: '', status: 'active', onlyAvailable: false, onlyOnLoan: false },
    members: [],
    loading: false,
    error: null,
  }),

  getters: {
    /** 有东西在外面的物品（列表顶部做个标记用）。 */
    onLoanItems: (state): AssetItem[] => state.items.filter((i) => i.onLoanQty > 0),

    /** 快要用完的：可借数量为 0 但总数不为 0。 */
    exhaustedItems: (state): AssetItem[] => state.items.filter((i) => i.totalQty > 0 && i.availableQty === 0),

    activeCategories: (state): AssetCategory[] => state.categories.filter((c) => !c.archived),
  },

  actions: {
    async loadCategories(): Promise<void> {
      try {
        const res = await api.assets.categories()
        this.categories = res.categories
      } catch (err) {
        // 分类加载失败不该挡住整个页面 —— 物品列表照常显示，只是筛选器空着
        this.error = messageOf(err)
      }
    },

    async loadItems(): Promise<void> {
      this.loading = true
      try {
        const res = await api.assets.items({
          q: this.filters.q || undefined,
          categoryId: this.filters.categoryId || undefined,
          status: this.filters.status,
          available: this.filters.onlyAvailable || undefined,
          onLoan: this.filters.onlyOnLoan || undefined,
        })
        this.items = res.items
        this.error = null
      } catch (err) {
        const message = messageOf(err)
        this.error = message
        useUi().notify('error', '加载物品失败', message)
      } finally {
        this.loading = false
      }
    },

    async loadLoans(): Promise<void> {
      try {
        const res = await api.assets.loans({
          mine: this.loanFilter === 'mine' || undefined,
          open: this.loanFilter === 'open' || undefined,
          overdue: this.loanFilter === 'overdue' || undefined,
          search: this.loanQ.trim() || undefined,
          limit: 200,
        })
        this.loans = res.loans
      } catch (err) {
        useUi().notify('error', '加载借还记录失败', messageOf(err))
      }
    },

    async loadSummary(): Promise<void> {
      try {
        const res = await api.assets.summary()
        this.summary = res.summary
        this.overdue = res.overdue
      } catch (err) {
        // 汇总失败不弹提示：它只是首页的一个概览，弹了反而吵
        this.error = messageOf(err)
      }
    },

    /** 一次把界面要用的都拉齐。 */
    async refresh(): Promise<void> {
      await Promise.all([this.loadCategories(), this.loadItems(), this.loadLoans(), this.loadSummary()])
    },

    async openItem(id: string): Promise<void> {
      try {
        this.detail = await api.assets.item(id)
      } catch (err) {
        useUi().notify('error', '打开物品失败', messageOf(err))
        this.detail = null
      }
    },

    closeDetail(): void {
      this.detail = null
    },

    async createItem(input: AssetItemInput): Promise<boolean> {
      try {
        const res = await api.assets.createItem(input)
        useUi().notify('success', '物品已登记', res.item.name)
        await Promise.all([this.loadItems(), this.loadSummary()])
        return true
      } catch (err) {
        useUi().notify('error', '登记失败', messageOf(err))
        return false
      }
    },

    async updateItem(id: string, input: Partial<AssetItemInput>): Promise<boolean> {
      try {
        const res = await api.assets.updateItem(id, input)
        useUi().notify('success', '已保存', res.item.name)
        await Promise.all([this.loadItems(), this.loadSummary()])
        // 详情页开着的话同步刷新，否则用户会看到旧数字
        if (this.detail?.item.id === id) await this.openItem(id)
        return true
      } catch (err) {
        useUi().notify('error', '保存失败', messageOf(err))
        return false
      }
    },

    async retireItem(id: string, retired: boolean): Promise<boolean> {
      try {
        await api.assets.retireItem(id, retired)
        useUi().notify('success', retired ? '已退役' : '已恢复')
        await Promise.all([this.loadItems(), this.loadSummary()])
        if (this.detail?.item.id === id) await this.openItem(id)
        return true
      } catch (err) {
        useUi().notify('error', retired ? '退役失败' : '恢复失败', messageOf(err))
        return false
      }
    },

    /**
     * 拉一份成员列表，供"代谁借"下拉用。
     *
     * 复用聊天的联系人接口而不是新开一个 —— 它返回的就是"社团里有哪些人"，
     * 而且普通成员也调得到（不需要管理员权限）。
     * 拿不到就退化成"只能借给自己"，不影响借东西本身。
     */
    async loadMembers(): Promise<void> {
      const me = useAuth().user
      const fallback = me ? [{ id: me.id, name: me.displayName }] : []
      try {
        const res = await api.chat.contacts()
        const list = (res.contacts ?? []).map((c) => ({ id: c.id, name: c.displayName }))
        // 把自己也放进去：借给自己是最常见的用法，而联系人列表不保证包含自己
        if (me && !list.some((m) => m.id === me.id)) list.push({ id: me.id, name: me.displayName })
        this.members = list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      } catch {
        this.members = fallback
      }
    },

    async lend(input: {
      itemId: string
      qty: number
      /** 代谁借。省略就是自己借。 */
      borrowerId?: string
      dueOn?: string
      purpose?: string
      note?: string
    }): Promise<boolean> {
      try {
        const res = await api.assets.lend(input)
        useUi().notify('success', '已借出', `${res.loan.itemName} × ${res.loan.qty}`)
        await Promise.all([this.loadItems(), this.loadLoans(), this.loadSummary()])
        if (this.detail) await this.openItem(this.detail.item.id)
        return true
      } catch (err) {
        // 超借是这个界面最可能出错的操作，服务端的提示很具体
        // （"只剩 1 件可借，你要借 2 件"），原样透传，不要替换成笼统的话
        useUi().notify('error', '借出失败', messageOf(err))
        return false
      }
    },

    async returnLoan(
      id: string,
      input: { condition?: 'good' | 'fair' | 'broken' | 'lost'; note?: string } = {},
    ): Promise<boolean> {
      try {
        const res = await api.assets.returnLoan(id, input)
        useUi().notify('success', '已归还', `${res.loan.itemName} × ${res.loan.qty}`)
        await Promise.all([this.loadItems(), this.loadLoans(), this.loadSummary()])
        if (this.detail) await this.openItem(this.detail.item.id)
        return true
      } catch (err) {
        useUi().notify('error', '归还失败', messageOf(err))
        return false
      }
    },

    /** 更正一条借还记录（管理员）。 */
    async updateLoan(
      id: string,
      input: { qty?: number; borrowerId?: string; dueOn?: string | null; purpose?: string | null; note?: string | null },
    ): Promise<boolean> {
      try {
        await api.assets.updateLoan(id, input)
        useUi().notify('success', '记录已更正')
        await Promise.all([this.loadItems(), this.loadLoans(), this.loadSummary()])
        if (this.detail) await this.openItem(this.detail.item.id)
        return true
      } catch (err) {
        useUi().notify('error', '更正失败', messageOf(err))
        return false
      }
    },

    /** 作废一条借还记录（管理员）。保留历史，仅从账面可用量里剔除。 */
    async voidLoan(id: string): Promise<boolean> {
      try {
        await api.assets.voidLoan(id)
        useUi().notify('success', '记录已作废')
        await Promise.all([this.loadItems(), this.loadLoans(), this.loadSummary()])
        if (this.detail) await this.openItem(this.detail.item.id)
        return true
      } catch (err) {
        useUi().notify('error', '作废失败', messageOf(err))
        return false
      }
    },

    /** 恢复一条被作废的记录（管理员）。恢复后会重新计入账面。 */
    async restoreLoan(id: string): Promise<boolean> {
      try {
        await api.assets.restoreLoan(id)
        useUi().notify('success', '记录已恢复', '重新计入账面')
        await Promise.all([this.loadItems(), this.loadLoans(), this.loadSummary()])
        if (this.detail) await this.openItem(this.detail.item.id)
        return true
      } catch (err) {
        useUi().notify('error', '恢复失败', messageOf(err))
        return false
      }
    },

    async createCategory(name: string): Promise<boolean> {
      try {
        await api.assets.createCategory({ name })
        useUi().notify('success', '分类已创建', name)
        await this.loadCategories()
        return true
      } catch (err) {
        useUi().notify('error', '创建分类失败', messageOf(err))
        return false
      }
    },

    async archiveCategory(id: string, archived: boolean): Promise<void> {
      try {
        await api.assets.archiveCategory(id, archived)
        await Promise.all([this.loadCategories(), this.loadItems()])
      } catch (err) {
        useUi().notify('error', '操作失败', messageOf(err))
      }
    },

    setLoanFilter(filter: State['loanFilter']): void {
      this.loanFilter = filter
      void this.loadLoans()
    },

    resetFilters(): void {
      this.filters = { q: '', categoryId: '', status: 'active', onlyAvailable: false, onlyOnLoan: false }
      void this.loadItems()
    },
  },
})
