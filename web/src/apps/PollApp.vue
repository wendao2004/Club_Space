<!--
  投票 / 约时间。

  一个卡片一个投票：点选项即投票（再点即改票），结果条与投票人实时刷新
  （服务端广播 poll 事件）。创建表单折叠在顶部，不用时收起来。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import type { Poll } from '@/api'
import { usePoll } from '@/stores/poll'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

defineProps<{ win: WindowInstance }>()

const poll = usePoll()
const auth = useAuth()
const ui = useUi()

// ---------------------------------------------------------------- 创建表单

const creating = ref(false)
const draftTitle = ref('')
const draftDesc = ref('')
const draftMulti = ref(false)
const draftOptions = ref<string[]>(['', ''])
/** 截止时长（毫秒）；0 = 不限时。给固定档位而不是自由输入 —— 约 time 的场景就这几种。 */
const draftDeadline = ref(0)
const DEADLINE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限时' },
  { value: 60 * 60_000, label: '1 小时' },
  { value: 24 * 60 * 60_000, label: '1 天' },
  { value: 3 * 24 * 60 * 60_000, label: '3 天' },
  { value: 7 * 24 * 60 * 60_000, label: '7 天' },
]

const canSubmit = computed(() => {
  const options = draftOptions.value.map((o) => o.trim()).filter(Boolean)
  return draftTitle.value.trim().length > 0 && options.length >= 2
})

function addOption(): void {
  if (draftOptions.value.length < 20) draftOptions.value.push('')
}

function removeOption(idx: number): void {
  if (draftOptions.value.length > 2) draftOptions.value.splice(idx, 1)
}

async function submitPoll(): Promise<void> {
  if (!canSubmit.value || poll.submitting) return
  const ok = await poll.create({
    title: draftTitle.value,
    description: draftDesc.value,
    multi: draftMulti.value,
    options: draftOptions.value.map((o) => o.trim()).filter(Boolean),
    deadlineInMs: draftDeadline.value > 0 ? draftDeadline.value : null,
  })
  if (ok) {
    draftTitle.value = ''
    draftDesc.value = ''
    draftMulti.value = false
    draftOptions.value = ['', '']
    draftDeadline.value = 0
    creating.value = false
  } else if (poll.error) {
    ui.notify('error', '创建投票失败', poll.error)
  }
}

// ---------------------------------------------------------------- 投票与结果

/**
 * 点选项即投票。
 *
 * 多选：点一下 = 切换该项（把勾选列表全量提交）；单选：点了就换票。
 * 已截止/已关闭时整卡只读。
 */
async function toggleOption(p: Poll, idx: number): Promise<void> {
  if (isClosed(p)) return
  let next: number[]
  if (p.multi) {
    next = p.myVotes.includes(idx) ? p.myVotes.filter((i) => i !== idx) : [...p.myVotes, idx]
  } else {
    // 单选再点同一个 = 取消？不 —— 约时间场景"我到底行不行"必须有个答案，
    // 保留最后一票，想弃权去点另一个或者让创建者关掉
    next = [idx]
  }
  const ok = await poll.vote(p.id, next)
  if (!ok && poll.error) ui.notify('error', '投票失败', poll.error)
}

/**
 * 每 30 秒推一下"现在"。
 *
 * 截止是**时间驱动**的状态：用户开着窗口不动，到点之后卡片应该自己变成
 * "已截止"、投票按钮变灰。之前所有判断都直接用 Date.now()，Vue 不知道
 * 时间过了，界面一直是"进行中"，直到用户点一下才刷新（点了还会报错
 * "已经截止"）—— 自相矛盾的体验。
 */
const now = ref(Date.now())
const tick = window.setInterval(() => {
  now.value = Date.now()
}, 30_000)
onBeforeUnmount(() => window.clearInterval(tick))

function isClosed(p: Poll): boolean {
  // 读一下 now.value 建立响应式依赖，时间推进后模板会重算
  return p.closedAt !== null || (p.deadlineAt !== null && now.value >= p.deadlineAt)
}

function statusOf(p: Poll): { label: string; tone: 'ok' | 'warning' | 'muted' } {
  if (p.closedAt !== null) return { label: '已关闭', tone: 'muted' }
  if (p.deadlineAt !== null && now.value >= p.deadlineAt) return { label: '已截止', tone: 'muted' }
  return { label: '进行中', tone: 'ok' }
}

/** 进行中的个数（响应式版，替换 store 里那个用 Date.now() 的 getter）。 */
const openCount = computed(
  () => poll.polls.filter((p) => p.closedAt === null && (p.deadlineAt === null || now.value < p.deadlineAt)).length,
)

/** 截止时间的人话表达。 */
function deadlineText(p: Poll): string {
  if (p.deadlineAt === null) return ''
  const diff = p.deadlineAt - now.value
  if (diff <= 0) return `截止于 ${fullTime(p.deadlineAt)}`
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟后截止`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时后截止`
  return `${Math.floor(hour / 24)} 天后截止`
}

async function closePoll(id: string, closed: boolean): Promise<void> {
  if (closed && !window.confirm('关闭后大家不能再投票，确定？')) return
  await poll.setClosed(id, closed)
}

async function removePoll(p: Poll): Promise<void> {
  if (!window.confirm(`删除投票「${p.title}」？所有投票记录一起删除，不可恢复。`)) return
  await poll.remove(p.id)
}

function fullTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return fullTime(ts)
}

onMounted(() => {
  poll.connectRealtime()
  void poll.load()
})

watch(
  () => poll.error,
  (err) => {
    if (err) ui.notify('error', '投票', err)
  },
)
</script>

<template>
  <div class="poll-app">
    <header class="bar">
      <div class="bar-title"><Icon name="vote" :size="18" />投票</div>
      <span v-if="openCount > 0" class="wl-badge wl-badge--ok">{{ openCount }} 个进行中</span>
      <div class="spacer" />
      <button class="wl-icon-btn" :disabled="poll.loading" title="刷新" @click="poll.load()">
        <Icon name="refresh" :size="16" :class="{ spin: poll.loading }" />
      </button>
      <button class="wl-btn wl-btn--primary" @click="creating = !creating">
        <Icon name="plus" :size="14" />{{ creating ? '收起' : '发起投票' }}
      </button>
    </header>

    <!-- 创建表单 -->
    <section v-if="creating" class="compose">
      <input v-model="draftTitle" class="wl-input" placeholder="投票标题（比如：这周六团建去哪儿）" maxlength="100" />
      <input v-model="draftDesc" class="wl-input" placeholder="补充说明（可空）" maxlength="500" />
      <div class="opt-list">
        <div v-for="(opt, i) in draftOptions" :key="i" class="opt-row">
          <span class="opt-idx">{{ i + 1 }}</span>
          <input
            v-model="draftOptions[i]"
            class="wl-input"
            :placeholder="`选项 ${i + 1}`"
            maxlength="60"
            @keydown.enter.prevent="i === draftOptions.length - 1 && addOption()"
          />
          <button
            v-if="draftOptions.length > 2"
            class="wl-icon-btn"
            title="删掉这个选项"
            @click="removeOption(i)"
          >
            <Icon name="minus" :size="14" />
          </button>
        </div>
      </div>
      <div class="compose-row">
        <button class="wl-icon-btn" title="加一个选项" @click="addOption"><Icon name="plus" :size="14" /></button>
        <label class="check"><input v-model="draftMulti" type="checkbox" />可多选</label>
        <select v-model.number="draftDeadline" class="wl-input wl-input--auto">
          <option v-for="o in DEADLINE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div class="spacer" />
        <button class="wl-btn wl-btn--primary" :disabled="!canSubmit || poll.submitting" @click="submitPoll">
          发布
        </button>
      </div>
      <p class="compose-hint">至少两个不同选项；Enter 跳到下一个选项</p>
    </section>

    <!-- 筛选 -->
    <div class="filter">
      <button class="wl-btn wl-btn--sm" :class="{ 'wl-btn--on': !poll.openOnly }" @click="poll.setFilter(false)">
        全部
      </button>
      <button class="wl-btn wl-btn--sm" :class="{ 'wl-btn--on': poll.openOnly }" @click="poll.setFilter(true)">
        进行中
      </button>
    </div>

    <!-- 列表 -->
    <div class="list">
      <p v-if="poll.polls.length === 0 && !poll.loading" class="empty">还没有投票，点右上角「发起投票」来一个</p>

      <article v-for="p in poll.polls" :key="p.id" class="card" :class="{ 'card--closed': isClosed(p) }">
        <header class="card-head">
          <strong class="card-title">{{ p.title }}</strong>
          <span class="wl-badge" :class="statusOf(p).tone === 'ok' ? 'wl-badge--ok' : 'wl-badge--muted'">
            {{ statusOf(p).label }}
          </span>
          <span v-if="p.multi" class="wl-badge wl-badge--muted">多选</span>
          <div class="spacer" />
          <template v-if="p.canManage">
            <button v-if="p.closedAt === null && !isClosed(p)" class="wl-btn wl-btn--sm" @click="closePoll(p.id, true)">
              关闭
            </button>
            <button v-else-if="p.closedAt !== null" class="wl-btn wl-btn--sm" @click="closePoll(p.id, false)">
              重开
            </button>
            <button class="wl-icon-btn" title="删除投票" @click="removePoll(p)">
              <Icon name="trash" :size="14" />
            </button>
          </template>
        </header>
        <p v-if="p.description" class="card-desc">{{ p.description }}</p>
        <p class="card-meta">
          {{ p.creatorName }} 发起于 {{ relativeTime(p.createdAt) }} · {{ p.totalVoters }} 人已投
          <template v-if="p.deadlineAt !== null"> · {{ deadlineText(p) }}</template>
        </p>

        <div class="opts">
          <button
            v-for="opt in p.options"
            :key="opt.idx"
            class="opt"
            :class="{
              'opt--mine': p.myVotes.includes(opt.idx),
              'opt--dead': isClosed(p),
            }"
            :disabled="isClosed(p)"
            @click="toggleOption(p, opt.idx)"
          >
            <span class="opt-main">
              <Icon v-if="p.myVotes.includes(opt.idx)" name="check" :size="14" class="opt-check" />
              <span class="opt-text">{{ opt.text }}</span>
              <span class="opt-count">{{ opt.count }}</span>
            </span>
            <span class="opt-bar" :style="{ width: p.totalVoters ? `${(opt.count / p.totalVoters) * 100}%` : '0' }" />
            <span v-if="opt.voters.length > 0" class="opt-voters">{{ opt.voters.map((v) => v.name).join('、') }}</span>
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.poll-app {
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

/* ---------------- 创建表单 */

.compose {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.opt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.opt-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.opt-idx {
  width: 18px;
  text-align: right;
  font-size: 12px;
  color: var(--text-tertiary);
  flex: none;
}

.compose-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.compose-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

.wl-input--auto {
  width: auto;
}

/* ---------------- 筛选与列表 */

.filter {
  flex: none;
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.empty {
  margin: auto;
  color: var(--text-tertiary);
  font-size: 13px;
}

.card {
  border: 1px solid var(--line-hair);
  border-radius: 10px;
  padding: var(--space-3);
  background: var(--surface-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.card--closed {
  opacity: 0.75;
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-title {
  font-size: 14px;
}

.card-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.card-meta {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ---------------- 选项 */

.opts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.opt {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border: 1px solid var(--line-hair);
  border-radius: 8px;
  background: var(--surface-2);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.opt:hover:not(:disabled) {
  border-color: var(--accent);
}

.opt--mine {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

.opt--dead {
  cursor: default;
}

.opt-main {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.opt-check {
  color: var(--accent);
  flex: none;
}

.opt-text {
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opt-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  flex: none;
}

/* 结果条垫在文字底下，宽度 = 得票占比 */
.opt-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: 7px;
  transition: width 0.25s ease;
}

.opt-voters {
  position: relative;
  z-index: 1;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .opt-voters {
    display: none;
  }
}
</style>
