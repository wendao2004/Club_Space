<!--
  运维应用。

  面向管理员的两件事：绑定/关闭两步验证，以及执行预定义的 Docker 运维操作。

  设计上的两条底线：
  1) 变更类操作（mutating）永远要先过动态口令，本地不缓存、不代填。
  2) 每次执行都把真正跑过的 argv 原样展示出来 —— 管理员看到的应该是"跑了什么"，
     而不是一个需要盲信的按钮。

  只有管理员能进：非管理员直接给"需要管理员权限"的空状态，一个请求都不发。
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { ApiError, api, formatTime } from '@/api'
import type { AdminOperation, OperationResult, TotpStatus } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const auth = useAuth()
const ui = useUi()

type TabId = 'totp' | 'ops'
const tab = ref<TabId>('totp')

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** 动态口令输入框共用的过滤：只留数字、最多 6 位，并回写 DOM 值。 */
type CodeField = 'setup' | 'disable' | 'exec'
function onCodeInput(event: Event, field: CodeField): void {
  const el = event.target as HTMLInputElement
  const cleaned = el.value.replace(/\D/g, '').slice(0, 6)
  if (el.value !== cleaned) el.value = cleaned
  if (field === 'setup') setupCode.value = cleaned
  else if (field === 'disable') disableCode.value = cleaned
  else pendingCode.value = cleaned
}

// ---------------------------------------------------------------- 两步验证

const totpStatus = ref<TotpStatus | null>(null)
const totpLoading = ref(false)
const totpError = ref('')

const setup = ref<{ secret: string; formatted: string; otpauthUrl: string } | null>(null)
const setupCode = ref('')
/**
 * 重新绑定时要提交的**当前**动态口令。
 *
 * 账号已绑定时服务端不允许仅凭会话换掉第二因子（否则拿到会话就能把 2FA
 * 换成自己的），所以这里必须先收集当前验证器上的码。
 * 只在 status.bound 为真时使用。
 */
const reauthCode = ref('')
/** 秘密无法解密时的恢复路径：改用登录口令再认证。 */
const reauthPassword = ref('')
const setupBusy = ref(false)
const setupError = ref('')
const urlInput = ref<HTMLInputElement | null>(null)

const disableOpen = ref(false)
const disableCode = ref('')
const disableBusy = ref(false)
const disableError = ref('')

async function loadTotp(showSpinner: boolean): Promise<void> {
  if (showSpinner) {
    totpLoading.value = true
    totpError.value = ''
  }
  try {
    totpStatus.value = await api.ops.totpStatus()
    totpError.value = ''
  } catch (err) {
    totpError.value = messageOf(err)
  } finally {
    totpLoading.value = false
  }
}

async function startSetup(): Promise<void> {
  if (setupBusy.value) return

  // 已绑定时必须先证明对现有第二因子的占有。
  //   · 正常情况  → 提交当前验证器上的 6 位码（**登录口令不能替代**，
  //                否则口令泄漏就等于 2FA 失效）
  //   · 秘密损坏  → 第二因子已无法验证，只能用登录口令恢复
  if (totpStatus.value?.bound && !totpStatus.value.broken && reauthCode.value.trim().length !== 6) {
    setupError.value = '请先填入当前验证器上的 6 位动态口令'
    return
  }
  if (totpStatus.value?.broken && reauthPassword.value.length === 0) {
    setupError.value = '请输入登录口令以完成恢复绑定'
    return
  }

  setupBusy.value = true
  setupError.value = ''
  try {
    const reauth = totpStatus.value?.broken
      ? { password: reauthPassword.value }
      : totpStatus.value?.bound
        ? { currentCode: reauthCode.value.trim() }
        : {}
    setup.value = await api.ops.totpSetup(reauth)
    setupCode.value = ''
  } catch (err) {
    // 面板还没展开，错误只能靠 toast 告知。
    ui.notify('error', '无法开始绑定', messageOf(err))
    setupError.value = messageOf(err)
  } finally {
    setupBusy.value = false
  }
}

function cancelSetup(): void {
  // 丢掉这次绑定：秘密只在内存里，收起面板即作废。
  setup.value = null
  setupCode.value = ''
  setupError.value = ''
  reauthCode.value = ''
  reauthPassword.value = ''
}

async function confirmEnable(): Promise<void> {
  if (setupBusy.value) return
  setupBusy.value = true
  setupError.value = ''
  try {
    const reauth = totpStatus.value?.broken
      ? { password: reauthPassword.value }
      : totpStatus.value?.bound
        ? { currentCode: reauthCode.value.trim() }
        : {}
    await api.ops.totpEnable(setupCode.value, reauth)
    setup.value = null
    setupCode.value = ''
    reauthCode.value = ''
    reauthPassword.value = ''
    ui.notify('success', '两步验证已启用')
    await loadTotp(false)
  } catch (err) {
    setupError.value = messageOf(err)
  } finally {
    setupBusy.value = false
  }
}

function openDisable(): void {
  disableOpen.value = true
  disableCode.value = ''
  disableError.value = ''
}

function cancelDisable(): void {
  disableOpen.value = false
  disableCode.value = ''
  disableError.value = ''
}

async function confirmDisable(): Promise<void> {
  if (disableBusy.value) return
  disableBusy.value = true
  disableError.value = ''
  try {
    await api.ops.totpDisable(disableCode.value)
    disableOpen.value = false
    disableCode.value = ''
    ui.notify('success', '两步验证已关闭')
    await loadTotp(false)
  } catch (err) {
    // 失败时保持绑定状态，只把后端真实 message 显示出来。
    disableError.value = messageOf(err)
  } finally {
    disableBusy.value = false
  }
}

async function copyUrl(): Promise<void> {
  const text = setup.value?.otpauthUrl ?? ''
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    ui.notify('success', '链接已复制')
  } catch {
    // 非安全上下文或权限被拒：退化成"选中文本"，让用户手动 Ctrl+C。
    const el = urlInput.value
    if (el) {
      el.focus()
      el.select()
    }
    ui.notify('warning', '复制失败', '已选中链接，请按 Ctrl+C 手动复制')
  }
}

// ---------------------------------------------------------------- 运维操作

interface OpsInfo {
  enabled: boolean
  allowedServices: string[]
  templatesDir: string
  operations: AdminOperation[]
}

interface ParamField {
  key: string
  type: string
  value: string
}

interface ExecState {
  busy: boolean
  error: string
  result: OperationResult | null
}

interface OpRow {
  op: AdminOperation
  fields: ParamField[]
  state: ExecState
}

const opsInfo = ref<OpsInfo | null>(null)
const opsLoading = ref(false)
const opsError = ref('')
const opsLoaded = ref(false)

const opFields = reactive<Record<string, ParamField[]>>({})
const execState = reactive<Record<string, ExecState>>({})

const allowedServices = computed<string[]>(() => opsInfo.value?.allowedServices ?? [])

function fieldsFor(op: AdminOperation): ParamField[] {
  const existing = opFields[op.id]
  if (existing) return existing
  const created: ParamField[] = Object.entries(op.params).map(([key, type]) => {
    let value = ''
    if (type === 'lines') value = '100'
    else if (type === 'service') value = allowedServices.value[0] ?? ''
    return { key, type, value }
  })
  opFields[op.id] = created
  return created
}

function stateFor(op: AdminOperation): ExecState {
  const existing = execState[op.id]
  if (existing) return existing
  const created: ExecState = { busy: false, error: '', result: null }
  execState[op.id] = created
  return created
}

function toRow(op: AdminOperation): OpRow {
  return { op, fields: fieldsFor(op), state: stateFor(op) }
}

const readOnlyRows = computed<OpRow[]>(() =>
  (opsInfo.value?.operations ?? []).filter((o) => !o.mutating).map(toRow),
)
const mutatingRows = computed<OpRow[]>(() =>
  (opsInfo.value?.operations ?? []).filter((o) => o.mutating).map(toRow),
)

const groups = computed<Array<{ key: string; title: string; rows: OpRow[] }>>(() => [
  { key: 'read', title: '只读操作', rows: readOnlyRows.value },
  { key: 'mut', title: '变更操作', rows: mutatingRows.value },
])

function isTemplateOp(op: AdminOperation): boolean {
  return Object.values(op.params).some((type) => type === 'template')
}

/** 必填参数没填（或数字非法）时禁用执行按钮。 */
function missingParams(op: AdminOperation): boolean {
  for (const field of fieldsFor(op)) {
    const raw = field.value.trim()
    if (raw === '') return true
    if (field.type === 'lines') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return true
    }
  }
  return false
}

function paramsFor(op: AdminOperation): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fieldsFor(op)) out[field.key] = field.value
  return out
}

async function loadOps(showSpinner: boolean): Promise<void> {
  if (showSpinner) {
    opsLoading.value = true
    opsError.value = ''
  }
  try {
    const info = await api.ops.operations()
    opsInfo.value = info
    // 先把每个操作的字段/执行状态建好，渲染期就只读不写。
    for (const op of info.operations) {
      fieldsFor(op)
      stateFor(op)
    }
    opsLoaded.value = true
    opsError.value = ''
  } catch (err) {
    opsError.value = messageOf(err)
  } finally {
    opsLoading.value = false
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadTotp(false), loadOps(false)])
}

const pending = ref<AdminOperation | null>(null)
const pendingCode = ref('')
const pendingBusy = ref(false)
const pendingError = ref('')

function requestExecute(op: AdminOperation): void {
  if (!opsInfo.value?.enabled) return
  if (op.mutating) {
    // 变更类操作一律先要动态口令，绝不直接执行。
    pending.value = op
    pendingCode.value = ''
    pendingError.value = ''
    return
  }
  void runExecute(op)
}

function cancelPending(): void {
  pending.value = null
  pendingCode.value = ''
  pendingError.value = ''
  pendingBusy.value = false
}

function confirmExec(): void {
  if (!pending.value || pendingBusy.value) return
  pendingBusy.value = true
  void runExecute(pending.value, pendingCode.value)
}

async function runExecute(op: AdminOperation, code?: string): Promise<void> {
  const state = stateFor(op)
  state.busy = true
  state.error = ''
  try {
    const result = await api.ops.execute(op.id, paramsFor(op), code)
    state.result = result
    pending.value = null
    ui.notify(
      result.exitCode === 0 ? 'success' : 'error',
      result.exitCode === 0 ? `${op.label} 已执行` : `${op.label} 执行失败`,
      result.timedOut ? '命令超时' : undefined,
    )
  } catch (err) {
    const msg = messageOf(err)
    // 口令错误发生在弹窗里，错误就地显示、弹窗不关。
    if (pending.value) pendingError.value = msg
    else state.error = msg
  } finally {
    state.busy = false
    pendingBusy.value = false
  }
}

function exitBadgeClass(result: OperationResult): string {
  if (result.timedOut) return 'wl-badge--warning'
  return result.exitCode === 0 ? 'wl-badge--success' : 'wl-badge--danger'
}

function exitLabel(result: OperationResult): string {
  if (result.timedOut) return '超时'
  return result.exitCode === 0 ? '成功' : `失败（退出码 ${result.exitCode}）`
}

// ---------------------------------------------------------------- 生命周期

function selectTab(id: TabId): void {
  tab.value = id
  if (id === 'ops' && !opsLoaded.value) void loadOps(true)
}

onMounted(() => {
  if (auth.isAdmin) void loadTotp(true)
})
</script>

<template>
  <div class="ops" :data-window-id="props.win.id">
    <!-- 非管理员：一个请求都不发 -->
    <div v-if="!auth.isAdmin" class="wl-empty ops__denied">
      <Icon name="shield" :size="44" />
      <div class="ops__denied-title">需要管理员权限</div>
      <div class="ops__denied-sub">运维应用只对管理员与所有者开放</div>
    </div>

    <template v-else>
      <nav class="ops__tabs">
        <button
          class="ops__tab"
          :class="{ 'ops__tab--active': tab === 'totp' }"
          type="button"
          @click="selectTab('totp')"
        >
          <Icon name="shield" :size="16" />
          <span>两步验证</span>
        </button>
        <button
          class="ops__tab"
          :class="{ 'ops__tab--active': tab === 'ops' }"
          type="button"
          @click="selectTab('ops')"
        >
          <Icon name="terminal" :size="16" />
          <span>运维操作</span>
        </button>
      </nav>

      <div class="ops__body wl-scroll">
        <!-- ============================ 标签页 1：两步验证 ============================ -->
        <section v-if="tab === 'totp'" class="ops__section">
          <div v-if="totpLoading && !totpStatus" class="wl-empty">
            <span class="wl-spinner" />
            <span>正在读取状态</span>
          </div>

          <div v-else-if="totpError" class="wl-empty">
            <Icon name="alert" :size="30" />
            <div>{{ totpError }}</div>
            <button class="wl-btn" type="button" @click="loadTotp(true)">重试</button>
          </div>

          <template v-else-if="totpStatus">
            <!-- 异常状态必须在界面上明确暴露，不能静默 -->
            <div v-if="totpStatus.broken" class="ops__alert ops__alert--danger">
              <Icon name="alert" :size="18" />
              <div>
                <div class="ops__alert-title">两步验证无法解密</div>
                <p class="ops__alert-text">
                  两步验证已绑定但无法解密，通常是 WL_SESSION_SECRET 被更换过。在这种情况下所有变更类操作都会被拒绝。请关闭后重新绑定。
                </p>
              </div>
            </div>

            <div class="wl-card ops__status">
              <div class="ops__status-head">
                <span
                  class="wl-badge"
                  :class="totpStatus.bound ? 'wl-badge--success' : ''"
                >
                  {{ totpStatus.bound ? '已绑定' : '未绑定' }}
                </span>
                <span
                  v-if="totpStatus.bound && totpStatus.enabledAt"
                  class="ops__status-time"
                >
                  启用时间 {{ formatTime(totpStatus.enabledAt) }}
                </span>
              </div>

              <p v-if="!totpStatus.bound" class="ops__note">
                变更类运维操作（启动/停止服务、安装扩展）要求先绑定两步验证。绑定后即使登录口令泄漏，攻击者也无法操作你的 NAS。
              </p>

              <div class="ops__status-actions">
                <!--
                  三种情况各有入口，缺一不可：
                    · 未绑定        → 「开始绑定」
                    · 已绑定且正常  → 「重新绑定」（服务端要求先给当前动态口令）
                    · 已绑定但损坏  → 「恢复绑定」（秘密解不开时只能用登录口令）
                  最初只在"未绑定"时给了按钮，于是后两种在界面上根本走不到 ——
                  服务端加了门禁，前端却连入口都没有。
                -->
                <button
                  v-if="!totpStatus.bound"
                  class="wl-btn wl-btn--primary"
                  type="button"
                  :disabled="setupBusy || setup !== null"
                  @click="startSetup"
                >
                  <Icon name="shield" :size="16" />
                  开始绑定
                </button>
                <button
                  v-else-if="totpStatus.broken"
                  class="wl-btn wl-btn--primary"
                  type="button"
                  :disabled="setupBusy || setup !== null"
                  @click="startSetup"
                >
                  <Icon name="shield" :size="16" />
                  恢复绑定
                </button>
                <button
                  v-else
                  class="wl-btn"
                  type="button"
                  :disabled="setupBusy || setup !== null"
                  @click="startSetup"
                >
                  <Icon name="shield" :size="16" />
                  重新绑定
                </button>
                <button
                  v-if="totpStatus.bound && !totpStatus.broken"
                  class="wl-btn"
                  type="button"
                  :disabled="disableBusy || disableOpen"
                  @click="openDisable"
                >
                  关闭两步验证
                </button>
              </div>

              <div v-if="disableOpen" class="ops__disable">
                <label class="wl-label">输入当前动态口令以关闭</label>
                <div class="ops__row">
                  <input
                    class="wl-input ops__code"
                    type="text"
                    inputmode="numeric"
                    maxlength="6"
                    autocomplete="one-time-code"
                    placeholder="000000"
                    :value="disableCode"
                    @input="onCodeInput($event, 'disable')"
                  />
                  <button
                    class="wl-btn"
                    type="button"
                    :disabled="disableBusy"
                    @click="cancelDisable"
                  >
                    取消
                  </button>
                  <button
                    class="wl-btn wl-btn--danger"
                    type="button"
                    :disabled="disableBusy || disableCode.length !== 6"
                    @click="confirmDisable"
                  >
                    确认关闭
                  </button>
                </div>
                <p v-if="disableError" class="ops__error">{{ disableError }}</p>
              </div>
            </div>

            <!-- 绑定引导面板 -->
            <div v-if="setup" class="wl-card ops__setup">
              <h3 class="ops__card-title">
                <Icon name="shield" :size="16" />
                {{ totpStatus.bound ? '重新绑定两步验证' : '绑定两步验证' }}
              </h3>
              <p class="ops__note">
                在验证器 App（如 Google Authenticator、微软 Authenticator、1Password）里选择「手动输入密钥」，填入下面的密钥；或把链接粘贴进支持 otpauth 的 App。
              </p>

              <div class="wl-field">
                <label class="wl-label">账户名 = {{ auth.user?.username ?? '你的用户名' }}，发行方 = 社团空间</label>
                <div class="ops__secret selectable">{{ setup.formatted }}</div>
                <div class="wl-hint">密钥仅在本次绑定中出现，收起面板后无法再次查看。</div>
              </div>

              <div class="wl-field">
                <label class="wl-label">otpauth 链接</label>
                <div class="ops__row">
                  <input
                    ref="urlInput"
                    class="wl-input ops__url selectable"
                    type="text"
                    readonly
                    :value="setup.otpauthUrl"
                  />
                  <button class="wl-btn" type="button" @click="copyUrl">
                    <Icon name="copy" :size="16" />
                    复制
                  </button>
                </div>
              </div>

              <!--
                重新绑定需要先证明身份。这是服务端的强制要求，也是 2FA 的意义所在：
                否则任何拿到会话的人都能把第二因子换成自己的。
              -->
              <div v-if="totpStatus.bound && !totpStatus.broken" class="wl-field">
                <label class="wl-label">当前验证器上的 6 位数字（用于证明身份）</label>
                <input
                  v-model="reauthCode"
                  class="wl-input ops__code"
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="当前口令"
                />
                <p class="wl-hint">
                  出于安全考虑，登录口令**不能**替代这个动态口令 —— 否则口令泄漏就等于两步验证失效。
                </p>
              </div>

              <div v-if="totpStatus.broken" class="wl-field">
                <label class="wl-label">登录口令（用于恢复绑定）</label>
                <input
                  v-model="reauthPassword"
                  class="wl-input"
                  type="password"
                  autocomplete="current-password"
                  placeholder="你的登录口令"
                />
                <p class="wl-hint">
                  两步验证的秘密已无法解密（通常是 WL_SESSION_SECRET 被更换过），
                  此时第二因子已无法验证，只能用登录口令完成恢复。
                </p>
              </div>

              <div class="wl-field">
                <label class="wl-label">验证器当前显示的 6 位数字</label>
                <input
                  class="wl-input ops__code"
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  autocomplete="one-time-code"
                  placeholder="000000"
                  :value="setupCode"
                  @input="onCodeInput($event, 'setup')"
                />
              </div>

              <p v-if="setupError" class="ops__error">{{ setupError }}</p>

              <div class="ops__actions">
                <button class="wl-btn" type="button" :disabled="setupBusy" @click="cancelSetup">
                  取消
                </button>
                <button
                  class="wl-btn wl-btn--primary"
                  type="button"
                  :disabled="setupBusy || setupCode.length !== 6"
                  @click="confirmEnable"
                >
                  确认启用
                </button>
              </div>
            </div>

            <!-- 安全说明 -->
            <div class="wl-card ops__security">
              <h3 class="ops__card-title">
                <Icon name="shield" :size="16" />
                为什么运维操作要加这一步
              </h3>
              <ul class="ops__bullets">
                <li>
                  能操作 Docker 等于能拿到 NAS 的最高权限（起一个挂载宿主根目录的容器即可）。所以变更类操作要求两步验证。
                </li>
                <li>
                  本平台<strong>不提供网页版任意命令终端</strong>。所有运维操作都是预先定义好的固定动作（启动/停止指定服务、按模板安装扩展），参数只能从白名单里选。这样做是因为“允许输入命令再拦截危险命令”永远能被绕过，而枚举操作是可证明安全的。
                </li>
                <li>每次执行（包括被拒绝的尝试）都会写入审计日志。</li>
              </ul>
            </div>
          </template>
        </section>

        <!-- ============================ 标签页 2：运维操作 ============================ -->
        <section v-else class="ops__section">
          <div class="ops__bar">
            <div class="ops__bar-heading">
              <Icon name="terminal" :size="16" />
              <span class="ops__bar-title">运维操作</span>
            </div>
            <button
              class="wl-icon-btn"
              type="button"
              title="刷新"
              :disabled="opsLoading"
              @click="refreshAll"
            >
              <Icon name="refresh" :size="16" />
            </button>
          </div>

          <div v-if="opsInfo && !opsInfo.enabled" class="ops__alert ops__alert--warning">
            <Icon name="alert" :size="18" />
            <div>
              <div class="ops__alert-title">运维管控未启用</div>
              <p class="ops__alert-text">
                需要在 NAS 的 <code>deploy/.env</code> 里设置 <code>WL_ADMIN_DOCKER_ENABLED=1</code>，
                再用 <code>docker compose --profile admin up -d</code> 启动
                <code>ops-runner</code> 执行器（它默认不启动）。
              </p>
              <p class="ops__alert-text">
                两步验证不需要环境变量：每位管理员在「运维 → 两步验证」里各自绑定。
                注意 <code>docker compose restart</code> 不会重读 <code>.env</code>，必须 <code>up -d</code> 重建容器。
              </p>
            </div>
          </div>

          <div v-if="opsLoading && !opsInfo" class="wl-empty">
            <span class="wl-spinner" />
            <span>正在加载操作清单</span>
          </div>

          <div v-else-if="opsError" class="wl-empty">
            <Icon name="alert" :size="30" />
            <div>{{ opsError }}</div>
            <button class="wl-btn" type="button" @click="loadOps(true)">重试</button>
          </div>

          <div
            v-else-if="opsInfo && opsInfo.operations.length === 0"
            class="wl-empty"
          >
            <Icon name="tools" :size="30" />
            <div>没有可用的运维操作</div>
          </div>

          <template v-else-if="opsInfo">
            <div v-for="group in groups" :key="group.key" class="ops__group">
              <template v-if="group.rows.length">
                <div class="ops__group-title">{{ group.title }}</div>

                <div v-for="row in group.rows" :key="row.op.id" class="wl-card ops__opcard">
                  <div class="ops__ophead">
                    <div class="ops__opmeta">
                      <div class="ops__oplabel">{{ row.op.label }}</div>
                      <div class="ops__opdesc">{{ row.op.description }}</div>
                    </div>
                    <span v-if="row.op.mutating" class="wl-badge wl-badge--warning">需动态口令</span>
                  </div>

                  <div v-if="row.fields.length" class="ops__params">
                    <div v-for="field in row.fields" :key="field.key" class="wl-field ops__param">
                      <label class="wl-label">{{ field.key }}</label>
                      <select
                        v-if="field.type === 'service'"
                        v-model="field.value"
                        class="wl-input"
                      >
                        <option v-for="service in allowedServices" :key="service" :value="service">
                          {{ service }}
                        </option>
                      </select>
                      <input
                        v-else-if="field.type === 'lines'"
                        v-model="field.value"
                        class="wl-input"
                        type="number"
                        min="1"
                      />
                      <input
                        v-else
                        v-model="field.value"
                        class="wl-input ops__url"
                        type="text"
                        placeholder="模板文件名（.yml）"
                      />
                    </div>
                  </div>

                  <div class="ops__opactions">
                    <button
                      class="wl-btn wl-btn--primary"
                      type="button"
                      :disabled="!opsInfo.enabled || row.state.busy || missingParams(row.op)"
                      @click="requestExecute(row.op)"
                    >
                      <span v-if="row.state.busy" class="wl-spinner" />
                      <span v-else>执行</span>
                    </button>
                    <span v-if="!opsInfo.enabled" class="wl-hint">运维管控未启用，暂不可执行</span>
                  </div>

                  <p v-if="row.state.error" class="ops__error">{{ row.state.error }}</p>

                  <div v-if="row.state.result" class="ops__result">
                    <div class="ops__result-head">
                      <span class="wl-badge" :class="exitBadgeClass(row.state.result)">
                        {{ exitLabel(row.state.result) }}
                      </span>
                    </div>

                    <div class="ops__argv">
                      <span class="ops__argv-label">实际执行</span>
                      <code class="ops__argv-text selectable">{{ row.state.result.argv.join(' ') }}</code>
                    </div>

                    <div class="ops__streams">
                      <div class="ops__stream">
                        <div class="ops__stream-title">stdout</div>
                        <pre class="ops__pre selectable">{{ row.state.result.stdout || '（无输出）' }}</pre>
                      </div>
                      <div class="ops__stream">
                        <div class="ops__stream-title">stderr</div>
                        <pre class="ops__pre selectable">{{ row.state.result.stderr || '（无输出）' }}</pre>
                      </div>
                    </div>
                  </div>

                  <p v-if="isTemplateOp(row.op)" class="wl-hint">
                    模板文件放在 NAS 的 {{ opsInfo.templatesDir }} 目录下，每个 .yml 是一个可安装的扩展。模板由管理员自行放置，不会从网络下载。
                  </p>
                </div>
              </template>
            </div>
          </template>
        </section>
      </div>
    </template>

    <!-- 变更操作执行前的动态口令弹窗 -->
    <div v-if="pending" class="ops__modal">
      <div class="ops__modal-card">
        <h3 class="ops__card-title">
          <Icon name="shield" :size="16" />
          动态口令
        </h3>
        <p class="ops__note">
          执行「{{ pending.label }}」需要输入验证器当前的 6 位动态口令。
        </p>
        <input
          class="wl-input ops__code"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          placeholder="000000"
          :value="pendingCode"
          @input="onCodeInput($event, 'exec')"
        />
        <p v-if="pendingError" class="ops__error">{{ pendingError }}</p>
        <div class="ops__actions">
          <button class="wl-btn" type="button" :disabled="pendingBusy" @click="cancelPending">
            取消
          </button>
          <button
            class="wl-btn wl-btn--primary"
            type="button"
            :disabled="pendingBusy || pendingCode.length !== 6"
            @click="confirmExec"
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ops {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-1);
  color: var(--text);
  font-family: var(--font-ui);
}

.ops__denied {
  flex: 1;
}

.ops__denied-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.ops__denied-sub {
  font-size: 13px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 标签页 */

.ops__tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.ops__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  transition: color var(--dur-fast) var(--ease-out);
}

.ops__tab:hover {
  color: var(--text);
}

.ops__tab--active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.ops__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
}

.ops__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ---------------------------------------------------------------- 提示条 */

.ops__alert {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  color: var(--text);
}

.ops__alert--danger {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
}

.ops__alert--warning {
  background: var(--warning-soft);
  border-color: var(--warning);
  color: var(--warning);
}

.ops__alert-title {
  font-weight: 600;
  margin-bottom: var(--space-1);
}

.ops__alert-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* 两段说明之间留一点空，避免读成一坨 */
.ops__alert-text + .ops__alert-text {
  margin-top: var(--space-2);
}

.ops__alert-text code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-sunken, rgba(127, 127, 127, 0.14));
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
  color: var(--text);
}

/* ---------------------------------------------------------------- 状态卡片 */

.ops__status {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.ops__status-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.ops__status-time {
  font-size: 13px;
  color: var(--text-secondary);
}

.ops__note {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.ops__status-actions {
  display: flex;
  gap: var(--space-2);
}

.ops__card-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

/* ---------------------------------------------------------------- 关闭流程 */

.ops__disable {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
}

/* ---------------------------------------------------------------- 绑定面板 */

.ops__setup {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.ops__secret {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-solid);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 16px;
  letter-spacing: 2px;
  word-break: break-all;
  color: var(--text);
}

.ops__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.ops__url {
  font-family: var(--font-mono);
  font-size: 12px;
}

.ops__code {
  width: 160px;
  font-family: var(--font-mono);
  font-size: 18px;
  letter-spacing: 6px;
  text-align: center;
}

.ops__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.ops__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
  word-break: break-word;
}

/* ---------------------------------------------------------------- 安全说明 */

.ops__security {
  padding: var(--space-4);
}

.ops__bullets {
  margin: var(--space-3) 0 0;
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.ops__bullets strong {
  color: var(--text);
}

/* ---------------------------------------------------------------- 操作清单 */

.ops__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ops__bar-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.ops__bar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.ops__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ops__group-title {
  margin-top: var(--space-2);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.ops__opcard {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.ops__ophead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ops__opmeta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ops__oplabel {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.ops__opdesc {
  font-size: 13px;
  color: var(--text-secondary);
}

.ops__params {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-3);
  align-items: end;
}

.ops__param {
  margin-bottom: 0;
}

.ops__opactions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* ---------------------------------------------------------------- 执行结果 */

.ops__result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.ops__result-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.ops__argv {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ops__argv-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.ops__argv-text {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-solid);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
}

.ops__streams {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-3);
}

.ops__stream {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ops__stream-title {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
}

.ops__pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-solid);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------------------------------------------------------------- 口令弹窗 */

.ops__modal {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--surface-1);
  backdrop-filter: blur(3px);
}

.ops__modal-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  max-width: 360px;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-popup);
}
</style>
