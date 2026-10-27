<!--
  白板（Excalidraw 集成）。

  左侧是白板墙（列表/新建/删除），右侧是 Excalidraw 画布（React 子树，
  见 excalidraw-bridge）。协作 = 最后写入胜：别人保存时若本地没有未保存
  改动就自动载入，有改动则提示（不覆盖正在画的东西）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, type WhiteboardDetail, type WhiteboardMeta } from '@/api'
import { mountExcalidraw, type ExcalidrawBridge } from '@/lib/excalidraw-bridge'
import { useAuth } from '@/stores/auth'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

defineProps<{ win: WindowInstance }>()

const auth = useAuth()
const ui = useUi()

// ---------------------------------------------------------------- 列表

const boards = ref<WhiteboardMeta[]>([])
const loading = ref(true)
/** 当前打开的白板（null = 没打开，显示列表空态）。 */
const current = ref<WhiteboardDetail | null>(null)
const dirty = ref(false)
const saving = ref(false)
/** 他人保存了当前白板而本地有未保存改动时置位。 */
const remoteAhead = ref(false)

const canEditCurrent = computed(() => current.value?.canEdit ?? false)

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const { boards: list } = await api.whiteboards.list()
    boards.value = list
  } catch (err) {
    ui.notify('error', '白板', err instanceof Error ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
}

async function createBoard(): Promise<void> {
  const name = window.prompt('新白板的名字：', '')
  if (!name?.trim()) return
  try {
    const { board } = await api.whiteboards.create(name.trim())
    await loadList()
    await openBoard(board.id)
  } catch (err) {
    ui.notify('error', '新建白板', err instanceof Error ? err.message : '创建失败')
  }
}

async function openBoard(id: string): Promise<void> {
  if (dirty.value && !window.confirm('当前画布有未保存的改动，切换会丢失，确定？')) return
  try {
    const { board } = await api.whiteboards.get(id)
    current.value = board
    dirty.value = false
    remoteAhead.value = false
    if (bridge) {
      // 已经挂过 React root：只换场景。之前这里直接 return，导致"切到
      // 另一块白板后画布还是上一块的内容"——用户以为保存失败
      bridge.loadScene(board.data)
      dirty.value = false
      return
    }
    /**
     * 首次挂载：必须等 DOM 真的渲染出画布容器。
     *
     * 曾经用 requestAnimationFrame，实测**不一定够**：窗口刚重新打开时
     * 组件才挂载，rAF 时 `canvasEl` 可能还是 null，mountCanvas 直接 return，
     * 整块画布根本没挂 —— 用户看到空白，再点一次列表行才出来（"要点两次
     * 才显示记录"）。改用 nextTick（Vue 渲染 flush 之后）+ watch 兑底。
     */
    pendingData = board.data
    await nextTick()
    mountCanvas(pendingData)
  } catch (err) {
    ui.notify('error', '白板', err instanceof Error ? err.message : '加载失败')
  }
}

async function removeBoard(b: WhiteboardMeta): Promise<void> {
  if (!window.confirm(`删除白板「${b.name}」？不可恢复。`)) return
  try {
    await api.whiteboards.remove(b.id)
    if (current.value?.id === b.id) closeCanvas()
    await loadList()
  } catch (err) {
    ui.notify('error', '白板', err instanceof Error ? err.message : '删除失败')
  }
}

// ---------------------------------------------------------------- 画布

const canvasEl = ref<HTMLDivElement | null>(null)
let bridge: ExcalidrawBridge | null = null
/** 等待画布容器出现时要载入的场景（nextTick 后仍可能是 null，见 watch）。 */
let pendingData: string | undefined

/**
 * 画布容器一出现就挂载。
 *
 * 这是"点一次就出来"的兑底：openBoard 里 nextTick 后如果容器还没渲染，
 * 这里会在 ref 被赋值的瞬间补上，而不是等用户再点一次。
 */
watch(canvasEl, (el) => {
  if (el && !bridge && pendingData !== undefined) {
    mountCanvas(pendingData)
  }
})

/**
 * 挂载 React 画布。
 *
 * `dataToLoad` 要**显式传入**：onReady 回调可能在 switch 之后才跑，那时
 * current 已经指向另一块白板了 —— 用参数捕获“要载入的那一份场景”。
 */
function mountCanvas(dataToLoad?: string): void {
  if (!canvasEl.value || bridge) return
  pendingData = undefined
  const initialData = dataToLoad ?? current.value?.data
  bridge = mountExcalidraw(canvasEl.value, {
    // 场景由 bridge 在就绪时自己载入 —— 调用方在 onReady 里拿不到 bridge
    initialScene: initialData,
    onReady: () => {
      dirty.value = false
    },
    onChange: () => {
      dirty.value = true
    },
  })
}

function closeCanvas(): void {
  bridge?.destroy()
  bridge = null
  pendingData = undefined
  current.value = null
  dirty.value = false
}

async function save(): Promise<void> {
  if (!current.value || !bridge || saving.value) return
  saving.value = true
  try {
    const data = bridge.exportScene()
    await api.whiteboards.save(current.value.id, data)
    /**
     * 关键：把刚保存的场景写回 current。
     *
     * 不写回的话，`current.data` 一直是"打开时的那一份"——切到别的白板
     * 再切回来，载入的是旧场景，用户看到图"没了"，以为保存失败。
     */
    current.value = { ...current.value, data, updatedAt: Date.now() }
    dirty.value = false
    remoteAhead.value = false
    // 更新列表里的时间戳
    await loadList()
  } catch (err) {
    ui.notify('error', '保存白板', err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------- 实时协作

const WHITEBOARD = 'whiteboard' satisfies RealtimeEventName
let offRealtime: Array<() => void> = []
const rt = useRealtime()

async function onRemoteSaved(boardId: string, by: string, actorId?: string): Promise<void> {
  /**
   * 自己保存触发的广播直接忽略。
   *
   * 不忽略的话：保存（dirty=false）→ 收到自己的广播 → 本地干净分支会
   * 重新 GET 并 loadScene —— 如果用户保存后立刻动了一笔，那一笔会被
   * 服务端返回的旧场景覆盖掉（实测可丢笔画）。
   */
  if (actorId && actorId === auth.user?.id) return
  if (current.value?.id !== boardId) {
    // 别的白板变了：只刷新墙
    await loadList()
    return
  }
  if (dirty.value) {
    remoteAhead.value = true
    ui.notify('info', '白板', `${by} 保存了新版本；你手上的改动还没保存，保存后会覆盖 Ta 的版本`)
    return
  }
  // 本地干净：直接拉新版灌进画布
  try {
    const { board } = await api.whiteboards.get(boardId)
    current.value = board
    bridge?.loadScene(board.data)
    dirty.value = false
  } catch {
    // 拉取失败就等下一次广播
  }
}

onMounted(() => {
  void loadList()
  rt.connect()
  offRealtime = [
    rt.on(WHITEBOARD, (payload) => {
      const data = (payload as { data?: { reason?: string; boardId?: string; by?: string; actorId?: string } }).data ?? {}
      if (data.reason === 'saved' && data.boardId) {
        void onRemoteSaved(data.boardId, data.by ?? '有人', data.actorId)
      }
      else void loadList()
    }),
    rt.onResync(() => void loadList()),
  ]
})

onBeforeUnmount(() => {
  for (const off of offRealtime) off()
  closeCanvas()
})

// 画布容器出现/销毁时挂载/卸载 React 子树
watch(current, (v) => {
  if (!v) closeCanvas()
})

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}
</script>

<template>
  <div class="wb-app">
    <!-- 白板墙 -->
    <aside class="side">
      <header class="side-head">
        <strong>白板墙</strong>
        <div class="spacer" />
        <button class="wl-icon-btn" :disabled="loading" title="刷新" @click="loadList()">
          <Icon name="refresh" :size="15" :class="{ spin: loading }" />
        </button>
        <button class="wl-icon-btn" title="新建白板" @click="createBoard"><Icon name="plus" :size="15" /></button>
      </header>
      <div class="side-list">
        <p v-if="boards.length === 0 && !loading" class="empty">还没有白板，点右上角 + 新建</p>
        <button
          v-for="b in boards"
          :key="b.id"
          class="brow"
          :class="{ 'brow--on': current?.id === b.id }"
          @click="openBoard(b.id)"
        >
          <span class="brow-main">
            <span class="brow-name">{{ b.name }}</span>
            <span class="brow-meta">{{ b.ownerName }} · {{ relativeTime(b.updatedAt) }}</span>
          </span>
          <span
            v-if="b.canEdit"
            class="wl-icon-btn"
            role="button"
            title="删除白板"
            @click.stop="removeBoard(b)"
          >
            <Icon name="trash" :size="13" />
          </span>
        </button>
      </div>
    </aside>

    <!-- 画布区 -->
    <section class="canvas-wrap">
      <template v-if="current">
        <header class="canvas-bar">
          <strong class="canvas-name">{{ current.name }}</strong>
          <span v-if="dirty" class="wl-badge wl-badge--warning">未保存</span>
          <span v-if="remoteAhead" class="wl-badge wl-badge--muted">他人已保存新版本</span>
          <div class="spacer" />
          <button class="wl-btn wl-btn--sm" @click="closeCanvas">关闭</button>
          <button
            v-if="canEditCurrent"
            class="wl-btn wl-btn--primary"
            :disabled="!dirty || saving"
            @click="save"
          >
            <Icon name="check" :size="13" />{{ saving ? '保存中…' : '保存' }}
          </button>
        </header>
        <div ref="canvasEl" class="canvas" />
      </template>
      <div v-else class="canvas-empty">
        <Icon name="brush" :size="28" />
        <p>从左边挑一块白板，或新建一块开始画</p>
        <p class="canvas-empty-sub">协作规则：所有人可见，作者保存定稿（最后保存的版本为准）</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wb-app {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
}

.side {
  flex: none;
  width: 230px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line-hair);
  min-height: 0;
}

.side-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  font-size: 13px;
  flex: none;
}

.spacer {
  flex: 1;
}

.side-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.empty {
  margin: var(--space-3) 0;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
}

.brow {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  text-align: left;
  cursor: pointer;
}

.brow:hover {
  background: var(--surface-2);
}

.brow--on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
}

.brow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.brow-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brow-meta {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ---------------- 画布 */

.canvas-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.canvas-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
}

.canvas-name {
  font-size: 13px;
}

.canvas {
  flex: 1;
  min-height: 0;
}

/* Excalidraw 期望撑满父容器 */
.canvas :deep(.excalidraw) {
  height: 100%;
}

.canvas-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-tertiary);
  font-size: 13px;
}

.canvas-empty p {
  margin: 0;
}

.canvas-empty-sub {
  font-size: 11px;
}

@media (max-width: 640px) {
  .side {
    width: 160px;
  }
}
</style>
