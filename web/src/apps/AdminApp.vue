<!--
  管理应用。

  只有管理员能进：非管理员打开时直接给一个"需要管理员权限"的空状态，一个请求都不发。
  左侧是标签页（概览 / 成员 / 邀请码 / 审计日志），右侧是内容区。

  数据来源只有两个接口：adminOverview（概览、成员、邀请码共用）与 getAudit（审计日志）。
  概览用 v-if 链保证「加载中 / 出错 / 有数据」三态清晰；出错一定把后端的真实 message 显示出来。
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, ApiError, formatBytes, formatTime } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const auth = useAuth()
const ui = useUi()

// ---------------------------------------------------------------- 类型

type Overview = Awaited<ReturnType<typeof api.adminOverview>>
type AdminInvite = Overview['invites'][number]
type AuditRecord = Awaited<ReturnType<typeof api.getAudit>>['records'][number]
type VerifyResult = Awaited<ReturnType<typeof api.verifyAudit>>

type TabId = 'overview' | 'members' | 'invites' | 'audit'

// ---------------------------------------------------------------- 标签页

const TABS: Array<{ id: TabId; name: string; icon: string }> = [
  { id: 'overview', name: '概览', icon: 'chart' },
  { id: 'members', name: '成员', icon: 'users' },
  { id: 'invites', name: '邀请码', icon: 'qr' },
  { id: 'audit', name: '审计日志', icon: 'shield' },
]

const tab = ref<TabId>('overview')

function selectTab(id: TabId): void {
  tab.value = id
  if (id === 'audit' && !auditLoaded.value) {
    auditLoaded.value = true
    void loadAudit(true)
  }
}

// ---------------------------------------------------------------- 概览 / 成员 / 邀请码

const overview = ref<Overview | null>(null)
const overviewLoading = ref(false)
const overviewError = ref('')

const stats = computed(() => overview.value?.stats ?? { blobs: 0, bytes: 0, nodes: 0 })
const users = computed(() => overview.value?.users ?? [])
const invites = computed(() => overview.value?.invites ?? [])
const chain = computed(
  () => overview.value?.audit ?? { records: 0, chainOk: true, head: { seq: 0, hash: '' } },
)

const statCards = computed<Array<{ icon: string; label: string; value: string }>>(() => [
  { icon: 'cloud', label: '存储占用', value: formatBytes(stats.value.bytes) },
  { icon: 'file', label: '文件数', value: String(stats.value.nodes) },
  { icon: 'db', label: '去重后对象数', value: String(stats.value.blobs) },
  { icon: 'users', label: '成员数', value: String(users.value.length) },
  { icon: 'shield', label: '审计记录数', value: String(chain.value?.records ?? 0) },
])

const dedupNote = computed(() => {
  const s = stats.value
  if (s.nodes <= s.blobs) return ''
  return `内容去重：${s.nodes} 个文件只占 ${s.blobs} 份存储`
})

const storage = computed(
  () =>
    overview.value?.storage ?? {
      topFiles: [],
      byOwner: [],
      freeBytes: -1,
      totalBytes: 0,
      minFreeBytes: 0,
    },
)
const logicalBytes = computed(() => storage.value.byOwner.reduce((sum, row) => sum + row.bytes, 0))
const storageBadge = computed(() => {
  const s = storage.value
  if (s.freeBytes < 0) return 'wl-badge'
  return s.freeBytes < s.minFreeBytes ? 'wl-badge--danger' : 'wl-badge--success'
})

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

async function loadOverview(): Promise<void> {
  if (overviewLoading.value) return
  overviewLoading.value = true
  overviewError.value = ''
  try {
    overview.value = await api.adminOverview()
  } catch (err) {
    overviewError.value = messageOf(err)
  } finally {
    overviewLoading.value = false
  }
}

// ---------------------------------------------------------------- 审计链校验

const verifyLoading = ref(false)
const verifyResult = ref<VerifyResult | null>(null)

async function runVerify(): Promise<void> {
  if (verifyLoading.value) return
  verifyLoading.value = true
  try {
    const result = await api.verifyAudit()
    verifyResult.value = result
    if (overview.value) overview.value.audit.chainOk = result.ok
    ui.notify(
      result.ok ? 'success' : 'error',
      result.ok ? '审计链校验通过' : '审计链校验失败',
      result.reason ?? undefined,
    )
  } catch (err) {
    verifyResult.value = null
    ui.notify('error', '校验失败', messageOf(err))
  } finally {
    verifyLoading.value = false
  }
}

// ---------------------------------------------------------------- 邀请码

const creating = ref(false)
const createError = ref('')
const newCode = ref('')

const form = reactive<{
  role: 'member' | 'admin'
  maxUses: number
  expiresInDays: number | null
  note: string
}>({
  role: 'member',
  maxUses: 1,
  expiresInDays: null,
  note: '',
})

async function submitInvite(): Promise<void> {
  if (creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const payload: {
      role: 'member' | 'admin'
      maxUses?: number
      expiresInDays?: number
      note?: string
    } = { role: form.role }

    const maxUses = Number(form.maxUses)
    if (Number.isFinite(maxUses) && maxUses >= 1) payload.maxUses = Math.floor(maxUses)

    const days = Number(form.expiresInDays)
    if (form.expiresInDays !== null && Number.isFinite(days) && days >= 1) {
      payload.expiresInDays = Math.floor(days)
    }

    const note = form.note.trim()
    if (note) payload.note = note

    const { code } = await api.createInvite(payload)
    newCode.value = code
    ui.notify('success', '邀请码已生成', code)
    await loadOverview()
  } catch (err) {
    createError.value = messageOf(err)
  } finally {
    creating.value = false
  }
}

function isInviteDead(inv: AdminInvite): boolean {
  if (inv.expires_at !== null && inv.expires_at <= Date.now()) return true
  return inv.max_uses > 0 && inv.uses >= inv.max_uses
}

function inviteDeadReason(inv: AdminInvite): string {
  if (inv.expires_at !== null && inv.expires_at <= Date.now()) return '已过期'
  return '已用尽'
}

const revoking = ref('')
async function revokeInvite(inv: AdminInvite): Promise<void> {
  if (!window.confirm(`作废邀请码 ${inv.code}？作废后无法再用它注册。`)) return
  revoking.value = inv.code
  try {
    await api.revokeInvite(inv.code)
    ui.notify('success', '邀请码已作废', inv.code)
    await loadOverview()
  } catch (err) {
    ui.notify('error', '作废失败', messageOf(err))
  } finally {
    revoking.value = ''
  }
}

// ---------------------------------------------------------------- 成员管理

const me = computed(() => auth.user)
const isOwner = computed(() => me.value?.role === 'owner')

/**
 * 我能不能管理这个成员。
 *
 * 与服务端同一套规则：管理员只能管普通成员（管不了别的管理员/创建者）；
 * 自己的账号不在这里改（改自己的显示名/口令请走设置页）。
 */
function canManage(u: Overview['users'][number]): boolean {
  if (u.id === me.value?.id) return false
  if (!isOwner.value && (u.role === 'admin' || u.role === 'owner')) return false
  return true
}

function manageTitle(u: Overview['users'][number]): string {
  if (u.id === me.value?.id) return '请在「设置 → 账号」里修改自己的资料'
  if (!isOwner.value && (u.role === 'admin' || u.role === 'owner')) {
    return '管理员只能管理普通成员'
  }
  return ''
}

type AdminUser = Overview['users'][number]

const editUser = ref<AdminUser | null>(null)
const editDisplayName = ref('')
const editRole = ref<'owner' | 'admin' | 'member'>('member')
const editStatus = ref<'active' | 'disabled'>('active')
const editError = ref('')
const editSaving = ref(false)

function openUserEdit(u: AdminUser): void {
  editUser.value = u
  editDisplayName.value = u.display_name || u.username
  editRole.value = (u.role as 'owner' | 'admin' | 'member') ?? 'member'
  editStatus.value = u.status === 'disabled' ? 'disabled' : 'active'
  editError.value = ''
}

function closeUserEdit(): void {
  editUser.value = null
  editError.value = ''
}

async function submitUserEdit(): Promise<void> {
  const u = editUser.value
  if (!u) return
  if (!editDisplayName.value.trim()) {
    editError.value = '显示名不能为空'
    return
  }
  editSaving.value = true
  editError.value = ''
  try {
    const payload: { displayName?: string; role?: 'owner' | 'admin' | 'member'; status?: 'active' | 'disabled' } = {}
    if (editDisplayName.value.trim() !== (u.display_name || u.username)) payload.displayName = editDisplayName.value.trim()
    // 只有创建者能改角色，服务端也会再拦一次
    if (isOwner.value && editRole.value !== u.role) payload.role = editRole.value
    if (editStatus.value !== (u.status === 'disabled' ? 'disabled' : 'active')) payload.status = editStatus.value

    if (Object.keys(payload).length === 0) {
      closeUserEdit()
      return
    }
    await api.adminUpdateUser(u.id, payload)
    ui.notify('success', '已保存成员信息', u.username)
    closeUserEdit()
    await loadOverview()
  } catch (err) {
    editError.value = messageOf(err)
  } finally {
    editSaving.value = false
  }
}

/** 快速启用/停用（不走弹窗，改的只有 status 一项）。 */
async function toggleUserStatus(u: AdminUser): Promise<void> {
  const next = u.status === 'disabled' ? 'active' : 'disabled'
  if (next === 'disabled' && !window.confirm(`停用 ${u.username}？其全部会话会被立即吊销。`)) return
  try {
    await api.adminUpdateUser(u.id, { status: next })
    ui.notify('success', next === 'disabled' ? '已停用' : '已启用', u.username)
    await loadOverview()
  } catch (err) {
    ui.notify('error', '操作失败', messageOf(err))
  }
}

const resetOpen = ref<AdminUser | null>(null)
const resetPwd = ref('')
const resetPwd2 = ref('')
const resetError = ref('')
const resetSaving = ref(false)

function openReset(u: AdminUser): void {
  resetOpen.value = u
  resetPwd.value = ''
  resetPwd2.value = ''
  resetError.value = ''
}

async function submitReset(): Promise<void> {
  const u = resetOpen.value
  if (!u) return
  if (resetPwd.value.length < 8) {
    resetError.value = '口令至少 8 位'
    return
  }
  if (resetPwd.value !== resetPwd2.value) {
    resetError.value = '两次输入的口令不一致'
    return
  }
  resetSaving.value = true
  resetError.value = ''
  try {
    await api.adminResetPassword(u.id, resetPwd.value)
    ui.notify('success', '口令已重置', `${u.username} 的旧会话已被吊销，请让其重新登录`)
    resetPwd.value = ''
    resetPwd2.value = ''
    resetOpen.value = null
  } catch (err) {
    resetError.value = messageOf(err)
  } finally {
    resetSaving.value = false
  }
}

const revokingUser = ref('')
async function revokeUserSessions(u: AdminUser): Promise<void> {
  if (!window.confirm(`强制 ${u.username} 下线？其全部会话将立即失效。`)) return
  revokingUser.value = u.id
  try {
    await api.adminRevokeSessions(u.id)
    ui.notify('success', '已强制下线', u.username)
  } catch (err) {
    ui.notify('error', '操作失败', messageOf(err))
  } finally {
    revokingUser.value = ''
  }
}

// ---------------------------------------------------------------- 复制

const copySink = ref<HTMLInputElement | null>(null)

async function copy(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    ui.notify('success', '已复制', text)
    return
  } catch {
    // 非安全上下文或权限被拒时退化成"选中文本"，让用户手动 Ctrl+C
    const sink = copySink.value
    if (sink) {
      sink.value = text
      sink.focus()
      sink.select()
    }
    ui.notify('warning', '复制失败', '已为你选中文本，请按 Ctrl+C 手动复制')
  }
}

// ---------------------------------------------------------------- 审计日志

const PAGE = 200

const audit = ref<AuditRecord[]>([])
const auditLoaded = ref(false)
const auditLoading = ref(false)
const auditError = ref('')
const auditHasMore = ref(false)

const actorNames = computed(() => {
  const map = new Map<string, string>()
  for (const u of users.value) map.set(u.id, u.display_name || u.username)
  return map
})

function actorName(id: string | null): string {
  if (!id) return '系统'
  return actorNames.value.get(id) ?? `#${id.slice(0, 8)}`
}

function maxSeq(): number {
  const last = audit.value[audit.value.length - 1]
  return last ? last.seq : 0
}

function appendRecords(records: AuditRecord[]): void {
  const seen = new Set(audit.value.map((r) => r.seq))
  for (const r of records) {
    if (!seen.has(r.seq)) {
      audit.value.push(r)
      seen.add(r.seq)
    }
  }
  audit.value.sort((a, b) => a.seq - b.seq)
}

async function loadAudit(reset: boolean): Promise<void> {
  if (auditLoading.value) return
  auditLoading.value = true
  auditError.value = ''
  try {
    const from = reset ? 0 : maxSeq()
    const { records } = await api.getAudit(from, PAGE)
    if (reset) audit.value = []
    appendRecords(records)
    auditHasMore.value = records.length >= PAGE
  } catch (err) {
    auditError.value = messageOf(err)
  } finally {
    auditLoading.value = false
  }
}

// ---------------------------------------------------------------- 展示辅助

function shortHash(hash: string): string {
  return hash ? hash.slice(0, 12) : '—'
}

function roleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return '所有者'
    case 'admin':
      return '管理员'
    case 'member':
      return '成员'
    default:
      return role || '未知'
  }
}

function roleBadge(role: string): string {
  switch (role) {
    case 'owner':
      return 'wl-badge--accent'
    case 'admin':
      return 'wl-badge--warning'
    default:
      return ''
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '正常'
    case 'disabled':
      return '已禁用'
    case 'pending':
      return '待激活'
    case 'invited':
      return '已邀请'
    default:
      return status || '未知'
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'active':
      return 'wl-badge--success'
    case 'disabled':
      return 'wl-badge--danger'
    case 'pending':
    case 'invited':
      return 'wl-badge--warning'
    default:
      return ''
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'auth':
      return '认证'
    case 'file':
      return '文件'
    case 'tool':
      return '工具'
    case 'admin':
      return '管理'
    case 'system':
      return '系统'
    default:
      return cat || '其它'
  }
}

function categoryBadge(cat: string): string {
  switch (cat) {
    case 'auth':
      return 'wl-badge--accent'
    case 'file':
      return 'wl-badge--success'
    case 'tool':
      return 'wl-badge--warning'
    case 'admin':
      return 'wl-badge--danger'
    default:
      return ''
  }
}

// ---------------------------------------------------------------- 挂载

onMounted(() => {
  // 非管理员：不发任何请求，直接走权限不足的空状态
  if (!auth.isAdmin) return

  const argTab = props.win.args.tab
  if (typeof argTab === 'string' && TABS.some((t) => t.id === argTab)) {
    tab.value = argTab as TabId
  }

  void loadOverview()

  if (tab.value === 'audit') {
    auditLoaded.value = true
    void loadAudit(true)
  }
})
</script>

<template>
  <div class="admin">
    <!-- 复制失败的兜底：把文本放进这个隐藏输入框并选中 -->
    <input ref="copySink" class="admin__copy-sink" readonly tabindex="-1" aria-hidden="true" />

    <!-- 权限不足 -->
    <div v-if="!auth.isAdmin" class="wl-empty admin__denied">
      <Icon name="shield" :size="40" />
      <p class="admin__denied-title">需要管理员权限</p>
      <p class="admin__denied-hint">当前账号没有访问管理功能的权限，请使用管理员账号登录后重试。</p>
    </div>

    <div v-else class="admin__body">
      <nav class="admin__nav">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="admin__tab"
          :class="{ 'admin__tab--active': tab === t.id }"
          @click="selectTab(t.id)"
        >
          <Icon :name="t.icon" :size="16" />
          <span>{{ t.name }}</span>
        </button>
      </nav>

      <section class="admin__content wl-scroll">
        <!-- ============================ 概览 ============================ -->
        <div v-if="tab === 'overview'">
          <h3 class="panel-title">概览</h3>

          <div v-if="overviewLoading && !overview" class="wl-empty admin-center">
            <span class="wl-spinner"></span>
            <span>正在加载管理数据</span>
          </div>

          <div v-else-if="overviewError && !overview" class="admin__error">
            <Icon name="alert" :size="18" />
            <div class="admin__error-body">
              <p class="admin__error-title">加载失败</p>
              <p class="admin__error-msg selectable">{{ overviewError }}</p>
            </div>
            <button class="wl-btn" @click="loadOverview">
              <Icon name="refresh" :size="15" />
              重试
            </button>
          </div>

          <template v-else-if="overview">
            <div class="stat-grid">
              <div v-for="card in statCards" :key="card.label" class="stat wl-card">
                <span class="stat__icon"><Icon :name="card.icon" :size="18" /></span>
                <span class="stat__value">{{ card.value }}</span>
                <span class="stat__label">{{ card.label }}</span>
              </div>
            </div>

            <p v-if="dedupNote" class="admin__note">{{ dedupNote }}</p>

            <div class="card wl-card">
              <div class="card__head">
                <h4 class="card__title">存储明细</h4>
                <span
                  class="wl-badge"
                  :class="storageBadge"
                >
                  {{ storage.freeBytes < 0 ? '余量未知' : `剩余 ${formatBytes(storage.freeBytes)}` }}
                </span>
              </div>
              <p class="card__meta">
                磁盘 {{ formatBytes(storage.totalBytes) }}，底线保留 {{ formatBytes(storage.minFreeBytes) }}
              </p>
              <p class="card__meta">
                物理占用 {{ formatBytes(stats.bytes) }}（内容去重后）；按文件算的逻辑大小
                {{ formatBytes(logicalBytes) }} —— 两者之差就是去重省下的空间。
              </p>

              <table v-if="storage.byOwner.length" class="table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>文件数</th>
                    <th>逻辑大小</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in storage.byOwner" :key="row.userId">
                    <td class="table__name">{{ row.name }}</td>
                    <td class="table__muted">{{ row.files }}</td>
                    <td class="table__muted">{{ formatBytes(row.bytes) }}</td>
                  </tr>
                </tbody>
              </table>

              <template v-if="storage.topFiles.length">
                <p class="card__meta">最大的文件（单文件不设上限，所以这里能看见"盘是怎么满的"）</p>
                <ul class="storagelist">
                  <li v-for="f in storage.topFiles" :key="f.id" class="storagelist__row">
                    <span class="storagelist__name selectable" :title="f.name">{{ f.name }}</span>
                    <span class="storagelist__meta">{{ f.ownerName }} · {{ formatBytes(f.size) }}</span>
                  </li>
                </ul>
              </template>
              <p v-else class="card__meta">还没有上传过文件。</p>
            </div>

            <div class="card wl-card">
              <div class="card__head">
                <h4 class="card__title">审计链</h4>
                <span
                  class="wl-badge"
                  :class="chain.chainOk ? 'wl-badge--success' : 'wl-badge--danger'"
                >
                  {{ chain.chainOk ? '链正常' : '链异常' }}
                </span>
              </div>
              <p class="card__meta">当前链头序号 #{{ chain.head.seq }}</p>
              <p class="card__meta">
                链头哈希
                <code class="mono selectable" :title="chain.head.hash">{{ shortHash(chain.head.hash) }}</code>
              </p>

              <div class="card__actions">
                <button class="wl-btn wl-btn--primary" :disabled="verifyLoading" @click="runVerify">
                  <span v-if="verifyLoading" class="wl-spinner"></span>
                  <Icon v-else name="shield" :size="16" />
                  校验审计链
                </button>
              </div>

              <div
                v-if="verifyResult"
                class="verify"
                :class="verifyResult.ok ? 'verify--ok' : 'verify--bad'"
              >
                <Icon :name="verifyResult.ok ? 'check' : 'alert'" :size="16" />
                <div class="verify__body">
                  <p v-if="verifyResult.ok">校验通过，已核验 {{ verifyResult.checked }} 条记录。</p>
                  <template v-else>
                    <p>校验失败，已核验 {{ verifyResult.checked }} 条。</p>
                    <p class="verify__detail">
                      第一处异常序号 #{{ verifyResult.firstBadSeq ?? '未知' }}
                    </p>
                    <p v-if="verifyResult.reason" class="verify__detail selectable">
                      原因：{{ verifyResult.reason }}
                    </p>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- ============================ 成员 ============================ -->
        <div v-else-if="tab === 'members'">
          <h3 class="panel-title">成员</h3>

          <div v-if="overviewLoading && !overview" class="wl-empty admin-center">
            <span class="wl-spinner"></span>
            <span>正在加载成员列表</span>
          </div>

          <div v-else-if="overviewError && !overview" class="admin__error">
            <Icon name="alert" :size="18" />
            <div class="admin__error-body">
              <p class="admin__error-title">加载失败</p>
              <p class="admin__error-msg selectable">{{ overviewError }}</p>
            </div>
            <button class="wl-btn" @click="loadOverview">
              <Icon name="refresh" :size="15" />
              重试
            </button>
          </div>

          <div v-else-if="users.length === 0" class="wl-empty admin-center">
            <Icon name="users" :size="32" />
            <span>暂无成员</span>
          </div>

          <table v-else class="table">
            <thead>
              <tr>
                <th>显示名</th>
                <th>用户名</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最后登录</th>
                <th class="table__actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td class="table__name">{{ u.display_name || u.username }}</td>
                <td class="table__muted">{{ u.username }}</td>
                <td>
                  <span class="wl-badge" :class="roleBadge(u.role)">{{ roleLabel(u.role) }}</span>
                </td>
                <td>
                  <span class="wl-badge" :class="statusBadge(u.status)">{{ statusLabel(u.status) }}</span>
                </td>
                <td class="table__muted">{{ formatTime(u.created_at) }}</td>
                <td class="table__muted">
                  {{ u.last_login_at ? formatTime(u.last_login_at) : '从未登录' }}
                </td>
                <td class="table__actions">
                  <div class="row-actions">
                    <button
                      class="wl-btn wl-btn--ghost wl-btn--xs"
                      :disabled="!canManage(u)"
                      :title="manageTitle(u) || '修改显示名 / 角色 / 状态'"
                      @click="openUserEdit(u)"
                    >
                      编辑
                    </button>
                    <button
                      class="wl-btn wl-btn--ghost wl-btn--xs"
                      :disabled="!canManage(u)"
                      :title="manageTitle(u) || '重置该成员的口令'"
                      @click="openReset(u)"
                    >
                      重置口令
                    </button>
                    <button
                      class="wl-btn wl-btn--ghost wl-btn--xs"
                      :disabled="!canManage(u) || revokingUser === u.id"
                      :title="manageTitle(u) || '吊销该成员的全部会话'"
                      @click="revokeUserSessions(u)"
                    >
                      强制下线
                    </button>
                    <button
                      class="wl-btn wl-btn--xs"
                      :class="u.status === 'disabled' ? 'wl-btn--ghost' : 'wl-btn--danger'"
                      :disabled="!canManage(u)"
                      :title="manageTitle(u) || (u.status === 'disabled' ? '启用该账号' : '停用该账号并踢下线')"
                      @click="toggleUserStatus(u)"
                    >
                      {{ u.status === 'disabled' ? '启用' : '停用' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ============================ 邀请码 ============================ -->
        <div v-else-if="tab === 'invites'">
          <h3 class="panel-title">邀请码</h3>

          <div v-if="newCode" class="invite-new wl-card">
            <div class="invite-new__head">
              <Icon name="check" :size="16" />
              <span>邀请码已生成</span>
            </div>
            <div class="invite-new__row">
              <code class="mono invite-new__code selectable">{{ newCode }}</code>
              <button class="wl-btn" @click="copy(newCode)">
                <Icon name="copy" :size="15" />
                复制
              </button>
            </div>
            <p class="wl-hint">请把邀请码发给受邀成员；离开本页后仍可在下方列表中找到。</p>
          </div>

          <form class="invite-form wl-card" @submit.prevent="submitInvite">
            <div class="invite-form__grid">
              <label class="wl-field">
                <span class="wl-label">角色</span>
                <select v-model="form.role" class="wl-select">
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <label class="wl-field">
                <span class="wl-label">可用次数</span>
                <input v-model.number="form.maxUses" class="wl-input" type="number" min="1" max="999" />
              </label>
              <label class="wl-field">
                <span class="wl-label">有效期（天）</span>
                <input
                  v-model.number="form.expiresInDays"
                  class="wl-input"
                  type="number"
                  min="1"
                  max="365"
                  placeholder="留空为永久"
                />
              </label>
              <label class="wl-field">
                <span class="wl-label">备注</span>
                <input
                  v-model="form.note"
                  class="wl-input"
                  type="text"
                  maxlength="80"
                  placeholder="可选"
                />
              </label>
            </div>
            <div class="invite-form__actions">
              <button type="submit" class="wl-btn wl-btn--primary" :disabled="creating">
                <span v-if="creating" class="wl-spinner"></span>
                <Icon v-else name="plus" :size="16" />
                生成邀请码
              </button>
              <span v-if="createError" class="invite-form__error selectable">{{ createError }}</span>
            </div>
          </form>

          <div v-if="overviewLoading && !overview" class="wl-empty admin-center">
            <span class="wl-spinner"></span>
            <span>正在加载邀请码</span>
          </div>

          <div v-else-if="overviewError && !overview" class="admin__error">
            <Icon name="alert" :size="18" />
            <div class="admin__error-body">
              <p class="admin__error-title">邀请码列表加载失败</p>
              <p class="admin__error-msg selectable">{{ overviewError }}</p>
            </div>
            <button class="wl-btn" @click="loadOverview">
              <Icon name="refresh" :size="15" />
              重试
            </button>
          </div>

          <div v-else-if="invites.length === 0" class="wl-empty admin-center">
            <Icon name="qr" :size="32" />
            <span>还没有邀请码</span>
          </div>

          <table v-else class="table">
            <thead>
              <tr>
                <th>邀请码</th>
                <th>角色</th>
                <th>已用 / 上限</th>
                <th>过期时间</th>
                <th>备注</th>
                <th>状态</th>
                <th class="table__actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="inv in invites"
                :key="inv.code"
                :class="{ 'table__row--muted': isInviteDead(inv) }"
              >
                <td>
                  <div class="invite-code">
                    <code class="mono" :title="inv.code">{{ inv.code }}</code>
                    <button class="wl-icon-btn" title="复制邀请码" @click="copy(inv.code)">
                      <Icon name="copy" :size="15" />
                    </button>
                  </div>
                </td>
                <td>
                  <span class="wl-badge" :class="roleBadge(inv.role)">{{ roleLabel(inv.role) }}</span>
                </td>
                <td class="table__muted">{{ inv.uses }} / {{ inv.max_uses > 0 ? inv.max_uses : '不限' }}</td>
                <td class="table__muted">
                  {{ inv.expires_at ? formatTime(inv.expires_at) : '永久有效' }}
                </td>
                <td class="table__muted">{{ inv.note || '—' }}</td>
                <td>
                  <span v-if="isInviteDead(inv)" class="wl-badge wl-badge--danger">
                    {{ inviteDeadReason(inv) }}
                  </span>
                  <span v-else class="wl-badge wl-badge--success">可用</span>
                </td>
                <td class="table__actions">
                  <button
                    class="wl-btn wl-btn--danger wl-btn--xs"
                    :disabled="revoking === inv.code"
                    title="作废该邀请码，作废后无法再用它注册"
                    @click="revokeInvite(inv)"
                  >
                    作废
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ============================ 审计日志 ============================ -->
        <div v-else-if="tab === 'audit'">
          <div class="audit-head">
            <h3 class="panel-title">审计日志</h3>
            <button class="wl-btn wl-btn--ghost" :disabled="auditLoading" @click="loadAudit(true)">
              <Icon name="refresh" :size="15" />
              刷新
            </button>
          </div>
          <p class="admin__hint">审计记录采用哈希链，任何一条被改动都会导致链校验失败。</p>

          <div v-if="auditLoading && audit.length === 0" class="wl-empty admin-center">
            <span class="wl-spinner"></span>
            <span>正在加载审计日志</span>
          </div>

          <div v-else-if="auditError && audit.length === 0" class="admin__error">
            <Icon name="alert" :size="18" />
            <div class="admin__error-body">
              <p class="admin__error-title">加载失败</p>
              <p class="admin__error-msg selectable">{{ auditError }}</p>
            </div>
            <button class="wl-btn" @click="loadAudit(true)">
              <Icon name="refresh" :size="15" />
              重试
            </button>
          </div>

          <div v-else-if="audit.length === 0" class="wl-empty admin-center">
            <Icon name="shield" :size="32" />
            <span>暂无审计记录</span>
          </div>

          <template v-else>
            <div v-if="auditError" class="admin__error admin__error--inline">
              <Icon name="alert" :size="16" />
              <div class="admin__error-body">
                <p class="admin__error-msg selectable">{{ auditError }}</p>
              </div>
              <button class="wl-btn" @click="loadAudit(true)">
                <Icon name="refresh" :size="15" />
                重试
              </button>
            </div>

            <table class="table table--audit">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>类别</th>
                  <th>动作</th>
                  <th>目标</th>
                  <th>哈希</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in audit" :key="r.seq">
                  <td class="table__mono">{{ r.seq }}</td>
                  <td class="table__muted">{{ formatTime(r.ts) }}</td>
                  <td>{{ actorName(r.actorId) }}</td>
                  <td>
                    <span class="wl-badge" :class="categoryBadge(r.category)">
                      {{ categoryLabel(r.category) }}
                    </span>
                  </td>
                  <td class="table__muted">{{ r.action }}</td>
                  <td class="table__muted">{{ r.target || '—' }}</td>
                  <td>
                    <code class="mono table__hash" :title="r.hash">{{ shortHash(r.hash) }}</code>
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="audit__foot">
              <button
                class="wl-btn"
                :disabled="auditLoading || !auditHasMore"
                @click="loadAudit(false)"
              >
                <span v-if="auditLoading" class="wl-spinner"></span>
                <Icon v-else name="chevron-down" :size="16" />
                {{ auditHasMore ? '加载更多' : '没有更多了' }}
              </button>
            </div>
          </template>
        </div>
      </section>
    </div>

    <!-- ============================ 编辑成员 ============================ -->
    <div v-if="editUser" class="dialog">
      <div class="dialog__backdrop" @click="closeUserEdit" />
      <div class="dialog__panel">
        <h2 class="dialog__title">编辑成员「{{ editUser.username }}」</h2>

        <label class="wl-field">
          <span class="wl-label">显示名</span>
          <input v-model="editDisplayName" class="wl-input" maxlength="64" />
        </label>

        <label class="wl-field">
          <span class="wl-label">角色</span>
          <select v-model="editRole" class="wl-select" :disabled="!isOwner">
            <option value="member">成员</option>
            <option value="admin">管理员</option>
            <option value="owner">创建者</option>
          </select>
          <span v-if="!isOwner" class="wl-hint">只有创建者（owner）可以调整角色。</span>
        </label>

        <label class="wl-field">
          <span class="wl-label">状态</span>
          <select v-model="editStatus" class="wl-select">
            <option value="active">正常</option>
            <option value="disabled">停用（将强制下线）</option>
          </select>
        </label>

        <p v-if="editError" class="form-error selectable">{{ editError }}</p>
        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" :disabled="editSaving" @click="submitUserEdit">
            <span v-if="editSaving" class="wl-spinner"></span>
            保存
          </button>
          <button class="wl-btn wl-btn--ghost" @click="closeUserEdit">取消</button>
        </div>
      </div>
    </div>

    <!-- ============================ 重置口令 ============================ -->
    <div v-if="resetOpen" class="dialog">
      <div class="dialog__backdrop" @click="resetOpen = null" />
      <div class="dialog__panel">
        <h2 class="dialog__title">重置「{{ resetOpen.username }}」的口令</h2>
        <p class="wl-hint">
          重置后该成员的全部会话会立即失效，需要用新口令重新登录。口令不会被记录到任何日志。
        </p>

        <label class="wl-field">
          <span class="wl-label">新口令</span>
          <input v-model="resetPwd" class="wl-input" type="password" autocomplete="new-password" />
        </label>
        <label class="wl-field">
          <span class="wl-label">确认新口令</span>
          <input v-model="resetPwd2" class="wl-input" type="password" autocomplete="new-password" />
        </label>

        <p v-if="resetError" class="form-error selectable">{{ resetError }}</p>
        <div class="dialog__actions">
          <button class="wl-btn wl-btn--primary" :disabled="resetSaving" @click="submitReset">
            <span v-if="resetSaving" class="wl-spinner"></span>
            重置口令
          </button>
          <button class="wl-btn wl-btn--ghost" @click="resetOpen = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  color: var(--text);
}

.admin__copy-sink {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

/* ---------------------------------------------------------------- 权限不足 */

.admin__denied {
  flex: 1;
  gap: var(--space-2);
}

.admin__denied-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
}

.admin__denied-hint {
  margin: 0;
  max-width: 340px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 布局 */

.admin__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.admin__nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  width: 148px;
  padding: var(--space-3) var(--space-2);
  background: var(--surface-2);
  border-right: 1px solid var(--border-subtle);
}

.admin__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.admin__tab:hover {
  background: var(--hover);
  color: var(--text);
}

.admin__tab--active {
  background: var(--selected);
  color: var(--text);
  font-weight: 600;
}

.admin__content {
  flex: 1;
  min-width: 0;
  padding: var(--space-4);
}

.panel-title {
  margin: 0 0 var(--space-3);
  font-size: 14px;
  font-weight: 600;
}

.admin-center {
  min-height: 200px;
}

.admin__hint {
  margin: 0 0 var(--space-3);
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.admin__note {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--text-secondary);
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 存储明细 */

.storagelist {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.storagelist__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 4px 0;
  border-bottom: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
  font-size: 12.5px;
}

.storagelist__row:last-child {
  border-bottom: 0;
}

.storagelist__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storagelist__meta {
  flex: none;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ---------------------------------------------------------------- 统计卡片 */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-3);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
}

.stat__icon {
  display: flex;
  color: var(--accent);
}

.stat__value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat__label {
  font-size: 12px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 卡片 */

.card {
  margin-top: var(--space-4);
  padding: var(--space-4);
}

.card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card__title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.card__meta {
  margin: var(--space-2) 0 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.card__actions {
  margin-top: var(--space-3);
}

.mono {
  font-family: var(--font-mono);
}

/* ---------------------------------------------------------------- 校验结果 */

.verify {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.verify p {
  margin: 0;
}

.verify__body {
  min-width: 0;
}

.verify__detail {
  margin-top: 2px;
}

.verify--ok {
  background: var(--success-soft);
  color: var(--success);
}

.verify--bad {
  background: var(--danger-soft);
  color: var(--danger);
}

/* ---------------------------------------------------------------- 错误块 */

.admin__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
}

.admin__error--inline {
  margin-bottom: var(--space-3);
}

.admin__error-body {
  flex: 1;
  min-width: 0;
}

.admin__error-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.admin__error-msg {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  word-break: break-word;
}

/* ---------------------------------------------------------------- 表格 */

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}

.table tbody tr:hover {
  background: var(--hover);
}

.table__name {
  font-weight: 500;
}

.table__muted {
  color: var(--text-secondary);
}

.table__mono {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.table__hash {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.table__row--muted {
  opacity: 0.5;
}

.table--audit td {
  white-space: nowrap;
}

/* ---------------------------------------------------------------- 邀请码 */

.invite-new {
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  background: var(--success-soft);
  border-color: var(--success);
}

.invite-new__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--success);
  font-size: 13px;
  font-weight: 600;
}

.invite-new__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.invite-new__code {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text);
  word-break: break-all;
}

.invite-form {
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.invite-form__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-3);
}

.invite-form__grid .wl-field {
  margin-bottom: 0;
}

.invite-form__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.invite-form__error {
  font-size: 12.5px;
  color: var(--danger);
}

.invite-code {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.invite-code .mono {
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 审计日志 */

.audit-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.audit-head .panel-title {
  flex: 1;
  margin-bottom: 0;
}

.audit__foot {
  display: flex;
  justify-content: center;
  margin-top: var(--space-4);
  padding-bottom: var(--space-2);
}

/* ---------------------------------------------------------------- 成员操作 */

.table__actions {
  text-align: right;
  white-space: nowrap;
}

.row-actions {
  display: inline-flex;
  gap: var(--space-1);
  justify-content: flex-end;
}

/* 表格里塞得下的紧凑按钮尺寸（基线按钮对表格行偏高） */
.wl-btn--xs {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}

/* ---------------------------------------------------------------- 对话框 */

.dialog {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}

.dialog__panel {
  position: relative;
  width: min(380px, calc(100% - var(--space-6)));
  max-height: calc(100% - var(--space-6));
  overflow-y: auto;
  padding: var(--space-5);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-solid);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.35));
}

.dialog__title {
  margin: 0 0 var(--space-4);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.dialog__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.form-error {
  margin: 0;
  color: var(--danger);
  font-size: 12.5px;
}
</style>
