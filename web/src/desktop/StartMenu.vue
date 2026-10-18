<!--
  开始菜单。

  Windows 11 式：固定宽度面板、搜索框在顶部、"已固定"图标网格、底部用户区。
  没有搜索后端，所以搜索框过滤的是应用列表本身 —— 对只有几个应用的平台够用，
  而且比给一个点了没反应的假搜索框诚实。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { APPS, type AppDef } from '@/apps/registry'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useWindows } from '@/stores/windows'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const windows = useWindows()
const auth = useAuth()
const ui = useUi()

const query = ref('')
const searchRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      // 打开后自动聚焦搜索框，键盘用户可以直接输入
      requestAnimationFrame(() => searchRef.value?.focus())
    }
  },
)

const visibleApps = computed<AppDef[]>(() =>
  APPS.filter((app) => app.inStartMenu).filter((app) => {
    if (app.adminOnly && !auth.isAdmin) return false
    return true
  }),
)

const filtered = computed<AppDef[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return visibleApps.value
  return visibleApps.value.filter(
    (app) =>
      app.name.toLowerCase().includes(q) ||
      app.id.includes(q) ||
      app.description.toLowerCase().includes(q),
  )
})

/** 「全部应用」按分组展示，和 Windows 的字母分组是同一种阅读逻辑。 */
const grouped = computed(() => {
  const map = new Map<string, AppDef[]>()
  for (const app of filtered.value) {
    const key = app.group ?? '其他'
    const list = map.get(key) ?? []
    list.push(app)
    map.set(key, list)
  }
  return [...map.entries()]
})

function launch(app: AppDef): void {
  windows.open({
    appId: app.id,
    title: app.name,
    w: app.defaultSize?.w,
    h: app.defaultSize?.h,
    minW: app.minSize?.w,
    minH: app.minSize?.h,
    resizable: app.resizable,
  })
  emit('close')
}

async function signOut(): Promise<void> {
  emit('close')
  await auth.logout()
  windows.clearLayout()
  windows.$reset?.()
}
</script>

<template>
  <Transition name="start">
    <div v-if="open" class="start" @click.stop>
      <div class="start__search">
        <Icon name="search" :size="15" />
        <input
          ref="searchRef"
          v-model="query"
          class="start__search-input"
          type="text"
          placeholder="搜索应用"
          @keydown.enter="filtered[0] && launch(filtered[0])"
          @keydown.esc="emit('close')"
        />
      </div>

      <div class="start__body wl-scroll">
        <template v-if="filtered.length === 0">
          <div class="wl-empty" style="padding: 32px 0">
            <Icon name="search" :size="28" />
            <span>没有匹配「{{ query }}」的应用</span>
          </div>
        </template>

        <template v-else>
          <!-- 无搜索词时按"已固定"网格；有搜索词时是结果列表 -->
          <template v-if="!query.trim()">
            <div class="start__grid">
              <button v-for="app in filtered" :key="app.id" class="start__tile" @click="launch(app)">
                <span class="start__tile-icon" :style="app.tint ? { background: app.tint } : undefined">
                  <Icon :name="app.icon" :size="22" />
                </span>
                <span class="start__tile-name">{{ app.name }}</span>
              </button>
            </div>
          </template>

          <template v-else>
            <div v-for="[group, apps] in grouped" :key="group" class="start__group">
              <div class="start__group-title">{{ group }}</div>
              <button v-for="app in apps" :key="app.id" class="start__result" @click="launch(app)">
                <span class="start__result-icon" :style="app.tint ? { background: app.tint } : undefined">
                  <Icon :name="app.icon" :size="16" />
                </span>
                <span class="start__result-text">
                  <span class="start__result-name">{{ app.name }}</span>
                  <span class="start__result-desc">{{ app.description }}</span>
                </span>
              </button>
            </div>
          </template>
        </template>
      </div>

      <div class="start__footer">
        <div class="start__user">
          <span class="start__avatar">{{ (auth.user?.displayName ?? '?').slice(0, 1) }}</span>
          <span class="start__user-text">
            <span class="start__user-name">{{ auth.user?.displayName }}</span>
            <span class="start__user-role">
              {{ auth.user?.role === 'owner' ? '创建者' : auth.user?.role === 'admin' ? '管理员' : '成员' }}
            </span>
          </span>
        </div>
        <button class="wl-icon-btn" title="退出登录" @click="signOut">
          <Icon name="logout" :size="17" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.start {
  position: fixed;
  left: 50%;
  bottom: calc(var(--taskbar-h) + 8px);
  z-index: var(--z-startmenu);
  display: flex;
  flex-direction: column;
  width: 480px;
  max-width: calc(100vw - 24px);
  max-height: min(640px, calc(100vh - var(--taskbar-h) - 24px));
  transform: translateX(-50%);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-strong);
  background: var(--surface-raised);
  backdrop-filter: blur(50px) saturate(180%);
  box-shadow: var(--shadow-popup);
  overflow: hidden;
}

/* ---------------------------------------------------------------- 搜索 */

.start__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin: var(--space-3);
  padding: 0 var(--space-3);
  height: 34px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  border-bottom-color: var(--border-strong);
  background: var(--surface-solid);
  color: var(--text-tertiary);
}

.start__search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.start__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.start__search-input::placeholder {
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 主体 */

.start__body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-3) var(--space-3);
  overflow-y: auto;
}

.start__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-1);
}

.start__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-1);
  border-radius: var(--radius);
  transition: background var(--dur-fast) var(--ease-out);
}

.start__tile:hover {
  background: var(--hover);
}

.start__tile-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--surface-3);
  color: #fff;
}

.start__tile-name {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.2;
}

/* ---------------------------------------------------------------- 搜索结果 */

.start__group-title {
  padding: var(--space-3) var(--space-2) var(--space-1);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.start__result {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.start__result:hover {
  background: var(--hover);
}

.start__result-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 8px;
  background: var(--surface-3);
  color: #fff;
}

.start__result-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.start__result-name {
  font-size: 13px;
  color: var(--text);
}

.start__result-desc {
  font-size: 11.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------------------------------------------------------------- 底部用户区 */

.start__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.start__user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.start__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}

.start__user-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.start__user-name {
  font-size: 12.5px;
}

.start__user-role {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 动画 */

.start-enter-active,
.start-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-spring);
}

.start-enter-from,
.start-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px) scale(0.98);
}
</style>
