<!--
  象棋大厅 + 对局界面。

  设计要点：
  - 一个本地 ref `view` 在大厅与对局之间切换；对局是否存在以 store 的 `room` 为准。
  - 所有对局状态都来自 useGames store —— 棋盘交互（点击、落子）也由 store 的
    clickSquare / makeMove 统一处理，本组件只负责布局、文案与把 props 传对。
  - 实时性由 store 内部通过共享 SSE 连接处理；本组件只读 games.connected 来提示断线。
  - 布局用 ResizeObserver 判断"窄窗口"（<820px），而不是媒体查询 ——
    应用渲染在桌面窗口里，视口宽度并不等于窗口宽度。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import XiangqiBoard from '@/components/XiangqiBoard.vue'
import { useGames } from '@/stores/games'
import { useUi } from '@/stores/ui'
import { formatTime } from '@/api'
import type { GameBotLevel, GameColor, GameMove, GameRoom, GameStatus } from '@/api'
import * as sfx from '@/lib/sfx'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const games = useGames()
const ui = useUi()

type View = 'lobby' | 'room'
const view = ref<View>('lobby')

/** 根元素：既用于窄窗口测量，也作为弹层的定位上下文。 */
const rootEl = ref<HTMLElement | null>(null)
const narrow = ref(false)
let observer: ResizeObserver | null = null

const room = computed<GameRoom | null>(() => games.room)

/** 棋盘 props：单独抽出来给非空默认值，避免模板里对 room 做非空断言。 */
const board = computed<string>(() => games.room?.board ?? '')
const mySide = computed<GameColor | null>(() => games.room?.mySide ?? null)
const turn = computed<GameColor>(() => games.room?.turn ?? 'red')

// ---------------------------------------------------------------- "轮到你了"

/**
 * 对方走完、轮到我时的一次性提示。
 *
 * 只在"没轮到我 → 轮到我"这个**跳变**上触发：自己走完一步后状态重算也会经过
 * myTurn，但那不是"该你了"的时刻，不该闪。窗口级提示，纯装饰、
 * pointer-events: none，放在棋盘上方居中，低头看手机的人抬头就能看见。
 * 计时器到点自己收掉，绝不留下常驻的 DOM。
 */
const myTurnFlash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => games.myTurn,
  (now, before) => {
    if (!now || before) return
    const current = games.room
    if (!current || current.status !== 'playing' || current.mySide === null) return
    myTurnFlash.value = true
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      myTurnFlash.value = false
      flashTimer = null
    }, 2600)
  },
)

// ---------------------------------------------------------------- 弹层状态

const showCreate = ref(false)
const showJoin = ref(false)
const joinTarget = ref<GameRoom | null>(null)
const createTitle = ref('')
const createSide = ref<GameColor>('red')
const busy = ref(false)
const localError = ref<string | null>(null)

// ---------------------------------------------------------------- 分组与文案

interface RoomGroup {
  key: string
  label: string
  rooms: GameRoom[]
}

const groups = computed<RoomGroup[]>(() =>
  [
    { key: 'waiting', label: '等待加入', rooms: games.waitingRooms },
    { key: 'playing', label: '对局中', rooms: games.playingRooms },
    { key: 'finished', label: '已结束', rooms: games.finishedRooms },
  ].filter((group) => group.rooms.length > 0),
)

const hasRooms = computed<boolean>(() => games.rooms.length > 0)

const statsText = computed<string>(() => {
  const stats = games.stats
  if (!stats) return '暂无战绩'
  return `已下 ${stats.played} 局 · 胜 ${stats.won} · 负 ${stats.lost}`
})

function statusLabel(status?: GameStatus): string {
  if (status === 'waiting') return '等待加入'
  if (status === 'playing') return '对局中'
  if (status === 'finished') return '已结束'
  return ''
}

function statusClass(status?: GameStatus): string {
  if (status === 'waiting') return 'wl-badge--accent'
  if (status === 'playing') return 'wl-badge--success'
  return ''
}

function groupIcon(key: string): string {
  if (key === 'waiting') return 'clock'
  if (key === 'playing') return 'eye'
  return 'check'
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'checkmate':
      return '将死'
    case 'stalemate':
      return '困毙（无棋可走判负）'
    case 'resign':
      return '认输'
    case 'timeout':
      return '超时'
    case 'abandon':
      return '对手离开'
    case 'no-legal-moves':
      return '无棋可走'
    default:
      return reason
  }
}

const resultText = computed<string>(() => {
  const current = room.value
  if (!current || current.status !== 'finished' || !current.result) return ''
  const winner = current.result.winner
  if (winner === 'red') return '红方获胜'
  if (winner === 'black') return '黑方获胜'
  return '和棋'
})

/** 结果标题：将死且认出了杀法时直接报杀法名 ——「绝杀 · 卧槽马」。 */
const resultHeadline = computed<string>(() => {
  const current = room.value
  if (!current || !current.result) return ''
  const m = current.result.mate
  if (m && current.result.reason === 'checkmate') return `绝杀 · ${m.name}`
  return resultText.value
})

const resultReason = computed<string>(() => {
  const result = room.value?.result
  return result ? reasonLabel(result.reason) : ''
})

const turnText = computed<string>(() => {
  const current = room.value
  if (!current || current.status !== 'playing') return ''
  if (games.myTurn) return '轮到你走'
  // 人机对战：对面是电脑时别写"轮到黑方走"，直接说它在想 —— 用户要的是这个信息
  if (current.botThinking) return '电脑正在思考…'
  return current.turn === 'red' ? '轮到红方走' : '轮到黑方走'
})

const mySideText = computed<string>(() => {
  const side = room.value?.mySide
  if (side === 'red') return '红'
  if (side === 'black') return '黑'
  return ''
})

// ---------------------------------------------------------------- 棋子与走子文案

/** [红方名, 黑方名]；字母大小写决定颜色（大写红、小写黑）。 */
const PIECE_NAMES: Record<string, readonly [string, string]> = {
  K: ['帅', '将'],
  A: ['仕', '士'],
  B: ['相', '象'],
  N: ['马', '马'],
  R: ['车', '车'],
  C: ['炮', '炮'],
  P: ['兵', '卒'],
}

function pieceLabel(ch: string): string {
  const pair = PIECE_NAMES[ch.toUpperCase()]
  if (!pair) return ch
  return ch === ch.toUpperCase() ? pair[0] : pair[1]
}

function sideLabel(color: GameColor): string {
  return color === 'red' ? '红' : '黑'
}

function moveText(move: GameMove): string {
  return `${pieceLabel(move.piece)} ${move.from}→${move.to}`
}

function initial(name: string | null): string {
  if (!name) return '空'
  const trimmed = name.trim()
  return trimmed ? trimmed.charAt(0) : '空'
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------- 大厅动作

function onRefresh(): void {
  void games.loadRooms()
}

// ---------------------------------------------------------------- 人机对战

/**
 * 三个难度档。文案里刻意说清"它下得怎么样"而不是"它的搜索深度"——
 * 用户关心的是"我下得过它吗"，不是引擎参数。
 */
const BOT_LEVELS: Array<{ key: GameBotLevel; label: string; hint: string }> = [
  { key: 'easy', label: '简单', hint: '会走漏着，刚学棋也能赢' },
  { key: 'normal', label: '普通', hint: '算得比较认真，能跟你来回下' },
  { key: 'hard', label: '困难', hint: '每步想一想，不太好赢' },
]

const showBot = ref(false)
const botLevel = ref<GameBotLevel>('normal')
const botSide = ref<GameColor>('red')

function openBot(): void {
  localError.value = null
  showBot.value = true
}

function closeBot(): void {
  if (!busy.value) showBot.value = false
}

async function doStartBot(): Promise<void> {
  if (busy.value) return
  busy.value = true
  localError.value = null
  try {
    await games.startBotGame({ level: botLevel.value, side: botSide.value })
    showBot.value = false
    view.value = 'room'
  } catch (err) {
    localError.value = errText(err)
  } finally {
    busy.value = false
  }
}

function onStartBot(): void {
  void doStartBot()
}

/**
 * 音效开关（持久化在 localStorage，见 lib/sfx）。
 *
 * 用 computed 读全局状态而不是自己存一个 ref：设置页里也有一个总闸，
 * 两处各存一份必然漂移 —— 在设置里静音了，棋盘上那个喇叭还亮着。
 */
const soundOn = computed(() => !sfx.soundState.muted)
function toggleSound(): void {
  sfx.toggleMuted()
}

/** 这一局是不是人机对战。 */
const isBotRoom = computed<boolean>(() => room.value?.botSide === 'red' || room.value?.botSide === 'black')

/** 将死时识别出的杀法（「绝杀 · 卧槽马」）。 */
const mate = computed(() => room.value?.result?.mate ?? null)

/** 电脑坐在哪一边（用于文案"电脑执黑"）。 */
const botSideText = computed<string>(() => {
  const side = room.value?.botSide
  if (side === 'red') return '红'
  if (side === 'black') return '黑'
  return ''
})

function dismissError(): void {
  games.error = null
}

function openCreate(): void {
  localError.value = null
  createTitle.value = ''
  createSide.value = 'red'
  showCreate.value = true
}

function closeCreate(): void {
  if (!busy.value) showCreate.value = false
}

async function doCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  localError.value = null
  try {
    const title = createTitle.value.trim()
    await games.createRoom({ title: title || undefined, side: createSide.value })
    showCreate.value = false
    view.value = 'room'
  } catch (err) {
    localError.value = errText(err)
  } finally {
    busy.value = false
  }
}

function onCreate(): void {
  void doCreate()
}

function hasEmptySeat(target: GameRoom): boolean {
  return target.redPlayer === null || target.blackPlayer === null
}

function actionLabel(target: GameRoom): string {
  if (target.status === 'waiting' && hasEmptySeat(target)) return '加入'
  if (target.status === 'finished') return '查看'
  return '观战'
}

function openJoin(target: GameRoom): void {
  localError.value = null
  joinTarget.value = target
  showJoin.value = true
}

function closeJoin(): void {
  if (!busy.value) showJoin.value = false
}

const joinRedTaken = computed<boolean>(() => joinTarget.value?.redPlayer != null)
const joinBlackTaken = computed<boolean>(() => joinTarget.value?.blackPlayer != null)

async function doJoin(side: GameColor): Promise<void> {
  const target = joinTarget.value
  if (!target || busy.value) return
  busy.value = true
  localError.value = null
  try {
    await games.joinRoom(target.id, side)
    showJoin.value = false
    view.value = 'room'
  } catch (err) {
    localError.value = errText(err)
  } finally {
    busy.value = false
  }
}

function onJoin(side: GameColor): void {
  void doJoin(side)
}

async function openRoom(target: GameRoom): Promise<void> {
  localError.value = null
  try {
    await games.openRoom(target.id)
    view.value = 'room'
  } catch (err) {
    localError.value = errText(err)
  }
}

function onCardClick(target: GameRoom): void {
  void openRoom(target)
}

function onRoomAction(target: GameRoom): void {
  if (target.status === 'waiting' && hasEmptySeat(target)) {
    openJoin(target)
  } else {
    void openRoom(target)
  }
}

function backToLobby(): void {
  games.clearSelection()
  view.value = 'lobby'
}

// ---------------------------------------------------------------- 对局动作

function onSelect(square: string): void {
  void games.clickSquare(square)
}

function onMove(payload: { from: string; to: string }): void {
  void games.makeMove(payload.from, payload.to)
}

async function doResign(): Promise<void> {
  if (!room.value) return
  if (!window.confirm('确定认输吗？本局将判负。')) return
  try {
    await games.resign()
  } catch (err) {
    ui.notify('error', '认输失败', errText(err))
  }
}

function onResign(): void {
  void doResign()
}

async function doLeave(): Promise<void> {
  const current = room.value
  if (current && current.status === 'playing' && current.mySide !== null) {
    if (!window.confirm('对局尚未结束，退出将判负。确定退出吗？')) return
  }
  try {
    if (current) await games.leaveRoom(current.id)
  } catch (err) {
    ui.notify('error', '退出房间失败', errText(err))
  } finally {
    games.clearSelection()
    view.value = 'lobby'
  }
}

function onLeave(): void {
  void doLeave()
}

async function rematch(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const side = room.value?.mySide ?? undefined
    await games.createRoom({ side })
    view.value = 'room'
  } catch (err) {
    ui.notify('error', '创建对局失败', errText(err))
  } finally {
    busy.value = false
  }
}

function onRematch(): void {
  void rematch()
}

async function copyRoomInfo(): Promise<void> {
  const current = room.value
  if (!current) return
  const text = `${current.title}（房间号 ${current.id}）`
  try {
    await navigator.clipboard.writeText(text)
    ui.notify('success', '已复制房间信息', text)
  } catch {
    ui.notify('error', '复制失败', `请手动复制房间号：${current.id}`)
  }
}

function onCopy(): void {
  void copyRoomInfo()
}

// ---------------------------------------------------------------- 电脑"思考"看门狗

/**
 * 界面侧的兜底：显示"电脑正在思考…"超过一定时间就重新拉一次房间。
 *
 * 服务端那边已经有两道保险（落子失败自动兜底、拉房间时自愈），但那两道都要求
 * 有"一次请求"或"一次定时器"去触发。真正难缠的情况是**客户端根本没收到**机器人
 * 那一手的推送 —— 断线重连丢了事件、代理把 SSE 缓冲住了、或者标签页被挂起过。
 * 那时服务端其实早就走完了，只有这一端还停在"思考中"，而且它自己不会好。
 *
 * 所以这里给一个纯客户端的看门狗：等太久就主动问一次服务端"现在什么局面"。
 * 顺序上只做两件事 —— 重新拉房间、实在还卡着就把状态亮出来让人知道点哪里。
 */
/** 等多久算"不对劲"。困难档最慢约 1.2 秒搜索 + 0.5 秒停顿，6 秒足够宽。 */
const BOT_STALL_MS = 6000
/** 最多自动重试几次，超过就不再骚扰服务端，改为提示用户。 */
const BOT_STALL_RETRIES = 3

const botStalled = ref(false)
let stallTimer: ReturnType<typeof setTimeout> | null = null
let stallChecks = 0

function stopStallTimer(): void {
  if (stallTimer !== null) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

function armStallTimer(): void {
  stopStallTimer()
  const current = games.room
  if (!current || current.status !== 'playing' || !current.botThinking) return
  stallTimer = setTimeout(onStallTick, BOT_STALL_MS)
}

async function onStallTick(): Promise<void> {
  const current = games.room
  if (!current || current.status !== 'playing' || !current.botThinking) {
    stopStallTimer()
    return
  }
  stallChecks++
  // 重新拉一次：服务端看到"该它走却太久没动"会自己补一手
  try {
    await games.openRoom(current.id)
  } catch {
    // 拉不到就等下一轮，不要在这里弹错误
  }
  const after = games.room
  if (after && after.status === 'playing' && after.botThinking && stallChecks < BOT_STALL_RETRIES) {
    armStallTimer()
    return
  }
  if (after && after.status === 'playing' && after.botThinking) botStalled.value = true
  else botStalled.value = false
}

/** 手动重试：清掉提示，立刻再拉一次。 */
async function retryBotTurn(): Promise<void> {
  const current = games.room
  if (!current) return
  botStalled.value = false
  stallChecks = 0
  try {
    await games.openRoom(current.id)
  } catch {
    // 忽略
  }
  armStallTimer()
}

// 只在"是否轮到电脑"这个布尔值跳变时重新计时 —— 每一步棋都会让它 false→true，
// 而普通的局面刷新（同一步被推送两遍）不会重置，避免把异常状态一直盖住。
watch(
  () => games.room?.botThinking === true && games.room?.status === 'playing',
  (thinking) => {
    stallChecks = 0
    botStalled.value = false
    if (thinking) armStallTimer()
    else stopStallTimer()
  },
)

// 只要有新的一手落下来，就说明对面在动 —— 计数与提示一起清掉
watch(
  () => games.room?.moves.length ?? 0,
  () => {
    stallChecks = 0
    botStalled.value = false
    armStallTimer()
  },
)

// ---------------------------------------------------------------- 生命周期

onMounted(async () => {
  games.connectRealtime()
  try {
    await games.loadRooms()
  } catch {
    // 错误已记入 games.error，界面会展示
  }

  const roomId = props.win.args.roomId
  if (typeof roomId === 'string' && roomId) {
    try {
      await games.openRoom(roomId)
      view.value = 'room'
    } catch {
      // 同上
    }
  }

  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) narrow.value = entry.contentRect.width < 820
    })
    observer.observe(rootEl.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null

  stopStallTimer()

  if (flashTimer !== null) {
    clearTimeout(flashTimer)
    flashTimer = null
  }

  /**
   * 关掉窗口时，如果我只是**开了个房间在等人**，就把它退掉。
   *
   * 为什么必须做：关窗口不会触发任何 leave 调用，于是房间带着我的座位一直挂在
   * 大厅里，而那个座位别人也坐不了 —— 线上真堆了一排这样的房间。
   *
   * ⚠️ 正在下棋时**不退**。关窗口不等于认输：人可能只是误关、或者想换个窗口再看，
   * 服务端自己也只清理"等待中"的房间。对局中的房间留着，回来还能接着下。
   */
  const room = games.room
  if (room && room.status === 'waiting' && room.mySide !== null) {
    void games.leaveRoom(room.id)
  }
})
</script>

<template>
  <div ref="rootEl" class="games">
    <!-- ===================================================== 大厅 -->
    <template v-if="view === 'lobby'">
      <header class="bar">
        <div class="bar-title"><Icon name="grid" :size="18" />象棋</div>
        <span class="stats">{{ statsText }}</span>
        <div class="spacer" />
        <button class="wl-btn" title="和电脑下一盘" @click="openBot">
          <Icon name="cpu" :size="16" />人机对战
        </button>
        <button class="wl-btn wl-btn--primary" @click="openCreate">
          <Icon name="plus" :size="16" />新建对局
        </button>
        <button class="wl-icon-btn" :disabled="games.loading" title="刷新" @click="onRefresh">
          <Icon name="refresh" :size="16" :class="{ spin: games.loading }" />
        </button>
      </header>

      <div class="lobby-body wl-scroll">
        <div v-if="games.error && hasRooms" class="banner banner--error">
          <Icon name="alert" :size="16" />
          <span class="banner-text">{{ games.error }}</span>
          <button class="wl-btn wl-btn--ghost" @click="dismissError">关闭</button>
        </div>

        <div v-if="!hasRooms && games.loading" class="wl-empty">
          <span class="wl-spinner" />
          <span>正在加载对局列表…</span>
        </div>

        <div v-else-if="!hasRooms && games.error" class="wl-empty">
          <Icon name="alert" :size="32" />
          <span>{{ games.error }}</span>
          <button class="wl-btn" @click="onRefresh"><Icon name="refresh" :size="16" />重试</button>
        </div>

        <div v-else-if="!hasRooms" class="wl-empty">
          <Icon name="grid" :size="32" />
          <span>还没有对局</span>
          <button class="wl-btn wl-btn--primary" @click="openCreate">
            <Icon name="plus" :size="16" />新建对局
          </button>
        </div>

        <div v-else class="groups">
          <section v-for="group in groups" :key="group.key" class="group">
            <div class="group-title">
              <Icon :name="groupIcon(group.key)" :size="14" />
              <span>{{ group.label }}</span>
              <span class="group-count">{{ group.rooms.length }}</span>
            </div>
            <div class="room-list">
              <article
                v-for="item in group.rooms"
                :key="item.id"
                class="room-card"
                @click="onCardClick(item)"
              >
                <div class="room-main">
                  <div class="room-head">
                    <span class="room-title">{{ item.title }}</span>
                    <span class="wl-badge" :class="statusClass(item.status)">
                      {{ statusLabel(item.status) }}
                    </span>
                    <span v-if="item.botSide" class="wl-badge wl-badge--accent" title="这一局对面是电脑">
                      人机
                    </span>
                  </div>
                  <div class="room-players">
                    <span class="side">
                      <span class="side-dot red" />{{ item.redName ?? '虚位以待' }}
                    </span>
                    <span class="vs">对</span>
                    <span class="side">
                      <span class="side-dot black" />{{ item.blackName ?? '虚位以待' }}
                    </span>
                  </div>
                  <div class="room-meta">{{ item.moves.length }} 手 · {{ formatTime(item.updatedAt) }}</div>
                </div>
                <div class="room-actions" @click.stop>
                  <button class="wl-btn" @click="onRoomAction(item)">{{ actionLabel(item) }}</button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </template>

    <!-- ===================================================== 对局 -->
    <template v-else>
      <header class="bar">
        <button class="wl-btn wl-btn--ghost" @click="backToLobby">
          <Icon name="arrow-left" :size="16" />返回大厅
        </button>
        <div class="bar-title"><Icon name="grid" :size="16" />{{ room?.title ?? '对局' }}</div>
        <span v-if="room" class="wl-badge" :class="statusClass(room?.status)">
          {{ statusLabel(room?.status) }}
        </span>
        <div class="spacer" />
        <button
          class="wl-icon-btn"
          :title="soundOn ? '关闭音效' : '打开音效'"
          @click="toggleSound"
        >
          <Icon :name="soundOn ? 'volume' : 'volume-off'" :size="16" />
        </button>
        <span v-if="room" class="room-id">房间号 {{ room?.id }}</span>
      </header>

      <div v-if="!games.connected" class="banners">
        <div class="banner banner--warn">
          <Icon name="wifi" :size="16" />
          <span>实时连接已断开，正在重连…</span>
        </div>
      </div>

      <div v-if="room" class="room-body" :class="{ narrow }">
        <div class="board-col" :class="{ 'board-col--mine': myTurnFlash }">
          <XiangqiBoard
            :board="board"
            :my-side="mySide"
            :turn="turn"
            :selected="games.selected"
            :targets="games.targets"
            :last-move="games.lastMove"
            :checked-side="games.checkedSide"
            :interactive="games.myTurn"
            @select="onSelect"
            @move="onMove"
          />
          <!-- 轮到你的横幅：纯装饰、不挡点击，计时器到点自己消失 -->
          <div v-if="myTurnFlash" class="turn-flash" aria-hidden="true">
            <span class="turn-flash__text">轮到你了</span>
          </div>
        </div>

        <aside class="info-col wl-scroll">
          <div v-if="room?.mySide === null" class="watching">
            <Icon name="eye" :size="16" />
            <span>观战中 · 你正在观战，不能走棋</span>
          </div>

          <!-- 对局双方 -->
          <div class="players">
            <div
              class="player"
              :class="{
                mine: room?.mySide === 'red',
                turn: room?.status === 'playing' && room?.turn === 'red',
              }"
            >
              <span class="avatar red-av">{{ initial(room?.redName ?? null) }}</span>
              <div class="pinfo">
                <span class="pname">
                  {{ room?.redName ?? '虚位以待' }}<em v-if="room?.mySide === 'red'">（我）</em>
                </span>
                <span class="pside">红方</span>
              </div>
              <span class="side-dot red" />
            </div>

            <div
              class="player"
              :class="{
                mine: room?.mySide === 'black',
                turn: room?.status === 'playing' && room?.turn === 'black',
              }"
            >
              <span class="avatar black-av">{{ initial(room?.blackName ?? null) }}</span>
              <div class="pinfo">
                <span class="pname">
                  {{ room?.blackName ?? '虚位以待' }}<em v-if="room?.mySide === 'black'">（我）</em>
                </span>
                <span class="pside">黑方</span>
              </div>
              <span class="side-dot black" />
            </div>
          </div>

          <!-- 对局结果 -->
          <div v-if="room?.status === 'finished'" class="result" :class="{ 'result--mate': mate }">
            <div class="result-main">{{ resultHeadline }}</div>
            <div v-if="mate" class="result-mate">
              <Icon name="star" :size="14" />
              <span>{{ mate.detail }}</span>
            </div>
            <div class="result-reason">{{ resultReason }}</div>
            <div v-if="room?.mySide" class="result-mine">你执{{ mySideText }}</div>
            <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onRematch">
              <Icon name="refresh" :size="16" />再来一局
            </button>
          </div>

          <!-- 回合提示 -->
          <div v-else-if="room?.status === 'playing'" class="turnbox">
            <span v-if="room?.botThinking" class="wl-spinner" />
            <Icon v-else name="clock" :size="16" />
            <span class="turn-text">{{ botStalled ? '电脑没有响应' : turnText }}</span>
            <span v-if="games.checkedSide" class="wl-badge wl-badge--danger">将军</span>
            <!--
              看门狗等了几轮还没等到它落子才出现。这时不做假动作：
              明确告诉用户"没响应"，并给一个手动再催一次的按钮。
            -->
            <button v-if="botStalled" class="stall-retry" @click="retryBotTurn">
              点这里重试
            </button>
          </div>

          <!-- 操作按钮 -->
          <div class="actions">
            <div v-if="room?.status === 'waiting'" class="wait-hint">
              <span class="wl-spinner" />
              <span>等待对手加入…</span>
              <button class="wl-btn" @click="onCopy"><Icon name="copy" :size="16" />复制房间信息</button>
            </div>
            <button
              v-if="room?.status === 'playing' && room?.mySide"
              class="wl-btn wl-btn--danger"
              @click="onResign"
            >
              <Icon name="alert" :size="16" />认输
            </button>
            <button class="wl-btn wl-btn--ghost" @click="onLeave">
              <Icon name="logout" :size="16" />退出房间
            </button>
          </div>

          <!-- 走子历史 -->
          <div class="history-block">
            <div class="section-title">
              <Icon name="list" :size="14" />
              <span>走子历史</span>
              <span class="count">{{ room?.moves.length ?? 0 }}</span>
            </div>
            <ol v-if="(room?.moves.length ?? 0) > 0" class="history wl-scroll">
              <li
                v-for="(move, index) in room?.moves ?? []"
                :key="index"
                class="hist-row"
                :class="{ last: index === (room?.moves.length ?? 0) - 1 }"
              >
                <span class="hist-no">{{ index + 1 }}.</span>
                <span class="hist-side" :class="move.color">{{ sideLabel(move.color) }}</span>
                <span class="hist-move">{{ moveText(move) }}</span>
                <span v-if="move.captured" class="hist-cap">吃 {{ pieceLabel(move.captured) }}</span>
                <span v-if="move.check" class="hist-check">将军</span>
              </li>
            </ol>
            <div v-else class="hist-empty">暂无着法</div>
          </div>
        </aside>
      </div>

      <div v-else class="wl-empty">
        <Icon name="alert" :size="32" />
        <span>对局不存在或已结束</span>
        <button class="wl-btn" @click="backToLobby">返回大厅</button>
      </div>
    </template>

    <!-- ===================================================== 新建对局弹层 -->
    <div v-if="showCreate" class="popover-layer">
      <div class="scrim" @click="closeCreate" />
      <div class="modal wl-card">
        <h3>新建对局</h3>
        <div class="wl-field">
          <label class="wl-label">房间名（可选）</label>
          <input
            v-model="createTitle"
            class="wl-input"
            type="text"
            maxlength="40"
            placeholder="留空则使用默认名称"
            @keydown.enter="onCreate"
          />
        </div>
        <div class="wl-field">
          <label class="wl-label">选择执子</label>
          <div class="side-pick">
            <button
              class="side-btn"
              :class="{ active: createSide === 'red' }"
              @click="createSide = 'red'"
            >
              <span class="side-dot red" />执红（先行）
            </button>
            <button
              class="side-btn"
              :class="{ active: createSide === 'black' }"
              @click="createSide = 'black'"
            >
              <span class="side-dot black" />执黑
            </button>
          </div>
        </div>
        <p v-if="localError" class="form-error">{{ localError }}</p>
        <div class="modal-actions">
          <button class="wl-btn" :disabled="busy" @click="closeCreate">取消</button>
          <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onCreate">
            <span v-if="busy" class="wl-spinner" /><span v-else>创建</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ===================================================== 人机对战弹层 -->
    <div v-if="showBot" class="popover-layer">
      <div class="scrim" @click="closeBot" />
      <div class="modal wl-card">
        <h3><Icon name="cpu" :size="18" /> 人机对战</h3>
        <p class="modal-sub">和电脑下一盘 —— 不用等人，坐下就开始</p>

        <div class="wl-field">
          <label class="wl-label">难度</label>
          <div class="level-pick">
            <button
              v-for="item in BOT_LEVELS"
              :key="item.key"
              class="level-btn"
              :class="{ active: botLevel === item.key }"
              @click="botLevel = item.key"
            >
              <span class="level-name">{{ item.label }}</span>
              <span class="level-hint">{{ item.hint }}</span>
            </button>
          </div>
        </div>

        <div class="wl-field">
          <label class="wl-label">你执哪一边</label>
          <div class="side-pick">
            <button
              class="side-btn"
              :class="{ active: botSide === 'red' }"
              @click="botSide = 'red'"
            >
              <span class="side-dot red" />执红（先行）
            </button>
            <button
              class="side-btn"
              :class="{ active: botSide === 'black' }"
              @click="botSide = 'black'"
            >
              <span class="side-dot black" />执黑（电脑先行）
            </button>
          </div>
        </div>

        <p v-if="localError" class="form-error">{{ localError }}</p>
        <div class="modal-actions">
          <button class="wl-btn" :disabled="busy" @click="closeBot">取消</button>
          <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onStartBot">
            <span v-if="busy" class="wl-spinner" /><span v-else>开始</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ===================================================== 加入对局弹层 -->
    <div v-if="showJoin" class="popover-layer">
      <div class="scrim" @click="closeJoin" />
      <div class="modal wl-card">
        <h3>加入对局</h3>
        <p class="modal-sub">{{ joinTarget?.title }}</p>
        <div class="wl-field">
          <label class="wl-label">选择执子</label>
          <div class="side-pick">
            <button class="side-btn" :disabled="joinRedTaken" @click="onJoin('red')">
              <span class="side-dot red" />执红
            </button>
            <button class="side-btn" :disabled="joinBlackTaken" @click="onJoin('black')">
              <span class="side-dot black" />执黑
            </button>
          </div>
          <p class="wl-hint">
            <template v-if="joinRedTaken && joinBlackTaken">两边都已有人，只能观战。</template>
            <template v-else-if="joinRedTaken">红方已有人，只能执黑。</template>
            <template v-else-if="joinBlackTaken">黑方已有人，只能执红。</template>
            <template v-else>两边都是空位，任选一边。</template>
          </p>
        </div>
        <p v-if="localError" class="form-error">{{ localError }}</p>
        <div class="modal-actions">
          <button class="wl-btn" :disabled="busy" @click="closeJoin">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.games {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
  font-family: var(--font-ui);
  color: var(--text);
}

/* ---------------------------------------------------------------- 顶栏 */

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.stats {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.room-id {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 提示条 */

.banners {
  flex: none;
  padding: var(--space-2) var(--space-4) 0;
}

.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner--warn {
  background: var(--warning-soft);
  color: var(--warning);
}

.banner--error {
  background: var(--danger-soft);
  color: var(--danger);
  margin-bottom: var(--space-3);
}

/* ---------------------------------------------------------------- 大厅 */

.lobby-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-4);
}

.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.group-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.group-count {
  color: var(--text-tertiary);
  font-weight: 400;
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
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.room-card:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.room-main {
  flex: 1;
  min-width: 0;
}

.room-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.room-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-players {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--text-secondary);
}

.room-players .side {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vs {
  color: var(--text-tertiary);
  font-size: 12px;
}

.room-meta {
  margin-top: var(--space-1);
  font-size: 12px;
  color: var(--text-tertiary);
}

.room-actions {
  flex: none;
}

/* ---------------------------------------------------------------- 对局布局 */

.room-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--space-4);
  padding: var(--space-4);
}

.board-col {
  position: relative; /* 给"轮到你了"提示做定位上下文 */
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* 轮到我时，棋盘区外圈脉冲两下 */
.board-col--mine {
  animation: games-turn-glow 1.1s var(--ease-out) 2;
}

@keyframes games-turn-glow {
  0%,
  100% {
    box-shadow: inset 0 0 0 0 var(--accent-soft);
  }
  50% {
    box-shadow: inset 0 0 0 3px var(--accent);
  }
}

/* "轮到你了"横幅：盖在棋盘中央，pointer-events: none 不挡操作 */
.turn-flash {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.turn-flash__text {
  padding: var(--space-3) var(--space-6);
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.08em;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  /*
   * 结束帧停在 opacity: 1（不用 forwards 淡出）：减少动效的用户那里动画被
   * 压到 0.01ms，若末尾是 opacity: 0 会直接看不见 —— 那这提示就白做了。
   * 何时消失交给 JS 计时器，两种偏好下都稳定。
   */
  animation: games-turn-pop 2.6s var(--ease-out);
}

@keyframes games-turn-pop {
  0% {
    transform: scale(0.7);
    opacity: 0;
  }
  12% {
    transform: scale(1.08);
    opacity: 1;
  }
  22% {
    transform: scale(1);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

.info-col {
  width: 320px;
  flex: none;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-right: var(--space-1);
}

.room-body.narrow {
  flex-direction: column;
}

.room-body.narrow .board-col {
  flex: 1 1 55%;
}

.room-body.narrow .info-col {
  width: auto;
  flex: 1 1 45%;
  border-top: 1px solid var(--border);
  padding-top: var(--space-3);
}

/* ---------------------------------------------------------------- 信息面板 */

.watching {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.players {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.player {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.player.mine {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.player.turn {
  box-shadow: inset 3px 0 0 var(--accent);
}

.avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  background: var(--surface-3);
  border: 2px solid var(--border-strong);
}

.avatar.red-av {
  color: var(--danger);
  border-color: var(--danger);
}

.avatar.black-av {
  color: var(--text);
  border-color: var(--text);
}

.pinfo {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pname {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pname em {
  font-style: normal;
  font-size: 12px;
  color: var(--accent);
}

.pside {
  font-size: 12px;
  color: var(--text-tertiary);
}

.turnbox {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 14px;
}

.turn-text {
  font-weight: 600;
}

/*
 * "点这里重试"：只在看门狗确认对面真的没响应时出现。
 * 用文字按钮而不是 wl-btn —— 它出现在回合提示这一行里，撑成一个大按钮会把
 * 整行撑高，视觉上像是主操作（它不是，主操作还是下棋）。
 */
.stall-retry {
  margin-left: auto;
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--dur) var(--ease-out);
}

.stall-retry:hover {
  background: var(--surface-2);
}

.result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.result-main {
  font-size: 20px;
  font-weight: 700;
}

.result-reason {
  font-size: 13px;
  color: var(--text-secondary);
}

.result-mine {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 绝杀：结果卡单独给一层强调色。将死是这盘棋的高潮，
   跟"对手认输"用同一张灰卡显示就太可惜了。 */
.result--mate {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
}

.result--mate .result-main {
  color: var(--accent);
}

.result-mate {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.result-mate svg {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.wait-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 走子历史 */

.history-block {
  display: flex;
  flex-direction: column;
  min-height: 120px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.section-title .count {
  color: var(--text-tertiary);
  font-weight: 400;
}

.history {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.hist-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: 13px;
}

.hist-row:last-child {
  border-bottom: none;
}

.hist-row.last {
  background: var(--selected);
}

.hist-no {
  flex: none;
  width: 26px;
  text-align: right;
  color: var(--text-tertiary);
}

.hist-side.red {
  color: var(--danger);
}

.hist-side.black {
  color: var(--text);
}

.hist-move {
  color: var(--text);
}

.hist-cap {
  color: var(--text-tertiary);
}

.hist-check {
  color: var(--danger);
  font-size: 12px;
}

.hist-empty {
  padding: var(--space-4);
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

/* ---------------------------------------------------------------- 棋子/颜色标记 */

.side-dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.side-dot.red {
  background: var(--danger);
}

.side-dot.black {
  background: var(--text);
}

/* ---------------------------------------------------------------- 弹层 */

.popover-layer {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scrim {
  position: absolute;
  inset: 0;
}

.modal {
  position: relative;
  width: 340px;
  max-width: calc(100% - 32px);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border-radius: var(--radius-lg);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-popup);
  background: var(--surface-raised);
}

.modal h3 {
  margin: 0;
  font-size: 15px;
}

.modal-sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-pick {
  display: flex;
  gap: var(--space-2);
}

.side-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 13px;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.side-btn:hover:not(:disabled) {
  background: var(--surface-3);
}

.side-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.side-btn:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

/* 难度选择：三张带说明的小卡，比一个下拉框更容易看明白"选的是什么" */
.level-pick {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.level-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.level-btn:hover {
  border-color: var(--border-strong);
}

.level-btn.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
}

.level-name {
  font-size: 13px;
  font-weight: 600;
}

.level-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.form-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

/* ---------------------------------------------------------------- 刷新按钮旋转 */

.spin {
  animation: games-spin 0.8s linear infinite;
}

@keyframes games-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
