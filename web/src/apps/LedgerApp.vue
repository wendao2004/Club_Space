<!--
  社团账目应用。

  三条业务红线在这里落到界面上，改代码前先读一遍：
   1. 金额永远是字符串。服务端存整数「分」，前端只做整数分的加减（字符串按小数点拆开），
      绝不用浮点算钱。展示时一律用 entry.amount / split.amount 原样字符串。
   2. 状态机 draft → submitted → approved/rejected → paid，按钮的可用性完全由状态 + 身份决定，
      不满足条件时禁用并说明原因，而不是把按钮藏起来。
   3. 不能审批自己提交的账目（服务端会拒绝，界面同步禁用）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { ApiError, api, formatBytes, formatTime } from '@/api'
import type {
  FileEntry,
  LedgerEntry,
  LedgerEntryInput,
  LedgerEvent,
  LedgerKind,
  LedgerSplit,
  LedgerStatus,
} from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useWindows } from '@/stores/windows'
import { useLedger } from '@/stores/ledger'
import type { LedgerFilters } from '@/stores/ledger'
import type { WindowInstance } from '@/stores/windows'
import LedgerSummary from './LedgerSummary.vue'

const props = defineProps<{ win: WindowInstance }>()

const auth = useAuth()
const ui = useUi()
const windows = useWindows()
const ledger = useLedger()

// ---------------------------------------------------------------- 常量与文案

const KIND_LABEL: Record<LedgerKind, string> = { income: '收入', expense: '支出' }

const STATUS_LABEL: Record<LedgerStatus, string> = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  paid: '已支付',
}

/** 徽章配色：draft→中性、submitted→warning、approved→accent、rejected→danger、paid→success。 */
const STATUS_BADGE: Record<LedgerStatus, string> = {
  draft: '',
  submitted: 'wl-badge--warning',
  approved: 'wl-badge--accent',
  rejected: 'wl-badge--danger',
  paid: 'wl-badge--success',
}

// ---------------------------------------------------------------- 金额工具（只用整数分）

/**
 * 把 "12.50" 这类字符串解析成整数「分」。全程不经过 parseFloat。
 * 不合法时返回 NaN，调用方自行判断。
 */
function centsOf(value: string): number {
  const text = value.trim()
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return NaN
  const dot = text.indexOf('.')
  const intPart = dot < 0 ? text : text.slice(0, dot)
  const fracPart = dot < 0 ? '' : text.slice(dot + 1)
  const frac = (fracPart + '00').slice(0, 2)
  return Number(intPart) * 100 + Number(frac)
}

/** 整数「分」格式化回 "12.50"。不经过浮点，也不会出现 0.30000000000000004。 */
function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '0.00'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}${whole}.${frac}`
}

// ---------------------------------------------------------------- 展示辅助

function kindIcon(kind: LedgerKind): string {
  // 钱进来用 arrow-down，钱出去用 arrow-up。
  return kind === 'income' ? 'arrow-down' : 'arrow-up'
}

function kindToneClass(kind: LedgerKind): string {
  return kind === 'income' ? 'tone-success' : 'tone-danger'
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** 本地「今天」，用本地时区，避免 toISOString 在时区偏移下差一天。 */
function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------- 响应式布局

const rootEl = ref<HTMLElement | null>(null)
/** 宽窗口（>=900px）时右侧常驻统计面板；窄窗口收进抽屉。 */
const narrow = ref(false)
const drawerOpen = ref(false)
let observer: ResizeObserver | null = null

function applyWidth(width: number): void {
  narrow.value = width < 900
}

// ---------------------------------------------------------------- 筛选

const categoryOptions = computed(() => {
  const kind = ledger.filters.kind
  return ledger.categories.filter((c) => kind === null || c.kind === kind)
})

/** 顶部的一句话筛选摘要，例如「2026-10-01 至 2026-10-31 · 仅支出 · 待审批」。 */
const filterSummary = computed<string>(() => {
  const f = ledger.filters
  const parts: string[] = []
  if (f.search.trim()) parts.push(`搜索「${f.search.trim()}」`)
  if (f.from && f.to) parts.push(`${f.from} 至 ${f.to}`)
  else if (f.from) parts.push(`${f.from} 起`)
  else if (f.to) parts.push(`截至 ${f.to}`)
  if (f.kind === 'income') parts.push('仅收入')
  else if (f.kind === 'expense') parts.push('仅支出')
  if (f.categoryId) {
    const cat = ledger.categories.find((c) => c.id === f.categoryId)
    if (cat) parts.push(cat.name)
  }
  if (f.status) parts.push(STATUS_LABEL[f.status])
  if (f.mine) parts.push('只看我的')
  if (f.pending) parts.push('待我审批')
  return parts.length > 0 ? parts.join(' · ') : '全部账目'
})

// 导出地址：筛选里的 null 要转成 undefined，
// 因为 api.ledger.exportUrl 的签名是 { from?: string; to?: string }，
// 而 URLSearchParams 遇到 null 会拼出字面量 "null"。
const exportHref = computed(() =>
  api.ledger.exportUrl({
    from: ledger.filters.from ?? undefined,
    to: ledger.filters.to ?? undefined,
  }),
)

function resetFilters(): void {
  // 逐字段给而不是调 store.resetFilters()：那个会把 eventId 也清掉，
  // 而 eventId 是"从活动页进来"的上下文，重置筛选不该丢它。
  ledger.setFilters({
    from: null,
    to: null,
    kind: null,
    categoryId: null,
    status: null,
    search: '',
    mine: false,
    pending: false,
  })
}

// --- 筛选控件接线。
//
// 这些控件之前只用 v-model 直接改 ledger.filters，列表并不会重查 ——
// 用户会觉得"选了筛选没反应"。统一走 store.setFilters()：它合并条件、
// 重拉列表，区间变了还会重算统计。
//
// 注意：不能用 v-model + @change 双写（v-model 先改值、setFilters 再改一次），
// 这里一律 :value / :checked + @change，保证只有一个入口。

const SEARCH_DEBOUNCE_MS = 250
let searchTimer: number | null = null

function onSearchInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  // 防抖：每敲一个字查一次会把服务端打成筛子
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    ledger.setFilters({ search: value })
  }, SEARCH_DEBOUNCE_MS)
}

function onDateChange(key: 'from' | 'to', event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  ledger.setFilters({ [key]: raw === '' ? null : raw } as Partial<LedgerFilters>)
}

function onSelectChange(key: 'kind' | 'categoryId' | 'status', event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  const patch: Partial<LedgerFilters> = { [key]: raw === '' ? null : raw } as Partial<LedgerFilters>
  // 类型一换，"已选分类"若不匹配就地清掉，和下面的 watch 保持同一语义
  if (key === 'kind' && raw !== '') {
    const cat = ledger.categories.find((c) => c.id === ledger.filters.categoryId)
    if (cat && cat.kind !== raw) patch.categoryId = null
  }
  ledger.setFilters(patch)
}

// --- 快捷时间范围（本月 / 上月 / 今年 / 全部）

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const rangePresets = computed<Array<{ key: string; label: string; from: string | null; to: string | null }>>(() => {
  const now = new Date()
  return [
    {
      key: 'month',
      label: '本月',
      from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    },
    {
      key: 'last-month',
      label: '上月',
      from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
    },
    {
      key: 'year',
      label: '今年',
      from: ymd(new Date(now.getFullYear(), 0, 1)),
      to: ymd(now),
    },
    { key: 'all', label: '全部', from: null, to: null },
  ]
})

/** 当前区间正好等于某个快捷范围时高亮它；手填的日期不会点亮任何 chip。 */
const activeRangeKey = computed<string | null>(() => {
  const { from, to } = ledger.filters
  const hit = rangePresets.value.find((p) => p.from === from && p.to === to)
  return hit?.key ?? null
})

function applyRange(preset: { from: string | null; to: string | null }): void {
  ledger.setFilters({ from: preset.from, to: preset.to })
}

// --- 活动卡片的展示辅助

function dateRangeText(ev: LedgerEvent): string {
  if (!ev.startOn && !ev.endOn) return '日期未定'
  if (!ev.endOn) return `${ev.startOn} 起`
  return `${ev.startOn ?? '未定'} ~ ${ev.endOn}`
}

/** 支出占收支总额的百分比（0~100），给卡片底部的构成条用。 */
function spendPercent(ev: LedgerEvent): number {
  const total = ev.incomeCents + ev.expenseCents
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((ev.expenseCents / total) * 100)))
}

// 类型切换后，若当前选中的分类不属于新类型，就清掉，避免出现「选了支出却筛的是收入分类」。
watch(
  () => ledger.filters.kind,
  (kind) => {
    const id = ledger.filters.categoryId
    if (!id || kind === null) return
    const cat = ledger.categories.find((c) => c.id === id)
    if (cat && cat.kind !== kind) ledger.filters.categoryId = null
  },
)

// ---------------------------------------------------------------- 列表与详情

const busy = ref<string | null>(null)
const selectedId = ref<string | null>(null)

/** 详情从 store 的 entries 里派生，这样 reload 后详情自动跟着刷新。 */
const selected = computed<LedgerEntry | null>(
  () => ledger.entries.find((e) => e.id === selectedId.value) ?? null,
)

interface TimelineNode {
  key: string
  label: string
  icon: string
  tone: '' | 'success' | 'danger' | 'accent'
  time: string | null
  who: string | null
  note: string | null
}

const timeline = computed<TimelineNode[]>(() => {
  const entry = selected.value
  if (!entry) return []
  const rejected = entry.status === 'rejected'
  return [
    {
      key: 'created',
      label: '创建',
      icon: 'file',
      tone: '',
      time: formatTime(entry.createdAt),
      who: entry.creatorName,
      note: null,
    },
    {
      key: 'submitted',
      label: '提交',
      icon: 'upload',
      tone: entry.submittedAt ? 'accent' : '',
      time: entry.submittedAt ? formatTime(entry.submittedAt) : null,
      who: entry.submittedAt ? entry.creatorName : null,
      note: null,
    },
    {
      key: 'decided',
      label: rejected ? '驳回' : '审批',
      icon: entry.decidedAt ? (rejected ? 'close' : 'check') : 'clock',
      tone: entry.decidedAt ? (rejected ? 'danger' : 'success') : '',
      time: entry.decidedAt ? formatTime(entry.decidedAt) : null,
      who: entry.deciderName,
      note: entry.decisionNote,
    },
    {
      key: 'paid',
      label: '支付',
      icon: 'check',
      tone: entry.paidAt ? 'success' : '',
      time: entry.paidAt ? formatTime(entry.paidAt) : null,
      who: entry.paidAt ? entry.deciderName : null,
      note: null,
    },
  ]
})

// ---------------------------------------------------------------- 行内 / 详情操作

interface RowAction {
  key: string
  label: string
  icon: string
  disabled: boolean
  title: string
  primary?: boolean
  danger?: boolean
}

function actionsFor(entry: LedgerEntry): RowAction[] {
  const mine = entry.createdBy === auth.user?.id
  const admin = auth.isAdmin

  // 管理员对任何账目都有编辑/删除权（服务端 updateEntry/deleteEntry 已放开）。
  // 草稿/驳回之外的状态也补上，满足"管理员对所有可增删改查项都有权限"。
  const adminEdit: RowAction = {
    key: 'edit',
    label: '编辑',
    icon: 'rename',
    disabled: !(mine || admin),
    title: admin && !mine ? '以管理员身份编辑这条账目' : '编辑这条账目',
  }
  const adminDelete: RowAction = {
    key: 'delete',
    label: '删除',
    icon: 'trash',
    disabled: !(mine || admin),
    title: admin && !mine ? '以管理员身份删除这条账目' : '删除这条账目',
    danger: true,
  }

  switch (entry.status) {
    case 'draft':
    case 'rejected':
      return [
        {
          ...adminEdit,
          title: mine ? '编辑这条账目' : admin ? '以管理员身份编辑这条账目' : '只有创建者或管理员可以修改',
        },
        {
          key: 'submit',
          label: '提交',
          icon: 'upload',
          disabled: !mine,
          title: mine ? '提交审批' : '只有创建者可以提交',
          primary: true,
        },
        adminDelete,
      ]
    case 'submitted':
      return [
        {
          key: 'withdraw',
          label: '撤回',
          icon: 'arrow-left',
          disabled: !mine,
          title: mine ? '撤回为草稿' : '只有创建者可以撤回',
        },
        {
          key: 'approve',
          label: '通过',
          icon: 'check',
          // 管理员可以审批自己提交的账目 —— 单人社团里没有第二个管理员，
          // 否则走正常 submit 流程的账目会永远卡在"待审批"。
          // 服务端 decideEntry 已按此放开（`createdBy === reviewerId && !isAdmin` 才拒绝）。
          disabled: !admin,
          title: !admin ? '仅管理员可以审批' : '审批通过',
          primary: true,
        },
        {
          key: 'reject',
          label: '驳回',
          icon: 'close',
          disabled: !admin,
          title: !admin ? '仅管理员可以审批' : '驳回并填写理由',
          danger: true,
        },
      ]
    case 'approved':
      return [
        {
          key: 'pay',
          label: '标记已支付',
          icon: 'check',
          disabled: !admin,
          title: admin ? '标记为已支付' : '仅管理员可以标记支付',
          primary: true,
        },
        adminEdit,
        adminDelete,
      ]
    case 'paid':
      // 已支付默认是"冻结"的历史，但管理员仍可按需求更正/删除错账。
      // 注意：若账目归属的已封账活动，服务端 assertEventWritable 仍会拦下。
      return [adminEdit, adminDelete]
  }
}

const actions = computed<RowAction[]>(() => (selected.value ? actionsFor(selected.value) : []))

async function runAction(entry: LedgerEntry, key: string): Promise<void> {
  if (key === 'edit') {
    openEdit(entry)
    return
  }
  if (key === 'delete') {
    askDelete(entry)
    return
  }
  if (key === 'reject') {
    rejectTarget.value = entry
    rejectNote.value = ''
    return
  }

  busy.value = entry.id
  try {
    if (key === 'submit') await api.ledger.submitEntry(entry.id)
    else if (key === 'withdraw') await api.ledger.withdrawEntry(entry.id)
    else if (key === 'approve') await api.ledger.decideEntry(entry.id, 'approve')
    else if (key === 'pay') await api.ledger.payEntry(entry.id)
    ui.notify('success', '操作已完成')
    await ledger.reload()
  } catch (err) {
    ui.notify('error', '操作失败', messageOf(err))
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- 确认 / 驳回

interface ConfirmState {
  title: string
  detail: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

const confirmState = ref<ConfirmState | null>(null)

function askDelete(entry: LedgerEntry): void {
  confirmState.value = {
    title: '删除账目',
    detail: `确定删除「${entry.title}」这笔${KIND_LABEL[entry.kind]}吗？删除后不可恢复。`,
    danger: true,
    onConfirm: async () => {
      confirmState.value = null
      busy.value = entry.id
      try {
        await api.ledger.deleteEntry(entry.id)
        if (selectedId.value === entry.id) selectedId.value = null
        ui.notify('success', '已删除')
        await ledger.reload()
      } catch (err) {
        ui.notify('error', '删除失败', messageOf(err))
      } finally {
        busy.value = null
      }
    },
  }
}

const rejectTarget = ref<LedgerEntry | null>(null)
const rejectNote = ref('')

async function confirmReject(): Promise<void> {
  const entry = rejectTarget.value
  if (!entry) return
  const note = rejectNote.value.trim()
  busy.value = entry.id
  try {
    await api.ledger.decideEntry(entry.id, 'reject', note || undefined)
    rejectTarget.value = null
    rejectNote.value = ''
    ui.notify('success', '已驳回')
    await ledger.reload()
  } catch (err) {
    ui.notify('error', '驳回失败', messageOf(err))
  } finally {
    busy.value = null
  }
}

function canSettle(split: LedgerSplit): boolean {
  return auth.user?.id === split.userId || auth.isAdmin
}

async function toggleSettle(entry: LedgerEntry, split: LedgerSplit): Promise<void> {
  busy.value = entry.id
  try {
    await api.ledger.settleSplit(entry.id, split.userId, !split.settled)
    await ledger.reload()
  } catch (err) {
    ui.notify('error', '更新结清状态失败', messageOf(err))
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- 新建 / 编辑表单

interface SplitRow {
  userId: string
  userName: string
  checked: boolean
  amount: string
}

interface AttachmentChip {
  nodeId: string
  name: string
  size: number
}

interface FormState {
  id: string | null
  kind: LedgerKind
  amount: string
  occurredOn: string
  categoryId: string
  title: string
  note: string
  /** 归属的活动/比赛。空字符串 = 不归属任何活动（日常零散账目）。 */
  eventId: string
  attachments: AttachmentChip[]
  showSplit: boolean
  splits: SplitRow[]
}

function blankForm(kind: LedgerKind): FormState {
  return {
    id: null,
    kind,
    amount: '',
    occurredOn: todayISO(),
    categoryId: '',
    title: '',
    note: '',
    // 默认带上当前正在浏览的活动 —— 在活动里点"记一笔"，十有八九就是记给它的
    eventId: ledger.filters.eventId ?? '',
    attachments: [],
    showSplit: false,
    splits: [],
  }
}

// ---------------------------------------------------------------- 活动视图

/**
 * 当前视图。
 *
 * 三种：账目流水（原来的）/ 活动列表 / 某个活动的汇总。
 * 用一个字段而不是三个布尔量 —— 布尔量会出现"两个同时为真"的非法状态，
 * 之后每加一种视图都要在两处同步修改。
 */
type LedgerView = 'entries' | 'events' | 'event'
const view = ref<LedgerView>('entries')

const EVENT_KIND_LABELS: Record<LedgerEvent['kind'], string> = {
  competition: '比赛',
  activity: '活动',
  other: '其它',
}

/** 同上的数组形式，给 v-for 用（对象遍历拿到的 key 是 string，类型上不好收）。 */
const EVENT_KIND_OPTIONS: Array<{ key: LedgerEvent['kind']; label: string }> = [
  { key: 'competition', label: '比赛' },
  { key: 'activity', label: '活动' },
  { key: 'other', label: '其它' },
]

/** 活动汇总。请求还在飞的那一瞬间是 null，模板里用 v-if 兜住。 */
const evS = computed(() => ledger.eventSummary)

/** 谁能改这个活动：管理员，或者建它的人。与服务端的判断保持一致。 */
const canManageEvent = computed(() => {
  const ev = ledger.eventSummary?.event
  if (!ev) return false
  return auth.isAdmin || ev.createdBy === auth.user?.id
})

const eventExportHref = computed(() =>
  ledger.eventSummary ? api.ledger.eventExportUrl(ledger.eventSummary.event.id) : '#',
)

function switchView(next: LedgerView): void {
  view.value = next
  if (next === 'entries') {
    // 回到流水视图时清掉活动筛选：否则会看到"列表空了"而不知道是筛选造成的
    ledger.filters.eventId = null
    void ledger.reload()
  } else if (next === 'events') {
    void ledger.loadEvents()
  }
}

async function openEvent(id: string): Promise<void> {
  view.value = 'event'
  await ledger.loadEventSummary(id)
}

/**
 * 打开某个活动的汇总时，顺手把活动筛选设上。
 *
 * 这样在活动里点「记一笔到本活动」时，表单会默认归属到这个活动 ——
 * 少一次选择，而"在活动里记的账却挂到了别处"是最容易犯的错。
 */
watch(
  () => ledger.eventSummary?.event.id,
  (id) => {
    if (id) ledger.filters.eventId = id
  },
)

async function toggleEventClosed(): Promise<void> {
  const ev = ledger.eventSummary?.event
  if (!ev) return
  const closing = ev.status !== 'closed'
  const ok = window.confirm(
    closing
      ? `封账之后不能再往「${ev.name}」里记新账、也不能改已有账目。\n\n历史一条都不会少，随时可以解封。确定吗？`
      : `解封「${ev.name}」之后又能往里记账、改账了。确定吗？`,
  )
  if (!ok) return
  await ledger.closeEvent(ev.id, closing)
}

// ---- 活动的新建 / 编辑

const eventEditorOpen = ref(false)
const eventFormError = ref('')
const eventForm = ref<{
  id: string | null
  name: string
  kind: LedgerEvent['kind']
  startOn: string
  endOn: string
  note: string
}>({ id: null, name: '', kind: 'activity', startOn: '', endOn: '', note: '' })

function openEventEditor(ev?: LedgerEvent): void {
  eventFormError.value = ''
  eventForm.value = ev
    ? {
        id: ev.id,
        name: ev.name,
        kind: ev.kind,
        startOn: ev.startOn ?? '',
        endOn: ev.endOn ?? '',
        note: ev.note ?? '',
      }
    : { id: null, name: '', kind: 'activity', startOn: todayISO(), endOn: '', note: '' }
  eventEditorOpen.value = true
}

async function submitEventForm(): Promise<void> {
  const f = eventForm.value
  const name = f.name.trim()
  if (!name) {
    eventFormError.value = '活动名称不能为空'
    return
  }
  if (name.length > 60) {
    eventFormError.value = '活动名称最多 60 字'
    return
  }
  // 本地先拦一道明显的错误，省一次往返；服务端仍然会独立校验
  if (f.endOn && f.startOn && f.endOn < f.startOn) {
    eventFormError.value = '结束日期不能早于开始日期'
    return
  }
  const payload = {
    name,
    kind: f.kind,
    startOn: f.startOn || null,
    endOn: f.endOn || null,
    note: f.note.trim() || null,
  }
  const saved = f.id ? await ledger.updateEvent(f.id, payload) : await ledger.createEvent(payload)
  if (saved) eventEditorOpen.value = false
}

const editorOpen = ref(false)
const form = ref<FormState>(blankForm('expense'))
const formError = ref('')
const saving = ref(false)

const editorCategoryOptions = computed(() =>
  ledger.categories.filter((c) => c.kind === form.value.kind),
)

function openCreate(): void {
  const kind: LedgerKind = ledger.filters.kind === 'income' ? 'income' : 'expense'
  form.value = blankForm(kind)
  formError.value = ''
  editorOpen.value = true
}

function openEdit(entry: LedgerEntry): void {
  form.value = {
    id: entry.id,
    kind: entry.kind,
    amount: entry.amount,
    occurredOn: entry.occurredOn,
    categoryId: entry.categoryId ?? '',
    title: entry.title,
    note: entry.note ?? '',
    eventId: entry.eventId ?? '',
    attachments: entry.attachments.map((a) => ({ nodeId: a.nodeId, name: a.name, size: a.size })),
    showSplit: false,
    splits: entry.splits.map((s) => ({
      userId: s.userId,
      userName: s.userName,
      checked: true,
      amount: s.amount,
    })),
  }
  formError.value = ''
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  picker.value.open = false
}

function removeAttachment(nodeId: string): void {
  const idx = form.value.attachments.findIndex((a) => a.nodeId === nodeId)
  if (idx >= 0) form.value.attachments.splice(idx, 1)
}

// ---------------------------------------------------------------- 分摊

/**
 * 可选的分摊对象。
 *
 * 用 /api/members（全部 active 成员，含自己、含管理员）而不是聊天联系人 ——
 * 聊天联系人刻意排除了「当前登录用户」，而记账的常见场景恰恰是：管理员自己
 * 垫钱、把自己也列进分摊。之前用联系人名单，导致分摊名单里永远没有管理员
 * 本人（也就是用户报的「分摊要把管理员也算入」）。
 */
const splitCandidates = ref<Array<{ id: string; name: string }>>([])
let candidatesLoaded = false

async function ensureCandidates(): Promise<void> {
  if (candidatesLoaded) return
  try {
    const { members } = await api.members()
    splitCandidates.value = members.map((m) => ({
      id: m.id,
      name: m.id === auth.user?.id ? `${m.displayName}（我）` : m.displayName,
    }))
    candidatesLoaded = true
  } catch (err) {
    ui.notify('error', '加载成员失败', messageOf(err))
  }
}

async function toggleSplit(): Promise<void> {
  const f = form.value
  if (f.showSplit) {
    f.showSplit = false
    return
  }
  await ensureCandidates()
  const rows = new Map<string, SplitRow>()
  for (const c of splitCandidates.value) {
    rows.set(c.id, { userId: c.id, userName: c.name, checked: false, amount: '' })
  }
  // 表单里已有的行优先 —— 包括不在成员名单里的（例如账号被停用）。
  // 之前用整表重建，把它们悄悄丢了、保存时报"分摊合计与总额不一致"，无从修起。
  for (const prev of f.splits) rows.set(prev.userId, { ...prev })
  f.splits = [...rows.values()]
  f.showSplit = true
}

/** 均分：总额按整数分平均，余数给第一个人（100 分给 3 人 = 34/33/33）。 */
function splitEvenly(): void {
  const f = form.value
  const total = centsOf(f.amount)
  if (Number.isNaN(total) || total <= 0) {
    formError.value = '请先填写正确的金额，再执行均分'
    return
  }
  const rows = f.splits.filter((r) => r.checked)
  if (rows.length === 0) {
    formError.value = '请先勾选参与分摊的成员'
    return
  }
  formError.value = ''
  const base = Math.floor(total / rows.length)
  const remainder = total - base * rows.length
  rows.forEach((row, index) => {
    row.amount = formatCents(base + (index < remainder ? 1 : 0))
  })
}

const splitSum = computed<number>(() => {
  let sum = 0
  for (const row of form.value.splits) {
    if (!row.checked) continue
    const cents = centsOf(row.amount)
    if (!Number.isNaN(cents)) sum += cents
  }
  return sum
})

/** 分摊合计与总额的差额；金额不合法时 diff 为 null，界面不显示差额。 */
const splitDiff = computed<{ sum: number; diff: number | null }>(() => {
  const total = centsOf(form.value.amount)
  const sum = splitSum.value
  return { sum, diff: Number.isNaN(total) ? null : total - sum }
})

// ---------------------------------------------------------------- 表单提交

async function saveForm(): Promise<void> {
  const f = form.value
  const amount = f.amount.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    formError.value = '金额格式不正确，请输入最多两位小数的数字，例如 12.50'
    return
  }
  if (centsOf(amount) <= 0) {
    formError.value = '金额必须大于 0'
    return
  }
  const title = f.title.trim()
  if (!title) {
    formError.value = '请填写事由'
    return
  }
  if (title.length > 100) {
    formError.value = '事由最多 100 字'
    return
  }
  if (!f.occurredOn) {
    formError.value = '请选择业务日期'
    return
  }

  const checkedRows = f.splits.filter((r) => r.checked)
  if (f.kind === 'expense' && checkedRows.length > 0) {
    let sum = 0
    for (const row of checkedRows) {
      const value = row.amount.trim()
      if (!/^\d+(\.\d{1,2})?$/.test(value)) {
        formError.value = `分摊金额「${value || '空'}」格式不正确`
        return
      }
      sum += centsOf(value)
    }
    const total = centsOf(amount)
    if (sum !== total) {
      formError.value = `分摊合计 ¥${formatCents(sum)} 与总额 ¥${formatCents(total)} 相差 ¥${formatCents(Math.abs(total - sum))}`
      return
    }
  }

  const splits =
    f.kind === 'expense' && checkedRows.length > 0
      ? checkedRows.map((r) => ({ userId: r.userId, amount: r.amount.trim() }))
      : undefined

  const input: LedgerEntryInput = {
    kind: f.kind,
    amount,
    categoryId: f.categoryId || null,
    title,
    note: f.note.trim() || null,
    occurredOn: f.occurredOn,
    eventId: f.eventId || null,
    attachmentNodeIds: f.attachments.map((a) => a.nodeId),
    splits,
  }

  saving.value = true
  formError.value = ''
  try {
    if (f.id) {
      await api.ledger.updateEntry(f.id, input)
      ui.notify('success', '已保存')
    } else {
      await api.ledger.createEntry(input)
      ui.notify('success', '已创建')
    }
    editorOpen.value = false
    await ledger.reload()
  } catch (err) {
    // 后端返回的真实 message 直接展示，别用兜底文案盖掉。
    formError.value = messageOf(err)
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------- 凭证文件选择

interface PickerState {
  open: boolean
  loading: boolean
  error: string
  parentId: string | null
  breadcrumb: Array<{ id: string; name: string }>
  entries: FileEntry[]
  picked: FileEntry[]
}

const picker = ref<PickerState>({
  open: false,
  loading: false,
  error: '',
  parentId: null,
  breadcrumb: [],
  entries: [],
  picked: [],
})

async function loadPicker(parentId: string | null): Promise<void> {
  picker.value.loading = true
  picker.value.error = ''
  try {
    const listing = await api.listFiles(parentId, 'shared')
    picker.value.parentId = listing.parentId
    picker.value.breadcrumb = listing.breadcrumb
    picker.value.entries = listing.entries
  } catch (err) {
    picker.value.error = messageOf(err)
  } finally {
    picker.value.loading = false
  }
}

function openPicker(): void {
  picker.value.open = true
  picker.value.picked = []
  void loadPicker(null)
}

function closePicker(): void {
  picker.value.open = false
}

function pickerEnter(folder: FileEntry): void {
  void loadPicker(folder.id)
}

function pickerUp(): void {
  const crumbs = picker.value.breadcrumb
  const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : undefined
  void loadPicker(parent ? parent.id : null)
}

function pickerToggle(entry: FileEntry): void {
  const idx = picker.value.picked.findIndex((p) => p.id === entry.id)
  if (idx >= 0) picker.value.picked.splice(idx, 1)
  else picker.value.picked.push(entry)
}

function pickerIsPicked(id: string): boolean {
  return picker.value.picked.some((p) => p.id === id)
}

function pickerConfirm(): void {
  for (const file of picker.value.picked) {
    if (!form.value.attachments.some((a) => a.nodeId === file.id)) {
      form.value.attachments.push({ nodeId: file.id, name: file.name, size: file.size })
    }
  }
  picker.value.open = false
}

function openFilesApp(): void {
  windows.open({ appId: 'files', title: '文件' })
}

// ---------------------------------------------------------------- 生命周期

onMounted(() => {
  // store 已经 watch filters 并触发刷新，这里只做首次加载，不重复触发。
  void ledger.reload()
  // 活动列表也要拉一次：记账表单里的"归属活动"下拉要用它，
  // 而用户很可能一进来就直接点"记一笔"、根本没进过活动视图。
  void ledger.loadEvents()

  const el = rootEl.value
  if (el) {
    applyWidth(el.clientWidth)
    observer = new ResizeObserver((records) => {
      const width = records[0]?.contentRect.width
      if (width !== undefined) applyWidth(width)
    })
    observer.observe(el)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (searchTimer !== null) window.clearTimeout(searchTimer)
})
</script>

<template>
  <div ref="rootEl" class="ledger" :data-window-id="props.win.id">
    <!-- ---------------------------------------------------------- 工具栏 -->
    <header class="toolbar">
      <div class="toolbar__top">
        <div class="toolbar__heading">
          <Icon name="chart" :size="16" />
          <span class="toolbar__title">社团账目</span>
          <span class="toolbar__summary">{{ filterSummary }}</span>
        </div>
        <div class="toolbar__actions">
          <button
            v-if="narrow"
            class="wl-btn"
            :class="{ 'wl-btn--primary': drawerOpen }"
            title="显示或隐藏统计面板"
            @click="drawerOpen = !drawerOpen"
          >
            <Icon name="chart" :size="15" />
            <span>统计</span>
          </button>
          <a class="wl-btn link-btn" :href="exportHref" download>
            <Icon name="download" :size="15" />
            <span>导出 CSV</span>
          </a>
          <button class="wl-btn wl-btn--primary" @click="openCreate">
            <Icon name="plus" :size="15" />
            <span>记一笔</span>
          </button>
        </div>
      </div>

      <!-- 视图切换：账目流水 / 按活动看 -->
      <div class="toolbar__views">
        <div class="seg seg--view">
          <button
            class="seg__btn"
            :class="{ 'seg__btn--active': view === 'entries' }"
            @click="switchView('entries')"
          >
            全部账目
          </button>
          <button
            class="seg__btn"
            :class="{ 'seg__btn--active': view !== 'entries' }"
            @click="switchView('events')"
          >
            按活动
            <span v-if="ledger.events.length > 0" class="seg__count">{{ ledger.events.length }}</span>
          </button>
        </div>
        <span v-if="view === 'event' && ledger.eventSummary" class="toolbar__crumb">
          <button class="linklike" @click="switchView('events')">← 所有活动</button>
          <span>{{ ledger.eventSummary.event.name }}</span>
          <span
            class="tag"
            :class="ledger.eventSummary.event.status === 'closed' ? 'tag--muted' : 'tag--ok'"
          >
            {{ ledger.eventSummary.event.status === 'closed' ? '已封账' : '进行中' }}
          </span>
        </span>
      </div>

      <div v-if="view === 'entries'" class="toolbar__filters">
        <label class="filter filter--search">
          <Icon name="search" :size="14" />
          <input
            class="filter__search"
            type="search"
            placeholder="搜索标题或备注"
            :value="ledger.filters.search"
            @input="onSearchInput"
          />
        </label>
        <div class="rchips">
          <button
            v-for="preset in rangePresets"
            :key="preset.key"
            class="rchip"
            :class="{ 'rchip--on': activeRangeKey === preset.key }"
            @click="applyRange(preset)"
          >
            {{ preset.label }}
          </button>
        </div>
        <span class="filtersep" />
        <label class="filter">
          <span class="filter__label">起</span>
          <input
            class="wl-input filter__date"
            type="date"
            :value="ledger.filters.from ?? ''"
            @change="onDateChange('from', $event)"
          />
        </label>
        <label class="filter">
          <span class="filter__label">止</span>
          <input
            class="wl-input filter__date"
            type="date"
            :value="ledger.filters.to ?? ''"
            @change="onDateChange('to', $event)"
          />
        </label>
        <select
          class="wl-select filter__select"
          :value="ledger.filters.kind ?? ''"
          @change="onSelectChange('kind', $event)"
        >
          <option value="">全部类型</option>
          <option value="income">收入</option>
          <option value="expense">支出</option>
        </select>
        <select
          class="wl-select filter__select"
          :value="ledger.filters.categoryId ?? ''"
          @change="onSelectChange('categoryId', $event)"
        >
          <option value="">全部分类</option>
          <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select
          class="wl-select filter__select"
          :value="ledger.filters.status ?? ''"
          @change="onSelectChange('status', $event)"
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="submitted">待审批</option>
          <option value="approved">已通过</option>
          <option value="rejected">已驳回</option>
          <option value="paid">已支付</option>
        </select>
        <label class="check">
          <input
            type="checkbox"
            :checked="ledger.filters.mine"
            @change="ledger.setFilters({ mine: ($event.target as HTMLInputElement).checked })"
          />
          <span>只看我的</span>
        </label>
        <label v-if="auth.isAdmin" class="check">
          <input
            type="checkbox"
            :checked="ledger.filters.pending"
            @change="ledger.setFilters({ pending: ($event.target as HTMLInputElement).checked })"
          />
          <span>待我审批</span>
        </label>
        <button class="wl-btn wl-btn--ghost" @click="resetFilters">
          <Icon name="refresh" :size="14" />
          <span>重置筛选</span>
        </button>
      </div>
    </header>

    <!-- ---------------------------------------------------------- 主体 -->
    <div class="body">
      <main class="main">
        <div class="main__scroll wl-scroll">
          <!-- ==================================================== 活动列表 -->
          <template v-if="view === 'events'">
            <div class="evhead">
              <div>
                <h2 class="evhead__title">按活动看账</h2>
                <p class="wl-hint">
                  一次比赛或一场活动下的收支归到一起：成员随手记、传凭证，管理员随时看汇总。
                </p>
              </div>
              <button class="wl-btn wl-btn--primary" @click="openEventEditor()">
                <Icon name="plus" :size="15" /><span>新建活动</span>
              </button>
            </div>

            <div v-if="ledger.events.length === 0" class="wl-empty">
              <Icon name="chart" :size="36" />
              <p class="empty__title">还没有活动</p>
              <p class="empty__hint">建一个活动（比如「秋季赛」），之后记的账就能挂到它下面。</p>
            </div>

            <ul v-else class="evcards">
              <li
                v-for="ev in ledger.events"
                :key="ev.id"
                class="evcard"
                :class="{ 'evcard--closed': ev.status === 'closed' }"
                @click="openEvent(ev.id)"
              >
                <div class="evcard__top">
                  <span class="evcard__kind">{{ EVENT_KIND_LABELS[ev.kind] }}</span>
                  <span
                    class="evcard__status tag"
                    :class="ev.status === 'closed' ? 'tag--muted' : 'tag--ok'"
                  >
                    {{ ev.status === 'closed' ? '已封账' : '进行中' }}
                  </span>
                </div>
                <h3 class="evcard__name">{{ ev.name }}</h3>
                <div class="evcard__meta">
                  <span class="evcard__dates">
                    <Icon name="clock" :size="12" />
                    {{ dateRangeText(ev) }}
                  </span>
                  <span>{{ ev.entryCount }} 笔</span>
                </div>
                <div class="evcard__bar" :title="`支出占比 ${spendPercent(ev)}%`">
                  <span class="evcard__bar-in" :style="{ width: `${spendPercent(ev)}%` }" />
                </div>
                <div class="evcard__money">
                  <div class="evcard__m">
                    <span class="evcard__m-label">收入</span>
                    <span class="evcard__m-num tone-success">¥{{ ev.income }}</span>
                  </div>
                  <div class="evcard__m">
                    <span class="evcard__m-label">支出</span>
                    <span class="evcard__m-num tone-danger">¥{{ ev.expense }}</span>
                  </div>
                  <div class="evcard__m">
                    <span class="evcard__m-label">结余</span>
                    <span
                      class="evcard__m-num"
                      :class="ev.balanceCents >= 0 ? 'tone-success' : 'tone-danger'"
                    >
                      ¥{{ ev.balance }}
                    </span>
                  </div>
                </div>
              </li>
            </ul>
          </template>

          <!-- ==================================================== 活动汇总 -->
          <template v-else-if="view === 'event'">
            <div v-if="!evS" class="state"><span class="wl-spinner" /><span>正在汇总…</span></div>

            <template v-else>
              <div class="evtotals">
                <div class="evtotal evtotal--income">
                  <span class="evtotal__label">收入</span>
                  <span class="evtotal__num tone-success">¥{{ evS.income }}</span>
                </div>
                <div class="evtotal evtotal--expense">
                  <span class="evtotal__label">支出</span>
                  <span class="evtotal__num tone-danger">¥{{ evS.expense }}</span>
                </div>
                <div class="evtotal" :class="evS.balanceCents >= 0 ? 'evtotal--ok' : 'evtotal--bad'">
                  <span class="evtotal__label">结余</span>
                  <span class="evtotal__num">¥{{ evS.balance }}</span>
                </div>
                <div class="evtotal evtotal--count">
                  <span class="evtotal__label">已通过笔数</span>
                  <span class="evtotal__num">{{ evS.entryCount }}</span>
                </div>
              </div>

              <p class="wl-hint evnote">
                上面的合计**只算已通过 / 已支付的账目** —— 草稿和待审批不进报表，
                否则数字会随人随手记草稿而变。下面的逐笔明细则把所有状态都列出来。
              </p>

              <div class="evactions">
                <button
                  class="wl-btn wl-btn--primary"
                  :disabled="evS.event.status === 'closed'"
                  @click="openCreate()"
                >
                  <Icon name="plus" :size="14" /><span>记一笔到本活动</span>
                </button>
                <a class="wl-btn link-btn" :href="eventExportHref" download>
                  <Icon name="download" :size="14" /><span>导出明细 CSV</span>
                </a>
                <button v-if="canManageEvent" class="wl-btn" @click="openEventEditor(evS.event)">
                  <Icon name="settings" :size="14" /><span>编辑活动</span>
                </button>
                <button
                  v-if="canManageEvent"
                  class="wl-btn"
                  :class="evS.event.status === 'closed' ? '' : 'wl-btn--danger'"
                  @click="toggleEventClosed()"
                >
                  {{ evS.event.status === 'closed' ? '解封' : '封账' }}
                </button>
              </div>
              <p v-if="evS.event.status === 'closed'" class="wl-hint evnote">
                这个活动已封账：不能再往里记新账、也不能改已有账目。
                「标记已支付」和「标记分摊已还清」仍然可以 —— 那是收付款动作，不是记账动作。
              </p>

              <h3 class="evsec">按分类</h3>
              <table class="evtable">
                <thead>
                  <tr>
                    <th>分类</th>
                    <th>类型</th>
                    <th class="num">金额</th>
                    <th class="num">笔数</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in evS.byCategory" :key="c.categoryId ?? 'none'">
                    <td>{{ c.name }}</td>
                    <td>{{ c.kind === 'income' ? '收入' : '支出' }}</td>
                    <td class="num" :class="c.kind === 'income' ? 'tone-success' : 'tone-danger'">
                      ¥{{ c.total }}
                    </td>
                    <td class="num">{{ c.count }}</td>
                  </tr>
                  <tr v-if="evS.byCategory.length === 0">
                    <td colspan="4" class="wl-hint">还没有账目</td>
                  </tr>
                </tbody>
              </table>

              <h3 class="evsec">按人（垫付 / 应分摊 / 还欠）</h3>
              <table class="evtable">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th class="num">垫付</th>
                    <th class="num">应分摊</th>
                    <th class="num">还欠</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="person in evS.byPerson" :key="person.userId">
                    <td>{{ person.userName }}</td>
                    <td class="num">¥{{ person.paid }}</td>
                    <td class="num">¥{{ person.share }}</td>
                    <td class="num" :class="person.owedCents > 0 ? 'tone-danger' : 'tone-success'">
                      ¥{{ person.owed }}
                    </td>
                  </tr>
                  <tr v-if="evS.byPerson.length === 0">
                    <td colspan="4" class="wl-hint">没有分摊信息（这期活动可能都是整笔收支）</td>
                  </tr>
                </tbody>
              </table>

              <h3 class="evsec">逐笔明细</h3>
              <table class="evtable">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>事由</th>
                    <th>分类</th>
                    <th>经手人</th>
                    <th>状态</th>
                    <th class="num">金额</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in evS.entries"
                    :key="row.id"
                    :class="{ 'evtable__row--pending': row.status === 'draft' || row.status === 'submitted' }"
                  >
                    <td>{{ row.occurredOn }}</td>
                    <td>
                      {{ row.title }}
                      <span
                        v-if="row.attachments.length > 0"
                        class="evtable__clip"
                        :title="row.attachments.length + ' 个凭证'"
                      >
                        <Icon name="share" :size="12" />
                      </span>
                    </td>
                    <td>{{ row.categoryName ?? '—' }}</td>
                    <td>{{ row.creatorName }}</td>
                    <td><span class="tag">{{ STATUS_LABEL[row.status] }}</span></td>
                    <td class="num" :class="row.kind === 'income' ? 'tone-success' : 'tone-danger'">
                      {{ row.kind === 'income' ? '+' : '-' }}¥{{ row.amount }}
                    </td>
                  </tr>
                  <tr v-if="evS.entries.length === 0">
                    <td colspan="6" class="wl-hint">还没有账目</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </template>

          <!-- ==================================================== 账目流水 -->
          <template v-else>
          <div v-if="ledger.loading && ledger.entries.length === 0" class="state">
            <span class="wl-spinner" />
            <span>正在加载账目…</span>
          </div>

          <div v-else-if="ledger.error" class="state state--error">
            <Icon name="alert" :size="16" />
            <span class="state__text selectable">{{ ledger.error }}</span>
            <button class="wl-btn" @click="ledger.reload()">重试</button>
          </div>

          <div v-else-if="ledger.entries.length === 0" class="wl-empty">
            <Icon name="chart" :size="36" />
            <p class="empty__title">没有符合条件的账目</p>
            <p class="empty__hint">调整筛选条件，或点右上角「记一笔」新建一条。</p>
          </div>

          <ul v-else class="entries">
            <li
              v-for="entry in ledger.entries"
              :key="entry.id"
              class="entry"
              :class="{ 'entry--active': entry.id === selectedId }"
              @click="selectedId = entry.id"
            >
              <div class="entry__lead">
                <span class="entry__date">{{ entry.occurredOn }}</span>
                <Icon
                  :name="kindIcon(entry.kind)"
                  :size="15"
                  :class="kindToneClass(entry.kind)"
                  class="entry__kind"
                />
              </div>

              <div class="entry__main">
                <div class="entry__line">
                  <span class="entry__title">{{ entry.title }}</span>
                  <span v-if="entry.categoryName" class="wl-badge entry__cat">
                    <Icon v-if="entry.categoryIcon" :name="entry.categoryIcon" :size="12" />
                    <span>{{ entry.categoryName }}</span>
                  </span>
                  <span class="wl-badge" :class="STATUS_BADGE[entry.status]">
                    {{ STATUS_LABEL[entry.status] }}
                  </span>
                </div>
                <div class="entry__meta">
                  <span class="entry__creator">{{ entry.creatorName }}</span>
                  <span
                    v-if="entry.attachments.length > 0"
                    class="entry__attach"
                    :title="`${entry.attachments.length} 个附件`"
                  >
                    <Icon name="share" :size="13" />
                  </span>
                  <span v-if="entry.splits.length > 0" class="wl-badge entry__split">
                    分摊 {{ entry.splits.length }} 人
                  </span>
                </div>
              </div>

              <div class="entry__amount" :class="kindToneClass(entry.kind)">
                <span v-if="busy === entry.id" class="wl-spinner" />
                <span v-else>{{ entry.kind === 'expense' ? '-' : '+' }}¥{{ entry.amount }}</span>
              </div>

              <div v-if="actionsFor(entry).length > 0" class="entry__actions" @click.stop>
                <button
                  v-for="a in actionsFor(entry)"
                  :key="a.key"
                  class="wl-btn entry__action"
                  :class="{ 'wl-btn--primary': a.primary, 'wl-btn--danger': a.danger }"
                  :disabled="a.disabled || busy !== null"
                  :title="a.title"
                  @click="runAction(entry, a.key)"
                >
                  <Icon :name="a.icon" :size="13" />
                  <span>{{ a.label }}</span>
                </button>
              </div>
            </li>
          </ul>
          </template>
        </div>

        <footer v-if="view === 'entries'" class="main__foot">
          <div class="totals">
            <span class="totals__exp">支出 ¥{{ formatCents(ledger.totalExpenseCents) }}</span>
            <span class="totals__inc">收入 ¥{{ formatCents(ledger.totalIncomeCents) }}</span>
          </div>
          <span class="main__footmeta">
            <span v-if="ledger.total > ledger.entries.length" class="main__limit">
              仅显示最近 100 条，请用筛选缩小范围
            </span>
            <span class="main__count">共 {{ ledger.total }} 笔</span>
          </span>
        </footer>
      </main>

      <aside v-if="!narrow" class="stats">
        <LedgerSummary :summary="ledger.summary" :debts="ledger.debts" :loading="ledger.loading" />
      </aside>
    </div>

    <!-- ---------------------------------------------------------- 窄窗口统计抽屉 -->
    <div v-if="narrow && drawerOpen" class="overlay overlay--right" @click.self="drawerOpen = false">
      <aside class="stats stats--drawer">
        <LedgerSummary :summary="ledger.summary" :debts="ledger.debts" :loading="ledger.loading" />
      </aside>
    </div>

    <!-- ---------------------------------------------------------- 详情面板 -->
    <div v-if="selected" class="overlay overlay--right" @click.self="selectedId = null">
      <aside class="panel">
        <header class="panel__head">
          <div class="panel__headmain">
            <Icon :name="kindIcon(selected.kind)" :size="16" :class="kindToneClass(selected.kind)" />
            <span class="panel__title">{{ selected.title }}</span>
          </div>
          <button class="wl-icon-btn" title="关闭" @click="selectedId = null">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="panel__body wl-scroll">
          <div class="detail__amount" :class="kindToneClass(selected.kind)">
            {{ selected.kind === 'expense' ? '-' : '+' }}¥{{ selected.amount }}
          </div>
          <span class="wl-badge" :class="STATUS_BADGE[selected.status]">
            {{ STATUS_LABEL[selected.status] }}
          </span>

          <dl class="fields">
            <div class="fields__row"><dt>业务日期</dt><dd>{{ selected.occurredOn }}</dd></div>
            <div class="fields__row"><dt>类型</dt><dd>{{ KIND_LABEL[selected.kind] }}</dd></div>
            <div class="fields__row"><dt>分类</dt><dd>{{ selected.categoryName || '未分类' }}</dd></div>
            <div class="fields__row"><dt>提交人</dt><dd>{{ selected.creatorName }}</dd></div>
            <div v-if="selected.note" class="fields__row">
              <dt>备注</dt>
              <dd class="selectable">{{ selected.note }}</dd>
            </div>
          </dl>

          <section class="sect">
            <h4 class="sect__title">状态流转</h4>
            <ol class="tl">
              <li v-for="node in timeline" :key="node.key" class="tl__item">
                <span class="tl__icon" :class="node.tone ? `tl__icon--${node.tone}` : ''">
                  <Icon :name="node.icon" :size="14" />
                </span>
                <div class="tl__main">
                  <div class="tl__label">{{ node.label }}</div>
                  <div class="tl__meta">
                    <template v-if="node.time">
                      <span>{{ node.time }}</span>
                      <span v-if="node.who"> · {{ node.who }}</span>
                    </template>
                    <span v-else class="tl__pending">—</span>
                  </div>
                  <div v-if="node.note" class="tl__note selectable">理由：{{ node.note }}</div>
                </div>
              </li>
            </ol>
          </section>

          <section v-if="selected.attachments.length > 0" class="sect">
            <h4 class="sect__title">凭证附件（{{ selected.attachments.length }}）</h4>
            <ul class="atts">
              <li v-for="att in selected.attachments" :key="att.nodeId" class="att">
                <Icon name="file" :size="15" />
                <span class="att__name selectable">{{ att.name }}</span>
                <span class="att__size">{{ formatBytes(att.size) }}</span>
                <a
                  class="wl-btn link-btn att__dl"
                  :href="api.downloadUrl(att.nodeId)"
                  download
                  title="下载"
                >
                  <Icon name="download" :size="14" />
                </a>
              </li>
            </ul>
          </section>

          <section v-if="selected.splits.length > 0" class="sect">
            <h4 class="sect__title">分摊（{{ selected.splits.length }} 人）</h4>
            <ul class="splits">
              <li v-for="sp in selected.splits" :key="sp.id" class="split-item">
                <span class="split-item__who">
                  <Icon
                    :name="sp.settled ? 'check' : 'clock'"
                    :size="14"
                    :class="sp.settled ? 'tone-success' : 'tone-muted'"
                  />
                  <span>{{ sp.userName }}</span>
                </span>
                <span class="split-item__amt">¥{{ sp.amount }}</span>
                <span class="split-item__state">{{ sp.settled ? '已结清' : '未结清' }}</span>
                <button
                  v-if="canSettle(sp)"
                  class="wl-btn split-item__btn"
                  :disabled="busy !== null"
                  @click="toggleSettle(selected, sp)"
                >
                  {{ sp.settled ? '标记未结清' : '标记已结清' }}
                </button>
              </li>
            </ul>
          </section>

          <section v-if="actions.length > 0" class="sect">
            <h4 class="sect__title">操作</h4>
            <div class="panel__actions">
              <button
                v-for="a in actions"
                :key="a.key"
                class="wl-btn"
                :class="{ 'wl-btn--primary': a.primary, 'wl-btn--danger': a.danger }"
                :disabled="a.disabled || busy !== null"
                :title="a.title"
                @click="runAction(selected, a.key)"
              >
                <Icon :name="a.icon" :size="14" />
                <span>{{ a.label }}</span>
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>

    <!-- ---------------------------------------------------------- 新建 / 编辑 -->
    <div v-if="editorOpen" class="overlay" @click.self="closeEditor">
      <div class="modal wl-card" role="dialog" aria-modal="true">
        <header class="modal__head">
          <span class="modal__title">{{ form.id ? '编辑账目' : '记一笔' }}</span>
          <button class="wl-icon-btn" title="关闭" @click="closeEditor">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="modal__body wl-scroll">
          <div class="wl-field">
            <span class="wl-label">类型</span>
            <div class="seg">
              <button
                class="seg__btn"
                :class="{ 'seg__btn--active': form.kind === 'income' }"
                @click="form.kind = 'income'"
              >
                收入
              </button>
              <button
                class="seg__btn"
                :class="{ 'seg__btn--active': form.kind === 'expense' }"
                @click="form.kind = 'expense'"
              >
                支出
              </button>
            </div>
          </div>

          <div class="wl-field">
            <span class="wl-label">金额（元）</span>
            <input
              v-model="form.amount"
              class="wl-input amount-input"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
            />
            <p class="wl-hint">直接填写金额，最多两位小数，例如 12.50。</p>
          </div>

          <div class="wl-field">
            <span class="wl-label">业务日期</span>
            <input v-model="form.occurredOn" class="wl-input" type="date" />
            <p class="wl-hint">钱实际花出去或收到的日期，可以不是今天。</p>
          </div>

          <div class="wl-field">
            <span class="wl-label">分类</span>
            <select v-model="form.categoryId" class="wl-select">
              <option :value="null">未分类</option>
              <option v-for="c in editorCategoryOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>

          <div class="wl-field">
            <span class="wl-label">归属活动</span>
            <select v-model="form.eventId" class="wl-select">
              <option value="">不归属任何活动（日常账目）</option>
              <option v-for="ev in ledger.events" :key="ev.id" :value="ev.id">
                {{ ev.name }}{{ ev.status === 'closed' ? '（已封账）' : '' }}
              </option>
            </select>
            <p class="wl-hint">
              挂到某个比赛或活动下面，之后就能一键汇总那期的收支明细。
            </p>
          </div>

          <div class="wl-field">
            <span class="wl-label">事由</span>
            <input
              v-model="form.title"
              class="wl-input"
              type="text"
              maxlength="100"
              placeholder="这笔钱的用途"
            />
          </div>

          <div class="wl-field">
            <span class="wl-label">备注（可选）</span>
            <textarea v-model="form.note" class="wl-textarea" placeholder="补充说明" />
          </div>

          <div class="wl-field">
            <span class="wl-label">凭证附件</span>
            <div class="attach">
              <button class="wl-btn" @click="openPicker">
                <Icon name="upload" :size="14" />
                <span>选择文件</span>
              </button>
              <span class="wl-hint">只从文件库选择；需要新上传请到「文件」应用。</span>
            </div>
            <ul v-if="form.attachments.length > 0" class="chips">
              <li v-for="a in form.attachments" :key="a.nodeId" class="chip">
                <Icon name="file" :size="13" />
                <span class="chip__name">{{ a.name }}</span>
                <span class="chip__size">{{ formatBytes(a.size) }}</span>
                <button class="wl-icon-btn chip__x" title="移除" @click="removeAttachment(a.nodeId)">
                  <Icon name="close" :size="13" />
                </button>
              </li>
            </ul>
          </div>

          <div v-if="form.kind === 'expense'" class="wl-field">
            <button class="split-toggle" @click="toggleSplit">
              <Icon :name="form.showSplit ? 'chevron-down' : 'chevron-right'" :size="15" />
              <span>分摊</span>
              <span v-if="!form.showSplit && form.splits.length > 0" class="wl-hint">
                已设置 {{ form.splits.filter((s) => s.checked).length }} 人
              </span>
            </button>

            <div v-if="form.showSplit" class="split">
              <div class="split__head">
                <span class="wl-hint">勾选参与分摊的成员并填写金额，合计需等于总额。</span>
                <button class="wl-btn" @click="splitEvenly">
                  <Icon name="split" :size="14" />
                  <span>均分</span>
                </button>
              </div>
              <div v-if="splitCandidates.length === 0" class="wl-hint">暂无成员可选。</div>
              <ul v-else class="split__list">
                <li v-for="row in form.splits" :key="row.userId" class="split__row">
                  <label class="check">
                    <input v-model="row.checked" type="checkbox" />
                    <span>{{ row.userName }}</span>
                  </label>
                  <input
                    v-model="row.amount"
                    class="wl-input split__amount"
                    type="text"
                    inputmode="decimal"
                    placeholder="0.00"
                    :disabled="!row.checked"
                  />
                </li>
              </ul>
              <div class="split__sum">
                合计 ¥{{ formatCents(splitDiff.sum) }}
                <span v-if="splitDiff.diff !== null && splitDiff.diff !== 0">
                  ，与总额相差 ¥{{ formatCents(Math.abs(splitDiff.diff)) }}
                </span>
              </div>
            </div>
          </div>

          <p v-if="formError" class="form-error">
            <Icon name="alert" :size="14" />
            <span class="selectable">{{ formError }}</span>
          </p>
        </div>

        <footer class="modal__foot">
          <div class="modal__footbtns">
            <button class="wl-btn" :disabled="saving" @click="closeEditor">取消</button>
            <button class="wl-btn wl-btn--primary" :disabled="saving" @click="saveForm">
              <span v-if="saving" class="wl-spinner" />
              <span>{{ form.id ? '保存' : '创建' }}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>

    <!-- ---------------------------------------------------------- 活动编辑 -->
    <div v-if="eventEditorOpen" class="overlay" @click.self="eventEditorOpen = false">
      <div class="modal wl-card" role="dialog" aria-modal="true">
        <header class="modal__head">
          <span class="modal__title">{{ eventForm.id ? '编辑活动' : '新建活动' }}</span>
          <button class="wl-icon-btn" title="关闭" @click="eventEditorOpen = false">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="modal__body wl-scroll">
          <div class="wl-field">
            <span class="wl-label">名称</span>
            <input
              v-model="eventForm.name"
              class="wl-input"
              placeholder="比如：秋季赛 / 迎新活动"
              maxlength="60"
            />
            <p class="wl-hint">这个名字会出现在记账表单的「归属活动」下拉里。</p>
          </div>

          <div class="wl-field">
            <span class="wl-label">类型</span>
            <div class="seg">
              <button
                v-for="opt in EVENT_KIND_OPTIONS"
                :key="opt.key"
                class="seg__btn"
                :class="{ 'seg__btn--active': eventForm.kind === opt.key }"
                @click="eventForm.kind = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <div class="wl-field">
            <span class="wl-label">开始日期</span>
            <input v-model="eventForm.startOn" class="wl-input" type="date" />
          </div>

          <div class="wl-field">
            <span class="wl-label">结束日期（可留空）</span>
            <input v-model="eventForm.endOn" class="wl-input" type="date" />
            <p class="wl-hint">日期只是给人看的标记，不参与任何计算 —— 不会自动按日期截止记账。</p>
          </div>

          <div class="wl-field">
            <span class="wl-label">备注</span>
            <textarea v-model="eventForm.note" class="wl-textarea" rows="2" placeholder="可留空" />
          </div>

          <p v-if="eventFormError" class="form-error">
            <Icon name="alert" :size="14" />
            <span class="selectable">{{ eventFormError }}</span>
          </p>
        </div>

        <footer class="modal__foot">
          <div class="modal__footbtns">
            <button class="wl-btn" @click="eventEditorOpen = false">取消</button>
            <button class="wl-btn wl-btn--primary" @click="submitEventForm">
              {{ eventForm.id ? '保存' : '创建' }}
            </button>
          </div>
        </footer>
      </div>
    </div>

    <!-- ---------------------------------------------------------- 凭证文件浏览 -->
    <div v-if="picker.open" class="overlay" @click.self="closePicker">
      <div class="modal wl-card modal--picker" role="dialog" aria-modal="true">
        <header class="modal__head">
          <span class="modal__title">选择凭证文件</span>
          <button class="wl-icon-btn" title="关闭" @click="closePicker">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="picker__bar">
          <button class="wl-icon-btn" title="上一级" @click="pickerUp">
            <Icon name="chevron-left" :size="16" />
          </button>
          <nav class="picker__crumb">
            <button class="picker__crumb-item" @click="loadPicker(null)">
              <Icon name="home" :size="13" />
              <span>共享空间</span>
            </button>
            <template v-for="crumb in picker.breadcrumb" :key="crumb.id">
              <Icon name="chevron-right" :size="12" class="picker__crumb-sep" />
              <button class="picker__crumb-item" @click="loadPicker(crumb.id)">
                {{ crumb.name }}
              </button>
            </template>
          </nav>
        </div>

        <div class="picker__body wl-scroll">
          <div v-if="picker.loading" class="state">
            <span class="wl-spinner" />
            <span>加载中…</span>
          </div>
          <p v-else-if="picker.error" class="form-error">
            <Icon name="alert" :size="14" />
            <span class="selectable">{{ picker.error }}</span>
          </p>
          <div v-else-if="picker.entries.length === 0" class="wl-empty">此目录为空</div>
          <ul v-else class="picker__list">
            <li
              v-for="item in picker.entries"
              :key="item.id"
              class="picker__item"
              :class="{ 'picker__item--picked': pickerIsPicked(item.id) }"
              @click="item.kind === 'folder' ? pickerEnter(item) : pickerToggle(item)"
            >
              <Icon :name="item.kind === 'folder' ? 'folder' : 'file'" :size="16" />
              <span class="picker__name">{{ item.name }}</span>
              <span v-if="item.kind === 'file'" class="picker__size">{{ formatBytes(item.size) }}</span>
              <Icon v-if="pickerIsPicked(item.id)" name="check" :size="15" class="tone-accent" />
            </li>
          </ul>
        </div>

        <footer class="modal__foot">
          <span class="wl-hint">已选 {{ picker.picked.length }} 个文件</span>
          <div class="modal__footbtns">
            <button class="wl-btn" @click="openFilesApp">
              <Icon name="folder-open" :size="14" />
              <span>去文件应用</span>
            </button>
            <button class="wl-btn" @click="closePicker">取消</button>
            <button
              class="wl-btn wl-btn--primary"
              :disabled="picker.picked.length === 0"
              @click="pickerConfirm"
            >
              添加
            </button>
          </div>
        </footer>
      </div>
    </div>

    <!-- ---------------------------------------------------------- 驳回理由 -->
    <div v-if="rejectTarget" class="overlay" @click.self="rejectTarget = null">
      <div class="modal wl-card modal--sm" role="dialog" aria-modal="true">
        <header class="modal__head">
          <span class="modal__title">驳回账目</span>
          <button class="wl-icon-btn" title="关闭" @click="rejectTarget = null">
            <Icon name="close" :size="16" />
          </button>
        </header>
        <div class="modal__body">
          <p class="confirm__detail">驳回「{{ rejectTarget.title }}」，可填写驳回理由（可留空）。</p>
          <textarea v-model="rejectNote" class="wl-textarea" placeholder="驳回理由（可选）" />
        </div>
        <footer class="modal__foot">
          <div class="modal__footbtns">
            <button class="wl-btn" :disabled="busy !== null" @click="rejectTarget = null">取消</button>
            <button class="wl-btn wl-btn--danger" :disabled="busy !== null" @click="confirmReject">
              <span v-if="busy !== null" class="wl-spinner" />
              <span>确认驳回</span>
            </button>
          </div>
        </footer>
      </div>
    </div>

    <!-- ---------------------------------------------------------- 通用确认 -->
    <div v-if="confirmState" class="overlay" @click.self="confirmState = null">
      <div class="modal wl-card modal--sm" role="dialog" aria-modal="true">
        <header class="modal__head">
          <span class="modal__title">{{ confirmState.title }}</span>
        </header>
        <div class="modal__body">
          <p class="confirm__detail">{{ confirmState.detail }}</p>
        </div>
        <footer class="modal__foot">
          <div class="modal__footbtns">
            <button class="wl-btn" @click="confirmState = null">取消</button>
            <button
              class="wl-btn"
              :class="confirmState.danger ? 'wl-btn--danger' : 'wl-btn--primary'"
              @click="confirmState.onConfirm()"
            >
              确定
            </button>
          </div>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ledger {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
}

/* ---------------------------------------------------------------- 工具栏 */

.toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-2);
}

.toolbar__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.toolbar__heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-secondary);
}

.toolbar__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.toolbar__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-tertiary);
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.toolbar__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.filter {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.filter__label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.filter__date {
  width: 148px;
}

.filter__select {
  width: auto;
  min-width: 104px;
}

/* 搜索框：一个自包含的胶囊，不套用 .wl-input 的边框，避免双层描边 */
.filter--search {
  gap: 6px;
  min-width: 200px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-1);
  color: var(--text-tertiary);
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

.filter--search:focus-within {
  border-color: var(--accent);
  color: var(--accent);
}

.filter__search {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}

.filter__search::placeholder {
  color: var(--text-tertiary);
}

.filter__search::-webkit-search-cancel-button {
  cursor: pointer;
}

/* 快捷时间范围 */
.rchips {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}

.rchip {
  height: 22px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

.rchip:hover {
  color: var(--text);
  background: var(--hover);
}

.rchip--on {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-weight: 600;
}

.filtersep {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--line);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
}

.check input {
  accent-color: var(--accent);
}

.link-btn {
  text-decoration: none;
}

/* ---------------------------------------------------------------- 主体 */

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.main__scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--text-tertiary);
}

.state--error {
  color: var(--danger);
}

.state__text {
  flex: 0 1 auto;
  max-width: 520px;
  line-height: 1.45;
}

.empty__title {
  margin: var(--space-2) 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty__hint {
  margin: 0;
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 账目列表 */

.entries {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.entry {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.entry:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.entry--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.entry__lead {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.entry__date {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.entry__kind {
  flex: none;
}

.entry__main {
  min-width: 0;
}

.entry__line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.entry__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.entry__cat {
  gap: var(--space-1);
  flex: none;
}

.entry__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.entry__attach {
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
}

.entry__split {
  color: var(--text-tertiary);
}

.entry__amount {
  flex: none;
  min-width: 88px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 13.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.entry__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}

.entry__action {
  height: 26px;
  padding: 0 var(--space-2);
  font-size: 12px;
}

/* ---------------------------------------------------------------- 列表底部 */

.main__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-2);
  font-size: 12.5px;
}

.totals {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.totals__exp {
  color: var(--danger);
}

.totals__inc {
  color: var(--success);
}

.main__footmeta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.main__limit {
  color: var(--warning);
}

.main__count {
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 统计面板 */

.stats {
  flex: none;
  width: 320px;
  min-height: 0;
  overflow: auto;
  border-left: 1px solid var(--border-subtle);
  background: var(--surface-1);
}

.stats--drawer {
  width: 340px;
  max-width: 88%;
  height: 100%;
  box-shadow: var(--shadow-popup);
}

/* ---------------------------------------------------------------- 遮罩与面板 */

.overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--surface-solid) 66%, transparent);
}

.overlay--right {
  justify-content: flex-end;
  padding: 0;
}

.panel {
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: 92%;
  height: 100%;
  background: var(--surface-solid);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-popup);
}

.panel__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.panel__headmain {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.panel__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}

.panel__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}

.panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.detail__amount {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.fields {
  width: 100%;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.fields__row {
  display: flex;
  gap: var(--space-3);
}

.fields__row dt {
  flex: none;
  width: 72px;
  color: var(--text-tertiary);
  font-size: 12.5px;
}

.fields__row dd {
  margin: 0;
  min-width: 0;
  color: var(--text);
  word-break: break-word;
}

.sect {
  width: 100%;
}

.sect__title {
  margin: 0 0 var(--space-2);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* 时间线 */
.tl {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tl__item {
  display: flex;
  gap: var(--space-2);
}

.tl__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--text-tertiary);
}

.tl__icon--success {
  color: var(--success);
}

.tl__icon--danger {
  color: var(--danger);
}

.tl__icon--accent {
  color: var(--accent);
}

.tl__main {
  min-width: 0;
  padding-top: 2px;
}

.tl__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.tl__meta {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.tl__pending {
  color: var(--text-disabled);
}

.tl__note {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
}

/* 附件 */
.atts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.att {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.att__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.att__size {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.att__dl {
  flex: none;
  height: 24px;
  padding: 0 var(--space-2);
}

/* 分摊明细 */
.splits {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.split-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.split-item__who {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.split-item__amt {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}

.split-item__state {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.split-item__btn {
  height: 24px;
  padding: 0 var(--space-2);
  font-size: 11.5px;
}

/* ---------------------------------------------------------------- 模态 */

.modal {
  display: flex;
  flex-direction: column;
  width: 460px;
  max-width: 100%;
  max-height: 100%;
  background: var(--surface-solid);
  box-shadow: var(--shadow-popup);
}

.modal--sm {
  width: 380px;
}

.modal--picker {
  width: 560px;
  height: 520px;
  max-height: 100%;
}

.modal__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.modal__title {
  font-size: 14px;
  font-weight: 600;
}

.modal__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
}

.modal__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.modal__footbtns {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.confirm__detail {
  margin: 0 0 var(--space-3);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.form-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.45;
}

.amount-input {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* 分段控件 */
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
}

.seg__btn {
  height: 28px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
}

.seg__btn--active {
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}

/* 附件 */
.attach {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.attach .wl-hint {
  margin: 0;
}

.chips {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.chip__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 12.5px;
}

.chip__size {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.chip__x {
  width: 24px;
  height: 24px;
}

/* 分摊 */
.split-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: 13px;
}

.split-toggle .wl-hint {
  margin: 0;
}

.split {
  margin-top: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.split__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.split__head .wl-hint {
  margin: 0;
}

.split__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 220px;
  overflow: auto;
}

.split__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.split__row .check {
  flex: 1;
  min-width: 0;
}

.split__amount {
  flex: none;
  width: 110px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.split__sum {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
  font-size: 12.5px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* 文件浏览 */
.picker__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.picker__crumb {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  flex-wrap: nowrap;
}

.picker__crumb-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12.5px;
  white-space: nowrap;
}

.picker__crumb-item:hover {
  background: var(--hover);
  color: var(--text);
}

.picker__crumb-sep {
  color: var(--text-tertiary);
  flex: none;
}

.picker__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-2);
}

.picker__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.picker__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.picker__item:hover {
  background: var(--hover);
}

.picker__item--picked {
  background: var(--selected);
  color: var(--text);
}

.picker__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.picker__size {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 语义色 */

.tone-success {
  color: var(--success);
}

.tone-danger {
  color: var(--danger);
}

.tone-accent {
  color: var(--accent);
}

.tone-muted {
  color: var(--text-tertiary);
}
/* ================================================================ 活动视图 */

.toolbar__views {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.seg--view .seg__btn {
  padding: 5px 14px;
}

.seg__count {
  margin-left: 6px;
  font-size: 10.5px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.toolbar__crumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

/* 行内可点的文字按钮（"← 所有活动"） */
.linklike {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font-size: inherit;
}

.linklike:hover {
  text-decoration: underline;
}

/* 通用小标签。活动卡片与汇总表里都用得到 */
.tag {
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  background: var(--surface-3);
  color: var(--fg-dim);
}

.tag--ok {
  background: color-mix(in srgb, var(--success, #3aa76d) 18%, transparent);
  color: var(--success, #3aa76d);
}

.tag--muted {
  opacity: 0.75;
}

/* ---------------------------------------------------------------- 活动列表 */

.evhead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.evhead__title {
  margin: 0 0 4px;
  font-size: 16px;
}

.evcards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 12px;
}

.evcard {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.evcard:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
}

.evcard--closed {
  opacity: 0.85;
}

.evcard__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.evcard__kind {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--surface-3);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  flex-shrink: 0;
}

.evcard__status {
  flex-shrink: 0;
}

.evcard__name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evcard__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.evcard__dates {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 收支构成条：底绿（收入）叠红（支出），红条宽度 = 支出占比 */
.evcard__bar {
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-3);
  background: color-mix(in srgb, var(--success, #3aa76d) 55%, transparent);
}

.evcard__bar-in {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--danger, #d94a4a);
  transition: width var(--dur-slow, 0.3s) var(--ease-out);
}

.evcard__money {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: auto;
}

.evcard__m {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.evcard__m-label {
  font-size: 10.5px;
  color: var(--fg-dim);
}

.evcard__m-num {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------------------------------------------------------- 活动汇总 */

.evtotals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.evtotal {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-top: 2px solid var(--line);
}

.evtotal--income,
.evtotal--ok {
  border-top-color: var(--success, #3aa76d);
}

.evtotal--expense,
.evtotal--bad {
  border-top-color: var(--danger, #d94a4a);
}

.evtotal--count {
  border-top-color: var(--fg-dim);
}

.evtotal__num {
  font-size: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}

.evtotal--ok .evtotal__num {
  color: var(--success, #3aa76d);
}

.evtotal--bad .evtotal__num {
  color: var(--danger, #d94a4a);
}

.evtotal--count .evtotal__num {
  color: var(--text-secondary);
}

.evtotal__label {
  font-size: 11px;
  color: var(--fg-dim);
  letter-spacing: 0.2px;
}

.evnote {
  margin: 0 0 10px;
  line-height: 1.6;
}

.evactions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.evsec {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

/* 小节标题左侧的短竖条：给三张表分出清楚的节奏 */
.evsec::before {
  content: '';
  width: 3px;
  height: 14px;
  border-radius: 999px;
  background: var(--accent);
}

.evtable {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  margin-bottom: 6px;
}

.evtable th {
  text-align: left;
  font-weight: 600;
  font-size: 11.5px;
  color: var(--fg-dim);
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.evtable td {
  padding: 8px;
  border-bottom: 1px solid var(--line-subtle, var(--line));
  vertical-align: top;
}

.evtable tbody tr:hover td {
  background: var(--hover);
}

.evtable .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 还没进报表的行（草稿 / 待审批）压暗一点 —— 让"合计数与逐笔行数不一样"
   这件事一眼看得出是为什么，而不是让人以为算错了 */
.evtable__row--pending {
  opacity: 0.6;
}

.evtable__clip {
  color: var(--text-tertiary);
  margin-left: 4px;
}

/* ================================================================
   整体 UI 升级（评审团定稿）· 降噪覆盖层
   ----------------------------------------------------------------
   记账是数据最密的页面：把"颜色噪声"换成"层次噪声"——
   分类/分摊降为纯文字，状态只在异常时着色；行操作默认隐身、
   悬浮/键盘聚焦才出现（触屏常显）；列表从"一行一卡"变成"一张卡多行"。
   ================================================================ */

.ledger .toolbar {
  background: var(--surface-1);
  border-bottom: 1px solid var(--line-hair);
  padding: var(--space-3) var(--space-4) var(--space-2);
  gap: var(--space-3);
}

.ledger .toolbar__title {
  font-size: 14px;
}

/* 视图分段：选中 = 白底卡片，不再整块实心蓝 */
.ledger .seg {
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
}

.ledger .seg__btn {
  height: 26px;
  padding: 0 var(--space-3);
  font-size: 12.5px;
  border-radius: 4px;
}

.ledger .seg__btn--active {
  background: var(--surface-1);
  color: var(--text);
  box-shadow: var(--shadow-card);
}

.ledger .seg__count {
  opacity: 0.55;
}

/* 筛选行：控件统一 32px，搜索框与其他控件同高同圆角 */
.ledger .filter--search {
  height: var(--ctl-h);
  border-radius: var(--radius-sm);
  min-width: 220px;
  flex: 1 1 220px;
  max-width: 340px;
}

.ledger .filter__search {
  font-size: var(--fs-body);
}

.ledger .rchips {
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
}

.ledger .rchip {
  height: 26px;
  border-radius: 3px;
  color: var(--text-secondary);
}

.ledger .rchip--on {
  background: var(--surface-1);
  color: var(--accent);
  box-shadow: var(--shadow-card);
}

.ledger .filtersep {
  background: var(--line-hair);
}

/* 列表：一张卡、行间发丝线、悬浮整行着色 */
.ledger .entries {
  gap: 0;
  background: var(--surface-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.ledger .entry {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: var(--space-2) var(--space-4);
  min-height: 54px;
}

.ledger .entries > .entry + .entry {
  border-top: 1px solid var(--line-hair);
}

.ledger .entry:hover {
  background: var(--surface-2);
}

.ledger .entry--active,
.ledger .entry--active:hover {
  background: var(--accent-soft);
}

/* 标签降噪：分类与分摊是辅助信息，纯文字；"已通过"这类默认状态不再着色 */
.ledger .entry__cat,
.ledger .entry__split {
  background: none;
  padding: 0;
  height: auto;
  font-weight: 500;
  color: var(--text-tertiary);
  gap: 4px;
}

.ledger .entry .wl-badge--accent {
  background: none;
  padding: 0;
  height: auto;
  font-weight: 500;
  color: var(--text-tertiary);
}

/* 行内操作：默认隐身，悬浮 / 键盘聚焦 / 已选中行才出现；触屏常显 */
.ledger .entry__action {
  height: 28px;
  padding: 0 10px;
  border-color: transparent;
  background: transparent;
  color: var(--text-tertiary);
  font-weight: 500;
}

.ledger .entry__action:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
  border-color: transparent;
}

/* 主操作（标记已支付）：软底强调，不再是一排实心蓝 */
.ledger .entry__action.wl-btn--primary {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: none;
}

.ledger .entry__action.wl-btn--primary:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-text);
}

.ledger .entry__action.wl-btn--danger {
  color: var(--danger);
  background: transparent;
}

.ledger .entry__action.wl-btn--danger:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}

@media (hover: hover) and (pointer: fine) {
  .ledger .entry__actions {
    opacity: 0;
    transition: opacity var(--dur) var(--ease-out);
  }

  .ledger .entry:hover .entry__actions,
  .ledger .entry:focus-within .entry__actions,
  .ledger .entry--active .entry__actions {
    opacity: 1;
  }
}

/* 底部汇总条与统计栏：发丝线，不再有灰带 */
.ledger .main__foot {
  background: transparent;
  border-top: 1px solid var(--line-hair);
  padding: var(--space-2) var(--space-4);
}

.ledger .stats {
  border-left: 1px solid var(--line-hair);
}

.ledger .main__scroll {
  padding: var(--space-4);
}

/* 活动视图的小标签：统一 4px 圆角软标签 */
.ledger .tag {
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}

</style>
