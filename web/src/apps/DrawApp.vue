<!--
  你画我猜。

  画布的三个决定：
  1. **坐标是 0-1000 的相对值**（与服务端 draw-rooms.ts 的校验一致），渲染时
     按画布实际尺寸缩放。窗口随便缩放、两人屏幕不一样大，画出来是同一张图。
  2. **本地即时画 + 服务端回放分两条路**：自己画的每一笔先落本地画布（不等
     服务器），同时攒批上报；别人的笔画通过 draw-stroke 事件到达后重放。
     所以本地画布有两条入口：pointer 事件（自己）与 store.onStroke（别人），
     两条路最终都汇入同一个"指令重放"函数 replay()。
  3. **攒批 80ms**：pointermove 一秒能来上百次，一条一个请求会把服务端打爆。
     攒 80ms 合并成一条 points 上报 —— 画感延迟 ~100ms，肉眼无感。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import {
  api,
  ApiError,
  type DrawChatMsg,
  type DrawHistoryDetail,
  type DrawHistoryItem,
  type DrawHistoryRound,
  type DrawStrokeBroadcast,
  type DrawStrokeInput,
} from '@/api'
import { useDraw } from '@/stores/draw'
import { useUi } from '@/stores/ui'
import { useAuth } from '@/stores/auth'
import * as sfx from '@/lib/sfx'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const draw = useDraw()
const ui = useUi()
const auth = useAuth()

const myId = computed(() => auth.user?.id ?? '')

type View = 'lobby' | 'table' | 'history' | 'historyDetail'
const view = ref<View>('lobby')
const busy = ref(false)

// ---------------------------------------------------------------- 数据

const room = computed(() => draw.room)
const viewState = computed(() => draw.room?.view ?? null)
const rooms = computed(() => draw.rooms)

/** 倒计时（秒）。phaseEndsAt 是服务器时间，与本地可能有偏差，误差 <1s 可接受。 */
const nowTick = ref(Date.now())
let tickTimer: number | null = null

const secondsLeft = computed(() => {
  const endsAt = viewState.value?.phaseEndsAt ?? 0
  if (!endsAt) return 0
  return Math.max(0, Math.ceil((endsAt - nowTick.value) / 1000))
})

const PHASE_LABEL: Record<string, string> = {
  waiting: '等人',
  choosing: '选词',
  drawing: '绘画',
  reveal: '答案',
  finished: '结束',
}

// ---------------------------------------------------------------- 画布

const canvasEl = ref<HTMLCanvasElement | null>(null)
const canvasBox = ref<HTMLElement | null>(null)

const COLORS = ['#1f2430', '#e5484d', '#2b6cf6', '#30a46c', '#f5a623', '#8e4ec6', '#8b5a2b', '#f7f8fa']
const WIDTHS = [3, 6, 14]

const tool = ref<'pen' | 'eraser'>('pen')
const color = ref(COLORS[0]!)
const width = ref(WIDTHS[1]!)
const canDraw = computed(() => viewState.value?.iAmDrawer === true && viewState.value?.phase === 'drawing')

/**
 * 本地笔画簿：strokeId → 笔画。重放 / 撤销 / 清空都基于它，
 * 与服务端的缓冲是镜像（自己画的先落本地，服务端确认后大家一致）。
 */
interface LocalStroke {
  id: string
  color: string
  width: number
  tool: 'pen' | 'eraser'
  points: Array<{ x: number; y: number }>
}
const localStrokes = new Map<string, LocalStroke>()
/** 本地笔画簿的插入顺序（撤销 = 删最后一个）。 */
const strokeOrder: string[] = []

function ctx(): CanvasRenderingContext2D | null {
  return canvasEl.value?.getContext('2d') ?? null
}

/** 逻辑坐标（0-1000）→ 画布像素。 */
function scaleOf(): { sx: number; sy: number } {
  const el = canvasEl.value
  if (!el) return { sx: 1, sy: 1 }
  return { sx: el.width / 1000, sy: el.height / 1000 }
}
function drawSegment(
  g: CanvasRenderingContext2D,
  stroke: { color: string; width: number; tool: 'pen' | 'eraser'; points: Array<{ x: number; y: number }> },
  from: number,
): void {
  if (stroke.points.length < 2 || from >= stroke.points.length) return
  const { sx, sy } = scaleOf()
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color
  g.lineWidth = stroke.width * (stroke.tool === 'eraser' ? 4 : 1) * sx
  g.beginPath()
  const start = Math.max(0, from - 1)
  g.moveTo(stroke.points[start]!.x * sx, stroke.points[start]!.y * sy)
  for (let i = start + 1; i < stroke.points.length; i++) {
    g.lineTo(stroke.points[i]!.x * sx, stroke.points[i]!.y * sy)
  }
  g.stroke()
  g.restore()
}

/** 起笔画一个点（只有一个点也看得见：画个圆点）。 */
function drawDot(stroke: LocalStroke): void {
  const g = ctx()
  if (!g || stroke.points.length === 0) return
  const { sx, sy } = scaleOf()
  const p = stroke.points[0]!
  g.save()
  g.fillStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color
  g.beginPath()
  g.arc(p.x * sx, p.y * sy, (stroke.width * sx) / 2, 0, Math.PI * 2)
  g.fill()
  g.restore()
}

function clearCanvas(): void {
  const g = ctx()
  if (!g) return
  g.clearRect(0, 0, canvasEl.value!.width, canvasEl.value!.height)
}

/** 全量重放本地笔画簿（撤销 / clear / 补发之后）。 */
function replayAll(): void {
  clearCanvas()
  for (const id of strokeOrder) {
    const stroke = localStrokes.get(id)
    if (!stroke) continue
    drawDot(stroke)
    drawSegment(ctx()!, stroke, 0)
  }
}

// ---------------------------------------------------------------- 上报攒批

let strokeSeq = 0
let activeStroke: LocalStroke | null = null
/** 攒批队列：pointermove 的点先堆在这里，80ms 定时器统一上报。 */
let pendingPoints: Array<{ x: number; y: number }> = []
let flushTimer: number | null = null
/**
 * 自己发起的笔画 id。服务端广播给全房间（含画家本人）—— 不加这个集合，
 * 画家的浏览器会把自己的笔迹再重放一遍：begin 回声覆盖 localStrokes 里的
 * 对象、strokeOrder 里同 id 出现两次，本地笔画簿与回声对象分叉。
 */
const myStrokeIds = new Set<string>()

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = window.setInterval(() => {
    flushPending()
  }, 80)
}

function stopFlush(): void {
  if (flushTimer !== null) {
    window.clearInterval(flushTimer)
    flushTimer = null
  }
}

function flushPending(): void {
  if (!activeStroke || pendingPoints.length === 0) return
  const points = pendingPoints
  pendingPoints = []
  // 点在 onPointerMove 里就已经画了、也进了 activeStroke.points ——
  // 这里只负责把增量上报。之前这里还"补画一遍"，那是在点没进笔画对象时
  // 的补救；现在两条路合一，再画就是重复描线。
  draw.sendStroke({
    op: 'points',
    strokeId: activeStroke.id,
    points,
    color: activeStroke.color,
    width: activeStroke.width,
    tool: activeStroke.tool,
  })
}

function toLocal(event: PointerEvent): { x: number; y: number } {
  // **用容器的矩形，不用 canvas 自己的**。
  //
  // canvas 是 position:absolute; inset:0，它的显示尺寸由容器决定；但它自己的
  // getBoundingClientRect 在布局未稳时可能返回视口级宽度（窗口刚打开/切视图
  // 的那几帧），与容器不一致。用它换算出来的是错的逻辑坐标 —— 实测笔迹被
  // 压缩到真实位置的 0.44 倍，视觉上就是"只有左上角能画"。
  // 容器是布局的权威，映射只认它。
  const rect = (canvasBox.value ?? canvasEl.value)!.getBoundingClientRect()
  const x = Math.round(((event.clientX - rect.left) / rect.width) * 1000)
  const y = Math.round(((event.clientY - rect.top) / rect.height) * 1000)
  return {
    x: Math.min(1000, Math.max(0, x)),
    y: Math.min(1000, Math.max(0, y)),
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!canDraw.value) return
  if (event.button !== 0) return
  // 落笔前对齐画布像素尺寸（见 syncCanvasSize 注释）。
  // 必须在 toLocal 之前：toLocal 按 CSS 矩形换算，绘制按像素尺寸缩放，
  // 两者脱节时笔迹就会跑到左上角。
  syncCanvasSize()
  const point = toLocal(event)
  strokeSeq += 1
  activeStroke = {
    id: `s${Date.now().toString(36)}${strokeSeq}`,
    color: color.value,
    width: width.value,
    tool: tool.value,
    points: [point],
  }
  localStrokes.set(activeStroke.id, activeStroke)
  strokeOrder.push(activeStroke.id)
  myStrokeIds.add(activeStroke.id)
  drawDot(activeStroke)
  canvasEl.value?.setPointerCapture(event.pointerId)
  draw.sendStroke({
    op: 'begin',
    strokeId: activeStroke.id,
    points: [point],
    color: activeStroke.color,
    width: activeStroke.width,
    tool: activeStroke.tool,
  })
  scheduleFlush()
}

function onPointerMove(event: PointerEvent): void {
  if (!activeStroke) return
  const point = toLocal(event)
  // 点**必须同时**进笔画对象和攒批队列：前者是本地即时画的依据（画
  // prev→point 这一小段，不等 80ms，手感才跟手），后者是上报的增量。
  // 最初只进了攒批队列，本地画线因"笔画对象里点数不足 2"全程失效 ——
  // 屏幕上能看见的线其实是服务端回声描出来的，慢一拍还依赖广播。
  const prev = activeStroke.points[activeStroke.points.length - 1]
  activeStroke.points.push(point)
  pendingPoints.push(point)
  if (prev) drawSegment(ctx()!, activeStroke, activeStroke.points.length - 1)
}

function onPointerUp(): void {
  if (!activeStroke) return
  flushPending()
  draw.sendStroke({
    op: 'end',
    strokeId: activeStroke.id,
    points: [],
    color: activeStroke.color,
    width: activeStroke.width,
    tool: activeStroke.tool,
  })
  activeStroke = null
  stopFlush()
}

function undoStroke(): void {
  if (!canDraw.value) return
  const lastId = strokeOrder.pop()
  if (!lastId) return
  localStrokes.delete(lastId)
  replayAll()
  draw.sendStroke({ op: 'undo', strokeId: lastId, points: [], color: color.value, width: width.value, tool: tool.value })
}

function clearAll(): void {
  if (!canDraw.value) return
  localStrokes.clear()
  strokeOrder.length = 0
  activeStroke = null
  pendingPoints = []
  clearCanvas()
  draw.sendStroke({ op: 'clear', strokeId: '', points: [], color: color.value, width: width.value, tool: tool.value })
}

// ---------------------------------------------------------------- 别人的笔迹

const offStroke = draw.onStroke((op: DrawStrokeBroadcast) => {
  // 自己的回声跳过：本地在 pointer 事件里已经画过了（见 myStrokeIds）。
  // 例外是 clear —— 它没有 strokeId，本地处理过一遍，回声再来一遍会把
  // 刚画的清掉……所以 clear 也跳过，用"发起人是不是我"判断。
  if (op.from === myId.value) return

  if (op.op === 'clear') {
    localStrokes.clear()
    strokeOrder.length = 0
    clearCanvas()
    return
  }
  if (op.op === 'undo') {
    // 撤销：按 strokeId 删；删不到（丢过事件）就全量补发兜底
    if (localStrokes.delete(op.strokeId)) {
      const index = strokeOrder.indexOf(op.strokeId)
      if (index >= 0) strokeOrder.splice(index, 1)
      replayAll()
    } else {
      void pullCanvas()
    }
    return
  }
  if (op.op === 'begin') {
    const stroke: LocalStroke = {
      id: op.strokeId,
      color: op.color,
      width: op.width,
      tool: op.tool,
      points: [...op.points],
    }
    localStrokes.set(stroke.id, stroke)
    strokeOrder.push(stroke.id)
    drawDot(stroke)
    return
  }
  if (op.op === 'points' || op.op === 'end') {
    const stroke = localStrokes.get(op.strokeId)
    if (!stroke) return
    const before = stroke.points.length
    stroke.points.push(...op.points)
    drawSegment(ctx()!, stroke, before === 0 ? 0 : before - 1)
  }
})

/** 补发画布：进入牌桌 / 新回合开始 / 本地状态可疑时拉一次全量。 */
async function pullCanvas(): Promise<void> {
  const current = room.value
  if (!current) return
  try {
    const { strokes } = await api.draw.canvas(current.id)
    localStrokes.clear()
    strokeOrder.length = 0
    clearCanvas()
    for (const op of strokes) {
      if (op.op === 'clear') {
        localStrokes.clear()
        strokeOrder.length = 0
        clearCanvas()
        continue
      }
      if (op.op === 'undo') {
        const index = strokeOrder.indexOf(op.strokeId)
        if (index >= 0) {
          strokeOrder.splice(index, 1)
          localStrokes.delete(op.strokeId)
        }
        continue
      }
      if (op.op === 'begin') {
        const stroke: LocalStroke = {
          id: op.strokeId,
          color: op.color,
          width: op.width,
          tool: op.tool,
          points: [...op.points],
        }
        localStrokes.set(stroke.id, stroke)
        strokeOrder.push(stroke.id)
        continue
      }
      if (op.op === 'points' || op.op === 'end') {
        localStrokes.get(op.strokeId)?.points.push(...op.points)
      }
    }
    replayAll()
  } catch {
    // 补发失败不致命：下一回合开始时会再拉
  }
}

// ---------------------------------------------------------------- 大厅

const newTitle = ref('')

async function onCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await draw.createRoom(newTitle.value.trim(), rounds.value)
    newTitle.value = ''
    view.value = 'table'
    await afterEnterTable()
  } catch {
    /* 错误已在 store 里 */
  } finally {
    busy.value = false
  }
}

const rounds = ref(2)

// ---------------------------------------------------------------- 历史对局

const historyItems = ref<DrawHistoryItem[]>([])
const historyDetail = ref<DrawHistoryDetail | null>(null)
const selectedTurn = ref<DrawHistoryRound | null>(null)
const historyBusy = ref(false)
const historyError = ref<string | null>(null)
const historyCanvasEl = ref<HTMLCanvasElement | null>(null)

async function openHistory(): Promise<void> {
  view.value = 'history'
  historyBusy.value = true
  historyError.value = null
  try {
    const { rooms } = await api.draw.history()
    historyItems.value = rooms
  } catch (err) {
    historyError.value = err instanceof ApiError ? err.message : '加载历史失败'
  } finally {
    historyBusy.value = false
  }
}

async function openHistoryDetail(roomId: string): Promise<void> {
  view.value = 'historyDetail'
  historyBusy.value = true
  historyError.value = null
  try {
    const { detail } = await api.draw.historyDetail(roomId)
    historyDetail.value = detail
    // 默认停在最后一回合（大家最想看刚才那张）
    selectedTurn.value = detail.rounds[detail.rounds.length - 1] ?? null
    await nextTick()
    renderHistoryTurn()
  } catch (err) {
    historyError.value = err instanceof ApiError ? err.message : '加载这一局失败'
  } finally {
    historyBusy.value = false
  }
}

function selectTurn(round: DrawHistoryRound): void {
  selectedTurn.value = round
  void nextTick(() => renderHistoryTurn())
}

/**
 * 把存档的笔画画到只读画布上。
 *
 * 存档里每一笔已经按 strokeId 合并成一条完整笔画（服务端 archiveRound
 * 做的），所以这里不需要还原撤销/清空语义 —— 直接一笔一笔照着画。
 */
function renderHistoryTurn(): void {
  const c = historyCanvasEl.value
  if (!c) return
  const g = c.getContext('2d')
  if (!g) return

  const dpr = window.devicePixelRatio || 1
  const rect = c.getBoundingClientRect()
  const w = Math.max(200, Math.round(rect.width * dpr))
  const h = Math.max(150, Math.round(rect.height * dpr))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  g.clearRect(0, 0, c.width, c.height)

  const round = selectedTurn.value
  if (!round) return
  const sx = c.width / 1000
  const sy = c.height / 1000

  for (const op of round.strokes) {
    if (op.points.length === 0) continue
    g.save()
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.strokeStyle = op.tool === 'eraser' ? '#ffffff' : op.color
    g.fillStyle = g.strokeStyle
    g.lineWidth = op.width * (op.tool === 'eraser' ? 4 : 1) * sx
    if (op.points.length === 1) {
      const p = op.points[0]!
      g.beginPath()
      g.arc(p.x * sx, p.y * sy, g.lineWidth / 2, 0, Math.PI * 2)
      g.fill()
    } else {
      g.beginPath()
      g.moveTo(op.points[0]!.x * sx, op.points[0]!.y * sy)
      for (let i = 1; i < op.points.length; i++) {
        g.lineTo(op.points[i]!.x * sx, op.points[i]!.y * sy)
      }
      g.stroke()
    }
    g.restore()
  }
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function onRefresh(): Promise<void> {
  await draw.loadRooms()
}

async function onEnterRoom(id: string): Promise<void> {
  const target = rooms.value.find((r) => r.id === id)
  if (!target) return
  const alreadyIn = target.view.players.some((p) => p.userId === myId.value)
  try {
    if (alreadyIn || target.phase !== 'waiting') await draw.openRoom(id)
    else await draw.join(id)
    view.value = 'table'
    await afterEnterTable()
  } catch (err) {
    if (err instanceof ApiError) ui.notify('warning', '进不去这一局', err.message)
  }
}

async function onLeave(): Promise<void> {
  await draw.leave()
  view.value = 'lobby'
  activeStroke = null
  stopFlush()
  await draw.loadRooms()
}

async function onStart(): Promise<void> {
  await draw.start()
}

async function afterEnterTable(): Promise<void> {
  await nextTick()
  // 两帧之后再设尺寸：避开窗口打开动画的中间态（见 resizeCanvas 的重试）。
  // 观察器在 nextTick 后就建 —— 它只依赖"画布已在 DOM 里"，不必等动画；
  // 建立得越早，"尺寸脱节"的窗口期越短。
  ensureResizeObserver()
  requestAnimationFrame(() => {
    resizeCanvas()
    ensureResizeObserver()
  })
  // 中途进来（别人已画了半张图）补一次全量
  if (viewState.value?.phase === 'drawing') void pullCanvas()
}

// ---------------------------------------------------------------- 选词 / 猜词

async function onPickWord(word: string): Promise<void> {
  await draw.chooseWord(word)
}

const guessText = ref('')
const chatListEl = ref<HTMLElement | null>(null)

async function onSendGuess(): Promise<void> {
  const text = guessText.value
  guessText.value = ''
  await draw.guess(text)
}

// ---------------------------------------------------------------- 反馈

const lastChatLen = ref(0)

watch(
  () => draw.room?.chat,
  (chat) => {
    if (!chat) return
    // 有人猜对：一声"成功"（不区分是谁 —— 对猜的人来说这就是个提示音）
    if (chat.length > lastChatLen.value) {
      const latest = chat[chat.length - 1]
      if (latest?.correct) sfx.playSystem('success')
    }
    lastChatLen.value = chat.length
    void nextTick(() => {
      const el = chatListEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

watch(
  () => viewState.value?.phase,
  (phase, prev) => {
    if (phase === prev) return
    if (phase === 'choosing') {
      // 新回合的选词阶段：本地先清一遍。服务端也会广播 clear（权威），
      // 但断线重连后可能错过那一条 —— 两条路只管清，重复清是无害的。
      localStrokes.clear()
      strokeOrder.length = 0
      clearCanvas()
      return
    }
    if (phase === 'drawing') {
      // 新回合：清空本地画布，补发（此时服务端缓冲也刚被重置，通常是空的）
      localStrokes.clear()
      strokeOrder.length = 0
      clearCanvas()
      void pullCanvas()
      // 轮到我画：这是唯一需要"立刻知道"的信号（错过就是干等 10 秒选词）
      if (viewState.value?.iAmDrawer) sfx.playYourTurn()
    }
    if (phase === 'reveal') sfx.playSystem('notify')
    if (phase === 'finished') sfx.playSystem('success')
  },
)

// ---------------------------------------------------------------- 生命周期

/** 尺寸尝试过小（窗口打开动画/布局未稳）时的重试计数。 */
let resizeRetries = 0

function resizeCanvas(): void {
  const el = canvasEl.value
  const box = canvasBox.value
  if (!el || !box) return
  // 高分屏按 devicePixelRatio 放大，避免笔画发虚
  const dpr = window.devicePixelRatio || 1
  const rect = box.getBoundingClientRect()

  // 桌面窗口打开有过渡动画，动画中的 rect 比终态小。把 canvas 的像素尺寸
  // 钉在这个小值上、CSS 又把它拉伸回终态 —— 笔迹就会全部挤在左上角。
  if ((rect.width < 120 || rect.height < 120) && resizeRetries < 30) {
    resizeRetries += 1
    requestAnimationFrame(() => resizeCanvas())
    return
  }
  resizeRetries = 0

  const nextW = Math.max(200, Math.round(rect.width * dpr))
  const nextH = Math.max(150, Math.round(rect.height * dpr))
  // 尺寸没变就不动（resize 会清空画布，必须紧跟 replayAll；
  // 落笔前的自愈检查会频繁调用它，白重放一次是浪费）
  if (el.width === nextW && el.height === nextH) return

  el.width = nextW
  el.height = nextH
  // ⚠️ **不要设 style.width/height**：canvas 是 `position:absolute; inset:0`，
  // 显示尺寸由容器拉伸决定。写过 style.width 之后，那个旧值会覆盖 inset 的
  // 拉伸（width 优先于 right:0），画布从此比容器宽 —— 而且 getBoundingClientRect
  // 也跟着变大，取到了错误宽度却"看起来很自洽"，是最难查的一类错。
  replayAll()
}

/**
 * 落笔前的尺寸自愈。
 *
 * 只在进入画桌时对齐一次不够 —— 实测仍会出现"只有左上角能画"：
 * 观察器建立晚于落笔、浏览器缩放改了 dpr、窗口被拖大而回调还没来，
 * 都会让 canvas 像素尺寸与 CSS 尺寸脱节。落笔是唯一"百分之百会发生的
 * 时机"，在这里兜一次，把窗口/动画/观察器全都不再是前提条件。
 */
function syncCanvasSize(): void {
  const el = canvasEl.value
  const box = canvasBox.value
  if (!el || !box) return
  const dpr = window.devicePixelRatio || 1
  const rect = box.getBoundingClientRect()
  const wantW = Math.max(200, Math.round(rect.width * dpr))
  const wantH = Math.max(150, Math.round(rect.height * dpr))
  if (el.width !== wantW || el.height !== wantH) resizeCanvas()
}

let resizeObserver: ResizeObserver | null = null

/**
 * 画布的尺寸观察器**必须在画布进入 DOM 之后建**。
 *
 * 之前它写在 onMounted 里 —— 那时组件还在大厅视图，canvasBox 根本不存在，
 * 判空之后 observer 就永远没建起来；进入画桌只靠 afterEnterTable 的一次
 * resizeCanvas，取到的是打开动画中的小尺寸，之后再没有任何东西纠正它。
 */
function ensureResizeObserver(): void {
  if (resizeObserver || typeof ResizeObserver === 'undefined' || !canvasBox.value) return
  resizeObserver = new ResizeObserver(() => resizeCanvas())
  resizeObserver.observe(canvasBox.value)
}

onMounted(() => {
  draw.connectRealtime()
  void draw.loadRooms()

  const roomId = props.win.args.roomId
  if (typeof roomId === 'string' && roomId) {
    view.value = 'table'
    void draw.openRoom(roomId).then(() => afterEnterTable())
  }

  tickTimer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 500)
})

onBeforeUnmount(() => {
  offStroke()
  stopFlush()
  if (tickTimer !== null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ---------------------------------------------------------------- 小工具

function chatTextOf(msg: DrawChatMsg): string {
  // 猜对的消息对所有人显示为"猜对了"—— 不把词再广播一遍（reveal 才公布）
  if (msg.correct) return `${msg.name} 猜对了！`
  // "很接近"只给猜的人自己看（服务端只把 close 标在消息上，房间内人人可见，
  // 与 skribbl 的通行做法一致：接近不算泄题）
  if (msg.close) return `${msg.name} 猜得很接近`
  return `${msg.name}：${msg.text}`
}
</script>

<template>
  <div class="draw">
    <!-- ======================================================= 大厅 -->
    <template v-if="view === 'lobby'">
      <header class="bar">
        <div class="bar-title"><Icon name="brush" :size="18" />你画我猜</div>
        <div class="spacer" />
        <button class="wl-btn wl-btn--ghost" @click="openHistory">
          <Icon name="clock" :size="15" />历史对局
        </button>
        <button class="wl-icon-btn" :disabled="draw.loading" title="刷新" @click="onRefresh">
          <Icon name="refresh" :size="16" :class="{ spin: draw.loading }" />
        </button>
      </header>

      <div class="body wl-scroll">
        <div class="new-room">
          <input v-model="newTitle" class="wl-input" placeholder="房间名（可留空）" maxlength="40" @keydown.enter="onCreate" />
          <select v-model.number="rounds" class="wl-input rounds-select" aria-label="轮数">
            <option v-for="n in 10" :key="n" :value="n">{{ n }} 轮</option>
          </select>
          <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onCreate">
            <Icon name="plus" :size="16" />新建房间
          </button>
        </div>

        <div v-if="rooms.length === 0 && !draw.loading" class="wl-empty">
          <Icon name="brush" :size="32" />
          <span>还没有房间，开一个吧</span>
        </div>

        <div v-else class="room-list">
          <article v-for="item in rooms" :key="item.id" class="room-card">
            <div class="room-main">
              <div class="room-head">
                <span class="room-title">{{ item.title || '你画我猜' }}</span>
                <span class="wl-badge" :class="item.phase === 'waiting' ? 'wl-badge--accent' : 'wl-badge--success'">
                  {{ item.phase === 'waiting' ? `等人（${item.view.players.length}/8）` : '进行中' }}
                </span>
              </div>
              <div class="room-seats">
                <span v-for="p in item.view.players" :key="p.userId" class="seat-chip">
                  <span class="dot" :class="p.online ? 'dot--on' : 'dot--off'" />
                  {{ p.name }}
                </span>
              </div>
              <div class="room-meta">房主 {{ item.creatorName }}</div>
            </div>
            <div class="room-action">
              <button
                class="wl-btn"
                :class="{ 'wl-btn--primary': item.phase === 'waiting' }"
                @click="onEnterRoom(item.id)"
              >
                {{ item.phase === 'waiting' ? '进入' : '观看' }}
              </button>
            </div>
          </article>
        </div>
      </div>
    </template>

    <!-- ======================================================= 历史对局列表 -->
    <template v-else-if="view === 'history'">
      <header class="bar">
        <button class="wl-icon-btn" title="返回大厅" @click="view = 'lobby'">
          <Icon name="chevron-left" :size="16" />
        </button>
        <div class="bar-title"><Icon name="clock" :size="18" />历史对局</div>
        <div class="spacer" />
        <button class="wl-icon-btn" :disabled="historyBusy" title="刷新" @click="openHistory">
          <Icon name="refresh" :size="16" :class="{ spin: historyBusy }" />
        </button>
      </header>

      <div class="body wl-scroll">
        <div v-if="historyError" class="wl-hint">{{ historyError }}</div>
        <div v-else-if="!historyBusy && historyItems.length === 0" class="wl-empty">
          <Icon name="clock" :size="32" />
          <span>还没有打完的对局</span>
        </div>
        <div v-else class="room-list">
          <article v-for="item in historyItems" :key="item.roomId" class="room-card room-card--clickable" @click="openHistoryDetail(item.roomId)">
            <div class="room-main">
              <div class="room-head">
                <span class="room-title">{{ item.title || '你画我猜' }}</span>
                <span class="wl-badge">{{ item.roundCount }} 回合</span>
                <span class="history-time">{{ formatTime(item.finishedAt) }}</span>
              </div>
              <div class="history-ranking">
                <span v-for="(p, i) in item.ranking.slice(0, 5)" :key="p.userId" class="rank-chip">
                  <span class="rank-no">{{ i + 1 }}</span>{{ p.name }}
                  <strong>{{ p.score }}</strong>
                </span>
              </div>
            </div>
            <Icon name="chevron-right" :size="16" class="room-arrow" />
          </article>
        </div>
      </div>
    </template>

    <!-- ======================================================= 历史对局详情 -->
    <template v-else-if="view === 'historyDetail'">
      <header class="bar">
        <button class="wl-icon-btn" title="返回列表" @click="view = 'history'">
          <Icon name="chevron-left" :size="16" />
        </button>
        <div class="bar-title">
          <Icon name="brush" :size="18" />
          <span class="selectable">{{ historyDetail?.title || '历史对局' }}</span>
        </div>
        <span v-if="historyDetail" class="history-time">{{ formatTime(historyDetail.finishedAt) }}</span>
        <div class="spacer" />
      </header>

      <div v-if="!historyDetail" class="wl-empty">
        <span v-if="historyBusy" class="wl-spinner" />
        <span>{{ historyError || '正在加载…' }}</span>
      </div>

      <div v-else class="history-detail">
        <!-- 左：回合列表 -->
        <aside class="turn-list wl-scroll">
          <div
            v-for="round in historyDetail.rounds"
            :key="round.turnNo"
            class="turn-item"
            :class="{ 'turn-item--on': selectedTurn?.turnNo === round.turnNo }"
            @click="selectTurn(round)"
          >
            <span class="turn-no">{{ round.turnNo }}</span>
            <div class="turn-main">
              <span class="turn-drawer">{{ round.drawerName }}</span>
              <span class="turn-word">「{{ round.word }}」</span>
            </div>
            <span class="turn-round">第 {{ round.roundNo }} 轮</span>
          </div>
          <div v-if="historyDetail.rounds.length === 0" class="wl-empty">
            <span>这一局没有留下回合记录</span>
          </div>
        </aside>

        <!-- 右：画布 + 该回合结果 -->
        <section class="history-board">
          <div class="history-board-head">
            <span v-if="selectedTurn" class="word-display">
              {{ selectedTurn.drawerName }} 画的是：<strong>{{ selectedTurn.word }}</strong>
            </span>
            <span v-else class="hint-text">选一个回合看画</span>
          </div>
          <div class="canvas-box canvas-box--readonly">
            <canvas ref="historyCanvasEl" class="board-canvas" />
            <div v-if="!selectedTurn" class="canvas-veil"><span>还没有选回合</span></div>
          </div>
          <div v-if="selectedTurn" class="history-results">
            <span
              v-for="r in selectedTurn.results"
              :key="r.userId"
              class="result-chip"
              :class="{ 'result-chip--guessed': r.guessed }"
            >
              <Icon :name="r.guessed ? 'check' : 'close'" :size="12" />
              {{ r.name }}
              <strong>{{ r.score }}</strong>
            </span>
          </div>
        </section>
      </div>
    </template>

    <!-- ======================================================= 画桌 -->
    <template v-else>
      <header class="bar">
        <button class="wl-icon-btn" title="返回大厅" @click="onLeave">
          <Icon name="chevron-left" :size="16" />
        </button>
        <div class="bar-title">
          <Icon name="brush" :size="18" />
          <span class="selectable">{{ room?.title || '你画我猜' }}</span>
        </div>
        <span class="wl-badge" :class="viewState?.phase === 'finished' ? '' : 'wl-badge--success'">
          {{ PHASE_LABEL[viewState?.phase ?? ''] ?? '' }}
        </span>
        <span v-if="viewState && viewState.phase !== 'waiting' && viewState.phase !== 'finished'" class="countdown">
          {{ secondsLeft }}s
        </span>
        <span v-if="viewState && viewState.phase !== 'waiting'" class="round-mark">
          第 {{ viewState.round }}/{{ viewState.totalRounds }} 轮
        </span>
        <div class="spacer" />
        <button class="wl-icon-btn" :disabled="draw.loading" title="刷新" @click="draw.reload()">
          <Icon name="refresh" :size="16" :class="{ spin: draw.loading }" />
        </button>
      </header>

      <div v-if="!room" class="wl-empty">
        <span class="wl-spinner" />
        <span>正在加载房间…</span>
      </div>

      <template v-else>
        <!-- ============ 等人 ============ -->
        <div v-if="viewState?.phase === 'waiting'" class="phase-panel wl-scroll">
          <div class="wl-empty">
            <Icon name="user" :size="32" />
            <span>
              当前 {{ viewState.players.length }} 人，还差 {{ Math.max(0, 2 - viewState.players.length) }} 人开局
            </span>
            <div class="waiting-players">
              <span v-for="p in viewState.players" :key="p.userId" class="seat-chip">
                <span class="dot" :class="p.online ? 'dot--on' : 'dot--off'" />{{ p.name }}
              </span>
            </div>
            <button v-if="room?.createdBy === myId" class="wl-btn wl-btn--primary" :disabled="draw.submitting" @click="onStart">
              开始游戏
            </button>
            <span v-else class="wl-hint">等房主开始</span>
          </div>
        </div>

        <!-- ============ 结算 ============ -->
        <div v-else-if="viewState?.phase === 'finished'" class="phase-panel">
          <div class="result-panel">
            <h3>本局结束</h3>
            <ol class="ranking">
              <li v-for="(p, i) in viewState.result?.ranking ?? []" :key="p.userId" :class="{ me: p.userId === myId }">
                <span class="rank-no">{{ i + 1 }}</span>
                <span class="rank-name">{{ p.name }}</span>
                <span class="rank-score">{{ p.score }} 分</span>
              </li>
            </ol>
            <button class="wl-btn wl-btn--primary" @click="onLeave">返回大厅再来一局</button>
          </div>
        </div>

        <!-- ============ 游戏中 ============ -->
        <div v-else class="table">
          <!-- 左：玩家 -->
          <aside class="players wl-scroll">
            <div
              v-for="p in viewState?.players ?? []"
              :key="p.userId"
              class="player"
              :class="{ 'player--drawer': p.isDrawer, 'player--guessed': p.guessed }"
            >
              <span class="dot" :class="p.online ? 'dot--on' : 'dot--off'" />
              <span class="player-name">{{ p.name }}</span>
              <Icon v-if="p.isDrawer" name="brush" :size="14" />
              <Icon v-else-if="p.guessed" name="check" :size="14" class="guessed-mark" />
              <span class="player-score">{{ p.score }}</span>
            </div>
          </aside>

          <!-- 中：画布 -->
          <section class="board">
            <div class="board-head">
              <!-- 选词 -->
              <template v-if="viewState?.phase === 'choosing'">
                <template v-if="viewState.iAmDrawer">
                  <span class="hint-text">选一个词来画（{{ Math.ceil(secondsLeft) }}s 后随机）：</span>
                  <button
                    v-for="choice in viewState.wordChoices"
                    :key="choice"
                    class="wl-btn wl-btn--primary word-choice"
                    @click="onPickWord(choice)"
                  >
                    {{ choice }}
                  </button>
                </template>
                <span class="hint-text">{{ viewState.drawerName }} 正在选词…</span>
              </template>

              <!-- 绘画：词 / 掩码 -->
              <template v-else-if="viewState?.phase === 'drawing'">
                <span v-if="viewState.iAmDrawer" class="word-display">
                  请画：<strong>{{ viewState.word }}</strong>
                </span>
                <span v-else-if="viewState.iGuessed" class="word-display">
                  你猜对了：<strong>{{ viewState.word }}</strong>
                </span>
                <span v-else class="word-display word-masked">{{ viewState.masked }}</span>
                <span class="hint-text">（{{ viewState.masked?.length }} 个字）</span>
              </template>

              <!-- 答案 -->
              <template v-else-if="viewState?.phase === 'reveal'">
                <span class="word-display">答案：<strong>{{ viewState.word }}</strong></span>
                <span class="hint-text">下一个：{{ viewState.players[viewState.drawerIndex]?.name }}（{{ secondsLeft }}s）</span>
              </template>
            </div>

            <div ref="canvasBox" class="canvas-box">
              <canvas
                ref="canvasEl"
                class="board-canvas"
                :class="{ 'board-canvas--draw': canDraw }"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
              />
              <div v-if="viewState?.phase === 'choosing' && !viewState.iAmDrawer" class="canvas-veil">
                <span>准备开始…</span>
              </div>
            </div>

            <!-- 工具栏：只有画家能用 -->
            <div class="tools" :class="{ 'tools--disabled': !canDraw }">
              <div class="tool-group">
                <button
                  v-for="c in COLORS"
                  :key="c"
                  class="color-chip"
                  :class="{ 'color-chip--on': color === c && tool === 'pen' }"
                  :style="{ background: c }"
                  :title="c"
                  :disabled="!canDraw"
                  @click="color = c; tool = 'pen'"
                />
              </div>
              <div class="tool-group">
                <button
                  v-for="w in WIDTHS"
                  :key="w"
                  class="width-chip"
                  :class="{ 'width-chip--on': width === w }"
                  :disabled="!canDraw"
                  @click="width = w; tool = 'pen'"
                >
                  <span :style="{ width: `${w + 2}px`, height: `${w + 2}px` }" />
                </button>
              </div>
              <div class="tool-group">
                <button
                  class="wl-icon-btn"
                  :class="{ 'tool--on': tool === 'eraser' }"
                  :disabled="!canDraw"
                  title="橡皮"
                  @click="tool = tool === 'eraser' ? 'pen' : 'eraser'"
                >
                  <Icon name="eraser" :size="16" />
                </button>
                <button class="wl-icon-btn" :disabled="!canDraw" title="撤销上一笔" @click="undoStroke">
                  <Icon name="refresh" :size="16" />
                </button>
                <button class="wl-icon-btn" :disabled="!canDraw" title="清空画布" @click="clearAll">
                  <Icon name="trash" :size="16" />
                </button>
              </div>
            </div>
          </section>

          <!-- 右：猜词 -->
          <aside class="chat">
            <div ref="chatListEl" class="chat-list wl-scroll">
              <div
                v-for="(msg, i) in draw.chat"
                :key="i"
                class="chat-msg"
                :class="{ 'chat-msg--correct': msg.correct, 'chat-msg--mine': msg.userId === myId }"
              >
                {{ chatTextOf(msg) }}
              </div>
              <div v-if="draw.chat.length === 0" class="chat-empty">在这里输入你的猜测</div>
            </div>
            <div class="chat-input-row">
              <input
                v-model="guessText"
                class="wl-input"
                :placeholder="viewState?.phase === 'drawing' ? '在这里猜…' : '随便聊聊'"
                maxlength="60"
                @keydown.enter="onSendGuess"
              />
              <button class="wl-btn wl-btn--primary" :disabled="!guessText.trim()" @click="onSendGuess">发送</button>
            </div>
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.draw {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  flex: none;
}

.bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 600;
}

.spacer {
  flex: 1;
}

.countdown {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--accent);
}

.round-mark {
  font-size: 12px;
  color: var(--text-tertiary);
}

.body {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.new-room {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.new-room .wl-input {
  flex: 1;
}

.rounds-select {
  width: 90px;
  flex: none;
}

.room-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.room-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
}

.room-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.room-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.room-title {
  font-weight: 600;
  font-size: 13.5px;
}

.room-seats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.room-meta {
  font-size: 12px;
  color: var(--text-tertiary);
}

.seat-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.dot--on {
  background: #30a46c;
}

.dot--off {
  background: var(--text-disabled);
}

/* ---------------- 游戏区三栏 */

.table {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 170px 1fr 240px;
  gap: var(--space-2);
  padding: var(--space-2);
}

.players {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow-y: auto;
}

.player {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.player--drawer {
  background: var(--accent-soft);
  font-weight: 600;
}

.player--guessed {
  color: #30a46c;
}

.player-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guessed-mark {
  color: #30a46c;
}

.player-score {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.board {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: var(--space-2);
}

.board-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  flex-wrap: wrap;
}

.hint-text {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.word-display {
  font-size: 15px;
}

.word-display strong {
  font-size: 18px;
  letter-spacing: 2px;
}

.word-masked {
  letter-spacing: 6px;
  font-weight: 700;
}

.word-choice {
  font-size: 14px;
}

.canvas-box {
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #ffffff;
  overflow: hidden;
}

.board-canvas {
  position: absolute;
  inset: 0;
  /* ⚠️ 这两行不能省：canvas 是**替换元素**，`inset:0` 对它的 width:auto
     不会产生拉伸 —— auto 宽度取的是固有尺寸（attribute width，默认 300）。
     没有这两行，画布就只有左上角 300×150 那么大，鼠标在别处按下根本
     落不到 canvas 上，用户看到的就是"只有左上角一小块能画"。
     用百分比而不是 px：百分比参照 canvas-box，窗口怎么变都跟着走，
     也不会像 px 那样把布局钉死。 */
  width: 100%;
  height: 100%;
  touch-action: none;
}

.board-canvas--draw {
  cursor: crosshair;
}

.canvas-veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  background: rgba(255, 255, 255, 0.72);
  font-size: 13px;
}

.tools {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.tools--disabled {
  opacity: 0.45;
  pointer-events: none;
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color-chip {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.color-chip--on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.width-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  cursor: pointer;
}

.width-chip span {
  border-radius: 50%;
  background: var(--text);
}

.width-chip--on {
  border-color: var(--accent);
}

.tool--on {
  background: var(--accent-soft);
}

.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow: hidden;
}

.chat-list {
  flex: 1;
  min-height: 0;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.chat-msg {
  font-size: 12.5px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  word-break: break-all;
}

.chat-msg--correct {
  background: rgba(48, 164, 108, 0.16);
  color: #1f7a4d;
  font-weight: 600;
}

.chat-msg--mine {
  background: var(--accent-soft);
}

.chat-empty {
  color: var(--text-tertiary);
  font-size: 12.5px;
  text-align: center;
  margin-top: var(--space-4);
}

.chat-input-row {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--line-hair);
}

.chat-input-row .wl-input {
  flex: 1;
  min-width: 0;
}

/* ---------------- 历史对局 */

.room-card--clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.room-card--clickable:hover {
  border-color: var(--accent);
  background: var(--surface-2);
}

.room-arrow {
  color: var(--text-tertiary);
  flex: none;
}

.history-time {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: auto;
  white-space: nowrap;
}

.history-ranking {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.rank-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.rank-chip strong {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.rank-chip .rank-no {
  width: auto;
  font-size: 11px;
  color: var(--accent);
  font-weight: 700;
}

.history-detail {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: var(--space-2);
  padding: var(--space-2);
}

.turn-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow-y: auto;
}

.turn-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
}

.turn-item:hover {
  background: var(--surface-2);
}

.turn-item--on {
  background: var(--accent-soft);
  font-weight: 600;
}

.turn-no {
  width: 18px;
  text-align: center;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.turn-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.turn-drawer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turn-word {
  font-size: 11.5px;
  color: var(--text-secondary);
}

.turn-round {
  font-size: 11px;
  color: var(--text-tertiary);
  flex: none;
}

.history-board {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  min-height: 0;
}

.history-board-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
}

.canvas-box--readonly {
  background: #ffffff;
}

.history-results {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.result-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-secondary);
}

.result-chip--guessed {
  background: rgba(48, 164, 108, 0.14);
  color: #1f7a4d;
}

.result-chip strong {
  font-variant-numeric: tabular-nums;
}

/* ---------------- 等人 / 结算 */

.phase-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.waiting-players {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin: var(--space-3) 0;
}

.result-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  min-width: 320px;
}

.result-panel h3 {
  margin: 0;
}

.ranking {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.ranking li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.ranking li.me {
  background: var(--accent-soft);
}

.rank-no {
  width: 22px;
  font-weight: 700;
  color: var(--text-tertiary);
}

.rank-name {
  flex: 1;
}

.rank-score {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
