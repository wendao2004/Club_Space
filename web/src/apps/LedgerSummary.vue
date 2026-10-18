<!--
  记账统计面板（纯展示）。

  刻意不发请求、不持有业务状态：数据由 LedgerApp 拉好之后通过 props 传进来，
  这样统计窗口可以随时挂载/切换而不会多打一次后端，也方便在同一份数据上做多视图。

  金额一律当字符串搬运，只在必要的占比计算里用整数「分」做除法，
  绝不把 "12.50" parseFloat 成浮点数再运算 —— 那样几十笔之后账就差出来了。
-->
<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { useAuth } from '@/stores/auth'
import type { LedgerSummary, LedgerDebt } from '@/api'

const props = defineProps<{
  summary: LedgerSummary | null
  debts: LedgerDebt[]
  loading?: boolean
}>()

const auth = useAuth()

/** "12.50" → "¥12.50"；"-3.20" → "-¥3.20"。只做前后缀拼接，不动数值本身。 */
function yuan(value: string): string {
  return value.startsWith('-') ? `-¥${value.slice(1)}` : `¥${value}`
}

/** 把一组分类按 kind 拆出来，并按金额从大到小排，附带整数分算出的占比。 */
function groupByKind(kind: 'income' | 'expense'): Array<{
  name: string
  icon: string | null
  totalCents: number
  total: string
  count: number
  pct: number
}> {
  const rows = (props.summary?.byCategory ?? [])
    .filter((item) => item.kind === kind)
    .slice()
    .sort((a, b) => b.totalCents - a.totalCents)
  const sumCents = rows.reduce((acc, item) => acc + item.totalCents, 0)
  return rows.map((item) => ({
    name: item.name,
    icon: item.icon,
    totalCents: item.totalCents,
    total: item.total,
    count: item.count,
    // 占比用整数分相除，避免字符串金额转浮点后的累计误差。
    pct: sumCents > 0 ? (item.totalCents / sumCents) * 100 : 0,
  }))
}

const expenseRows = computed(() => groupByKind('expense'))
const incomeRows = computed(() => groupByKind('income'))

/** 月度趋势：按月份倒序取最近 6 个月。 */
const months = computed(() =>
  (props.summary?.byMonth ?? [])
    .slice()
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 6),
)

/** 收入段 / 支出段各自按本组最大值归一化（空集时兜底为 1，避免除零）。 */
const maxIncomeCents = computed(() => Math.max(1, ...months.value.map((m) => m.incomeCents)))
const maxExpenseCents = computed(() => Math.max(1, ...months.value.map((m) => m.expenseCents)))

function incomeWidth(cents: number): string {
  return `${Math.min(100, (cents / maxIncomeCents.value) * 100)}%`
}

function expenseWidth(cents: number): string {
  return `${Math.min(100, (cents / maxExpenseCents.value) * 100)}%`
}

/** 欠款人是当前登录用户时高亮该行 —— 提醒"这笔该你给了"。 */
function isMine(debt: LedgerDebt): boolean {
  return auth.user !== null && debt.userId === auth.user.id
}
</script>

<template>
  <div class="sum wl-scroll">
    <!-- 1. 三个统计卡片 -->
    <section class="sum__stats">
      <template v-if="loading && !summary">
        <div v-for="n in 3" :key="n" class="wl-card stat stat--skeleton">
          <span class="sk sk--sm" />
          <span class="sk sk--lg" />
        </div>
      </template>

      <div v-else-if="!summary" class="sum__none">
        <Icon name="chart" :size="26" />
        <p>暂无数据</p>
      </div>

      <template v-else>
        <div class="wl-card stat">
          <span class="stat__label">收入</span>
          <span class="stat__value stat__value--success">{{ yuan(summary.income) }}</span>
        </div>
        <div class="wl-card stat">
          <span class="stat__label">支出</span>
          <span class="stat__value stat__value--danger">{{ yuan(summary.expense) }}</span>
        </div>
        <div class="wl-card stat">
          <span class="stat__label">结余</span>
          <span
            class="stat__value"
            :class="summary.balanceCents < 0 ? 'stat__value--danger' : 'stat__value--success'"
          >
            {{ yuan(summary.balance) }}
          </span>
        </div>
      </template>
    </section>

    <p v-if="summary" class="sum__count">共 {{ summary.entryCount }} 笔已确认账目</p>

    <!-- 2. 按分类的分布 -->
    <section v-if="summary" class="wl-card sec">
      <header class="sec__head">
        <Icon name="list" :size="15" />
        <h3 class="sec__title">支出构成</h3>
      </header>

      <p v-if="expenseRows.length === 0" class="sec__empty">暂无记录</p>
      <ul v-else class="cats">
        <li v-for="(row, index) in expenseRows" :key="index" class="cat">
          <div class="cat__head">
            <Icon :name="row.icon || 'file'" :size="15" class="cat__icon" />
            <span class="cat__name">{{ row.name }}</span>
            <span class="cat__amount">{{ yuan(row.total) }}</span>
            <span class="cat__count">{{ row.count }} 笔</span>
          </div>
          <div class="cat__track">
            <div class="cat__fill cat__fill--expense" :style="{ width: `${row.pct}%` }" />
          </div>
        </li>
      </ul>

      <header class="sec__head sec__head--gap">
        <Icon name="list" :size="15" />
        <h3 class="sec__title">收入构成</h3>
      </header>

      <p v-if="incomeRows.length === 0" class="sec__empty">暂无记录</p>
      <ul v-else class="cats">
        <li v-for="(row, index) in incomeRows" :key="index" class="cat">
          <div class="cat__head">
            <Icon :name="row.icon || 'file'" :size="15" class="cat__icon" />
            <span class="cat__name">{{ row.name }}</span>
            <span class="cat__amount">{{ yuan(row.total) }}</span>
            <span class="cat__count">{{ row.count }} 笔</span>
          </div>
          <div class="cat__track">
            <div class="cat__fill cat__fill--income" :style="{ width: `${row.pct}%` }" />
          </div>
        </li>
      </ul>
    </section>

    <!-- 3. 月度趋势 -->
    <section v-if="summary" class="wl-card sec">
      <header class="sec__head">
        <Icon name="chart" :size="15" />
        <h3 class="sec__title">月度趋势</h3>
        <span class="sec__hint">最近 6 个月</span>
      </header>

      <p v-if="months.length === 0" class="sec__empty">暂无数据</p>
      <ul v-else class="months">
        <li v-for="m in months" :key="m.month" class="month">
          <span class="month__label">{{ m.month }}</span>
          <div class="month__bar">
            <div class="month__half month__half--in">
              <div class="month__fill month__fill--in" :style="{ width: incomeWidth(m.incomeCents) }" />
            </div>
            <div class="month__half month__half--out">
              <div class="month__fill month__fill--out" :style="{ width: expenseWidth(m.expenseCents) }" />
            </div>
          </div>
          <span class="month__vals">
            <span class="month__val month__val--in">+{{ yuan(m.income) }}</span>
            <span class="month__sep">/</span>
            <span class="month__val month__val--out">-{{ yuan(m.expense) }}</span>
          </span>
        </li>
      </ul>
    </section>

    <!-- 4. 待结清的分摊 -->
    <section class="wl-card sec">
      <header class="sec__head">
        <Icon name="users" :size="15" />
        <h3 class="sec__title">待结清的分摊</h3>
      </header>
      <p class="sec__sub">一起花的钱，谁还欠谁多少。结清操作在账目详情里完成。</p>

      <div v-if="debts.length === 0" class="wl-empty debts__empty">
        <Icon name="check" :size="30" />
        <p class="debts__empty-title">没有待结清的账</p>
      </div>

      <ul v-else class="debts">
        <li
          v-for="debt in debts"
          :key="`${debt.entryId}-${debt.userId}`"
          class="debt"
          :class="{ 'debt--mine': isMine(debt) }"
        >
          <div class="debt__top">
            <span class="debt__date">{{ debt.occurredOn }}</span>
            <span class="debt__title selectable">{{ debt.entryTitle }}</span>
            <span v-if="isMine(debt)" class="wl-badge wl-badge--accent">我</span>
          </div>
          <div class="debt__line">
            <span class="debt__who">{{ debt.userName }}</span>
            <span class="debt__verb">应给</span>
            <span class="debt__who">{{ debt.payerName }}</span>
            <span class="debt__amount">{{ yuan(debt.amount) }}</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sum {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 0;
  padding: var(--space-3);
  overflow-y: auto;
}

/* ---------------------------------------------------------------- 统计卡片 */

.sum__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.stat {
  flex: 1 1 140px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
}

.stat__label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat__value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat__value--success {
  color: var(--success);
}

.stat__value--danger {
  color: var(--danger);
}

.sum__none {
  display: flex;
  flex: 1 1 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-tertiary);
  font-size: 13px;
}

.sum__none p {
  margin: 0;
}

.sum__count {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 骨架 */

.stat--skeleton {
  gap: var(--space-2);
}

.sk {
  display: block;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  animation: sk-pulse 1.2s ease-in-out infinite;
}

.sk--sm {
  width: 40px;
  height: 10px;
}

.sk--lg {
  width: 80px;
  height: 20px;
}

@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* ---------------------------------------------------------------- 分区 */

.sec {
  flex: none;
  padding: var(--space-3);
}

.sec__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.sec__head--gap {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.sec__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.sec__hint {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.sec__sub {
  margin: var(--space-1) 0 var(--space-3);
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.45;
}

.sec__empty {
  margin: var(--space-3) 0 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 分类分布 */

.cats {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.cat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cat__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.cat__icon {
  flex: none;
  color: var(--text-tertiary);
}

.cat__name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat__amount {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.cat__count {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.cat__track {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.cat__fill {
  height: 100%;
  border-radius: inherit;
  transition: width var(--dur) var(--ease-out);
}

.cat__fill--expense {
  background: var(--accent);
}

.cat__fill--income {
  background: var(--success);
}

/* ---------------------------------------------------------------- 月度趋势 */

.months {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.month {
  display: grid;
  grid-template-columns: 64px 1fr auto;
  align-items: center;
  gap: var(--space-3);
}

.month__label {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.month__bar {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.month__half {
  flex: 1;
  min-width: 0;
  height: 10px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.month__half--in {
  display: flex;
  justify-content: flex-start;
}

.month__half--out {
  display: flex;
  justify-content: flex-end;
}

.month__fill {
  height: 100%;
  border-radius: inherit;
  transition: width var(--dur) var(--ease-out);
}

.month__fill--in {
  background: var(--success);
}

.month__fill--out {
  background: var(--danger);
}

.month__vals {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.month__val--in {
  color: var(--success);
}

.month__val--out {
  color: var(--danger);
}

.month__sep {
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 待结清分摊 */

.debts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.debt {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.debt--mine {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.debt__top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.debt__date {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.debt__title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debt__line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: 12.5px;
}

.debt__who {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debt__verb {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.debt__amount {
  margin-left: auto;
  flex: none;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.debts__empty {
  gap: var(--space-1);
  padding: var(--space-4);
}

.debts__empty-title {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 降噪覆盖层 */

/* 欠款条目：去掉描边，用底色分层（卡里的小块不该再各自带框） */
.sum .debt {
  border: none;
  background: var(--surface-2);
}

.sum .debt--mine {
  background: var(--accent-soft);
}

.sum .stat__label {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}
</style>
