<!--
  任务应用。

  展示当前用户最近的任务记录，并轮询刷新进行中任务的进度。轮询放在这里而不是
  放在工具应用里：任务一旦提交就离开了工具应用的上下文，用户会把这个窗口当作
  "任务中心"盯着看，所以刷新必须由它自己负责。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { ApiError, api, formatTime } from '@/api'
import type { JobView } from '@/api'
import { useWindows } from '@/stores/windows'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const windows = useWindows()

/** 一次最多展示多少条：再往前的历史没有查看价值，还会拖慢轮询后的重渲染。 */
const MAX_ROWS = 30
const POLL_MS = 2000

const jobs = ref<JobView[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')

let timer: number | null = null
/** 防止 2 秒的轮询和手动刷新叠在一起打后端。 */
let inFlight = false

/**
 * 工具 id → 可读名称。
 *
 * 不写死在这里：工具集是会长的（现在已经二十来个），写死就意味着每加一个工具
 * 都得回来补一行，而漏了的表现是任务列表里冒出一行 `pdf.split-each` 这样的原始 id ——
 * 不算错，但看起来像没做完。改成向服务端的工具注册表问一次，新增工具自动就有名字。
 */
const toolNames = ref<Record<string, string>>({})

async function loadToolNames(): Promise<void> {
  try {
    const res = await api.listTools()
    const map: Record<string, string> = {}
    for (const tool of res.tools) map[tool.id] = tool.name
    toolNames.value = map
  } catch {
    // 拿不到就退回原始 id —— 任务列表本身照常可用，不值得为它弹提示
  }
}

const STATE_LABELS: Record<JobView['state'], string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
}

/** 徽章配色：done→success、running→accent、failed→danger，其余用中性色。 */
const STATE_BADGE: Record<JobView['state'], string> = {
  done: 'wl-badge--success',
  running: 'wl-badge--accent',
  queued: '',
  failed: 'wl-badge--danger',
  canceled: '',
}

const activeCount = computed(
  () => jobs.value.filter((job) => job.state === 'queued' || job.state === 'running').length,
)

function kindLabel(kind: string): string {
  // 认不出来就显示原始 id，不要瞎猜一个名字 —— 猜错比显示 id 更误导
  return toolNames.value[kind] ?? kind
}

function progressOf(job: JobView): number {
  const value = Number.isFinite(job.progress) ? job.progress : 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** 进度条下方那一行补充说明：只在有增量信息时才显示。 */
function metaLine(job: JobView): string {
  if (job.state === 'running') return `${progressOf(job)}%`
  if (job.state === 'done' && job.finishedAt) return `完成于 ${formatTime(job.finishedAt)}`
  return ''
}

async function load(showSpinner: boolean): Promise<void> {
  if (inFlight) return
  inFlight = true
  if (showSpinner) {
    loading.value = true
    error.value = ''
  }
  try {
    const result = await api.listJobs()
    // 先按时间倒序再截断，否则后端若不保证顺序，"最近 30 条"可能漏掉最新的。
    jobs.value = [...result.jobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ROWS)
    error.value = ''
  } catch (err) {
    // 后端返回的中文提示优先，其次才是兜底文案。
    error.value = err instanceof ApiError ? err.message : '无法加载任务列表'
  } finally {
    inFlight = false
    loading.value = false
    refreshing.value = false
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true
  // 已经有内容时不闪加载态，避免列表被整体替换造成跳动。
  await load(jobs.value.length === 0)
}

function openTools(): void {
  windows.open({ appId: 'tools', title: '工具集' })
}

onMounted(() => {
  void load(true)
  void loadToolNames()
  timer = window.setInterval(() => {
    void load(false)
  }, POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="jobs" :data-window-id="props.win.id">
    <header class="jobs__bar">
      <div class="jobs__heading">
        <Icon name="clock" :size="16" />
        <span class="jobs__title">任务</span>
        <span v-if="!loading" class="jobs__count">{{ jobs.length }} 条记录</span>
      </div>
      <button
        class="wl-icon-btn"
        title="刷新"
        :disabled="loading || refreshing"
        @click="refresh"
      >
        <Icon name="refresh" :size="16" />
      </button>
    </header>

    <div v-if="activeCount > 0" class="jobs__summary">
      <span class="wl-spinner" />
      <span>{{ activeCount }} 个任务进行中</span>
    </div>

    <div v-if="error" class="jobs__error">
      <Icon name="alert" :size="15" />
      <span class="jobs__error-text selectable">{{ error }}</span>
      <button class="wl-btn" :disabled="refreshing" @click="refresh">重试</button>
    </div>

    <div class="jobs__body wl-scroll">
      <div v-if="loading" class="jobs__state">
        <span class="wl-spinner" />
        <span>正在加载任务…</span>
      </div>

      <div v-else-if="jobs.length === 0 && !error" class="wl-empty jobs__empty">
        <Icon name="clock" :size="36" />
        <p class="jobs__empty-title">还没有任务，去工具集试试</p>
        <p class="jobs__empty-hint">在工具集里对文件运行工具后，结果会出现在这里。</p>
        <button class="wl-btn wl-btn--primary" @click="openTools">
          <Icon name="tools" :size="15" />
          <span>打开工具集</span>
        </button>
      </div>

      <ul v-else class="jobs__list">
        <li v-for="job in jobs" :key="job.id" class="job">
          <div class="job__head">
            <span class="job__name">{{ kindLabel(job.kind) }}</span>
            <span class="wl-badge" :class="STATE_BADGE[job.state]">
              {{ STATE_LABELS[job.state] }}
            </span>
          </div>

          <div class="job__meta">
            <span>{{ formatTime(job.createdAt) }}</span>
            <span class="job__id">#{{ job.id.slice(0, 8) }}</span>
          </div>

          <div class="job__progress" :class="`job__progress--${job.state}`">
            <div class="job__progress-fill" :style="{ width: `${progressOf(job)}%` }" />
          </div>

          <div class="job__foot">
            <span v-if="metaLine(job)" class="job__pct">{{ metaLine(job) }}</span>
            <span v-else />
            <a
              v-for="(nodeId, index) in job.outputNodeIds"
              :key="nodeId"
              class="job__dl"
              :href="api.downloadUrl(nodeId)"
              download
            >
              <Icon name="download" :size="13" />
              <span>{{ job.outputNodeIds.length > 1 ? `下载产物 ${index + 1}` : '下载产物' }}</span>
            </a>
          </div>

          <p v-if="job.state === 'failed' && job.error" class="job__error selectable">
            <Icon name="alert" :size="13" />
            <span>{{ job.error }}</span>
          </p>
          <p v-else-if="job.message" class="job__message">{{ job.message }}</p>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.jobs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ---------------------------------------------------------------- 工具栏 */

.jobs__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: none;
  height: 44px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.jobs__heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-secondary);
}

.jobs__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.jobs__count {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 汇总条 */

.jobs__summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  border-bottom: 1px solid var(--border-subtle);
}

/* ---------------------------------------------------------------- 错误 */

.jobs__error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12.5px;
  border-bottom: 1px solid var(--border-subtle);
}

.jobs__error-text {
  flex: 1;
  min-width: 0;
  line-height: 1.45;
}

/* ---------------------------------------------------------------- 内容区 */

.jobs__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
}

.jobs__state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--text-tertiary);
  font-size: 13px;
}

.jobs__empty {
  gap: var(--space-2);
  color: var(--text-tertiary);
}

.jobs__empty-title {
  margin: var(--space-2) 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}

.jobs__empty-hint {
  margin: 0 0 var(--space-3);
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 列表 */

.jobs__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.job {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  transition: border-color var(--dur-fast) var(--ease-out);
}

.job:hover {
  border-color: var(--border-strong);
}

.job__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.job__name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.job__id {
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 进度条 */

.job__progress {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.job__progress-fill {
  position: relative;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  overflow: hidden;
  transition: width var(--dur) var(--ease-out);
}

.job__progress--done .job__progress-fill {
  background: var(--success);
}

.job__progress--failed .job__progress-fill {
  background: var(--danger);
}

/* 运行中的进度条加一道扫光，让"在动"这件事一眼可见 */
.job__progress--running .job__progress-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, var(--accent-text) 50%, transparent 100%);
  opacity: 0.35;
  transform: translateX(-100%);
  animation: job-sheen 1.4s var(--ease-out) infinite;
}

@keyframes job-sheen {
  to {
    transform: translateX(100%);
  }
}

/* ---------------------------------------------------------------- 底部信息 */

.job__foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 24px;
}

.job__pct {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
}

.job__foot > span:first-child:not(.job__pct) {
  flex: 1;
}

.job__dl {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  transition: background var(--dur-fast) var(--ease-out);
}

.job__dl:hover {
  background: var(--selected);
  text-decoration: none;
}

.job__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.45;
}

.job__message {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
}
</style>
