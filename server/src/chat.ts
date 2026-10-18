/**
 * 聊天数据层。
 *
 * 几个设计决定值得说明：
 *
 * 1. **单聊唯一性靠数据库约束，不靠应用层查重。** 两个用户之间只应存在一个单聊，
 *    用 `pair_key`（两个 id 排序后拼接）+ 唯一索引来保证。应用层"先查再插"在并发下
 *    一定会漏，然后用户就会看到两个一样的会话。
 *
 * 2. **未读数由 seq 相减得出，不用计数表。** 计数表要么每次读写都更新（写放大、
 *    且容易和真实状态漂移），要么就得定期重算。而 `max(seq) - last_read_seq` 永远是准的。
 *    唯一代价是实时性差一点 —— 发新消息时主动推给在线的人即可。
 *
 * 3. **消息用 seq 做游标而不是时间戳。** 同一毫秒内可能有多条消息，用时间戳拉增量会丢消息，
 *    而且重连补拉时边界处理很痛苦。全局自增的 seq 是单调的，逻辑简单且正确。
 */
import { getDb, newId, now, transaction } from './db.ts'
import { HttpError } from './files.ts'

export interface ConversationSummary {
  id: string
  kind: 'direct' | 'group'
  title: string
  /** 单聊时对方的用户 id（前端用来显示头像与名字）。 */
  peerId: string | null
  memberCount: number
  lastMessage: {
    id: string
    seq: number
    senderId: string
    senderName: string
    kind: string
    preview: string
    createdAt: number
  } | null
  unread: number
  lastReadSeq: number
  updatedAt: number
}

export interface MessageView {
  id: string
  seq: number
  conversationId: string
  senderId: string
  senderName: string
  kind: string
  body: string | null
  fileNodeId: string | null
  replyTo: string | null
  editedAt: number | null
  deletedAt: number | null
  createdAt: number
  /** 已撤回的消息不返回原文，避免"撤回"变成摆设。 */
  recalled: boolean
}

// ---------------------------------------------------------------- 成员与权限

export function isMember(conversationId: string, userId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId) as { ok: number } | undefined
  return row !== undefined
}

function requireMember(conversationId: string, userId: string): void {
  if (!isMember(conversationId, userId)) {
    throw new HttpError(403, '你不是该会话的成员')
  }
}

function memberIdsInternal(conversationId: string): string[] {
  const rows = getDb()
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId) as unknown as Array<{ user_id: string }>
  return rows.map((r) => r.user_id)
}

/**
 * 会话成员的用户 id。对外导出，供推送层决定把事件发给谁。
 */
export const memberIds = memberIdsInternal

// ---------------------------------------------------------------- 会话

/** 单聊的规范化键：两个 id 排序后拼接，与顺序无关。 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * 找到或创建一个单聊。
 *
 * 用事务 + 唯一索引处理并发：两个客户端同时点开同一个人的对话时，
 * 其中一个会撞上唯一约束，此时回退成"读取已存在的那条"。
 */
export function getOrCreateDirect(userId: string, peerId: string): string {
  if (userId === peerId) throw new HttpError(400, '不能和自己创建会话')

  const peer = getDb().prepare('SELECT id, status FROM users WHERE id = ?').get(peerId) as
    | { id: string; status: string }
    | undefined
  if (!peer) throw new HttpError(404, '对方不存在')
  if (peer.status !== 'active') throw new HttpError(400, '对方账号已停用')

  const key = pairKey(userId, peerId)

  return transaction(() => {
    const existing = getDb()
      .prepare('SELECT id FROM conversations WHERE pair_key = ?')
      .get(key) as { id: string } | undefined
    if (existing) return existing.id

    const id = newId('c')
    const ts = now()
    getDb()
      .prepare(
        `INSERT INTO conversations (id, kind, title, created_by, pair_key, created_at, updated_at)
         VALUES (?, 'direct', NULL, ?, ?, ?, ?)`,
      )
      .run(id, userId, key, ts, ts)

    const add = getDb().prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    )
    add.run(id, userId, ts)
    add.run(id, peerId, ts)
    return id
  })
}

export function createGroup(creatorId: string, title: string, memberIdsInput: string[]): string {
  const cleanTitle = title.trim()
  if (!cleanTitle) throw new HttpError(400, '群聊需要名称')
  if (cleanTitle.length > 64) throw new HttpError(400, '群聊名称过长')

  // 去重并确保创建者在里面
  const members = [...new Set([creatorId, ...memberIdsInput])].filter(Boolean)
  if (members.length < 2) throw new HttpError(400, '群聊至少需要两个人')

  const db = getDb()
  for (const id of members) {
    const exists = db.prepare("SELECT 1 AS ok FROM users WHERE id = ? AND status = 'active'").get(id)
    if (!exists) throw new HttpError(400, `成员不存在或已停用：${id}`)
  }

  return transaction(() => {
    const id = newId('c')
    const ts = now()
    db.prepare(
      `INSERT INTO conversations (id, kind, title, created_by, pair_key, created_at, updated_at)
       VALUES (?, 'group', ?, ?, NULL, ?, ?)`,
    ).run(id, cleanTitle, creatorId, ts, ts)

    const add = db.prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
    )
    for (const uid of members) {
      add.run(id, uid, uid === creatorId ? 'owner' : 'member', ts)
    }

    // 群创建本身是一条系统消息：新成员进来能看见"这个群是什么时候建的、谁建的"
    appendMessage({
      conversationId: id,
      senderId: creatorId,
      kind: 'system',
      body: `${cleanTitle} —— 会话已创建`,
    })
    return id
  })
}

export function listConversations(userId: string): ConversationSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.kind, c.title, c.created_by, c.updated_at,
              cm.last_read_seq, cm.muted,
              (SELECT COUNT(*) FROM conversation_members m2 WHERE m2.conversation_id = c.id) AS member_count,
              -- 未读数是**本会话内** seq 大于我已读水位的消息条数。
              --
              -- 这里刻意用 COUNT 而不是 (MAX(seq) - last_read_seq)：seq 是**全局**自增的，
              -- 两个数字相减得到的是"本会话最新消息在全库里的序号"，而不是本会话的未读数。
              -- 后果很离谱：库里有几万条消息时，一个刚被拉进新群、还没打开过的成员，
              -- 未读数会显示成几万。测试没抓到是因为测试里所有人都先发过言。
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                  AND m.seq > cm.last_read_seq) AS unread_count,
              (SELECT u.id FROM conversation_members m3
                 JOIN users u ON u.id = m3.user_id
                WHERE m3.conversation_id = c.id AND m3.user_id != ? LIMIT 1) AS peer_id
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
        ORDER BY c.updated_at DESC
        LIMIT 200`,
    )
    .all(userId, userId) as unknown as Array<{
    id: string
    kind: 'direct' | 'group'
    title: string | null
    created_by: string
    updated_at: number
    last_read_seq: number
    muted: number
    member_count: number
    unread_count: number
    peer_id: string | null
  }>

  const result: ConversationSummary[] = []
  for (const row of rows) {
    const last = getDb()
      .prepare(
        `SELECT m.id, m.seq, m.sender_id, m.kind, m.body, m.created_at, u.display_name
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? AND m.deleted_at IS NULL
          ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(row.id) as
      | {
          id: string
          seq: number
          sender_id: string
          kind: string
          body: string | null
          created_at: number
          display_name: string
        }
      | undefined

    // 单聊的标题用对方的名字实时算，而不是建会话时写死 ——
    // 否则对方改了显示名，你的会话列表里还是旧名字。
    let title = row.title ?? '会话'
    if (row.kind === 'direct' && row.peer_id) {
      const peer = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(row.peer_id) as
        | { display_name: string }
        | undefined
      title = peer?.display_name ?? '会话'
    }

    const unread = Math.max(0, row.unread_count)

    result.push({
      id: row.id,
      kind: row.kind,
      title,
      peerId: row.peer_id,
      memberCount: row.member_count,
      lastMessage: last
        ? {
            id: last.id,
            seq: last.seq,
            senderId: last.sender_id,
            senderName: last.display_name,
            kind: last.kind,
            preview: previewOf(last.kind, last.body),
            createdAt: last.created_at,
          }
        : null,
      unread,
      lastReadSeq: row.last_read_seq,
      updatedAt: row.updated_at,
    })
  }
  return result
}

function previewOf(kind: string, body: string | null): string {
  if (kind === 'file') return `[文件] ${body ?? ''}`.trim()
  if (kind === 'system') return body ?? ''
  const text = (body ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export function getConversation(conversationId: string, userId: string): ConversationSummary {
  requireMember(conversationId, userId)
  const found = listConversations(userId).find((c) => c.id === conversationId)
  if (!found) throw new HttpError(404, '会话不存在')
  return found
}

// ---------------------------------------------------------------- 消息

function toMessageView(row: {
  id: string
  seq: number
  conversation_id: string
  sender_id: string
  sender_name: string
  kind: string
  body: string | null
  file_node_id: string | null
  reply_to: string | null
  edited_at: number | null
  deleted_at: number | null
  created_at: number
}): MessageView {
  const recalled = row.deleted_at !== null
  return {
    id: row.id,
    seq: row.seq,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    kind: row.kind,
    // 撤回的消息不返回正文：否则"撤回"只是前端不显示，对方抓包还是能看到
    body: recalled ? null : row.body,
    fileNodeId: recalled ? null : row.file_node_id,
    replyTo: row.reply_to,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    recalled,
  }
}

export interface SendInput {
  conversationId: string
  senderId: string
  kind?: 'text' | 'file' | 'system'
  body?: string | null
  fileNodeId?: string | null
  replyTo?: string | null
}

/** 写入一条消息（内部使用，不做成员校验）。 */
function appendMessage(input: SendInput): MessageView {
  const kind = input.kind ?? 'text'
  const body = input.body?.trim() ?? null

  if (kind === 'text' && !body) throw new HttpError(400, '消息内容不能为空')
  if (kind === 'text' && body && body.length > 4000) {
    throw new HttpError(400, '单条消息不能超过 4000 字')
  }
  if (kind === 'file' && !input.fileNodeId) throw new HttpError(400, '文件消息缺少文件')

  const id = newId('m')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, body, file_node_id, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.conversationId,
      input.senderId,
      kind,
      body,
      input.fileNodeId ?? null,
      input.replyTo ?? null,
      ts,
    )

  getDb()
    .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(ts, input.conversationId)

  const row = getDb()
    .prepare(
      `SELECT m.id, m.seq, m.conversation_id, m.sender_id, u.display_name AS sender_name,
              m.kind, m.body, m.file_node_id, m.reply_to, m.edited_at, m.deleted_at, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?`,
    )
    .get(id) as Parameters<typeof toMessageView>[0]

  // 自己发的消息按定义就是"已读"。
  // 不更新这一步的话，未读数 = max(seq) - last_read_seq 会把自己刚发的消息也算进去，
  // 表现是"我发了条消息，然后我这边显示有 1 条未读"——很奇怪但很容易漏掉。
  getDb()
    .prepare(
      `UPDATE conversation_members
          SET last_read_seq = MAX(last_read_seq, ?)
        WHERE conversation_id = ? AND user_id = ?`,
    )
    .run(row.seq, input.conversationId, input.senderId)

  return toMessageView(row)
}

export function sendMessage(input: SendInput): MessageView {
  requireMember(input.conversationId, input.senderId)
  return transaction(() => appendMessage(input))
}

/**
 * 拉取消息。
 *
 * 两个方向都支持，因为这个界面两种都要用：
 *   - `before`：向上翻历史（聊天记录默认从最新往前翻）
 *   - `since`：断线重连后补拉增量
 */
export function listMessages(
  conversationId: string,
  userId: string,
  options: { before?: number; since?: number; limit?: number } = {},
): { messages: MessageView[]; hasMore: boolean } {
  requireMember(conversationId, userId)
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))

  const base = `SELECT m.id, m.seq, m.conversation_id, m.sender_id, u.display_name AS sender_name,
                       m.kind, m.body, m.file_node_id, m.reply_to, m.edited_at, m.deleted_at, m.created_at
                  FROM messages m JOIN users u ON u.id = m.sender_id
                 WHERE m.conversation_id = ?`

  if (options.since !== undefined) {
    const rows = getDb()
      .prepare(`${base} AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`)
      .all(conversationId, options.since, limit) as unknown as Parameters<typeof toMessageView>[0][]
    return { messages: rows.map(toMessageView), hasMore: rows.length === limit }
  }

  const upper = options.before ?? Number.MAX_SAFE_INTEGER
  const rows = getDb()
    .prepare(`${base} AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
    .all(conversationId, upper, limit + 1) as unknown as Parameters<typeof toMessageView>[0][]

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).reverse() // 倒序取出来后翻回正序
  return { messages: page.map(toMessageView), hasMore }
}

/**
 * 编辑消息。
 *
 * **只允许编辑自己发的消息，管理员也不例外。** 管理员能撤回任何消息
 * （recallMessage 收 isAdmin），但"改写他人发言"是不可接受的边界 ——
 * 那等于替别人说出他没说过的话，会误导所有读到的人。这是刻意的取舍，
 * 不是漏加 isAdmin。
 */
export function editMessage(messageId: string, userId: string, body: string): MessageView {
  const clean = body.trim()
  if (!clean) throw new HttpError(400, '消息内容不能为空')

  const row = getDb()
    .prepare('SELECT conversation_id, sender_id, deleted_at FROM messages WHERE id = ?')
    .get(messageId) as
    | { conversation_id: string; sender_id: string; deleted_at: number | null }
    | undefined
  if (!row) throw new HttpError(404, '消息不存在')
  if (row.sender_id !== userId) throw new HttpError(403, '只能编辑自己发的消息')
  if (row.deleted_at !== null) throw new HttpError(400, '已撤回的消息不能编辑')

  getDb()
    .prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
    .run(clean, now(), messageId)

  return fetchMessage(messageId)
}

export function recallMessage(messageId: string, userId: string, isAdmin: boolean): MessageView {
  const row = getDb()
    .prepare('SELECT sender_id, deleted_at FROM messages WHERE id = ?')
    .get(messageId) as { sender_id: string; deleted_at: number | null } | undefined
  if (!row) throw new HttpError(404, '消息不存在')
  if (row.sender_id !== userId && !isAdmin) throw new HttpError(403, '只能撤回自己发的消息')
  if (row.deleted_at !== null) return fetchMessage(messageId)

  getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(now(), messageId)
  return fetchMessage(messageId)
}

export function fetchMessage(messageId: string): MessageView {
  const row = getDb()
    .prepare(
      `SELECT m.id, m.seq, m.conversation_id, m.sender_id, u.display_name AS sender_name,
              m.kind, m.body, m.file_node_id, m.reply_to, m.edited_at, m.deleted_at, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?`,
    )
    .get(messageId) as Parameters<typeof toMessageView>[0] | undefined
  if (!row) throw new HttpError(404, '消息不存在')
  return toMessageView(row)
}

/** 把会话的已读位置推进到指定 seq。只前进不后退。 */
export function markRead(conversationId: string, userId: string, seq: number): number {
  requireMember(conversationId, userId)
  const current = getDb()
    .prepare('SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId) as { last_read_seq: number } | undefined
  const next = Math.max(current?.last_read_seq ?? 0, seq)
  getDb()
    .prepare('UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND user_id = ?')
    .run(next, conversationId, userId)
  return next
}

/** 会话里所有人的已读位置（用于显示"已读/未读"）。 */
export function readReceipts(
  conversationId: string,
  userId: string,
): Array<{ userId: string; displayName: string; lastReadSeq: number }> {
  requireMember(conversationId, userId)
  const rows = getDb()
    .prepare(
      `SELECT cm.user_id, u.display_name, cm.last_read_seq
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ?`,
    )
    .all(conversationId) as unknown as Array<{
    user_id: string
    display_name: string
    last_read_seq: number
  }>
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    lastReadSeq: r.last_read_seq,
  }))
}

// ---------------------------------------------------------------- 成员管理

export function addMembers(conversationId: string, actorId: string, userIds: string[]): void {
  requireMember(conversationId, actorId)
  const conv = getDb().prepare('SELECT kind FROM conversations WHERE id = ?').get(conversationId) as
    | { kind: string }
    | undefined
  if (!conv) throw new HttpError(404, '会话不存在')
  if (conv.kind === 'direct') throw new HttpError(400, '单聊不能添加成员')

  transaction(() => {
    const ts = now()
    // 新成员的水位线设成"会话当前最新"，否则他一进来就会看到整段历史都是未读 ——
    // 那些消息是在他加入之前发的，不该算成他的未读。
    const maxSeq = (
      getDb()
        .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { m: number }
    ).m

    const add = getDb().prepare(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_seq)
       VALUES (?, ?, 'member', ?, ?)`,
    )
    for (const uid of userIds) add.run(conversationId, uid, ts, maxSeq)
  })
}

export function leaveConversation(conversationId: string, userId: string): void {
  requireMember(conversationId, userId)
  getDb()
    .prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .run(conversationId, userId)

  // 没人了就把会话删掉（关联的消息靠外键级联清理）
  const remaining = getDb()
    .prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?')
    .get(conversationId) as { n: number }
  if (remaining.n === 0) {
    getDb().prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
  }
}

// ---------------------------------------------------------------- 搜索

export interface SearchHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  senderId: string
  senderName: string
  body: string
  createdAt: number
}

/**
 * 在"我参与的会话"里搜索消息。
 *
 * 分词器用 FTS5 的 trigram（按三元组索引），这是中文能搜得到的唯一零依赖方案：
 * unicode61 会把整串中文当成一个词，搜"会议纪要"匹配不到"我会带上次的会议纪要过去"。
 *
 * trigram 的约束是**查询词至少 3 个字符**（少于 3 个字无法构成三元组），
 * 所以短查询退回 LIKE：慢一点，但至少能搜到。
 */
export function searchMessages(userId: string, query: string, limit = 50): SearchHit[] {
  const q = query.trim()
  if (!q) return []

  // 少于 3 个字符时 trigram 不会有结果，直接用 LIKE 更诚实
  if ([...q].length < 3) return searchByLike(userId, q, limit)

  // FTS5 的查询语法里有些字符有特殊含义（引号、星号、冒号、括号等），
  // 拼错会直接语法错误。把用户输入包成带引号的短语并转义内部引号是最省事的正确处理。
  const escaped = `"${q.replace(/"/g, '""')}"`

  try {
    const rows = getDb()
      .prepare(
        `SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_name,
                m.body, m.created_at,
                COALESCE(c.title, '会话') AS conv_title
           FROM messages_fts f
           JOIN messages m ON m.seq = f.rowid
           JOIN conversations c ON c.id = m.conversation_id
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
           JOIN users u ON u.id = m.sender_id
          WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
          ORDER BY m.seq DESC
          LIMIT ?`,
      )
      .all(userId, escaped, limit) as unknown as RawSearchRow[]

    return rows.map(toSearchHit)
  } catch (err) {
    // FTS 出任何意外都不该让搜索整个不可用 —— 退回 LIKE，并留下日志便于排查
    console.error('[chat] FTS 查询失败，退回 LIKE:', err)
    return searchByLike(userId, q, limit)
  }
}

interface RawSearchRow {
  id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  body: string | null
  created_at: number
  conv_title: string
}

function toSearchHit(r: RawSearchRow): SearchHit {
  return {
    messageId: r.id,
    conversationId: r.conversation_id,
    conversationTitle: r.conv_title,
    senderId: r.sender_id,
    senderName: r.sender_name,
    body: r.body ?? '',
    createdAt: r.created_at,
  }
}

function searchByLike(userId: string, q: string, limit: number): SearchHit[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_name,
              m.body, m.created_at,
              COALESCE(c.title, '会话') AS conv_title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         JOIN users u ON u.id = m.sender_id
        WHERE m.deleted_at IS NULL AND m.body LIKE ?
        ORDER BY m.seq DESC LIMIT ?`,
    )
    // LIKE 里的 % 和 _ 是通配符，用户输入里的这两个字符要转义，否则搜 "50%" 会变成模糊匹配
    .all(userId, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, limit) as unknown as RawSearchRow[]
  return rows.map(toSearchHit)
}

// ---------------------------------------------------------------- 在线状态

/** 记一次心跳。用时间戳而不是布尔值，进程崩溃后能自然过期。 */
export function touchPresence(userId: string, delta = 0): void {
  getDb()
    .prepare(
      `INSERT INTO presence (user_id, last_seen, connection_count)
       VALUES (?, ?, MAX(0, ?))
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         connection_count = MAX(0, presence.connection_count + ?)`,
    )
    .run(userId, now(), Math.max(0, delta), delta)
}

/**
 * 连接全部断开时调用：只减计数，**不动 last_seen**。
 *
 * 早先这里走的是 touchPresence(userId, -1)，它会把 last_seen 一起刷成 now ——
 * 于是刚关掉页面的人在接下来整整 60 秒里仍被判成在线。用户看到的是
 * "明明退出了，头像还是亮的"，这是"在线状态显示异常"的一部分。
 */
export function markPresenceOffline(userId: string): void {
  getDb()
    .prepare('UPDATE presence SET connection_count = MAX(0, connection_count - 1) WHERE user_id = ?')
    .run(userId)
}

/**
 * 进程启动时把所有连接计数清零。
 *
 * connection_count 的语义是"此刻有几条 SSE 连接"，而进程刚重启时一条都没有。
 * 不清的话，上一次崩溃前留下的计数会让那些人**永远显示在线** ——
 * 因为下面的 onlineUserIds 把 connection_count > 0 当作在线依据。
 */
export function resetPresenceCounts(): void {
  getDb().prepare('UPDATE presence SET connection_count = 0').run()
}

/** 在线判定窗口。心跳间隔设计为 25 秒，60 秒没动静就认为这条连接已经不在了。 */
const ONLINE_WINDOW_MS = 60_000

/**
 * 当前在线的人。
 *
 * 判定条件是「有活连接」**或**「最近有心跳」，不是单独的某一个：
 *
 *   - `connection_count > 0` 是主依据。干净断开时会立刻减到 0，用户马上变灰 ——
 *     比"等 60 秒窗口过期"准得多。
 *   - `last_seen` 窗口是兜底。进程被 kill -9 时没有机会执行断开逻辑，
 *     连接计数会残留；时间窗保证这类幽灵连接最多活 60 秒。
 *     （启动时还会再清一次，见 resetPresenceCounts。）
 *
 * ⚠️ 这里曾经**只**看 last_seen 窗口，而 25 秒的心理心跳从不刷新 last_seen、
 * touchPresence 只在连接建立时调用一次 —— 于是每个人连上 1 分钟后就全体变灰，
 * 哪怕连接好端端开着、人正在打字。这就是用户报告的"在线状态显示异常"。
 */
export function onlineUserIds(): Set<string> {
  const rows = getDb()
    .prepare('SELECT user_id FROM presence WHERE connection_count > 0 OR last_seen > ?')
    .all(now() - ONLINE_WINDOW_MS) as unknown as Array<{ user_id: string }>
  return new Set(rows.map((r) => r.user_id))
}

/** 可发起会话的人（用于"新建聊天"的人员选择器）。 */
export function listContacts(userId: string): Array<{
  id: string
  username: string
  displayName: string
  role: string
  online: boolean
}> {
  const rows = getDb()
    .prepare(
      "SELECT id, username, display_name, role FROM users WHERE status = 'active' AND id != ? ORDER BY display_name",
    )
    .all(userId) as unknown as Array<{
    id: string
    username: string
    display_name: string
    role: string
  }>
  const online = onlineUserIds()
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    online: online.has(r.id),
  }))
}

/** 会话成员列表（群聊成员管理界面用）。 */
export function conversationMembers(
  conversationId: string,
  userId: string,
): Array<{ id: string; displayName: string; username: string; role: string; online: boolean }> {
  requireMember(conversationId, userId)
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.display_name, u.username, cm.role
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ?
        ORDER BY cm.role DESC, u.display_name`,
    )
    .all(conversationId) as unknown as Array<{
    id: string
    display_name: string
    username: string
    role: string
  }>
  const online = onlineUserIds()
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    username: r.username,
    role: r.role,
    online: online.has(r.id),
  }))
}

/** 未读总数（用于桌面任务栏的角标）。 */
export function totalUnread(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(
                (SELECT COUNT(*) FROM messages m
                  WHERE m.conversation_id = cm.conversation_id
                    AND m.deleted_at IS NULL
                    AND m.seq > cm.last_read_seq)
              ), 0) AS total
         FROM conversation_members cm
        WHERE cm.user_id = ?`,
    )
    .get(userId) as { total: number } | undefined
  return row?.total ?? 0
}
