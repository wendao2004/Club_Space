<!--
  文件预览窗口。

  原先预览是文件管理器里的一个浮层 —— 不能拖、不能缩放、不能贴边，
  切到别的窗口就被盖住。现在它是**一个真正的桌面窗口**：
  和所有窗口共用同一套框架（WindowFrame）的拖拽 / 8 向缩放 / 最大化 /
  贴边分屏 / 任务栏按钮，行为与其他窗口完全一致。

  通过窗口参数拿文件：args: { node: FileEntry }（文件管理器传入）。

  ────────────────────────────────────────────────────────────────────────────
  三类内容的三条路
  ────────────────────────────────────────────────────────────────────────────
  1. 图片 / 音视频 / PDF / 纯文本 —— 浏览器自己会渲染，直接给 URL。
  2. CSV / TSV —— 前端解析成表格（见 lib/csv.ts）。不需要任何服务端能力，
     所以这一路是"离线可用"的。
  3. Word / Excel / PPT —— 浏览器渲染不了，必须先转成 PDF。
     复用已有的 doc.to-pdf 工具（服务端 Gotenberg），转完把产物当 PDF 预览。
     转换服务是**按需拉起**的（见 deploy/heavy-tools.compose.yml），
     所以它的不可用是常态而不是故障：这里要如实说清"为什么不能预览"和
     "管理员该跑什么"，而不是转一个永远等不到的圈。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, formatBytes, type FileEntry, type JobView } from '@/api'
import { isDelimitedText, isOfficeMime, OFFICE_LABEL } from '@/lib/file-kinds'
import { parseDelimited, type ParsedTable } from '@/lib/csv'
import { useWindows, type WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const windows = useWindows()

/** 只接受形状合法的 FileEntry；坏参数当作"没有文件"处理，不炸界面。 */
const node = computed<FileEntry | null>(() => {
  const raw = props.win.args?.node as FileEntry | undefined
  return raw && typeof raw.id === 'string' && typeof raw.name === 'string' ? raw : null
})

/**
 * 实际展示的那个文件。
 *
 * Office 转换成功后它会被换成生成的 PDF 节点 —— 窗口标题与下载按钮随之切换，
 * 用户看到的就是"这个文档的 PDF 版"，不用另外开一个窗口。
 */
const shown = ref<FileEntry | null>(null)
watch(
  node,
  (n) => {
    shown.value = n
  },
  { immediate: true },
)

const mime = computed(() => shown.value?.mime ?? '')
const url = computed(() => (shown.value ? api.previewUrl(shown.value.id) : ''))
const isImage = computed(() => mime.value.startsWith('image/'))
const isVideo = computed(() => mime.value.startsWith('video/'))
const isAudio = computed(() => mime.value.startsWith('audio/'))
const isFrame = computed(() => mime.value === 'application/pdf' || mime.value.startsWith('text/'))
const isOffice = computed(() => isOfficeMime(mime.value))
const isTable = computed(() => isDelimitedText(mime.value))

// ------------------------------------------------------------------ 图片翻页

/**
 * 同目录的图片排成一条队列，用「上一张 / 下一张」按钮或方向键在它们之间走。
 *
 * 队列只装**图片**：如果按"同目录所有文件"翻，按一下跳到一份要转 PDF 的 PPT 上，
 * 用户会以为翻页坏了。文档类的相邻浏览是另一件事（也没有统一的排序语义）。
 *
 * 顺序以文件管理器传来的 `queue`（id 列表）为准 —— 用户可能按大小/时间排过序，
 * 翻页顺序该跟他眼前看到的一致。窗口被布局恢复重开时没有 queue，
 * 那就退回目录自身的顺序（文件夹在前、名字升序），总比"翻不动"好。
 *
 * 为什么只传 id 不传整个 entry：窗口布局会写进 localStorage，
 * 目录里几百张图时带全量元数据只会让那份快照无谓地变大。
 */
const gallery = ref<FileEntry[]>([])

const galleryPos = computed(() =>
  shown.value ? gallery.value.findIndex((e) => e.id === shown.value?.id) : -1,
)
const canPrev = computed(() => galleryPos.value > 0)
const canNext = computed(() => galleryPos.value >= 0 && galleryPos.value < gallery.value.length - 1)

async function loadGallery(): Promise<void> {
  const target = shown.value
  if (!target || !isImage.value) {
    gallery.value = []
    return
  }
  const hinted = props.win.args?.queue
  const queueIds = Array.isArray(hinted) ? hinted.filter((id): id is string => typeof id === 'string') : []
  try {
    const listing = await api.listFiles(target.parentId, target.space)
    const images = listing.entries.filter(
      (e) => e.kind === 'file' && (e.mime ?? '').startsWith('image/'),
    )
    let ordered: FileEntry[]
    if (queueIds.length > 0) {
      const byId = new Map(images.map((e) => [e.id, e]))
      ordered = queueIds.map((id) => byId.get(id)).filter((e): e is FileEntry => !!e)
    } else {
      ordered = images
    }
    // 当前这张必须在队列里，否则位置算成 -1、两个按钮永远是灰的
    if (!ordered.some((e) => e.id === target.id)) ordered = [target, ...ordered]
    gallery.value = ordered
    prefetchNeighbors()
  } catch {
    // 拿不到目录列表（无权限/网络抖动）就退化成"只有这一张"，翻页按钮不出现
    gallery.value = [target]
  }
}

/** 翻页。delta = -1 上一张，+1 下一张。 */
function turn(delta: number): void {
  const pos = galleryPos.value
  if (pos < 0) return
  const next = gallery.value[pos + delta]
  if (!next) return
  // 上一张可能是"PDF 版"状态，翻页即回到原图
  convertedFrom.value = null
  failed.value = false
  mediaError.value = ''
  shown.value = next
  windows.setTitle(props.win.id, next.name)
  prefetchNeighbors()
}

/**
 * 预取前后各一张。
 *
 * 手机拍的图动辄几 MB，不预取的话每按一次方向键都要空等一轮下载。
 * 用 `new Image()` 只是把图丢进浏览器缓存，不插入 DOM、不影响当前显示。
 */
function prefetchNeighbors(): void {
  const pos = galleryPos.value
  for (const offset of [1, -1]) {
    const target = gallery.value[pos + offset]
    if (!target) continue
    const img = new Image()
    img.src = api.previewUrl(target.id)
  }
}

/**
 * 方向键翻页。
 *
 * 只有**这个窗口在最上面**时才响应 —— 否则在聊天框里按 ← 会把背后那张图翻掉。
 * 左右与上下都算：图片浏览器的通行做法，用户不用记哪个键。
 */
function onKeydown(event: KeyboardEvent): void {
  if (windows.activeId !== props.win.id) return
  if (!showNav.value) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const el = event.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return

  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    if (!canPrev.value) return
    event.preventDefault()
    turn(-1)
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    if (!canNext.value) return
    event.preventDefault()
    turn(1)
  }
}

/**
 * 有第二张图才显示翻页控件（含计数器）。
 *
 * 刻意不把"加载失败"算进来：某一张图坏了（磁盘上文件被删、格式怪）时，
 * 用户更需要的是"继续翻下一张"，而不该被卡在这一张上。
 */
const showNav = computed(() => isImage.value && gallery.value.length > 1)

/** 加载失败（文件被删 / 无权限 / 解码失败）时给一个体面的兜底。 */
const failed = ref(false)

/**
 * 失败时到底说哪句话。
 *
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` 与别的失败不是一回事：前者是**服务端把文件
 * 完整给了、浏览器解不了码**（手机拍的 HEVC / H.265 最常见），下载下来用
 * 本地播放器就能看；后者才是网络或权限问题。混成一句"暂时无法预览"
 * 会让人以为文件坏了。
 */
const mediaError = ref('')

function onMediaError(event: Event): void {
  const el = event.target as HTMLVideoElement | HTMLAudioElement
  if (el.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    mediaError.value = '视频能连上，但这种编码浏览器解不了（常见于手机拍的 HEVC / H.265），下载后用本地播放器观看即可'
  } else {
    mediaError.value = ''
  }
  failed.value = true
}

/** "转成 PDF 预览"得到的产物，用于回看原文件。 */
const convertedFrom = ref<FileEntry | null>(null)

function download(): void {
  const target = shown.value
  if (!target) return
  const a = document.createElement('a')
  a.href = api.downloadUrl(target.id)
  a.download = target.name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// ------------------------------------------------------------------ CSV / TSV

/** 超过这个体积就不做表格渲染：几十 MB 的表在浏览器里解析会把标签页卡死。 */
const TABLE_MAX_BYTES = 2 * 1024 * 1024
/** 最多渲染多少行（解析上限，见 lib/csv.ts 的 maxRows）。 */
const TABLE_MAX_ROWS = 1000

type TableState = 'idle' | 'loading' | 'ready' | 'error' | 'tooBig'
const tableState = ref<TableState>('idle')
const table = ref<ParsedTable | null>(null)
const tableError = ref('')
/** 表格视图 ↔ 纯文本视图。解析结果不理想时用户能自己退回纯文本。 */
const asRawText = ref(false)

async function loadTable(): Promise<void> {
  const target = shown.value
  if (!target) return
  if (target.size > TABLE_MAX_BYTES) {
    tableState.value = 'tooBig'
    return
  }
  tableState.value = 'loading'
  try {
    const res = await fetch(api.previewUrl(target.id))
    if (!res.ok) throw new Error(`读取失败（${res.status}）`)
    table.value = parseDelimited(await res.text(), { maxRows: TABLE_MAX_ROWS })
    tableState.value = 'ready'
  } catch (err) {
    tableError.value = err instanceof Error ? err.message : String(err)
    tableState.value = 'error'
  }
}

// ------------------------------------------------------------------ Office → PDF

type OfficeState = 'checking' | 'available' | 'unavailable' | 'converting' | 'error'
const officeState = ref<OfficeState>('checking')
const officeReason = ref('')
const jobProgress = ref(0)

/**
 * 转换结果缓存（仅本次会话）。
 *
 * 产物是**真实落盘的文件节点**（保存在原文件所在目录），不是临时对象 ——
 * 所以同一个文件第二次点预览时没必要再转一次，也不用再往目录里多塞一份 PDF。
 */
const convertedCache = new Map<string, FileEntry>()

/** 工具可用性只问一次：它只随部署变化，不随文件变化。 */
let toolAvailable: boolean | null = null
let toolReason = ''

async function checkTool(): Promise<void> {
  if (toolAvailable !== null) {
    officeState.value = toolAvailable ? 'available' : 'unavailable'
    officeReason.value = toolReason
    return
  }
  try {
    const { tools } = await api.listTools()
    const tool = tools.find((t) => t.id === 'doc.to-pdf')
    toolAvailable = tool?.available ?? false
    toolReason = tool?.unavailableReason ?? '当前没有可用的文档转换工具。'
  } catch (err) {
    toolAvailable = false
    toolReason = err instanceof Error ? err.message : String(err)
  }
  officeState.value = toolAvailable ? 'available' : 'unavailable'
  officeReason.value = toolReason
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询任务直到结束。转换要过一遍 LibreOffice，几十秒是正常的。 */
async function waitJob(jobId: string): Promise<JobView> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const { job } = await api.getJob(jobId)
    jobProgress.value = job.progress
    if (job.state === 'done') return job
    if (job.state === 'failed' || job.state === 'canceled') {
      throw new Error(job.error ?? job.message ?? '转换失败')
    }
    await sleep(1200)
  }
  throw new Error('转换超时（超过 2 分钟仍未完成），可以稍后重试')
}

async function convertToPdf(): Promise<void> {
  const source = shown.value
  if (!source) return

  const cached = convertedCache.get(source.id)
  if (cached) {
    showConverted(source, cached)
    return
  }

  officeState.value = 'converting'
  jobProgress.value = 0
  try {
    const { jobId } = await api.runTool('doc.to-pdf', {
      nodeIds: [source.id],
      params: {},
      space: source.space,
    })
    const job = await waitJob(jobId)
    const outputId = job.outputNodeIds[0]
    if (!outputId) throw new Error('转换完成了，但没有产出文件')

    // 产物是落盘的节点，去列表里取它的真实名字与大小，
    // 而不是自己拼一个"xxx.pdf"（Gotenberg 多输入时会打包成 zip）。
    let output: FileEntry | null = null
    try {
      const listing = await api.listFiles(source.parentId, source.space)
      output = listing.entries.find((e) => e.id === outputId) ?? null
    } catch {
      /* 取不到就用兜底，不影响预览 */
    }
    output ??= {
      id: outputId,
      parentId: source.parentId,
      name: `${source.name.replace(/\.[^.]+$/, '')}.pdf`,
      kind: 'file',
      space: source.space,
      size: 0,
      mime: 'application/pdf',
      sha256: null,
      ownerId: source.ownerId,
      ownerName: source.ownerName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    showConverted(source, output)
  } catch (err) {
    officeState.value = 'error'
    officeReason.value = err instanceof Error ? err.message : String(err)
  }
}

function showConverted(source: FileEntry, output: FileEntry): void {
  convertedCache.set(source.id, output)
  convertedFrom.value = source
  shown.value = output
  officeState.value = 'available'
  failed.value = false
}

/** 从 PDF 版本退回原文件（重新打开时仍是"未转换"状态，可再转一次）。 */
function showOriginal(): void {
  const source = convertedFrom.value
  if (!source) return
  convertedFrom.value = null
  shown.value = source
}

onMounted(() => {
  // Office：先问工具在不在，决定按钮能不能点、不能点时说什么
  if (isOffice.value) void checkTool()
  // 表格：直接解析
  if (isTable.value) void loadTable()
  // 图片：拉同目录的图片清单，凑出一条可以左右翻的队列
  if (isImage.value) void loadGallery()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

watch([isOffice, isTable], ([office, tbl]) => {
  if (office) void checkTool()
  if (tbl) void loadTable()
})
</script>

<template>
  <div class="pv">
    <header class="pv__bar">
      <Icon
        :name="isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file'"
        :size="15"
        class="pv__icon"
      />
      <span class="pv__name" :title="shown?.name">{{ shown?.name ?? '文件预览' }}</span>
      <span v-if="shown" class="wl-badge">{{ formatBytes(shown.size) }}</span>
      <span v-if="showNav" class="pv__counter">{{ galleryPos + 1 }} / {{ gallery.length }}</span>
      <span v-if="convertedFrom" class="pv__converted">PDF 版</span>

      <span class="pv__spacer" />

      <button v-if="convertedFrom" class="wl-btn" @click="showOriginal">
        <Icon name="file" :size="14" />
        <span>看原文件</span>
      </button>
      <button
        v-else-if="isTable && tableState === 'ready'"
        class="wl-btn"
        @click="asRawText = !asRawText"
      >
        <Icon name="file" :size="14" />
        <span>{{ asRawText ? '表格视图' : '纯文本' }}</span>
      </button>
      <button class="wl-btn" :disabled="!shown" @click="download">
        <Icon name="download" :size="14" />
        <span>下载</span>
      </button>
    </header>

    <div class="pv__body" :class="{ 'pv__body--flow': isTable || isOffice }">
      <div v-if="!shown" class="wl-empty">
        <Icon name="file" :size="30" />
        <span>没有可预览的文件</span>
      </div>

      <img v-else-if="isImage && !failed" class="pv__img" :src="url" :alt="shown.name" @error="failed = true" />

      <!--
        preload="metadata"：只先拿容器头（时长/尺寸）就停，不自动下完整段 ——
        起播与拖动进度条靠的是 HTTP Range（服务端已支持 206），这里不声明的话
        有的浏览器会打开窗口就开始整段下载。
        playsinline：iOS Safari 上不加会强制全屏接管。
      -->
      <video
        v-else-if="isVideo && !failed"
        class="pv__media"
        :src="url"
        controls
        playsinline
        preload="metadata"
        @error="onMediaError"
      />

      <audio v-else-if="isAudio && !failed" class="pv__audio" :src="url" controls @error="failed = true" />

      <!-- 表格：CSV / TSV 自己解析，不依赖任何服务端能力 -->
      <div v-else-if="isTable" class="pv__tableWrap">
        <div v-if="tableState === 'loading'" class="wl-empty">
          <span>正在解析…</span>
        </div>

        <div v-else-if="tableState === 'tooBig'" class="wl-empty">
          <Icon name="alert" :size="30" />
          <span>这个文件有 {{ formatBytes(shown.size) }}，超过 {{ formatBytes(TABLE_MAX_BYTES) }} 就不做表格渲染了（会卡住页面）</span>
          <iframe class="pv__frame" :src="url" :title="shown.name" />
        </div>

        <div v-else-if="tableState === 'error'" class="wl-empty">
          <Icon name="alert" :size="30" />
          <span>读取失败：{{ tableError }}</span>
        </div>

        <div v-else-if="tableState === 'ready' && table && !asRawText" class="pv__tableBox">
          <table class="pv__table">
            <thead v-if="table.header">
              <tr>
                <th class="pv__num">#</th>
                <th v-for="(cell, i) in table.header" :key="`h${i}`">{{ cell }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, r) in table.rows" :key="`r${r}`">
                <td class="pv__num">{{ r + 1 }}</td>
                <td v-for="(cell, c) in row" :key="`c${c}`">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="table.truncated" class="pv__note">
            共 {{ table.totalRows }} 行，只显示前 {{ TABLE_MAX_ROWS }} 行（完整内容请下载）
          </p>
        </div>

        <!-- 判定不出表头 / 用户切到纯文本 / 还没解析完：都退回纯文本渲染 -->
        <iframe v-else class="pv__frame" :src="url" :title="shown.name" />
      </div>

      <!-- Office：浏览器渲染不了，先转成 PDF -->
      <div v-else-if="isOffice" class="pv__office">
        <div class="wl-empty">
          <Icon name="file" :size="30" />
          <span>{{ OFFICE_LABEL[mime] ?? 'Office 文档' }}需要转成 PDF 才能预览</span>

          <button
            v-if="officeState === 'available'"
            class="wl-btn wl-btn--primary"
            @click="convertToPdf"
          >
            <Icon name="download" :size="15" />
            <span>转为 PDF 预览</span>
          </button>

          <div v-else-if="officeState === 'converting'" class="pv__progress">
            <div class="pv__bar2"><i :style="{ width: `${jobProgress}%` }" /></div>
            <span>转换中… {{ jobProgress }}%（首次转换要等 LibreOffice 启动，约 10-30 秒）</span>
          </div>

          <template v-else>
            <p class="pv__reason">{{ officeReason }}</p>
            <button v-if="officeState === 'error'" class="wl-btn" @click="convertToPdf">
              <Icon name="refresh" :size="15" />
              <span>重试</span>
            </button>
          </template>

          <p v-if="officeState === 'available'" class="pv__note">
            转换后的 PDF 会保存在原文件所在目录
          </p>
        </div>
      </div>

      <!-- PDF 与文本走内置查看器 / 纯文本渲染；响应头已有 CSP sandbox 兜底 -->
      <iframe v-else-if="isFrame && !failed" class="pv__frame" :src="url" :title="shown.name" @error="failed = true" />

      <div v-else class="wl-empty">
        <Icon name="alert" :size="30" />
        <span>{{ failed ? (mediaError || '这个文件暂时无法预览，可以下载后本地查看') : '此类文件不支持在线预览' }}</span>
        <button class="wl-btn wl-btn--primary" @click="download">
          <Icon name="download" :size="15" />
          <span>下载文件</span>
        </button>
      </div>

      <!-- 图片翻页：同目录还有其他图时才出现 -->
      <button
        v-if="showNav && canPrev"
        class="pv__nav pv__nav--prev"
        title="上一张（← / ↑）"
        aria-label="上一张"
        @click="turn(-1)"
      >
        <Icon name="chevron-left" :size="20" />
      </button>
      <button
        v-if="showNav && canNext"
        class="pv__nav pv__nav--next"
        title="下一张（→ / ↓）"
        aria-label="下一张"
        @click="turn(1)"
      >
        <Icon name="chevron-right" :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pv__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.pv__icon {
  flex: none;
  color: var(--text-secondary);
}

.pv__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.pv__converted {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  padding: 1px 6px;
  border: 1px solid var(--line-hair);
  border-radius: 999px;
}

/* 「3 / 12」：等宽数字，翻页时宽度不跳 */
.pv__counter {
  flex: none;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.pv__spacer {
  flex: 1;
}

.pv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: var(--space-3);
  background: var(--surface-0);
  /* 翻页按钮贴在图片两侧，用绝对定位（不占布局，图片仍居中） */
  position: relative;
}

/* 表格与 Office 卡片是"从上往下读"的内容，居中反而会把第一行推到中间 */
.pv__body--flow {
  align-items: stretch;
  justify-content: flex-start;
}

.pv__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
}

/* ------------------------------------------------------------ 图片翻页 */

.pv__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--line-hair);
  border-radius: 999px;
  background: var(--surface-1);
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: var(--shadow-card);
  opacity: 0.88;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  z-index: 2;
}

.pv__nav:hover {
  opacity: 1;
  color: var(--text);
  background: var(--surface-2);
}

.pv__nav:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pv__nav--prev {
  left: var(--space-3);
}

.pv__nav--next {
  right: var(--space-3);
}

.pv__media {
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
}

.pv__audio {
  width: min(420px, 100%);
}

.pv__frame {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 6px;
  background: #fff;
}

/* ------------------------------------------------------------ 表格 */

.pv__tableWrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
}

.pv__tableBox {
  overflow: auto;
  min-height: 0;
  border: 1px solid var(--line-hair);
  border-radius: 6px;
  background: var(--surface-1);
}

.pv__table {
  border-collapse: collapse;
  font-size: var(--fs-body);
  /* 单元格不换行、横向滚动：表格宽的时候滚动比把行撑成三段更好读 */
  white-space: nowrap;
}

.pv__table th,
.pv__table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--line-hair);
  border-right: 1px solid var(--line-hair);
  text-align: left;
}

.pv__table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-2);
  font-weight: 600;
}

/* 行号列：看着淡一点，且滚动时跟着表头一起钉住左边 */
.pv__num {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--surface-2);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  text-align: right !important;
}

.pv__note {
  flex: none;
  margin: var(--space-2) 0 0;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

/* ------------------------------------------------------------ Office */

.pv__office {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.pv__progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: min(420px, 100%);
}

.pv__bar2 {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}

.pv__bar2 i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}

.pv__reason {
  max-width: 520px;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-secondary);
  text-align: center;
}
</style>
