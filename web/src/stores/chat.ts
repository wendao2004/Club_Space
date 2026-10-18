/**
 * 聊天状态：会话列表、消息分页、SSE 实时流。
 *
 * 写之前先把三个最容易踩的坑记在这里，免得后人再踩一遍：
 *  1. 消息游标是全局自增的 seq，不是时间戳 —— 同一毫秒可能有多条消息，用时间戳做游标会丢。
 *  2. 未读数是服务端算的（max(seq) - 已读位置）。前端只在"打开会话"这种确定性动作里
 *     乐观清零，其余一律以服务端推送为准，绝不在本地按 seq 估算。
 *  3. EventSource 自带断线重连，不要再写重连循环；但 connected 状态要自己维护，
 *     并在重连（onopen）后重新对齐一次会话列表与未读，因为断线期间的事件会丢。
 */
import { defineStore } from 'pinia'
import {
  api,
  ApiError,
  type ChatContact,
  type ChatConversation,
  type ChatMessage,
  type ChatSearchHit,
} from '@/api'
import { useAuth } from '@/stores/auth'
import { useRealtime } from '@/stores/realtime'
import { useUi } from '@/stores/ui'

/** 每次拉取消息的条数。 */
const PAGE_SIZE = 50
/** 输入状态的存活时间：10 秒内没收到新的 typing 事件就自动消失。 */
const TYPING_TTL = 10_000
/** 同一会话最多每 3 秒发一次 typing，别把后端打爆。 */
const TYPING_THROTTLE = 3_000

/**
 * 聊天的实时事件订阅取消函数。
 *
 * 放在模块作用域而不是 state 里：这些是"副作用句柄"，不需要响应式追踪，
 * 放进 state 反而会被 Pinia 包成代理。
 *
 * 注意这里**不再持有 EventSource** —— 连接由 '@/stores/realtime' 统一管理，
 * 整个应用只有一条 SSE，聊天和游戏共用。
 */
let offRealtime: Array<() => void> = []

/**
 * 把已解析的事件数据包成 parseEvent 认识的样子。
 *
 * realtime 层已经做过 JSON.parse，但聊天里已有的六个处理函数都从
 * MessageEvent.data 里取字符串。包一层比改六个函数更安全 ——
 * 那些函数里的字段校验逻辑是经过测试的，不该为了这一层重构而动它们。
 */
function wrap(data: unknown): Event {
  return { data: JSON.stringify(data) } as unknown as Event
}

let typingTimer: number | null = null
/** 当前登录用户 id，用于区分"自己发的"和"别人发的"。 */
let selfUserId: string | null = null
/** 每个会话上次发出 typing 的时间戳，用于节流。 */
const lastTypingSent: Record<string, number> = {}

export interface TypingEntry {
  userId: string
  displayName: string
  at: number
}

interface State {
  conversations: ChatConversation[]
  activeId: string | null
  messages: Record<string, ChatMessage[]>
  hasMore: Record<string, boolean>
  contacts: ChatContact[]
  connected: boolean
  totalUnread: number
  loadingConversations: boolean
  loadingMessages: boolean
  error: string | null
  typing: Record<string, TypingEntry[]>
}

export const useChat = defineStore('chat', {
  state: (): State => ({
    conversations: [],
    activeId: null,
    messages: {},
    hasMore: {},
    contacts: [],
    connected: false,
    totalUnread: 0,
    loadingConversations: false,
    loadingMessages: false,
    error: null,
    typing: {},
  }),

  getters: {
    /** 当前打开的会话。 */
    active: (state): ChatConversation | null =>
      state.conversations.find((c) => c.id === state.activeId) ?? null,

    /** 当前会话的消息（按 seq 升序）。 */
    activeMessages: (state): ChatMessage[] =>
      state.activeId ? state.messages[state.activeId] ?? [] : [],

    /** 在线用户的 id 集合，用于会话/联系人列表显示在线点。 */
    onlineIds: (state): Set<string> =>
      new Set(state.contacts.filter((c) => c.online).map((c) => c.id)),
  },

  actions: {
    /**
     * 建立实时连接。
     *
     * 连接本身由 '@/stores/realtime' 统一持有 —— 整个应用只有一条 SSE，
     * 聊天和游戏共用。各自 new 一个 EventSource 会白白多占一条浏览器连接，
     * 而且两条连接的重连会各自抖动。
     *
     * 这里注册的是"收到事件后怎么改聊天状态"。
     * 重复调用是安全的：realtime.connect() 幂等，而下面的注册会因为
     * offRealtime 已存在而先解绑再重绑。
     */
    async connect(): Promise<void> {
      selfUserId = useAuth().user?.id ?? null
      const store = this

      // 已经注册过就先解绑，避免窗口反复挂载时处理器越积越多
      if (offRealtime.length > 0) {
        for (const off of offRealtime) off()
        offRealtime = []
      }

      const rt = useRealtime()
      rt.connect()
      this.connected = rt.connected

      offRealtime = [
        rt.onStatus((connected) => {
          store.connected = connected
        }),
        // 重连成功后要重新对齐会话列表与未读 —— 断线期间的事件已经丢了。
        //
        // ⚠️ 联系人也要一起补拉，这一条很容易漏：在线状态是靠 SSE 的 presence
        // 事件增量维护的，断线期间别人上下线的事件全部丢掉了。只拉会话不拉联系人，
        // 那个绿点就会一直停在断线前的状态，谁也不去纠正它 ——
        // 表现出来就是"在线状态显示异常"：明明人在，图标是灰的（或者反过来）。
        rt.onResync(() => {
          void store.loadConversations()
          void store.loadContacts()
        }),
        // 下面这些处理器原本接收 MessageEvent，realtime 层给的是已解析的数据。
        // 这里包一个只有 data 的假事件对象，让已有的 parseEvent 逻辑原样复用，
        // 避免为了改这一层而把六个处理函数全部重写一遍。
        rt.on('message', (data) => handleIncoming(store, wrap(data))),
        rt.on('message-updated', (data) => handleUpdated(store, wrap(data))),
        rt.on('conversation', () => {
          // 别人找你单聊、或把你拉进新群：整个列表重新拉一次最省心
          void store.loadConversations()
        }),
        rt.on('read', (data) => handleRead(store, wrap(data))),
        rt.on('typing', (data) => handleTyping(store, wrap(data))),
        rt.on('presence', (data) => handlePresence(store, wrap(data))),
        rt.on('unread', (data) => handleUnread(store, wrap(data))),
      ]

      if (typingTimer === null) {
        typingTimer = window.setInterval(() => pruneTyping(store), 1000)
      }
    },

    /**
     * 解除聊天对实时事件的订阅。
     *
     * **不关闭连接本身** —— 游戏模块可能还在用。真正的连接生命周期由
     * realtime store 管理，应用退出时随页面一起销毁。
     */
    disconnect(): void {
      for (const off of offRealtime) off()
      offRealtime = []
      if (typingTimer !== null) {
        window.clearInterval(typingTimer)
        typingTimer = null
      }
      this.connected = false
      this.typing = {}
    },

    async loadConversations(): Promise<void> {
      this.loadingConversations = true
      try {
        const { conversations, totalUnread } = await api.chat.conversations()
        this.conversations = conversations
        this.totalUnread = totalUnread
        sortConversations(this)
        this.error = null
      } catch (err) {
        reportError(this, err, '加载会话列表失败')
      } finally {
        this.loadingConversations = false
      }
    },

    /** 打开会话：拉最近一页消息，并把已读位置推进到最新一条。 */
    async openConversation(id: string): Promise<void> {
      this.activeId = id
      this.error = null
      this.loadingMessages = true
      try {
        const { messages, hasMore } = await api.chat.messages(id, { limit: PAGE_SIZE })
        const sorted = [...messages].sort((a, b) => a.seq - b.seq)
        this.messages[id] = sorted
        this.hasMore[id] = hasMore

        const last = sorted.length > 0 ? sorted[sorted.length - 1] : undefined
        if (last) await this.markRead(id, last.seq)
      } catch (err) {
        reportError(this, err, '加载消息失败')
      } finally {
        this.loadingMessages = false
      }
    },

    /** 向上翻历史：用当前最早一条的 seq 作为 before 游标。 */
    async loadMore(conversationId: string): Promise<void> {
      if (!this.hasMore[conversationId]) return
      const current = this.messages[conversationId]
      if (!current || current.length === 0) return
      const earliest = current[0]
      if (!earliest) return

      this.loadingMessages = true
      try {
        const { messages, hasMore } = await api.chat.messages(conversationId, {
          before: earliest.seq,
          limit: PAGE_SIZE,
        })
        const seen = new Set(current.map((m) => m.seq))
        const older = messages
          .filter((m) => m.seq < earliest.seq && !seen.has(m.seq))
          .sort((a, b) => a.seq - b.seq)
        this.messages[conversationId] = [...older, ...current]
        this.hasMore[conversationId] = hasMore
        this.error = null
      } catch (err) {
        reportError(this, err, '加载更多消息失败')
      } finally {
        this.loadingMessages = false
      }
    },

    /** 打开（或新建）与某人的单聊，返回会话 id，并自动打开。 */
    async startDirect(peerId: string): Promise<string> {
      try {
        const { conversation } = await api.chat.openDirect(peerId)
        upsertConversation(this, conversation)
        await this.openConversation(conversation.id)
        return conversation.id
      } catch (err) {
        reportError(this, err, '发起会话失败')
        throw err
      }
    },

    /** 创建群聊，返回会话 id，并自动打开。 */
    async startGroup(title: string, memberIds: string[]): Promise<string> {
      try {
        const { conversation } = await api.chat.createGroup(title, memberIds)
        upsertConversation(this, conversation)
        await this.openConversation(conversation.id)
        return conversation.id
      } catch (err) {
        reportError(this, err, '创建群聊失败')
        throw err
      }
    },

    async sendText(conversationId: string, body: string): Promise<void> {
      const text = body.trim()
      if (!text) return
      try {
        const { message } = await api.chat.send(conversationId, { kind: 'text', body: text })
        insertMessage(this, message)
        bumpConversation(this, message)
        this.error = null
      } catch (err) {
        reportError(this, err, '发送消息失败')
        // 重新抛出：调用方据此判断是否清空输入框，发送失败时把草稿保留下来。
        throw err
      }
    },

    async sendFile(conversationId: string, fileNodeId: string, name: string): Promise<void> {
      try {
        const { message } = await api.chat.send(conversationId, {
          kind: 'file',
          fileNodeId,
          body: name,
        })
        insertMessage(this, message)
        bumpConversation(this, message)
        this.error = null
      } catch (err) {
        reportError(this, err, '发送文件失败')
        throw err
      }
    },

    async editMessage(messageId: string, body: string): Promise<void> {
      const text = body.trim()
      if (!text) return
      try {
        const { message } = await api.chat.editMessage(messageId, text)
        applyMessageUpdate(this, message)
        this.error = null
      } catch (err) {
        reportError(this, err, '修改消息失败')
      }
    },

    async recallMessage(messageId: string): Promise<void> {
      try {
        const { message } = await api.chat.recallMessage(messageId)
        applyMessageUpdate(this, message)
        this.error = null
      } catch (err) {
        reportError(this, err, '撤回消息失败')
      }
    },

    /**
     * 标记已读。已读位置只前进不后退。
     * 这是后台记账动作，失败不弹提示（离线时打开会话会静默失败），只记到 error。
     */
    async markRead(conversationId: string, seq: number): Promise<void> {
      const conv = findConversation(this, conversationId)
      if (!conv || seq <= conv.lastReadSeq) return

      const cleared = conv.unread
      conv.lastReadSeq = seq
      conv.unread = 0
      this.totalUnread = Math.max(0, this.totalUnread - cleared)

      try {
        const { lastReadSeq } = await api.chat.markRead(conversationId, seq)
        conv.lastReadSeq = Math.max(conv.lastReadSeq, lastReadSeq)
        conv.unread = 0
      } catch (err) {
        // 回滚乐观值；服务端的已读位置只增不减，下次打开会重新对齐。
        conv.unread = cleared
        this.totalUnread += cleared
        this.error = messageOf(err)
      }
    },

    /** 通知服务端"我正在输入"。同一会话 3 秒内最多发一次（节流）。 */
    notifyTyping(conversationId: string): void {
      const now = Date.now()
      if (now - (lastTypingSent[conversationId] ?? 0) < TYPING_THROTTLE) return
      lastTypingSent[conversationId] = now
      void api.chat.typing(conversationId).catch((err: unknown) => {
        // 输入状态是"尽力而为"的信号，失败不打扰用户。
        this.error = messageOf(err)
      })
    },

    async loadContacts(): Promise<void> {
      try {
        const { contacts } = await api.chat.contacts()
        this.contacts = contacts
        this.error = null
      } catch (err) {
        reportError(this, err, '加载联系人失败')
      }
    },

    async search(q: string): Promise<ChatSearchHit[]> {
      try {
        const { hits } = await api.chat.search(q)
        return hits
      } catch (err) {
        reportError(this, err, '搜索失败')
        return []
      }
    },
  },
})

// ---------------------------------------------------------------- 模块级工具

type ChatStore = ReturnType<typeof useChat>

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** 统一的错误处理：写进 error，并弹一个错误提示，不抛出（调用方自行决定是否 rethrow）。 */
function reportError(store: ChatStore, err: unknown, title: string): void {
  const message = messageOf(err)
  store.error = message
  useUi().notify('error', title, message)
}

/** 解析 SSE 事件里的 JSON。坏数据直接丢弃，绝不让它把整个事件循环带崩。 */
function parseEvent<T>(event: Event): T | null {
  const data = (event as MessageEvent).data
  if (typeof data !== 'string' || data.length === 0) return null
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

function findConversation(store: ChatStore, id: string): ChatConversation | undefined {
  return store.conversations.find((c) => c.id === id)
}

/** 让最新的会话排在最前。 */
function sortConversations(store: ChatStore): void {
  store.conversations.sort((a, b) => b.updatedAt - a.updatedAt)
}

function previewOf(msg: ChatMessage): string {
  if (msg.recalled) return '消息已撤回'
  const body = msg.body?.trim()
  if (body) return body
  if (msg.kind === 'file') return '[文件]'
  if (msg.kind === 'system') return '系统消息'
  return ''
}

function lastMessageOf(msg: ChatMessage): NonNullable<ChatConversation['lastMessage']> {
  return {
    id: msg.id,
    seq: msg.seq,
    senderId: msg.senderId,
    senderName: msg.senderName,
    kind: msg.kind,
    preview: previewOf(msg),
    createdAt: msg.createdAt,
  }
}

function upsertConversation(store: ChatStore, conversation: ChatConversation): void {
  const index = store.conversations.findIndex((c) => c.id === conversation.id)
  if (index >= 0) store.conversations[index] = conversation
  else store.conversations.push(conversation)
  sortConversations(store)
}

/**
 * 把一条消息按 seq 升序插入本地数组，并按 seq/id 去重。
 * 返回 true 表示是新消息（用于后续更新会话摘要）。
 * 该会话没打开过也要建数组，否则实时消息会无处安放。
 */
function insertMessage(store: ChatStore, msg: ChatMessage): boolean {
  const list = store.messages[msg.conversationId] ?? (store.messages[msg.conversationId] = [])
  const existing = list.findIndex((m) => m.seq === msg.seq || m.id === msg.id)
  if (existing >= 0) {
    list[existing] = msg
    return false
  }

  let index = list.length
  while (index > 0) {
    const prev = list[index - 1]
    if (!prev || prev.seq <= msg.seq) break
    index -= 1
  }
  list.splice(index, 0, msg)
  return true
}

/** 更新会话列表里对应项的 lastMessage 与 updatedAt（seq 回退时不覆盖更新的摘要）。 */
function bumpConversation(store: ChatStore, msg: ChatMessage): void {
  const conv = findConversation(store, msg.conversationId)
  if (!conv) return
  if (conv.lastMessage && conv.lastMessage.seq > msg.seq) return
  conv.lastMessage = lastMessageOf(msg)
  conv.updatedAt = msg.createdAt
  sortConversations(store)
}

/** 按 id/seq 替换本地那条消息；若它正好是会话最后一条，同步更新摘要（撤回/编辑都会用到）。 */
function applyMessageUpdate(store: ChatStore, msg: ChatMessage): void {
  const list = store.messages[msg.conversationId]
  if (list) {
    const index = list.findIndex((m) => m.id === msg.id || m.seq === msg.seq)
    if (index >= 0) list[index] = msg
  }
  const conv = findConversation(store, msg.conversationId)
  if (conv && conv.lastMessage && conv.lastMessage.id === msg.id) {
    conv.lastMessage = lastMessageOf(msg)
  }
}

// ---------------------------------------------------------------- SSE 事件处理

function handleIncoming(store: ChatStore, event: Event): void {
  const msg = parseEvent<ChatMessage>(event)
  if (!msg || !msg.conversationId || typeof msg.seq !== 'number') return

  const isNew = insertMessage(store, msg)
  if (isNew) bumpConversation(store, msg)

  // 正在看这个会话，就立刻把已读位置推进，否则界面会一直挂着未读。
  if (msg.conversationId === store.activeId && msg.senderId !== selfUserId) {
    void store.markRead(msg.conversationId, msg.seq)
  }
}

function handleUpdated(store: ChatStore, event: Event): void {
  const msg = parseEvent<ChatMessage>(event)
  if (msg) applyMessageUpdate(store, msg)
}

function handleRead(store: ChatStore, event: Event): void {
  const data = parseEvent<{
    conversationId?: string
    userId?: string
    lastReadSeq?: number
    unread?: number
  }>(event)
  if (!data?.conversationId) return
  // 当前打开的会话自己会走 markRead，忽略即可。
  if (data.conversationId === store.activeId) return
  // 只有"我自己在别的设备上读了"才会影响我的未读。
  if (data.userId !== selfUserId) return

  const conv = findConversation(store, data.conversationId)
  if (!conv) return
  if (typeof data.lastReadSeq === 'number') {
    conv.lastReadSeq = Math.max(conv.lastReadSeq, data.lastReadSeq)
  }
  if (typeof data.unread === 'number') {
    const delta = conv.unread - data.unread
    conv.unread = data.unread
    store.totalUnread = Math.max(0, store.totalUnread - delta)
  }
}

function handleTyping(store: ChatStore, event: Event): void {
  const data = parseEvent<{ conversationId?: string; userId?: string; displayName?: string }>(event)
  if (!data?.conversationId || !data.userId) return
  if (data.userId === selfUserId) return

  const now = Date.now()
  const list = store.typing[data.conversationId] ?? (store.typing[data.conversationId] = [])
  const entry = list.find((e) => e.userId === data.userId)
  if (entry) entry.at = now
  else list.push({ userId: data.userId, displayName: data.displayName ?? '', at: now })
  store.typing[data.conversationId] = list.filter((e) => now - e.at < TYPING_TTL)
}

function handlePresence(store: ChatStore, event: Event): void {
  const data = parseEvent<{ userId?: string; id?: string; online?: boolean }>(event)
  if (!data) return
  const userId = data.userId ?? data.id
  if (!userId || typeof data.online !== 'boolean') return
  const contact = store.contacts.find((c) => c.id === userId)
  // 不在联系人列表里就忽略（可能是路人，界面不需要展示）。
  if (contact) contact.online = data.online
}

function handleUnread(store: ChatStore, event: Event): void {
  const data = parseEvent<{ totalUnread?: number } | number>(event)
  if (typeof data === 'number') {
    store.totalUnread = data
  } else if (data && typeof data.totalUnread === 'number') {
    store.totalUnread = data.totalUnread
  }
}

/** 清掉超过 10 秒的输入状态。 */
function pruneTyping(store: ChatStore): void {
  const now = Date.now()
  for (const id of Object.keys(store.typing)) {
    const kept = (store.typing[id] ?? []).filter((e) => now - e.at < TYPING_TTL)
    if (kept.length > 0) store.typing[id] = kept
    else delete store.typing[id]
  }
}
