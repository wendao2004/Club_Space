<!--
  工具集应用。

  左侧按类别列出工具，右侧是选中工具的工作区。工具清单来自后端 /api/tools，
  每个工具自己声明参数与输入数量要求，所以这里全部动态渲染 —— 后端加一个工具，
  前端不用改。

  设计上的一条硬约束：available=false 的工具必须显式呈现为「未启用」并给出原因，
  而不是隐藏或点了没反应。评审团反复强调过这一点。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, ApiError, formatBytes, fileKind } from '@/api'
import type { FileEntry, FileListing, JobView, ToolDescriptor } from '@/api'
import type { WindowInstance } from '@/stores/windows'
import { useUi } from '@/stores/ui'

const props = defineProps<{ win: WindowInstance }>()
const ui = useUi()

type Category = ToolDescriptor['category']
type Space = 'shared' | 'private'
type ParamValue = string | boolean

// ---------------------------------------------------------------- 静态表

const CATEGORY_ORDER: Category[] = ['pdf', 'image', 'document', 'utility', 'media']

const CATEGORY_LABELS: Record<Category, string> = {
  pdf: 'PDF 工具',
  image: '图片',
  document: '文档',
  utility: '实用',
  media: '媒体',
}

const CATEGORY_ICONS: Record<Category, string> = {
  pdf: 'pdf',
  image: 'image',
  document: 'doc',
  utility: 'tools',
  media: 'video',
}

const STATE_LABELS: Record<JobView['state'], string> = {
  queued: '排队中',
  running: '处理中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
}

/** 结构化结果里已知字段的中文名，未知字段回退到原始键名。 */
const DATA_LABELS: Record<string, string> = {
  pageCount: '页数',
  title: '标题',
  author: '作者',
  producer: '生成工具',
  index: '页码',
  width: '宽度（pt）',
  height: '高度（pt）',
  rotation: '旋转角度',
}

// ---------------------------------------------------------------- 状态

const tools = ref<ToolDescriptor[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const selectedId = ref<string | null>(null)

const paramValues = ref<Record<string, ParamValue>>({})
const inputs = ref<FileEntry[]>([])

const job = ref<JobView | null>(null)
const running = ref(false)
const runError = ref<string | null>(null)

const narrow = ref(false)

// 文件浏览面板
const browserOpen = ref(false)
const fileSpace = ref<Space>('shared')
const browserParent = ref<string | null>(null)
const browserListing = ref<FileListing | null>(null)
const browserLoading = ref(false)
const browserError = ref<string | null>(null)

// ---------------------------------------------------------------- 派生

const grouped = computed(() =>
  CATEGORY_ORDER.map((cat) => ({
    cat,
    label: CATEGORY_LABELS[cat],
    tools: tools.value.filter((t) => t.category === cat),
  })).filter((group) => group.tools.length > 0),
)

const selectedTool = computed<ToolDescriptor | null>(
  () => tools.value.find((t) => t.id === selectedId.value) ?? null,
)

const crumbs = computed(() => browserListing.value?.breadcrumb ?? [])

const browserEntries = computed<FileEntry[]>(() => {
  const list = browserListing.value?.entries ?? []
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
})

const dataScalars = computed<Array<{ label: string; value: string }>>(() => {
  const data = job.value?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const rows: Array<{ label: string; value: string }> = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'object') continue
    rows.push({
      label: DATA_LABELS[key] ?? key,
      value: typeof value === 'boolean' ? (value ? '是' : '否') : String(value),
    })
  }
  return rows
})

const dataPages = computed<{ columns: Array<{ key: string; label: string }>; rows: string[][] } | null>(() => {
  const data = job.value?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const pages = (data as Record<string, unknown>)['pages']
  if (!Array.isArray(pages) || pages.length === 0) return null
  const first = pages[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const keys = Object.keys(first as Record<string, unknown>)
  if (keys.length === 0) return null
  const columns = keys.map((key) => ({ key, label: DATA_LABELS[key] ?? key }))
  const rows = pages.map((page) => {
    const record = (page ?? {}) as Record<string, unknown>
    return keys.map((key) => {
      const value = record[key]
      return value === null || value === undefined ? '—' : String(value)
    })
  })
  return { columns, rows }
})

// ---------------------------------------------------------------- 工具加载

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

function pickInitialTool(): void {
  const fromArgs = props.win.args['tool']
  if (typeof fromArgs === 'string' && tools.value.some((t) => t.id === fromArgs)) {
    selectedId.value = fromArgs
    return
  }
  if (!selectedId.value || !tools.value.some((t) => t.id === selectedId.value)) {
    selectedId.value = tools.value[0]?.id ?? null
  }
}

async function loadTools(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const { tools: list } = await api.listTools()
    tools.value = list
    pickInitialTool()
  } catch (err) {
    tools.value = []
    loadError.value = errorMessage(err, '无法加载工具清单')
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------- 选择工具

function selectTool(id: string): void {
  if (id === selectedId.value) return
  selectedId.value = id
}

function resetParamValues(tool: ToolDescriptor): void {
  const next: Record<string, ParamValue> = {}
  for (const param of tool.params) {
    if (param.type === 'boolean') {
      next[param.key] = typeof param.default === 'boolean' ? param.default : false
    } else {
      next[param.key] = param.default === undefined ? '' : String(param.default)
    }
  }
  paramValues.value = next
}

function resetRun(): void {
  stopPolling()
  running.value = false
  job.value = null
  runError.value = null
}

// 切换工具时，上一次的结果与输入一律清空，避免张冠李戴。
watch(selectedId, () => {
  resetRun()
  inputs.value = []
  browserOpen.value = false
  browserParent.value = null
  browserListing.value = null
  browserError.value = null
  fileSpace.value = 'shared'
  const tool = selectedTool.value
  if (tool) resetParamValues(tool)
  else paramValues.value = {}
})

function fieldId(key: string): string {
  return `tool-param-${key}`
}

function setParam(key: string, value: ParamValue): void {
  paramValues.value[key] = value
}

function collectParams(tool: ToolDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const param of tool.params) {
    const raw = paramValues.value[param.key]
    if (param.type === 'boolean') {
      out[param.key] = raw === true
    } else if (param.type === 'number') {
      const text = typeof raw === 'string' ? raw.trim() : ''
      out[param.key] = text === '' ? null : Number(text)
    } else {
      out[param.key] = typeof raw === 'string' ? raw : ''
    }
  }
  return out
}

// ---------------------------------------------------------------- 输入文件

function acceptsEntry(entry: FileEntry, tool: ToolDescriptor | null): boolean {
  if (!tool || tool.accepts.length === 0) return true
  const mime = entry.mime ?? ''
  return tool.accepts.some((accept) => (accept.endsWith('/') ? mime.startsWith(accept) : mime === accept))
}

function isSelected(id: string): boolean {
  return inputs.value.some((entry) => entry.id === id)
}

function clearInputs(): void {
  inputs.value = []
}

function removeInput(id: string): void {
  inputs.value = inputs.value.filter((entry) => entry.id !== id)
}

function pickEntry(entry: FileEntry): void {
  const tool = selectedTool.value
  if (!tool || entry.kind !== 'file') return
  const index = inputs.value.findIndex((item) => item.id === entry.id)
  if (index >= 0) {
    inputs.value.splice(index, 1)
    return
  }
  if (tool.maxInputs <= 0) {
    ui.notify('warning', '该工具不接受输入文件', tool.name)
    return
  }
  if (inputs.value.length >= tool.maxInputs) {
    ui.notify('warning', '已达到数量上限', `「${tool.name}」最多选择 ${tool.maxInputs} 个文件`)
    return
  }
  inputs.value.push(entry)
}

function activate(entry: FileEntry): void {
  if (entry.kind === 'folder') {
    void openDir(entry.id)
    return
  }
  pickEntry(entry)
}

/**
 * 处理别的应用「用工具处理」带过来的文件（win.args.node）。
 *
 * 工具集是单例窗口：已经开着时再带文件打开，窗口不会重建、只是 args 被替换，
 * 所以除了挂载后要处理，还要 watch args（见文件末尾）。
 *
 * 两点细节：
 * 1. 当前工具接不了这个格式时，自动切到第一个能接的工具 —— 用户点「用工具
 *    处理」的意思是"我想处理它"，不是"我想打开工具集自己找"。
 * 2. 切换工具会触发上面的 watch 清空输入，所以必须等一帧再放文件。
 */
async function applyArgsNode(): Promise<void> {
  const raw: unknown = props.win.args['node']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const entry = raw as FileEntry
  if (entry.kind !== 'file' || typeof entry.id !== 'string') return
  if (inputs.value.some((item) => item.id === entry.id)) return

  if (!acceptsEntry(entry, selectedTool.value)) {
    const match = tools.value.find(
      (tool) => tool.available && tool.maxInputs > 0 && acceptsEntry(entry, tool),
    )
    if (!match) {
      ui.notify('warning', '暂无工具能处理这个文件', entry.name)
      return
    }
    if (match.id !== selectedId.value) {
      selectedId.value = match.id
      await nextTick()
    }
  }

  const tool = selectedTool.value
  if (!tool || tool.maxInputs <= 0) {
    ui.notify('warning', '该工具不接受输入文件', tool?.name)
    return
  }
  // 满了就顶掉最早的一个：带着文件进来必须成功，否则"用工具处理"点了没反应
  if (inputs.value.length >= tool.maxInputs) inputs.value.shift()
  inputs.value.push(entry)
}

// ---------------------------------------------------------------- 文件浏览

async function openDir(parentId: string | null): Promise<void> {
  browserParent.value = parentId
  browserLoading.value = true
  browserError.value = null
  try {
    browserListing.value = await api.listFiles(parentId, fileSpace.value)
  } catch (err) {
    browserListing.value = null
    browserError.value = errorMessage(err, '无法读取文件列表')
  } finally {
    browserLoading.value = false
  }
}

function reloadBrowser(): void {
  void openDir(browserParent.value)
}

function switchSpace(space: Space): void {
  if (space === fileSpace.value) return
  fileSpace.value = space
  void openDir(null)
}

function toggleBrowser(): void {
  browserOpen.value = !browserOpen.value
  if (browserOpen.value && !browserListing.value && !browserLoading.value) {
    void openDir(browserParent.value)
  }
}

// ---------------------------------------------------------------- 运行任务

let pollTimer: number | null = null
let pollToken = 0
let pollBusy = false

function stopPolling(): void {
  pollToken += 1
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function runJob(): Promise<void> {
  const tool = selectedTool.value
  if (!tool || !tool.available || running.value) return
  if (inputs.value.length < tool.minInputs) return

  resetRun()
  running.value = true

  const space: Space = inputs.value[0]?.space ?? fileSpace.value
  let jobId = ''
  try {
    const result = await api.runTool(tool.id, {
      nodeIds: inputs.value.map((entry) => entry.id),
      params: collectParams(tool),
      space,
    })
    jobId = result.jobId
  } catch (err) {
    running.value = false
    const message = errorMessage(err, '任务提交失败')
    runError.value = message
    ui.notify('error', '任务提交失败', message)
    return
  }

  const token = pollToken
  const deadline = Date.now() + 90_000

  const tick = async (): Promise<void> => {
    if (token !== pollToken || pollBusy) return
    if (Date.now() > deadline) {
      stopPolling()
      running.value = false
      runError.value = '等待任务超时（超过 90 秒），可稍后在「任务」应用中查看结果'
      return
    }
    pollBusy = true
    try {
      const { job: view } = await api.getJob(jobId)
      if (token !== pollToken) return
      job.value = view
      if (view.state === 'done') {
        stopPolling()
        running.value = false
        ui.notify('success', '处理完成', view.message ?? `${tool.name} 已完成`)
      } else if (view.state === 'failed' || view.state === 'canceled') {
        stopPolling()
        running.value = false
        ui.notify('error', '处理失败', view.error ?? '任务未完成')
      }
    } catch (err) {
      stopPolling()
      running.value = false
      runError.value = errorMessage(err, '查询任务状态失败')
    } finally {
      pollBusy = false
    }
  }

  await tick()
  if (token === pollToken) {
    pollTimer = window.setInterval(() => void tick(), 800)
  }
}

// ---------------------------------------------------------------- 展示辅助

function stateLabel(state: JobView['state']): string {
  return STATE_LABELS[state]
}

function stateBadge(state: JobView['state']): string {
  switch (state) {
    case 'done':
      return 'wl-badge--success'
    case 'failed':
      return 'wl-badge--danger'
    case 'canceled':
      return 'wl-badge--warning'
    default:
      return 'wl-badge--accent'
  }
}

function barWidth(progress: number): string {
  return `${Math.min(100, Math.max(0, progress))}%`
}

function downloadUrl(id: string): string {
  return api.downloadUrl(id)
}

function categoryIcon(cat: Category): string {
  return CATEGORY_ICONS[cat]
}

// ---------------------------------------------------------------- 生命周期

const rootEl = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

// 用组件自身的宽度判断，而不是视口宽度 —— 桌面外壳里窗口可以比屏幕窄很多，
// 只看视口会导致窄窗口仍然硬塞一个侧栏。
function measure(): void {
  const width = rootEl.value?.clientWidth ?? window.innerWidth
  narrow.value = width > 0 && width < 640
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    if (rootEl.value) resizeObserver.observe(rootEl.value)
  }
  window.addEventListener('resize', measure)
  void loadTools().then(() => void applyArgsNode())
})

// 单例窗口：已经开着时「用工具处理」会替换 args 而不是重建窗口
watch(
  () => props.win.args,
  () => {
    if (loading.value || tools.value.length === 0) return
    void applyArgsNode()
  },
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', measure)
  stopPolling()
})
</script>

<template>
  <div ref="rootEl" class="tools">
    <!-- 窄窗口：分类折叠成顶部下拉 -->
    <div v-if="narrow" class="tools__topbar">
      <Icon name="tools" :size="16" />
      <select
        class="wl-select"
        :value="selectedId ?? ''"
        :disabled="loading || !!loadError || grouped.length === 0"
        @change="selectTool(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!selectedId" value="" disabled>选择工具</option>
        <optgroup v-for="group in grouped" :key="group.cat" :label="group.label">
          <option v-for="t in group.tools" :key="t.id" :value="t.id">
            {{ t.name }}{{ t.available ? '' : '（未启用）' }}
          </option>
        </optgroup>
      </select>
    </div>

    <div class="tools__body">
      <!-- 左侧分类列表（宽窗口） -->
      <aside v-if="!narrow" class="tools__side wl-scroll">
        <div v-if="loading" class="side-status">
          <span class="wl-spinner" />
          <span>正在加载…</span>
        </div>
        <div v-else-if="loadError" class="side-error">
          <p>{{ loadError }}</p>
          <button class="wl-btn" @click="loadTools">
            <Icon name="refresh" :size="14" /> 重试
          </button>
        </div>
        <div v-else-if="grouped.length === 0" class="side-status">暂无可用工具</div>
        <template v-else>
          <div v-for="group in grouped" :key="group.cat" class="tool-group">
            <p class="tool-group__label">{{ group.label }}</p>
            <button
              v-for="t in group.tools"
              :key="t.id"
              class="tool-item"
              :class="{ 'tool-item--active': t.id === selectedId }"
              @click="selectTool(t.id)"
            >
              <Icon :name="categoryIcon(t.category)" :size="16" />
              <span class="tool-item__name">{{ t.name }}</span>
              <span v-if="!t.available" class="tool-item__off">未启用</span>
            </button>
          </div>
        </template>
      </aside>

      <!-- 右侧工作区 -->
      <section class="tools__work">
        <div v-if="loading" class="work-status">
          <span class="wl-spinner" />
          <p>正在加载工具清单…</p>
        </div>

        <div v-else-if="loadError" class="work-status">
          <Icon name="alert" :size="24" />
          <p class="work-status__err">{{ loadError }}</p>
          <button class="wl-btn wl-btn--primary" @click="loadTools">
            <Icon name="refresh" :size="14" /> 重新加载
          </button>
        </div>

        <div v-else-if="!selectedTool" class="wl-empty">
          <Icon name="tools" :size="28" />
          <p>请从左侧选择一个工具</p>
        </div>

        <template v-else>
          <div class="tools__scroll wl-scroll">
            <header class="head">
              <div class="head__title">
                <h2>{{ selectedTool.name }}</h2>
                <span
                  class="wl-badge"
                  :class="selectedTool.available ? 'wl-badge--success' : 'wl-badge--warning'"
                >
                  {{ selectedTool.available ? '可用' : '未启用' }}
                </span>
              </div>
              <p class="head__desc">{{ selectedTool.description }}</p>
            </header>

            <div v-if="!selectedTool.available" class="notice notice--warn">
              <Icon name="alert" :size="16" />
              <div class="notice__body">
                <strong>该工具当前不可用，无法运行</strong>
                <p>{{ selectedTool.unavailableReason ?? '未提供具体原因' }}</p>
              </div>
            </div>

            <!-- 参数 -->
            <section class="block">
              <h3 class="block__title">参数</h3>
              <p v-if="selectedTool.params.length === 0" class="wl-hint">该工具无需设置参数。</p>
              <template v-else>
                <div v-for="p in selectedTool.params" :key="p.key" class="wl-field">
                  <template v-if="p.type === 'boolean'">
                    <label class="check">
                      <input
                        type="checkbox"
                        :checked="paramValues[p.key] === true"
                        @change="setParam(p.key, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>{{ p.label }}</span>
                    </label>
                    <p v-if="p.help" class="wl-hint">{{ p.help }}</p>
                  </template>
                  <template v-else>
                    <label class="wl-label" :for="fieldId(p.key)">{{ p.label }}</label>
                    <select
                      v-if="p.type === 'select'"
                      class="wl-select"
                      :id="fieldId(p.key)"
                      :value="String(paramValues[p.key] ?? '')"
                      @change="setParam(p.key, ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="o in p.options ?? []" :key="o.value" :value="o.value">
                        {{ o.label }}
                      </option>
                    </select>
                    <input
                      v-else
                      class="wl-input"
                      :id="fieldId(p.key)"
                      :type="p.type === 'number' ? 'number' : 'text'"
                      :value="String(paramValues[p.key] ?? '')"
                      :placeholder="p.placeholder ?? ''"
                      @input="setParam(p.key, ($event.target as HTMLInputElement).value)"
                    />
                    <p v-if="p.help" class="wl-hint">{{ p.help }}</p>
                  </template>
                </div>
              </template>
            </section>

            <!-- 输入文件 -->
            <section class="block">
              <div class="block__head">
                <h3 class="block__title">输入文件</h3>
                <span v-if="selectedTool.maxInputs > 0" class="block__meta">
                  已选 {{ inputs.length }} 个 · 需 {{ selectedTool.minInputs }}–{{ selectedTool.maxInputs }} 个
                </span>
              </div>

              <p v-if="selectedTool.maxInputs === 0" class="wl-hint">该工具不需要输入文件。</p>

              <template v-else>
                <div v-if="inputs.length > 0" class="chips">
                  <span v-for="f in inputs" :key="f.id" class="chip">
                    <Icon :name="fileKind(f).icon" :size="14" />
                    <span class="chip__name">{{ f.name }}</span>
                    <span class="chip__size">{{ formatBytes(f.size) }}</span>
                    <button class="chip__x" title="移除" @click="removeInput(f.id)">
                      <Icon name="close" :size="12" />
                    </button>
                  </span>
                </div>
                <p v-else class="wl-hint">尚未选择文件。</p>

                <div class="picker-actions">
                  <button class="wl-btn" :class="{ 'wl-btn--primary': !browserOpen }" @click="toggleBrowser">
                    <Icon :name="browserOpen ? 'close' : 'folder-open'" :size="14" />
                    {{ browserOpen ? '收起文件库' : '从文件库选择' }}
                  </button>
                  <button v-if="inputs.length > 0" class="wl-btn wl-btn--ghost" @click="clearInputs">
                    <Icon name="trash" :size="14" /> 清空
                  </button>
                </div>

                <div v-if="browserOpen" class="browser">
                  <div class="browser__head">
                    <div class="browser__spaces">
                      <button
                        class="wl-btn"
                        :class="{ 'wl-btn--primary': fileSpace === 'shared' }"
                        @click="switchSpace('shared')"
                      >
                        共享空间
                      </button>
                      <button
                        class="wl-btn"
                        :class="{ 'wl-btn--primary': fileSpace === 'private' }"
                        @click="switchSpace('private')"
                      >
                        我的空间
                      </button>
                    </div>
                    <nav class="crumbs">
                      <button class="crumb" @click="openDir(null)">根目录</button>
                      <template v-for="c in crumbs" :key="c.id">
                        <Icon name="chevron-right" :size="12" />
                        <button class="crumb" @click="openDir(c.id)">{{ c.name }}</button>
                      </template>
                    </nav>
                  </div>

                  <div class="browser__list wl-scroll">
                    <div v-if="browserLoading" class="browser__status">
                      <span class="wl-spinner" />
                      <span>正在读取…</span>
                    </div>
                    <div v-else-if="browserError" class="browser__status">
                      <p class="browser__err">{{ browserError }}</p>
                      <button class="wl-btn" @click="reloadBrowser">
                        <Icon name="refresh" :size="14" /> 重试
                      </button>
                    </div>
                    <div v-else-if="browserEntries.length === 0" class="browser__status">此目录为空。</div>
                    <template v-else>
                      <button
                        v-for="e in browserEntries"
                        :key="e.id"
                        class="browser__row"
                        :class="{
                          'browser__row--dim': e.kind === 'file' && !acceptsEntry(e, selectedTool),
                          'browser__row--on': isSelected(e.id),
                        }"
                        @click="activate(e)"
                      >
                        <Icon :name="e.kind === 'folder' ? 'folder' : fileKind(e).icon" :size="16" />
                        <span class="browser__name">{{ e.name }}</span>
                        <span v-if="e.kind === 'folder'" class="browser__enter">
                          <Icon name="chevron-right" :size="14" />
                        </span>
                        <span v-else class="browser__size">{{ formatBytes(e.size) }}</span>
                      </button>
                    </template>
                  </div>
                </div>
              </template>
            </section>

            <!-- 运行状态与结果 -->
            <section v-if="running || job || runError" class="block">
              <h3 class="block__title">运行状态</h3>

              <div v-if="runError" class="notice notice--danger">
                <Icon name="alert" :size="16" />
                <div class="notice__body">
                  <strong>操作未完成</strong>
                  <p>{{ runError }}</p>
                </div>
              </div>

              <template v-if="job">
                <div class="jobline">
                  <span class="wl-badge" :class="stateBadge(job.state)">{{ stateLabel(job.state) }}</span>
                  <span class="jobline__pct">{{ job.progress }}%</span>
                </div>
                <div class="bar">
                  <div class="bar__fill" :style="{ width: barWidth(job.progress) }" />
                </div>

                <p v-if="job.message" class="wl-hint">{{ job.message }}</p>

                <div
                  v-if="job.state === 'failed' || job.state === 'canceled'"
                  class="notice notice--danger"
                >
                  <Icon name="alert" :size="16" />
                  <div class="notice__body">
                    <strong>{{ stateLabel(job.state) }}</strong>
                    <p>{{ job.error ?? '未提供错误详情' }}</p>
                  </div>
                </div>

                <template v-if="job.state === 'done'">
                  <dl v-if="dataScalars.length > 0" class="kv">
                    <template v-for="row in dataScalars" :key="row.label">
                      <dt>{{ row.label }}</dt>
                      <dd class="selectable">{{ row.value }}</dd>
                    </template>
                  </dl>

                  <div v-if="dataPages" class="table-wrap">
                    <table class="table">
                      <thead>
                        <tr>
                          <th v-for="c in dataPages.columns" :key="c.key">{{ c.label }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(row, i) in dataPages.rows" :key="i">
                          <td v-for="(cell, j) in row" :key="j" class="selectable">{{ cell }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div v-if="job.outputNodeIds.length > 0" class="outputs">
                    <p class="outputs__label">产出文件</p>
                    <div v-for="(id, i) in job.outputNodeIds" :key="id" class="output">
                      <Icon name="file" :size="16" />
                      <span class="output__name">产物 {{ i + 1 }}</span>
                      <a class="wl-btn" :href="downloadUrl(id)" download>
                        <Icon name="download" :size="14" /> 下载
                      </a>
                    </div>
                  </div>

                  <p
                    v-if="dataScalars.length === 0 && !dataPages && job.outputNodeIds.length === 0"
                    class="wl-hint"
                  >
                    任务已完成，但没有可展示的结果。
                  </p>
                </template>
              </template>
            </section>
          </div>

          <!-- 底部操作条 -->
          <footer class="tools__actions">
            <p v-if="!selectedTool.available" class="actions__hint">工具未启用，无法运行。</p>
            <p v-else-if="inputs.length < selectedTool.minInputs" class="actions__hint">
              还需选择 {{ selectedTool.minInputs - inputs.length }} 个文件。
            </p>
            <p v-else class="actions__hint">准备就绪。</p>
            <div class="actions__btns">
              <button v-if="running" class="wl-btn" disabled>
                <span class="wl-spinner" /> 处理中…
              </button>
              <button
                v-else
                class="wl-btn wl-btn--primary"
                :disabled="!selectedTool.available || inputs.length < selectedTool.minInputs"
                @click="runJob"
              >
                <Icon name="tools" :size="14" /> 运行
              </button>
            </div>
          </footer>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tools {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.tools__topbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
}

.tools__topbar .wl-select {
  flex: 1;
  min-width: 0;
}

.tools__body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ---- 左侧列表 ---- */

.tools__side {
  width: 208px;
  flex: 0 0 auto;
  padding: var(--space-2);
  border-right: 1px solid var(--border);
}

.side-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  color: var(--text-tertiary);
  font-size: 13px;
}

.side-error {
  padding: var(--space-2);
  color: var(--text-secondary);
  font-size: 13px;
}

.side-error p {
  margin: 0 0 var(--space-2);
}

.tool-group {
  margin-bottom: var(--space-3);
}

.tool-group__label {
  margin: var(--space-1) var(--space-2);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 7px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.tool-item:hover {
  background: var(--hover);
  color: var(--text);
}

.tool-item--active,
.tool-item--active:hover {
  background: var(--selected);
  color: var(--text);
}

.tool-item__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-item__off {
  flex: 0 0 auto;
  color: var(--warning);
  font-size: 10px;
}

/* ---- 右侧 ---- */

.tools__work {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.work-status {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6);
  color: var(--text-tertiary);
  text-align: center;
}

.work-status p {
  margin: 0;
}

.work-status__err {
  max-width: 420px;
  color: var(--danger);
  font-size: 13px;
}

.tools__scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
}

.head__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.head__title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.head__desc {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.block {
  margin-top: var(--space-5);
}

.block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.block__title {
  margin: 0 0 var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.block__meta {
  color: var(--text-tertiary);
  font-size: 12px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.check input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

/* ---- 提示条 ---- */

.notice {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius);
  font-size: 13px;
}

.notice--warn {
  background: var(--warning-soft);
  color: var(--text);
}

.notice--danger {
  background: var(--danger-soft);
  color: var(--text);
}

.notice__body {
  min-width: 0;
}

.notice__body strong {
  display: block;
  margin-bottom: var(--space-1);
  font-weight: 600;
  color: var(--text);
}

.notice__body p {
  margin: 0;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.notice--warn > svg {
  color: var(--warning);
  flex: 0 0 auto;
}

.notice--danger > svg {
  color: var(--danger);
  flex: 0 0 auto;
}

/* ---- 已选文件 chip ---- */

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  height: 26px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12px;
}

.chip__name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.chip__size {
  color: var(--text-tertiary);
}

.chip__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
}

.chip__x:hover {
  background: var(--hover);
  color: var(--danger);
}

.picker-actions {
  display: flex;
  gap: var(--space-2);
}

/* ---- 文件浏览面板 ---- */

.browser {
  margin-top: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow: hidden;
}

.browser__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}

.browser__spaces {
  display: flex;
  gap: var(--space-1);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  min-width: 0;
  color: var(--text-tertiary);
}

.crumb {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
}

.crumb:hover {
  background: var(--hover);
  color: var(--text);
}

.browser__list {
  max-height: 240px;
  padding: var(--space-1);
}

.browser__status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-tertiary);
  font-size: 13px;
}

.browser__err {
  margin: 0;
  color: var(--danger);
}

.browser__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
}

.browser__row:hover {
  background: var(--hover);
  color: var(--text);
}

.browser__row--dim {
  opacity: 0.55;
}

.browser__row--on {
  background: var(--selected);
  color: var(--text);
}

.browser__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser__enter,
.browser__size {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

/* ---- 运行状态 ---- */

.jobline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.jobline__pct {
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.bar__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--dur) var(--ease-out);
}

.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-4);
  margin: var(--space-3) 0 0;
  font-size: 13px;
}

.kv dt {
  color: var(--text-tertiary);
}

.kv dd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}

.table-wrap {
  margin-top: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.table th,
.table td {
  padding: 6px var(--space-3);
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}

.table th {
  color: var(--text-tertiary);
  font-weight: 600;
}

.table td {
  color: var(--text-secondary);
}

.outputs {
  margin-top: var(--space-3);
}

.outputs__label {
  margin: 0 0 var(--space-2);
  color: var(--text-tertiary);
  font-size: 12px;
}

.output {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  margin-bottom: var(--space-2);
  color: var(--text-secondary);
}

.output__name {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 底部操作条 ---- */

.tools__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
}

.actions__hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.actions__btns {
  display: flex;
  gap: var(--space-2);
}
</style>
