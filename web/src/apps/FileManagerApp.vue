<!--
  文件管理器。

  这是第一里程碑的核心应用（"桌面外壳 + 文件上传下载 + 工具集"）。
  实现：目录浏览、网格/列表两种视图、拖拽上传、分片上传与断点续传、
  秒传提示、新建文件夹、重命名、删除、移动、下载、预览、右键菜单、
  共享/个人空间切换。

  两个来自评审结论的实现决定：
  1. 上传进度要区分"秒传命中"和"真实传输" —— 前者是瞬间完成，如果 UI 照常
     显示进度条会让人以为出了问题，所以明确提示"内容已存在，已秒传"。
  2. 删除是软删除且目录递归，删别人上传的文件要拦在前面（后端也会拦），
     UI 层根据 ownerId 提前禁用按钮比让用户点了收到 403 更友好。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import {
  api,
  ApiError,
  fileKind,
  formatBytes,
  formatTime,
  uploadFile,
  type FileEntry,
  type UploadProgress,
} from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi, type ContextMenuItem } from '@/stores/ui'
import { useWindows, type WindowInstance } from '@/stores/windows'
import { playSystem } from '@/lib/sfx'

const props = defineProps<{ win: WindowInstance }>()
const auth = useAuth()
const ui = useUi()
const windows = useWindows()

// ---------------------------------------------------------------- 状态

const space = ref<'shared' | 'private'>('shared')
const parentId = ref<string | null>(null)
const breadcrumb = ref<Array<{ id: string; name: string }>>([])
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const error = ref('')
const view = ref<'grid' | 'list'>('grid')
const filter = ref('')
const selected = ref<Set<string>>(new Set())
/** 最近一次点选的条目，Shift 连选的锚点（和 Windows 资源管理器一致）。 */
const lastClickedId = ref<string | null>(null)

/** 列表视图的排序。网格视图固定"文件夹在前 + 名称升序"，不参与这里。 */
type SortKey = 'name' | 'size' | 'owner' | 'time'
const sortKey = ref<SortKey>('name')
const sortDir = ref<'asc' | 'desc'>('asc')

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'name' ? 'asc' : 'desc'
  }
}

function sortMark(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ↑' : ' ↓'
}

interface UploadTask {
  id: string
  name: string
  size: number
  progress: UploadProgress | null
  state: 'uploading' | 'done' | 'failed'
  error?: string
}

const uploads = ref<UploadTask[]>([])
const dragActive = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const showNewFolder = ref(false)
const newFolderName = ref('')
const renaming = ref<{ id: string; name: string } | null>(null)

// ---------------------------------------------------------------- 数据加载

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const list = q
    ? entries.value.filter((e) => e.name.toLowerCase().includes(q))
    : entries.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  const byName = (a: FileEntry, b: FileEntry): number => a.name.localeCompare(b.name, 'zh-CN')
  const compare = (a: FileEntry, b: FileEntry): number => {
    switch (sortKey.value) {
      case 'size':
        return (a.size - b.size) * dir || byName(a, b)
      case 'owner':
        return a.ownerName.localeCompare(b.ownerName, 'zh-CN') * dir || byName(a, b)
      case 'time':
        return (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * dir || byName(a, b)
      default:
        return byName(a, b) * dir
    }
  }
  // 文件夹永远排在文件前面 —— 这是所有文件管理器的共同约定
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return compare(a, b)
  })
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await api.listFiles(parentId.value, space.value)
    entries.value = result.entries
    breadcrumb.value = result.breadcrumb
    selected.value = new Set()
    updateWindowTitle()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      auth.handleUnauthorized()
      return
    }
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function updateWindowTitle(): void {
  const current = breadcrumb.value[breadcrumb.value.length - 1]
  const label = current ? current.name : space.value === 'shared' ? '共享空间' : '个人空间'
  const app = '文件'
  if (props.win.title !== `${app} · ${label}`) {
    // 直接改 store 里的标题，让任务栏也跟着更新
    props.win.title = `${app} · ${label}`
  }
}

function enter(entry: FileEntry): void {
  if (entry.kind !== 'folder') return
  parentId.value = entry.id
  filter.value = ''
  void load()
}

function goToRoot(): void {
  parentId.value = null
  filter.value = ''
  void load()
}

function goToCrumb(index: number): void {
  const target = breadcrumb.value[index]
  parentId.value = target ? target.id : null
  filter.value = ''
  void load()
}

function goUp(): void {
  const parent = breadcrumb.value[breadcrumb.value.length - 2]
  parentId.value = parent ? parent.id : null
  filter.value = ''
  void load()
}

function switchSpace(next: 'shared' | 'private'): void {
  if (space.value === next) return
  space.value = next
  parentId.value = null
  filter.value = ''
  void load()
}

// ---------------------------------------------------------------- 选择

function toggleSelect(entry: FileEntry, event?: MouseEvent): void {
  // Shift 连选：以最近一次点选为锚点，选中两者之间的所有条目（含文件夹）
  if (event?.shiftKey && lastClickedId.value) {
    const ids = filtered.value.map((e) => e.id)
    const from = ids.indexOf(lastClickedId.value)
    const to = ids.indexOf(entry.id)
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      selected.value = new Set(ids.slice(lo, hi + 1))
      return
    }
  }
  lastClickedId.value = entry.id
  if (event?.ctrlKey || event?.metaKey) {
    const next = new Set(selected.value)
    if (next.has(entry.id)) next.delete(entry.id)
    else next.add(entry.id)
    selected.value = next
    return
  }
  selected.value = new Set([entry.id])
}

function selectAll(): void {
  selected.value = new Set(filtered.value.map((e) => e.id))
}

const selectedEntries = computed(() => entries.value.filter((e) => selected.value.has(e.id)))

/** 未选中任何文件时，默认操作作用于当前光标下的那一个。 */
function primaryTarget(): FileEntry | null {
  return selectedEntries.value[0] ?? null
}

function canModify(entry: FileEntry): boolean {
  return auth.isAdmin || entry.ownerId === auth.user?.id
}

// ---------------------------------------------------------------- 上传

/**
 * 上传一批文件。
 *
 * 串行而不是并行：NAS 的磁盘 IO 与内存都紧张，并行上传多个大文件会把
 * 存储服务拖慢；串行上传的总体完成时间反而更短，进度也更好呈现。
 *
 * targetFolder 用于"把文件拖到某个文件夹图块上"——直接传到那个目录里，
 * 而不是当前目录。不传就往当前目录传。
 */
async function uploadFiles(files: FileList | File[], targetFolder?: FileEntry): Promise<void> {
  const list = [...files]
  if (list.length === 0) return
  const destId = targetFolder?.id ?? parentId.value

  const tasks: UploadTask[] = list.map((file, index) => ({
    id: `${Date.now()}-${index}`,
    name: file.name,
    size: file.size,
    progress: null,
    state: 'uploading',
  }))
  uploads.value.push(...tasks)

  let succeeded = 0
  let instantCount = 0

  for (let i = 0; i < list.length; i++) {
    const file = list[i]!
    const task = tasks[i]!
    try {
      const result = await uploadFile(file, destId, space.value, (progress) => {
        task.progress = progress
        if (progress.instant) instantCount += 1
      })
      task.state = 'done'
      succeeded++
      void result
    } catch (err) {
      task.state = 'failed'
      task.error = err instanceof ApiError ? err.message : '上传失败'
    }
  }

  if (succeeded > 0) {
    const instantNote = instantCount > 0 ? `，其中 ${instantCount} 个命中秒传` : ''
    const where = targetFolder ? `到「${targetFolder.name}」` : ''
    ui.notify('success', `已上传 ${succeeded} 个文件${where}${instantNote}`)
    // 只有传到当前目录才需要刷新列表；传到别的文件夹里，当前列表没变化
    if (!targetFolder) await load()
  }
  const failedTasks = tasks.filter((t) => t.state === 'failed')
  if (failedTasks.length > 0) {
    ui.notify('error', `${failedTasks.length} 个文件上传失败`, failedTasks[0]?.error)
  }

  // 全部结束后清掉任务条（成功的立刻消失，失败的留 6 秒让人看到原因）
  window.setTimeout(() => {
    uploads.value = uploads.value.filter((t) => t.state === 'failed')
  }, 3000)
}

function onFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files) void uploadFiles(input.files)
  input.value = ''
}

/**
 * 拖放只在这一个应用窗口内生效。
 *
 * ⚠️ 这里曾经把 dragenter/drop 挂在 window 上，而内容区又有一个自己的
 * @drop —— 一次拖入会**同时触发两处**，同一个文件被上传两次（用户报的 bug）。
 * 而且 window 级监听器是全局的：开着两个文件管理器窗口时，往任何一个里拖
 * 都会在两个窗口各传一份。
 *
 * 现在的规则：监听器只挂在本应用的根元素上，且**只有一处**处理外部文件的
 * drop（屏幕根处的 onRootDrop）。拖到文件夹图块上时由该图块的处理器接管
 * （stopPropagation 拦住冒泡，不会重复）。内部条目互拖也不会弹"上传"遮罩。
 */
const rootEl = ref<HTMLElement | null>(null)
const dragging = ref(0)
/** 正在被拖动的（内部）条目 id。非空表示这是一次"移动"拖拽，不是外部文件。 */
const dragIds = ref<string[]>([])
/** 光标悬停其上的文件夹 id，用于高亮"松手就放进这里"。 */
const dragOverFolder = ref<string | null>(null)

function onRootDragEnter(event: DragEvent): void {
  if (dragIds.value.length > 0) return
  dragging.value++
  dragActive.value = true
  event.preventDefault()
}

function onRootDragOver(event: DragEvent): void {
  // 不 preventDefault 的话浏览器根本不会派发 drop
  event.preventDefault()
}

function onRootDragLeave(): void {
  dragging.value = Math.max(0, dragging.value - 1)
  if (dragging.value === 0) dragActive.value = false
}

function onRootDrop(event: DragEvent): void {
  event.preventDefault()
  dragging.value = 0
  dragActive.value = false
  // 内部拖拽没有 files，落到空白处就是取消，什么也不做
  if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
    void uploadFiles(event.dataTransfer.files)
  }
}

// ---------------------------------------------------------------- 内部拖拽（移动到文件夹）

function onEntryDragStart(event: DragEvent, entry: FileEntry): void {
  if (renaming.value?.id === entry.id) {
    event.preventDefault()
    return
  }
  // 拖一个没被选中的条目时，先把它选中 —— 和资源管理器一致
  if (!selected.value.has(entry.id)) {
    selected.value = new Set([entry.id])
    lastClickedId.value = entry.id
  }
  dragIds.value = selectedEntries.value.map((e) => e.id)
  event.dataTransfer?.setData('application/x-wl-nodes', '1')
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onEntryDragEnd(): void {
  dragIds.value = []
  dragOverFolder.value = null
}

function onFolderDragOver(entry: FileEntry): void {
  if (entry.kind === 'folder') dragOverFolder.value = entry.id
}

function onFolderDragLeave(entry: FileEntry): void {
  if (dragOverFolder.value === entry.id) dragOverFolder.value = null
}

/**
 * 条目上的 drop：
 * - 落在**文件夹**上 → 内部拖拽就移动进去；外部文件就上传进这个文件夹
 * - 落在文件或空白上 → 不拦截，冒泡给根处理器（上传到当前目录）
 */
function onEntryDrop(event: DragEvent, entry: FileEntry): void {
  if (entry.kind !== 'folder') return
  event.preventDefault()
  event.stopPropagation()
  dragOverFolder.value = null

  if (dragIds.value.length > 0) {
    const targets = entries.value.filter((e) => dragIds.value.includes(e.id))
    void moveEntries(targets, entry)
  } else if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
    void uploadFiles(event.dataTransfer.files, entry)
  }
}

// ---------------------------------------------------------------- 操作

async function createFolder(): Promise<void> {
  const name = newFolderName.value.trim()
  if (!name) return
  try {
    await api.createFolder({ parentId: parentId.value, name, space: space.value })
    showNewFolder.value = false
    newFolderName.value = ''
    ui.notify('success', `已创建「${name}」`)
    await load()
  } catch (err) {
    ui.notify('error', '创建失败', err instanceof ApiError ? err.message : String(err))
  }
}

async function commitRename(): Promise<void> {
  const target = renaming.value
  if (!target) return
  const name = target.name.trim()
  const entry = entries.value.find((e) => e.id === target.id)
  renaming.value = null
  if (!name || !entry || name === entry.name) return
  try {
    await api.renameNode(target.id, name)
    ui.notify('success', '已重命名')
    await load()
  } catch (err) {
    ui.notify('error', '重命名失败', err instanceof ApiError ? err.message : String(err))
  }
}

async function removeEntries(list: FileEntry[]): Promise<void> {
  if (list.length === 0) return
  const names = list.map((e) => e.name)
  const summary =
    list.length === 1 ? `「${names[0]}」` : `${list.length} 个项目`
  const hasFolder = list.some((e) => e.kind === 'folder')
  const confirmed = window.confirm(
    `确定删除 ${summary}？${hasFolder ? '\n\n文件夹会连同里面的内容一起删除。' : ''}\n\n删除后文件内容会被移出存储空间。`,
  )
  if (!confirmed) return

  let done = 0
  for (const entry of list) {
    try {
      await api.deleteNode(entry.id)
      done++
    } catch (err) {
      ui.notify('error', `删除「${entry.name}」失败`, err instanceof ApiError ? err.message : String(err))
    }
  }
  if (done > 0) {
    // 删除用"回收站"那一声，而不是通用的"完成"：这个动作有分量，值得区分
    playSystem('trash')
    ui.notify('success', `已删除 ${done} 个项目`, undefined, 4000, { sound: 'none' })
    await load()
  }
}

/**
 * 把一批条目移动进某个文件夹（内部拖拽的一个落点）。
 *
 * 已在目标目录里的条目直接跳过 —— 那是个空操作，调接口只会白拿一个 409
 * （"目标目录下已有同名项"，因为它自己就在那儿）。
 */
async function moveEntries(list: FileEntry[], folder: FileEntry): Promise<void> {
  const movable = list.filter((e) => e.id !== folder.id && e.parentId !== folder.id)
  if (movable.length === 0) return
  const failures: string[] = []
  let done = 0
  for (const entry of movable) {
    try {
      await api.moveNode(entry.id, folder.id)
      done++
    } catch (err) {
      failures.push(`${entry.name}：${err instanceof ApiError ? err.message : '移动失败'}`)
    }
  }
  if (done > 0) {
    ui.notify('success', `已移动 ${done} 个项目到「${folder.name}」`)
    selected.value = new Set()
    await load()
  }
  if (failures.length > 0) {
    ui.notify('error', `${failures.length} 个项目移动失败`, failures[0])
  }
}

// ---------------------------------------------------------------- 移动到…（对话框选目录）

/**
 * 「移动到…」对话框。
 *
 * 为什么要做它：拖拽只解决"拖到看得见的文件夹"，而"移到三层以外的目录"
 * 之前根本没有任何入口（用户报的功能缺失）。这里给一棵可展开的目录树，
 * 支持多选一起移、能移到根目录。
 *
 * 目录树是**懒加载**的：点开一个才拉它的子目录，避免为了一棵可能没人展开的
 * 树把整站目录结构全读一遍。做不了的事在树里直接禁用（灰掉），
 * 不让用户点了才吃一个错误：不能移进自己、不能移进正在移动的文件夹内部、
 * 不能选当前所在的目录（本来就是它）。
 */
const moving = ref<FileEntry[] | null>(null)
const moveChosen = ref(false)
const moveTarget = ref<string | null>(null)
const moveTargetName = ref('')
const moveBusy = ref(false)
const moveExpanded = ref<Set<string>>(new Set())
/** parentId（'' 表示根）→ 该目录下的条目。懒加载后缓存。 */
const moveChildren = ref<Map<string, FileEntry[]>>(new Map())
const moveLoadingIds = ref<Set<string>>(new Set())

interface MoveRow {
  id: string
  name: string
  depth: number
  expanded: boolean
  loading: boolean
  /** 不能作为移动目标（自己 / 自己的子孙 / 当前目录） */
  disabled: boolean
  /** 可以展开看子目录（注意：disabled 的"当前目录"仍然可以展开） */
  canExpand: boolean
}

const moveRows = computed<MoveRow[]>(() => {
  const movingIds = new Set((moving.value ?? []).map((e) => e.id))
  const rows: MoveRow[] = []
  const walk = (dirId: string, depth: number, blocked: boolean): void => {
    const children = (moveChildren.value.get(dirId) ?? []).filter((e) => e.kind === 'folder')
    for (const entry of children) {
      const isMoving = movingIds.has(entry.id)
      const expanded = moveExpanded.value.has(entry.id)
      const canExpand = !isMoving && !blocked
      rows.push({
        id: entry.id,
        name: entry.name,
        depth,
        expanded,
        loading: moveLoadingIds.value.has(entry.id),
        // 正在被移动的文件夹自己、它的子孙（blocked）、以及当前目录都不能当目标
        disabled: blocked || isMoving || entry.id === parentId.value,
        canExpand,
      })
      // 正在被移动的文件夹不展开 —— 它里面的目录全是非法目标，展开只会让人点错
      if (expanded && canExpand) walk(entry.id, depth + 1, false)
    }
  }
  walk('', 0, false)
  return rows
})

function openMoveDialog(list: FileEntry[]): void {
  if (list.length === 0) return
  moving.value = [...list]
  moveChosen.value = false
  moveTarget.value = null
  moveTargetName.value = ''
  moveExpanded.value = new Set()
  moveChildren.value = new Map()
  moveLoadingIds.value = new Set()
  void loadMoveChildren('')
}

async function loadMoveChildren(parentId: string): Promise<void> {
  if (parentId) {
    const next = new Set(moveLoadingIds.value)
    next.add(parentId)
    moveLoadingIds.value = next
  }
  try {
    const result = await api.listFiles(parentId === '' ? null : parentId, space.value)
    const next = new Map(moveChildren.value)
    next.set(parentId, result.entries)
    moveChildren.value = next
  } catch (err) {
    ui.notify('error', '读取目录失败', err instanceof ApiError ? err.message : String(err))
  } finally {
    const next = new Set(moveLoadingIds.value)
    next.delete(parentId)
    moveLoadingIds.value = next
  }
}

function toggleMoveExpand(row: MoveRow): void {
  const next = new Set(moveExpanded.value)
  if (next.has(row.id)) {
    next.delete(row.id)
  } else {
    next.add(row.id)
    if (!moveChildren.value.has(row.id)) void loadMoveChildren(row.id)
  }
  moveExpanded.value = next
}

function chooseMoveTarget(id: string | null, name: string, disabled: boolean): void {
  if (disabled) return
  moveChosen.value = true
  moveTarget.value = id
  moveTargetName.value = name
}

async function confirmMove(): Promise<void> {
  const list = moving.value
  if (!list || !moveChosen.value || moveBusy.value) return
  const target = moveTarget.value
  const targets = list.filter((e) => e.id !== target && e.parentId !== target)
  if (targets.length === 0) {
    ui.notify('info', '这些项目已经在目标目录里了')
    moving.value = null
    return
  }
  moveBusy.value = true
  const failures: string[] = []
  let done = 0
  for (const entry of targets) {
    try {
      await api.moveNode(entry.id, target)
      done++
    } catch (err) {
      failures.push(`${entry.name}：${err instanceof ApiError ? err.message : '移动失败'}`)
    }
  }
  moveBusy.value = false
  if (done > 0) {
    ui.notify('success', `已移动 ${done} 个项目到「${moveTargetName.value}」`)
    selected.value = new Set()
    moving.value = null
    await load()
  }
  if (failures.length > 0) {
    ui.notify('error', `${failures.length} 个项目移动失败`, failures[0])
  }
}

function download(entry: FileEntry): void {
  if (entry.kind !== 'file') return
  const link = document.createElement('a')
  link.href = api.downloadUrl(entry.id)
  link.download = entry.name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function downloadSelected(): void {
  for (const entry of selectedEntries.value) {
    if (entry.kind === 'file') download(entry)
  }
}

function canPreview(entry: FileEntry): boolean {
  const mime = entry.mime ?? ''
  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/')
  )
}

function openEntry(entry: FileEntry): void {
  if (entry.kind === 'folder') {
    enter(entry)
  } else if (canPreview(entry)) {
    openPreview(entry)
  } else {
    download(entry)
  }
}

/**
 * 预览 = 打开一个独立的预览窗口。
 *
 * 和其他窗口同一套框架（拖拽 / 缩放 / 最大化 / 贴边 / 任务栏），
 * 不再是从前那个钉在文件管理器里的浮层；每个文件开独立一个窗口，
 * 方便两张图并排比较。
 */
function openPreview(entry: FileEntry): void {
  windows.open({
    appId: 'preview',
    title: entry.name,
    args: { node: entry },
    w: 940,
    h: 660,
    minW: 420,
    minH: 320,
  })
}

// ---------------------------------------------------------------- 右键菜单

function entryContextMenu(event: MouseEvent, entry: FileEntry): void {
  event.preventDefault()
  if (!selected.value.has(entry.id)) selected.value = new Set([entry.id])

  const multi = selected.value.size > 1
  const targets = multi ? selectedEntries.value : [entry]
  const editable = targets.every(canModify)

  const items: ContextMenuItem[] = []
  if (!multi) {
    if (entry.kind === 'folder') {
      items.push({ label: '打开', icon: 'folder-open', action: () => enter(entry) })
    } else {
      if (canPreview(entry)) {
        items.push({ label: '预览', icon: 'eye', action: () => openPreview(entry) })
      }
      items.push({ label: '下载', icon: 'download', action: () => download(entry) })
      items.push({
        label: '用工具处理',
        icon: 'tools',
        // 把选中的这个文件作为工具输入带过去（工具集会自己挑一个接受它的工具）
        action: () => windows.open({ appId: 'tools', title: '工具集', args: { node: entry } }),
      })
    }
    items.push({ separator: true, label: '' })
  }

  items.push({
    label: multi ? `下载 ${targets.length} 个文件` : '下载',
    icon: 'download',
    disabled: multi && targets.every((t) => t.kind === 'folder'),
    action: () => downloadSelected(),
  })

  items.push({
    label: multi ? `移动 ${targets.length} 个项目…` : '移动到…',
    icon: 'move',
    disabled: !editable,
    action: () => openMoveDialog(targets),
  })

  if (!multi) {
    items.push({
      label: '重命名',
      icon: 'rename',
      disabled: !editable,
      action: () => (renaming.value = { id: entry.id, name: entry.name }),
    })
  }

  items.push({
    label: multi ? `删除 ${targets.length} 个项目` : '删除',
    icon: 'trash',
    danger: true,
    disabled: !editable,
    action: () => void removeEntries(targets),
  })

  items.push({ separator: true, label: '' })
  items.push({
    label: `上传者：${entry.ownerName}`,
    disabled: true,
  })
  items.push({ label: `修改时间：${formatTime(entry.updatedAt)}`, disabled: true })

  ui.openContextMenu(event.clientX, event.clientY, items)
}

function blankContextMenu(event: MouseEvent): void {
  event.preventDefault()
  ui.openContextMenu(event.clientX, event.clientY, [
    { label: '新建文件夹', icon: 'plus', action: () => (showNewFolder.value = true) },
    { label: '上传文件', icon: 'upload', action: () => fileInput.value?.click() },
    { separator: true, label: '' },
    { label: '全选', icon: 'list', disabled: filtered.value.length === 0, action: selectAll },
    { label: '刷新', icon: 'refresh', action: () => void load() },
    { separator: true, label: '' },
    {
      label: view.value === 'grid' ? '切换到列表视图' : '切换到网格视图',
      icon: view.value === 'grid' ? 'list' : 'grid',
      action: () => (view.value = view.value === 'grid' ? 'list' : 'grid'),
    },
  ])
}

// ---------------------------------------------------------------- 生命周期

onMounted(() => {
  // 支持 win.args.parentId 直接打开某个目录（工具集里选文件会用到）
  const initialParent = props.win.args.parentId
  if (typeof initialParent === 'string') parentId.value = initialParent
  const initialSpace = props.win.args.space
  if (initialSpace === 'private' || initialSpace === 'shared') space.value = initialSpace

  void load()

  // 拖放监听只挂在本应用根元素上（不是 window），且只有一处处理 drop。
  // 详见上面 onRootDragEnter 上方的注释 —— 挂在 window 上会导致
  // "拖一次上传两份"的老 bug。
  const el = rootEl.value
  el?.addEventListener('dragenter', onRootDragEnter)
  el?.addEventListener('dragover', onRootDragOver)
  el?.addEventListener('dragleave', onRootDragLeave)
  el?.addEventListener('drop', onRootDrop)
})

onBeforeUnmount(() => {
  const el = rootEl.value
  el?.removeEventListener('dragenter', onRootDragEnter)
  el?.removeEventListener('dragover', onRootDragOver)
  el?.removeEventListener('dragleave', onRootDragLeave)
  el?.removeEventListener('drop', onRootDrop)
})

watch(
  () => props.win.args,
  (args) => {
    if (typeof args.parentId === 'string' && args.parentId !== parentId.value) {
      parentId.value = args.parentId
      void load()
    }
  },
)
</script>

<template>
  <div ref="rootEl" class="fm" @contextmenu.self="blankContextMenu">
    <!-- 工具栏 -->
    <div class="fm__toolbar">
      <div class="fm__nav">
        <button class="wl-icon-btn" title="返回上级" :disabled="parentId === null" @click="goUp">
          <Icon name="arrow-left" :size="16" />
        </button>
        <button class="wl-icon-btn" title="回到根目录" :disabled="parentId === null" @click="goToRoot">
          <Icon name="home" :size="16" />
        </button>
        <button class="wl-icon-btn" title="刷新" :disabled="loading" @click="load">
          <Icon name="refresh" :size="16" />
        </button>
      </div>

      <!-- 空间切换 -->
      <div class="fm__spaces">
        <button
          class="fm__space"
          :class="{ 'fm__space--on': space === 'shared' }"
          @click="switchSpace('shared')"
        >
          <Icon name="users" :size="14" />
          共享空间
        </button>
        <button
          class="fm__space"
          :class="{ 'fm__space--on': space === 'private' }"
          @click="switchSpace('private')"
        >
          <Icon name="lock" :size="14" />
          个人空间
        </button>
      </div>

      <div class="fm__spacer" />

      <div class="fm__search">
        <Icon name="search" :size="14" />
        <input v-model="filter" class="fm__search-input" type="text" placeholder="筛选当前目录" />
      </div>

      <button class="wl-icon-btn" :title="view === 'grid' ? '切换列表视图' : '切换网格视图'" @click="view = view === 'grid' ? 'list' : 'grid'">
        <Icon :name="view === 'grid' ? 'list' : 'grid'" :size="16" />
      </button>
      <button class="wl-btn" @click="showNewFolder = true">
        <Icon name="plus" :size="15" />
        新建文件夹
      </button>
      <button class="wl-btn wl-btn--primary" @click="fileInput?.click()">
        <Icon name="upload" :size="15" />
        上传
      </button>
      <input ref="fileInput" type="file" multiple hidden @change="onFileInputChange" />
    </div>

    <!-- 面包屑 -->
    <div class="fm__crumbs">
      <button class="fm__crumb" @click="goToRoot">
        {{ space === 'shared' ? '共享空间' : '个人空间' }}
      </button>
      <template v-for="(crumb, index) in breadcrumb" :key="crumb.id">
        <Icon name="chevron-right" :size="12" class="fm__crumb-sep" />
        <button
          class="fm__crumb"
          :class="{ 'fm__crumb--current': index === breadcrumb.length - 1 }"
          @click="goToCrumb(index)"
        >
          {{ crumb.name }}
        </button>
      </template>
      <span class="fm__count">
        {{ filtered.length }} 个项目
        <template v-if="selected.size > 0"> · 已选 {{ selected.size }}</template>
      </span>
    </div>

    <!-- 上传进度 -->
    <div v-if="uploads.length > 0" class="fm__uploads">
      <div v-for="task in uploads" :key="task.id" class="upload" :class="`upload--${task.state}`">
        <Icon
          :name="task.state === 'done' ? 'check' : task.state === 'failed' ? 'alert' : 'upload'"
          :size="14"
        />
        <span class="upload__name">{{ task.name }}</span>
        <span class="upload__meta">
          <template v-if="task.state === 'failed'">{{ task.error }}</template>
          <template v-else-if="task.progress?.instant">内容已存在，已秒传</template>
          <template v-else-if="task.progress?.phase === 'finalizing'">正在校验…</template>
          <template v-else-if="task.progress?.phase === 'hashing'">正在计算校验和…</template>
          <template v-else-if="task.progress">
            {{ formatBytes(task.progress.uploaded) }} / {{ formatBytes(task.progress.total) }}
            （{{ task.progress.percent }}%）
          </template>
          <template v-else>准备中…</template>
        </span>
        <div v-if="task.state === 'uploading'" class="upload__bar">
          <div
            class="upload__fill"
            :style="{ width: `${task.progress?.phase === 'hashing' ? 3 : (task.progress?.percent ?? 0)}%` }"
          />
        </div>
      </div>
    </div>

    <!-- 内容 -->
    <!-- 注意：这里刻意没有任何 drag/drop 处理 —— 外部文件的落点由根元素的
         onRootDrop 统一接管（曾经这里也挂了一份，导致拖一次上传两份）。 -->
    <div
      class="fm__body wl-scroll"
      :class="{ 'fm__body--drop': dragActive }"
      @contextmenu.self="blankContextMenu"
      @click.self="selected = new Set()"
    >
      <div v-if="dragActive" class="fm__dropzone">
        <Icon name="upload" :size="40" />
        <p>松开即上传到「{{ breadcrumb[breadcrumb.length - 1]?.name ?? (space === 'shared' ? '共享空间' : '个人空间') }}」</p>
      </div>

      <div v-else-if="loading && entries.length === 0" class="wl-empty">
        <span class="wl-spinner" />
        <span>正在加载…</span>
      </div>

      <div v-else-if="error" class="wl-empty">
        <Icon name="alert" :size="32" />
        <span>{{ error }}</span>
        <button class="wl-btn" @click="load">重试</button>
      </div>

      <div v-else-if="filtered.length === 0" class="wl-empty">
        <Icon :name="filter ? 'search' : 'folder-open'" :size="42" />
        <span v-if="filter">没有匹配「{{ filter }}」的项目</span>
        <span v-else>这里还是空的</span>
        <span v-if="!filter" class="fm__empty-hint">把文件拖进来，或点右上角的「上传」</span>
      </div>

      <!-- 网格视图 -->
      <div v-else-if="view === 'grid'" class="fm__grid">
        <button
          v-for="entry in filtered"
          :key="entry.id"
          class="tile"
          :class="{
            'tile--selected': selected.has(entry.id),
            'tile--dropinto': dragOverFolder === entry.id,
          }"
          :title="`${entry.name}\n${entry.kind === 'file' ? formatBytes(entry.size) + ' · ' : ''}${entry.ownerName} · ${formatTime(entry.updatedAt)}`"
          draggable="true"
          @click="toggleSelect(entry, $event)"
          @dblclick="openEntry(entry)"
          @contextmenu="entryContextMenu($event, entry)"
          @dragstart="onEntryDragStart($event, entry)"
          @dragend="onEntryDragEnd"
          @dragover.prevent="onFolderDragOver(entry)"
          @dragleave="onFolderDragLeave(entry)"
          @drop="onEntryDrop($event, entry)"
        >
          <span class="tile__glyph" :class="`tile__glyph--${fileKind(entry).icon}`">
            <Icon :name="fileKind(entry).icon" :size="28" :stroke="1.4" />
          </span>
          <span v-if="renaming?.id === entry.id" class="tile__rename" @click.stop>
            <input
              v-model="renaming.name"
              class="wl-input tile__rename-input"
              autofocus
              @keydown.enter="commitRename"
              @keydown.esc="renaming = null"
              @blur="commitRename"
            />
          </span>
          <span v-else class="tile__name">{{ entry.name }}</span>
          <span class="tile__meta">
            {{ entry.kind === 'file' ? formatBytes(entry.size) : '文件夹' }}
          </span>
        </button>
      </div>

      <!-- 列表视图 -->
      <table v-else class="fm__table selectable">
        <thead>
          <tr>
            <th class="fm__col-name fm__col-sort" title="按名称排序" @click="setSort('name')">
              名称<span class="fm__sort">{{ sortMark('name') }}</span>
            </th>
            <th class="fm__col-size fm__col-sort" title="按大小排序" @click="setSort('size')">
              大小<span class="fm__sort">{{ sortMark('size') }}</span>
            </th>
            <th class="fm__col-owner fm__col-sort" title="按上传者排序" @click="setSort('owner')">
              上传者<span class="fm__sort">{{ sortMark('owner') }}</span>
            </th>
            <th class="fm__col-time fm__col-sort" title="按修改时间排序" @click="setSort('time')">
              修改时间<span class="fm__sort">{{ sortMark('time') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in filtered"
            :key="entry.id"
            class="row"
            :class="{
              'row--selected': selected.has(entry.id),
              'row--dropinto': dragOverFolder === entry.id,
            }"
            draggable="true"
            @click="toggleSelect(entry, $event)"
            @dblclick="openEntry(entry)"
            @contextmenu="entryContextMenu($event, entry)"
            @dragstart="onEntryDragStart($event, entry)"
            @dragend="onEntryDragEnd"
            @dragover.prevent="onFolderDragOver(entry)"
            @dragleave="onFolderDragLeave(entry)"
            @drop="onEntryDrop($event, entry)"
          >
            <td class="fm__col-name">
              <span class="row__icon" :class="`row__icon--${fileKind(entry).icon}`">
                <Icon :name="fileKind(entry).icon" :size="16" />
              </span>
              <input
                v-if="renaming?.id === entry.id"
                v-model="renaming.name"
                class="wl-input row__rename"
                autofocus
                @click.stop
                @keydown.enter="commitRename"
                @keydown.esc="renaming = null"
                @blur="commitRename"
              />
              <span v-else class="row__name">{{ entry.name }}</span>
            </td>
            <td class="fm__col-size">{{ entry.kind === 'file' ? formatBytes(entry.size) : '—' }}</td>
            <td class="fm__col-owner">{{ entry.ownerName }}</td>
            <td class="fm__col-time">{{ formatTime(entry.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 底部状态栏 -->
    <div v-if="selected.size > 0" class="fm__statusbar">
      <span>已选 {{ selected.size }} 项</span>
      <div class="fm__spacer" />
      <button class="wl-btn wl-btn--ghost" @click="downloadSelected()">
        <Icon name="download" :size="14" />
        下载
      </button>
      <button
        class="wl-btn wl-btn--ghost"
        :disabled="!selectedEntries.every(canModify)"
        :title="selectedEntries.every(canModify) ? '移动到其他文件夹' : '只能移动自己上传的内容'"
        @click="openMoveDialog(selectedEntries)"
      >
        <Icon name="move" :size="14" />
        移动
      </button>
      <button
        class="wl-btn wl-btn--danger"
        :disabled="!selectedEntries.every(canModify)"
        :title="selectedEntries.every(canModify) ? '' : '只能删除自己上传的内容'"
        @click="removeEntries(selectedEntries)"
      >
        <Icon name="trash" :size="14" />
        删除
      </button>
      <button class="wl-btn wl-btn--ghost" @click="selected = new Set()">取消选择</button>
    </div>

    <!-- 新建文件夹 -->
    <div v-if="showNewFolder" class="fm__overlay" @click.self="showNewFolder = false">
      <div class="fm__dialog">
        <h3 class="fm__dialog-title">新建文件夹</h3>
        <div class="wl-field">
          <label class="wl-label">文件夹名称</label>
          <input
            v-model="newFolderName"
            class="wl-input"
            autofocus
            placeholder="例如：会议纪要"
            @keydown.enter="createFolder"
            @keydown.esc="showNewFolder = false"
          />
          <p class="wl-hint">名称不能包含斜杠；同一目录下不能重名。</p>
        </div>
        <div class="fm__dialog-actions">
          <button class="wl-btn" @click="showNewFolder = false">取消</button>
          <button class="wl-btn wl-btn--primary" :disabled="!newFolderName.trim()" @click="createFolder">
            创建
          </button>
        </div>
      </div>
    </div>

    <!-- 移动到… -->
    <div v-if="moving" class="fm__overlay" @click.self="moving = null">
      <div class="fm__dialog fm__dialog--move">
        <h3 class="fm__dialog-title">移动 {{ moving.length }} 个项目</h3>
        <p class="wl-hint fm__move-hint">选择目标文件夹（灰色的是不能选的位置）：</p>

        <div class="fm__move-tree wl-scroll">
          <button
            class="move-row"
            :class="{ 'move-row--on': moveChosen && moveTarget === null }"
            @click="chooseMoveTarget(null, `${space === 'shared' ? '共享空间' : '个人空间'}根目录`, false)"
          >
            <span class="move-row__toggle-placeholder" />
            <span class="move-row__pick">
              <Icon name="home" :size="14" />
              <span class="move-row__name">{{ space === 'shared' ? '共享空间' : '个人空间' }}根目录</span>
            </span>
          </button>

          <div
            v-for="row in moveRows"
            :key="row.id"
            class="move-row"
            :class="{
              'move-row--on': moveChosen && moveTarget === row.id,
              'move-row--disabled': row.disabled,
            }"
            :style="{ paddingLeft: `${10 + row.depth * 18}px` }"
          >
            <button
              class="move-row__toggle"
              :disabled="!row.canExpand"
              :title="row.canExpand ? (row.expanded ? '收起' : '展开') : ''"
              @click.stop="toggleMoveExpand(row)"
            >
              <span v-if="row.loading" class="wl-spinner wl-spinner--xs" />
              <Icon v-else-if="row.canExpand" :name="row.expanded ? 'chevron-down' : 'chevron-right'" :size="12" />
            </button>
            <button class="move-row__pick" :disabled="row.disabled" @click="chooseMoveTarget(row.id, row.name, row.disabled)">
              <Icon name="folder" :size="14" />
              <span class="move-row__name">{{ row.name }}</span>
            </button>
          </div>

          <p v-if="moveRows.length === 0" class="fm__move-empty">这个空间下还没有任何文件夹</p>
        </div>

        <div class="fm__dialog-actions">
          <span class="fm__move-target">
            <template v-if="moveChosen">目标：{{ moveTargetName }}</template>
            <template v-else>还没选目标文件夹</template>
          </span>
          <button class="wl-btn" @click="moving = null">取消</button>
          <button class="wl-btn wl-btn--primary" :disabled="!moveChosen || moveBusy" @click="confirmMove">
            {{ moveBusy ? '移动中…' : '移动到此处' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fm {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ---------------------------------------------------------------- 工具栏 */

.fm__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.fm__nav {
  display: flex;
  gap: 2px;
}

.fm__spaces {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
}

.fm__space {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  transition: all var(--dur-fast) var(--ease-out);
}

.fm__space--on {
  background: var(--surface-solid);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.fm__spacer {
  flex: 1;
}

.fm__search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 180px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-solid);
  color: var(--text-tertiary);
}

.fm__search:focus-within {
  border-color: var(--accent);
}

.fm__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 面包屑 */

.fm__crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12.5px;
  overflow: hidden;
}

.fm__crumb {
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  white-space: nowrap;
}

.fm__crumb:hover {
  background: var(--hover);
  color: var(--text);
}

.fm__crumb--current {
  color: var(--text);
  font-weight: 600;
}

.fm__crumb-sep {
  color: var(--text-tertiary);
  flex: none;
}

.fm__count {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

/* ---------------------------------------------------------------- 上传进度 */

.fm__uploads {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 140px;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-2);
}

.upload {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  color: var(--text-secondary);
}

.upload--done {
  color: var(--success);
}

.upload--failed {
  color: var(--danger);
}

.upload__name {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.upload__meta {
  flex: 1;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.upload__bar {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
  flex: none;
}

.upload__fill {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur) var(--ease-out);
}

/* ---------------------------------------------------------------- 内容区 */

.fm__body {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: var(--space-3);
  overflow-y: auto;
}

.fm__body--drop {
  background: var(--accent-soft);
}

.fm__dropzone {
  position: absolute;
  inset: var(--space-3);
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  color: var(--accent);
  background: var(--surface-1);
  pointer-events: none;
}

.fm__dropzone p {
  margin: 0;
  font-size: 13px;
}

.fm__empty-hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 网格 */

.fm__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--space-1);
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.tile:hover {
  background: var(--hover);
}

.tile--selected {
  background: var(--selected);
  border-color: var(--accent);
}

.tile__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 10px;
  background: var(--surface-3);
  color: var(--text-secondary);
}

/* 按类型给图标一点颜色区分，但不花哨 —— 只有强调色与几个语义色 */
.tile__glyph--folder {
  color: #f0b429;
}
.tile__glyph--pdf {
  color: #d94a4a;
}
.tile__glyph--doc {
  color: #3b7dd8;
}
.tile__glyph--sheet {
  color: #2f9e63;
}
.tile__glyph--slide {
  color: #d97a3b;
}
.tile__glyph--image {
  color: #6a8fd8;
}
.tile__glyph--video {
  color: #a06ad8;
}
.tile__glyph--audio {
  color: #4aa8b8;
}
.tile__glyph--archive {
  color: #b8894a;
}

.tile__name {
  font-size: 12px;
  line-height: 1.3;
  text-align: center;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tile__rename {
  width: 100%;
}

.tile__rename-input {
  height: 24px;
  font-size: 12px;
  text-align: center;
}

.tile__meta {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 列表 */

.fm__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.fm__table th {
  position: sticky;
  top: calc(var(--space-3) * -1);
  z-index: 1;
  padding: var(--space-2) var(--space-2);
  text-align: left;
  font-weight: 500;
  font-size: 11.5px;
  color: var(--text-tertiary);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
}

.row {
  cursor: default;
}

.row:hover {
  background: var(--hover);
}

.row--selected {
  background: var(--selected);
}

.fm__table td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.fm__col-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
}

.row__icon {
  display: flex;
  flex: none;
  color: var(--text-tertiary);
}

.row__icon--folder {
  color: #f0b429;
}
.row__icon--pdf {
  color: #d94a4a;
}
.row__icon--doc {
  color: #3b7dd8;
}
.row__icon--sheet {
  color: #2f9e63;
}
.row__icon--slide {
  color: #d97a3b;
}
.row__icon--image {
  color: #6a8fd8;
}
.row__icon--video {
  color: #a06ad8;
}
.row__icon--audio {
  color: #4aa8b8;
}
.row__icon--archive {
  color: #b8894a;
}

.row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__rename {
  height: 24px;
  font-size: 12.5px;
}

.fm__col-size,
.fm__col-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  width: 110px;
}

.fm__col-owner {
  width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------------------------------------------------------- 状态栏 */

.fm__statusbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 对话框 */

.fm__overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.fm__dialog {
  width: 100%;
  max-width: 380px;
  padding: var(--space-4);
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--surface-raised);
  box-shadow: var(--shadow-popup);
}

.fm__dialog-title {
  margin: 0 0 var(--space-3);
  font-size: 15px;
  font-weight: 600;
}

.fm__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* ---------------------------------------------------------------- 排序表头 */

.fm__col-sort {
  cursor: pointer;
  user-select: none;
}

.fm__col-sort:hover {
  color: var(--accent);
}

.fm__sort {
  font-size: 11px;
  color: var(--accent);
}

/* ---------------------------------------------------------------- 拖入文件夹高亮 */

.tile--dropinto {
  background: var(--selected);
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 2px var(--accent);
}

.row--dropinto td {
  background: var(--selected);
  box-shadow: inset 0 0 0 1px var(--accent);
}

/* ---------------------------------------------------------------- 移动到… */

.fm__dialog--move {
  max-width: 460px;
}

.fm__move-hint {
  margin: 0 0 var(--space-2);
}

.fm__move-tree {
  max-height: 280px;
  margin-bottom: var(--space-3);
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-solid);
}

.move-row {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-height: 30px;
  padding-right: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: none;
  color: var(--text);
  font-size: 13px;
  text-align: left;
}

.move-row--on {
  background: var(--selected);
  border-color: var(--accent);
}

.move-row--disabled .move-row__pick {
  opacity: 0.4;
  cursor: not-allowed;
}

.move-row__toggle,
.move-row__toggle-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
}

.move-row__toggle:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.move-row__toggle .wl-spinner {
  width: 11px;
  height: 11px;
  border-width: 1.5px;
}

.move-row__pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.move-row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fm__move-empty {
  margin: var(--space-2);
  font-size: 12px;
  color: var(--text-tertiary);
}

.fm__move-target {
  flex: 1;
  min-width: 0;
  margin-right: var(--space-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
  align-self: center;
}

/* ================================================================
   整体 UI 升级（评审团定稿）· 降噪覆盖层
   ================================================================ */

.fm .fm__toolbar {
  background: var(--surface-1);
  border-bottom: 1px solid var(--line-hair);
}

.fm .fm__crumbs {
  border-bottom: 1px solid var(--line-hair);
}

/* 网格图标：底色跟随图标自身的颜色做 10% 淡染，
   文件夹是琥珀、文档是中性灰、图片/视频各随其色——不再是一排同色方块 */
.fm .tile__glyph {
  background: color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 12px;
}

.fm .tile__name {
  font-size: var(--fs-caption);
}

.fm .tile__meta {
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
