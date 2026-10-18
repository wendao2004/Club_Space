<!--
  更换壁纸。

  两条路：预设的四套 CSS 光斑壁纸，或者从文件空间里挑一张图片。
  图片壁纸只存引用（nodeId + 名字，见 stores/ui.ts），图片本体留在文件空间 ——
  与"主题与壁纸仅影响本机显示"的既有设定一致，也避免把大图塞进 localStorage。

  桌面右键「更换壁纸」与设置应用「外观」页共用这一个弹层。

  ⚠️ 预设缩略图用的是全局类 wl-wall-N（base.css），和桌面上的壁纸是同一套
  定义 —— 改壁纸时改一处即可，缩略图与全屏观感始终一致。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, formatBytes, type FileEntry } from '@/api'
import { useUi } from '@/stores/ui'

const ui = useUi()

const PRESETS = [0, 1, 2, 3]

const space = ref<'shared' | 'private'>('shared')
const breadcrumb = ref<Array<{ id: string; name: string }>>([])
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const error = ref('')

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.heic', '.tif', '.tiff']

/**
 * 能不能当壁纸：位图即可。
 * SVG 明确排除 —— 预览接口不允许内联 SVG（防存储型 XSS），<img> 拉不到它。
 */
function isImage(entry: FileEntry): boolean {
  const mime = entry.mime ?? ''
  if (mime === 'image/svg+xml') return false
  if (mime.startsWith('image/')) return true
  const dot = entry.name.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXTS.includes(entry.name.slice(dot).toLowerCase())
}

const folders = computed(() => entries.value.filter((e) => e.kind === 'folder'))
const images = computed(() => entries.value.filter((e) => e.kind === 'file' && isImage(e)))

async function load(id: string | null): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const data = await api.listFiles(id, space.value)
    entries.value = data.entries
    breadcrumb.value = data.breadcrumb
  } catch (err) {
    entries.value = []
    breadcrumb.value = []
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function switchSpace(next: 'shared' | 'private'): void {
  if (space.value === next) return
  space.value = next
  void load(null)
}

function enterFolder(entry: FileEntry): void {
  void load(entry.id)
}

function goUp(): void {
  const parent = breadcrumb.value.length > 0 ? breadcrumb.value[breadcrumb.value.length - 2]?.id ?? null : null
  void load(parent)
}

function pickPreset(index: number): void {
  ui.setWallpaper(index)
}

function pickImage(entry: FileEntry): void {
  ui.setWallpaperImage({ nodeId: entry.id, name: entry.name })
  ui.notify('success', '壁纸已更换', entry.name)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // 捕获阶段拦下：不让 Escape 继续传到桌面的全局快捷键上
    event.stopPropagation()
    ui.closeWallpaperPicker()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  void load(null)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div
    class="wp-picker"
    role="dialog"
    aria-modal="true"
    aria-label="更换壁纸"
    @click.self="ui.closeWallpaperPicker()"
  >
    <div class="wp-picker__panel">
      <header class="wp-picker__head">
        <h2 class="wp-picker__title">更换壁纸</h2>
        <button class="wl-icon-btn" title="关闭" @click="ui.closeWallpaperPicker()">
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="wp-picker__body wl-scroll">
        <!-- 预设壁纸 -->
        <section>
          <div class="wp-picker__label">预设壁纸</div>
          <div class="wp-picker__presets">
            <button
              v-for="n in PRESETS"
              :key="n"
              class="wp-picker__preset"
              :class="[`wl-wall-${n}`, { 'wp-picker__preset--on': !ui.wallpaperImage && ui.wallpaper === n }]"
              :title="`壁纸 ${n + 1}`"
              @click="pickPreset(n)"
            >
              <span v-if="!ui.wallpaperImage && ui.wallpaper === n" class="wp-picker__check">
                <Icon name="check" :size="12" />
              </span>
            </button>
          </div>
        </section>

        <!-- 文件空间图片 -->
        <section>
          <div class="wp-picker__label">从文件空间选择图片</div>

          <div class="wp-picker__bar">
            <div class="wp-picker__seg">
              <button
                class="wp-picker__seg-btn"
                :class="{ 'wp-picker__seg-btn--on': space === 'shared' }"
                @click="switchSpace('shared')"
              >
                共享空间
              </button>
              <button
                class="wp-picker__seg-btn"
                :class="{ 'wp-picker__seg-btn--on': space === 'private' }"
                @click="switchSpace('private')"
              >
                私人空间
              </button>
            </div>
            <button class="wl-btn" :disabled="breadcrumb.length === 0" @click="goUp">
              <Icon name="arrow-left" :size="14" />
              <span>上一级</span>
            </button>
            <span class="wp-picker__path" :title="breadcrumb.map((c) => c.name).join(' / ')">
              {{ breadcrumb.length === 0 ? '根目录' : breadcrumb.map((c) => c.name).join(' / ') }}
            </span>
          </div>

          <div v-if="loading" class="wp-picker__state">
            <span class="wl-spinner" />
            <span>正在读取…</span>
          </div>

          <div v-else-if="error" class="wp-picker__state wp-picker__state--err">
            <Icon name="alert" :size="18" />
            <span class="selectable">{{ error }}</span>
          </div>

          <div v-else-if="folders.length === 0 && images.length === 0" class="wp-picker__state">
            <Icon name="image" :size="22" />
            <span>这个目录里还没有图片（先到文件应用里上传）</span>
          </div>

          <div v-else class="wp-picker__grid">
            <button v-for="f in folders" :key="f.id" class="wp-picker__folder" @click="enterFolder(f)">
              <Icon name="folder" :size="20" class="wp-picker__folder-icon" />
              <span class="wp-picker__folder-name">{{ f.name }}</span>
            </button>
            <button
              v-for="img in images"
              :key="img.id"
              class="wp-picker__img"
              :class="{ 'wp-picker__img--on': ui.wallpaperImage?.nodeId === img.id }"
              :title="`${img.name}（${formatBytes(img.size)}）`"
              @click="pickImage(img)"
            >
              <img :src="api.previewUrl(img.id)" :alt="img.name" loading="lazy" />
              <span class="wp-picker__img-name">{{ img.name }}</span>
              <span v-if="ui.wallpaperImage?.nodeId === img.id" class="wp-picker__check">
                <Icon name="check" :size="12" />
              </span>
            </button>
          </div>
        </section>
      </div>

      <footer class="wp-picker__foot">
        <span class="wp-picker__current">
          <template v-if="ui.wallpaperImage">当前：图片壁纸「{{ ui.wallpaperImage.name }}」</template>
          <template v-else>当前：预设壁纸 {{ ui.wallpaper + 1 }}</template>
        </span>
        <div class="wp-picker__foot-actions">
          <button v-if="ui.wallpaperImage" class="wl-btn" @click="ui.clearWallpaperImage()">
            <Icon name="trash" :size="14" />
            <span>清除图片壁纸</span>
          </button>
          <button class="wl-btn wl-btn--primary" @click="ui.closeWallpaperPicker()">完成</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.wp-picker {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: rgba(8, 16, 28, 0.35);
  backdrop-filter: blur(3px);
}

.wp-picker__panel {
  display: flex;
  flex-direction: column;
  width: min(780px, 100%);
  max-height: min(660px, 100%);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  backdrop-filter: blur(40px) saturate(1.6);
  box-shadow: var(--shadow-window);
  overflow: hidden;
}

.wp-picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
}

.wp-picker__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.wp-picker__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.wp-picker__label {
  margin-bottom: var(--space-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-tertiary);
}

/* ---- 预设缩略图 ---- */

.wp-picker__presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  max-width: 460px;
}

.wp-picker__preset {
  position: relative;
  height: 64px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.wp-picker__preset:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.wp-picker__preset--on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.wp-picker__check {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: 0 1px 3px rgba(16, 40, 72, 0.3);
}

/* ---- 文件空间浏览 ---- */

.wp-picker__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.wp-picker__seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.wp-picker__seg-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 3px;
  font-size: 12.5px;
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
}

.wp-picker__seg-btn--on {
  background: var(--surface-1);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-card);
}

.wp-picker__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.wp-picker__state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--text-tertiary);
  font-size: var(--fs-body);
}

.wp-picker__state--err {
  color: var(--danger);
}

.wp-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: var(--space-3);
}

.wp-picker__folder {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 42px;
  padding: 0 var(--space-3);
  border-radius: 6px;
  color: var(--text-secondary);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.wp-picker__folder:hover {
  background: var(--hover);
  color: var(--text);
}

.wp-picker__folder-icon {
  flex: none;
  color: #cf8214;
}

[data-theme='dark'] .wp-picker__folder-icon {
  color: #e2ab4d;
}

.wp-picker__folder-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.wp-picker__img {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--surface-2);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.wp-picker__img img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wp-picker__img:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.wp-picker__img--on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.wp-picker__img-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 14px 8px 5px;
  font-size: 11px;
  color: #fff;
  text-align: left;
  background: linear-gradient(transparent, rgba(8, 16, 28, 0.72));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 底部 ---- */

.wp-picker__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-hair);
}

.wp-picker__current {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}

.wp-picker__foot-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
}
</style>
