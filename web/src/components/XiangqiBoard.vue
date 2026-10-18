<!--
  象棋棋盘（纯展示 + 交互）。

  这个组件只负责「把一块棋盘画对、把点击翻译成坐标」：
  它自己不发请求、不持有业务状态，落子合法性由服务端裁定，选子/改选/落子的
  判断统一交给父组件（GamesApp → games.clickSquare），避免两处各判一套、
  结果对不上。

  —— 坐标约定 ——
  棋盘 9 列 × 10 行。序列化字符串 10 行以 '/' 分隔，第 0 行是黑方底线（棋盘最上方），
  第 9 行是红方底线（最下方）。坐标名用「列字母 a-i（左到右）+ rank 0-9（从红方底线
  往上数）」，所以红帅初始在 e0、黑将初始在 e9，换算关系是 row = 9 - rank。

  整块棋盘用一张 SVG 画：线、九宫、河界、兵炮准星、棋子都在同一套 viewBox 坐标系
  （1 个单位 = 一格）里，靠 preserveAspectRatio 等比缩放，任何窗口尺寸下都不变形。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { GameColor } from '@/api'

const props = defineProps<{
  board: string
  mySide: GameColor | null
  turn: GameColor
  selected: string | null
  targets: string[]
  lastMove: { from: string; to: string } | null
  checkedSide: GameColor | null
  interactive: boolean
}>()

const emit = defineEmits<{
  (e: 'select', square: string): void
  (e: 'move', payload: { from: string; to: string }): void
}>()

// ---------------------------------------------------------------- 几何常量

/**
 * 棋盘的坐标基准。
 *
 * ⚠️ **网格不是从 0 开始的。** 9 列 × 10 行的交叉点落在
 * x = 0.5 … 8.5、y = 0.5 … 9.5（格距为 1，棋子画在交叉点上）。
 *
 * 这一点算错会让整个 viewBox 偏移半格，后果是**右侧多出一块没有木板的区域、
 * 底部一排棋子被裁掉**。线上真踩过：用户的原话是"右边棋盘背景颜色没对上，
 * 底部棋子没完全显示"。
 *
 * 所以下面所有尺寸都从**网格边界**推导，不再从 0 推导。
 */
const GRID_X0 = 0.5
const GRID_X1 = 8.5
const GRID_Y0 = 0.5
const GRID_Y1 = 9.5

/**
 * 网格四周的留白（单位 = 一格）。
 *
 * **必须大于棋子放大后的半径**，否则最外圈的棋子会被 viewBox 切掉一块。
 * 算一下最大情况：选中/悬停光圈 r = 0.5，而棋子被 hover 时还会 `scale(1.08)`
 * —— 0.5 × 1.08 = 0.54。取 0.7 留出余量，顺便让木质边框看起来像个正经框。
 *
 * （最初这里是 0.12，比棋子半径 0.44 还小 —— 边上的棋子必然溢出，
 *   这是"底部棋子没完全显示"的一半原因。）
 */
const PAD = 0.7

// ⚠️ 注释里**不写算出来的具体数字**。这里原来写着 "8 + 1 = 9"、"0 0 9 10"，
// 那是 PAD=0.5 时代的残留；后来 PAD 改成 0.7，代码自动跟着变、注释却留在原地，
// 反而把人引向"viewBox 从 0 开始"这个错误理解 —— 而那正是当初棋盘被裁的根因。
const BOARD_W = GRID_X1 - GRID_X0 + PAD * 2
const BOARD_H = GRID_Y1 - GRID_Y0 + PAD * 2
const VIEW_X = GRID_X0 - PAD
const VIEW_Y = GRID_Y0 - PAD
const VIEW_BOX = `${VIEW_X} ${VIEW_Y} ${BOARD_W} ${BOARD_H}`

/**
 * SVG 元素的宽高比。
 *
 * CSS 需要它来把**左右那两块留白消掉**：SVG 元素若被拉成容器的宽高，
 * `preserveAspectRatio="xMidYMid meet"` 就只能把棋盘居中、两边各留一条
 * 空白（实测 84px），而那条空白是透明的 —— 看起来就是"棋盘右边有一块
 * 颜色不对的地方"。让元素本身按比例定尺寸，留白就不存在了。
 */
const BOARD_RATIO = `${BOARD_W} / ${BOARD_H}`

/**
 * 所有线条坐标**一律从上面那组网格常量推导**，不再出现裸的 0.5 / 8.5。
 *
 * 理由很实际：这次出的两个 bug 都是"某个地方偷偷假设网格从 0 开始"。
 * 只要坐标只有一处来源，就不可能出现"线条对了、viewBox 错了"这种半对半错。
 */
/** 10 条横线的 y 坐标。 */
const H_LINE_Y = Array.from({ length: 10 }, (_, i) => GRID_Y0 + i)
/** a、i 两列贯通到底。 */
const V_FULL_X = [GRID_X0, GRID_X1]
/** b-h 七列在河界处断开（第 4、5 行之间不画）。 */
const V_BROKEN_X = Array.from({ length: 7 }, (_, i) => GRID_X0 + 1 + i)

/** 九宫两条对角线（红方 rank 0-2 与黑方 rank 7-9 的 d-f 列）。 */
const PALACE_LINES: Array<[number, number, number, number]> = [
  [GRID_X0 + 3, GRID_Y0, GRID_X0 + 5, GRID_Y0 + 2],
  [GRID_X0 + 5, GRID_Y0, GRID_X0 + 3, GRID_Y0 + 2],
  [GRID_X0 + 3, GRID_Y0 + 7, GRID_X0 + 5, GRID_Y0 + 9],
  [GRID_X0 + 5, GRID_Y0 + 7, GRID_X0 + 3, GRID_Y0 + 9],
]

/** 炮位与兵卒位的「十字准星」标记点。 */
const MARKERS: Array<{ x: number; y: number }> = []
for (const col of [1, 7]) {
  for (const row of [2, 7]) MARKERS.push({ x: GRID_X0 + col, y: GRID_Y0 + row })
}
for (const col of [0, 2, 4, 6, 8]) {
  for (const row of [3, 6]) MARKERS.push({ x: GRID_X0 + col, y: GRID_Y0 + row })
}

/** 河界文字基线的 y。 */
const RIVER_Y = 5.2

// ---------------------------------------------------------------- 坐标换算

const FLIPPED = computed(() => props.mySide === 'black')

function colLetter(col: number): string {
  return String.fromCharCode(97 + col)
}

/** 序列化行号 + 列号 → 坐标名，例如 (9, 4) → "e0"（红帅初始位）。 */
function squareName(row: number, col: number): string {
  return colLetter(col) + String(9 - row)
}

/** 把 board 字符串解析成 10 × 9 的字符矩阵，容错处理残缺输入。 */
const grid = computed<string[][]>(() => {
  const lines = props.board.split('/')
  const rows: string[][] = []
  for (let row = 0; row < 10; row++) {
    const line = lines[row] ?? ''
    const cells: string[] = []
    for (let col = 0; col < 9; col++) cells.push(line[col] ?? '.')
    rows.push(cells)
  }
  return rows
})

interface Square {
  /** 真实坐标，例如 "e0"。 */
  square: string
  /** 该格的棋子字母；空格为 '.'。 */
  piece: string
  /** 渲染位置（viewBox 单位），已按视角翻转。 */
  x: number
  y: number
}

/**
 * 渲染用格子列表（90 个）。
 *
 * 黑方视角时行、列都取反，让执黑的人看到自己的棋在下方。翻转只影响渲染位置：
 * `square` 始终是真实坐标，所以点击时不需要再换算一次。
 */
const squares = computed<Square[]>(() => {
  const list: Square[] = []
  for (let dr = 0; dr < 10; dr++) {
    for (let dc = 0; dc < 9; dc++) {
      const row = FLIPPED.value ? 9 - dr : dr
      const col = FLIPPED.value ? 8 - dc : dc
      list.push({
        square: squareName(row, col),
        piece: grid.value[row]?.[col] ?? '.',
        x: GRID_X0 + dc,
        y: GRID_Y0 + dr,
      })
    }
  }
  return list
})

const pieceSquares = computed(() => squares.value.filter((s) => s.piece !== '.'))

const targetSquares = computed(() => {
  const wanted = new Set(props.targets)
  return squares.value.filter((s) => wanted.has(s.square))
})

const lastMoveSquares = computed(() => {
  if (!props.lastMove) return []
  const wanted = new Set([props.lastMove.from, props.lastMove.to])
  return squares.value.filter((s) => wanted.has(s.square))
})

/** 被将军一方的帅/将所在格；从棋盘上直接找 K / k。 */
const checkSquare = computed<Square | null>(() => {
  if (!props.checkedSide) return null
  const king = props.checkedSide === 'red' ? 'K' : 'k'
  return squares.value.find((s) => s.piece === king) ?? null
})

// ---------------------------------------------------------------- 棋子名称

const RED_NAMES: Record<string, string> = {
  K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
}
const BLACK_NAMES: Record<string, string> = {
  K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒',
}

/** 大写是红方、小写是黑方。 */
function pieceName(piece: string): string {
  const upper = piece.toUpperCase()
  const table = piece === upper ? RED_NAMES : BLACK_NAMES
  return table[upper] ?? ''
}

function pieceSide(piece: string): GameColor {
  return piece === piece.toUpperCase() ? 'red' : 'black'
}

// ---------------------------------------------------------------- 走子反馈特效

/**
 * 走子反馈用的是**临时"飞行棋子"**，不是 FLIP。为什么这么选：
 *
 * 棋盘是用 `props.board` 这个序列化字符串整盘重画的，走子后 `from` 处的元素被
 * 卸载、`to` 处冒出一个**全新的**元素（key 是坐标）。FLIP 的前提是"同一个 DOM
 * 元素，走子前后各量一次位置再补动画" —— 而这里根本没有持续的同一个元素可量，
 * 在 keyed 列表里它已经死了，记录不到"之前的位置"。
 *
 * 飞行棋子则只认 `lastMove` 一个数据源：在 `from` 画一个临时棋子，用 CSS 把它
 * 平移到 `to`，同时让 `to` 处的真实棋子隐身，动画收尾时把整个特效组移除、真实
 * 棋子显形。整条链路不依赖 DOM 的身份，连点、反复走同一对格子、撤销重来都只是
 * "再放一次"，不会错位。
 *
 * 所有特效都 `pointer-events: none`，且棋子的点击热区是独立一层，动画期间照常点得到。
 */
interface MoveFx {
  /** 递增序号：既做 :key（连点同一对格子也能重放），也做一次性冲击波的 key。 */
  key: number
  moverName: string
  moverSide: GameColor
  /** 落点坐标名，用来把该格的"真实棋子"在动画期间隐身。 */
  to: string
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** 渲染坐标系下的位移（已含执黑翻转），供 CSS 平移使用。 */
  dx: number
  dy: number
  capturedPiece: string | null
  capturedName: string
  capturedSide: GameColor | null
}

const fx = ref<MoveFx | null>(null)
/** 每次走子自增：给"只用一次"的元素换 key，让每一次将军都能重放冲击波。 */
const moveSeq = ref(0)
let fxTimer: ReturnType<typeof setTimeout> | null = null

/** 特效计时上限，兜底清理（切后台时动画结束事件可能不来）。 */
const FX_CLEAR_MS = 700

/** 坐标名 → 渲染位置（viewBox 单位）；飞行棋子的起终点都从这里取。 */
const squarePos = computed(() => {
  const map = new Map<string, { x: number; y: number }>()
  for (const s of squares.value) map.set(s.square, { x: s.x, y: s.y })
  return map
})

/** 从**任意一份** board 字符串读某格棋子 —— 旧盘也要能读，用来找被吃的是哪个子。 */
function charAt(board: string, square: string): string {
  const col = square.charCodeAt(0) - 97
  const row = 9 - Number(square.slice(1))
  const line = board.split('/')[row] ?? ''
  return line[col] ?? '.'
}

/**
 * 是否开启了"减少动效"。
 * base.css 里的全局兜底只管 CSS 动画/过渡；这里特效是 JS 驱动的，
 * 必须自己判断一次，关掉动画的用户不该被晃。
 */
function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 收尾：停掉兜底计时器并清空特效（DOM 里不留任何临时元素）。 */
function clearFx(): void {
  if (fxTimer !== null) {
    clearTimeout(fxTimer)
    fxTimer = null
  }
  fx.value = null
}

/** 飞行棋子动画结束即收尾（计时器兜底，二者取先到者）。 */
function onFxEnd(event: AnimationEvent): void {
  const target = event.target as Element | null
  if (target && target.classList.contains('board__flight')) clearFx()
}

onBeforeUnmount(clearFx)

/** 吃子爆点：以落点为中心向外炸开的碎片，坐标在渲染坐标系里算好。 */
const captureShards = computed(() => {
  const f = fx.value
  if (!f || !f.capturedPiece) return []
  const shards: Array<{ id: number; x1: number; y1: number; x2: number; y2: number }> = []
  const count = 6
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count - Math.PI / 2
    shards.push({
      id: i,
      x1: round3(f.toX + Math.cos(angle) * 0.2),
      y1: round3(f.toY + Math.sin(angle) * 0.2),
      x2: round3(f.toX + Math.cos(angle) * 0.46),
      y2: round3(f.toY + Math.sin(angle) * 0.46),
    })
  }
  return shards
})

/** 飞行棋子的位移，交给 keyframes 里的 translate 用。 */
const fxStyle = computed<Record<string, string>>((): Record<string, string> => {
  const f = fx.value
  if (!f) return {}
  return { '--xq-fly-dx': `${f.dx}px`, '--xq-fly-dy': `${f.dy}px` }
})

/**
 * 盘面或上一手变了就重新评估。
 *
 * 同时观察 [board, lastMove] 的好处：回调能直接拿到**走子前**的盘面（旧值），
 * 不必自己维护快照 —— "被吃的是哪个子"正是要从旧盘的 to 格里读。
 *
 * 判定"是不是新的一手"要同时满足：lastMove 换了新对象、且 board 字符串确实变了。
 * 后者能挡掉 SSE 回声与断线重连重拉（同一手会被再写一遍）导致的重复动画。
 */
watch(
  () => [props.board, props.lastMove] as [string, { from: string; to: string } | null],
  ([board, last], prev) => {
    const [prevBoard, prevLast] = prev
    if (!last) {
      clearFx()
      return
    }
    if (last === prevLast || board === prevBoard) return
    // 起落点要自洽：旧盘 from 上站的子应恰好是新盘 to 上的那个，否则这不是"一手棋"
    // （例如切换房间时两张盘对不上），放动画只会错位。
    const mover = charAt(board, last.to)
    if (mover === '.' || charAt(prevBoard, last.from) !== mover) {
      clearFx()
      return
    }
    // 一次性元素换 key 用；无论最终是否播放都自增，冲击波才能每次将军都重放。
    moveSeq.value++
    if (reducedMotion()) {
      clearFx()
      return
    }
    const from = squarePos.value.get(last.from)
    const to = squarePos.value.get(last.to)
    if (!from || !to) return
    const captured = charAt(prevBoard, last.to)
    fx.value = {
      key: moveSeq.value,
      moverName: pieceName(mover),
      moverSide: pieceSide(mover),
      to: last.to,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      dx: round3(to.x - from.x),
      dy: round3(to.y - from.y),
      capturedPiece: captured === '.' ? null : captured,
      capturedName: captured === '.' ? '' : pieceName(captured),
      capturedSide: captured === '.' ? null : pieceSide(captured),
    }
    if (fxTimer !== null) clearTimeout(fxTimer)
    fxTimer = setTimeout(clearFx, FX_CLEAR_MS)
  },
)

// ---------------------------------------------------------------- 交互

function onSquareClick(square: Square): void {
  if (!props.interactive) return

  // 只有一种情况直接落子：已选中、且点到的是 targets 里的空格。
  // 其余（含「点对方棋子吃子」）一律 emit('select')，交给 store.clickSquare 统一判断，
  // 这样"该落子还是该改选"的逻辑只有一份。
  if (props.selected && square.piece === '.' && props.targets.includes(square.square)) {
    emit('move', { from: props.selected, to: square.square })
    return
  }
  emit('select', square.square)
}

/** 供读屏软件朗读的棋盘状态描述。 */
const ariaLabel = computed(() => {
  const side = (color: GameColor): string => (color === 'red' ? '红方' : '黑方')
  const parts = ['象棋棋盘']
  parts.push(props.mySide ? `你执${side(props.mySide)}` : '观战')
  if (props.checkedSide) parts.push(`${side(props.checkedSide)}被将军`)
  parts.push(`轮到${side(props.turn)}走`)
  return parts.join('，')
})

// ---------------------------------------------------------------- 棋盘线生成

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 兵/炮位的十字准星：在交叉点四角各画一个小 L 形，靠边的角省略。 */
function markerPath(x: number, y: number): string {
  const inset = 0.1
  const arm = 0.16
  let d = ''
  for (const dx of [-1, 1]) {
    if ((x === GRID_X0 && dx === -1) || (x === GRID_X1 && dx === 1)) continue
    for (const dy of [-1, 1]) {
      if ((y === GRID_Y0 && dy === -1) || (y === GRID_Y1 && dy === 1)) continue
      const px = round3(x + dx * inset)
      const py = round3(y + dy * inset)
      const ox = round3(x + dx * (inset + arm))
      const oy = round3(y + dy * (inset + arm))
      d += `M${px} ${oy}H${ox}V${py}`
    }
  }
  return d
}

const markerPathD = MARKERS.map((m) => markerPath(m.x, m.y)).join(' ')

/** 河界文字：黑方视角下整盘旋转 180°，两个词左右互换（字形保持正立便于阅读）。 */
const riverLabels = computed(() => [
  { text: FLIPPED.value ? '汉界' : '楚河', x: 2.5 },
  { text: FLIPPED.value ? '楚河' : '汉界', x: 6.5 },
])
</script>

<template>
  <div class="board" :class="{ 'board--locked': !interactive }">
    <svg
      class="board__svg"
      :viewBox="VIEW_BOX"
      preserveAspectRatio="xMidYMid meet"
      :style="{ aspectRatio: BOARD_RATIO }"
      role="img"
      :aria-label="ariaLabel"
    >
      <defs>
        <linearGradient id="xq-board-face" x1="0" y1="0" x2="0.65" y2="1">
          <stop offset="0" :style="{ stopColor: 'var(--xq-board-1)' }" />
          <stop offset="1" :style="{ stopColor: 'var(--xq-board-2)' }" />
        </linearGradient>
        <radialGradient id="xq-piece-face" cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" :style="{ stopColor: 'var(--xq-piece-1)' }" />
          <stop offset="0.62" :style="{ stopColor: 'var(--xq-piece-2)' }" />
          <stop offset="1" :style="{ stopColor: 'var(--xq-piece-3)' }" />
        </radialGradient>
      </defs>

      <!-- 木质底板：坐标与 viewBox 完全一致，这样四周的留白也是木色的 -->
      <rect
        class="board__wood"
        :x="VIEW_X"
        :y="VIEW_Y"
        :width="BOARD_W"
        :height="BOARD_H"
        rx="0.3"
      />

      <!-- 棋盘线。坐标一律引用常量，不写字面量 —— 见几何常量那一段的注释 -->
      <g class="board__grid">
        <line v-for="y in H_LINE_Y" :key="`h${y}`" :x1="GRID_X0" :y1="y" :x2="GRID_X1" :y2="y" />
        <line v-for="x in V_FULL_X" :key="`vf${x}`" :x1="x" :y1="GRID_Y0" :x2="x" :y2="GRID_Y1" />
        <template v-for="x in V_BROKEN_X" :key="`vb${x}`">
          <line :x1="x" :y1="GRID_Y0" :x2="x" :y2="GRID_Y0 + 4" />
          <line :x1="x" :y1="GRID_Y0 + 5" :x2="x" :y2="GRID_Y1" />
        </template>
        <line
          v-for="(p, i) in PALACE_LINES"
          :key="`pal${i}`"
          :x1="p[0]"
          :y1="p[1]"
          :x2="p[2]"
          :y2="p[3]"
        />
      </g>

      <!-- 兵/炮位准星 -->
      <path class="board__marker" :d="markerPathD" />

      <!-- 楚河 · 汉界 -->
      <g class="board__river">
        <text
          v-for="(label, i) in riverLabels"
          :key="`river${i}`"
          :x="label.x"
          :y="RIVER_Y"
          text-anchor="middle"
        >
          {{ label.text }}
        </text>
      </g>

      <!-- 上一步 -->
      <g class="board__last">
        <rect
          v-for="s in lastMoveSquares"
          :key="`lm${s.square}`"
          :x="s.x - 0.44"
          :y="s.y - 0.44"
          width="0.88"
          height="0.88"
          rx="0.12"
        />
      </g>

      <!-- 将军：整盘一闪（一次性，key 随走子换、每次将军都重放） -->
      <template v-if="checkSquare">
        <rect
          :key="`cb${moveSeq}`"
          class="board__check-flash"
          :x="VIEW_X"
          :y="VIEW_Y"
          :width="BOARD_W"
          :height="BOARD_H"
          rx="0.3"
        />
        <circle class="board__check-glow" :cx="checkSquare.x" :cy="checkSquare.y" r="0.5" />
        <circle class="board__check-ring" :cx="checkSquare.x" :cy="checkSquare.y" r="0.47" />
      </template>

      <!-- 可落子提示 -->
      <g class="board__targets">
        <template v-for="s in targetSquares" :key="`t${s.square}`">
          <circle v-if="s.piece === '.'" class="board__target-dot" :cx="s.x" :cy="s.y" r="0.13" />
          <circle v-else class="board__target-ring" :cx="s.x" :cy="s.y" r="0.4" />
        </template>
      </g>

      <!-- 棋子 -->
      <g
        v-for="s in pieceSquares"
        :key="`pc${s.square}`"
        class="board__piece"
        :class="[
          `board__piece--${pieceSide(s.piece)}`,
          {
            'board__piece--selected': s.square === selected,
            // 飞行动画期间，落点上的真实棋子先隐身，避免和飞行棋子重影；
            // 只影响视觉，热区仍是独立一层，照常可点。
            'board__piece--hidden': fx !== null && s.square === fx.to,
          },
        ]"
      >
        <circle class="board__piece-select" :cx="s.x" :cy="s.y" r="0.5" />
        <circle :cx="s.x" :cy="s.y" r="0.44" fill="url(#xq-piece-face)" />
        <circle class="board__piece-ring" :cx="s.x" :cy="s.y" r="0.44" />
        <circle class="board__piece-ring board__piece-ring--inner" :cx="s.x" :cy="s.y" r="0.38" />
        <text
          class="board__piece-text"
          :x="s.x"
          :y="s.y"
          text-anchor="middle"
          dominant-baseline="central"
        >
          {{ pieceName(s.piece) }}
        </text>
      </g>

      <!--
        走子反馈：飞行棋子 / 落点涟漪 / 吃子爆点。
        全是临时元素，动画收尾即整组移除（onFxEnd + 计时器兜底），不留 DOM。
      -->
      <g
        v-if="fx"
        :key="`fx${fx.key}`"
        class="board__fx"
        aria-hidden="true"
        @animationend="onFxEnd"
      >
        <!-- 落点涟漪：棋子落地时目标格扩散一圈 -->
        <circle class="board__ripple" :cx="fx.toX" :cy="fx.toY" r="0.3" />

        <!-- 吃子爆点：被吃的子炸成几片向外飞散 -->
        <g v-if="fx.capturedPiece" class="board__capture">
          <circle class="board__capture-flash" :cx="fx.toX" :cy="fx.toY" r="0.18" />
          <line
            v-for="shard in captureShards"
            :key="`shard${shard.id}`"
            :x1="shard.x1"
            :y1="shard.y1"
            :x2="shard.x2"
            :y2="shard.y2"
          />
          <text
            class="board__capture-glyph"
            :class="`board__capture-glyph--${fx.capturedSide}`"
            :x="fx.toX"
            :y="fx.toY"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {{ fx.capturedName }}
          </text>
        </g>

        <!-- 飞行棋子：从 from 平移到 to -->
        <g class="board__flight" :class="`board__piece--${fx.moverSide}`" :style="fxStyle">
          <circle :cx="fx.fromX" :cy="fx.fromY" r="0.44" fill="url(#xq-piece-face)" />
          <circle class="board__piece-ring" :cx="fx.fromX" :cy="fx.fromY" r="0.44" />
          <circle
            class="board__piece-ring board__piece-ring--inner"
            :cx="fx.fromX"
            :cy="fx.fromY"
            r="0.38"
          />
          <text
            class="board__piece-text"
            :x="fx.fromX"
            :y="fx.fromY"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {{ fx.moverName }}
          </text>
        </g>
      </g>

      <!-- 将军冲击环：画在棋子之上确保看得见；一次性，key 随走子换 -->
      <circle
        v-if="checkSquare"
        :key="`shock${moveSeq}`"
        class="board__check-shock"
        :cx="checkSquare.x"
        :cy="checkSquare.y"
        r="0.3"
      />

      <!-- 点击热区：放在最上层，保证任意位置都点得到 -->
      <g class="board__hits">
        <rect
          v-for="s in squares"
          :key="`hit${s.square}`"
          class="board__hit"
          :x="s.x - 0.47"
          :y="s.y - 0.47"
          width="0.94"
          height="0.94"
          @click="onSquareClick(s)"
        />
      </g>
    </svg>
  </div>
</template>

<style scoped>
/*
  棋盘配色例外说明：
  棋盘是「实体物件」的模拟，不应该跟着界面主题变色 —— 深色主题下一块浅木色棋盘
  看起来才是对的，跟着变黑反而怪。所以下面这些木头色/棋子色是固定的，集中写在
  根元素的 CSS 变量里方便将来统一调整。
  界面自身的强调色（选中高亮、可落子点、将军提示）仍然用主题变量（--accent / --danger），
  让棋盘与外壳保持一致。
*/
.board {
  /* —— 棋盘固定配色（不随主题变化）—— */
  --xq-board-1: #f3ddb0; /* 棋盘木色 · 亮 */
  --xq-board-2: #e2c68b; /* 棋盘木色 · 暗 */
  --xq-board-edge: #b8894f; /* 棋盘边框描边 */
  --xq-line: #6d4a24; /* 棋盘线：深棕墨色 */
  --xq-river: #7c5a2e; /* 河界文字 */
  --xq-piece-1: #fdf4de; /* 棋子面 · 高光 */
  --xq-piece-2: #f5e3bd; /* 棋子面 · 中间 */
  --xq-piece-3: #e7cf9e; /* 棋子面 · 边缘 */
  --xq-red: #b3271e; /* 红方字与圈 */
  --xq-black: #23201b; /* 黑方字与圈 */
  --xq-last-move: rgba(196, 140, 30, 0.42); /* 上一步高亮 */
  /* 反馈特效配色：棋盘是固定木色的实体，这几个色也跟着固定，深浅主题下都看得清 */
  --xq-ripple: rgba(255, 214, 130, 0.95); /* 落点涟漪 */
  --xq-capture: #ff7a45; /* 吃子爆点（暖橙，压在木色上醒目） */

  display: flex;
  flex-direction: column;
  /*
   * ⚠️ 这里的三个属性合起来解决两个互相牵扯的问题，别单独删任何一个。
   *
   * 1. **宽度必须确定**。这个元素是 .board-col（flex 行容器）里的 flex 项，
   *    不给宽度的话它由内容决定，而内容是 SVG —— 循环依赖，
   *    浏览器只能回退到 SVG 的默认 300×150，棋盘缩成一小块。
   *
   * 2. **必须有 align-items: center**。SVG 靠 aspect-ratio 把宽度从高度推出来，
   *    而 flex 默认的 `align-items: stretch` 会**覆盖**这个宽度、把元素横向拉满 ——
   *    那样 preserveAspectRatio="xMidYMid meet" 就只能把棋盘居中、
   *    两边各留一条透明空白（实测 84px）。那就是用户说的
   *    "右边棋盘背景颜色没对上"。
   */
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  align-items: center;
  justify-content: center;

  padding: var(--space-4);
}

.board--locked {
  cursor: not-allowed;
}

.board__svg {
  /*
   * 高度撑满可用空间，**宽度由 aspect-ratio 从高度推出来** ——
   * 这样元素盒子正好是棋盘的形状，不会出现"棋盘居中、两边各留一条透明空白"。
   *
   * `width: auto` 是关键：写成 100% 就等于把元素拉满，aspect-ratio 也就没用了，
   * 又回到 letterbox 那条老路。
   * `max-width: 100%` 是窗口又窄又高时的兜底 —— 那时宽度会顶到上限，
   * 交给 preserveAspectRatio 处理（只在这一个方向才会出现少量留白）。
   */
  flex: 1 1 auto;
  height: 100%;
  width: auto;
  max-width: 100%;
  min-height: 0;
  min-width: 0;
  display: block;
}

/* ---------------------------------------------------------------- 底板 */

.board__wood {
  fill: url(#xq-board-face);
  stroke: var(--xq-board-edge);
  stroke-width: 0.05;
}

/* ---------------------------------------------------------------- 棋盘线 */

.board__grid line,
.board__marker {
  stroke: var(--xq-line);
  stroke-width: 0.028; /* ≈1.4px（棋盘约 450px 宽时），线随棋盘等比缩放 */
  stroke-linecap: round;
}

.board__marker {
  fill: none;
  opacity: 0.85;
}

.board__river text {
  fill: var(--xq-river);
  font-family: 'Songti SC', 'SimSun', 'STSong', serif;
  font-size: 0.56px;
  letter-spacing: 0.16px;
  opacity: 0.92;
}

/* ---------------------------------------------------------------- 上一步 */

.board__last rect {
  fill: var(--xq-last-move);
}

/* ---------------------------------------------------------------- 将军 */

.board__check-glow {
  fill: var(--danger);
  transform-box: fill-box;
  transform-origin: center;
  animation: xq-check-pulse 1.15s var(--ease-out) infinite;
}

.board__check-ring {
  fill: none;
  stroke: var(--danger);
  stroke-width: 0.06;
  opacity: 0.9;
}

@keyframes xq-check-pulse {
  0% {
    transform: scale(0.82);
    opacity: 0.6;
  }
  70% {
    transform: scale(1.32);
    opacity: 0;
  }
  100% {
    transform: scale(1.32);
    opacity: 0;
  }
}

/*
 * 整盘一闪：将军是这盘棋情绪最高的时刻，光靠一颗棋子的脉冲不够。
 * 低透明的 danger 铺满整盘、快速淡出 —— 画在棋子**之下**，所以不会盖住棋子；
 * 又是 pointer-events: none，点击不受影响。
 */
.board__check-flash {
  fill: var(--danger);
  opacity: 0;
  pointer-events: none;
  animation: xq-check-flash 0.5s var(--ease-out) forwards;
}

@keyframes xq-check-flash {
  0% {
    opacity: 0;
  }
  16% {
    opacity: 0.18;
  }
  100% {
    opacity: 0;
  }
}

/* 冲击环：从被将的将/帅处向外炸开一圈，一次性 */
.board__check-shock {
  fill: none;
  stroke: var(--danger);
  stroke-width: 0.07;
  pointer-events: none;
  transform-box: fill-box;
  transform-origin: center;
  animation: xq-check-shock 0.62s var(--ease-out) forwards;
}

@keyframes xq-check-shock {
  0% {
    transform: scale(0.55);
    opacity: 0.95;
  }
  100% {
    transform: scale(2.8);
    opacity: 0;
  }
}

/* ---------------------------------------------------------------- 走子特效 */

/* 一律不参与命中测试：既有的 90 个热区始终在最上层，动画挡不住任何点击 */
.board__fx,
.board__ripple,
.board__capture,
.board__capture-flash,
.board__capture-glyph,
.board__flight {
  pointer-events: none;
}

/* 飞行棋子隐身它的"落点真身"，避免重影（视觉层，不影响热区） */
.board__piece--hidden {
  opacity: 0;
}

/* 落点涟漪 */
.board__ripple {
  fill: none;
  stroke: var(--xq-ripple);
  stroke-width: 0.06;
  transform-box: fill-box;
  transform-origin: center;
  animation: xq-ripple 0.42s var(--ease-out) forwards;
}

@keyframes xq-ripple {
  0% {
    transform: scale(0.4);
    opacity: 0.9;
  }
  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}

/* 吃子爆点 */
.board__capture {
  transform-box: fill-box;
  transform-origin: center;
  animation: xq-burst 0.4s var(--ease-out) forwards;
}

.board__capture line {
  stroke: var(--xq-capture);
  stroke-width: 0.05;
  stroke-linecap: round;
}

.board__capture-flash {
  fill: var(--xq-capture);
  opacity: 0.9;
}

.board__capture-glyph {
  font-family: 'Songti SC', 'SimSun', 'STSong', serif;
  font-size: 0.42px;
  font-weight: 700;
}

.board__capture-glyph--red {
  fill: var(--xq-red);
}

.board__capture-glyph--black {
  fill: var(--xq-black);
}

@keyframes xq-burst {
  0% {
    transform: scale(0.55);
    opacity: 1;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

/* 飞行棋子：起跳略微放大、落点回正，读起来像"被拎起来送到对面" */
.board__flight {
  transform-box: fill-box;
  transform-origin: center;
  animation: xq-fly 0.36s var(--ease-spring) forwards;
}

@keyframes xq-fly {
  0% {
    transform: translate(0, 0) scale(1);
  }
  25% {
    transform: translate(calc(var(--xq-fly-dx) * 0.25), calc(var(--xq-fly-dy) * 0.25))
      scale(1.12);
  }
  100% {
    transform: translate(var(--xq-fly-dx), var(--xq-fly-dy)) scale(1);
  }
}

/* ---------------------------------------------------------------- 落子提示 */

.board__target-dot {
  fill: var(--accent);
  opacity: 0.55;
}

.board__target-ring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 0.055;
  opacity: 0.85;
}

/* ---------------------------------------------------------------- 棋子 */

.board__piece {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform var(--dur) var(--ease-out);
}

.board__piece--selected {
  transform: scale(1.08);
}

/* 选中时的一圈强调色高亮（默认透明，选中才显形） */
.board__piece-select {
  fill: none;
  stroke: var(--accent);
  stroke-width: 0.05;
  opacity: 0;
  transition: opacity var(--dur) var(--ease-out);
}

.board__piece--selected .board__piece-select {
  opacity: 1;
}

.board__piece-ring {
  fill: none;
  stroke-width: 0.045;
}

.board__piece-ring--inner {
  stroke-width: 0.018;
  opacity: 0.65;
}

.board__piece--red .board__piece-ring {
  stroke: var(--xq-red);
}

.board__piece--black .board__piece-ring {
  stroke: var(--xq-black);
}

.board__piece-text {
  font-family: 'Songti SC', 'SimSun', 'STSong', serif;
  font-size: 0.46px; /* ≈棋子直径的 52% */
  font-weight: 700;
}

.board__piece--red .board__piece-text {
  fill: var(--xq-red);
}

.board__piece--black .board__piece-text {
  fill: var(--xq-black);
}

/* ---------------------------------------------------------------- 热区 */

.board__hit {
  fill: transparent;
  cursor: pointer;
}

.board--locked .board__hit {
  cursor: not-allowed;
}
</style>
