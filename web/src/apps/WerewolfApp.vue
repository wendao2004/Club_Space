<!--
  狼人杀。

  界面遵循两条原则：

  1. **不猜身份。** 服务端发来的 view 里压根没有"别人是什么身份"这个信息，
     所以界面也不做任何推断（不根据票型标"这人像狼"）。玩家自己想怎么盘是玩家的事。

  2. **能做什么完全看服务端。** 按钮的显示与否取决于 view.actionKind / canAct /
     legalTargets，本地不重推一遍规则。狼人杀的规则比象棋复杂得多，
     本地重推一遍必然和服务端漂移，而漂移的表现是"按钮亮着却点不动"。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import type { WerewolfPhase, WerewolfRoom } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useWerewolf } from '@/stores/werewolf'

const ww = useWerewolf()
const auth = useAuth()
const ui = useUi()

/** 可选人数范围（与服务端 werewolf.ts 的 MIN/MAX 保持一致）。 */
const MIN_PLAYERS = 6
const MAX_PLAYERS = 12
const PLAYER_OPTIONS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i)

const PHASE_LABELS: Record<WerewolfPhase, string> = {
  waiting: '等待玩家',
  night: '夜晚',
  'day-announce': '公布昨夜结果',
  'day-discuss': '白天讨论',
  'day-vote': '投票放逐',
  hunter: '猎人开枪',
  finished: '已结束',
}

const ACTION_LABELS: Record<string, string> = {
  kill: '选择今晚要袭击的人',
  check: '选择要查验的人',
  witch: '使用药水',
  vote: '投票放逐一个人',
  shoot: '选择要带走的座位',
}

const ROLE_HINTS: Record<string, string> = {
  wolf: '每晚和队友一起选一个人袭击。白天尽量藏好 —— 被投出去就出局了。',
  seer: '每晚可以查验一个人的阵营（好人还是狼人）。你的查验结果只有你自己看得到。',
  witch: '你有一瓶解药和一瓶毒药，各只能用一次。每晚能看到狼刀的是谁，可以选择救或不救。',
  hunter: '你出局时可以开枪带走一个人 —— 但被女巫毒死时不能开枪。',
  villager: '你没有夜间技能，靠白天的发言和投票找出狼人。',
}

// ---------------------------------------------------------------- 建房间

const newTitle = ref('')
const newPlayerCount = ref(9)
const creating = ref(false)

async function createRoom(): Promise<void> {
  if (creating.value) return
  creating.value = true
  const ok = await ww.create(newTitle.value.trim() || '狼人杀', newPlayerCount.value)
  creating.value = false
  if (ok) newTitle.value = ''
}

// ---------------------------------------------------------------- 交互

function seatClass(seat: { seat: number; alive: boolean; isMe: boolean }): Record<string, boolean> {
  const room = ww.room
  return {
    'seat--me': seat.isMe,
    'seat--dead': !seat.alive,
    'seat--selected': ww.selectedTarget === seat.seat,
    // 只对**狼队友**高亮 —— 这个信息是我的 view 里本来就有的，不是推断出来的
    'seat--pack': (room?.teammates ?? []).includes(seat.seat),
    'seat--selectable': (room?.legalTargets ?? []).includes(seat.seat),
    // 刚出局：抖一下、泛红，让"谁死了"不用去读日志
    'seat--dying': dyingSeats.value.includes(seat.seat),
  }
}

function clickSeat(seat: number): void {
  const room = ww.room
  if (!room?.canAct) return
  // 只能选服务端说合法的目标 —— 本地不做"这个目标行不行"的判断
  if (!room.legalTargets.includes(seat)) return
  ww.select(ww.selectedTarget === seat ? null : seat)
}

const canSubmit = computed(() => {
  const room = ww.room
  if (!room?.canAct) return false
  // 投票和女巫允许弃权，其余必须选人
  if (room.canAbstain) return true
  return ww.selectedTarget !== null
})

// ---------------------------------------------------------------- 倒计时

const nowTick = ref(Date.now())
let timer: number | null = null
onMounted(() => {
  ww.subscribe()
  void ww.loadRooms()
  timer = window.setInterval(() => (nowTick.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  if (bannerTimer !== null) window.clearTimeout(bannerTimer)
  for (const t of dyingTimers) window.clearTimeout(t)

  /**
   * 关窗口 = 离开房间。
   *
   * 等待中的房间必须把座位退掉：不然座位一直挂在房里，别人也坐不进来 ——
   * 线上会堆出一排"僵尸房"（曾经真的堆过）。房主退房时服务端会直接解散
   * 整个房间（见 leaveWerewolfRoom），其余人会被送回大厅。
   *
   * 对局中**不退**：关窗口不等于认输，人可能只是误关或想换个窗口再看；
   * 服务端也只在 waiting 阶段按"退房"处理。
   */
  const room = ww.room
  if (room && room.phase === 'waiting' && room.mySeat !== null) {
    void ww.leave(room.id)
  }
  ww.unsubscribe()
})

/** 剩余秒数（没有 deadline 时为 null）。 */
const remainSeconds = computed(() => {
  const deadline = ww.room?.deadline
  if (!deadline) return null
  return Math.max(0, Math.ceil((deadline - nowTick.value) / 1000))
})

// ---------------------------------------------------------------- 反馈特效
//
// 狼人杀的信息密度高（谁死了、天黑了、轮到你、谁被投了），
// 全靠文字读会很累。这里加几处**只做强调、不改变信息**的视觉反馈：
//   1. 阶段切换的整屏横幅（天黑/天亮/投票…），1.6 秒后自动消失；
//   2. 刚出局的座位抖一下、泛红，一眼看到"死的不是别人"；
//   3. 轮到行动时行动栏呼吸发光；
//   4. 票数变化、新日志、新消息、结算面板各自有入场动画。
// 所有动画都尊重 prefers-reduced-motion（见样式区末尾）。

/** 我是不是房主。房主退房 = 解散房间，确认文案必须说清楚。 */
const isHost = computed(() => {
  const room = ww.room
  return !!room && !!auth.user && room.createdBy === auth.user.id
})

interface PhaseBanner {
  key: number
  title: string
  sub: string
  tone: 'night' | 'day' | 'vote' | 'danger'
}

const PHASE_BANNERS: Partial<
  Record<WerewolfPhase, { title: string; sub: (day: number) => string; tone: PhaseBanner['tone'] }>
> = {
  night: { title: '天黑请闭眼', sub: (day) => `第 ${day} 夜 · 狼人请行动`, tone: 'night' },
  'day-announce': { title: '天亮了', sub: (day) => `第 ${day} 天 · 公布昨夜结果`, tone: 'day' },
  'day-discuss': { title: '白天讨论', sub: (day) => `第 ${day} 天 · 聊聊你的判断`, tone: 'day' },
  'day-vote': { title: '投票放逐', sub: (day) => `第 ${day} 天 · 选出你心中的狼人`, tone: 'vote' },
  hunter: { title: '猎人开枪', sub: () => '枪已上膛，有人要一起走', tone: 'danger' },
}

const phaseBanner = ref<PhaseBanner | null>(null)
let bannerTimer: number | null = null
/** 上一次看到的阶段。初始进房（null → 某阶段）不弹横幅。 */
let lastPhase: WerewolfPhase | null = null

watch(
  () => ww.room?.phase ?? null,
  (phase) => {
    if (!phase) {
      lastPhase = null
      return
    }
    if (phase === lastPhase) return
    const previous = lastPhase
    lastPhase = phase
    if (previous === null || phase === 'waiting' || phase === 'finished') return
    const meta = PHASE_BANNERS[phase]
    if (!meta) return
    phaseBanner.value = {
      key: Date.now(),
      title: meta.title,
      sub: meta.sub(ww.room?.day ?? 1),
      tone: meta.tone,
    }
    if (bannerTimer !== null) window.clearTimeout(bannerTimer)
    bannerTimer = window.setTimeout(() => {
      bannerTimer = null
      phaseBanner.value = null
    }, 1600)
  },
)

/** 刚出局的座位（短暂高亮，1.4 秒后自动移除）。 */
const dyingSeats = ref<number[]>([])
const dyingTimers: number[] = []

/** 把"谁活着"压成一个字符串：座位号稳定，改变时才触发对比。 */
const aliveSignature = computed(() =>
  (ww.room?.players ?? []).map((p) => `${p.seat}:${p.alive ? 1 : 0}`).join(','),
)

watch(aliveSignature, (signature, previous) => {
  const room = ww.room
  // 等待阶段座位会前移（有人退房），不能按座位号对比，否则会误判"有人死了"
  if (!room || room.phase === 'waiting' || !previous) return
  const before = new Map(
    previous.split(',').map((part) => {
      const [seat, alive] = part.split(':')
      return [Number(seat), alive === '1'] as const
    }),
  )
  const died = room.players
    .filter((p) => before.get(p.seat) === true && !p.alive)
    .map((p) => p.seat)
  if (died.length === 0) return
  dyingSeats.value = [...dyingSeats.value, ...died]
  dyingTimers.push(
    window.setTimeout(() => {
      dyingSeats.value = dyingSeats.value.filter((s) => !died.includes(s))
    }, 1400),
  )
})

/** 自己出局时给一条明确的通知（光看座位变灰太容易错过）。 */
watch(
  () => ww.dead,
  (dead) => {
    if (dead && ww.room && ww.room.phase !== 'waiting') {
      ui.notify('warning', '你出局了', '可以继续旁观，等这一局结束')
    }
  },
)

// ---------------------------------------------------------------- 展示

function seatName(seat: number | null): string {
  if (seat === null) return '—'
  return ww.room?.players.find((p) => p.seat === seat)?.name ?? `${seat + 1} 号`
}

/** 谁投了谁：把票型聚合成"3 号 ← 1 号、5 号"。 */
function votersOf(seat: number): string[] {
  return (ww.room?.votes ?? [])
    .filter((v) => v.target === seat)
    .map((v) => `${v.voter + 1} 号`)
}

const myChecksDesc = computed(() => {
  const checks = ww.room?.myChecks
  if (!checks) return []
  return checks.map((c) => ({
    seat: c.target,
    name: seatName(c.target),
    team: c.team,
    label: c.team === 'wolf' ? '狼人' : '好人',
    day: c.day,
  }))
})

function leaveRoom(): void {
  const room = ww.room
  if (!room) return
  let hint: string
  if (room.phase === 'waiting') {
    hint = isHost.value
      ? '你是房主，离开会解散这个房间（里面的人都会被送回大厅）。确定吗？'
      : '确定离开这个房间吗？'
  } else if (isHost.value) {
    hint = '对局进行中离开会被当作「出局」处理（房间不会解散，其他人可以继续玩完）。确定吗？'
  } else {
    hint = '对局进行中离开会被当作「出局」处理（其他人可以继续玩完）。确定吗？'
  }
  if (!window.confirm(hint)) return
  void ww.leave(room.id)
}

// ---------------------------------------------------------------- 房内发言

const chatText = ref('')
const chatList = ref<HTMLElement | null>(null)

/**
 * 夜晚且我不是狼：服务端根本不会给我任何狼队消息，面板看起来是空的。
 * 明确显示"天黑了，狼队正在行动"，让人知道是**设计如此**，而不是坏了。
 */
const nightHidden = computed(() => ww.room?.chatScope === 'wolf' && ww.room.myRole !== 'wolf')

const chatPlaceholder = computed(() => {
  const room = ww.room
  if (!room) return ''
  if (room.chatScope === 'wolf') return '和狼队友商量（仅狼队可见）'
  if (room.mySeat === null) return '观战者不能发言'
  if (ww.dead) return '你已出局，不能发言'
  return '说点什么…'
})

async function sendChat(): Promise<void> {
  if (!chatText.value.trim()) return
  const ok = await ww.sendChat(chatText.value)
  if (ok) chatText.value = ''
}

/** 新消息进来后把列表滚到底部。 */
watch(
  () => ww.room?.messages.length ?? 0,
  async () => {
    await nextTick()
    const el = chatList.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function chatTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="ww">
    <!-- ============================================================ 大厅 -->
    <template v-if="!ww.room">
      <header class="ww__head">
        <div>
          <h2 class="ww__title">狼人杀</h2>
          <p class="ww__sub">自定义 6~12 人 · 人齐自动开局 · 白天公开聊天 / 夜晚狼队私聊</p>
        </div>
        <div class="ww__create">
          <input v-model="newTitle" class="wl-input" placeholder="房间名（可留空）" maxlength="40" />
          <select v-model.number="newPlayerCount" class="wl-input ww__count" title="人数">
            <option v-for="n in PLAYER_OPTIONS" :key="n" :value="n">{{ n }} 人</option>
          </select>
          <button class="wl-btn wl-btn--primary" :disabled="creating" @click="createRoom">新建房间</button>
        </div>
      </header>

      <div v-if="ww.loading && ww.rooms.length === 0" class="wl-empty">正在加载…</div>
      <div v-else-if="ww.rooms.length === 0" class="wl-empty">
        <p>还没有房间</p>
        <p class="wl-hint">开一局吧，把房间喊给社团里的人，坐满设定的人数就会自动开始。</p>
      </div>

      <div v-else class="rooms">
        <article v-for="r in ww.rooms" :key="r.id" class="room">
          <div class="room__top">
            <h3 class="room__title">{{ r.title }}</h3>
            <span class="tag" :class="r.phase === 'waiting' ? 'tag--warn' : 'tag--ok'">
              {{ r.phase === 'waiting' ? `${r.players.length}/${r.playerCount} 等人` : PHASE_LABELS[r.phase] }}
            </span>
          </div>
          <div class="room__meta">
            <span>{{ r.creatorName }} 开的</span>
            <span v-if="r.phase !== 'waiting' && r.phase !== 'finished'">第 {{ r.day }} 天</span>
          </div>
          <div class="room__seats">
            <span v-for="p in r.players" :key="p.seat" class="room__dot" :title="p.name ?? ''" />
            <span
              v-for="n in Math.max(0, r.playerCount - r.players.length)"
              :key="'e' + n"
              class="room__dot room__dot--empty"
            />
          </div>
          <button class="wl-btn" @click="ww.join(r.id)">
            {{ r.phase === 'waiting' ? '加入' : '观战' }}
          </button>
        </article>
      </div>
    </template>

    <!-- ============================================================ 房间 -->
    <template v-else>
      <header class="ww__head">
        <div>
          <h2 class="ww__title">{{ ww.room.title }}</h2>
          <p class="ww__sub">
            <span class="tag" :class="ww.room.phase === 'night' ? 'tag--night' : 'tag--ok'">
              {{ PHASE_LABELS[ww.room.phase] }}
            </span>
            <span v-if="ww.room.phase !== 'waiting'">第 {{ ww.room.day }} 天</span>
            <span
              v-if="remainSeconds !== null"
              class="ww__clock"
              :class="{ 'ww__clock--low': remainSeconds <= 10 }"
            >
              {{ remainSeconds }}s
            </span>
            <span v-if="!ww.connected" class="ww__offline">连接已断开</span>
          </p>
        </div>
        <div class="ww__head-actions">
          <button class="wl-btn wl-btn--ghost" @click="ww.closeRoom()">返回大厅</button>
          <button v-if="ww.seated && ww.room.phase !== 'finished'" class="wl-btn wl-btn--danger" @click="leaveRoom">
            离开
          </button>
        </div>
      </header>

      <!-- 阶段切换的整屏提示：只做强调，pointer-events:none 不挡任何操作 -->
      <div
        v-if="phaseBanner"
        :key="phaseBanner.key"
        class="phasefx"
        :class="`phasefx--${phaseBanner.tone}`"
        aria-hidden="true"
      >
        <span class="phasefx__ring" />
        <p class="phasefx__title">{{ phaseBanner.title }}</p>
        <p class="phasefx__sub">{{ phaseBanner.sub }}</p>
      </div>

      <!-- 等待阶段：显示还差几个人 -->
      <div v-if="ww.room.phase === 'waiting'" class="ww__banner">
        <span>
          还差 {{ Math.max(0, ww.room.playerCount - ww.room.players.length) }} 个人就能开局（本局
          {{ ww.room.playerCount }} 人）
        </span>
        <span class="ww__banner-hint">房主离开会解散房间</span>
      </div>

      <div class="ww__body">
        <!-- ---------------------------------------------- 座位 -->
        <section class="board">
          <div class="seats">
            <button
              v-for="p in ww.room.players"
              :key="p.seat"
              class="seat"
              :class="seatClass(p)"
              :disabled="!ww.room.canAct || !ww.room.legalTargets.includes(p.seat)"
              @click="clickSeat(p.seat)"
            >
              <span class="seat__no">{{ p.seat + 1 }}</span>
              <span class="seat__name">{{ p.name ?? '空位' }}</span>
              <span v-if="!p.alive" class="seat__dead">出局</span>
              <span v-else-if="!p.online" class="seat__off">离线</span>
              <span v-if="ww.room.mySeat === p.seat" class="seat__me">我</span>
              <span v-if="(ww.room.teammates ?? []).includes(p.seat)" class="seat__pack">狼队友</span>
              <span
                v-if="votersOf(p.seat).length"
                :key="votersOf(p.seat).join('、')"
                class="seat__votes"
              >
                {{ votersOf(p.seat).join('、') }} 投
              </span>
            </button>
          </div>

          <!-- 公开日志 -->
          <div class="log wl-scroll">
            <div class="log__head">公开记录</div>
            <p v-if="ww.room.log.length === 0" class="wl-hint">还没有记录</p>
            <p
              v-for="entry in [...ww.room.log].reverse()"
              :key="`${entry.at}:${entry.text}`"
              class="log__row"
              :class="`log__row--${entry.kind}`"
            >
              <span class="log__day">D{{ entry.day }}</span>
              {{ entry.text }}
            </p>
          </div>
        </section>

        <!-- ---------------------------------------------- 侧栏 -->
        <aside class="side wl-scroll">
          <!-- 我的身份 -->
          <div v-if="ww.room.myRole" class="card card--role" :class="`card--${ww.room.myTeam}`">
            <div class="card__head">
              <span class="card__role">{{ ww.room.myRoleLabel }}</span>
              <span class="tag" :class="ww.room.myTeam === 'wolf' ? 'tag--bad' : 'tag--ok'">
                {{ ww.room.myTeam === 'wolf' ? '狼人阵营' : '好人阵营' }}
              </span>
            </div>
            <p class="card__hint">{{ ROLE_HINTS[ww.room.myRole] ?? '' }}</p>

            <div v-if="ww.myWolfPack.length" class="card__row">
              <span class="card__label">队友</span>
              <span>{{ ww.myWolfPack.map((s) => s + 1).join('、') }} 号</span>
            </div>

            <div v-if="myChecksDesc.length" class="card__row card__row--col">
              <span class="card__label">查验记录</span>
              <div v-for="c in myChecksDesc" :key="c.seat" class="check">
                第 {{ c.day }} 天查 {{ c.seat + 1 }} 号：
                <b :class="c.team === 'wolf' ? 'is-wolf' : 'is-good'">{{ c.label }}</b>
              </div>
            </div>

            <div v-if="ww.room.myPotions" class="card__row">
              <span class="card__label">药水</span>
              <span>
                解药{{ ww.room.myPotions.heal ? '有' : '已用' }} · 毒药{{ ww.room.myPotions.poison ? '有' : '已用' }}
              </span>
            </div>

            <div v-if="ww.room.witchNightVictim !== null" class="card__row card__row--warn">
              <span class="card__label">今晚被刀</span>
              <span>{{ seatName(ww.room.witchNightVictim) }}</span>
            </div>
          </div>

          <div v-else-if="!ww.seated" class="card">
            <div class="card__head"><span class="card__role">观战中</span></div>
            <p class="card__hint">你看得到所有公开信息，但看不到任何人的身份 —— 这一局里没有"上帝视角"。</p>
          </div>

          <div v-else class="card">
            <div class="card__head"><span class="card__role">等待开局</span></div>
            <p class="card__hint">人坐满 {{ ww.room.playerCount }} 个位子后会自动分配身份并进入第一夜。</p>
          </div>

          <!-- 板子 -->
          <div class="card">
            <div class="card__head"><span class="card__role">本局板子</span></div>
            <div class="board-list">
              <span v-for="b in ww.room.board" :key="b.role" class="board-list__item">
                {{ b.label }} × {{ b.count }}
              </span>
            </div>
          </div>

          <!-- 房内发言 -->
          <div class="card card--chat">
            <div class="card__head">
              <span class="card__role">{{ ww.room.chatScope === 'wolf' ? '狼队频道' : '房内发言' }}</span>
              <span v-if="ww.room.chatScope === 'wolf'" class="tag tag--bad">仅狼可见</span>
            </div>

            <!-- 夜晚且我不是狼：服务端不会给我狼队消息，明确说明是设计如此 -->
            <div v-if="nightHidden" class="chat__hidden">
              <p class="chat__hidden-title">天黑了，狼队正在行动</p>
              <p class="chat__hidden-hint">夜晚只有狼人能看到房内消息，天亮后会恢复公开。</p>
            </div>

            <template v-else>
              <div ref="chatList" class="chat__list wl-scroll">
                <p v-if="ww.room.messages.length === 0" class="wl-hint">
                  {{ ww.room.chatScope === 'wolf' ? '商量一下今晚刀谁吧。' : '还没有人发言。' }}
                </p>
                <div
                  v-for="m in ww.room.messages"
                  :key="m.id"
                  class="chat__msg"
                  :class="{ 'chat__msg--wolf': m.scope === 'wolf' }"
                >
                  <span class="chat__who">{{ m.seat + 1 }}号 {{ m.name }}</span>
                  <span class="chat__time">{{ chatTime(m.at) }}</span>
                  <span class="chat__text">{{ m.text }}</span>
                </div>
              </div>

              <div class="chat__input">
                <input
                  v-model="chatText"
                  class="wl-input"
                  :placeholder="chatPlaceholder"
                  :disabled="!ww.room.canChat || ww.submitting"
                  maxlength="200"
                  @keyup.enter="sendChat"
                />
                <button
                  class="wl-btn wl-btn--primary"
                  :disabled="!ww.room.canChat || !chatText.trim() || ww.submitting"
                  @click="sendChat"
                >
                  发送
                </button>
              </div>
            </template>
          </div>
        </aside>
      </div>

      <!-- ---------------------------------------------- 行动栏 -->
      <footer
        v-if="ww.room.phase !== 'finished'"
        class="actionbar"
        :class="{ 'actionbar--act': ww.room.canAct }"
      >
        <template v-if="ww.room.canAct">
          <span class="actionbar__ping" aria-hidden="true" />
          <span class="actionbar__label">{{ ACTION_LABELS[ww.room.actionKind ?? ''] ?? '轮到你行动' }}</span>
          <span v-if="ww.selectedTarget !== null" class="actionbar__picked">
            已选：{{ seatName(ww.selectedTarget) }}
          </span>
          <button class="wl-btn wl-btn--primary" :disabled="!canSubmit || ww.submitting" @click="ww.act()">
            确认
          </button>
          <button v-if="ww.room.canAbstain" class="wl-btn wl-btn--ghost" :disabled="ww.submitting" @click="ww.abstain()">
            {{ ww.room.actionKind === 'witch' ? '不用药' : '弃票' }}
          </button>
        </template>
        <template v-else-if="ww.dead">
          <span class="actionbar__label actionbar__label--muted">你已经出局了，安静看戏</span>
        </template>
        <template v-else-if="ww.seated">
          <span class="actionbar__label actionbar__label--muted">
            {{
              ww.room.phase === 'night'
                ? '天黑了，等待其他人行动…'
                : ww.room.phase === 'waiting'
                  ? '等更多玩家加入'
                  : '等待其他人…'
            }}
          </span>
          <span v-if="ww.room.acted" class="actionbar__picked">你本阶段已完成</span>
        </template>
        <template v-else>
          <span class="actionbar__label actionbar__label--muted">观战中</span>
        </template>
      </footer>

      <!-- ---------------------------------------------- 结算 -->
      <div v-if="ww.room.phase === 'finished' && ww.room.winner" class="over">
        <div class="over__panel" :class="ww.room.winner === 'wolf' ? 'over__panel--wolf' : 'over__panel--good'">
          <h2 class="over__title">{{ ww.room.winner === 'wolf' ? '狼人获胜' : '好人获胜' }}</h2>
          <p class="over__reason">{{ ww.room.finishReason ?? '' }}</p>
          <button class="wl-btn wl-btn--primary" @click="ww.closeRoom()">返回大厅</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ww {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 16px;
  gap: 12px;
  position: relative;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 顶栏 */
.ww__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.ww__title {
  margin: 0 0 4px;
  font-size: 17px;
}
.ww__sub {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.ww__clock {
  font-variant-numeric: tabular-nums;
  color: var(--warning, #d99a2b);
}
.ww__offline {
  color: var(--danger, #d9534f);
}
.ww__head-actions {
  display: flex;
  gap: 8px;
}
.ww__create {
  display: flex;
  gap: 8px;
}
.ww__create .wl-input {
  width: 180px;
}
.ww__banner {
  flex-shrink: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--warning, #d99a2b) 14%, transparent);
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 大厅 */
.rooms {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  align-content: start;
}
.room {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.room__top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.room__title {
  margin: 0;
  font-size: 14px;
}
.room__meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  color: var(--fg-dim);
}
.room__seats {
  display: flex;
  gap: 3px;
}
.room__dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--accent, #4a8cff);
}
.room__dot--empty {
  background: var(--line);
}

/* ---------------------------------------------------------------- 主体 */
.ww__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 290px;
  gap: 12px;
}
.board {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.seats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  flex-shrink: 0;
}
.seat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 8px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  color: var(--fg);
  cursor: default;
  transition:
    border-color 0.15s,
    transform 0.15s;
}
.seat--selectable {
  cursor: pointer;
  border-color: color-mix(in srgb, var(--accent, #4a8cff) 45%, transparent);
}
.seat--selectable:hover {
  transform: translateY(-1px);
}
.seat--selected {
  border-color: var(--accent, #4a8cff);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4a8cff) 35%, transparent);
}
.seat--me {
  background: color-mix(in srgb, var(--accent, #4a8cff) 12%, var(--surface-1));
}
.seat--pack {
  border-color: color-mix(in srgb, var(--danger, #d9534f) 50%, transparent);
}
.seat--dead {
  opacity: 0.45;
  text-decoration: line-through;
}
.seat__no {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.seat__name {
  font-size: 12px;
}
.seat__dead,
.seat__off,
.seat__me,
.seat__pack,
.seat__votes {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
}
.seat__dead {
  background: color-mix(in srgb, var(--danger, #d9534f) 18%, transparent);
  color: var(--danger, #d9534f);
}
.seat__off {
  color: var(--fg-dim);
}
.seat__me {
  background: color-mix(in srgb, var(--accent, #4a8cff) 20%, transparent);
  color: var(--accent, #4a8cff);
}
.seat__pack {
  background: color-mix(in srgb, var(--danger, #d9534f) 18%, transparent);
  color: var(--danger, #d9534f);
}
.seat__votes {
  color: var(--fg-dim);
}

/* ---------------------------------------------------------------- 日志 */
.log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  font-size: 12px;
}
.log__head {
  font-size: 11.5px;
  color: var(--fg-dim);
  margin-bottom: 6px;
}
.log__row {
  margin: 0 0 5px;
  line-height: 1.5;
}
.log__day {
  display: inline-block;
  min-width: 26px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.log__row--death,
.log__row--shot {
  color: var(--danger, #d9534f);
}
.log__row--end {
  font-weight: 600;
}

/* ---------------------------------------------------------------- 侧栏 */
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}
.card {
  padding: 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  font-size: 12px;
}
.card--wolf {
  border-color: color-mix(in srgb, var(--danger, #d9534f) 45%, transparent);
}
.card--good {
  border-color: color-mix(in srgb, var(--success, #3aa76d) 45%, transparent);
}
.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.card__role {
  font-size: 15px;
  font-weight: 650;
}
.card__hint {
  margin: 0 0 8px;
  color: var(--fg-dim);
  line-height: 1.55;
}
.card__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  border-top: 1px solid var(--line);
}
.card__row--col {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.card__row--warn {
  color: var(--warning, #d99a2b);
}
.card__label {
  color: var(--fg-dim);
  flex-shrink: 0;
}
.check {
  font-size: 11.5px;
}
.is-wolf {
  color: var(--danger, #d9534f);
}
.is-good {
  color: var(--success, #3aa76d);
}
.board-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.board-list__item {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
}

/* ---------------------------------------------------------------- 房内发言 */
.ww__count {
  width: 92px;
}
.card--chat {
  display: flex;
  flex-direction: column;
}
.chat__list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}
.chat__msg {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  line-height: 1.5;
}
.chat__who {
  color: var(--fg-dim);
  font-size: 11px;
  flex-shrink: 0;
}
.chat__time {
  color: var(--fg-dim);
  font-size: 10px;
  flex-shrink: 0;
}
.chat__text {
  flex-basis: 100%;
  word-break: break-word;
}
.chat__msg--wolf .chat__who,
.chat__msg--wolf .chat__text {
  color: var(--danger, #d9534f);
}
.chat__hidden {
  padding: 14px 10px;
  text-align: center;
  border-radius: 8px;
  background: color-mix(in srgb, #6a5acd 14%, transparent);
}
.chat__hidden-title {
  margin: 0 0 4px;
  font-weight: 600;
}
.chat__hidden-hint {
  margin: 0;
  font-size: 11px;
  color: var(--fg-dim);
}
.chat__input {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.chat__input .wl-input {
  flex: 1;
  min-width: 0;
}

/* ---------------------------------------------------------------- 标签 */
.tag {
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.tag--ok {
  background: color-mix(in srgb, var(--success, #3aa76d) 16%, transparent);
  color: var(--success, #3aa76d);
}
.tag--warn {
  background: color-mix(in srgb, var(--warning, #d99a2b) 16%, transparent);
  color: var(--warning, #d99a2b);
}
.tag--bad {
  background: color-mix(in srgb, var(--danger, #d9534f) 16%, transparent);
  color: var(--danger, #d9534f);
}
.tag--night {
  background: color-mix(in srgb, #6a5acd 22%, transparent);
  color: #a99cf0;
}

/* ---------------------------------------------------------------- 行动栏 */
.actionbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.actionbar__label {
  font-size: 13px;
  font-weight: 600;
}
.actionbar__label--muted {
  font-weight: 400;
  color: var(--fg-dim);
}
.actionbar__picked {
  font-size: 12px;
  color: var(--accent, #4a8cff);
}
.actionbar .wl-btn {
  margin-left: auto;
}
.actionbar .wl-btn + .wl-btn {
  margin-left: 0;
}

/* ---------------------------------------------------------------- 结算 */
.over {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.over__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 40px;
  border-radius: 14px;
  background: var(--surface-raised);
  border: 1px solid var(--line);
}
.over__panel--wolf {
  border-color: color-mix(in srgb, var(--danger, #d9534f) 55%, transparent);
}
.over__panel--good {
  border-color: color-mix(in srgb, var(--success, #3aa76d) 55%, transparent);
}
.over__title {
  margin: 0;
  font-size: 24px;
}
.over__reason {
  margin: 0;
  color: var(--fg-dim);
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 反馈动效 */

/* 轮到你行动：行动栏呼吸发光 + 左侧小圆点脉冲 */
.actionbar--act {
  border-color: color-mix(in srgb, var(--accent, #4a8cff) 55%, transparent);
  animation: ww-act-glow 1.8s ease-in-out infinite;
}
.actionbar__ping {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--accent, #4a8cff);
  animation: ww-ping 1.4s ease-out infinite;
}
@keyframes ww-act-glow {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent, #4a8cff) 0%, transparent);
  }
  50% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #4a8cff) 22%, transparent);
  }
}
@keyframes ww-ping {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent, #4a8cff) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 7px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* 倒计时进入最后 10 秒：变红并脉冲 */
.ww__clock--low {
  color: var(--danger, #d9534f);
  font-weight: 700;
  animation: ww-clock 1s ease-in-out infinite;
}
@keyframes ww-clock {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* 刚出局的座位：抖一下 + 红光（1.4 秒后类被移除） */
.seat--dying {
  z-index: 2;
  border-color: var(--danger, #d9534f) !important;
  animation: ww-seat-death 0.55s ease-out;
}
@keyframes ww-seat-death {
  0% {
    transform: translateX(0);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger, #d9534f) 70%, transparent);
  }
  20% {
    transform: translateX(-5px);
  }
  40% {
    transform: translateX(4px);
  }
  60% {
    transform: translateX(-3px);
  }
  80% {
    transform: translateX(2px);
  }
  100% {
    transform: translateX(0);
    box-shadow: 0 0 24px 4px transparent;
  }
}

/* 票数变化：弹一下（key 变了才会重播） */
.seat__votes {
  animation: ww-vote-pop 0.28s ease-out;
}
@keyframes ww-vote-pop {
  0% {
    transform: scale(0.6);
    opacity: 0.3;
  }
  60% {
    transform: scale(1.14);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* 新日志 / 新发言入场 */
.log__row,
.chat__msg {
  animation: ww-fade-up 0.22s ease-out;
}
@keyframes ww-fade-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 结算面板：淡入 + 轻微放大，赢家标题发光 */
.over {
  animation: ww-overlay-in 0.24s ease-out;
}
.over__panel {
  animation: ww-panel-in 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.1);
}
.over__panel--wolf .over__title {
  color: var(--danger, #d9534f);
  text-shadow: 0 0 18px color-mix(in srgb, var(--danger, #d9534f) 55%, transparent);
}
.over__panel--good .over__title {
  color: var(--success, #3aa76d);
  text-shadow: 0 0 18px color-mix(in srgb, var(--success, #3aa76d) 55%, transparent);
}
@keyframes ww-overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes ww-panel-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 阶段横幅：夜间冷紫 / 白天暖黄 / 投票粉紫 / 猎人红 */
.phasefx {
  position: absolute;
  inset: 0;
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none; /* 绝不能挡住点座位/按钮 */
  background: radial-gradient(
    circle at 50% 45%,
    rgba(8, 10, 20, 0.82),
    rgba(8, 10, 20, 0.55) 55%,
    transparent 78%
  );
  animation: ww-phase-bg 1.6s ease-out both;
}
.phasefx__ring {
  position: absolute;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  border: 2px solid currentColor;
  opacity: 0;
  animation: ww-phase-ring 1.4s ease-out;
}
.phasefx__title {
  position: relative;
  margin: 0;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 3px;
  animation: ww-phase-title 0.5s cubic-bezier(0.2, 0.9, 0.25, 1.1) both;
}
.phasefx__sub {
  position: relative;
  margin: 0;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.72);
  letter-spacing: 1px;
  animation: ww-phase-title 0.5s 0.08s cubic-bezier(0.2, 0.9, 0.25, 1.1) both;
}
.phasefx--night {
  color: #a99cf0;
}
.phasefx--day {
  color: #f2c14e;
}
.phasefx--vote {
  color: #d98cab;
}
.phasefx--danger {
  color: #f07a72;
}
@keyframes ww-phase-bg {
  0% {
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  78% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes ww-phase-title {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.94);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes ww-phase-ring {
  0% {
    transform: scale(0.62);
    opacity: 0.55;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

/* 等待横幅：右侧给"房主离开会解散房间"留个提示位 */
.ww__banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ww__banner-hint {
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
}

/* 尊重系统的"减少动态效果"偏好 */
@media (prefers-reduced-motion: reduce) {
  .actionbar--act,
  .actionbar__ping,
  .ww__clock--low,
  .seat--dying,
  .seat__votes,
  .log__row,
  .chat__msg,
  .over,
  .over__panel,
  .phasefx,
  .phasefx__ring,
  .phasefx__title,
  .phasefx__sub {
    animation: none !important;
  }
  .phasefx {
    background: rgba(8, 10, 20, 0.8);
  }
}

/* ================================================================
   整体 UI 升级（评审团定稿）· 降噪覆盖层
   ================================================================ */

/* 房间卡：发丝描边 + 轻阴影；座位点改小圆点 */
.room {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 14px;
  gap: 10px;
}

.room__title {
  font-size: var(--fs-subtitle);
  font-weight: 600;
}

.room__meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.room__dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.room__dot--empty {
  background: var(--surface-3);
}

/* 座位卡：统一 8px 圆角与发丝描边 */
.seat {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
}
</style>
