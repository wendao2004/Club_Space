<!--
  移动端外壳。

  这里刻意不复用桌面那套窗口模型：Windows 式窗口依赖拖拽、多窗口重叠和悬浮
  任务栏，这三件事在触屏上都没有意义，硬塞只会得到一个"缩小的桌面"。所以移动端
  是独立的一套 —— 全屏单页 + 底部 Tab 栏，应用以全屏遮罩层的形式打开（顶部一条
  返回栏），整个页面没有任何拖拽或贴边逻辑。

  Tab 切换只是切换 ref，不重建组件、不动路由，因此横竖屏旋转不会丢状态。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { APPS, appComponents, findApp, type AppDef } from '@/apps/registry'
import {
  api,
  fileKind,
  formatBytes,
  formatTime,
  type FileEntry,
  type FileListing,
  type JobView,
} from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

const auth = useAuth()
const ui = useUi()

// ---------------------------------------------------------------- Tab

type TabId = 'apps' | 'files' | 'jobs' | 'me'

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'apps', label: '应用', icon: 'grid' },
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'jobs', label: '任务', icon: 'clock' },
  { id: 'me', label: '我的', icon: 'user' },
]

const activeTab = ref<TabId>('apps')

// ---------------------------------------------------------------- 应用全屏层

/** 正在全屏打开的应用 id；空串表示没有打开。 */
const openAppId = ref('')
const openApp = computed<AppDef | null>(() =>
  openAppId.value ? findApp(openAppId.value) ?? null : null,
)

/**
 * 传给应用组件的假窗口对象。
 *
 * 应用组件都按 `win: WindowInstance` 取参数，移动端没有真正的窗口，这里补一个
 * 满屏、不可拖拽的实例，让同一批应用组件能在两种外壳里直接复用。
 */
const openWin = computed<WindowInstance>(() => ({
  id: 'mobile',
  appId: openAppId.value,
  title: openApp.value?.name ?? '',
  args: {},
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  z: 0,
  minimized: false,
  maximized: true,
  restore: null,
  snap: 'none',
  resizable: false,
  minW: 0,
  minH: 0,
}))

function launchApp(app: AppDef): void {
  openAppId.value = app.id
}

function closeApp(): void {
  openAppId.value = ''
}

/** 开始/关于等抽屉里出现过的应用（过滤掉非管理员看不到的管理台）。 */
const visibleApps = computed<AppDef[]>(() =>
  APPS.filter((app) => app.inStartMenu && !(app.adminOnly && !auth.isAdmin)),
)

// ---------------------------------------------------------------- 文件

const fileSpace = ref<'shared' | 'private'>('shared')
const listing = ref<FileListing | null>(null)
const fileLoading = ref(false)
const fileError = ref('')
const parentId = ref<string | null>(null)
const filesReady = ref(false)

/** 文件夹在前、同类按名称排序，和桌面文件管理器保持一致。 */
const sortedEntries = computed<FileEntry[]>(() => {
  const list = listing.value?.entries ?? []
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
})

async function loadFiles(id: string | null): Promise<void> {
  fileLoading.value = true
  fileError.value = ''
  try {
    const data = await api.listFiles(id, fileSpace.value)
    listing.value = data
    parentId.value = data.parentId
  } catch (err) {
    // 后端的中文提示（含 401 会话过期）要原样显示，不能吞掉
    fileError.value = err instanceof Error ? err.message : String(err)
    listing.value = null
  } finally {
    fileLoading.value = false
  }
}

function reloadFiles(): void {
  void loadFiles(parentId.value)
}

function switchSpace(space: 'shared' | 'private'): void {
  if (fileSpace.value === space) return
  fileSpace.value = space
  parentId.value = null
  void loadFiles(null)
}

function openEntry(entry: FileEntry): void {
  if (entry.kind === 'folder') {
    void loadFiles(entry.id)
    return
  }
  window.open(api.previewUrl(entry.id), '_blank', 'noopener')
}

// ---------------------------------------------------------------- 任务

const jobs = ref<JobView[]>([])
const jobsLoading = ref(false)
const jobsError = ref('')
const jobsReady = ref(false)

const JOB_STATE: Record<JobView['state'], { label: string; badge: string }> = {
  queued: { label: '排队中', badge: 'wl-badge' },
  running: { label: '处理中', badge: 'wl-badge wl-badge--accent' },
  done: { label: '已完成', badge: 'wl-badge wl-badge--success' },
  failed: { label: '失败', badge: 'wl-badge wl-badge--danger' },
  canceled: { label: '已取消', badge: 'wl-badge' },
}

/** 排队与处理中才有进度可看，其余状态进度条没有意义。 */
function isActive(state: JobView['state']): boolean {
  return state === 'queued' || state === 'running'
}

async function loadJobs(): Promise<void> {
  jobsLoading.value = true
  jobsError.value = ''
  try {
    const data = await api.listJobs()
    jobs.value = data.jobs
  } catch (err) {
    jobsError.value = err instanceof Error ? err.message : String(err)
    jobs.value = []
  } finally {
    jobsLoading.value = false
  }
}

// ---------------------------------------------------------------- 我的

const avatarText = computed(() =>
  (auth.user?.displayName ?? auth.user?.username ?? '?').slice(0, 1),
)

const roleLabel = computed(() => {
  const role = auth.user?.role
  if (role === 'owner') return '创建者'
  if (role === 'admin') return '管理员'
  return '成员'
})

async function signOut(): Promise<void> {
  await auth.logout()
}

function openAbout(): void {
  openAppId.value = 'about'
}

// ---------------------------------------------------------------- 生命周期

function selectTab(id: TabId): void {
  activeTab.value = id
}

// 首次进入某个 Tab 时才发请求，避免一开壳就把所有接口打一遍。
watch(activeTab, (tab) => {
  if (tab === 'files' && !filesReady.value) {
    filesReady.value = true
    void loadFiles(null)
  } else if (tab === 'jobs' && !jobsReady.value) {
    jobsReady.value = true
    void loadJobs()
  }
})
</script>

<template>
  <div class="m">
    <main class="m__body wl-scroll">
      <!-- 应用 -->
      <section v-if="activeTab === 'apps'" class="pane">
        <h1 class="pane__title">应用</h1>
        <div v-if="visibleApps.length" class="apps">
          <button
            v-for="app in visibleApps"
            :key="app.id"
            class="apps__tile"
            @click="launchApp(app)"
          >
            <span class="apps__icon" :style="app.tint ? { '--tint': app.tint } : undefined">
              <Icon :name="app.icon" :size="24" />
            </span>
            <span class="apps__name">{{ app.name }}</span>
          </button>
        </div>
        <div v-else class="wl-empty">
          <Icon name="grid" :size="30" />
          <span>暂无可用的应用</span>
        </div>
      </section>

      <!-- 文件 -->
      <section v-else-if="activeTab === 'files'" class="pane">
        <div class="bar">
          <div class="seg">
            <button
              class="seg__btn"
              :class="{ 'seg__btn--on': fileSpace === 'shared' }"
              @click="switchSpace('shared')"
            >
              共享
            </button>
            <button
              class="seg__btn"
              :class="{ 'seg__btn--on': fileSpace === 'private' }"
              @click="switchSpace('private')"
            >
              私人
            </button>
          </div>
          <button class="bar__btn" title="刷新" @click="reloadFiles">
            <Icon name="refresh" :size="18" />
          </button>
        </div>

        <nav v-if="listing" class="crumbs wl-scroll" aria-label="路径">
          <button class="crumbs__item" @click="loadFiles(null)">
            <Icon name="home" :size="14" />
            <span>根目录</span>
          </button>
          <template v-for="(crumb, index) in listing.breadcrumb" :key="crumb.id">
            <Icon name="chevron-right" :size="14" class="crumbs__sep" />
            <button
              class="crumbs__item"
              :class="{ 'crumbs__item--cur': index === listing.breadcrumb.length - 1 }"
              @click="loadFiles(crumb.id)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </nav>

        <div v-if="fileLoading" class="wl-empty">
          <span class="wl-spinner" />
          <span>正在加载…</span>
        </div>

        <div v-else-if="fileError" class="state">
          <Icon name="alert" :size="26" />
          <p class="state__msg selectable">{{ fileError }}</p>
          <button class="wl-btn" @click="reloadFiles">
            <Icon name="refresh" :size="15" />
            重试
          </button>
        </div>

        <div v-else-if="sortedEntries.length === 0" class="wl-empty">
          <Icon name="folder-open" :size="30" />
          <span>这个目录是空的</span>
        </div>

        <ul v-else class="frows">
          <li v-for="entry in sortedEntries" :key="entry.id">
            <button class="frow" @click="openEntry(entry)">
              <span class="frow__icon">
                <Icon :name="fileKind(entry).icon" :size="20" />
              </span>
              <span class="frow__main">
                <span class="frow__name selectable">{{ entry.name }}</span>
                <span class="frow__meta">
                  {{ fileKind(entry).label }}
                  <template v-if="entry.kind === 'file'"> · {{ formatBytes(entry.size) }}</template>
                  · {{ formatTime(entry.updatedAt) }}
                </span>
              </span>
              <Icon
                :name="entry.kind === 'folder' ? 'chevron-right' : 'external'"
                :size="16"
                class="frow__chev"
              />
            </button>
          </li>
        </ul>
      </section>

      <!-- 任务 -->
      <section v-else-if="activeTab === 'jobs'" class="pane">
        <div class="bar">
          <span class="bar__title">处理任务</span>
          <button class="bar__btn" title="刷新" @click="loadJobs">
            <Icon name="refresh" :size="18" />
          </button>
        </div>

        <div v-if="jobsLoading" class="wl-empty">
          <span class="wl-spinner" />
          <span>正在加载…</span>
        </div>

        <div v-else-if="jobsError" class="state">
          <Icon name="alert" :size="26" />
          <p class="state__msg selectable">{{ jobsError }}</p>
          <button class="wl-btn" @click="loadJobs">
            <Icon name="refresh" :size="15" />
            重试
          </button>
        </div>

        <div v-else-if="jobs.length === 0" class="wl-empty">
          <Icon name="clock" :size="30" />
          <span>还没有任务记录</span>
        </div>

        <ul v-else class="jrows">
          <li v-for="job in jobs" :key="job.id" class="jrow">
            <div class="jrow__head">
              <span class="jrow__kind selectable">{{ job.kind }}</span>
              <span :class="JOB_STATE[job.state].badge">{{ JOB_STATE[job.state].label }}</span>
            </div>
            <div v-if="isActive(job.state)" class="jrow__bar">
              <span :style="{ width: `${job.progress}%` }" />
            </div>
            <div class="jrow__meta">
              <span>{{ job.progress }}%</span>
              <span>{{ formatTime(job.createdAt) }}</span>
            </div>
            <p v-if="job.error" class="jrow__err selectable">{{ job.error }}</p>
          </li>
        </ul>
      </section>

      <!-- 我的 -->
      <section v-else class="pane">
        <div class="me">
          <span class="me__avatar">{{ avatarText }}</span>
          <div class="me__info">
            <div class="me__name selectable">{{ auth.user?.displayName ?? '未登录' }}</div>
            <div class="me__username">@{{ auth.user?.username ?? '-' }}</div>
          </div>
          <span class="wl-badge wl-badge--accent">{{ roleLabel }}</span>
        </div>

        <ul class="rows">
          <li>
            <button class="row" @click="ui.toggleTheme()">
              <span class="row__icon">
                <Icon :name="ui.theme === 'dark' ? 'moon' : 'sun'" :size="18" />
              </span>
              <span class="row__label">主题</span>
              <span class="row__value">{{ ui.theme === 'dark' ? '深色' : '浅色' }}</span>
              <Icon name="chevron-right" :size="16" class="row__chev" />
            </button>
          </li>
          <li>
            <button class="row" @click="openAbout">
              <span class="row__icon">
                <Icon name="info" :size="18" />
              </span>
              <span class="row__label">关于本平台</span>
              <Icon name="chevron-right" :size="16" class="row__chev" />
            </button>
          </li>
          <li>
            <button class="row row--danger" @click="signOut">
              <span class="row__icon">
                <Icon name="logout" :size="18" />
              </span>
              <span class="row__label">退出登录</span>
            </button>
          </li>
        </ul>

        <p class="me__site">{{ auth.siteName }}</p>
      </section>
    </main>

    <!-- 底部 Tab 栏 -->
    <nav class="tabs" aria-label="主导航">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="tabs__item"
        :class="{ 'tabs__item--on': activeTab === tab.id }"
        @click="selectTab(tab.id)"
      >
        <Icon :name="tab.icon" :size="22" />
        <span class="tabs__label">{{ tab.label }}</span>
      </button>
    </nav>

    <!-- 应用全屏层：覆盖整个外壳，顶部一条返回栏 -->
    <div v-if="openAppId" class="app">
      <header class="app__bar">
        <button class="app__back" title="返回" @click="closeApp">
          <Icon name="arrow-left" :size="20" />
        </button>
        <span class="app__title">{{ openApp?.name ?? '应用' }}</span>
      </header>
      <div class="app__body">
        <component :is="appComponents[openAppId]" :win="openWin" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.m {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--surface-0);
  color: var(--text);
  font-family: var(--font-ui);
}

.m__body {
  flex: 1;
  min-height: 0;
  padding-top: env(safe-area-inset-top);
  -webkit-overflow-scrolling: touch;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: var(--space-4);
}

.pane__title {
  margin: 0 0 var(--space-4);
  font-size: var(--fs-title);
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: var(--lh-tight);
}

/* ---------------------------------------------------------------- 应用抽屉 */

.apps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}

.apps__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-3) var(--space-1);
  border-radius: var(--radius);
  transition: background var(--dur-fast) var(--ease-out);
}

.apps__tile:active {
  background: var(--hover);
}

/* 与桌面同源的图标语言：主色 15% 淡底 + 主色线性字形 */
.apps__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 50px;
  border-radius: var(--radius-lg);
  background: rgba(127, 140, 156, 0.14);
  background: color-mix(in srgb, var(--tint, #6b7686) 15%, transparent);
  color: var(--tint, #6b7686);
}

[data-theme='dark'] .apps__icon {
  color: color-mix(in srgb, var(--tint, #9aa5b1) 62%, #ffffff);
}

.apps__name {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.3;
}

/* ---------------------------------------------------------------- 顶部工具条 */

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: none;
  min-height: 40px;
  margin-bottom: var(--space-3);
}

.bar__title {
  font-size: var(--fs-title);
  font-weight: 600;
}

.bar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: var(--radius);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
}

.bar__btn:active {
  background: var(--hover);
  color: var(--text);
}

.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
}

.seg__btn {
  min-width: 68px;
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: 3px;
  font-size: var(--fs-body);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
}

.seg__btn--on {
  background: var(--surface-3);
  color: var(--text);
  font-weight: 600;
}

/* ---------------------------------------------------------------- 面包屑 */

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-1);
  overflow-x: auto;
  white-space: nowrap;
}

.crumbs__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}

.crumbs__item:active {
  background: var(--hover);
}

.crumbs__item--cur {
  color: var(--text);
  font-weight: 600;
}

.crumbs__sep {
  flex: none;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 错误 / 空状态 */

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--danger);
}

.state__msg {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  word-break: break-word;
}

/* ---------------------------------------------------------------- 文件列表 */

/* 一张分组卡：行间发丝线分隔，不再每行各自带框 */
.frows {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--surface-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.frows > li + li {
  border-top: 1px solid var(--line-hair);
}

.frow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 56px;
  padding: var(--space-2) var(--space-3);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.frow:active {
  background: var(--hover);
}

.frow__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  color: var(--text-secondary);
}

.frow__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.frow__name {
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frow__meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frow__chev {
  flex: none;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 任务列表 */

.jrows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  margin: 0;
  padding: 0;
}

.jrow {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
}

.jrow__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.jrow__kind {
  font-size: 14px;
  color: var(--text);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jrow__bar {
  height: 6px;
  margin: var(--space-3) 0 var(--space-2);
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.jrow__bar span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--dur) var(--ease-out);
}

.jrow__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-tertiary);
}

.jrow__err {
  margin: var(--space-2) 0 0;
  font-size: 12.5px;
  color: var(--danger);
  word-break: break-word;
}

/* ---------------------------------------------------------------- 我的 */

.me {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  margin-bottom: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
}

.me__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 20px;
  font-weight: 600;
}

.me__info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.me__name {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.me__username {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.rows {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.rows > li + li {
  border-top: 1px solid var(--line-hair);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-3);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.row:active {
  background: var(--hover);
}

.row__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  flex: none;
  color: var(--text-secondary);
}

.row__label {
  flex: 1;
  font-size: 14px;
  color: var(--text);
}

.row__value {
  font-size: var(--fs-body);
  color: var(--text-tertiary);
}

.row__chev {
  flex: none;
  color: var(--text-tertiary);
}

.row--danger .row__icon,
.row--danger .row__label {
  color: var(--danger);
}

.me__site {
  margin: auto 0 var(--space-2);
  padding-top: var(--space-3);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  text-align: center;
}

/* ---------------------------------------------------------------- 底部 Tab 栏 */

.tabs {
  display: flex;
  flex: none;
  align-items: stretch;
  height: calc(56px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid var(--line-hair);
  background: var(--surface-raised);
  backdrop-filter: blur(30px) saturate(1.8);
}

.tabs__item {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 44px;
  color: var(--text-tertiary);
  transition: color var(--dur-fast) var(--ease-out);
}

.tabs__item--on {
  color: var(--accent);
}

.tabs__label {
  font-size: 12px;
}

.tabs__item--on .tabs__label {
  font-weight: 600;
}

/* ---------------------------------------------------------------- 应用全屏层 */

.app {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  background: var(--surface-0);
}

.app__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  min-height: calc(56px + env(safe-area-inset-top));
  padding: env(safe-area-inset-top) var(--space-2) 0;
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-raised);
  backdrop-filter: blur(30px) saturate(1.8);
}

.app__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: var(--radius);
  color: var(--text);
}

.app__back:active {
  background: var(--hover);
}

.app__title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app__body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
