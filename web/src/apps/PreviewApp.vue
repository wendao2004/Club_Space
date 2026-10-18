<!--
  文件预览窗口。

  原先预览是文件管理器里的一个浮层 —— 不能拖、不能缩放、不能贴边，
  切到别的窗口就被盖住。现在它是**一个真正的桌面窗口**：
  和所有窗口共用同一套框架（WindowFrame）的拖拽 / 8 向缩放 / 最大化 /
  贴边分屏 / 任务栏按钮，行为与其他窗口完全一致。

  通过窗口参数拿文件：args: { node: FileEntry }（文件管理器传入）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, formatBytes, type FileEntry } from '@/api'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

/** 只接受形状合法的 FileEntry；坏参数当作"没有文件"处理，不炸界面。 */
const node = computed<FileEntry | null>(() => {
  const raw = props.win.args?.node as FileEntry | undefined
  return raw && typeof raw.id === 'string' && typeof raw.name === 'string' ? raw : null
})

const mime = computed(() => node.value?.mime ?? '')
const url = computed(() => (node.value ? api.previewUrl(node.value.id) : ''))
const isImage = computed(() => mime.value.startsWith('image/'))
const isVideo = computed(() => mime.value.startsWith('video/'))
const isAudio = computed(() => mime.value.startsWith('audio/'))
const isFrame = computed(() => mime.value === 'application/pdf' || mime.value.startsWith('text/'))

/** 加载失败（文件被删 / 无权限 / 解码失败）时给一个体面的兜底。 */
const failed = ref(false)

function download(): void {
  if (!node.value) return
  const a = document.createElement('a')
  a.href = api.downloadUrl(node.value.id)
  a.download = node.value.name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>

<template>
  <div class="pv">
    <header class="pv__bar">
      <Icon :name="isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file'" :size="15" class="pv__icon" />
      <span class="pv__name" :title="node?.name">{{ node?.name ?? '文件预览' }}</span>
      <span v-if="node" class="wl-badge">{{ formatBytes(node.size) }}</span>
      <span class="pv__spacer" />
      <button class="wl-btn" :disabled="!node" @click="download">
        <Icon name="download" :size="14" />
        <span>下载</span>
      </button>
    </header>

    <div class="pv__body">
      <div v-if="!node" class="wl-empty">
        <Icon name="file" :size="30" />
        <span>没有可预览的文件</span>
      </div>

      <img v-else-if="isImage && !failed" class="pv__img" :src="url" :alt="node.name" @error="failed = true" />

      <video v-else-if="isVideo && !failed" class="pv__media" :src="url" controls @error="failed = true" />

      <audio v-else-if="isAudio && !failed" class="pv__audio" :src="url" controls @error="failed = true" />

      <!-- PDF 与文本走内置查看器 / 纯文本渲染；响应头已有 CSP sandbox 兜底 -->
      <iframe v-else-if="isFrame && !failed" class="pv__frame" :src="url" :title="node.name" @error="failed = true" />

      <div v-else class="wl-empty">
        <Icon name="alert" :size="30" />
        <span>{{ failed ? '这个文件暂时无法预览，可以下载后本地查看' : '此类文件不支持在线预览' }}</span>
        <button class="wl-btn wl-btn--primary" @click="download">
          <Icon name="download" :size="15" />
          <span>下载文件</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pv__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
  background: var(--surface-1);
}

.pv__icon {
  flex: none;
  color: var(--text-secondary);
}

.pv__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.pv__spacer {
  flex: 1;
}

.pv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: var(--space-3);
  background: var(--surface-0);
}

.pv__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
}

.pv__media {
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
}

.pv__audio {
  width: min(420px, 100%);
}

.pv__frame {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 6px;
  background: #fff;
}
</style>
