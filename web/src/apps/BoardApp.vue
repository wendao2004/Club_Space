<!--
  留言板。

  定位是"收集 bug"：一行一条，没有楼层、没有回复树。讨论去聊天，
  这里只负责把待处理的问题排成一列 —— 一眼能扫完。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { type BoardKind } from '@/api'
import { useBoard } from '@/stores/board'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

defineProps<{ win: WindowInstance }>()

const board = useBoard()
const auth = useAuth()
const ui = useUi()

const KIND_OPTIONS: Array<{ key: BoardKind; label: string; icon: string }> = [
  { key: 'bug', label: 'Bug', icon: 'close' },
  { key: 'idea', label: '建议', icon: 'bulb' },
  { key: 'complaint', label: '吐槽', icon: 'chat' },
]

const KIND_LABEL: Record<BoardKind, string> = {
  bug: 'Bug',
  idea: '建议',
  complaint: '吐槽',
}

const draft = ref('')
const draftKind = ref<BoardKind>('bug')
const isAdmin = computed(() => auth.isAdmin)
const openCount = computed(() => board.openCount)

async function submit(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  const ok = await board.create(draftKind.value, text)
  if (ok) draft.value = ''
  else if (board.error) ui.notify('error', '发送失败', board.error)
}

/** Enter 发送，Shift+Enter 换行 —— 留言短，回车就该发出去。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}

async function toggleResolved(id: string, resolved: boolean): Promise<void> {
  let note: string | null = null
  if (!resolved) {
    // 处理说明可选：直接回车/取消都能继续（留空就只标记状态）
    note = window.prompt('处理说明（可留空，比如「已修复」「设计如此」）：', '')
    if (note === null) return
  }
  await board.resolve(id, !resolved, note)
}

async function removePost(id: string, mine: boolean): Promise<void> {
  const ok = window.confirm(mine ? '撤回这条留言？' : '删除这条留言？这一步不可撤销。')
  if (!ok) return
  await board.remove(id)
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
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function setOpenOnly(next: boolean): void {
  board.setFilter({ openOnly: next })
}

function setKind(next: BoardKind | null): void {
  board.setFilter({ kind: next })
}

onMounted(() => {
  board.connectRealtime()
  void board.load()
})

watch(
  () => board.error,
  (err) => {
    if (err) ui.notify('error', '留言板', err)
  },
)
</script>

<template>
  <div class="board-app">
    <header class="bar">
      <div class="bar-title"><Icon name="chat" :size="18" />留言板</div>
      <span class="wl-badge wl-badge--warning" v-if="openCount > 0">{{ openCount }} 条待处理</span>
      <div class="spacer" />
      <button class="wl-icon-btn" :disabled="board.loading" title="刷新" @click="board.load()">
        <Icon name="refresh" :size="16" :class="{ spin: board.loading }" />
      </button>
    </header>

    <!-- 输入区 -->
    <section class="compose">
      <div class="kind-row">
        <button
          v-for="opt in KIND_OPTIONS"
          :key="opt.key"
          class="kind-chip"
          :class="{ 'kind-chip--on': draftKind === opt.key, [`kind-chip--${opt.key}`]: true }"
          @click="draftKind = opt.key"
        >
          {{ opt.label }}
        </button>
        <span class="compose-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      <textarea
        v-model="draft"
        class="compose-input wl-scroll"
        rows="3"
        maxlength="800"
        placeholder="遇到什么问题？怎么复现？期望是什么？（也欢迎吐槽）"
        @keydown="onKeydown"
      />
      <div class="compose-foot">
        <span class="compose-count" :class="{ 'compose-count--full': draft.length > 760 }">
          {{ draft.length }}/800
        </span>
        <button class="wl-btn wl-btn--primary" :disabled="!draft.trim() || board.submitting" @click="submit">
          <Icon name="plus" :size="15" />发送
        </button>
      </div>
    </section>

    <!-- 筛选 -->
    <div class="filters">
      <button class="filter-btn" :class="{ 'filter-btn--on': !board.openOnly }" @click="setOpenOnly(false)">全部</button>
      <button class="filter-btn" :class="{ 'filter-btn--on': board.openOnly }" @click="setOpenOnly(true)">未处理</button>
      <span class="filter-sep" />
      <button class="filter-btn" :class="{ 'filter-btn--on': board.kind === null }" @click="setKind(null)">所有类型</button>
      <button
        v-for="opt in KIND_OPTIONS"
        :key="opt.key"
        class="filter-btn"
        :class="{ 'filter-btn--on': board.kind === opt.key }"
        @click="setKind(opt.key)"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- 列表 -->
    <div class="list wl-scroll">
      <div v-if="board.loading && board.posts.length === 0" class="wl-empty">
        <span class="wl-spinner" /><span>加载中…</span>
      </div>
      <div v-else-if="board.posts.length === 0" class="wl-empty">
        <Icon name="chat" :size="32" />
        <span>{{ board.openOnly ? '没有待处理的留言，清爽' : '还没有留言，说点什么吧' }}</span>
      </div>

      <article
        v-for="post in board.posts"
        :key="post.id"
        class="post"
        :class="{ 'post--resolved': post.resolvedAt !== null }"
      >
        <div class="post-head">
          <span class="post-kind" :class="`post-kind--${post.kind}`">{{ KIND_LABEL[post.kind] }}</span>
          <span class="post-author">{{ post.authorName }}</span>
          <span class="post-time">{{ relativeTime(post.createdAt) }}</span>
          <span v-if="post.resolvedAt" class="post-resolved">
            <Icon name="check" :size="12" />已处理
            <template v-if="post.resolvedByName">· {{ post.resolvedByName }}</template>
          </span>
          <div class="spacer" />
          <button
            v-if="isAdmin"
            class="wl-btn wl-btn--ghost wl-btn--xs"
            :title="post.resolvedAt ? '撤销「已处理」标记' : '标记为已处理'"
            @click="toggleResolved(post.id, post.resolvedAt !== null)"
          >
            {{ post.resolvedAt ? '撤销' : '标记已处理' }}
          </button>
          <button
            v-if="isAdmin || (post.mine && !post.resolvedAt)"
            class="wl-icon-btn post-del"
            :title="post.mine ? '撤回' : '删除'"
            @click="removePost(post.id, post.mine)"
          >
            <Icon name="trash" :size="14" />
          </button>
        </div>
        <p class="post-body selectable">{{ post.body }}</p>
        <p v-if="post.resolution" class="post-resolution">
          <Icon name="check" :size="12" />{{ post.resolution }}
        </p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.board-app {
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

/* ---------------- 输入区 */

.compose {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.kind-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.kind-chip {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
  cursor: pointer;
}

.kind-chip--on.kind-chip--bug {
  border-color: #e5484d;
  color: #b3261e;
  background: rgba(229, 72, 77, 0.12);
}

.kind-chip--on.kind-chip--idea {
  border-color: #2b6cf6;
  color: #1f57c3;
  background: rgba(43, 108, 246, 0.12);
}

.kind-chip--on.kind-chip--complaint {
  border-color: #f5a623;
  color: #a86a00;
  background: rgba(245, 166, 35, 0.14);
}

.compose-hint {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.compose-input {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.6;
}

.compose-input:focus {
  outline: none;
  border-color: var(--accent);
}

.compose-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}

.compose-count {
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.compose-count--full {
  color: #b3261e;
}

/* ---------------- 筛选 */

.filters {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  flex: none;
  flex-wrap: wrap;
}

.filter-btn {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.filter-btn:hover {
  background: var(--surface-2);
}

.filter-btn--on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.filter-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 4px;
}

/* ---------------- 列表 */

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.post {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.post--resolved {
  opacity: 0.62;
}

.post-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.post-kind {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.post-kind--bug {
  background: rgba(229, 72, 77, 0.14);
  color: #b3261e;
}

.post-kind--idea {
  background: rgba(43, 108, 246, 0.14);
  color: #1f57c3;
}

.post-kind--complaint {
  background: rgba(245, 166, 35, 0.16);
  color: #a86a00;
}

.post-author {
  font-weight: 600;
}

.post-time {
  color: var(--text-tertiary);
}

.post-resolved {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #1f7a4d;
  font-weight: 600;
}

.post-del {
  color: var(--text-tertiary);
}

.post-del:hover {
  color: #b3261e;
}

.post-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.post-resolution {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #1f7a4d;
  background: rgba(48, 164, 108, 0.12);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  align-self: flex-start;
}

/* ---------------------------------------------------------------- 窄屏（手机） */

/* 留言板本身是纵向流，手机上不会"挤没"，只需要让顶部工具条与输入区
   在 390px 宽下别横向溢出（类型标签 + 提交按钮一行放不下就换行）。 */
@media (max-width: 520px) {
  .bar {
    padding: 0 8px;
  }

  .compose {
    padding: 8px;
  }

  .kind-row {
    flex-wrap: wrap;
  }

  .compose-hint {
    margin-left: 0;
  }
}
</style>
