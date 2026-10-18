<!--
  设置应用。

  左侧纵向标签页 + 右侧内容区，四个页签：外观 / 账号 / 安全 / 存储。
  可以通过 win.args.tab 指定初始页签（任务栏头像按钮就以 tab=account 打开本应用）。

  几条刻意的设计立场：
    - 安全页如实呈现当前环境具备与不具备的能力，不做粉饰也不静默降级：
      非安全上下文下，浏览器确实没有摄像头/麦克风/通知/剪贴板/Web Crypto 这些能力。
    - 存储页需要管理员数据，普通成员会拿到 401 —— 此时给出"仅管理员可查看"的
      说明，而不是把后端错误原样抛给用户。
    - 颜色一律走 CSS 变量，明暗主题下都成立。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, ApiError, formatBytes, type CurrentUser } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useWindows, type WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const ui = useUi()
const auth = useAuth()
const windows = useWindows()

// ---------------------------------------------------------------- 标签页

type TabId = 'appearance' | 'account' | 'security' | 'storage'

interface TabDef {
  id: TabId
  label: string
  icon: string
}

const tabs: TabDef[] = [
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'account', label: '账号', icon: 'user' },
  { id: 'security', label: '安全', icon: 'shield' },
  { id: 'storage', label: '存储', icon: 'db' },
]

/** 把 win.args.tab 归一化成合法页签，非法值回落到"外观"。 */
function resolveTab(value: unknown): TabId {
  return tabs.some((tab) => tab.id === value) ? (value as TabId) : 'appearance'
}

const activeTab = ref<TabId>(resolveTab(props.win.args.tab))

// settings 是单例窗口：再次打开时会更新 args 而不是新建组件，
// 所以这里要跟着 args 变化切页签，否则任务栏头像点第二次没反应。
watch(
  () => props.win.args.tab,
  (value) => {
    activeTab.value = resolveTab(value)
  },
)

// ---------------------------------------------------------------- 外观

const themes: Array<{ id: 'dark' | 'light'; label: string; icon: string }> = [
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'light', label: '浅色', icon: 'sun' },
]

const wallpapers = [0, 1, 2, 3]

function chooseTheme(id: 'dark' | 'light'): void {
  ui.setTheme(id)
}

function chooseWallpaper(index: number): void {
  ui.setWallpaper(index)
}

function resetLayout(): void {
  windows.clearLayout()
  ui.notify('info', '已恢复默认窗口布局', '下次刷新页面后生效')
}

// ---------------------------------------------------------------- 账号

const user = computed<CurrentUser | null>(() => auth.user)

const ROLE_LABEL: Record<CurrentUser['role'], string> = {
  owner: '创建者',
  admin: '管理员',
  member: '成员',
}

const avatarText = computed(() => {
  const name = user.value?.displayName ?? user.value?.username ?? '?'
  return name.slice(0, 1).toUpperCase()
})

const loggingOut = ref(false)

async function logout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
    ui.notify('success', '已退出登录')
  } catch (err) {
    ui.notify('error', '退出登录失败', err instanceof Error ? err.message : String(err))
  } finally {
    loggingOut.value = false
  }
}

// ---------------------------------------------------------------- 账号 · 改资料 / 改口令

const displayName = ref('')
// 用户信息可能在打开设置之后才加载完，跟着同步一次输入框初值
watch(
  () => user.value?.displayName,
  (name) => {
    displayName.value = name ?? ''
  },
  { immediate: true },
)

const savingName = ref(false)

async function saveDisplayName(): Promise<void> {
  const name = displayName.value.trim()
  if (!name) {
    ui.notify('error', '显示名不能为空')
    return
  }
  savingName.value = true
  try {
    const { user: updated } = await api.updateMe({ displayName: name })
    // 会话里的显示名已经变了，本地状态同步一下，任务栏/头像才会立刻跟着变
    auth.user = updated
    ui.notify('success', '显示名已更新', updated.displayName)
  } catch (err) {
    ui.notify('error', '保存失败', err instanceof Error ? err.message : String(err))
  } finally {
    savingName.value = false
  }
}

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const savingPassword = ref(false)

async function savePassword(): Promise<void> {
  if (!oldPassword.value) {
    ui.notify('error', '请输入当前口令')
    return
  }
  if (newPassword.value.length < 8) {
    ui.notify('error', '新口令至少 8 位')
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    ui.notify('error', '两次输入的新口令不一致')
    return
  }
  savingPassword.value = true
  try {
    await api.changePassword({ oldPassword: oldPassword.value, newPassword: newPassword.value })
    // 服务端已吊销本用户的全部会话（含当前这个），所以这里必须回到登录页。
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    ui.notify('success', '口令已修改', '为安全起见，请用新口令重新登录')
    auth.handleUnauthorized()
  } catch (err) {
    ui.notify('error', '修改口令失败', err instanceof Error ? err.message : String(err))
  } finally {
    savingPassword.value = false
  }
}

// ---------------------------------------------------------------- 安全

const secure = window.isSecureContext
const serviceWorkerOk = 'serviceWorker' in navigator

/** 非安全上下文下确实用不了的能力，逐条列出而不是含糊带过。 */
const blockedCapabilities = [
  '摄像头、麦克风与屏幕共享',
  '系统通知与后台任务',
  '剪贴板读写',
  '安装为桌面应用（PWA）',
  '文件哈希秒传（Web Crypto）',
]

/** 引导页：与当前主机同址的 8080 端口（部署时由 nginx 提供明文引导页）。 */
const onboardUrl = `http://${window.location.hostname}:8080/onboard`

// ---------------------------------------------------------------- 存储

type AdminOverview = Awaited<ReturnType<typeof api.adminOverview>>

const overview = ref<AdminOverview | null>(null)
const storageLoading = ref(false)
const storageError = ref<string | null>(null)
const storageForbidden = ref(false)
const storageLoaded = ref(false)

async function loadStorage(): Promise<void> {
  storageLoading.value = true
  storageError.value = null
  try {
    overview.value = await api.adminOverview()
    storageForbidden.value = false
  } catch (err) {
    overview.value = null
    // 普通成员没有管理数据权限，后端返回 401/403 —— 这是预期情况，不是"出错"。
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      storageForbidden.value = true
    } else {
      storageForbidden.value = false
      storageError.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    storageLoading.value = false
    storageLoaded.value = true
  }
}

// 切到存储页才拉数据（懒加载），避免一打开设置就打管理接口。
watch(
  activeTab,
  (tab) => {
    if (tab === 'storage' && !storageLoaded.value && !storageLoading.value) {
      void loadStorage()
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="settings">
    <div class="settings__frame">
      <!-- 左：纵向标签页 -->
      <nav class="settings__nav">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="settings__tab"
          :class="{ 'settings__tab--active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <Icon :name="tab.icon" :size="16" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <!-- 右：内容区 -->
      <section class="settings__content wl-scroll">
        <!-- ============================ 外观 ============================ -->
        <template v-if="activeTab === 'appearance'">
          <div class="settings__head">
            <h2>外观</h2>
            <p>主题与壁纸仅影响本机显示，保存在浏览器本地。</p>
          </div>

          <div class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">主题</div>
              <div class="wl-hint">选择界面明暗外观，立即生效。</div>
            </div>
            <div class="theme-grid">
              <button
                v-for="item in themes"
                :key="item.id"
                class="theme-opt"
                :class="[`theme-opt--${item.id}`, { 'theme-opt--active': ui.theme === item.id }]"
                @click="chooseTheme(item.id)"
              >
                <span class="theme-opt__preview">
                  <span class="theme-opt__bar" />
                  <span class="theme-opt__body">
                    <span class="theme-opt__accent" />
                  </span>
                </span>
                <span class="theme-opt__meta">
                  <Icon :name="item.icon" :size="15" />
                  <span>{{ item.label }}</span>
                </span>
                <span v-if="ui.theme === item.id" class="theme-opt__check">
                  <Icon name="check" :size="13" />
                </span>
              </button>
            </div>
          </div>

          <div class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">壁纸</div>
              <div class="wl-hint">点击缩略图即可切换桌面背景。</div>
            </div>
            <div class="wp-grid">
              <button
                v-for="n in wallpapers"
                :key="n"
                class="wp-opt"
                :class="[`wp-opt--${n}`, { 'wp-opt--active': ui.wallpaper === n }]"
                :title="`壁纸 ${n + 1}`"
                @click="chooseWallpaper(n)"
              >
                <span v-if="ui.wallpaper === n" class="wp-opt__check">
                  <Icon name="check" :size="12" />
                </span>
              </button>
            </div>
          </div>

          <div class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">窗口布局</div>
              <div class="wl-hint">清除已保存的窗口位置与大小，恢复为默认的层叠排列。</div>
            </div>
            <button class="wl-btn" @click="resetLayout">
              <Icon name="refresh" :size="15" />
              恢复默认窗口布局
            </button>
          </div>
        </template>

        <!-- ============================ 账号 ============================ -->
        <template v-else-if="activeTab === 'account'">
          <div class="settings__head">
            <h2>账号</h2>
            <p>当前登录的社团账号信息。</p>
          </div>

          <div v-if="user" class="wl-card settings__card">
            <div class="profile">
              <div class="profile__avatar">{{ avatarText }}</div>
              <div class="profile__info">
                <div class="profile__name selectable">{{ user.displayName }}</div>
                <div class="profile__username selectable">@{{ user.username }}</div>
                <div class="profile__role">
                  <span class="wl-badge wl-badge--accent">{{ ROLE_LABEL[user.role] }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="wl-card settings__card">
            <div class="wl-empty">
              <Icon name="user" :size="28" />
              <div>当前处于未登录状态</div>
            </div>
          </div>

          <!-- 改显示名 -->
          <div v-if="user" class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">修改显示名</div>
              <div class="wl-hint">显示名是别人在聊天、账目里看到的名字；用户名（@{{ user.username }}）不可更改。</div>
            </div>
            <div class="account-form">
              <label class="wl-field">
                <span class="wl-label">显示名</span>
                <input v-model="displayName" class="wl-input" maxlength="64" />
              </label>
              <button class="wl-btn wl-btn--primary" :disabled="savingName" @click="saveDisplayName">
                <span v-if="savingName" class="wl-spinner" />
                <Icon v-else name="check" :size="15" />
                保存
              </button>
            </div>
          </div>

          <!-- 改口令 -->
          <div v-if="user" class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">修改口令</div>
              <div class="wl-hint">
                需要先验证当前口令。修改成功后你在所有设备上的会话都会失效，需要用新口令重新登录。
              </div>
            </div>
            <div class="account-form">
              <label class="wl-field">
                <span class="wl-label">当前口令</span>
                <input v-model="oldPassword" class="wl-input" type="password" autocomplete="current-password" />
              </label>
              <label class="wl-field">
                <span class="wl-label">新口令</span>
                <input v-model="newPassword" class="wl-input" type="password" autocomplete="new-password" placeholder="至少 8 位" />
              </label>
              <label class="wl-field">
                <span class="wl-label">确认新口令</span>
                <input v-model="confirmPassword" class="wl-input" type="password" autocomplete="new-password" />
              </label>
              <button class="wl-btn wl-btn--primary" :disabled="savingPassword" @click="savePassword">
                <span v-if="savingPassword" class="wl-spinner" />
                <Icon v-else name="lock" :size="15" />
                修改口令
              </button>
            </div>
          </div>

          <div v-if="user" class="wl-card settings__card">
            <div class="settings__card-head">
              <div class="settings__card-title">退出登录</div>
              <div class="wl-hint">退出后需要重新输入用户名和密码。</div>
            </div>
            <button class="wl-btn wl-btn--danger" :disabled="loggingOut" @click="logout">
              <span v-if="loggingOut" class="wl-spinner" />
              <Icon v-else name="logout" :size="15" />
              {{ loggingOut ? '正在退出…' : '退出登录' }}
            </button>
          </div>
        </template>

        <!-- ============================ 安全 ============================ -->
        <template v-else-if="activeTab === 'security'">
          <div class="settings__head">
            <h2>安全</h2>
            <p>如实呈现当前浏览环境具备与不具备的能力，不做粉饰。</p>
          </div>

          <div class="wl-card settings__card">
            <div class="check-item">
              <span
                class="check-item__icon"
                :class="secure ? 'check-item__icon--ok' : 'check-item__icon--bad'"
              >
                <Icon :name="secure ? 'check' : 'alert'" :size="16" />
              </span>
              <div class="check-item__body">
                <div class="check-item__title">
                  安全上下文（Secure Context）
                  <span
                    class="wl-badge"
                    :class="secure ? 'wl-badge--success' : 'wl-badge--danger'"
                  >
                    {{ secure ? '通过' : '不满足' }}
                  </span>
                </div>
                <div class="check-item__desc">
                  {{
                    secure
                      ? '当前页面运行在安全上下文中，浏览器的高级能力可以正常使用。'
                      : '当前页面不是安全上下文（需要 HTTPS 或 localhost）。以下能力将无法使用：'
                  }}
                </div>
                <ul v-if="!secure" class="check-item__list">
                  <li v-for="cap in blockedCapabilities" :key="cap">{{ cap }}</li>
                </ul>
                <div v-if="!secure" class="check-item__fix">
                  <span>修复方式：在每台设备（含手机）上安装社团内网根证书。</span>
                  <a
                    class="wl-btn wl-btn--primary settings__link"
                    :href="onboardUrl"
                    target="_blank"
                    rel="noopener"
                  >
                    <Icon name="external" :size="14" />
                    去安装内网根证书
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div class="wl-card settings__card">
            <div class="check-item">
              <span
                class="check-item__icon"
                :class="serviceWorkerOk ? 'check-item__icon--ok' : 'check-item__icon--bad'"
              >
                <Icon :name="serviceWorkerOk ? 'check' : 'alert'" :size="16" />
              </span>
              <div class="check-item__body">
                <div class="check-item__title">
                  Service Worker
                  <span
                    class="wl-badge"
                    :class="serviceWorkerOk ? 'wl-badge--success' : 'wl-badge--warning'"
                  >
                    {{ serviceWorkerOk ? '可用' : '不可用' }}
                  </span>
                </div>
                <div class="check-item__desc">
                  {{
                    serviceWorkerOk
                      ? '浏览器支持 Service Worker，可用于离线缓存与后台同步。'
                      : '当前浏览器不支持 Service Worker，离线能力不可用。'
                  }}
                </div>
              </div>
            </div>
          </div>

          <div class="wl-card settings__card">
            <div class="check-item">
              <span class="check-item__icon check-item__icon--info">
                <Icon name="lock" :size="16" />
              </span>
              <div class="check-item__body">
                <div class="check-item__title">会话保存方式</div>
                <div class="check-item__desc">
                  登录态保存在 httpOnly cookie 中，前端脚本无法读取，可降低 XSS 窃取会话的风险。
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ============================ 存储 ============================ -->
        <template v-else>
          <div class="settings__head">
            <h2>存储</h2>
            <p>二进制对象、文件节点与审计记录的总体情况。</p>
          </div>

          <div v-if="storageLoading" class="wl-card settings__card">
            <div class="wl-empty">
              <span class="wl-spinner" />
              <div>正在读取存储信息…</div>
            </div>
          </div>

          <div v-else-if="storageForbidden" class="wl-card settings__card">
            <div class="check-item">
              <span class="check-item__icon check-item__icon--info">
                <Icon name="shield" :size="16" />
              </span>
              <div class="check-item__body">
                <div class="check-item__title">仅管理员可查看</div>
                <div class="check-item__desc">
                  存储统计与审计信息属于管理数据，当前账号没有查看权限。如需了解，请联系社团管理员。
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="storageError" class="wl-card settings__card">
            <div class="check-item">
              <span class="check-item__icon check-item__icon--bad">
                <Icon name="alert" :size="16" />
              </span>
              <div class="check-item__body">
                <div class="check-item__title">读取失败</div>
                <div class="check-item__desc selectable">{{ storageError }}</div>
              </div>
            </div>
            <button class="wl-btn settings__retry" @click="loadStorage">
              <Icon name="refresh" :size="15" />
              重试
            </button>
          </div>

          <template v-else-if="overview">
            <div class="stat-grid">
              <div class="wl-card stat">
                <div class="stat__label">二进制对象</div>
                <div class="stat__value">{{ overview.stats.blobs }}</div>
              </div>
              <div class="wl-card stat">
                <div class="stat__label">占用空间</div>
                <div class="stat__value">{{ formatBytes(overview.stats.bytes) }}</div>
              </div>
              <div class="wl-card stat">
                <div class="stat__label">文件节点</div>
                <div class="stat__value">{{ overview.stats.nodes }}</div>
              </div>
              <div class="wl-card stat">
                <div class="stat__label">审计记录</div>
                <div class="stat__value">{{ overview.audit.records }}</div>
              </div>
            </div>

            <div class="wl-card settings__card">
              <div class="check-item">
                <span
                  class="check-item__icon"
                  :class="overview.audit.chainOk ? 'check-item__icon--ok' : 'check-item__icon--bad'"
                >
                  <Icon :name="overview.audit.chainOk ? 'shield' : 'alert'" :size="16" />
                </span>
                <div class="check-item__body">
                  <div class="check-item__title">
                    审计链自洽性
                    <span
                      class="wl-badge"
                      :class="overview.audit.chainOk ? 'wl-badge--success' : 'wl-badge--danger'"
                    >
                      {{ overview.audit.chainOk ? '审计链完整' : '审计链异常' }}
                    </span>
                  </div>
                  <div class="check-item__desc">
                    {{
                      overview.audit.chainOk
                        ? '从首条到最后一条审计记录的哈希链校验通过，历史记录未被篡改。'
                        : '审计哈希链校验未通过，记录可能被篡改或损坏，请立即排查。'
                    }}
                  </div>
                </div>
              </div>
              <button class="wl-btn settings__retry" @click="loadStorage">
                <Icon name="refresh" :size="15" />
                刷新
              </button>
            </div>
          </template>

          <div v-else class="wl-card settings__card">
            <div class="wl-empty">
              <Icon name="db" :size="28" />
              <div>暂无存储数据</div>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.settings__frame {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* ---------------------------------------------------------------- 左侧标签页 */

.settings__nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 176px;
  padding: var(--space-3) var(--space-2);
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}

.settings__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.settings__tab:hover {
  background: var(--hover);
  color: var(--text);
}

.settings__tab--active {
  background: var(--selected);
  color: var(--text);
  font-weight: 600;
}

/* ---------------------------------------------------------------- 内容区 */

.settings__content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
}

.settings__head h2 {
  margin: 0 0 var(--space-1);
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

.settings__head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.settings__card {
  padding: var(--space-4);
}

.settings__card-head {
  margin-bottom: var(--space-3);
}

.settings__card-title {
  margin-bottom: var(--space-1);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.settings__link {
  text-decoration: none;
}

.settings__retry {
  margin-top: var(--space-3);
}

/* ---------------------------------------------------------------- 外观 · 主题 */

.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  max-width: 420px;
}

.theme-opt {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.theme-opt:hover {
  border-color: var(--border-strong);
}

.theme-opt--active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.theme-opt__preview {
  display: flex;
  flex-direction: column;
  height: 64px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-solid);
}

.theme-opt__bar {
  height: 14px;
  background: var(--surface-3);
}

.theme-opt__body {
  flex: 1;
  display: flex;
  align-items: flex-end;
  padding: var(--space-2);
}

.theme-opt__accent {
  width: 26px;
  height: 6px;
  border-radius: 3px;
  background: var(--accent);
}

/* 用滤镜把预览压暗/提亮，避免硬编码颜色 */
.theme-opt--dark .theme-opt__preview {
  filter: brightness(0.45) saturate(0.9);
}

.theme-opt--light .theme-opt__preview {
  filter: brightness(1.45) saturate(0.85);
}

.theme-opt__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.theme-opt--active .theme-opt__meta {
  color: var(--text);
  font-weight: 600;
}

.theme-opt__check {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
}

/* ---------------------------------------------------------------- 外观 · 壁纸 */

.wp-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  max-width: 420px;
}

.wp-opt {
  position: relative;
  height: 56px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.wp-opt:hover {
  border-color: var(--border-strong);
}

.wp-opt--active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.wp-opt--0 {
  background: linear-gradient(140deg, var(--wallpaper-1), var(--wallpaper-2) 45%, var(--wallpaper-3));
}
.wp-opt--1 {
  background: linear-gradient(160deg, var(--wallpaper-2), var(--wallpaper-1) 55%, var(--bg-desktop));
}
.wp-opt--2 {
  background: linear-gradient(150deg, var(--bg-desktop), var(--wallpaper-2) 50%, var(--wallpaper-1));
}
.wp-opt--3 {
  background: radial-gradient(130% 140% at 25% 15%, var(--wallpaper-2), var(--wallpaper-1) 50%, var(--bg-desktop));
}

.wp-opt__check {
  position: absolute;
  right: var(--space-1);
  bottom: var(--space-1);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
}

/* ---------------------------------------------------------------- 账号 */

.profile {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.profile__avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 22px;
  font-weight: 600;
}

.profile__info {
  min-width: 0;
}

.profile__name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.profile__username {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.profile__role {
  margin-top: var(--space-2);
}

.account-form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  max-width: 360px;
}

.account-form .wl-field {
  width: 100%;
  margin-bottom: 0;
}

/* ---------------------------------------------------------------- 安全 / 存储 通用 */

.check-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.check-item__icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}

.check-item__icon--ok {
  background: var(--success-soft);
  color: var(--success);
}

.check-item__icon--bad {
  background: var(--danger-soft);
  color: var(--danger);
}

.check-item__icon--info {
  background: var(--accent-soft);
  color: var(--accent);
}

.check-item__body {
  flex: 1;
  min-width: 0;
}

.check-item__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.check-item__desc {
  margin-top: var(--space-1);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.check-item__list {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.check-item__fix {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-3);
  font-size: 12.5px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 存储 · 统计 */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3);
}

.stat {
  padding: var(--space-3) var(--space-4);
}

.stat__label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.stat__value {
  margin-top: var(--space-1);
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
</style>
