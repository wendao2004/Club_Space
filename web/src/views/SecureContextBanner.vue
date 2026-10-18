<!--
  安全上下文提示条。

  这一条不是"锦上添花"，是评审团反复强调的功能门槛：
  http://192.168.x.x 不是浏览器的安全上下文，在这些 API 上会直接失效 ——
  摄像头/麦克风、屏幕共享、Service Worker、通知、剪贴板、Web Crypto。
  而且 Chrome 对带证书错误的站点**禁止注册 Service Worker**，所以没装根证书
  不是"弹个警告"，而是"功能没有"。

  设计立场：绝不静默降级。用户点了"继续访问"放行之后，这里明确告诉他缺了什么、
  怎么修（去引导页装根证书），而不是让功能莫名其妙地不可用。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { useUi } from '@/stores/ui'

const ui = useUi()
const dismissed = ref(false)

const problems = computed<string[]>(() => {
  const list: string[] = []
  if (!window.isSecureContext) {
    list.push('摄像头、麦克风、屏幕共享')
    list.push('系统通知与后台运行')
    list.push('剪贴板读写')
    list.push('安装为桌面应用（PWA）')
    list.push('文件哈希校验（秒传加速）')
  } else if (!('serviceWorker' in navigator)) {
    list.push('浏览器不支持 Service Worker，离线能力不可用')
  }
  return list
})

const show = computed(() => problems.value.length > 0 && !dismissed.value)

/** 引导页地址：与当前主机同址的 8080 端口（部署时由 nginx 提供明文引导页）。 */
const onboardUrl = computed(() => {
  const { protocol, hostname } = window.location
  void protocol
  return `http://${hostname}:8080/onboard`
})
</script>

<template>
  <Transition name="banner">
    <div v-if="show" class="banner">
      <span class="banner__icon">
        <Icon name="lock" :size="18" />
      </span>
      <div class="banner__body">
        <div class="banner__title">当前不是安全连接，部分功能不可用</div>
        <div class="banner__detail">
          受影响的正是需要浏览器安全上下文的能力：{{ problems.join('、') }}。
          <br />
          修复方式：在每台设备上安装社团内网根证书（手机也一样），然后重新打开本页。
        </div>
      </div>
      <a class="wl-btn wl-btn--primary banner__action" :href="onboardUrl" target="_blank" rel="noopener">
        去安装证书
      </a>
      <button class="wl-icon-btn" title="暂时忽略" @click="dismissed = true">
        <Icon name="close" :size="16" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.banner {
  position: fixed;
  left: 50%;
  top: var(--space-3);
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: min(760px, calc(100vw - 24px));
  padding: var(--space-3) var(--space-4);
  transform: translateX(-50%);
  border-radius: var(--radius);
  border: 1px solid var(--warning);
  background: var(--surface-raised);
  backdrop-filter: blur(40px) saturate(180%);
  box-shadow: var(--shadow-popup);
}

.banner__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  background: var(--warning-soft);
  color: var(--warning);
}

.banner__body {
  flex: 1;
  min-width: 0;
}

.banner__title {
  font-size: 13px;
  font-weight: 600;
}

.banner__detail {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.banner__action {
  flex: none;
  text-decoration: none;
}

.banner-enter-active,
.banner-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-spring);
}

.banner-enter-from,
.banner-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-12px);
}
</style>
