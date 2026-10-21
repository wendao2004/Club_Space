<!--
  打字背单词。

  玩法参考 qwerty-learner（GPL-3，代码没搬只借鉴交互）：逐词显示，键盘
  输入，打错必须重打该词 —— 保住肌肉记忆的正确性。进度与错题本存服务端，
  换设备接着练。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, type TypingProgress, type TypingWrong } from '@/api'
import { TYPING_DICTS, type TypingDict, type TypingWord } from '@/lib/dicts'
import { useUi } from '@/stores/ui'
import type { WindowInstance } from '@/stores/windows'

defineProps<{ win: WindowInstance }>()

const ui = useUi()

// ---------------------------------------------------------------- 状态

const progress = ref<TypingProgress[]>([])
const wrong = ref<TypingWrong[]>([])
const loading = ref(true)

type Mode = 'home' | 'practice'
const mode = ref<Mode>('home')
const currentDict = ref<TypingDict | null>(null)
const currentChapter = ref(0)

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    const [p, w] = await Promise.all([api.typing.progress(), api.typing.wrong()])
    progress.value = p.progress
    wrong.value = w.wrong
  } catch (err) {
    ui.notify('error', '打字练习', err instanceof Error ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function positionOf(dictId: string, chapter: number): number {
  return progress.value.find((p) => p.dict === dictId && p.chapter === chapter)?.position ?? 0
}

// ---------------------------------------------------------------- 练习

const words = computed<TypingWord[]>(() => currentDict.value?.chapters[currentChapter.value]?.words ?? [])

/** 当前练到第几个词。 */
const pos = ref(0)
/** 已经敲对的字符数（含当前词的进度）。 */
const typed = ref('')
/** 本词是否出过错（出过错的词进错题本）。 */
const wordHadError = ref(false)
/** 本 章 统计。 */
const stats = ref({ words: 0, errors: 0, startAt: 0 })
/** 章节结算弹层。 */
const finished = ref(false)
/** 默写模式：隐藏释义（只看拼写回忆意思）。 */
const blind = ref(false)

const word = computed(() => words.value[pos.value] ?? null)
const wordChars = computed(() => word.value?.w.split('') ?? [])
const isWrongWord = computed(() => {
  const w = word.value
  return w !== null && wrong.value.some((x) => x.dict === currentDict.value?.id && x.word === w.w)
})

async function startPractice(dict: TypingDict, chapter: number): Promise<void> {
  currentDict.value = dict
  currentChapter.value = chapter
  pos.value = Math.min(positionOf(dict.id, chapter), dict.chapters[chapter]?.words.length ?? 0)
  typed.value = ''
  wordHadError.value = false
  stats.value = { words: 0, errors: 0, startAt: Date.now() }
  finished.value = false
  mode.value = 'practice'
  focusInput()
}

async function savePosition(): Promise<void> {
  if (!currentDict.value) return
  try {
    await api.typing.saveProgress({
      dict: currentDict.value.id,
      chapter: currentChapter.value,
      position: pos.value,
    })
  } catch {
    // 进度保存失败不打断练习（下一次换词会再存）
  }
}

async function recordWrongWord(): Promise<void> {
  if (!currentDict.value || !word.value) return
  try {
    await api.typing.recordWrong({ dict: currentDict.value.id, word: word.value.w })
    const exist = wrong.value.find((x) => x.dict === currentDict.value!.id && x.word === word.value!.w)
    if (exist) {
      exist.wrongCount += 1
      exist.lastAt = Date.now()
    } else {
      wrong.value = [{ dict: currentDict.value.id, word: word.value.w, wrongCount: 1, lastAt: Date.now() }, ...wrong.value]
    }
  } catch {
    // 错题记录失败同样不打断
  }
}

async function finishChapter(): Promise<void> {
  finished.value = true
  await savePosition()
}

/** 章内继续下一章（如有）。 */
async function nextChapter(): Promise<void> {
  if (!currentDict.value) return
  const next = currentChapter.value + 1
  if (next < currentDict.value.chapters.length) {
    await startPractice(currentDict.value, next)
  } else {
    mode.value = 'home'
  }
}

// ---------------------------------------------------------------- 键盘输入

const inputEl = ref<HTMLInputElement | null>(null)

function focusInput(): void {
  // 等一拍让输入框挂出来
  requestAnimationFrame(() => inputEl.value?.focus())
}

function onInput(): void {
  const el = inputEl.value
  const w = word.value
  if (!el || !w) return
  const value = el.value
  const target = w.w

  // 逐字符比对：错一个就整词重打 —— qwerty-learner 的核心约束
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== target[i]) {
      wordHadError.value = true
      stats.value.errors += 1
      el.value = ''
      typed.value = ''
      return
    }
  }
  typed.value = value

  if (value === target) {
    stats.value.words += 1
    if (wordHadError.value) void recordWrongWord()
    const next = pos.value + 1
    pos.value = next
    el.value = ''
    typed.value = ''
    wordHadError.value = false
    if (next >= words.value.length) {
      void finishChapter()
    } else {
      void savePosition()
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  // Ctrl+V 切默写模式（qwerty-learner 的同款快捷键，Ctrl+Shift+V 显示释义）
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
    event.preventDefault()
    blind.value = !blind.value
  }
  // Enter / Tab 跳过当前词（跳过的词不进错题本）
  if ((event.key === 'Enter' || event.key === 'Tab') && mode.value === 'practice') {
    event.preventDefault()
    const next = pos.value + 1
    if (inputEl.value) inputEl.value.value = ''
    typed.value = ''
    wordHadError.value = false
    pos.value = Math.min(next, words.value.length)
    if (pos.value >= words.value.length) void finishChapter()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void loadAll()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

watch(mode, (m) => {
  if (m === 'practice') focusInput()
})

// ---------------------------------------------------------------- 展示辅助

const elapsedMin = computed(() => Math.max(1, Math.round((Date.now() - stats.value.startAt) / 60_000)))

function chapterState(dict: TypingDict, i: number): 'done' | 'doing' | 'todo' {
  const p = positionOf(dict.id, i)
  const len = dict.chapters[i]?.words.length ?? 0
  if (p >= len && len > 0) return 'done'
  if (p > 0) return 'doing'
  return 'todo'
}

async function clearWrongAll(): Promise<void> {
  if (!window.confirm('清空错题本？')) return
  try {
    await api.typing.clearWrong({})
    wrong.value = []
  } catch (err) {
    ui.notify('error', '错题本', err instanceof Error ? err.message : '清空失败')
  }
}

function removeWrong(wordStr: string): void {
  void (async () => {
    try {
      await api.typing.clearWrong({ word: wordStr })
      wrong.value = wrong.value.filter((x) => x.word !== wordStr)
    } catch {
      // 同上，不打断
    }
  })()
}
</script>

<template>
  <div class="typing-app">
    <header class="bar">
      <div class="bar-title"><Icon name="text" :size="18" />打字背单词</div>
      <div class="spacer" />
      <button v-if="mode === 'practice'" class="wl-btn wl-btn--sm" @click="blind = !blind">
        {{ blind ? '默写中 (Ctrl+V 切换)' : '释义显示中 (Ctrl+V 切换)' }}
      </button>
      <button class="wl-icon-btn" :disabled="loading" title="刷新" @click="loadAll()">
        <Icon name="refresh" :size="16" :class="{ spin: loading }" />
      </button>
    </header>

    <!-- 选库首页 -->
    <div v-if="mode === 'home'" class="home">
      <section class="dicts">
        <article v-for="d in TYPING_DICTS" :key="d.id" class="dict-card">
          <h3 class="dict-name">{{ d.name }}</h3>
          <div class="chapters">
            <button
              v-for="(ch, i) in d.chapters"
              :key="i"
              class="chapter"
              :class="`chapter--${chapterState(d, i)}`"
              @click="startPractice(d, i)"
            >
              <span class="chapter-title">{{ ch.title }}</span>
              <span class="chapter-pos">
                {{ chapterState(d, i) === 'done' ? '✓' : `${positionOf(d.id, i)}/${ch.words.length}` }}
              </span>
            </button>
          </div>
        </article>
      </section>

      <!-- 错题本 -->
      <section class="wrong">
        <header class="wrong-head">
          <strong>错题本（{{ wrong.length }}）</strong>
          <div class="spacer" />
          <button v-if="wrong.length > 0" class="wl-btn wl-btn--sm" @click="clearWrongAll">清空</button>
        </header>
        <p v-if="wrong.length === 0" class="empty">出过错的词会出现在这里，练完一章来复习</p>
        <div v-for="x in wrong.slice(0, 30)" :key="x.dict + x.word" class="wrong-row">
          <code class="wrong-word">{{ x.word }}</code>
          <span class="wrong-meta">错 {{ x.wrongCount }} 次</span>
          <button class="wl-icon-btn" title="移出错题本" @click="removeWrong(x.word)">
            <Icon name="close" :size="12" />
          </button>
        </div>
      </section>
    </div>

    <!-- 练习页 -->
    <div v-else-if="mode === 'practice' && word" class="practice" @click="focusInput">
      <div class="p-head">
        <button class="wl-btn wl-btn--sm" @click="mode = 'home'">
          <Icon name="chevron-left" :size="13" />返回
        </button>
        <span class="p-title">{{ currentDict?.name }} · {{ currentDict?.chapters[currentChapter]?.title }}</span>
        <div class="spacer" />
        <span class="p-stat">正确 {{ stats.words }}</span>
        <span class="p-stat">出错 {{ stats.errors }}</span>
      </div>

      <div class="p-progress">
        <div class="p-progress-bar" :style="{ width: `${(pos / words.length) * 100}%` }" />
      </div>

      <div class="p-stage">
        <div class="p-phonetic" :class="{ 'p-phonetic--hidden': blind }">{{ word.ipa || '　' }}</div>
        <div class="p-word">
          <span
            v-for="(c, i) in wordChars"
            :key="i"
            class="p-char"
            :class="{ 'p-char--done': i < typed.length }"
          >{{ blind || i >= typed.length ? c : c }}</span>
        </div>
        <div class="p-meaning" :class="{ 'p-meaning--hidden': blind }">{{ word.t }}</div>
        <input
          ref="inputEl"
          class="p-input"
          :placeholder="`输入 ${word.w} 后回车继续 · 错了整词重打`"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @input="onInput"
        />
        <div class="p-hint">
          Enter / Tab 跳过 · Ctrl+V 切默写 ·
          <Icon v-if="isWrongWord" name="alert" :size="12" class="p-hint-wrong" /> 这个词在你的错题本里
        </div>
      </div>
    </div>

    <!-- 章节结算 -->
    <div v-if="finished" class="mask">
      <div class="result">
        <h3>本章完成 🎉</h3>
        <p class="result-line">练习 {{ stats.words }} 个词 · 出错 {{ stats.errors }} 次 · 用时约 {{ elapsedMin }} 分钟</p>
        <p class="result-line">进度已保存，下次进来接着练</p>
        <div class="result-actions">
          <button class="wl-btn" @click="mode = 'home'; finished = false">回列表</button>
          <button class="wl-btn wl-btn--primary" @click="finished = false; nextChapter()">下一章</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.typing-app {
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

/* ---------------- 首页 */

.home {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.dicts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: var(--space-3);
}

.dict-card {
  border: 1px solid var(--line-hair);
  border-radius: 10px;
  padding: var(--space-3);
  background: var(--surface-1);
}

.dict-name {
  margin: 0 0 var(--space-2);
  font-size: 14px;
}

.chapters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.chapter {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 10px;
  border: 1px solid var(--line-hair);
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 12px;
  cursor: pointer;
}

.chapter:hover {
  border-color: var(--accent);
}

.chapter--done {
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

.chapter--doing {
  border-style: dashed;
}

.chapter-pos {
  color: var(--text-3);
  font-size: 11px;
}

/* ---------------- 错题本 */

.wrong {
  border: 1px solid var(--line-hair);
  border-radius: 10px;
  padding: var(--space-3);
  background: var(--surface-1);
}

.wrong-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  margin-bottom: var(--space-2);
}

.wrong-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 0;
}

.wrong-word {
  font-size: 13px;
  font-weight: 600;
}

.wrong-meta {
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
}

.empty {
  margin: var(--space-2) 0;
  font-size: 12px;
  color: var(--text-3);
}

/* ---------------- 练习页 */

.practice {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  cursor: text;
}

.p-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-hair);
}

.p-title {
  font-size: 12px;
  color: var(--text-2);
}

.p-stat {
  font-size: 12px;
  color: var(--text-3);
}

.p-progress {
  height: 3px;
  background: var(--surface-2);
}

.p-progress-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}

.p-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4);
}

.p-phonetic {
  font-size: 16px;
  color: var(--text-3);
  font-family: monospace;
}

.p-phonetic--hidden {
  visibility: hidden;
}

.p-word {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}

.p-char {
  font-size: 40px;
  font-weight: 600;
  font-family: monospace;
  color: var(--text-3);
  min-width: 0.6em;
}

.p-char--done {
  color: var(--accent);
}

.p-meaning {
  font-size: 15px;
  color: var(--text-2);
}

.p-meaning--hidden {
  visibility: hidden;
}

.p-input {
  width: min(420px, 90%);
  padding: 10px 14px;
  font-size: 16px;
  text-align: center;
  border: 1px solid var(--line-hair);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--text-1);
  outline: none;
}

.p-input:focus {
  border-color: var(--accent);
}

.p-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.p-hint-wrong {
  color: var(--warning, #d97706);
}

/* ---------------- 结算 */

.mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.result {
  width: min(380px, 90%);
  background: var(--surface-1);
  border: 1px solid var(--line-hair);
  border-radius: 12px;
  padding: var(--space-4);
  text-align: center;
}

.result h3 {
  margin: 0 0 var(--space-2);
}

.result-line {
  margin: var(--space-1) 0;
  font-size: 13px;
  color: var(--text-2);
}

.result-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
  margin-top: var(--space-3);
}
</style>
