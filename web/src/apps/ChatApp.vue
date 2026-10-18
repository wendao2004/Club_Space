<!--
  聊天应用。

  布局是经典的"左会话、右消息"两栏：窄窗口（组件自身宽度 < 620px）时左侧列表
  收成一个可切换的覆盖层，否则常驻。

  所有状态都来自 @/stores/chat（SSE 连接、未读计数、已读位置都在那里维护），
  本组件只负责展示与交互，不自己发请求拼状态 —— 否则未读数和已读回执会和
  服务端真实状态漂移。唯一直接调 api 的地方是"查看成员"，因为那份数据只在这
  个弹窗里用一次，没必要进全局 store。

  与 store 约定的接口（由 store 侧提供）：
    state:  conversations, totalUnread, contacts, messages(按会话 id 存消息),
            hasMore(按会话 id), typing(按会话 id), error
    action: connect, loadConversations, loadContacts, openConversation,
            startDirect, startGroup, loadMore, sendText, editMessage,
            recallMessage, notifyTyping, search
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { ApiError, api, formatTime } from '@/api'
import type {
  ChatContact,
  ChatConversation,
  ChatMessage,
  ChatReceipt,
  ChatSearchHit,
} from '@/api'
import { useAuth } from '@/stores/auth'
import { useChat } from '@/stores/chat'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const auth = useAuth()
const chat = useChat()

const myId = computed(() => auth.user?.id ?? '')

// ---------------------------------------------------------------- 会话列表

const searchQuery = ref('')
const searchHits = ref<ChatSearchHit[]>([])
const searching = ref(false)

/** 会话按更新时间倒序，与服务端一致；这里再兜一次底，避免往后端排序假设。 */
const conversations = computed(() =>
  [...chat.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
)

const activeId = ref<string | null>(null)
const activeConversation = computed(
  () => chat.conversations.find((conv) => conv.id === activeId.value) ?? null,
)

const activeMessages = computed<ChatMessage[]>(() => {
  const id = activeId.value
  return id ? chat.messages[id] ?? [] : []
})

const canLoadEarlier = computed(() => {
  const id = activeId.value
  return id ? chat.hasMore[id] === true : false
})

const peerOnline = computed(() => {
  const conv = activeConversation.value
  if (!conv || conv.kind !== 'direct' || !conv.peerId) return false
  return chat.contacts.some((c) => c.id === conv.peerId && c.online)
})

const MAX_UNREAD = 99

function unreadLabel(count: number): string {
  return count > MAX_UNREAD ? '99+' : String(count)
}

function avatarChar(name: string): string {
  return name.trim().charAt(0) || '?'
}

function peerOnlineOf(conv: ChatConversation): boolean {
  if (conv.kind !== 'direct' || !conv.peerId) return false
  return chat.contacts.some((c) => c.id === conv.peerId && c.online)
}

const ROLE_LABELS: Record<ChatContact['role'], string> = {
  owner: '创建者',
  admin: '管理员',
  member: '成员',
}

function roleLabel(role: ChatContact['role']): string {
  return ROLE_LABELS[role]
}

// ---------------------------------------------------------------- 搜索

let searchTimer: number | null = null

function onSearchInput(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  const query = searchQuery.value.trim()
  if (!query) {
    searchHits.value = []
    searching.value = false
    return
  }
  searching.value = true
  // 打字过程中节流，避免每个字符都打一次全文检索。
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void runSearch(query)
  }, 250)
}

async function runSearch(query: string): Promise<void> {
  try {
    const hits = await chat.search(query)
    // 结果回来时用户可能已经改了关键词，丢弃过期结果。
    if (searchQuery.value.trim() === query) searchHits.value = hits
  } finally {
    // 失败时 store 已提示，并按空结果降级。
    searching.value = false
  }
}

function clearSearch(): void {
  searchQuery.value = ''
  searchHits.value = []
  searching.value = false
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
}

// ---------------------------------------------------------------- 选中会话

const atBottom = ref(true)
const listEl = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

/** 只切换本组件的视图状态，不触发请求。 */
function activateLocal(id: string): void {
  activeId.value = id
  if (narrow.value) sidebarOpen.value = false
  editingId.value = null
  editDraft.value = ''
  draft.value = ''
  atBottom.value = true
  clearSearch()
}

function selectConversation(id: string): void {
  activateLocal(id)
  void chat.openConversation(id)
}

async function jumpToLatest(): Promise<void> {
  atBottom.value = true
  await nextTick()
  scrollToBottom()
}

async function loadEarlier(): Promise<void> {
  const id = activeId.value
  const el = listEl.value
  if (!id) return
  const previousHeight = el?.scrollHeight ?? 0
  await chat.loadMore(id)
  await nextTick()
  // 向上翻历史时保持视口位置，否则会"跳"到别处。
  if (el) el.scrollTop += el.scrollHeight - previousHeight
}

// 有新消息且用户本来就在底部时才自动跟随；正在翻历史就不要打断。
watch([activeId, () => activeMessages.value.length], async () => {
  if (!atBottom.value) return
  await nextTick()
  scrollToBottom()
})

// ---------------------------------------------------------------- 消息分组

interface MessageRow {
  msg: ChatMessage
  own: boolean
  /** 与上一条同一发送者，视觉上并入一组。 */
  continuation: boolean
  showName: boolean
}

const rows = computed<MessageRow[]>(() => {
  const list = activeMessages.value
  const isGroup = activeConversation.value?.kind === 'group'
  return list.map((msg, index) => {
    const prev = list[index - 1]
    const own = msg.senderId === myId.value
    const sameSender =
      prev !== undefined &&
      prev.senderId === msg.senderId &&
      prev.kind !== 'system' &&
      msg.kind !== 'system'
    return {
      msg,
      own,
      continuation: sameSender,
      showName: isGroup && !own && !sameSender,
    }
  })
})

// ---------------------------------------------------------------- 编辑 / 撤回

const editingId = ref<string | null>(null)
const editDraft = ref('')

function beginEdit(msg: ChatMessage): void {
  editingId.value = msg.id
  editDraft.value = msg.body ?? ''
}

function cancelEdit(): void {
  editingId.value = null
  editDraft.value = ''
}

async function submitEdit(msg: ChatMessage): Promise<void> {
  const body = editDraft.value.trim()
  if (!body || body === (msg.body ?? '')) {
    cancelEdit()
    return
  }
  // store 内部处理失败提示并更新本地消息，这里只需收尾。
  await chat.editMessage(msg.id, body)
  cancelEdit()
}

function onEditKeydown(event: KeyboardEvent, msg: ChatMessage): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submitEdit(msg)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  }
}

async function askRecall(msg: ChatMessage): Promise<void> {
  if (!window.confirm('确定撤回这条消息吗？撤回后双方都将无法再看到其内容。')) return
  // 失败提示由 store 统一处理。
  await chat.recallMessage(msg.id)
}

// ---------------------------------------------------------------- 输入区

const draft = ref('')

function onDraftInput(): void {
  const id = activeId.value
  if (id) chat.notifyTyping(id)
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词时的 Enter 是在选词，不能当作发送。
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void handleSend()
  }
}

async function handleSend(): Promise<void> {
  const id = activeId.value
  const text = draft.value.trim()
  if (!id || !text) return
  try {
    await chat.sendText(id, text)
  } catch {
    // 发送失败：store 已写入 chat.error 并弹提示，草稿原样保留，不用重打。
    return
  }
  // 成功后才清空。
  draft.value = ''
  atBottom.value = true
  await nextTick()
  scrollToBottom()
}

const typingUsers = computed(() => {
  const id = activeId.value
  return id ? chat.typing[id] ?? [] : []
})

const typingText = computed(() => {
  const list = typingUsers.value
  const first = list[0]
  if (!first) return ''
  if (list.length === 1) return `${first.displayName} 正在输入…`
  return `${list.length} 人正在输入…`
})

// ---------------------------------------------------------------- 新建会话

const panelOpen = ref(false)
const panelTab = ref<'direct' | 'group'>('direct')
const groupTitle = ref('')
const selectedIds = ref<string[]>([])
const creating = ref(false)
const contactsLoading = ref(false)

async function openPanel(): Promise<void> {
  panelOpen.value = true
  panelTab.value = 'direct'
  groupTitle.value = ''
  selectedIds.value = []
  if (chat.contacts.length === 0) {
    contactsLoading.value = true
    try {
      await chat.loadContacts()
    } catch {
      // 失败时列表就是空的，界面会给出空状态。
    } finally {
      contactsLoading.value = false
    }
  }
}

function toggleContact(id: string): void {
  const index = selectedIds.value.indexOf(id)
  if (index >= 0) selectedIds.value.splice(index, 1)
  else selectedIds.value.push(id)
}

function onContactClick(contact: ChatContact): void {
  if (panelTab.value === 'direct') void pickDirect(contact)
  else toggleContact(contact.id)
}

async function pickDirect(contact: ChatContact): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    // startDirect 内部已打开会话并返回会话 id；失败会抛出，store 已提示。
    const conversationId = await chat.startDirect(contact.id)
    panelOpen.value = false
    activateLocal(conversationId)
  } catch {
    // 失败时保持面板打开，方便重试。
  } finally {
    creating.value = false
  }
}

async function createGroup(): Promise<void> {
  const title = groupTitle.value.trim()
  if (!title || selectedIds.value.length === 0 || creating.value) return
  creating.value = true
  try {
    const conversationId = await chat.startGroup(title, [...selectedIds.value])
    panelOpen.value = false
    activateLocal(conversationId)
  } catch {
    // 失败时保持面板打开，方便重试。
  } finally {
    creating.value = false
  }
}

// ---------------------------------------------------------------- 成员面板

const membersOpen = ref(false)
const members = ref<ChatContact[]>([])
const receipts = ref<ChatReceipt[]>([])
const membersLoading = ref(false)
const membersError = ref('')

async function openMembers(): Promise<void> {
  const id = activeId.value
  if (!id) return
  membersOpen.value = true
  membersLoading.value = true
  membersError.value = ''
  try {
    const data = await api.chat.getConversation(id)
    members.value = data.members
    receipts.value = data.receipts
  } catch (err) {
    membersError.value = err instanceof ApiError ? err.message : '无法加载成员'
  } finally {
    membersLoading.value = false
  }
}

function memberReceipt(userId: string): ChatReceipt | null {
  return receipts.value.find((r) => r.userId === userId) ?? null
}

function memberRead(member: ChatContact): boolean {
  const list = activeMessages.value
  const last = list[list.length - 1]
  const receipt = memberReceipt(member.id)
  if (!last || !receipt) return false
  return receipt.lastReadSeq >= last.seq
}

// ---------------------------------------------------------------- 窄窗口

const rootEl = ref<HTMLElement | null>(null)
const narrow = ref(false)
const sidebarOpen = ref(true)
let resizeObserver: ResizeObserver | null = null

function applyNarrow(isNarrow: boolean): void {
  if (isNarrow === narrow.value) return
  narrow.value = isNarrow
  // 变窄时默认收起列表，变宽时恢复常驻。
  sidebarOpen.value = !isNarrow
}

// ---------------------------------------------------------------- 生命周期

async function boot(): Promise<void> {
  // 两个请求内部都自己处理错误（写进 chat.error），这里不需要 try。
  await chat.loadConversations()
  // 联系人用于显示在线状态小圆点，顺手拉一次。
  await chat.loadContacts()
}

onMounted(() => {
  chat.connect()
  void boot()

  const initialId = props.win.args.conversationId
  if (typeof initialId === 'string' && initialId) selectConversation(initialId)

  if (typeof ResizeObserver !== 'undefined' && rootEl.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? rootEl.value?.clientWidth ?? 0
      applyNarrow(width < 620)
    })
    resizeObserver.observe(rootEl.value)
  }
})

onBeforeUnmount(() => {
  // 刻意不断开 SSE：桌面外壳里窗口关了但应用还在，重开时应已连着。
  // 只清理本组件自己的定时器与观察器。
  resizeObserver?.disconnect()
  resizeObserver = null
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
})
</script>

<template>
  <div ref="rootEl" class="chat" :data-window-id="props.win.id">
    <div class="chat__body">
      <!-- ------------------------------------------------ 会话列表 -->
      <aside
        class="chat__side"
        :class="{ 'chat__side--floating': narrow, 'chat__side--hidden': narrow && !sidebarOpen }"
      >
        <div class="chat__side-head">
          <div class="chat__search">
            <Icon name="search" :size="15" />
            <input
              v-model="searchQuery"
              class="chat__search-input selectable"
              type="text"
              placeholder="搜索消息"
              @input="onSearchInput"
            />
            <button
              v-if="searchQuery"
              class="wl-icon-btn chat__search-clear"
              title="清除搜索"
              @click="clearSearch"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <button class="wl-icon-btn chat__new" title="新建会话" @click="openPanel">
            <Icon name="plus" :size="17" />
          </button>
        </div>

        <div v-if="chat.totalUnread > 0" class="chat__total">
          <Icon name="info" :size="13" />
          <span>{{ chat.totalUnread }} 条未读</span>
        </div>

        <div v-if="chat.error && !panelOpen" class="chat__error">
          <Icon name="alert" :size="14" />
          <span class="chat__error-text selectable">{{ chat.error }}</span>
          <button class="wl-btn wl-btn--ghost" @click="boot">重试</button>
        </div>

        <div class="chat__side-body wl-scroll">
          <!-- 搜索结果 -->
          <template v-if="searchQuery.trim()">
            <div v-if="searching" class="chat__state">
              <span class="wl-spinner" />
              <span>正在搜索…</span>
            </div>
            <div v-else-if="searchHits.length === 0" class="chat__state">
              <span>没有匹配的消息</span>
            </div>
            <div v-else class="chat__results">
              <button
                v-for="hit in searchHits"
                :key="hit.messageId"
                class="hit"
                @click="selectConversation(hit.conversationId)"
              >
                <span class="hit__top">
                  <span class="hit__conv">{{ hit.conversationTitle }}</span>
                  <span class="hit__time">{{ formatTime(hit.createdAt) }}</span>
                </span>
                <span class="hit__body">
                  <span class="hit__sender">{{ hit.senderName }}：</span>{{ hit.body }}
                </span>
              </button>
            </div>
          </template>

          <!-- 会话列表 -->
          <template v-else>
            <div v-if="chat.loadingConversations" class="chat__state">
              <span class="wl-spinner" />
              <span>正在加载会话…</span>
            </div>
            <div v-else-if="conversations.length === 0" class="wl-empty chat__empty-small">
              <Icon name="users" :size="30" />
              <p class="chat__empty-title">还没有会话</p>
              <p class="chat__empty-hint">点右上角按钮发起单聊或群聊</p>
            </div>
            <div v-else class="chat__list">
              <button
                v-for="conv in conversations"
                :key="conv.id"
                class="conv"
                :class="{ 'conv--active': conv.id === activeId }"
                @click="selectConversation(conv.id)"
              >
                <span
                  class="conv__avatar"
                  :class="{ 'conv__avatar--group': conv.kind === 'group' }"
                >
                  <Icon v-if="conv.kind === 'group'" name="users" :size="16" />
                  <template v-else>{{ avatarChar(conv.title) }}</template>
                  <span
                    v-if="conv.kind === 'direct' && peerOnlineOf(conv)"
                    class="avatar__dot avatar__dot--on"
                  />
                </span>
                <span class="conv__main">
                  <span class="conv__row">
                    <span class="conv__name">{{ conv.title }}</span>
                    <span v-if="conv.lastMessage" class="conv__time">
                      {{ formatTime(conv.lastMessage.createdAt) }}
                    </span>
                  </span>
                  <span class="conv__row">
                    <span class="conv__preview">
                      {{ conv.lastMessage?.preview || '还没有消息' }}
                    </span>
                    <span v-if="conv.unread > 0" class="conv__badge">
                      {{ unreadLabel(conv.unread) }}
                    </span>
                  </span>
                </span>
              </button>
            </div>
          </template>
        </div>
      </aside>

      <!-- ------------------------------------------------ 消息区 -->
      <section class="chat__main">
        <template v-if="activeConversation">
          <header class="chat__head">
            <button
              v-if="narrow"
              class="wl-icon-btn chat__menu"
              title="会话列表"
              @click="sidebarOpen = !sidebarOpen"
            >
              <Icon name="menu" :size="17" />
            </button>
            <div class="chat__peer">
              <span class="chat__peer-name">{{ activeConversation.title }}</span>
              <span class="chat__peer-sub">
                <template v-if="activeConversation.kind === 'direct'">
                  <span class="online-dot" :class="{ 'online-dot--on': peerOnline }" />
                  <span>{{ peerOnline ? '在线' : '离线' }}</span>
                </template>
                <template v-else>{{ activeConversation.memberCount }} 名成员</template>
              </span>
            </div>
            <button class="wl-btn chat__members-btn" @click="openMembers">
              <Icon name="users" :size="15" />
              <span>查看成员</span>
            </button>
          </header>

          <div ref="listEl" class="chat__list wl-scroll" @scroll="onScroll">
            <div v-if="canLoadEarlier" class="chat__earlier">
              <button class="wl-btn wl-btn--ghost" @click="loadEarlier">
                <Icon name="arrow-up" :size="14" />
                <span>加载更早的消息</span>
              </button>
            </div>

            <div
              v-if="activeMessages.length === 0 && !chat.loadingMessages"
              class="wl-empty chat__empty-chat"
            >
              <Icon name="users" :size="34" />
              <p>还没有消息，说点什么吧</p>
            </div>

            <div
              v-for="row in rows"
              :key="row.msg.id"
              class="msg"
              :class="{
                'msg--own': row.own,
                'msg--cont': row.continuation,
                'msg--system': row.msg.kind === 'system',
              }"
            >
              <!-- 系统消息：居中、小字、无气泡 -->
              <span v-if="row.msg.kind === 'system'" class="msg__system">
                {{ row.msg.body }}
              </span>

              <template v-else>
                <span
                  v-if="!row.own"
                  class="msg__avatar"
                  :class="{ 'msg__avatar--hide': row.continuation }"
                >
                  {{ avatarChar(row.msg.senderName) }}
                </span>

                <div class="msg__col">
                  <span v-if="row.showName" class="msg__sender">{{ row.msg.senderName }}</span>

                  <div class="msg__line">
                    <!-- 内联编辑 -->
                    <div v-if="editingId === row.msg.id" class="msg__edit">
                      <textarea
                        v-model="editDraft"
                        class="wl-textarea msg__edit-input selectable"
                        rows="2"
                        @keydown="onEditKeydown($event, row.msg)"
                      />
                      <div class="msg__edit-actions">
                        <button class="wl-btn wl-btn--primary" @click="submitEdit(row.msg)">
                          保存
                        </button>
                        <button class="wl-btn" @click="cancelEdit">取消</button>
                      </div>
                    </div>

                    <div
                      v-else
                      class="msg__bubble"
                      :class="{
                        'msg__bubble--own': row.own,
                        'msg__bubble--recalled': row.msg.recalled,
                      }"
                    >
                      <span v-if="row.msg.recalled" class="msg__recalled">消息已撤回</span>
                      <a
                        v-else-if="row.msg.kind === 'file'"
                        class="msg__file"
                        :href="api.downloadUrl(row.msg.fileNodeId ?? '')"
                        download
                      >
                        <span class="msg__file-icon"><Icon name="file" :size="20" /></span>
                        <span class="msg__file-main">
                          <span class="msg__file-name">{{ row.msg.body || '文件' }}</span>
                          <span class="msg__file-dl">下载</span>
                        </span>
                      </a>
                      <span v-else class="msg__text selectable">{{ row.msg.body }}</span>
                    </div>

                    <!-- 悬停时才出现，避免一直占用视觉噪音 -->
                    <!--
                      管理员也能撤回别人的消息（服务端 recallMessage 已收 isAdmin），
                      但**编辑**仍只限本人 —— 改写别人的发言是不可接受的边界。
                    -->
                    <div
                      v-if="(row.own || auth.isAdmin) && !row.msg.recalled"
                      class="msg__actions"
                    >
                      <button
                        v-if="row.own && row.msg.kind === 'text'"
                        class="wl-icon-btn"
                        title="编辑"
                        @click="beginEdit(row.msg)"
                      >
                        <Icon name="rename" :size="14" />
                      </button>
                      <button
                        class="wl-icon-btn"
                        :title="row.own ? '撤回' : '以管理员身份撤回'"
                        @click="askRecall(row.msg)"
                      >
                        <Icon name="trash" :size="14" />
                      </button>
                    </div>
                  </div>

                  <span class="msg__meta">
                    <span>{{ formatTime(row.msg.createdAt) }}</span>
                    <span v-if="row.msg.editedAt">（已编辑）</span>
                  </span>
                </div>
              </template>
            </div>
          </div>

          <div class="chat__typing">
            <span v-if="typingText">{{ typingText }}</span>
          </div>

          <button
            v-if="!atBottom && activeMessages.length > 0"
            class="chat__to-bottom"
            title="回到最新"
            @click="jumpToLatest"
          >
            <Icon name="arrow-down" :size="16" />
          </button>

          <footer class="chat__composer">
            <textarea
              v-model="draft"
              class="wl-textarea chat__input selectable"
              rows="1"
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              @input="onDraftInput"
              @keydown="onKeydown"
            />
            <button
              class="wl-btn wl-btn--primary chat__send"
              :disabled="!draft.trim()"
              title="发送"
              @click="handleSend"
            >
              <Icon name="arrow-up" :size="16" />
            </button>
          </footer>
        </template>

        <!-- 没有选中会话 -->
        <div v-else class="chat__welcome">
          <button
            v-if="narrow"
            class="wl-icon-btn chat__menu"
            title="会话列表"
            @click="sidebarOpen = true"
          >
            <Icon name="menu" :size="17" />
          </button>
          <div class="wl-empty chat__welcome-inner">
            <Icon name="users" :size="44" />
            <p class="chat__welcome-title">
              {{ conversations.length ? '选择左边的会话开始聊天' : '还没有会话，点新建开始' }}
            </p>
            <p class="chat__welcome-hint">
              在左侧选择会话查看消息，或点"新建"发起单聊 / 群聊。
            </p>
            <button v-if="!narrow" class="wl-btn wl-btn--primary" @click="openPanel">
              <Icon name="plus" :size="15" />
              <span>新建会话</span>
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- 窄窗口下点击遮罩收起列表 -->
    <div v-if="narrow && sidebarOpen" class="chat__scrim" @click="sidebarOpen = false" />

    <!-- ------------------------------------------------ 新建会话面板 -->
    <div v-if="panelOpen" class="chat__modal" @click.self="panelOpen = false">
      <div class="chat__modal-card">
        <header class="chat__modal-head">
          <span>新建会话</span>
          <button class="wl-icon-btn" title="关闭" @click="panelOpen = false">
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="chat__tabs">
          <button
            class="chat__tab"
            :class="{ 'chat__tab--active': panelTab === 'direct' }"
            @click="panelTab = 'direct'"
          >
            单聊
          </button>
          <button
            class="chat__tab"
            :class="{ 'chat__tab--active': panelTab === 'group' }"
            @click="panelTab = 'group'"
          >
            群聊
          </button>
        </div>

        <div class="chat__modal-body wl-scroll">
          <div v-if="contactsLoading" class="chat__state">
            <span class="wl-spinner" />
            <span>正在加载联系人…</span>
          </div>
          <div v-else-if="chat.contacts.length === 0" class="wl-empty">
            <Icon name="user" :size="28" />
            <p>没有其他成员</p>
          </div>
          <ul v-else class="contact-list">
            <li v-for="contact in chat.contacts" :key="contact.id">
              <button
                class="contact"
                :class="{ 'contact--chosen': panelTab === 'group' && selectedIds.includes(contact.id) }"
                :disabled="creating"
                @click="onContactClick(contact)"
              >
                <span
                  v-if="panelTab === 'group'"
                  class="contact__check"
                  :class="{ 'contact__check--on': selectedIds.includes(contact.id) }"
                >
                  <Icon v-if="selectedIds.includes(contact.id)" name="check" :size="12" />
                </span>
                <span class="contact__avatar">
                  {{ avatarChar(contact.displayName) }}
                  <span
                    class="avatar__dot"
                    :class="{ 'avatar__dot--on': contact.online }"
                  />
                </span>
                <span class="contact__name">{{ contact.displayName }}</span>
                <span class="contact__role">{{ roleLabel(contact.role) }}</span>
              </button>
            </li>
          </ul>
        </div>

        <footer v-if="panelTab === 'group'" class="chat__modal-foot">
          <input
            v-model="groupTitle"
            class="wl-input selectable"
            type="text"
            placeholder="群聊名称"
            maxlength="40"
          />
          <button
            class="wl-btn wl-btn--primary"
            :disabled="creating || !groupTitle.trim() || selectedIds.length === 0"
            @click="createGroup"
          >
            创建{{ selectedIds.length ? `（${selectedIds.length}）` : '' }}
          </button>
        </footer>
      </div>
    </div>

    <!-- ------------------------------------------------ 成员面板 -->
    <div v-if="membersOpen" class="chat__modal" @click.self="membersOpen = false">
      <div class="chat__modal-card">
        <header class="chat__modal-head">
          <span>成员{{ members.length ? `（${members.length}）` : '' }}</span>
          <button class="wl-icon-btn" title="关闭" @click="membersOpen = false">
            <Icon name="close" :size="16" />
          </button>
        </header>
        <div class="chat__modal-body wl-scroll">
          <div v-if="membersLoading" class="chat__state">
            <span class="wl-spinner" />
            <span>正在加载成员…</span>
          </div>
          <div v-else-if="membersError" class="chat__modal-error">
            <Icon name="alert" :size="15" />
            <span class="selectable">{{ membersError }}</span>
          </div>
          <div v-else-if="members.length === 0" class="wl-empty">
            <Icon name="users" :size="28" />
            <p>没有成员信息</p>
          </div>
          <ul v-else class="member-list">
            <li v-for="member in members" :key="member.id" class="member">
              <span class="member__avatar">
                {{ avatarChar(member.displayName) }}
                <span
                  class="avatar__dot"
                  :class="{ 'avatar__dot--on': member.online }"
                />
              </span>
              <span class="member__name">
                {{ member.displayName }}
                <span v-if="member.id === myId" class="member__self">（我）</span>
              </span>
              <span class="member__role">{{ roleLabel(member.role) }}</span>
              <span class="member__read" :class="{ 'member__read--done': memberRead(member) }">
                {{ memberRead(member) ? '已读' : '未读' }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--text);
  background: var(--surface-1);
}

.chat__body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* ---------------------------------------------------------------- 侧栏 */

.chat__side {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 260px;
  min-width: 260px;
  background: var(--surface-2);
  border-right: 1px solid var(--border-subtle);
}

.chat__side--floating {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 30;
  box-shadow: var(--shadow-popup);
  transform: translateX(0);
  transition: transform var(--dur) var(--ease-out);
}

.chat__side--hidden {
  transform: translateX(-100%);
}

.chat__side-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.chat__search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-solid);
  color: var(--text-tertiary);
  transition: border-color var(--dur-fast) var(--ease-out);
}

.chat__search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.chat__search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.chat__search-clear {
  width: 22px;
  height: 22px;
  flex: none;
}

.chat__new {
  flex: none;
}

.chat__total {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
  padding: var(--space-2) var(--space-3);
  font-size: 12px;
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border-subtle);
}

.chat__error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  font-size: 12.5px;
  color: var(--danger);
  background: var(--danger-soft);
  border-bottom: 1px solid var(--border-subtle);
}

.chat__error-text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}

.chat__side-body {
  flex: 1;
  min-height: 0;
}

.chat__state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-5);
  font-size: 13px;
  color: var(--text-tertiary);
}

.chat__empty-small {
  gap: var(--space-1);
  padding: var(--space-5) var(--space-3);
}

.chat__empty-small p {
  margin: 0;
}

.chat__empty-title {
  margin-top: var(--space-2);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-secondary);
}

.chat__empty-hint {
  font-size: 12px;
}

/* ---------------------------------------------------------------- 会话项 */

.chat__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1);
}

.conv {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.conv:hover {
  background: var(--hover);
}

.conv--active {
  background: var(--selected);
}

.conv__avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 15px;
  font-weight: 600;
}

.conv__avatar--group {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.conv__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.conv__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.conv__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__time {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
}

.conv__preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
}

/* 在线小圆点 */
.online-dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.online-dot--on {
  background: var(--success);
}

.avatar__dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--surface-2);
  background: var(--text-tertiary);
}

.avatar__dot--on {
  background: var(--success);
}

/* ---------------------------------------------------------------- 搜索结果 */

.chat__results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1);
}

.hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.hit:hover {
  background: var(--hover);
}

.hit__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.hit__conv {
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit__time {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
}

.hit__body {
  overflow: hidden;
  font-size: 12px;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit__sender {
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 消息区 */

.chat__main {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface-1);
}

.chat__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  height: 52px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.chat__menu {
  flex: none;
}

.chat__peer {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.chat__peer-name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat__peer-sub {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.chat__members-btn {
  flex: none;
}

.chat__list {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
}

.chat__earlier {
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-2);
}

.chat__empty-chat {
  margin: auto;
}

/* ---------------------------------------------------------------- 单条消息 */

.msg {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* 同一人连续发言：收紧间距，形成一组 */
.msg--cont {
  margin-top: 2px;
}

.msg--own {
  flex-direction: row-reverse;
}

.msg--system {
  justify-content: center;
}

.msg__system {
  align-self: center;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.msg__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: flex-end;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
}

.msg__avatar--hide {
  visibility: hidden;
}

.msg__col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: min(560px, 76%);
  min-width: 0;
}

.msg--own .msg__col {
  align-items: flex-end;
}

.msg__sender {
  padding: 0 var(--space-1);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.msg__line {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
}

.msg--own .msg__line {
  flex-direction: row-reverse;
}

.msg__bubble {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 13.5px;
  line-height: 1.5;
  word-break: break-word;
}

.msg__bubble--own {
  border-color: transparent;
  background: var(--accent);
  color: var(--accent-text);
}

.msg__bubble--recalled {
  border-style: dashed;
  background: var(--surface-2);
  color: var(--text-tertiary);
}

.msg__recalled {
  font-size: 12.5px;
  font-style: italic;
}

.msg__text {
  word-break: break-word;
  white-space: pre-wrap;
}

.msg__meta {
  display: flex;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  font-size: 11px;
  color: var(--text-tertiary);
}

.msg__actions {
  display: flex;
  gap: 2px;
  align-self: center;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.msg:hover .msg__actions {
  opacity: 1;
}

.msg__actions .wl-icon-btn {
  width: 26px;
  height: 26px;
}

/* 文件卡片 */
.msg__file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: inherit;
  text-decoration: none;
}

.msg__file:hover {
  text-decoration: none;
}

.msg__file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--hover);
}

.msg__file-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.msg__file-name {
  max-width: 260px;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg__file-dl {
  font-size: 11.5px;
  opacity: 0.85;
}

/* 内联编辑 */
.msg__edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 220px;
}

.msg__edit-input {
  width: 100%;
  min-height: 56px;
}

.msg__edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* ---------------------------------------------------------------- 输入区 */

.chat__typing {
  flex: none;
  min-height: 18px;
  padding: 0 var(--space-4);
  font-size: 12px;
  color: var(--text-tertiary);
}

.chat__to-bottom {
  position: absolute;
  right: var(--space-4);
  bottom: 104px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: var(--shadow-popup);
}

.chat__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-3);
  background: var(--surface-2);
  border-top: 1px solid var(--border-subtle);
}

.chat__input {
  flex: 1;
  min-height: 40px;
  max-height: 140px;
  resize: none;
  line-height: 1.5;
}

.chat__send {
  flex: none;
  width: 40px;
  height: 40px;
  padding: 0;
}

/* ---------------------------------------------------------------- 空状态 */

.chat__welcome {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
}

.chat__welcome-inner {
  gap: var(--space-2);
}

.chat__welcome-title {
  margin: var(--space-2) 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
}

.chat__welcome-hint {
  margin: 0 0 var(--space-3);
  font-size: 12.5px;
}

/* 窄窗口遮罩：压住消息区，让浮层列表浮在其上 */
.chat__scrim {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: var(--surface-1);
}

/* ---------------------------------------------------------------- 弹窗 */

.chat__modal {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--surface-1);
}

.chat__modal-card {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  max-height: min(520px, 100%);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-popup);
}

.chat__modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13.5px;
  font-weight: 600;
}

.chat__tabs {
  display: flex;
  gap: var(--space-1);
  flex: none;
  padding: var(--space-2) var(--space-3) 0;
}

.chat__tab {
  flex: 1;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 13px;
  transition: background var(--dur-fast) var(--ease-out);
}

.chat__tab--active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.chat__modal-body {
  flex: 1;
  min-height: 0;
  padding: var(--space-2);
}

.chat__modal-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.chat__modal-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  font-size: 12.5px;
  color: var(--danger);
}

/* 联系人与成员列表 */
.contact-list,
.member-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.contact {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.contact:hover {
  background: var(--hover);
}

.contact--chosen {
  background: var(--selected);
}

.contact:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.contact__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--accent-text);
}

.contact__check--on {
  border-color: var(--accent);
  background: var(--accent);
}

.contact__avatar,
.member__avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.contact__name,
.member__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contact__role,
.member__role {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.member {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
}

.member__self {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.member__read {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.member__read--done {
  color: var(--success);
}
</style>
