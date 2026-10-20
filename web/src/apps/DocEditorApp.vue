<!--
  在线文档编辑器（.docx）。

  ────────────────────────────────────────────────────────────────────────────
  它编辑的是"内容"，不是"版面"
  ────────────────────────────────────────────────────────────────────────────
  界面把文档呈现成一段一段的内容（标题 / 正文 / 列表 / 表格），而不是像 Word 那样
  把 A4 纸画出来。原因在于保真策略：保存时只替换 `word/document.xml`，
  页边距、页眉页脚、图片、字体全部原样不动（见 lib/docx.ts 头注释）。
  反过来，如果界面画出一张"纸"，就必须在浏览器里重建分页与字体，那才会真的
  把版面弄坏。
  所以这里的承诺是：**文字和格式改对了，版面一个像素都不动**。
  界面上也这么写着，不假装自己是 Word。

  ────────────────────────────────────────────────────────────────────────────
  没建模的内容一律只读
  ────────────────────────────────────────────────────────────────────────────
  图片、图表、文本框、含图片的表格：整段原样保留、界面标灰。
  这是"宁可不让你改，也不能给你改没了"。真正要改这些，下载后用本地软件打开。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { api, ApiError, formatBytes, type FileEntry } from '@/api'
import {
  loadDocument,
  type DocBlock,
  type DocRun,
  type ParaLevel,
  type TableBlock,
  type WordDocument,
} from '@/lib/docx'
import { useUi } from '@/stores/ui'
import { useWindows, type WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const ui = useUi()
const windows = useWindows()

/** 打开的体积上限（与表格编辑器同样的理由：解析在浏览器里做）。 */
const MAX_OPEN_BYTES = 20 * 1024 * 1024

const node = computed<FileEntry | null>(() => {
  const raw = props.win.args?.node as FileEntry | undefined
  return raw && typeof raw.id === 'string' && typeof raw.name === 'string' ? raw : null
})

type Phase = 'loading' | 'ready' | 'error'
const phase = ref<Phase>('loading')
const errorText = ref('')

/**
 * 文档句柄。同样用 shallowRef：doc.blocks 里的对象不参与响应式，
 * 改动之后靠 `version` 手动通知界面重算（见下面的 blocks computed）。
 */
const doc = shallowRef<WordDocument | null>(null)
const version = ref(0)

const blocks = computed<DocBlock[]>(() => {
  void version.value
  return doc.value?.blocks ?? []
})

/** 每个块渲染出的 innerHTML。**只在结构性变化时重建** —— 打字时不重建，否则光标会跳。 */
const rendered = ref<string[]>([])
/** 每个块的稳定 key，避免按下标复用时把 DOM 内容张冠李戴。 */
const keys = ref<number[]>([])
let keySeq = 0

const rootEl = ref<HTMLElement | null>(null)
const focused = ref(-1)
const dirty = ref(false)
const saving = ref(false)
const conflict = ref(false)
const baseUpdatedAt = ref(0)

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
      `这个文档有 ${formatBytes(target.size)}，超过在线编辑的 ${formatBytes(MAX_OPEN_BYTES)} 上限。` +
      `请在下载后用本地软件编辑。`
    return
  }
  phase.value = 'loading'
  try {
    const res = await fetch(api.previewUrl(target.id))
    if (!res.ok) throw new Error(`读取失败（${res.status}）`)
    doc.value = loadDocument(await res.arrayBuffer())
    if (doc.value.blocks.length === 0) doc.value.insertParagraphAfter(-1)
    baseUpdatedAt.value = target.updatedAt
    rebuild()
    phase.value = 'ready'
  } catch (err) {
    phase.value = 'error'
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

/** 重建 innerHTML 与 key（插入/删除块之后必须调）。 */
function rebuild(): void {
  const list = doc.value?.blocks ?? []
  rendered.value = list.map((block) =>
    block.kind === 'p' || block.kind === 'list' ? renderRuns(block.runs) : '',
  )
  keys.value = list.map(() => ++keySeq)
  version.value += 1
}

// ---------------------------------------------------------------- 渲染

/** 把 runs 渲染成 contenteditable 里的 HTML。 */
function renderRuns(runs: DocRun[]): string {
  if (runs.length === 0) return ''
  return runs
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/g, '<br>')
      if (html === '') return ''
      if (run.underline) html = `<u>${html}</u>`
      if (run.strike) html = `<s>${html}</s>`
      if (run.italic) html = `<i>${html}</i>`
      if (run.bold) html = `<b>${html}</b>`
      // 链接放在最外层：<a> 里再包格式标签才是合法结构
      if (run.href) {
        html = `<a href="${escapeAttr(run.href)}" data-link-id="${escapeAttr(run.linkId ?? '')}">${html}</a>`
      }
      return html
    })
    .join('')
}

function cellHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------- 反向解析（DOM → runs）

/**
 * 把浏览器产生的 HTML 读回 runs。
 *
 * 只认四种行内格式（粗/斜/下划线/删除线）与 `<a>`。其余标签（span、font、
 * 粘贴进来的表格样式…）一律**拆掉但保留文字** —— 那些东西我们无法写回 docx，
 * 留着只会在保存时凭空消失，不如当场就按纯文本处理。
 */
function htmlToRuns(root: HTMLElement): DocRun[] {
  const runs: DocRun[] = []

  const push = (text: string, fmt: Omit<DocRun, 'text'>): void => {
    if (text === '') return
    const last = runs[runs.length - 1]
    if (
      last &&
      !!last.bold === !!fmt.bold &&
      !!last.italic === !!fmt.italic &&
      !!last.underline === !!fmt.underline &&
      !!last.strike === !!fmt.strike &&
      (last.href ?? null) === (fmt.href ?? null)
    ) {
      last.text += text
      return
    }
    runs.push({ text, ...fmt })
  }

  const walk = (node: Node, fmt: Omit<DocRun, 'text'>): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.nodeValue ?? '', fmt)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName

    if (tag === 'BR') {
      push('\n', fmt)
      return
    }
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? ''
      // 链接要落回 docx 必须有一个关系 id。新粘贴进来的 <a> 在这里补一个。
      const existing = el.getAttribute('data-link-id') ?? ''
      let linkId = existing
      if (!linkId && href) {
        linkId = doc.value?.addHyperlink(href) ?? ''
        if (!linkId) {
          // 协议不安全（比如 javascript:）—— 保留文字，不保留链接
          for (const child of Array.from(el.childNodes)) walk(child, fmt)
          return
        }
      }
      for (const child of Array.from(el.childNodes)) {
        walk(child, { ...fmt, linkId, href })
      }
      return
    }

    const next: Omit<DocRun, 'text'> = { ...fmt }
    if (tag === 'B' || tag === 'STRONG') next.bold = true
    if (tag === 'I' || tag === 'EM') next.italic = true
    if (tag === 'U') next.underline = true
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strike = true
    for (const child of Array.from(el.childNodes)) walk(child, next)
  }

  for (const child of Array.from(root.childNodes)) walk(child, {})
  return runs
}

// ---------------------------------------------------------------- 编辑

function onInput(index: number, event: Event): void {
  const block = blocks.value[index]
  if (!block || (block.kind !== 'p' && block.kind !== 'list')) return
  block.runs = htmlToRuns(event.target as HTMLElement)
  dirty.value = true
}

function onCellInput(index: number, row: number, col: number, event: Event): void {
  const block = blocks.value[index]
  if (!block || block.kind !== 'table') return
  const el = event.target as HTMLElement
  const rows = block.rows
  const target = rows[row]
  if (!target) return
  target[col] = (el.innerText ?? '').replace(/\u00a0/g, ' ')
  dirty.value = true
}

function onPaste(index: number, event: ClipboardEvent): void {
  // 一律按纯文本粘贴：从网页/微信里复制的内容带着一堆内联样式，
  // 我们既写不回 docx，也不该让它们污染文档
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text) document.execCommand('insertText', false, text)
}

function onKeydown(index: number, event: KeyboardEvent): void {
  const block = blocks.value[index]
  if (!block) return

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    doc.value?.insertParagraphAfter(index)
    rebuild()
    dirty.value = true
    void focusBlock(index + 1, true)
    return
  }
  // Shift+Enter：段内换行（<br>），交给浏览器
  if (event.key === 'Backspace' && (event.target as HTMLElement).innerText === '' && index > 0) {
    event.preventDefault()
    doc.value?.removeBlock(index)
    rebuild()
    dirty.value = true
    void focusBlock(index - 1, false)
  }
}

async function focusBlock(index: number, atStart: boolean): Promise<void> {
  await nextTick()
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-block="${index}"]`)
  if (!el) return
  el.focus()
  if (!atStart) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** 工具条动作作用在"最后获得焦点的那一段"上。 */
function currentIndex(): number {
  return focused.value >= 0 ? focused.value : blocks.value.length - 1
}

/** 当前段落的级别（工具条下拉框显示的就是它）。 */
const currentLevel = computed<ParaLevel>(() => {
  const block = blocks.value[currentIndex()]
  return block && block.kind === 'p' ? block.level : 0
})

function exec(command: string, value?: string): void {
  // 焦点不在可编辑区时 execCommand 什么都不做，先把它放回去
  const index = currentIndex()
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-block="${index}"]`)
  el?.focus()
  document.execCommand(command, false, value)
  // execCommand 会触发 input 事件，模型的同步交给 onInput
}

function setLevel(level: ParaLevel): void {
  const index = currentIndex()
  const block = blocks.value[index]
  if (!block || block.kind !== 'p') return
  block.level = level
  rebuild()
  dirty.value = true
  // rebuild 会把 DOM 重建一遍（key 变了），焦点会掉到 body 上 —— 放回去，
  // 否则连着改几段样式要一下一下重新点
  void focusBlock(index, false)
}

function toggleList(): void {
  const index = currentIndex()
  const block = blocks.value[index]
  if (!block) return
  if (block.kind === 'list') {
    // 变回正文：保留文字，去掉编号
    doc.value?.blocks.splice(index, 1, {
      kind: 'p',
      level: 0,
      origLevel: 0,
      align: null,
      runs: block.runs,
      pPrXml: block.pPrXml.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, ''),
      styleVal: null,
    })
    rebuild()
    dirty.value = true
    return
  }
  if (block.kind !== 'p') {
    ui.notify('info', '只有段落能变成列表项')
    return
  }
  const numId = doc.value?.bulletNumId() ?? null
  if (!numId) {
    ui.notify(
      'info',
      '这份文档没有可用的项目符号定义',
      'Word 的编号来自文档自带的 numbering.xml，这里不能凭空造一个（造出来在 Word 里可能不显示）。要加列表，请在本地软件里先建一条列表项，之后就能继续用了。',
      7000,
    )
    return
  }
  doc.value?.blocks.splice(index, 1, {
    kind: 'list',
    level: 1,
    ordered: false,
    runs: block.runs,
    pPrXml: `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`,
  })
  rebuild()
  dirty.value = true
}

function addLink(): void {
  const raw = window.prompt('链接地址（http:// 或 https:// 开头）', 'https://')
  if (!raw) return
  const href = raw.trim()
  if (!/^(https?:\/\/|mailto:)/i.test(href)) {
    ui.notify('error', '这个地址不能作为链接', '只支持 http / https / mailto。')
    return
  }
  exec('createLink', href)
  // createLink 生成的是普通 <a>，模型里还没有关系 id —— 立刻回读一遍补上
  const index = currentIndex()
  const block = blocks.value[index]
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-block="${index}"]`)
  if (block && el && (block.kind === 'p' || block.kind === 'list')) {
    block.runs = htmlToRuns(el)
    dirty.value = true
  }
}

function insertTable(): void {
  const index = currentIndex()
  const table: TableBlock = {
    kind: 'table',
    rows: [
      ['', '', ''],
      ['', '', ''],
    ],
    prXml: '',
    gridXml: '',
  }
  doc.value?.blocks.splice(index + 1, 0, table)
  rebuild()
  dirty.value = true
}

function addTableRow(index: number): void {
  const block = blocks.value[index]
  if (!block || block.kind !== 'table') return
  const width = block.rows[0]?.length ?? 1
  block.rows.push(new Array<string>(width).fill(''))
  rebuild()
  dirty.value = true
}

function removeTableRow(index: number): void {
  const block = blocks.value[index]
  if (!block || block.kind !== 'table') return
  if (block.rows.length <= 1) return
  block.rows.pop()
  rebuild()
  dirty.value = true
}

function insertParagraph(): void {
  const index = currentIndex()
  doc.value?.insertParagraphAfter(index)
  rebuild()
  dirty.value = true
  void focusBlock(index + 1, true)
}

function removeBlock(): void {
  const index = currentIndex()
  if (blocks.value.length <= 1) {
    ui.notify('info', '文档至少要留一段')
    return
  }
  doc.value?.removeBlock(index)
  rebuild()
  dirty.value = true
}

// ---------------------------------------------------------------- 保存

async function save(options: { force?: boolean } = {}): Promise<void> {
  const target = node.value
  if (!doc.value || !target || saving.value) return
  saving.value = true
  try {
    const bytes = doc.value.toBytes()
    const result = await api.saveFileContent(
      target.id,
      bytes,
      options.force ? undefined : baseUpdatedAt.value,
    )
    baseUpdatedAt.value = result.node.updatedAt
    dirty.value = false
    conflict.value = false
    ui.notify('success', '已保存', `${target.name} · ${formatBytes(result.node.size)}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      conflict.value = true
      return
    }
    ui.notify('error', '保存失败', err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function reload(): Promise<void> {
  conflict.value = false
  dirty.value = false
  await open()
}

// ---------------------------------------------------------------- 键盘

function onWindowKeydown(event: KeyboardEvent): void {
  if (windows.activeId !== props.win.id) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
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

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  windows.setCloseGuard(props.win.id, async () => {
    if (!dirty.value) return true
    return askConfirm(
      '关闭窗口？',
      `「${node.value?.name ?? '这个文档'}」有未保存的修改，关掉就没了。`,
      '放弃修改并关闭',
    )
  })
  void open()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  windows.setCloseGuard(props.win.id, null)
})
</script>

<template>
  <div class="de">
    <header class="de__bar">
      <Icon name="doc" :size="15" class="de__icon" />
      <span class="de__name" :title="node?.name">{{ node?.name ?? '文档' }}</span>
      <span v-if="dirty" class="wl-badge wl-badge--warning">未保存</span>

      <span class="de__spacer" />

      <template v-if="phase === 'ready'">
        <div class="de__group">
          <button class="de__fmt de__fmt--b" title="加粗（Ctrl+B）" @mousedown.prevent="exec('bold')">B</button>
          <button class="de__fmt de__fmt--i" title="斜体（Ctrl+I）" @mousedown.prevent="exec('italic')">I</button>
          <button class="de__fmt de__fmt--u" title="下划线（Ctrl+U）" @mousedown.prevent="exec('underline')">U</button>
          <button class="de__fmt de__fmt--s" title="删除线" @mousedown.prevent="exec('strikeThrough')">S</button>
        </div>

        <select
          class="wl-select de__level"
          title="段落样式"
          :value="currentLevel"
          @change="setLevel(Number(($event.target as HTMLSelectElement).value) as ParaLevel)"
        >
          <option :value="0">正文</option>
          <option :value="1">标题 1</option>
          <option :value="2">标题 2</option>
          <option :value="3">标题 3</option>
        </select>

        <button class="wl-icon-btn" title="项目符号" @mousedown.prevent="toggleList">
          <Icon name="list" :size="15" />
        </button>
        <button class="wl-icon-btn" title="插入链接" @mousedown.prevent="addLink">
          <Icon name="external" :size="15" />
        </button>
        <button class="wl-icon-btn" title="插入表格（3 列 × 2 行）" @mousedown.prevent="insertTable">
          <Icon name="layout" :size="15" />
        </button>
        <button class="wl-icon-btn" title="在下方插入一段" @mousedown.prevent="insertParagraph">
          <Icon name="plus" :size="15" />
        </button>
        <button class="wl-icon-btn" title="删除当前段" @mousedown.prevent="removeBlock">
          <Icon name="trash" :size="15" />
        </button>
        <span class="de__divider" />
        <button class="wl-btn" :class="dirty ? 'wl-btn--primary' : ''" :disabled="saving" @click="save()">
          <Icon name="check" :size="14" />
          <span>{{ saving ? '保存中…' : '保存' }}</span>
        </button>
      </template>
    </header>

    <div v-if="conflict" class="de__conflict">
      <Icon name="alert" :size="15" />
      <span class="de__conflictText">
        这个文档在你打开之后被改动过（可能是别人也编辑了它）。直接保存会覆盖掉对方的修改。
      </span>
      <button class="wl-btn" @click="reload">丢弃我的修改并重新加载</button>
      <button class="wl-btn wl-btn--danger" @click="save({ force: true })">仍用我的版本覆盖</button>
    </div>

    <div ref="rootEl" class="de__scroll">
      <div v-if="phase === 'loading'" class="wl-empty">
        <span class="wl-spinner" />
        <span>正在打开文档…</span>
      </div>

      <div v-else-if="phase === 'error'" class="wl-empty">
        <Icon name="alert" :size="30" />
        <span>{{ errorText }}</span>
      </div>

      <article v-else class="de__paper">
        <template v-for="(block, i) in blocks" :key="keys[i] ?? i">
          <!-- 只读块：图片 / 图表 / 复杂表格，原样保留 -->
          <div v-if="block.kind === 'raw'" class="de__raw" :data-block="i">
            <div class="de__rawHead">
              <Icon name="lock" :size="13" />
              <span>{{ block.note }}</span>
            </div>
            <p v-if="block.text" class="de__rawText">{{ block.text }}</p>
          </div>

          <!-- 表格 -->
          <div v-else-if="block.kind === 'table'" class="de__tableWrap" :data-block="i">
            <table class="de__table">
              <tbody>
                <tr v-for="(row, r) in block.rows" :key="r">
                  <td
                    v-for="(cell, c) in row"
                    :key="c"
                    contenteditable="true"
                    class="de__td"
                    @input="onCellInput(i, r, c, $event)"
                    @focus="focused = i"
                    v-html="cellHtml(cell)"
                  ></td>
                </tr>
              </tbody>
            </table>
            <div class="de__tableOps">
              <button class="wl-btn" @click="addTableRow(i)">加一行</button>
              <button class="wl-btn" :disabled="block.rows.length <= 1" @click="removeTableRow(i)">
                删末行
              </button>
            </div>
          </div>

          <!-- 段落 / 标题 / 列表项 -->
          <div v-else class="de__line" :class="`de__line--${block.kind === 'list' ? 'li' : `h${block.level}`}`">
            <span v-if="block.kind === 'list'" class="de__bullet">{{ block.ordered ? '1.' : '•' }}</span>
            <div
              class="de__text"
              :data-block="i"
              contenteditable="true"
              spellcheck="false"
              @input="onInput(i, $event)"
              @keydown="onKeydown(i, $event)"
              @paste="onPaste(i, $event)"
              @focus="focused = i"
              v-html="rendered[i]"
            ></div>
          </div>
        </template>

        <p class="de__hint">
          版面（页边距、页眉页脚、图片位置）由原文档保留，这里编辑的是内容。
        </p>
      </article>
    </div>

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
.de {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-0);
}

.de__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.de__icon {
  flex: none;
  color: var(--text-secondary);
}

.de__name {
  min-width: 0;
  max-width: 28%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.de__spacer {
  flex: 1;
}

.de__group {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.de__fmt {
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.de__fmt:hover {
  background: var(--hover);
}

.de__fmt--b {
  font-weight: 700;
}

.de__fmt--i {
  font-style: italic;
  font-family: Georgia, serif;
}

.de__fmt--u {
  text-decoration: underline;
}

.de__fmt--s {
  text-decoration: line-through;
}

.de__level {
  height: 26px;
  width: 88px;
  font-size: var(--fs-caption);
}

.de__divider {
  width: 1px;
  height: 16px;
  background: var(--line-hair);
}

.de__conflict {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  flex: none;
  padding: var(--space-2) var(--space-3);
  background: var(--warning-soft);
  font-size: var(--fs-caption);
  border-bottom: 1px solid var(--line-hair);
}

.de__conflictText {
  flex: 1;
  min-width: 240px;
  line-height: 1.5;
}

.de__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--space-4);
  display: flex;
  justify-content: center;
}

/* 一张"纸"的感觉来自宽度与留白，而不是伪造分页 */
.de__paper {
  width: min(760px, 100%);
  min-height: 100%;
  padding: var(--space-6);
  background: var(--surface-1);
  border: 1px solid var(--line-hair);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
}

.de__line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.de__bullet {
  flex: none;
  min-width: 16px;
  color: var(--text-secondary);
  line-height: 1.75;
  user-select: none;
}

.de__text {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  outline: none;
  line-height: 1.75;
  font-size: 14.5px;
  border-radius: 3px;
  white-space: pre-wrap;
  word-break: break-word;
}

.de__text:focus {
  background: var(--accent-soft);
}

.de__text a {
  color: var(--accent);
  text-decoration: underline;
}

/* 标题层级：只需让结构看得出来，具体字号由文档自己的样式决定 */
.de__line--h1 .de__text {
  font-size: 21px;
  font-weight: 700;
  line-height: 1.5;
}

.de__line--h2 .de__text {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.55;
}

.de__line--h3 .de__text {
  font-size: 16px;
  font-weight: 600;
}

.de__line--h4 .de__text,
.de__line--h5 .de__text,
.de__line--h6 .de__text {
  font-weight: 600;
}

.de__raw {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: var(--fs-caption);
}

.de__rawHead {
  display: flex;
  align-items: center;
  gap: 6px;
}

.de__rawText {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  white-space: pre-wrap;
  max-height: 80px;
  overflow: hidden;
}

.de__tableWrap {
  margin: var(--space-2) 0;
}

.de__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 14px;
}

.de__td {
  border: 1px solid var(--line-hair);
  padding: 5px 8px;
  vertical-align: top;
  outline: none;
  min-height: 24px;
  word-break: break-word;
}

.de__td:focus {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.de__tableOps {
  display: flex;
  gap: var(--space-2);
  margin-top: 4px;
}

.de__tableOps .wl-btn {
  height: 24px;
  font-size: var(--fs-caption);
}

.de__hint {
  margin: var(--space-5) 0 0;
  padding-top: var(--space-3);
  border-top: 1px dashed var(--line-hair);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}
</style>
