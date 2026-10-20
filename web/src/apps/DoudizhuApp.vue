<!--
  斗地主大厅 + 牌桌。

  设计要点：
  - 一个本地 ref `view` 在大厅与牌桌之间切换；牌局是否存在以 store 的 `room` 为准。
  - **手牌是隐藏信息。** 服务端只下发本人 myHand，别人的只有 handCounts（张数）。
    所以对手面板只显示张数和背面示意，界面不可能也不应该显示别人的牌 —— 这是设计使然。
  - **前端不做牌型判断。** 是否管得上由服务端裁定，提示来自 room.hints，本组件只选牌、
    提交牌 id。"提示"按钮把 hints 里的牌映射成手牌 id 并选中，这一步也由 store 完成。
  - 实时性由 store 内部通过共享 SSE 处理；本组件只读 ddz.connected 提示断线，
    并用 3 秒轮询兜底（只在牌桌且对局未结束时）。

  反馈效果（本轮新增）：
  - 全部用纯 CSS + <Transition>/<TransitionGroup>，不引入任何依赖、不用音效素材。
  - **动画的触发源绝不能用 room.history.length。** 服务端把 history 用 slice(-40)
    封了顶，打到 40 手之后长度恒定不变，任何以长度为条件的动画都会突然不触发，
    而且只在长局里冒头，极难复现。见下面「反馈纯函数区」的 thisHandKey。
  - 尊重 prefers-reduced-motion：styles/base.css 里有一条全局的
    `@media (prefers-reduced-motion: reduce)` 把所有 animation/transition 压到 0.01ms，
    组件里不必再重复一遍；那个 * 选择器对所有元素生效，包含本组件。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import * as sfx from '@/lib/sfx'
import { useDdz } from '@/stores/ddz'
import { formatTime } from '@/api'
import type { DdzCard, DdzPhase, DdzPlay, DdzRoom } from '@/api'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const ddz = useDdz()

type View = 'lobby' | 'table'
const view = ref<View>('lobby')
/** 提交类操作（新建/加入）进行中，用于禁用按钮防止连点。 */
const busy = ref(false)

// ---------------------------------------------------------------- 声音

/**
 * 喇叭按钮：和设置页、象棋窗口共用同一个总开关（`soundState.muted`）。
 *
 * 这里**不做独立的"斗地主音效"开关** —— 总量只有三层（静音 / 系统音效 /
 * 聊天音效），再加一层就没人记得住哪层管哪层了。要安静就整体静音。
 */
const soundOn = computed(() => !sfx.soundState.muted)

function toggleSound(): void {
  sfx.toggleMuted()
  // 关掉的时候当然什么都不响（那正是意图）；打开时回一声，让用户确认成功
  if (!sfx.soundState.muted) sfx.playSystem('notify', { force: true })
}

// ---------------------------------------------------------------- 数据

const room = computed<DdzRoom | null>(() => ddz.room)
const rooms = computed<DdzRoom[]>(() => ddz.rooms)
const hasRooms = computed<boolean>(() => ddz.rooms.length > 0)

// ---------------------------------------------------------------- 座位辅助

/** 取某个座位的玩家记录（无则 null）。 */
function seatRecord(seat: number): DdzRoom['seats'][number] | null {
  return room.value?.seats.find((s) => s.seat === seat) ?? null
}
function seatName(seat: number): string {
  return seatRecord(seat)?.name ?? '虚位以待'
}
function seatOnline(seat: number): boolean {
  return seatRecord(seat)?.online ?? false
}
function seatCount(seat: number): number {
  return room.value?.handCounts[seat] ?? 0
}
function isCurrentSeat(seat: number): boolean {
  return room.value?.current === seat
}
function isLandlordSeat(seat: number): boolean {
  return room.value?.landlord === seat
}
/** 背面小卡片：只示意"对方还有牌"，最多 5 个，真实张数在数字里显示。 */
function cardBacks(seat: number): number[] {
  return Array.from({ length: Math.min(seatCount(seat), 5) }, (_, i) => i + 1)
}
function sortedSeats(target: DdzRoom): DdzRoom['seats'] {
  return [...target.seats].sort((a, b) => a.seat - b.seat)
}

/** 出牌顺序是逆时针：我的下家在左（mySeat+1），我在观战时固定 1 左、2 右。 */
const leftSeat = computed<number>(() => {
  const mine = room.value?.mySeat
  return mine === null || mine === undefined ? 1 : (mine + 1) % 3
})
const rightSeat = computed<number>(() => {
  const mine = room.value?.mySeat
  return mine === null || mine === undefined ? 2 : (mine + 2) % 3
})

// ---------------------------------------------------------------- 手牌与操作

const hand = computed<DdzCard[]>(() => ddz.sortedHand())
/** 底牌：叫地主后才有；用空数组兜底，模板里不必反复判空。 */
const bottom = computed<DdzCard[]>(() => room.value?.bottom ?? [])
const isSpectator = computed<boolean>(() => room.value !== null && room.value.mySeat === null)

const isFirstPlay = computed<boolean>(() => {
  const current = room.value
  return !!current && current.phase === 'playing' && current.myTurn && current.lastPlay === null
})
const canPass = computed<boolean>(() => {
  const current = room.value
  return !!current && current.phase === 'playing' && current.myTurn && current.lastPlay !== null
})
const passTitle = computed<string>(() => {
  const current = room.value
  if (!current) return ''
  if (current.lastPlay === null) return '你是首出，必须出牌'
  if (!current.myTurn) return '还没轮到你'
  return '要不起，跳过这一轮'
})

function isSelected(id: number): boolean {
  return ddz.selectedIds.includes(id)
}

// ---------------------------------------------------------------- 牌面与历史文案

/** 花色 → 颜色类：红桃/方块红，黑桃/梅花黑，大小王金色。 */
function suitClass(card: DdzCard): string {
  if (card.suit === 'joker') return 'is-joker'
  if (card.suit === 'heart' || card.suit === 'diamond') return 'is-red'
  return 'is-black'
}
const SUIT_GLYPH: Record<DdzCard['suit'], string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
  joker: '★',
}
function suitGlyph(card: DdzCard): string {
  return SUIT_GLYPH[card.suit]
}

function phaseLabel(phase: DdzPhase): string {
  if (phase === 'waiting') return '等人'
  if (phase === 'bidding') return '叫地主'
  if (phase === 'playing') return '出牌中'
  return '已结束'
}
function phaseBadgeClass(phase: DdzPhase): string {
  if (phase === 'waiting') return 'wl-badge--accent'
  if (phase === 'bidding') return 'wl-badge--warning'
  if (phase === 'playing') return 'wl-badge--success'
  return ''
}

function playText(play: DdzPlay): string {
  if (play.cards.length === 0) return `座位${play.seat + 1} 要不起`
  return `座位${play.seat + 1} 出 ${play.cards.join(' ')}（${play.typeLabel}）`
}
const recentHistory = computed<DdzPlay[]>(() => (room.value?.history ?? []).slice(-10))

const resultText = computed<string>(() => {
  const result = room.value?.result
  if (!result) return ''
  return result.landlordWon ? '地主获胜' : '农民获胜'
})
const resultDetail = computed<string>(() => {
  const result = room.value?.result
  if (!result) return ''
  // 服务端发的是 'emptied' / 'abandon' 这类英文码，这里翻成中文再展示
  return `座位${result.winnerSeat + 1} · ${reasonLabel(result.reason)}`
})

/**
 * 结算结果相对于"我"是赢还是输：null 表示观战（没有立场，用中性配色）。
 * 地主赢 === 我是地主 ⇒ 我赢；否则我输。观战者 mySeat 为 null，无从谈起。
 */
const iWon = computed<boolean | null>(() => {
  const current = room.value
  if (!current?.result || current.mySeat === null) return null
  return current.result.landlordWon === (current.landlord === current.mySeat)
})

/** 出牌阶段且轮到我 —— 用来给整条操作区加高亮。 */
const myPlayingTurn = computed<boolean>(() => {
  const current = room.value
  return !!current && current.phase === 'playing' && current.myTurn
})

// ================================================================ 反馈纯函数区
/* ==== 反馈纯函数区：scripts/doudizhu-ux-test.mjs 会整段抽出来跑，改动请保持无外部依赖 ==== */

/**
 * 找出"上一手"在 history 里对应的那条记录。
 *
 * 为什么要按内容匹配、而不是直接取 history 末位：有人"要不起"时也会往
 * history 里塞一条（cards 为空），但期间 lastPlay 并不改变 —— 末位于是变成
 * 那条 pass，取它会把"这一手"的身份算错。所以从后往前找牌面、座位、文案
 * 都对得上的那条。
 */
function findLastPlayEntry(room: DdzRoom | null): DdzPlay | null {
  const lastPlay = room?.lastPlay
  if (!lastPlay) return null
  const history = room?.history ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (
      entry &&
      entry.seat === lastPlay.seat &&
      entry.typeLabel === lastPlay.typeLabel &&
      entry.cards.length === lastPlay.cards.length &&
      entry.cards.every((text, k) => text === lastPlay.cards[k])
    ) {
      return entry
    }
  }
  return null
}

/**
 * "这一手"的唯一标识，用作所有出牌 / 炸弹动画的 key。
 *
 * ⚠️ 绝不能用 history.length 或数组 join 当触发源：服务端把 history 用
 * slice(-40) 封了顶，打到 40 手之后长度恒定不变，动画会突然不触发 ——
 * 而且这种 bug 只在长局里冒头，极难复现。这里用服务端 now() 生成的毫秒
 * 时间戳 at：每一手都不同，连点、快速切换也不会撞。空串表示当前没有上一手。
 */
function thisHandKey(room: DdzRoom | null): string {
  const entry = findLastPlayEntry(room)
  return entry ? `${entry.seat}-${entry.at}-${entry.type}` : ''
}

/**
 * 上一手是不是炸弹 / 王炸。返回 'bomb' | 'rocket' | ''（空串即普通牌）。
 * 服务端只在 history 条目里带 type，视图的 lastPlay 只有 typeLabel，
 * 所以要顺着内容找到那条记录再读 type。
 */
function bombFlavor(room: DdzRoom | null): '' | 'bomb' | 'rocket' {
  const entry = findLastPlayEntry(room)
  if (!entry) return ''
  if (entry.type === 'bomb') return 'bomb'
  if (entry.type === 'rocket') return 'rocket'
  return ''
}

/** 剩余张数的警示文案：报单（剩 1 张）、报双（剩 2 张），其余为空。 */
function countBadgeOf(count: number): string {
  if (count === 1) return '报单'
  if (count === 2) return '报双'
  return ''
}

/** 结算原因码 → 中文。服务端发的是英文码，直接显示对用户不友好。 */
const REASON_LABELS: Record<string, string> = {
  emptied: '出完了所有手牌',
  abandon: '有人中途退出',
}
function reasonLabel(reason: string): string {
  // 未知码原样透出，而不是硬塞一句"未知" —— 万一将来服务端加了新原因，
  // 至少还能看到真实值，方便排查，不会静默丢失信息。
  return REASON_LABELS[reason] ?? reason
}

/* ==== 反馈纯函数区 结束 ==== */

/** 驱动"这一手"动画的 key；变了就重放一次入场动画。 */
const playKey = computed<string>(() => thisHandKey(room.value))
/** 上一手是不是炸弹 / 王炸；'' 表示普通牌。 */
const bomb = computed<'' | 'bomb' | 'rocket'>(() => bombFlavor(room.value))
const bombLabel = computed<string>(() => (bomb.value === 'rocket' ? '王炸' : '炸弹'))

// ---------------------------------------------------------------- 大厅操作

function hasEmptySeat(target: DdzRoom): boolean {
  return target.seats.some((s) => s.userId === null)
}

function onRefresh(): void {
  void ddz.loadRooms()
}

function dismissError(): void {
  ddz.error = null
}

function onCreate(): void {
  void doCreate()
}

async function doCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await ddz.createRoom()
    view.value = 'table'
  } catch {
    // 失败已由 store 记录并提示，留在原地即可
  } finally {
    busy.value = false
  }
}

function onEnterRoom(target: DdzRoom): void {
  void enterRoom(target)
}

async function enterRoom(target: DdzRoom): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    // 有空位就入座，满座则观战（mySeat 为 null），两者都进牌桌
    if (hasEmptySeat(target)) await ddz.joinRoom(target.id)
    else await ddz.openRoom(target.id)
    if (ddz.room?.id === target.id) view.value = 'table'
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 牌桌操作

function goLobby(): void {
  void doLobby()
}

async function doLobby(): Promise<void> {
  const current = room.value
  if (current && (current.phase === 'bidding' || current.phase === 'playing') && ddz.mySeat !== null) {
    if (!window.confirm('本局尚未结束，返回大厅将退出牌局。确定退出吗？')) return
  }
  if (current) await ddz.leaveRoom(current.id)
  ddz.clearSelection()
  view.value = 'lobby'
}

function onPlay(): void {
  if (ddz.submitting || !ddz.canPlay) return
  void ddz.playSelected()
}

function onPass(): void {
  if (ddz.submitting || !canPass.value) return
  void ddz.passTurn()
}

function onHint(): void {
  if (ddz.submitting) return
  ddz.applyHint()
}

function onClear(): void {
  ddz.clearSelection()
}

function onBid(call: boolean): void {
  if (ddz.submitting) return
  void ddz.bid(call)
}

function onRematch(): void {
  void doRematch()
}

async function doRematch(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const oldId = room.value?.id
    if (oldId) await ddz.leaveRoom(oldId)
    await ddz.createRoom()
    view.value = 'table'
  } catch {
    // 失败已由 store 记录并提示
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 生命周期

let pollTimer: number | null = null

/**
 * 轮询兜底：SSE 万一断了，牌桌也不会卡住。
 *
 * **只在断线时才真的发请求**。连接正常时服务端会推每一条变化，3 秒一次的
 * 全量拉取纯属重复读库 —— 一局牌下来几十次请求，服务端和手机流量都白花。
 * `ddz.connected` 由共享的实时层维护，正是"连接还活着吗"的准确答案。
 */
function tick(): void {
  const current = room.value
  if (view.value !== 'table' || !current) return
  if (current.phase !== 'bidding' && current.phase !== 'playing') return
  if (ddz.connected) return
  void ddz.reload()
}

onMounted(() => {
  ddz.connectRealtime()
  void ddz.loadRooms()

  const roomId = props.win.args.roomId
  if (typeof roomId === 'string' && roomId) {
    view.value = 'table'
    void ddz.openRoom(roomId)
  }

  pollTimer = window.setInterval(tick, 3000)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="ddz">
    <!-- ======================================================= 大厅 -->
    <template v-if="view === 'lobby'">
      <header class="bar">
        <div class="bar-title"><Icon name="grid" :size="18" />斗地主</div>
        <div class="spacer" />
        <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onCreate">
          <Icon name="plus" :size="16" />新建牌局
        </button>
        <button class="wl-icon-btn" :disabled="ddz.loading" title="刷新" @click="onRefresh">
          <Icon name="refresh" :size="16" :class="{ spin: ddz.loading }" />
        </button>
        <button
          class="wl-icon-btn"
          :title="soundOn ? '关闭音效' : '打开音效（轮到你时会提示）'"
          @click="toggleSound"
        >
          <Icon :name="soundOn ? 'volume' : 'volume-off'" :size="16" />
        </button>
      </header>

      <div class="body wl-scroll">
        <div v-if="ddz.error && hasRooms" class="banner banner--error">
          <Icon name="alert" :size="16" />
          <span class="banner-text">{{ ddz.error }}</span>
          <button class="wl-btn wl-btn--ghost" @click="dismissError">关闭</button>
        </div>

        <div v-if="!hasRooms && ddz.loading" class="wl-empty">
          <span class="wl-spinner" />
          <span>正在加载牌局…</span>
        </div>

        <div v-else-if="!hasRooms && ddz.error" class="wl-empty">
          <Icon name="alert" :size="32" />
          <span>{{ ddz.error }}</span>
          <button class="wl-btn" @click="onRefresh"><Icon name="refresh" :size="16" />重试</button>
        </div>

        <div v-else-if="!hasRooms" class="wl-empty">
          <Icon name="grid" :size="32" />
          <span>还没有牌局</span>
          <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onCreate">
            <Icon name="plus" :size="16" />新建牌局
          </button>
        </div>

        <div v-else class="room-list">
          <article v-for="item in rooms" :key="item.id" class="room-card">
            <div class="room-main">
              <div class="room-head">
                <span class="room-title selectable">{{ item.title || '斗地主牌局' }}</span>
                <span class="wl-badge" :class="phaseBadgeClass(item.phase)">{{ phaseLabel(item.phase) }}</span>
              </div>
              <div class="room-seats">
                <span v-for="seat in sortedSeats(item)" :key="seat.seat" class="seat-chip">
                  <span class="dot" :class="seat.online ? 'dot--on' : 'dot--off'" />
                  <span :class="{ muted: !seat.name }">{{ seat.name || '虚位以待' }}</span>
                  <span v-if="item.landlord === seat.seat" class="wl-badge wl-badge--warning">地主</span>
                </span>
              </div>
              <div class="room-meta">更新于 {{ formatTime(item.updatedAt) }}</div>
            </div>
            <div class="room-action">
              <button
                class="wl-btn"
                :class="{ 'wl-btn--primary': hasEmptySeat(item) }"
                :disabled="busy"
                @click="onEnterRoom(item)"
              >
                <Icon :name="hasEmptySeat(item) ? 'plus' : 'eye'" :size="16" />
                {{ hasEmptySeat(item) ? '加入' : '观战' }}
              </button>
            </div>
          </article>
        </div>
      </div>
    </template>

    <!-- ======================================================= 牌桌 -->
    <template v-else>
      <header class="bar">
        <button class="wl-icon-btn" title="返回大厅" @click="goLobby">
          <Icon name="chevron-left" :size="16" />
        </button>
        <div class="bar-title">
          <Icon name="grid" :size="18" />
          <span class="selectable">{{ room?.title || '斗地主牌局' }}</span>
        </div>
        <span v-if="room" class="wl-badge" :class="phaseBadgeClass(room.phase)">{{ phaseLabel(room.phase) }}</span>
        <div class="spacer" />
        <span class="status-text">{{ ddz.statusText }}</span>
        <button
          class="wl-icon-btn"
          :title="soundOn ? '关闭音效' : '打开音效（轮到你时会提示）'"
          @click="toggleSound"
        >
          <Icon :name="soundOn ? 'volume' : 'volume-off'" :size="16" />
        </button>
      </header>

      <div v-if="!ddz.connected" class="notice notice--warning">
        <Icon name="alert" :size="16" />
        <span>实时连接已断开，正在重连…</span>
      </div>

      <div v-if="!room" class="wl-empty">
        <span class="wl-spinner" />
        <span>正在加载牌局…</span>
      </div>

      <template v-else>
        <!-- 结束结果条：整条滑入；赢/输按"我的立场"上色（观战为中性）。 -->
        <Transition name="ddz-result">
          <div
            v-if="room.phase === 'finished' && room.result"
            class="result-bar"
            :class="{ 'result-bar--win': iWon === true, 'result-bar--lose': iWon === false }"
          >
            <Icon name="star" :size="20" />
            <div class="result-main">
              <span class="result-title">{{ resultText }}</span>
              <span class="result-detail">{{ resultDetail }}</span>
            </div>
            <div class="result-counts">
              <span v-for="seat in sortedSeats(room)" :key="seat.seat" class="result-count">
                {{ seat.name || `座位${seat.seat + 1}` }} · {{ room.handCounts[seat.seat] ?? 0 }} 张
              </span>
            </div>
            <button class="wl-btn wl-btn--primary" :disabled="busy" @click="onRematch">
              <Icon name="refresh" :size="16" />再来一局
            </button>
            <button class="wl-btn" @click="goLobby">返回大厅</button>
          </div>
        </Transition>

        <div v-if="ddz.error" class="banner banner--error banner--inline">
          <Icon name="alert" :size="16" />
          <span class="banner-text">{{ ddz.error }}</span>
          <button class="wl-btn wl-btn--ghost" @click="dismissError">关闭</button>
        </div>

        <!-- 上排：两个对手 -->
        <div class="table-top">
          <section
            v-for="seat in [leftSeat, rightSeat]"
            :key="seat"
            class="opponent"
            :class="{ 'opponent--active': isCurrentSeat(seat) }"
          >
            <div class="opp-head">
              <span class="dot" :class="seatOnline(seat) ? 'dot--on' : 'dot--off'" />
              <span class="opp-name" :class="{ muted: !seatRecord(seat)?.name }">{{ seatName(seat) }}</span>
              <span v-if="isLandlordSeat(seat)" class="wl-badge wl-badge--warning">地主</span>
            </div>
            <!-- 报单 / 报双：对手张数掉到 1、2 时给一个醒目徽标，别让数字悄悄变 -->
            <div class="opp-count">
              <span class="opp-num" :key="seatCount(seat)">{{ seatCount(seat) }}</span> 张
              <Transition name="ddz-fade">
                <span
                  v-if="countBadgeOf(seatCount(seat))"
                  :key="countBadgeOf(seatCount(seat))"
                  class="opp-warn"
                  :class="{ 'opp-warn--one': seatCount(seat) === 1 }"
                >
                  {{ countBadgeOf(seatCount(seat)) }}
                </span>
              </Transition>
            </div>
            <!-- 只画背面示意"对方还有牌"：对方手牌是隐藏信息，服务端不下发，界面也不显示 -->
            <div class="card-backs">
              <span v-for="n in cardBacks(seat)" :key="n" class="card-back" />
            </div>
            <div v-if="isCurrentSeat(seat)" class="opp-turn">出牌中</div>
          </section>
        </div>

        <!-- 中间：牌桌区 -->
        <div class="table-mid wl-scroll">
          <div class="mid-row">
            <span class="mid-label">底牌</span>
            <div v-if="bottom.length" class="card-row">
              <span v-for="card in bottom" :key="card.id" class="card card--bottom" :class="suitClass(card)">
                <span class="card-label">{{ card.label }}</span>
                <span class="card-suit">{{ suitGlyph(card) }}</span>
              </span>
            </div>
            <span v-else class="mid-empty">叫地主后公开</span>
          </div>

          <div class="mid-row mid-row--last">
            <span class="mid-label">上一手</span>
            <template v-if="room.lastPlay">
              <span class="play-by">座位{{ room.lastPlay.seat + 1 }}</span>
              <!-- key 用 thisHandKey（服务端时间戳），new 一手才重放；不能挂在 history.length 上 -->
              <Transition name="ddz-play" mode="out-in" appear>
                <div :key="playKey" class="card-row">
                  <span
                    v-for="(text, i) in room.lastPlay.cards"
                    :key="i"
                    class="card card--play"
                    :class="{ 'card--play-bomb': bomb }"
                  >
                    <span class="card-label">{{ text }}</span>
                  </span>
                </div>
              </Transition>
              <span class="play-type" :class="{ 'play-type--bomb': bomb }">{{ room.lastPlay.typeLabel }}</span>
            </template>
            <span v-else class="mid-empty">（等待出牌）</span>
            <!-- 炸弹 / 王炸特效：key 变了就重放，动画自己播完停在透明，不需要定时器 -->
            <div
              v-if="bomb"
              :key="playKey"
              class="bomb-fx"
              :class="`bomb-fx--${bomb}`"
              aria-hidden="true"
            >
              <span class="bomb-fx__ring" />
              <span class="bomb-fx__ring bomb-fx__ring--2" />
              <span class="bomb-fx__label">{{ bombLabel }}</span>
            </div>
          </div>

          <div v-if="isFirstPlay" class="first-play">你是首出，必须出牌</div>

          <div class="mid-row">
            <span class="mid-label">出牌记录</span>
            <div v-if="recentHistory.length" class="history wl-scroll">
              <span
                v-for="(play, i) in recentHistory"
                :key="i"
                class="history-item"
                :class="{ 'history-item--pass': !play.cards.length }"
              >
                {{ playText(play) }}
              </span>
            </div>
            <span v-else class="mid-empty">暂无出牌记录</span>
          </div>
        </div>

        <!-- 下排：我的手牌 + 操作 -->
        <div class="table-bottom" :class="{ 'table-bottom--myturn': myPlayingTurn }">
          <div class="my-area wl-scroll">
            <div v-if="isSpectator" class="wl-empty wl-empty--compact">
              <Icon name="eye" :size="28" />
              <span>观战中，仅可查看牌局</span>
            </div>
            <div v-else-if="!hand.length" class="wl-empty wl-empty--compact">
              <span class="wl-spinner" />
              <span>等待发牌…</span>
            </div>
            <!--
              TransitionGroup：出掉的牌有"缩小下落淡出"的离场过渡。
              ⚠️ 剩下的牌是**跳**到新位置的，不是平滑滑动 —— 因为离场元素在过渡期间
              仍占据文档流位置（leave-active 没加 position:absolute），剩余手牌在它
              真正移除前不会移动，ddz-hand-move 也就记录不到位移。
              想让补位也平滑，得给 .ddz-hand-leave-active 加 position:absolute
              并处理负 margin 叠排下的水平定位；权衡后没做，别让注释承诺做不到的事。
            -->
            <TransitionGroup v-else name="ddz-hand" tag="div" class="hand">
              <button
                v-for="card in hand"
                :key="card.id"
                type="button"
                class="card card--hand"
                :class="[suitClass(card), { 'is-selected': isSelected(card.id) }]"
                @click="ddz.toggleCard(card.id)"
              >
                <span class="card-label">{{ card.label }}</span>
                <span class="card-suit">{{ suitGlyph(card) }}</span>
              </button>
            </TransitionGroup>
          </div>

          <div class="actions">
            <!-- 轮到我：一个会呼吸的小旗子，把注意力拉回操作区 -->
            <Transition name="ddz-fade">
              <span v-if="myPlayingTurn" class="my-turn-flag">轮到你出牌</span>
            </Transition>

            <!-- 叫地主阶段 -->
            <template v-if="room.phase === 'bidding'">
              <template v-if="room.canBid">
                <button class="wl-btn wl-btn--primary" :disabled="ddz.submitting" @click="onBid(true)">
                  <Icon name="star" :size="16" />叫地主
                </button>
                <button class="wl-btn" :disabled="ddz.submitting" @click="onBid(false)">
                  <Icon name="minus" :size="16" />不叫
                </button>
              </template>
              <span v-else class="wait-text">等待其他人叫地主</span>
            </template>

            <!-- 出牌阶段 -->
            <template v-else-if="room.phase === 'playing'">
              <button class="wl-btn wl-btn--primary" :disabled="ddz.submitting || !ddz.canPlay" @click="onPlay">
                <Icon name="arrow-up" :size="16" />出牌
              </button>
              <button class="wl-btn" :disabled="ddz.submitting || !canPass" :title="passTitle" @click="onPass">
                <Icon name="minus" :size="16" />要不起
              </button>
              <button class="wl-btn" :disabled="ddz.submitting || !room.myTurn" @click="onHint">
                <Icon name="search" :size="16" />提示
              </button>
              <button class="wl-btn wl-btn--ghost" :disabled="ddz.submitting" @click="onClear">
                <Icon name="close" :size="16" />清空选择
              </button>
            </template>

            <template v-else-if="room.phase === 'waiting'">
              <span class="wait-text">等待玩家加入</span>
            </template>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.ddz {
  /* 扑克牌是"实体物件"的模拟，不跟随主题变色 —— 这是唯一允许硬编码颜色的例外：
     固定白底 + 红花色/黑花色 + 金色王。集中写在这里，其它地方一律用设计令牌。 */
  --poker-face: #fbfbf6;
  --poker-red: #c8322b;
  --poker-black: #23292f;
  --poker-joker: #c98a12;
  --poker-edge: rgba(0, 0, 0, 0.24);
  --poker-shadow: rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  height: 100%;
  color: var(--text);
  font-family: var(--font-ui);
}

/* ---------------------------------------------------------------- 通用 */

.spacer {
  flex: 1;
}

.status-text {
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}

.muted {
  color: var(--text-tertiary);
}

.spin {
  animation: ddz-spin 0.8s linear infinite;
}

@keyframes ddz-spin {
  to {
    transform: rotate(360deg);
  }
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}

.bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: 13px;
}

.banner--error {
  background: var(--danger-soft);
  color: var(--danger);
}

.banner--inline {
  margin: var(--space-2) var(--space-4) 0;
  border-radius: var(--radius);
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: 13px;
  flex-shrink: 0;
}

.notice--warning {
  background: var(--warning-soft);
  color: var(--warning);
}

.wl-empty--compact {
  padding: var(--space-4);
}

/* ---------------------------------------------------------------- 大厅 */

.body {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
}

.room-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
}

.room-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}

.room-card:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.room-main {
  flex: 1;
  min-width: 0;
}

.room-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.room-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-seats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin-bottom: var(--space-2);
}

.seat-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 12px;
  color: var(--text-secondary);
}

.room-meta {
  font-size: 11px;
  color: var(--text-tertiary);
}

.room-action {
  flex-shrink: 0;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot--on {
  background: var(--success);
}

.dot--off {
  background: var(--text-disabled);
}

/* ---------------------------------------------------------------- 牌桌 */

.result-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin: var(--space-3) var(--space-4) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--text);
  flex-shrink: 0;
}

/* 按"我的立场"给结果条上色：赢了绿、输了红，观战保持中性蓝（默认值） */
.result-bar--win {
  border-color: var(--success);
  background: var(--success-soft);
}

.result-bar--lose {
  border-color: var(--danger);
  background: var(--danger-soft);
}

/* 结果条滑入；星标随之弹一下，别让结算只是静悄悄地出现 */
.ddz-result-enter-active {
  transition: opacity var(--dur-slow) var(--ease-spring), transform var(--dur-slow) var(--ease-spring);
}
.ddz-result-enter-active .result-title {
  animation: ddz-title-pop 0.5s var(--ease-spring);
}
.ddz-result-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.ddz-result-enter-from,
.ddz-result-leave-to {
  opacity: 0;
  transform: translateY(-12px) scale(0.96);
}

@keyframes ddz-title-pop {
  from {
    transform: scale(0.7);
    opacity: 0;
  }
  60% {
    transform: scale(1.12);
    opacity: 1;
  }
  to {
    transform: scale(1);
  }
}

.result-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-title {
  font-size: 16px;
  font-weight: 700;
}

.result-detail {
  font-size: 12px;
  color: var(--text-secondary);
}

.result-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.table-top {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4) 0;
  flex-shrink: 0;
}

.opponent {
  flex: 1;
  max-width: 280px;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

/* 对手回合：只给一个克制的描边。
   之前这里是 accent 边框 + 光晕，比"轮到我"还抢眼，主次是反的 ——
   现在把视线的重心留给下方 .table-bottom--myturn（自己出牌时的呼吸光晕）。 */
.opponent--active {
  border-color: var(--border-strong);
}

.opp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.opp-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opp-count {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.opp-num {
  display: inline-block;
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  /* key 跟着张数走（模板里 :key="seatCount(seat)"），张数一变就重挂元素，
     这段 pop 动画于是重新播一遍 —— 数字不再悄悄跳变。 */
  animation: ddz-count-pop var(--dur-slow) var(--ease-spring);
}

@keyframes ddz-count-pop {
  from {
    transform: scale(1.4);
    color: var(--accent);
  }
  to {
    transform: scale(1);
    color: var(--text);
  }
}

.opp-warn {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.6;
  color: var(--warning);
  background: var(--warning-soft);
}

/* 报单（只剩 1 张）升级成红色并持续闪烁，比报双更急迫 */
.opp-warn--one {
  color: var(--danger);
  background: var(--danger-soft);
  animation: ddz-warn-flash 1s var(--ease-out) infinite;
}

@keyframes ddz-warn-flash {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.card-backs {
  display: flex;
  gap: 2px;
}

.card-back {
  width: 12px;
  height: 18px;
  border-radius: 2px;
  border: 1px solid var(--border-strong);
  background: repeating-linear-gradient(
    45deg,
    var(--surface-3),
    var(--surface-3) 3px,
    var(--surface-1) 3px,
    var(--surface-1) 6px
  );
}

.opp-turn {
  margin-top: var(--space-2);
  font-size: 11px;
  color: var(--accent);
}

.table-mid {
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mid-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

/* 炸弹特效是绝对定位覆盖在这一行上，需要一个定位上下文，且不能影响布局 */
.mid-row--last {
  position: relative;
}

.mid-label {
  width: 56px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.mid-empty {
  font-size: 13px;
  color: var(--text-tertiary);
}

.play-by,
.play-type {
  font-size: 12px;
  color: var(--text-secondary);
}

.play-type--bomb {
  color: var(--danger);
  font-weight: 700;
}

.card-row {
  display: flex;
  gap: var(--space-1);
}

/* 出牌入场：新一手从上方落下来并放大到位；旧一手向下淡出。
   配合 mode="out-in"，连续出牌也不会闪。 */
.ddz-play-enter-active {
  transition: opacity var(--dur-slow) var(--ease-spring), transform var(--dur-slow) var(--ease-spring);
}
.ddz-play-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.ddz-play-enter-from {
  opacity: 0;
  transform: translateY(-16px) scale(0.8);
}
.ddz-play-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.9);
}

.first-play {
  align-self: flex-start;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
}

.history {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding-bottom: var(--space-1);
  flex: 1;
  min-width: 0;
}

.history-item {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.history-item--pass {
  color: var(--text-tertiary);
}

.table-bottom {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

/* 轮到我：整条操作区呼吸式发光，替掉"只有按钮变可点"的那种无声提示 */
.table-bottom--myturn {
  border-top-color: var(--accent);
  animation: ddz-turn-glow 1.6s var(--ease-out) infinite;
}

@keyframes ddz-turn-glow {
  0%,
  100% {
    box-shadow: inset 0 0 0 1px var(--accent-soft);
  }
  50% {
    box-shadow: inset 0 0 0 1px var(--accent), inset 0 8px 22px -14px var(--accent);
  }
}

.my-turn-flag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.my-turn-flag::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: ddz-dot-pulse 1.2s var(--ease-out) infinite;
}

@keyframes ddz-dot-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.6);
  }
}

/* 小旗子的进出都用同一条淡入淡出，避免快速轮转时突兀 */
.ddz-fade-enter-active,
.ddz-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.ddz-fade-enter-from,
.ddz-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.my-area {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.hand {
  display: flex;
  width: max-content;
  padding: 20px 6px 6px;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  flex-shrink: 0;
  max-width: 360px;
}

.wait-text {
  font-size: 13px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 扑克牌（固定色） */

.card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: var(--poker-face);
  color: var(--poker-black);
  border: 1px solid var(--poker-edge);
  border-radius: var(--radius-sm);
  box-shadow: 0 1px 2px var(--poker-shadow);
  user-select: none;
  line-height: 1;
}

.card-label {
  font-weight: 700;
}

.card-suit {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.85;
}

.card.is-red {
  color: var(--poker-red);
}

.card.is-black {
  color: var(--poker-black);
}

.card.is-joker {
  color: var(--poker-joker);
}

.card--bottom {
  width: 36px;
  height: 50px;
  font-size: 18px;
}

.card--play {
  width: 40px;
  height: 56px;
  font-size: 20px;
}

/* 炸弹 / 王炸的牌本身也描一圈红边，和特效呼应 */
.card--play-bomb {
  box-shadow: 0 0 0 2px var(--danger), 0 0 14px var(--danger-soft);
}

.card--hand {
  position: relative;
  width: 52px;
  height: 74px;
  font-size: 26px;
  padding: 0;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.card--hand + .card--hand {
  margin-left: -20px;
}

.card--hand:hover {
  transform: translateY(-10px);
  z-index: 3;
}

.card--hand.is-selected {
  transform: translateY(-16px);
  box-shadow: 0 0 0 2px var(--accent), 0 4px 10px var(--poker-shadow);
  z-index: 2;
}

.card--hand.is-selected:hover {
  transform: translateY(-18px);
  z-index: 4;
}

/* ---------------------------------------------------------------- 手牌离场过渡 */
/* 放在 .card--hand 之后：同优先级下后者胜出，把这些 transition 覆盖到手牌上。
   出掉的牌向下缩小淡出（有"打出去"的感觉），剩下的牌靠 move 过渡平滑补位。 */
.ddz-hand-move {
  transition: transform var(--dur-slow) var(--ease-out);
}
.ddz-hand-enter-active {
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.ddz-hand-leave-active {
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.ddz-hand-enter-from {
  opacity: 0;
  transform: translateY(16px);
}
.ddz-hand-leave-to {
  opacity: 0;
  transform: translateY(30px) scale(0.7) rotate(5deg);
}

/* ---------------------------------------------------------------- 炸弹 / 王炸特效 */
/* 覆盖在"上一手"那一行上的纯装饰层，pointer-events 关掉，绝不挡点击；
   动画只播一次，`forwards` 停在透明状态，所以不需要任何定时器去清理它。
   key 变了 = 又炸了一次，元素重挂 → 特效重放。 */
.bomb-fx {
  position: absolute;
  inset: -10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  animation: ddz-bomb-fade 1.05s var(--ease-out) forwards;
}

.bomb-fx__label {
  position: relative;
  z-index: 1;
  font-size: 30px;
  font-weight: 900;
  letter-spacing: 4px;
  color: var(--danger);
  text-shadow: 0 0 12px var(--danger-soft), 0 2px 0 rgba(0, 0, 0, 0.35);
  animation: ddz-bomb-pop 0.5s var(--ease-spring);
}

.bomb-fx--rocket .bomb-fx__label {
  color: var(--warning);
  text-shadow: 0 0 14px var(--warning-soft), 0 2px 0 rgba(0, 0, 0, 0.35);
}

.bomb-fx__ring {
  position: absolute;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: 3px solid var(--danger);
  opacity: 0;
  animation: ddz-bomb-ring 0.7s var(--ease-out) forwards;
}

.bomb-fx--rocket .bomb-fx__ring {
  border-color: var(--warning);
}

.bomb-fx__ring--2 {
  animation-delay: 0.12s;
}

@keyframes ddz-bomb-ring {
  from {
    transform: scale(0.3);
    opacity: 0.9;
  }
  to {
    transform: scale(3.6);
    opacity: 0;
  }
}

@keyframes ddz-bomb-pop {
  from {
    transform: scale(0.4) rotate(-6deg);
    opacity: 0;
  }
  60% {
    transform: scale(1.15) rotate(2deg);
    opacity: 1;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes ddz-bomb-fade {
  0%,
  65% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
</style>
