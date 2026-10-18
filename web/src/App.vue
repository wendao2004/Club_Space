<!--
  根组件：决定显示登录页、桌面外壳，还是移动端壳。

  三个状态：
    - 未登录 → LoginView（首次运行时是"创建管理员"）
    - 已登录 + 窄屏 → MobileShell
    - 已登录 + 宽屏 → DesktopShell

  移动端走独立的壳而不是把桌面缩小：Windows 式窗口在手机上不可用（拖拽、
  多窗口并存、悬浮任务栏都没有意义），这是评审团明确的结论。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import DesktopShell from '@/desktop/DesktopShell.vue'
import MobileShell from '@/mobile/MobileShell.vue'
import LoginView from '@/views/LoginView.vue'
import SecureContextBanner from '@/views/SecureContextBanner.vue'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'

const auth = useAuth()
const ui = useUi()

const width = ref(window.innerWidth)

/** 断点取 820px：再窄下去窗口化布局会挤成一团，不如切移动壳。 */
const isMobile = computed(() => width.value < 820)

function onResize(): void {
  width.value = window.innerWidth
}

onMounted(async () => {
  ui.initTheme()
  ui.mobile = isMobile.value
  window.addEventListener('resize', onResize)
  await auth.load()
  ui.mobile = isMobile.value
})

onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <div v-if="!auth.ready" class="boot">
    <div class="boot__logo">
      <span v-for="i in 4" :key="i" />
    </div>
    <p class="boot__text">正在连接…</p>
    <p v-if="auth.error" class="boot__error">{{ auth.error }}</p>
  </div>

  <template v-else>
    <!-- 非安全上下文是"功能缺失"而不是"体验差"，必须显式告知 -->
    <SecureContextBanner />

    <LoginView v-if="!auth.loggedIn" />
    <MobileShell v-else-if="ui.mobile || isMobile" />
    <DesktopShell v-else />
  </template>
</template>

<style scoped>
.boot {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  background: var(--bg-desktop);
}

.boot__logo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  width: 40px;
  height: 40px;
  animation: boot-pulse 1.6s var(--ease-out) infinite;
}

.boot__logo span {
  background: var(--accent);
  border-radius: 2px;
}

@keyframes boot-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(0.92);
  }
}

.boot__text {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.boot__error {
  max-width: 420px;
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
  text-align: center;
}
</style>
