<!--
  在线表格编辑器（.xlsx）。

  ────────────────────────────────────────────────────────────────────────────
  它是什么、不是什么
  ────────────────────────────────────────────────────────────────────────────
  是：一个"打开共同表格、改几个数、存回去"的工具。样式、公式、列宽、合并单元格
  都由 ExcelJS 原样保留（见 lib/xlsx.ts 里的说明），所以保存之后用 Excel / WPS
  打开还是原来那份表。

  不是：Excel 的替代品。没有函数自动补全、没有图表编辑、没有数据透视表、
  没有协同编辑。界面上如实写着这些，而不是装作全都有。

  ────────────────────────────────────────────────────────────────────────────
  几个刻意的设计
  ────────────────────────────────────────────────────────────────────────────
  * **只渲染看得见的那几十行**（虚拟滚动）。一张一万行的表如果全画出来，
    打开窗口的那一瞬间标签页就会卡死 —— 而它其实只需要显示当前这一屏。
  * **保存是显式的**，并且带冲突检测：`base` 传的是打开时的 updatedAt，
    期间被别人改过就回 409 让你选，而不是静默覆盖。这一点比"自动保存"重要：
    自动保存遇到冲突时会悄悄把别人的修改抹掉。
  * **关闭窗口前会问一句**（windows.setCloseGuard）。改了没存就关掉，
    在任何桌面应用里都等于"丢弃"，用户不该在没有提示的情况下丢东西。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { api, ApiError, formatBytes, type FileEntry } from '@/api'
import {
  columnName,
  loadSpreadsheet,
  SHEET_MAX_RENDER_COLS,
  type CellVal,
  type Spreadsheet,
} from '@/lib/xlsx'
import { useUi } from '@/stores/ui'
import { useWindows, type WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const ui = useUi()
const windows = useWindows()

/** 行高（与 CSS 里的 `.se__row td` 保持一致，虚拟滚动靠它算偏移）。 */
const ROW_H = 26
/** 上下各多渲染几行，滚动时不会看到空白接缝。 */
const OVERSCAN = 6
/**
 * 打开的体积上限。
 *
 * 服务端保存上限是 32MB，但**打开**要宽松得多地卡一道：ExcelJS 解析 30MB 的
 * 表格会吃掉几百 MB 内存并让界面卡住十几秒，那体验比"直接告诉你太大了"差得多。
 */
const MAX_OPEN_BYTES = 16 * 1024 * 1024

/** 只接受形状合法的 FileEntry，坏参数当作"没有文件"。 */
const node = computed<FileEntry | null>(() => {
  const raw = props.win.args?.node as FileEntry | undefined
  return raw && typeof raw.id === 'string' && typeof raw.name === 'string' ? raw : null
})

type Phase = 'loading' | 'ready' | 'error'
const phase = ref<Phase>('loading')
const errorText = ref('')

/**
 * 表格句柄。
 *
 * ⚠️ `shallowRef` 而不是 `ref`：workbook 是一张几万个对象的深图，
 * 交给 Vue 的深层响应式代理之后，每一次读单元格都会产生依赖追踪，
 * 一万行的表会卡到无法使用。这里只把"它换了一个对象"当作变化。
 */
const book = shallowRef<Spreadsheet | null>(null)

const sheetNames = ref<string[]>([])
const activeSheet = ref('')
const rowCount = ref(1)
const columnCount = ref(1)
/** 每次改动 +1，用来让"可见行"重新算一遍（book 内部是可变对象）。 */
const version = ref(0)

const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(400)

const dirty = ref(false)
const saving = ref(false)
const conflict = ref(false)
/** 打开时的 updatedAt，保存时带给服务端做乐观并发校验。 */
const baseUpdatedAt = ref(0)

const sel = ref<{ row: number; col: number }>({ row: 1, col: 1 })
const editing = ref<{ row: number; col: number; draft: string; prev: string } | null>(null)
/**
 * 编辑中的输入框。
 *
 * ⚠️ 刻意**不用** `ref="editInput"`：那个 ref 写在 v-for 里，Vue 会把收集到的
 * 元素放进一个数组，于是 `editInput.value` 不是元素而是数组，
 * `editInput.value?.focus()` 就成了 `TypeError: ... focus is not a function`
 * —— 而且它只在"进编辑态"那一刻炸，界面上表现为输入框不聚焦、键盘全失灵，
 * 控制台里才看得到原因。改成按 DOM 查询，一个编辑态只有一个这样的输入框。
 */
function editInputEl(): HTMLInputElement | null {
  return scrollEl.value?.querySelector<HTMLInputElement>('.se__input') ?? null
}

// ---------------------------------------------------------------- 打开

async function open(): Promise<void> {
  const target = node.value
  if (!target) {
    phase.value = 'error'
    errorText.value = '没有要打开的文件'
    return
  }
  if (target.size > MAX_OPEN_BYTES) {
    phase.value = 'error'
    errorText.value =
      `这个表格有 ${formatBytes(target.size)}，超过在线编辑的 ${formatBytes(MAX_OPEN_BYTES)} 上限。` +
      `这么大的表在浏览器里打开会把页面卡住，建议下载后用本地软件编辑。`
    return
  }

  phase.value = 'loading'
  try {
    const res = await fetch(api.previewUrl(target.id))
    if (!res.ok) throw new Error(`读取失败（${res.status}）`)
    book.value = await loadSpreadsheet(await res.arrayBuffer())
    sheetNames.value = book.value.sheetNames
    activeSheet.value = book.value.activeName
    baseUpdatedAt.value = target.updatedAt
    refreshShape()
    phase.value = 'ready'
    await nextTick()
    measure()
  } catch (err) {
    phase.value = 'error'
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

function refreshShape(): void {
  const b = book.value
  rowCount.value = b?.rowCount ?? 1
  columnCount.value = b?.columnCount ?? 1
  version.value += 1
}

/** 当前工作表实际要画的列数（超出的部分不画，保存时仍然完整）。 */
const cols = computed(() => Math.min(columnCount.value, SHEET_MAX_RENDER_COLS))

// ---------------------------------------------------------------- 虚拟滚动

function measure(): void {
  const el = scrollEl.value
  if (!el) return
  viewportH.value = el.clientHeight
  scrollTop.value = el.scrollTop
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  // 每次滚动都改 ref 会触发重算，但这里只改一个数字、重算也只读一屏，
  // 比"节流 + 手动同步"简单得多，实测没有可见的掉帧
  scrollTop.value = el.scrollTop
}

const firstRow = computed(() => Math.max(1, Math.floor(scrollTop.value / ROW_H) + 1 - OVERSCAN))
const visibleRows = computed(() => Math.ceil(viewportH.value / ROW_H) + OVERSCAN * 2)

const rows = computed<string[][]>(() => {
  const b = book.value
  if (!b) return []
  void version.value
  return b.readRows(firstRow.value, visibleRows.value)
})

const lastRenderedRow = computed(() => firstRow.value + rows.value.length - 1)

// ---------------------------------------------------------------- 选择与编辑

function select(row: number, col: number): void {
  if (editing.value) commitEdit()
  sel.value = { row, col }
  // 点到的行/列若在可视区外（例如用键盘移出屏幕），把它滚进来
  const el = scrollEl.value
  if (!el) return
  const top = (row - 1) * ROW_H
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
}

function startEdit(initial?: string): void {
  const b = book.value
  if (!b) return
  const { row, col } = sel.value
  const prev = b.cellText(row, col)
  editing.value = { row, col, draft: initial ?? prev, prev }
  void nextTick(() => {
    const input = editInputEl()
    input?.focus()
    if (initial === undefined) input?.select()
  })
}

function commitEdit(): void {
  const b = book.value
  const current = editing.value
  editing.value = null
  if (!b || !current) return
  const before = b.cellValue(current.row, current.col)
  const after = current.draft
  if (after === current.prev) return // 没改就不进撤销栈，也不标脏
  pushUndo(`修改 ${columnName(current.col)}${current.row}`, () => {
    b.setCellValue(current.row, current.col, before)
    dirty.value = true
    refreshShape()
  })
  b.setCellText(current.row, current.col, after)
  dirty.value = true
  refreshShape()
}

function cancelEdit(): void {
  editing.value = null
}

async function clearCell(): Promise<void> {
  const b = book.value
  if (!b) return
  const { row, col } = sel.value
  const before = b.cellValue(row, col)
  if (before === null || before === undefined) return
  pushUndo('清空单元格', () => {
    b.setCellValue(row, col, before)
    dirty.value = true
    refreshShape()
  })
  b.setCellText(row, col, '')
  dirty.value = true
  refreshShape()
}

// ---------------------------------------------------------------- 撤销

const undoStack: Array<{ label: string; run: () => void }> = []

function pushUndo(label: string, run: () => void): void {
  undoStack.push({ label, run })
  // 只留最近 50 步：再多的"撤销"没人用，而存下来的是闭包（含单元格旧值）
  if (undoStack.length > 50) undoStack.shift()
}

function undo(): void {
  const step = undoStack.pop()
  if (!step) {
    ui.notify('info', '没有可撤销的操作')
    return
  }
  step.run()
  dirty.value = true
  refreshShape()
  ui.notify('info', `已撤销：${step.label}`)
}

// ---------------------------------------------------------------- 行列操作

function insertRow(): void {
  const b = book.value
  if (!b) return
  const at = sel.value.row
  pushUndo('插入行', () => {
    b.deleteRow(at)
    refreshShape()
  })
  b.insertRow(at)
  dirty.value = true
  refreshShape()
}

function deleteRow(): void {
  const b = book.value
  if (!b) return
  if (b.rowCount <= 1) {
    ui.notify('info', '至少要留一行')
    return
  }
  const at = sel.value.row
  const snapshot: CellVal[] = []
  for (let c = 1; c <= b.columnCount; c++) snapshot.push(b.cellValue(at, c))
  pushUndo(`删除第 ${at} 行`, () => {
    b.insertRow(at)
    snapshot.forEach((value, i) => b.setCellValue(at, i + 1, value))
    refreshShape()
  })
  b.deleteRow(at)
  sel.value = { row: Math.min(at, b.rowCount), col: sel.value.col }
  dirty.value = true
  refreshShape()
}

function insertColumn(): void {
  const b = book.value
  if (!b) return
  const at = sel.value.col
  pushUndo('插入列', () => {
    b.deleteColumn(at)
    refreshShape()
  })
  b.insertColumn(at)
  dirty.value = true
  refreshShape()
}

function deleteColumn(): void {
  const b = book.value
  if (!b) return
  if (b.columnCount <= 1) {
    ui.notify('info', '至少要留一列')
    return
  }
  const at = sel.value.col
  const snapshot: CellVal[] = []
  for (let r = 1; r <= b.rowCount; r++) snapshot.push(b.cellValue(r, at))
  pushUndo(`删除第 ${columnName(at)} 列`, () => {
    b.insertColumn(at)
    snapshot.forEach((value, i) => b.setCellValue(i + 1, at, value))
    refreshShape()
  })
  b.deleteColumn(at)
  sel.value = { row: sel.value.row, col: Math.min(at, b.columnCount) }
  dirty.value = true
  refreshShape()
}

function switchSheet(name: string): void {
  const b = book.value
  if (!b || name === activeSheet.value) return
  if (editing.value) commitEdit()
  if (!b.select(name)) return
  activeSheet.value = name
  sel.value = { row: 1, col: 1 }
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  refreshShape()
}

// ---------------------------------------------------------------- 保存

async function save(options: { force?: boolean } = {}): Promise<void> {
  const b = book.value
  const target = node.value
  if (!b || !target || saving.value) return

  saving.value = true
  try {
    const bytes = await b.toBytes()
    const result = await api.saveFileContent(
      target.id,
      bytes,
      // force = 用户在冲突提示里明确选择了"用我的版本覆盖"
      options.force ? undefined : baseUpdatedAt.value,
    )
    baseUpdatedAt.value = result.node.updatedAt
    dirty.value = false
    conflict.value = false
    undoStack.length = 0
    ui.notify('success', '已保存', `${target.name} · ${formatBytes(result.node.size)}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // 冲突不是"保存失败"，是"需要你做个决定"，所以不走红色错误提示那一套
      conflict.value = true
      return
    }
    ui.notify('error', '保存失败', err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

/** 放弃本地修改，重新从服务端读一遍（冲突时的"看看别人改了什么"）。 */
async function reload(): Promise<void> {
  conflict.value = false
  dirty.value = false
  undoStack.length = 0
  await open()
}

// ---------------------------------------------------------------- 键盘

function isActive(): boolean {
  return windows.activeId === props.win.id
}

function onKeydown(event: KeyboardEvent): void {
  if (!isActive() || phase.value !== 'ready') return

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undo()
    return
  }
  // 输入框自己在处理键盘，别再插一脚（否则输入 "n" 会被当成"下一行"）
  if (editing.value) return

  const { row, col } = sel.value
  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault()
      select(Math.max(1, row - 1), col)
      break
    case 'ArrowDown':
      event.preventDefault()
      select(Math.min(rowCount.value, row + 1), col)
      break
    case 'ArrowLeft':
      event.preventDefault()
      select(row, Math.max(1, col - 1))
      break
    case 'ArrowRight':
      event.preventDefault()
      select(row, Math.min(cols.value, col + 1))
      break
    case 'Tab':
      event.preventDefault()
      select(row, Math.min(cols.value, col + (event.shiftKey ? -1 : 1)))
      break
    case 'Enter':
    case 'F2':
      event.preventDefault()
      startEdit()
      break
    case 'Delete':
    case 'Backspace':
      event.preventDefault()
      void clearCell()
      break
    default:
      // 直接打字 = 覆盖这一格（Excel 的行为）
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        startEdit(event.key)
      }
      break
  }
}

function onEditKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitEdit()
    select(Math.min(rowCount.value, sel.value.row + 1), sel.value.col)
  } else if (event.key === 'Tab') {
    event.preventDefault()
    commitEdit()
    select(sel.value.row, Math.min(cols.value, sel.value.col + 1))
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  }
}

// ---------------------------------------------------------------- 关闭守卫

interface AskState {
  title: string
  message: string
  confirmText: string
  resolve: (ok: boolean) => void
}
const ask = ref<AskState | null>(null)

function askConfirm(title: string, message: string, confirmText = '确定'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    ask.value = { title, message, confirmText, resolve }
  })
}

function answerAsk(ok: boolean): void {
  ask.value?.resolve(ok)
  ask.value = null
}

// ---------------------------------------------------------------- 生命周期

let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  windows.setCloseGuard(props.win.id, async () => {
    if (!dirty.value) return true
    return askConfirm(
      '关闭窗口？',
      `「${node.value?.name ?? '这个表格'}」有未保存的修改，关掉就没了。`,
      '放弃修改并关闭',
    )
  })
  await open()
  // 表格区是 phase 变成 ready 之后才出现的，所以观察器要等 open() 之后挂
  if (scrollEl.value) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(scrollEl.value)
    measure()
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  windows.setCloseGuard(props.win.id, null)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="se">
    <header class="se__bar">
      <Icon name="sheet" :size="15" class="se__icon" />
      <span class="se__name" :title="node?.name">{{ node?.name ?? '表格' }}</span>

      <select
        v-if="sheetNames.length > 1"
        class="wl-select se__sheets"
        :value="activeSheet"
        title="切换工作表"
        @change="switchSheet(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="name in sheetNames" :key="name" :value="name">{{ name }}</option>
      </select>
      <span v-else-if="activeSheet" class="wl-badge">{{ activeSheet }}</span>

      <span v-if="dirty" class="wl-badge wl-badge--warning">未保存</span>

      <span class="se__spacer" />

      <template v-if="phase === 'ready'">
        <span class="se__pos" :title="`当前选中 ${columnName(sel.col)}${sel.row}`">
          {{ columnName(sel.col) }}{{ sel.row }}
        </span>
        <button class="wl-icon-btn" title="撤销（Ctrl+Z）" @click="undo">
          <Icon name="restore" :size="15" />
        </button>
        <span class="se__divider" />
        <button class="wl-icon-btn" title="在上方插入一行" @click="insertRow">
          <Icon name="plus" :size="15" />
        </button>
        <button class="wl-icon-btn" title="删除当前行" @click="deleteRow">
          <Icon name="minus" :size="15" />
        </button>
        <button class="wl-icon-btn" title="在左侧插入一列" @click="insertColumn">
          <Icon name="grid" :size="15" />
        </button>
        <button class="wl-icon-btn" title="删除当前列" @click="deleteColumn">
          <Icon name="trash" :size="15" />
        </button>
        <span class="se__divider" />
        <button
          class="wl-btn"
          :class="dirty ? 'wl-btn--primary' : ''"
          :disabled="saving"
          @click="save()"
        >
          <Icon name="check" :size="14" />
          <span>{{ saving ? '保存中…' : '保存' }}</span>
        </button>
      </template>
    </header>

    <!-- 冲突：不静默覆盖，交给人决定 -->
    <div v-if="conflict" class="se__conflict">
      <Icon name="alert" :size="15" />
      <span class="se__conflictText">
        这个文件在你打开之后被改动过（可能是别人也编辑了它）。如果直接用当前内容保存，会覆盖掉对方的修改。
      </span>
      <button class="wl-btn" @click="reload">丢弃我的修改并重新加载</button>
      <button class="wl-btn wl-btn--danger" @click="save({ force: true })">仍用我的版本覆盖</button>
    </div>

    <div class="se__body">
      <div v-if="phase === 'loading'" class="wl-empty">
        <span class="wl-spinner" />
        <span>正在打开表格…</span>
      </div>

      <div v-else-if="phase === 'error'" class="wl-empty">
        <Icon name="alert" :size="30" />
        <span>{{ errorText }}</span>
      </div>

      <div v-else ref="scrollEl" class="se__grid" @scroll="onScroll">
        <table class="se__table">
          <colgroup>
            <col class="se__numCol" />
            <col v-for="c in cols" :key="c" class="se__col" />
          </colgroup>
          <thead>
            <tr>
              <th class="se__corner"></th>
              <th
                v-for="c in cols"
                :key="c"
                class="se__head"
                :class="{ 'is-active': c === sel.col }"
                :title="book?.headerText(c)"
              >
                {{ columnName(c) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <!-- 上方的空白占位：只渲染看得见的行，但滚动条长度要对得上 -->
            <tr v-if="firstRow > 1" class="se__pad">
              <td :colspan="cols + 1" :style="{ height: `${(firstRow - 1) * ROW_H}px` }"></td>
            </tr>

            <tr v-for="(row, i) in rows" :key="firstRow + i" class="se__row">
              <th
                class="se__num"
                :class="{ 'is-active': firstRow + i === sel.row }"
                @click="select(firstRow + i, sel.col)"
              >
                {{ firstRow + i }}
              </th>
              <td
                v-for="c in cols"
                :key="c"
                class="se__cell"
                :class="{
                  'is-active': firstRow + i === sel.row && c === sel.col,
                  'is-editing': editing?.row === firstRow + i && editing?.col === c,
                }"
                @click="select(firstRow + i, c)"
                @dblclick="startEdit()"
              >
                <input
                  v-if="editing?.row === firstRow + i && editing?.col === c"
                  v-model="editing.draft"
                  class="se__input"
                  @keydown="onEditKey"
                  @blur="commitEdit"
                />
                <span v-else class="se__text">{{ row[c - 1] ?? '' }}</span>
              </td>
            </tr>

            <tr v-if="lastRenderedRow < rowCount" class="se__pad">
              <td
                :colspan="cols + 1"
                :style="{ height: `${(rowCount - lastRenderedRow) * ROW_H}px` }"
              ></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <footer v-if="phase === 'ready'" class="se__foot">
      <span>{{ rowCount }} 行 × {{ columnCount }} 列</span>
      <span v-if="columnCount > cols">（只显示前 {{ cols }} 列，保存时全表都在）</span>
      <span class="se__spacer" />
      <span>双击或直接打字改单元格 · Enter 换行下一格 · Ctrl+S 保存</span>
    </footer>

    <ConfirmDialog
      v-if="ask"
      :title="ask.title"
      :message="ask.message"
      :confirm-text="ask.confirmText"
      danger
      cancel-text="继续编辑"
      @confirm="answerAsk(true)"
      @cancel="answerAsk(false)"
    />
  </div>
</template>

<style scoped>
.se {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-0);
}

.se__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.se__icon {
  flex: none;
  color: var(--text-secondary);
}

.se__name {
  min-width: 0;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.se__sheets {
  height: 26px;
  font-size: var(--fs-caption);
  max-width: 160px;
}

.se__spacer {
  flex: 1;
}

.se__pos {
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  min-width: 44px;
  text-align: right;
}

.se__divider {
  width: 1px;
  height: 16px;
  background: var(--line-hair);
}

.se__conflict {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  flex: none;
  padding: var(--space-2) var(--space-3);
  background: var(--warning-soft);
  color: var(--text);
  font-size: var(--fs-caption);
  border-bottom: 1px solid var(--line-hair);
}

.se__conflictText {
  flex: 1;
  min-width: 240px;
  line-height: 1.5;
}

.se__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ------------------------------------------------------------ 表格 */

.se__grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--surface-1);
}

.se__table {
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-size: var(--fs-body);
}

.se__numCol {
  width: 48px;
}

.se__col {
  width: 112px;
}

.se__head,
.se__corner {
  position: sticky;
  top: 0;
  z-index: 3;
  height: 26px;
  background: var(--surface-2);
  border-right: 1px solid var(--line-hair);
  border-bottom: 1px solid var(--line-hair);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: center;
  /* 列标不该被选中（拖选单元格时会顺带选到它） */
  user-select: none;
}

.se__corner {
  left: 0;
  z-index: 4;
}

.se__head.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.se__num {
  position: sticky;
  left: 0;
  z-index: 2;
  width: 48px;
  height: 26px;
  background: var(--surface-2);
  border-right: 1px solid var(--line-hair);
  border-bottom: 1px solid var(--line-hair);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: center;
  cursor: pointer;
  user-select: none;
}

.se__num.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.se__row td {
  height: 26px;
}

.se__cell {
  padding: 0 7px;
  border-right: 1px solid var(--line-hair);
  border-bottom: 1px solid var(--line-hair);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: cell;
}

.se__cell.is-active {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}

.se__cell.is-editing {
  padding: 0;
  background: var(--surface-1);
}

.se__text {
  display: block;
  overflow: hidden;
  white-space: pre;
  text-overflow: ellipsis;
}

.se__input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: none;
  outline: none;
  background: var(--surface-1);
  color: var(--text);
  font: inherit;
}

.se__pad td {
  padding: 0;
  border: none;
}

/* ------------------------------------------------------------ 底栏 */

.se__foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: 4px var(--space-3);
  border-top: 1px solid var(--line-hair);
  background: var(--surface-1);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}
</style>
