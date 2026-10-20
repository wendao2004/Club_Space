<!--
  财物管理。

  社团的家当有两件事最容易乱：**东西现在在谁手上**、**一共还有几件**。
  所以这个界面的第一屏就是回答这两个问题 —— 概览数字 + 带"可借/在外"角标的清单，
  而不是先让人翻表格。

  权限上刻意的取舍（与服务端一致）：
    - 谁都能看、谁都能借、谁都能还（"他先走了我帮他带回来"太常见了，
      强制本人操作只会让大家干脆不记账）
    - 只有管理员能登记、修改、退役物品
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import ModalShell from '@/components/ModalShell.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { api, type AssetCondition, type AssetItem, type AssetItemInput, type AssetLoan } from '@/api'
import { useAssets, type LoanFilter } from '@/stores/assets'
import { useAuth } from '@/stores/auth'
import { useTodos } from '@/stores/todos'

const assets = useAssets()
const auth = useAuth()
const todos = useTodos()

type Tab = 'items' | 'loans'
const tab = ref<Tab>('items')

/** 整数「分」格式化回 "12.50"。不经过浮点，也不会出现 0.30000000000000004。 */
function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '0.00'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  // 千分位：几千块的设备在看板上写成 12000.00 很难一眼读出来
  return `${sign}${whole.toLocaleString('zh-CN')}.${frac}`
}

const CONDITION_LABELS: Record<AssetCondition, string> = {
  good: '完好',
  fair: '有磨损',
  broken: '已损坏',
  lost: '已遗失',
}

function conditionClass(c: AssetCondition): string {
  if (c === 'good') return 'tag tag--ok'
  if (c === 'fair') return 'tag tag--warn'
  return 'tag tag--bad'
}

function formatDate(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------- 初始化

onMounted(() => {
  void assets.refresh()
  // 打开应用时刷新待办：角标与列表必须来自同一时刻的口径
  void todos.refresh()
  // 「代谁借」的下拉需要成员列表，单独拉一份
  void assets.loadMembers()
})

// ---------------------------------------------------------------- 详情

const detailOpen = computed(() => assets.detail !== null)

async function openItem(item: AssetItem): Promise<void> {
  await assets.openItem(item.id)
}

function closeDetail(): void {
  assets.closeDetail()
  cancelLend()
}

// ---------------------------------------------------------------- 借出

const lendOpen = ref(false)
/** 发起入口：物品详情（物品已定）还是借还记录页（要现场挑物品）。 */
const lendSource = ref<'detail' | 'list'>('detail')
const lendQty = ref('1')
const lendDue = ref('')
const lendPurpose = ref('')
/** 借用人。默认是自己 —— 绝大多数情况就是给自己借。 */
const lendBorrower = ref('')
const lendError = ref('')

// 从借还记录页发起时用：可借物品清单（只有 available>0 的在用物品）
const lendPickItems = ref<AssetItem[]>([])
const lendPickId = ref('')
const lendPickSearch = ref('')
const lendPickLoading = ref(false)

/** 这次借出对应哪件物品。 */
const lendItem = computed<AssetItem | null>(() => {
  if (lendSource.value === 'detail') return assets.detail?.item ?? null
  return lendPickItems.value.find((item) => item.id === lendPickId.value) ?? null
})

/** 物品选择器的搜索结果（台账通常不大，客户端过滤足够，还能少发请求）。 */
const lendPickChoices = computed(() => {
  const term = lendPickSearch.value.trim().toLowerCase()
  if (!term) return lendPickItems.value
  return lendPickItems.value.filter((item) =>
    [item.name, item.code ?? ''].some((text) => text.toLowerCase().includes(term)),
  )
})

function resetLendForm(): void {
  lendQty.value = '1'
  lendDue.value = defaultDue()
  lendPurpose.value = ''
  lendBorrower.value = auth.user?.id ?? ''
  lendError.value = ''
}

function startLend(): void {
  lendSource.value = 'detail'
  resetLendForm()
  lendOpen.value = true
}

async function loadLendItems(): Promise<void> {
  if (lendPickItems.value.length > 0) return
  lendPickLoading.value = true
  try {
    const { items } = await api.assets.items({ status: 'active', available: true })
    lendPickItems.value = items.filter((item) => item.availableQty > 0)
    if (!lendPickId.value && lendPickItems.value.length > 0) {
      lendPickId.value = lendPickItems.value[0]!.id
    }
  } catch (err) {
    lendError.value = err instanceof Error ? err.message : '加载可借物品失败'
  } finally {
    lendPickLoading.value = false
  }
}

/** 从借还记录页直接登记一笔借出 —— 不用先绕到物品台账里找那件东西。 */
async function startLendFromList(): Promise<void> {
  lendSource.value = 'list'
  resetLendForm()
  lendPickSearch.value = ''
  lendPickId.value = ''
  lendOpen.value = true
  await loadLendItems()
}

function cancelLend(): void {
  lendOpen.value = false
  lendError.value = ''
}

/** 默认应还日期：两周后。绝大多数借用都是"活动结束就还"，两周是个合理的默认值。 */
function defaultDue(): string {
  const d = new Date()
  d.setDate(d.getDate() + 14)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function submitLend(): Promise<void> {
  const item = lendItem.value
  if (!item) {
    lendError.value = '请先选择要借出的物品'
    return
  }
  const qty = Number.parseInt(lendQty.value, 10)
  if (!Number.isInteger(qty) || qty <= 0) {
    lendError.value = '借出数量必须是不小于 1 的整数'
    return
  }
  // 本地先拦一道，只是为了少一次往返；真正的判定在服务端事务里
  if (qty > item.availableQty) {
    lendError.value = `「${item.name}」现在只剩 ${item.availableQty} 件可借`
    return
  }
  const ok = await assets.lend({
    itemId: item.id,
    qty,
    // 借用人等于自己时不传，让服务端用它自己的身份 —— 少一个可被伪造的字段
    borrowerId: lendBorrower.value && lendBorrower.value !== auth.user?.id ? lendBorrower.value : undefined,
    dueOn: lendDue.value || undefined,
    purpose: lendPurpose.value || undefined,
  })
  if (ok) {
    cancelLend()
    // 列表页发起时，借完把数量缓存作废，下次打开会重新拉一份可借清单
    if (lendSource.value === 'list') lendPickItems.value = []
  }
}

// ---------------------------------------------------------------- 归还

const returnOpen = ref<AssetLoan | null>(null)
const returnCondition = ref<AssetCondition>('good')
const returnNote = ref('')

function startReturn(loan: AssetLoan): void {
  returnOpen.value = loan
  returnCondition.value = 'good'
  returnNote.value = ''
}

async function submitReturn(): Promise<void> {
  const loan = returnOpen.value
  if (!loan) return
  const ok = await assets.returnLoan(loan.id, {
    condition: returnCondition.value,
    note: returnNote.value || undefined,
  })
  if (ok) returnOpen.value = null
}

// ---------------------------------------------------------------- 更正 / 作废借还记录（管理员）

const loanEdit = ref<AssetLoan | null>(null)
const loanEditQty = ref('1')
const loanEditBorrower = ref('')
const loanEditDue = ref('')
const loanEditPurpose = ref('')
const loanEditError = ref('')

function startLoanEdit(loan: AssetLoan): void {
  loanEdit.value = loan
  loanEditQty.value = String(loan.qty)
  loanEditBorrower.value = loan.borrowerId
  loanEditDue.value = loan.dueOn ?? ''
  loanEditPurpose.value = loan.purpose ?? ''
  loanEditError.value = ''
}

function cancelLoanEdit(): void {
  loanEdit.value = null
  loanEditError.value = ''
}

async function submitLoanEdit(): Promise<void> {
  const loan = loanEdit.value
  if (!loan) return
  const qty = Number.parseInt(loanEditQty.value, 10)
  if (!Number.isInteger(qty) || qty <= 0) {
    loanEditError.value = '数量必须是不小于 1 的整数'
    return
  }
  const ok = await assets.updateLoan(loan.id, {
    qty,
    borrowerId: loanEditBorrower.value || undefined,
    dueOn: loanEditDue.value || null,
    purpose: loanEditPurpose.value || null,
  })
  if (ok) cancelLoanEdit()
}

async function voidLoan(loan: AssetLoan): Promise<void> {
  // 作废是账面动作，问一句再动手
  if (!window.confirm(`作废「${loan.borrowerName}」借出 ${loan.qty} 件的记录？作废后不再计入账面。`)) return
  await assets.voidLoan(loan.id)
}

async function restoreLoan(loan: AssetLoan): Promise<void> {
  if (!window.confirm(`恢复「${loan.borrowerName}」借出 ${loan.qty} 件的记录？恢复后重新计入账面。`)) return
  await assets.restoreLoan(loan.id)
}

// ---------------------------------------------------------------- 登记 / 编辑

const editOpen = ref(false)
const editId = ref<string | null>(null)
const editError = ref('')
const form = ref<AssetItemInput>({
  name: '',
  code: '',
  categoryId: null,
  totalQty: 1,
  value: '',
  purchasedOn: '',
  location: '',
  condition: 'good',
  note: '',
})

/**
 * 「脏」判定跟打开那一刻的快照比。
 *
 * 不能写成"有字段非空就算改过"：新建时数量默认 1、成色默认 good，
 * 那样一打开就脏，Esc 也会弹确认，保护就变成了骚扰。
 */
const editBaseline = ref('')
const editDirty = computed(() => JSON.stringify(form.value) !== editBaseline.value)
const editCloseConfirm = ref(false)
/** 提交中不允许关闭：请求已经发出，关掉只会让用户误以为取消了。 */
const editSaving = ref(false)

function openCreate(): void {
  editId.value = null
  editError.value = ''
  form.value = {
    name: '',
    code: '',
    categoryId: null,
    totalQty: 1,
    value: '',
    purchasedOn: '',
    location: '',
    condition: 'good',
    note: '',
  }
  editBaseline.value = JSON.stringify(form.value)
  editOpen.value = true
}

function openEdit(item: AssetItem): void {
  editId.value = item.id
  editError.value = ''
  form.value = {
    name: item.name,
    code: item.code ?? '',
    categoryId: item.categoryId,
    totalQty: item.totalQty,
    value: formatCents(item.valueCents),
    purchasedOn: item.purchasedOn ?? '',
    location: item.location ?? '',
    condition: item.condition,
    note: item.note ?? '',
  }
  editBaseline.value = JSON.stringify(form.value)
  editOpen.value = true
}

/** Esc / 点遮罩 / 点「取消」都走这里，见 ModalShell。 */
function requestCloseEdit(): void {
  if (!editOpen.value || editSaving.value) return
  if (editDirty.value) {
    editCloseConfirm.value = true
    return
  }
  editOpen.value = false
}

function discardEdit(): void {
  editCloseConfirm.value = false
  editOpen.value = false
}

async function submitForm(): Promise<void> {
  editError.value = ''
  if (!form.value.name.trim()) {
    editError.value = '物品名称不能为空'
    return
  }
  const qty = Number(form.value.totalQty)
  if (!Number.isInteger(qty) || qty < 0) {
    editError.value = '数量必须是非负整数'
    return
  }
  const payload: AssetItemInput = {
    name: form.value.name.trim(),
    code: form.value.code?.trim() || undefined,
    categoryId: form.value.categoryId || null,
    totalQty: qty,
    value: form.value.value ?? '',
    purchasedOn: form.value.purchasedOn || undefined,
    location: form.value.location?.trim() || undefined,
    condition: form.value.condition,
    note: form.value.note?.trim() || undefined,
  }
  editSaving.value = true
  try {
    const ok = editId.value
      ? await assets.updateItem(editId.value, payload)
      : await assets.createItem(payload)
    if (ok) editOpen.value = false
  } finally {
    editSaving.value = false
  }
}

// ---------------------------------------------------------------- 退役

async function toggleRetire(item: AssetItem): Promise<void> {
  const retiring = item.status === 'active'
  const verb = retiring ? '退役' : '恢复'
  if (!window.confirm(`确定要${verb}「${item.name}」吗？\n\n退役不会删除它的借还历史。`)) return
  await assets.retireItem(item.id, retiring)
}

// ---------------------------------------------------------------- 分类

const newCatName = ref('')
async function addCategory(): Promise<void> {
  const name = newCatName.value.trim()
  if (!name) return
  if (await assets.createCategory(name)) newCatName.value = ''
}

// ---------------------------------------------------------------- 筛选

let searchTimer: number | null = null
watch(
  () => assets.filters.q,
  () => {
    // 输入时防抖：每敲一个字就发一次请求，在 NAS 上是白白的负载
    if (searchTimer !== null) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => void assets.loadItems(), 250)
  },
)

watch(
  () => [assets.filters.categoryId, assets.filters.status, assets.filters.onlyAvailable, assets.filters.onlyOnLoan],
  () => void assets.loadItems(),
)

let loanSearchTimer: number | null = null
watch(
  () => assets.loanQ,
  () => {
    if (loanSearchTimer !== null) window.clearTimeout(loanSearchTimer)
    loanSearchTimer = window.setTimeout(() => void assets.loadLoans(), 250)
  },
)

// ---------------------------------------------------------------- 导出

/** 导出走浏览器下载（服务端已带 Content-Disposition），不做前端拼 CSV。 */
function download(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// ---------------------------------------------------------------- 展示辅助

const summary = computed(() => assets.summary)

/** 借还记录的筛选标签。 */
const LOAN_TABS: Array<{ key: LoanFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未归还' },
  { key: 'overdue', label: '已逾期' },
  { key: 'mine', label: '我借的' },
  { key: 'myOverdue', label: '我的逾期' },
  { key: 'myDueSoon', label: '即将到期' },
]

/**
 * 待办一键筛出。
 *
 * 角标上的数字由服务端按 `mine=1&overdue=1` / `mine=1&dueWithin=N` 算出来，
 * 这里点下去切到的就是同一组条件（见 stores/assets.ts 的 loadLoans）。
 * 绝不能在界面上另加日期/搜索条件 —— 那会让条数和角标对不上。
 */
function applyTodo(intent: 'overdue' | 'dueSoon'): void {
  tab.value = 'loans'
  assets.loanQ = ''
  assets.setLoanFilter(intent === 'overdue' ? 'myOverdue' : 'myDueSoon')
  void todos.refresh()
}

const editing = computed(() => editOpen.value)
</script>

<template>
  <div class="assets">
    <!-- ------------------------------------------------------------ 顶栏 -->
    <header class="assets__head">
      <div class="assets__tabs">
        <button class="tab" :class="{ 'tab--active': tab === 'items' }" @click="tab = 'items'">
          物品台账
        </button>
        <button class="tab" :class="{ 'tab--active': tab === 'loans' }" @click="tab = 'loans'">
          借还记录
        </button>
      </div>
      <div class="assets__head-actions">
        <button class="wl-btn wl-btn--ghost" @click="download(api.assets.itemsCsvUrl())">
          <Icon name="download" :size="14" /> 导出台账
        </button>
        <button v-if="auth.isAdmin" class="wl-btn wl-btn--primary" @click="openCreate">
          <Icon name="plus" :size="14" /> 登记物品
        </button>
      </div>
    </header>

    <!-- ------------------------------------------------------------ 我的待办 -->
    <!--
      只显示"等我处理的事"，数字来自 /api/todos，点下去切到同一个筛选条件。
      0 不显示 —— 不挂一个永远为 0 的提醒条。
    -->
    <div v-if="todos.data.assets.total > 0" class="assets__todo">
      <span class="assets__todo-label">我借的</span>
      <button
        v-if="todos.data.assets.overdue.count > 0"
        class="todopill todopill--bad"
        :title="`${todos.data.assets.overdue.count} 件东西已经过了应还日期还没还`"
        @click="applyTodo('overdue')"
      >
        已逾期
        <span class="todopill__n">{{ todos.data.assets.overdue.count > 99 ? '99+' : todos.data.assets.overdue.count }}</span>
      </button>
      <button
        v-if="todos.data.assets.dueSoon.count > 0"
        class="todopill"
        :title="`${todos.data.assets.dueSoon.count} 件东西将在 ${todos.dueSoonDays} 天内到期`"
        @click="applyTodo('dueSoon')"
      >
        {{ todos.dueSoonDays }} 天内到期
        <span class="todopill__n">{{ todos.data.assets.dueSoon.count > 99 ? '99+' : todos.data.assets.dueSoon.count }}</span>
      </button>
    </div>

    <!-- ------------------------------------------------------------ 逾期提醒 -->
    <div v-if="assets.overdue.length > 0" class="assets__alert">
      <strong>有 {{ assets.overdue.length }} 件东西已经逾期没还</strong>
      <span class="assets__alert-list">
        {{
          assets.overdue
            .slice(0, 4)
            .map((l) => `${l.itemName}（${l.borrowerName}，超 ${l.overdueDays} 天）`)
            .join('、')
        }}
        <template v-if="assets.overdue.length > 4">…等</template>
      </span>
    </div>

    <!-- ------------------------------------------------------------ 概览 -->
    <div v-if="summary" class="assets__stats">
      <div class="stat">
        <span class="stat__num">{{ summary.itemCount }}</span>
        <span class="stat__label">种物品</span>
      </div>
      <div class="stat">
        <span class="stat__num">{{ summary.totalQty }}</span>
        <span class="stat__label">总件数</span>
      </div>
      <div class="stat">
        <span class="stat__num stat__num--ok">{{ summary.availableQty }}</span>
        <span class="stat__label">可借</span>
      </div>
      <div class="stat">
        <span class="stat__num" :class="{ 'stat__num--warn': summary.onLoanQty > 0 }">
          {{ summary.onLoanQty }}
        </span>
        <span class="stat__label">在外</span>
      </div>
      <div class="stat">
        <span class="stat__num" :class="{ 'stat__num--bad': summary.overdueLoans > 0 }">
          {{ summary.overdueLoans }}
        </span>
        <span class="stat__label">逾期</span>
      </div>
      <div class="stat stat--wide">
        <span class="stat__num">¥{{ formatCents(summary.totalValueCents) }}</span>
        <span class="stat__label">台账价值</span>
      </div>
    </div>

    <!-- ------------------------------------------------------------ 物品台账 -->
    <template v-if="tab === 'items'">
      <div class="filters">
        <input v-model="assets.filters.q" class="wl-input filters__search" placeholder="搜名称 / 编号 / 存放位置" />
        <select v-model="assets.filters.categoryId" class="wl-select">
          <option value="">全部分类</option>
          <option v-for="c in assets.activeCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="assets.filters.status" class="wl-select">
          <option value="active">在用</option>
          <option value="retired">已退役</option>
        </select>
        <label class="filters__check">
          <input v-model="assets.filters.onlyAvailable" type="checkbox" /> 还有得借
        </label>
        <label class="filters__check">
          <input v-model="assets.filters.onlyOnLoan" type="checkbox" /> 外借中
        </label>
      </div>

      <div v-if="assets.loading && assets.items.length === 0" class="wl-empty">正在加载…</div>

      <div v-else-if="assets.items.length === 0" class="wl-empty">
        <p>{{ assets.filters.q || assets.filters.categoryId ? '没有符合条件的物品' : '台账还是空的' }}</p>
        <p v-if="auth.isAdmin" class="wl-hint">点右上角「登记物品」把社团的家当记进来。</p>
      </div>

      <div v-else class="items">
        <article
          v-for="item in assets.items"
          :key="item.id"
          class="item"
          :class="{ 'item--out': item.availableQty === 0 && item.totalQty > 0, 'item--retired': item.status === 'retired' }"
          @click="openItem(item)"
        >
          <div class="item__top">
            <h3 class="item__name">{{ item.name }}</h3>
            <span :class="conditionClass(item.condition)">{{ CONDITION_LABELS[item.condition] }}</span>
          </div>
          <div class="item__meta">
            <span v-if="item.categoryName">{{ item.categoryName }}</span>
            <span v-if="item.code" class="item__code">{{ item.code }}</span>
            <span v-if="item.location">{{ item.location }}</span>
          </div>
          <div class="item__qty">
            <!--
              这里刻意把「可借 / 总数」一起显示，而不是只写一个数字。
              只写"3"的话，人不知道那是总数还是还能借的 —— 而这个区别
              恰恰是社团最常搞错的地方。
            -->
            <span class="item__avail" :class="{ 'item__avail--zero': item.availableQty === 0 }">
              {{ item.availableQty }}
            </span>
            <span class="item__slash">/</span>
            <span class="item__total">{{ item.totalQty }}</span>
            <span class="item__qty-label">可借</span>
            <span v-if="item.onLoanQty > 0" class="item__loan-badge">{{ item.onLoanQty }} 件在外</span>
          </div>
        </article>
      </div>
    </template>

    <!-- ------------------------------------------------------------ 借还记录 -->
    <template v-else>
      <div class="filters">
        <div class="assets__tabs assets__tabs--sub">
          <button
            v-for="t in LOAN_TABS"
            :key="t.key"
            class="tab tab--sm"
            :class="{ 'tab--active': assets.loanFilter === t.key }"
            @click="assets.setLoanFilter(t.key)"
          >
            {{ t.label }}
          </button>
        </div>
        <input
          v-model="assets.loanQ"
          class="wl-input filters__search"
          placeholder="搜物品 / 借用人 / 用途"
        />
        <button class="wl-btn wl-btn--primary" @click="startLendFromList">
          <Icon name="plus" :size="14" /> 登记借出
        </button>
        <button class="wl-btn wl-btn--ghost" @click="download(api.assets.loansCsvUrl())">导出记录</button>
      </div>

      <div v-if="assets.loans.length === 0" class="wl-empty">
        <p>{{ assets.loanQ.trim() ? '没有匹配的借还记录' : '这里还没有记录' }}</p>
        <p v-if="assets.loanQ.trim()" class="wl-hint">换个关键词试试，或清空搜索。</p>
      </div>

      <table v-else class="loans">
        <thead>
          <tr>
            <th>物品</th>
            <th>数量</th>
            <th>借用人</th>
            <th>借出</th>
            <th>应还</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="loan in assets.loans" :key="loan.id" :class="{ 'row--overdue': loan.overdue }">
            <td>
              <button class="linklike" @click="openItem({ id: loan.itemId } as AssetItem)">
                {{ loan.itemName }}
              </button>
              <div v-if="loan.purpose" class="loans__purpose">{{ loan.purpose }}</div>
            </td>
            <td>{{ loan.qty }}</td>
            <td>{{ loan.borrowerName }}</td>
            <td>{{ formatDate(loan.lentAt) }}</td>
            <td>{{ loan.dueOn ?? '—' }}</td>
            <td>
              <template v-if="loan.voidedAt">
                <span class="tag tag--bad">已作废</span>
                <div v-if="loan.voidedByName" class="loans__sub">
                  {{ loan.voidedByName }} 作废 · {{ formatDate(loan.voidedAt) }}
                </div>
              </template>
              <template v-else-if="loan.returnedAt">
                <span class="tag tag--ok">已归还</span>
                <div class="loans__sub">
                  {{ formatDate(loan.returnedAt) }}
                  <template v-if="loan.returnedByName"> · {{ loan.returnedByName }} 还的</template>
                </div>
                <div v-if="loan.returnCondition && loan.returnCondition !== 'good'" class="loans__sub loans__sub--warn">
                  归还时报：{{ CONDITION_LABELS[loan.returnCondition] }}
                </div>
              </template>
              <template v-else-if="loan.overdue">
                <span class="tag tag--bad">逾期 {{ loan.overdueDays }} 天</span>
              </template>
              <template v-else>
                <span class="tag tag--warn">外借中</span>
              </template>
            </td>
            <td class="loans__actions">
              <button v-if="!loan.returnedAt && !loan.voidedAt" class="wl-btn wl-btn--ghost" @click="startReturn(loan)">
                归还
              </button>
              <template v-if="auth.isAdmin && !loan.voidedAt">
                <button class="wl-btn wl-btn--ghost" title="更正借用人/数量/日期" @click="startLoanEdit(loan)">
                  更正
                </button>
                <button class="wl-btn wl-btn--danger" title="作废这条记录（保留历史）" @click="voidLoan(loan)">
                  作废
                </button>
              </template>
              <button
                v-if="auth.isAdmin && loan.voidedAt"
                class="wl-btn wl-btn--ghost"
                title="恢复这条记录，重新计入账面"
                @click="restoreLoan(loan)"
              >
                恢复
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- ------------------------------------------------------------ 物品详情 -->
    <div v-if="detailOpen && assets.detail" class="drawer">
      <div class="drawer__backdrop" @click="closeDetail" />
      <aside class="drawer__panel wl-scroll">
        <header class="drawer__head">
          <div>
            <h2 class="drawer__title">{{ assets.detail.item.name }}</h2>
            <div class="drawer__sub">
              <span v-if="assets.detail.item.categoryName">{{ assets.detail.item.categoryName }}</span>
              <span v-if="assets.detail.item.code">编号 {{ assets.detail.item.code }}</span>
              <span :class="conditionClass(assets.detail.item.condition)">
                {{ CONDITION_LABELS[assets.detail.item.condition] }}
              </span>
            </div>
          </div>
          <button class="wl-icon-btn" title="关闭" @click="closeDetail">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="drawer__qty">
          <div>
            <span class="drawer__big">{{ assets.detail.item.availableQty }}</span>
            <span class="drawer__qty-label">件可借</span>
          </div>
          <div class="drawer__qty-sub">
            共 {{ assets.detail.item.totalQty }} 件，其中 {{ assets.detail.item.onLoanQty }} 件在外
          </div>
        </div>

        <dl class="facts">
          <div><dt>单价</dt><dd>¥{{ formatCents(assets.detail.item.valueCents) }}</dd></div>
          <div><dt>台账价值</dt><dd>¥{{ formatCents(assets.detail.item.totalValueCents) }}</dd></div>
          <div><dt>购入日期</dt><dd>{{ assets.detail.item.purchasedOn ?? '未记录' }}</dd></div>
          <div><dt>存放位置</dt><dd>{{ assets.detail.item.location ?? '未记录' }}</dd></div>
          <div v-if="assets.detail.item.note" class="facts__wide">
            <dt>备注</dt><dd>{{ assets.detail.item.note }}</dd>
          </div>
        </dl>

        <div class="drawer__actions">
          <button
            class="wl-btn wl-btn--primary"
            :disabled="assets.detail.item.availableQty === 0 || assets.detail.item.status === 'retired'"
            @click="startLend"
          >
            借出
          </button>
          <button v-if="auth.isAdmin" class="wl-btn wl-btn--ghost" @click="openEdit(assets.detail.item)">
            编辑
          </button>
          <button v-if="auth.isAdmin" class="wl-btn wl-btn--danger" @click="toggleRetire(assets.detail.item)">
            {{ assets.detail.item.status === 'active' ? '退役' : '恢复' }}
          </button>
        </div>

        <!-- 这件东西的借还历史 -->
        <h3 class="drawer__section">借还历史</h3>
        <div v-if="assets.detail.loans.length === 0" class="wl-hint">还没有人借过</div>
        <ul v-else class="history">
          <li v-for="loan in assets.detail.loans" :key="loan.id" class="history__row">
            <div class="history__who">
              {{ loan.borrowerName }}
              <span v-if="loan.qty > 1" class="history__qty">× {{ loan.qty }}</span>
            </div>
            <div class="history__when">
              {{ formatDate(loan.lentAt) }} 借出
              <template v-if="loan.returnedAt"> · {{ formatDate(loan.returnedAt) }} 归还</template>
              <template v-else-if="loan.overdue">
                · <span class="history__overdue">逾期 {{ loan.overdueDays }} 天</span>
              </template>
              <template v-else> · 未归还</template>
            </div>
            <div v-if="loan.purpose" class="history__purpose">{{ loan.purpose }}</div>
            <div v-if="loan.returnCondition && loan.returnCondition !== 'good'" class="history__purpose history__overdue">
              归还时报：{{ CONDITION_LABELS[loan.returnCondition] }}
            </div>
            <div v-if="loan.voidedAt" class="history__purpose history__overdue">
              已作废（{{ loan.voidedByName }}）
              <button v-if="auth.isAdmin" class="linklike history__restore" @click="restoreLoan(loan)">
                恢复
              </button>
            </div>
            <div v-else-if="auth.isAdmin" class="history__admin">
              <button class="wl-btn wl-btn--ghost" @click="startLoanEdit(loan)">更正</button>
              <button class="wl-btn wl-btn--danger" @click="voidLoan(loan)">作废</button>
            </div>
          </li>
        </ul>
      </aside>
    </div>

    <!-- ------------------------------------------------------------ 登记 / 编辑 -->
    <ModalShell
      v-if="editing"
      overlay-class="dialog"
      backdrop
      backdrop-class="dialog__backdrop"
      panel-class="dialog__panel wl-scroll"
      labelledby="asset-edit-title"
      initial-focus="input.wl-input"
      :closable="!editSaving"
      @close="requestCloseEdit"
    >
        <h2 id="asset-edit-title" class="dialog__title">{{ editId ? '编辑物品' : '登记物品' }}</h2>

        <div class="grid2">
          <label class="wl-field grid2__wide">
            <span class="wl-label">名称 *</span>
            <input v-model="form.name" class="wl-input" placeholder="比如：露营帐篷" maxlength="60" />
          </label>
          <label class="wl-field">
            <span class="wl-label">资产编号</span>
            <input v-model="form.code" class="wl-input" placeholder="可留空" maxlength="40" />
          </label>
          <label class="wl-field">
            <span class="wl-label">分类</span>
            <select v-model="form.categoryId" class="wl-select">
              <option :value="null">未分类</option>
              <option v-for="c in assets.activeCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="wl-field">
            <span class="wl-label">数量</span>
            <input v-model.number="form.totalQty" class="wl-input" type="number" min="0" />
          </label>
          <label class="wl-field">
            <span class="wl-label">单价（元）</span>
            <input v-model="form.value" class="wl-input" placeholder="0.00" />
          </label>
          <label class="wl-field">
            <span class="wl-label">购入日期</span>
            <input v-model="form.purchasedOn" class="wl-input" type="date" />
          </label>
          <label class="wl-field">
            <span class="wl-label">成色</span>
            <select v-model="form.condition" class="wl-select">
              <option value="good">完好</option>
              <option value="fair">有磨损</option>
              <option value="broken">已损坏</option>
              <option value="lost">已遗失</option>
            </select>
          </label>
          <label class="wl-field grid2__wide">
            <span class="wl-label">存放位置</span>
            <input v-model="form.location" class="wl-input" placeholder="比如：活动室 A 柜" maxlength="80" />
          </label>
          <label class="wl-field grid2__wide">
            <span class="wl-label">备注</span>
            <textarea v-model="form.note" class="wl-textarea" rows="2" maxlength="1000" />
          </label>
        </div>

        <p v-if="editError" class="form-error">{{ editError }}</p>

        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" @click="submitForm">保存</button>
          <button class="wl-btn wl-btn--ghost" @click="requestCloseEdit">取消</button>
        </div>

        <details class="cats">
          <summary>管理分类</summary>
          <ul class="cats__list">
            <li v-for="c in assets.categories" :key="c.id" class="cats__row">
              <span :class="{ 'cats__archived': c.archived }">{{ c.name }}{{ c.archived ? '（已归档）' : '' }}</span>
              <button class="linklike" @click="assets.archiveCategory(c.id, !c.archived)">
                {{ c.archived ? '恢复' : '归档' }}
              </button>
            </li>
          </ul>
          <div class="cats__add">
            <input v-model="newCatName" class="wl-input" placeholder="新分类名" maxlength="24" />
            <button class="wl-btn wl-btn--ghost" @click="addCategory">添加</button>
          </div>
        </details>
    </ModalShell>

    <ConfirmDialog
      v-if="editCloseConfirm"
      title="放弃未保存的物品信息？"
      message="名称、数量等内容还没有保存，关闭后需要重新填写。"
      confirm-text="放弃修改"
      cancel-text="继续填写"
      danger
      @confirm="discardEdit"
      @cancel="editCloseConfirm = false"
    />

    <!-- ------------------------------------------------------------ 借出 -->
    <div v-if="lendOpen" class="dialog">
      <div class="dialog__backdrop" @click="cancelLend" />
      <div class="dialog__panel wl-scroll">
        <h2 class="dialog__title">登记借出</h2>

        <!-- 从借还记录页发起：现场挑物品；从物品详情发起：物品已经确定 -->
        <template v-if="lendSource === 'list'">
          <label class="wl-field">
            <span class="wl-label">找物品</span>
            <input v-model="lendPickSearch" class="wl-input" placeholder="搜名称或编号" />
          </label>
          <label class="wl-field">
            <span class="wl-label">物品 *</span>
            <select v-model="lendPickId" class="wl-select" :disabled="lendPickLoading">
              <option v-if="lendPickLoading" value="">正在加载…</option>
              <option v-else-if="lendPickChoices.length === 0" value="">没有可借的物品</option>
              <option v-for="item in lendPickChoices" :key="item.id" :value="item.id">
                {{ item.name }}（可借 {{ item.availableQty }} 件）{{ item.code ? ` · ${item.code}` : '' }}
              </option>
            </select>
          </label>
          <p v-if="!lendPickLoading && lendPickItems.length === 0" class="wl-hint">
            台账里没有「在用且还有得借」的物品，先去物品台账登记或补货。
          </p>
        </template>
        <div v-else class="lend-item">
          <span class="lend-item__name">{{ lendItem?.name ?? '—' }}</span>
          <span class="lend-item__avail">可借 {{ lendItem?.availableQty ?? 0 }} 件</span>
        </div>

        <div class="grid2">
          <!--
            借用人。**只有管理员能选别人** —— 普通成员固定借给自己。
            服务端会拒绝成员代他人登记（否则任何人都能把借款记到别人名下），
            所以这里对成员直接不显示选择器，避免给了入口又报 403。
            真的操作人是谁由审计日志如实记录，下拉只决定**记在谁名下**。
          -->
          <label v-if="auth.isAdmin" class="wl-field">
            <span class="wl-label">借用人</span>
            <select v-model="lendBorrower" class="wl-select">
              <option v-if="!assets.members.some((m) => m.id === auth.user?.id)" :value="auth.user?.id ?? ''">
                {{ auth.user?.displayName ?? '我' }}（我）
              </option>
              <option v-for="m in assets.members" :key="m.id" :value="m.id">
                {{ m.name }}{{ m.id === auth.user?.id ? '（我）' : '' }}
              </option>
            </select>
          </label>
          <label class="wl-field">
            <span class="wl-label">数量</span>
            <input
              v-model="lendQty"
              class="wl-input"
              type="number"
              min="1"
              :max="lendItem?.availableQty ?? 1"
            />
          </label>
          <label class="wl-field">
            <span class="wl-label">应还日期</span>
            <input v-model="lendDue" class="wl-input" type="date" />
          </label>
          <label class="wl-field grid2__wide">
            <span class="wl-label">用途</span>
            <input v-model="lendPurpose" class="wl-input" placeholder="比如：周末露营" maxlength="200" />
          </label>
        </div>

        <p v-if="lendError" class="form-error">{{ lendError }}</p>
        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" :disabled="!lendItem" @click="submitLend">确认借出</button>
          <button class="wl-btn wl-btn--ghost" @click="cancelLend">取消</button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ 归还 -->
    <div v-if="returnOpen" class="dialog">
      <div class="dialog__backdrop" @click="returnOpen = null" />
      <div class="dialog__panel">
        <h2 class="dialog__title">归还「{{ returnOpen.itemName }}」</h2>
        <p class="wl-hint">借用人：{{ returnOpen.borrowerName }} · 数量 {{ returnOpen.qty }}</p>

        <label class="wl-field">
          <span class="wl-label">归还时的状态</span>
          <select v-model="returnCondition" class="wl-select">
            <option value="good">完好</option>
            <option value="fair">有磨损</option>
            <option value="broken">已损坏</option>
            <option value="lost">已遗失</option>
          </select>
        </label>
        <!-- 这里说清后果，否则"随手选个损坏"会让整件物品在台账上变成坏的 -->
        <p v-if="returnCondition === 'broken' || returnCondition === 'lost'" class="wl-hint">
          选这项会把整件物品在台账上的状态也改成「{{ CONDITION_LABELS[returnCondition] }}」。
        </p>

        <label class="wl-field">
          <span class="wl-label">备注</span>
          <input v-model="returnNote" class="wl-input" placeholder="可留空，比如：摔裂了一个角" maxlength="500" />
        </label>

        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" @click="submitReturn">确认归还</button>
          <button class="wl-btn wl-btn--ghost" @click="returnOpen = null">取消</button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ 更正借还记录（管理员） -->
    <div v-if="loanEdit" class="dialog">
      <div class="dialog__backdrop" @click="cancelLoanEdit" />
      <div class="dialog__panel">
        <h2 class="dialog__title">更正「{{ loanEdit.itemName }}」的借出记录</h2>
        <p class="wl-hint">记错了借用人 / 数量 / 日期时直接改，不必先错误地归还。</p>

        <label class="wl-field">
          <span class="wl-label">借用人</span>
          <select v-model="loanEditBorrower" class="wl-select">
            <option v-for="m in assets.members" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </label>
        <label class="wl-field">
          <span class="wl-label">数量</span>
          <input v-model="loanEditQty" class="wl-input" type="number" min="1" />
        </label>
        <label class="wl-field">
          <span class="wl-label">应还日期</span>
          <input v-model="loanEditDue" class="wl-input" type="date" />
        </label>
        <label class="wl-field">
          <span class="wl-label">用途</span>
          <input v-model="loanEditPurpose" class="wl-input" placeholder="可留空" maxlength="200" />
        </label>

        <p v-if="loanEditError" class="form-error">{{ loanEditError }}</p>
        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" @click="submitLoanEdit">保存</button>
          <button class="wl-btn wl-btn--ghost" @click="cancelLoanEdit">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assets {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 16px;
  gap: 12px;
  overflow: hidden;
  /*
   * ⚠️ 必须定位，弹层才关得住。
   *
   * 详情抽屉（.drawer）与两个对话框（.dialog）用的都是 position:absolute; inset:0 ——
   * 它们要盖住的是**这个应用窗口**。少了 position:relative，
   * 它们会往上找最近的定位祖先，找不到就落到整个视口上 ——
   * 于是一个应用里的表单会盖住整个桌面、连任务栏都点不到。
   */
  position: relative;
}

/* ---------------------------------------------------------------- 顶栏 */
.assets__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.assets__tabs {
  display: flex;
  gap: 4px;
}
.tab {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 13px;
  cursor: pointer;
}
.tab:hover {
  background: var(--surface-2);
}
.tab--active {
  background: var(--surface-2);
  border-color: var(--line);
  color: var(--fg);
  font-weight: 600;
}
.tab--sm {
  padding: 4px 10px;
  font-size: 12px;
}
.assets__head-actions {
  display: flex;
  gap: 8px;
}
.assets__head-actions .wl-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* ---------------------------------------------------------------- 我的待办 */
.assets__todo {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.assets__todo-label {
  font-size: 11.5px;
  color: var(--fg-dim);
}
.todopill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--fg-dim);
  font-size: 12px;
  cursor: pointer;
}
.todopill:hover {
  border-color: var(--accent);
  color: var(--fg);
}
.todopill--bad {
  border-color: color-mix(in srgb, var(--danger, #d9534f) 40%, transparent);
  color: var(--danger, #d9534f);
}
.todopill__n {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--danger, #d9534f);
  color: #ffffff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

/* ---------------------------------------------------------------- 逾期提醒 */
.assets__alert {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger, #d9534f) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #d9534f) 35%, transparent);
  font-size: 12px;
}
.assets__alert-list {
  color: var(--fg-dim);
}

/* ---------------------------------------------------------------- 概览 */
.assets__stats {
  flex-shrink: 0;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.stat {
  flex: 1;
  min-width: 78px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.stat--wide {
  min-width: 130px;
}
.stat__num {
  font-size: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.stat__num--ok {
  color: var(--success, #3aa76d);
}
.stat__num--warn {
  color: var(--warning, #d99a2b);
}
.stat__num--bad {
  color: var(--danger, #d9534f);
}
.stat__label {
  font-size: 11px;
  color: var(--fg-dim);
}

/* ---------------------------------------------------------------- 筛选 */
.filters {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.filters__search {
  flex: 1;
  min-width: 160px;
}
.filters__check {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--fg-dim);
  cursor: pointer;
  white-space: nowrap;
}

/* ---------------------------------------------------------------- 物品卡片 */
.items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  align-content: start;
  padding-bottom: 8px;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 0.15s;
}
.item:hover {
  border-color: var(--accent, #4a8cff);
  transform: translateY(-1px);
}
.item--retired {
  opacity: 0.55;
}
.item--out {
  border-color: color-mix(in srgb, var(--warning, #d99a2b) 45%, transparent);
}
.item__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.item__name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
}
.item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-dim);
}
.item__code {
  font-family: ui-monospace, monospace;
}
.item__qty {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-top: auto;
}
.item__avail {
  font-size: 19px;
  font-weight: 650;
  color: var(--success, #3aa76d);
  font-variant-numeric: tabular-nums;
}
.item__avail--zero {
  color: var(--warning, #d99a2b);
}
.item__slash {
  color: var(--fg-dim);
  font-size: 12px;
}
.item__total {
  font-size: 13px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.item__qty-label {
  font-size: 11px;
  color: var(--fg-dim);
  margin-left: 3px;
}
.item__loan-badge {
  margin-left: auto;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning, #d99a2b) 18%, transparent);
  color: var(--warning, #d99a2b);
}

/* ---------------------------------------------------------------- 标签 */
.tag {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.tag--ok {
  background: color-mix(in srgb, var(--success, #3aa76d) 16%, transparent);
  color: var(--success, #3aa76d);
}
.tag--warn {
  background: color-mix(in srgb, var(--warning, #d99a2b) 16%, transparent);
  color: var(--warning, #d99a2b);
}
.tag--bad {
  background: color-mix(in srgb, var(--danger, #d9534f) 16%, transparent);
  color: var(--danger, #d9534f);
}

/* ---------------------------------------------------------------- 借还表格 */
.loans {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.loans th {
  position: sticky;
  top: 0;
  background: var(--surface-1);
  text-align: left;
  font-weight: 600;
  font-size: 11.5px;
  color: var(--fg-dim);
  padding: 7px 8px;
  border-bottom: 1px solid var(--line);
}
.loans td {
  padding: 8px;
  border-bottom: 1px solid var(--line-subtle, var(--line));
  vertical-align: top;
}
.row--overdue td {
  background: color-mix(in srgb, var(--danger, #d9534f) 7%, transparent);
}
.loans__purpose,
.loans__sub {
  font-size: 11px;
  color: var(--fg-dim);
  margin-top: 2px;
}
.loans__sub--warn {
  color: var(--warning, #d99a2b);
}
.loans__actions {
  text-align: right;
}
.linklike {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent, #4a8cff);
  cursor: pointer;
  font-size: inherit;
  text-align: left;
}
.linklike:hover {
  text-decoration: underline;
}

/* ---------------------------------------------------------------- 详情抽屉 */
.drawer {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  justify-content: flex-end;
}
.drawer__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
}
.drawer__panel {
  position: relative;
  width: min(420px, 100%);
  height: 100%;
  overflow-y: auto;
  background: var(--surface-raised);
  border-left: 1px solid var(--line);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.drawer__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}
.drawer__title {
  margin: 0 0 5px;
  font-size: 17px;
}
.drawer__sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--fg-dim);
}
.drawer__qty {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.drawer__big {
  font-size: 26px;
  font-weight: 700;
  color: var(--success, #3aa76d);
  font-variant-numeric: tabular-nums;
}
.drawer__qty-label {
  font-size: 12px;
  color: var(--fg-dim);
  margin-left: 4px;
}
.drawer__qty-sub {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--fg-dim);
}
.facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: 12px;
}
.facts > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.facts__wide {
  grid-column: 1 / -1;
}
.facts dt {
  color: var(--fg-dim);
  font-size: 11px;
}
.facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.drawer__actions {
  display: flex;
  gap: 8px;
}
.drawer__section {
  margin: 4px 0 0;
  font-size: 12.5px;
  font-weight: 600;
}

/* ---------------------------------------------------------------- 内联表单 */
.inline-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.inline-form__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inline-form__row .wl-label {
  width: 66px;
  flex-shrink: 0;
  margin: 0;
}
.inline-form__actions {
  display: flex;
  gap: 8px;
}
.form-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #d9534f);
}

/* ---------------------------------------------------------------- 历史 */
.history {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.history__row {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  font-size: 12px;
}
.history__who {
  font-weight: 600;
}
.history__qty {
  color: var(--fg-dim);
  font-weight: 400;
}
.history__when {
  color: var(--fg-dim);
  font-size: 11px;
  margin-top: 2px;
}
.history__overdue {
  color: var(--danger, #d9534f);
}
.history__purpose {
  color: var(--fg-dim);
  font-size: 11px;
  margin-top: 2px;
}
.history__admin {
  display: flex;
  gap: var(--space-2, 8px);
  margin-top: var(--space-2, 8px);
}
.history__admin .wl-btn {
  height: 24px;
  padding: 0 10px;
  font-size: 11.5px;
}

/* ---------------------------------------------------------------- 对话框 */
.dialog {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
/* 面板/遮罩由 ModalShell 渲染，需要用 :deep() 才能套到子组件内部节点 */
.dialog :deep(.dialog__backdrop) {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}
.dialog :deep(.dialog__panel) {
  position: relative;
  width: min(520px, 100%);
  max-height: 100%;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dialog__title {
  margin: 0;
  font-size: 16px;
}
.dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.grid2__wide {
  grid-column: 1 / -1;
}

/* ---------------------------------------------------------------- 分类管理 */
.cats {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  font-size: 12px;
}
.cats summary {
  cursor: pointer;
  color: var(--fg-dim);
}
.cats__list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.cats__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.cats__archived {
  opacity: 0.5;
  text-decoration: line-through;
}
.cats__add {
  display: flex;
  gap: 6px;
}

/* ---------------------------------------------------------------- 借出对话框 */
.lend-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.lend-item__name {
  font-size: 14px;
  font-weight: 600;
}
.lend-item__avail {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.history__restore {
  margin-left: 8px;
  font-size: 11px;
}

/* ---------------------------------------------------------------- 借还表格打磨 */
.loans tbody tr {
  transition: background var(--dur-fast, 0.15s) var(--ease-out, ease-out);
}
.loans tbody tr:hover td {
  background: var(--hover);
}
.loans th:first-child,
.loans td:first-child {
  padding-left: 12px;
}
.loans th:last-child,
.loans td:last-child {
  padding-right: 12px;
}
.loans__actions {
  white-space: nowrap;
}
.loans__actions .wl-btn {
  height: 24px;
  padding: 0 9px;
  font-size: 11.5px;
}
.loans__actions .wl-btn + .wl-btn {
  margin-left: 4px;
}

/* ================================================================
   整体 UI 升级（评审团定稿）· 降噪覆盖层
   ================================================================ */

/* 顶栏页签 → 分段控件（选中 = 白底卡片，不再是"带框按钮"） */
.assets .assets__tabs {
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.assets .tab {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 3px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.assets .tab:hover {
  background: var(--hover);
}

.assets .tab--active {
  background: var(--surface-1);
  color: var(--text);
  box-shadow: var(--shadow-card);
  font-weight: 600;
}

.assets .tab--sm {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}

/* 逾期提醒：软底 + 无描边 */
.assets .assets__alert {
  background: var(--danger-soft);
  border: none;
  border-radius: var(--radius);
  padding: 10px 14px;
}

.assets .assets__alert-list {
  color: var(--text-secondary);
}

/* 概览卡：8px 圆角 + 发丝描边 + 轻阴影 */
.assets .stat {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 10px 14px;
}

.assets .stat__num {
  font-size: var(--fs-num);
  font-weight: 600;
}

.assets .stat__label {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

/* 筛选行：搜索框限宽、下拉不再撑满整行 */
.assets .filters {
  gap: var(--space-2);
}

.assets .filters__search {
  flex: 1 1 240px;
  max-width: 360px;
  min-width: 200px;
}

.assets .filters .wl-select {
  width: auto;
  min-width: 128px;
}

.assets .filters__check {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}

.assets .filters__check input {
  accent-color: var(--accent);
}

/* 物品卡片：发丝描边 + 悬浮抬起 */
.assets .item {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 12px 14px;
}

.assets .item:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
  box-shadow: var(--shadow-popup);
}

.assets .item__name {
  font-size: var(--fs-subtitle);
}

.assets .item__meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.assets .item__avail {
  font-size: 20px;
  font-weight: 600;
}

.assets .item__loan-badge {
  border-radius: var(--radius-sm);
}

/* 状态标签：统一 4px 圆角 */
.assets .tag {
  border-radius: var(--radius-sm);
}

/* 借还表格：发丝线 */
.assets .loans th {
  background: var(--surface-1);
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--line-hair);
}

.assets .loans td {
  border-bottom: 1px solid var(--line-hair);
}

.assets .loans__purpose,
.assets .loans__sub {
  color: var(--text-tertiary);
}
</style>
