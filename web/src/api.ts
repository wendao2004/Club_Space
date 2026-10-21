/**
 * 后端 API 客户端。
 *
 * 统一在这里处理三件事：错误归一化、cookie 凭据、以及分片上传的切片循环。
 * 组件里不直接 fetch —— 否则错误处理会散落在几十个地方，最后没人处理。
 */

export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * 401 的统一出口。
 *
 * 原来每个页面自己判 401（全站只有 5 处），其余请求遇到会话过期就只是
 * 弹一句"未登录"，界面还停在已登录状态 —— 用户以为是自己点错了，
 * 反复点同一个按钮，每次都失败。会话过期（12 小时）在这台 NAS 上
 * 是每天都会发生的事，不是边角场景。
 *
 * 用"注册回调"而不是在这里 import auth store：store 反过来 import api，
 * 直接互引会在模块初始化时形成循环，把其中一边变成 undefined。
 * 由 main.ts 在 pinia 装好之后注册。
 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

async function request<T>(
  path: string,
  options: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body = options.body

  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      credentials: 'same-origin',
    })
  } catch {
    // 网络层失败（后端没起、局域网断了）要和业务错误区分开，否则用户看到的是
    // 一堆 "Failed to fetch"，不知道该怎么办。
    throw new ApiError(0, '无法连接到服务器，请检查后端是否已启动或网络是否正常')
  }

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, `请求失败（${response.status}）`)
    return (await response.arrayBuffer()) as unknown as T
  }

  const payload = (await response.json()) as unknown
  if (!response.ok) {
    // 会话过期：把界面切回登录页，而不是让用户对着一个"看起来还在登录"的界面反复点。
    // 排除 /api/auth/* —— 登录页里密码输错也是 401，那不是"会话过期"，
    // 触发全局登出只会把刚填的表单清空。
    if (response.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler?.()

    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（${response.status}）`
    throw new ApiError(response.status, message, payload)
  }
  return payload as T
}

// ---------------------------------------------------------------- 类型

export interface CurrentUser {
  id: string
  username: string
  displayName: string
  role: 'owner' | 'admin' | 'member'
}

export interface Bootstrap {
  siteName: string
  firstRun: boolean
  maxUploadBytes: number
  user: CurrentUser | null
}

export interface FileEntry {
  id: string
  parentId: string | null
  name: string
  kind: 'file' | 'folder'
  space: 'shared' | 'private'
  size: number
  mime: string | null
  sha256: string | null
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
}

export interface FileListing {
  space: 'shared' | 'private'
  parentId: string | null
  breadcrumb: Array<{ id: string; name: string }>
  entries: FileEntry[]
}

export interface ToolDescriptor {
  id: string
  name: string
  description: string
  category: 'pdf' | 'image' | 'document' | 'utility' | 'media'
  accepts: string[]
  minInputs: number
  maxInputs: number
  params: Array<{
    key: string
    label: string
    type: 'text' | 'number' | 'select' | 'boolean'
    options?: Array<{ value: string; label: string }>
    default?: string | number | boolean
    placeholder?: string
    help?: string
  }>
  kind: 'inline' | 'external'
  available: boolean
  unavailableReason: string | null
}

export interface JobView {
  id: string
  kind: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  error: string | null
  outputNodeIds: string[]
  data: unknown
  message: string | null
  createdAt: number
  finishedAt: number | null
}

// ---------------------------------------------------------------- 接口

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  health: () => request<{ ok: boolean; audit: { healthy: boolean; chainOk: boolean; records: number } }>('/api/health'),

  register: (input: {
    username: string
    displayName: string
    password: string
    inviteCode?: string
  }) => request<{ user: CurrentUser }>('/api/auth/register', { json: input }),

  /**
   * 登录。
   *
   * 返回有两种形态：
   *   - `{ user }` —— 直接登录成功
   *   - `{ needTotp: true, challenge, displayName }` —— 账号绑定了两步验证，
   *     口令正确但**还不算登录**，需要拿 challenge + 动态口令再调 loginTotp 换会话
   */
  login: (input: { username: string; password: string }) =>
    request<
      | { user: CurrentUser }
      | { needTotp: true; challenge: string; displayName: string }
    >('/api/auth/login', { json: input }),

  /** 两步登录的第二步。 */
  loginTotp: (challenge: string, code: string) =>
    request<{ user: CurrentUser }>('/api/auth/login/totp', { json: { challenge, code } }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { json: {} }),

  me: () => request<{ user: CurrentUser }>('/api/auth/me'),

  /** 改自己的显示名。用户名不可改（它是登录身份与审计留痕的依据）。 */
  updateMe: (input: { displayName: string }) =>
    request<{ user: CurrentUser }>('/api/me', { method: 'PATCH', json: input }),

  /**
   * 改自己的口令。
   *
   * 必须提交旧口令：否则会话被窃时，攻击者不用知道口令就能把口令换掉。
   * 成功之后服务端会吊销本用户的全部会话 —— 包括当前这个，需要重新登录。
   */
  changePassword: (input: { oldPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/api/me/password', { json: input }),

  /** 轻量成员名册（仅 active）。给"代谁借"这类选人下拉用。 */
  members: () =>
    request<{ members: Array<{ id: string; username: string; displayName: string; role: 'owner' | 'admin' | 'member' }> }>(
      '/api/members',
    ),

  listFiles: (parentId: string | null, space: 'shared' | 'private' = 'shared') => {
    const params = new URLSearchParams({ space })
    if (parentId) params.set('parent', parentId)
    return request<FileListing>(`/api/files?${params.toString()}`)
  },

  createFolder: (input: { parentId: string | null; name: string; space: 'shared' | 'private' }) =>
    request<{ node: { id: string; name: string; kind: string } }>('/api/files/folder', { json: input }),

  renameNode: (id: string, name: string) =>
    request<{ node: { id: string; name: string } }>(`/api/files/${id}`, {
      method: 'PATCH',
      json: { name },
    }),

  moveNode: (id: string, parentId: string | null) =>
    request<{ node: { id: string } }>(`/api/files/${id}`, {
      method: 'PATCH',
      json: { parentId },
    }),

  deleteNode: (id: string) =>
    request<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),

  downloadUrl: (id: string) => `/api/files/${id}/download`,
  previewUrl: (id: string) => `/api/files/${id}/preview`,

  /**
   * 在线编辑保存：把整份新内容发回去，**改写**同一个文件。
   *
   * @param base 打开文件时拿到的 `updatedAt`。服务端拿它做乐观并发校验：
   *             期间被别人改过就回 409，而不是把别人的修改静默覆盖掉。
   *             不传则跳过这道校验（只有"新建后第一次保存"才该这样）。
   */
  saveFileContent: (id: string, bytes: Uint8Array, base?: number) => {
    const query = base ? `?base=${encodeURIComponent(String(base))}` : ''
    return request<{
      node: { id: string; name: string; size: number; mime: string | null; sha256: string | null; updatedAt: number }
    }>(`/api/files/${id}/content${query}`, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
    })
  },

  listTools: () => request<{ tools: ToolDescriptor[] }>('/api/tools'),

  runTool: (toolId: string, input: {
    nodeIds: string[]
    params: Record<string, unknown>
    space?: 'shared' | 'private'
  }) => request<{ jobId: string }>(`/api/tools/${toolId}/run`, { json: input }),

  getJob: (id: string) => request<{ job: JobView }>(`/api/jobs/${id}`),

  listJobs: () => request<{ jobs: JobView[] }>('/api/jobs'),

  adminOverview: () =>
    request<{
      stats: { blobs: number; bytes: number; nodes: number }
      users: Array<{
        id: string
        username: string
        display_name: string
        role: string
        status: string
        created_at: number
        last_login_at: number | null
      }>
      invites: Array<{
        code: string
        role: string
        max_uses: number
        uses: number
        expires_at: number | null
        note: string | null
      }>
      audit: { records: number; chainOk: boolean; head: { seq: number; hash: string } }
      /** 存储明细：逻辑大小按文件聚合，物理占用看 stats.bytes。 */
      storage: {
        topFiles: Array<{
          id: string
          name: string
          size: number
          ownerId: string
          ownerName: string
          createdAt: number
        }>
        byOwner: Array<{ userId: string; name: string; files: number; bytes: number }>
        freeBytes: number
        totalBytes: number
        minFreeBytes: number
      }
      canManage: boolean
    }>('/api/admin/overview'),

  createInvite: (input: {
    role?: 'member' | 'admin'
    maxUses?: number
    expiresInDays?: number
    note?: string
  }) => request<{ code: string }>('/api/admin/invites', { json: input }),

  getAudit: (from = 0, limit = 200) =>
    request<{
      records: Array<{
        seq: number
        ts: number
        actorId: string | null
        category: string
        action: string
        target: string | null
        payload: string | null
        hash: string
      }>
    }>(`/api/admin/audit?from=${from}&limit=${limit}`),

  verifyAudit: () =>
    request<{ ok: boolean; checked: number; firstBadSeq: number | null; reason: string | null }>(
      '/api/admin/audit/verify',
    ),

  /** 作废一个邀请码。 */
  revokeInvite: (code: string) =>
    request<{ ok: boolean }>(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }),

  // ---------------------------------------------------------------- 成员管理（管理员）
  /** 改成员资料：显示名 / 角色 / 状态（启用停用）。未传的字段保持原样。 */
  adminUpdateUser: (
    id: string,
    input: { displayName?: string; role?: 'owner' | 'admin' | 'member'; status?: 'active' | 'disabled' },
  ) => request<{ user: CurrentUser }>(`/api/admin/users/${id}`, { method: 'PATCH', json: input }),

  /** 重置成员口令。新口令要过强度校验；服务端绝不回显、也绝不写进审计。 */
  adminResetPassword: (id: string, password: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/password`, { json: { password } }),

  /** 强制成员下线（吊销其全部会话）。 */
  adminRevokeSessions: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/sessions/revoke`, { json: {} }),

  /**
   * 当前用户的待办汇总（记账的待审批/被驳回、财物的逾期/即将到期）。
   *
   * 数字由服务端按**列表接口同一套筛选条件**算出来，前端只负责显示 ——
   * 前端自己再数一遍迟早会分叉，而"角标 3、点进去 2 条"会被直接判定成坏了。
   */
  todos: () => request<{ todos: TodoPayload; asOf: number }>('/api/todos'),

  // ---------------------------------------------------------------- 聊天
  chat: {
    /** SSE 事件流的地址。用 EventSource 连它，不要用 fetch。 */
    streamUrl: () => '/api/chat/stream',

    conversations: () =>
      request<{ conversations: ChatConversation[]; totalUnread: number }>('/api/chat/conversations'),

    contacts: () => request<{ contacts: ChatContact[] }>('/api/chat/contacts'),

    openDirect: (peerId: string) =>
      request<{ conversation: ChatConversation }>('/api/chat/conversations/direct', {
        json: { peerId },
      }),

    createGroup: (title: string, memberIds: string[]) =>
      request<{ conversation: ChatConversation }>('/api/chat/conversations/group', {
        json: { title, memberIds },
      }),

    getConversation: (id: string) =>
      request<{
        conversation: ChatConversation
        members: ChatContact[]
        receipts: ChatReceipt[]
      }>(`/api/chat/conversations/${id}`),

    /** 把成员拉进群聊（服务端会同时写一条系统消息）。 */
    addMembers: (id: string, userIds: string[]) =>
      request<{ added: ChatContact[]; members: ChatContact[] }>(
        `/api/chat/conversations/${id}/members`,
        { json: { userIds } },
      ),

    /** 退出群聊。单聊不允许退（服务端会拒绝并说明原因）。 */
    leaveConversation: (id: string) =>
      request<{ ok: boolean }>(`/api/chat/conversations/${id}/leave`, { method: 'POST' }),

    /**
     * 拉消息。
     *  - 不传参数：取最新一页
     *  - `before`：向上翻历史（传当前最早一条的 seq）
     *  - `since`：重连后补拉增量（传本地最大的 seq）
     */
    messages: (id: string, options: { before?: number; since?: number; limit?: number } = {}) => {
      const params = new URLSearchParams()
      if (options.before !== undefined) params.set('before', String(options.before))
      if (options.since !== undefined) params.set('since', String(options.since))
      if (options.limit !== undefined) params.set('limit', String(options.limit))
      const qs = params.toString()
      return request<{ messages: ChatMessage[]; hasMore: boolean }>(
        `/api/chat/conversations/${id}/messages${qs ? `?${qs}` : ''}`,
      )
    },

    send: (
      conversationId: string,
      input: { kind?: 'text' | 'file'; body?: string; fileNodeId?: string; replyTo?: string },
    ) =>
      request<{ message: ChatMessage }>(`/api/chat/conversations/${conversationId}/messages`, {
        json: input,
      }),

    markRead: (conversationId: string, seq: number) =>
      request<{ lastReadSeq: number }>(`/api/chat/conversations/${conversationId}/read`, {
        json: { seq },
      }),

    editMessage: (messageId: string, body: string) =>
      request<{ message: ChatMessage }>(`/api/chat/messages/${messageId}`, {
        method: 'PATCH',
        json: { body },
      }),

    recallMessage: (messageId: string) =>
      request<{ message: ChatMessage }>(`/api/chat/messages/${messageId}/recall`, { json: {} }),

    typing: (conversationId: string) =>
      request<{ ok: boolean }>('/api/chat/typing', { json: { conversationId } }),

    search: (q: string) =>
      request<{ hits: ChatSearchHit[] }>(`/api/chat/search?q=${encodeURIComponent(q)}`),
  },

  // ---------------------------------------------------------------- 记账
  ledger: {
    categories: (includeArchived = false) =>
      request<{ categories: LedgerCategory[] }>(
        `/api/ledger/categories${includeArchived ? '?includeArchived=1' : ''}`,
      ),

    createCategory: (input: { name: string; kind: LedgerKind; icon?: string }) =>
      request<{ category: LedgerCategory }>('/api/ledger/categories', { json: input }),

    archiveCategory: (id: string, archived: boolean) =>
      request<{ ok: boolean }>(`/api/ledger/categories/${id}`, {
        method: 'PATCH',
        json: { archived },
      }),

    entries: (options: LedgerQueryOptions & { limit?: number; offset?: number } = {}) => {
      const params = new URLSearchParams(ledgerQueryString(options))
      if (options.limit !== undefined) params.set('limit', String(options.limit))
      if (options.offset !== undefined) params.set('offset', String(options.offset))
      const qs = params.toString()
      return request<{ entries: LedgerEntry[]; total: number }>(
        `/api/ledger/entries${qs ? `?${qs}` : ''}`,
      )
    },

    getEntry: (id: string) => request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}`),

    createEntry: (input: LedgerEntryInput) =>
      request<{ entry: LedgerEntry }>('/api/ledger/entries', { json: input }),

    updateEntry: (id: string, input: Partial<LedgerEntryInput>) =>
      request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}`, {
        method: 'PATCH',
        json: input,
      }),

    deleteEntry: (id: string) =>
      request<{ ok: boolean }>(`/api/ledger/entries/${id}`, { method: 'DELETE' }),

    submitEntry: (id: string) =>
      request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}/submit`, { json: {} }),

    withdrawEntry: (id: string) =>
      request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}/withdraw`, { json: {} }),

    decideEntry: (id: string, decision: 'approve' | 'reject', note?: string) =>
      request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}/decide`, {
        json: { decision, note },
      }),

    payEntry: (id: string) =>
      request<{ entry: LedgerEntry }>(`/api/ledger/entries/${id}/pay`, { json: {} }),

    settleSplit: (entryId: string, userId: string, settled: boolean) =>
      request<{ ok: boolean }>(`/api/ledger/entries/${entryId}/splits/${userId}/settle`, {
        json: { settled },
      }),

    summary: (options: { from?: string; to?: string } = {}) => {
      const params = new URLSearchParams()
      if (options.from) params.set('from', options.from)
      if (options.to) params.set('to', options.to)
      const qs = params.toString()
      return request<{ summary: LedgerSummary }>(`/api/ledger/summary${qs ? `?${qs}` : ''}`)
    },

    debts: (eventId?: string) =>
      request<{ debts: LedgerDebt[] }>(
        `/api/ledger/debts${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''}`,
      ),

    /**
     * 导出 CSV 的下载地址（服务端已加 BOM，Excel 打开中文不乱码）。
     *
     * ⚠️ 接受的筛选条件与 `entries()` **完全一致**：导出的表必须就是列表里那张表。
     * 从前这里只收 from/to，于是"搜索 / 分类 / 状态 / 只看我的 / 待我审批"
     * 在导出时被静默丢掉 —— 用户筛出三行，下载到的是全部账目，
     * 而界面上的筛选摘要还挂着，他不会怀疑这张表。它不报错，只能靠对账发现。
     * 所以两边共用同一份 ledgerQueryString()。
     */
    exportUrl: (options: LedgerQueryOptions = {}) => {
      const qs = ledgerQueryString(options)
      return `/api/ledger/export.csv${qs ? `?${qs}` : ''}`
    },

    // ---- 活动 / 比赛 ----

    events: (options: { openOnly?: boolean } = {}) =>
      request<{ events: LedgerEvent[] }>(
        `/api/ledger/events${options.openOnly ? '?open=1' : ''}`,
      ),

    getEvent: (id: string) => request<{ event: LedgerEvent }>(`/api/ledger/events/${id}`),

    createEvent: (input: LedgerEventInput) =>
      request<{ event: LedgerEvent }>('/api/ledger/events', { json: input }),

    updateEvent: (id: string, input: Partial<LedgerEventInput>) =>
      request<{ event: LedgerEvent }>(`/api/ledger/events/${id}`, {
        method: 'PATCH',
        json: input,
      }),

    closeEvent: (id: string, closed: boolean) =>
      request<{ event: LedgerEvent }>(`/api/ledger/events/${id}/close`, { json: { closed } }),

    /**
     * 删除活动（仅管理员）。账目不删：归属它的账目退回日常账目，
     * 响应里的 detachedEntries 是解绑笔数。
     */
    deleteEvent: (id: string) =>
      request<{ ok: true; name: string; detachedEntries: number }>(`/api/ledger/events/${id}`, {
        method: 'DELETE',
      }),

    /** 按活动的完整汇总（收支合计 + 按分类 + 按人 + 逐笔明细）。 */
    eventSummary: (id: string) =>
      request<LedgerEventSummary>(`/api/ledger/events/${id}/summary`),

    /** 按活动导出 CSV 的下载地址（同样带 BOM 与公式注入转义）。 */
    eventExportUrl: (id: string) => `/api/ledger/events/${id}/export.csv`,
  },

  // ---------------------------------------------------------------- 财物管理
  assets: {
    categories: (includeArchived = false) =>
      request<{ categories: AssetCategory[] }>(
        `/api/assets/categories${includeArchived ? '?all=1' : ''}`,
      ),

    createCategory: (input: { name: string; icon?: string }) =>
      request<{ category: AssetCategory }>('/api/assets/categories', { json: input }),

    archiveCategory: (id: string, archived: boolean) =>
      request<{ ok: boolean }>(`/api/assets/categories/${id}/archive`, { json: { archived } }),

    items: (options: { categoryId?: string; q?: string; status?: AssetStatus; available?: boolean; onLoan?: boolean } = {}) => {
      const params = new URLSearchParams()
      if (options.categoryId) params.set('categoryId', options.categoryId)
      if (options.q) params.set('q', options.q)
      if (options.status) params.set('status', options.status)
      if (options.available) params.set('available', '1')
      if (options.onLoan) params.set('onLoan', '1')
      const qs = params.toString()
      return request<{ items: AssetItem[] }>(`/api/assets/items${qs ? `?${qs}` : ''}`)
    },

    item: (id: string) => request<{ item: AssetItem; loans: AssetLoan[] }>(`/api/assets/items/${id}`),

    createItem: (input: AssetItemInput) =>
      request<{ item: AssetItem }>('/api/assets/items', { json: input }),

    updateItem: (id: string, input: Partial<AssetItemInput>) =>
      request<{ item: AssetItem }>(`/api/assets/items/${id}`, { method: 'PATCH', json: input }),

    retireItem: (id: string, retired: boolean) =>
      request<{ item: AssetItem }>(`/api/assets/items/${id}/retire`, { json: { retired } }),

    loans: (
      options: {
        itemId?: string
        mine?: boolean
        open?: boolean
        overdue?: boolean
        /** 只看「N 天内到期、且还没逾期」的（服务端与待办角标共用同一个窗口） */
        dueWithin?: number
        /** 物品名/编号、借用人、用途的模糊搜索 */
        search?: string
        limit?: number
      } = {},
    ) => {
      const params = new URLSearchParams()
      if (options.itemId) params.set('itemId', options.itemId)
      if (options.mine) params.set('mine', '1')
      if (options.open) params.set('open', '1')
      if (options.overdue) params.set('overdue', '1')
      if (options.dueWithin !== undefined) params.set('dueWithin', String(options.dueWithin))
      if (options.search) params.set('search', options.search)
      if (options.limit !== undefined) params.set('limit', String(options.limit))
      const qs = params.toString()
      return request<{ loans: AssetLoan[] }>(`/api/assets/loans${qs ? `?${qs}` : ''}`)
    },

    lend: (input: { itemId: string; qty?: number; borrowerId?: string; dueOn?: string; purpose?: string; note?: string }) =>
      request<{ loan: AssetLoan }>('/api/assets/loans', { json: input }),

    returnLoan: (id: string, input: { condition?: AssetCondition; note?: string } = {}) =>
      request<{ loan: AssetLoan }>(`/api/assets/loans/${id}/return`, { json: input }),

    /** 更正一条借还记录（管理员）：改借用人 / 数量 / 应还日期 / 用途 / 备注。 */
    updateLoan: (
      id: string,
      input: {
        qty?: number
        borrowerId?: string
        dueOn?: string | null
        purpose?: string | null
        note?: string | null
      },
    ) => request<{ loan: AssetLoan }>(`/api/assets/loans/${id}`, { method: 'PATCH', json: input }),

    /** 作废一条借还记录（管理员）。保留历史，仅从账面可用量里剔除。 */
    voidLoan: (id: string) =>
      request<{ loan: AssetLoan }>(`/api/assets/loans/${id}`, { method: 'DELETE' }),

    /** 恢复一条被作废的记录（管理员）。作废点错了的后悔药。 */
    restoreLoan: (id: string) =>
      request<{ loan: AssetLoan }>(`/api/assets/loans/${id}/restore`, { json: {} }),

    summary: () => request<{ summary: AssetSummary; overdue: AssetLoan[] }>('/api/assets/summary'),

    itemsCsvUrl: () => '/api/assets/export/items.csv',
    loansCsvUrl: () => '/api/assets/export/loans.csv',
  },

  // ---------------------------------------------------------------- 狼人杀
  werewolf: {
    rooms: (options: { open?: boolean } = {}) =>
      request<{ rooms: WerewolfRoom[] }>(
        `/api/games/werewolf/rooms${options.open ? '?open=1' : ''}`,
      ),

    room: (id: string) => request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}`),

    create: (title: string, playerCount = 9) =>
      request<{ room: WerewolfRoom }>('/api/games/werewolf/rooms', { json: { title, playerCount } }),

    join: (id: string) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/join`, { json: {} }),

    leave: (id: string) =>
      request<{ room: WerewolfRoom | null }>(`/api/games/werewolf/rooms/${id}/leave`, { json: {} }),

    /** 房内文字发言。文本为空或此刻不能发言（夜晚的非狼、出局者、观战者）会被拒。 */
    chat: (id: string, text: string) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/chat`, { json: { text } }),

    kill: (id: string, target: number) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/kill`, { json: { target } }),

    check: (id: string, target: number) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/check`, { json: { target } }),

    /**
     * 女巫用药。
     *
     * 字段名是 heal / poisonTarget（与服务端的 WitchChoice 一致），
     * **不是** action/target —— 传错了不会报错，只会静默地什么都不做
     * （heal 恒为 undefined、poisonTarget 恒为 null），女巫看起来行动过了
     * 但药效没发生。所以这里把契约写在签名上。
     */
    witch: (id: string, choice: { heal?: boolean; poisonTarget?: number | null }) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/witch`, { json: choice }),

    vote: (id: string, target: number | null) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/vote`, { json: { target } }),

    shoot: (id: string, target: number | null) =>
      request<{ room: WerewolfRoom }>(`/api/games/werewolf/rooms/${id}/shoot`, { json: { target } }),
  },

  // ---------------------------------------------------------------- 游戏
  games: {
    rooms: (options: { status?: GameStatus; kind?: 'xiangqi' } = {}) => {
      const params = new URLSearchParams()
      if (options.status) params.set('status', options.status)
      if (options.kind) params.set('kind', options.kind)
      const qs = params.toString()
      return request<{ rooms: GameRoom[]; stats: GameStats }>(
        `/api/games/rooms${qs ? `?${qs}` : ''}`,
      )
    },

    createRoom: (input: {
      kind?: 'xiangqi'
      title?: string
      side?: GameColor
      /** 传了就是人机对战：电脑坐对面，开局即下。 */
      bot?: { level: GameBotLevel; side: GameColor }
    } = {}) => request<{ room: GameRoom }>('/api/games/rooms', { json: input }),

    getRoom: (id: string) => request<{ room: GameRoom }>(`/api/games/rooms/${id}`),

    joinRoom: (id: string, side?: GameColor) =>
      request<{ room: GameRoom }>(`/api/games/rooms/${id}/join`, { json: { side } }),

    /** 落子。合法性由服务端裁定，前端只提交意图。 */
    move: (id: string, from: string, to: string) =>
      request<{
        room: GameRoom
        move: GameMove
        finished: { winner: GameColor | null; reason: string } | null
      }>(`/api/games/rooms/${id}/move`, { json: { from, to } }),

    resign: (id: string) => request<{ room: GameRoom }>(`/api/games/rooms/${id}/resign`, { json: {} }),

    leave: (id: string) => request<{ room: GameRoom | null }>(`/api/games/rooms/${id}/leave`, { json: {} }),

    /** 某个棋子的合法着法（点击棋子时高亮用）。 */
    legal: (id: string, from: string) =>
      request<{ targets: string[] }>(`/api/games/rooms/${id}/legal?from=${encodeURIComponent(from)}`),
  },

  // ---------------------------------------------------------------- 运维（管理员）
  ops: {
    totpStatus: () => request<TotpStatus>('/api/admin/totp/status'),

    /**
     * 生成绑定用的秘密与新二维码。返回的秘密**只在这一次**出现。
     *
     * ⚠️ 账号**已绑定**时必须带上 currentCode（当前验证器上的 6 位码）——
     * 服务端不允许仅凭会话就把第二因子换掉。只接受动态口令、不接受登录口令，
     * 否则"口令泄漏"就等于 2FA 失效（登录本身不校验 TOTP）。
     * 唯一的例外是 broken（秘密已无法解密）的状态，那时才用 password 恢复。
     */
    totpSetup: (reauth: { currentCode?: string; password?: string } = {}) =>
      request<{ secret: string; formatted: string; otpauthUrl: string }>('/api/admin/totp/setup', {
        json: reauth,
      }),

    /** 完成绑定。同样是已绑定时必须带 currentCode/password。 */
    totpEnable: (code: string, reauth: { currentCode?: string; password?: string } = {}) =>
      request<{ ok: boolean }>('/api/admin/totp/enable', { json: { code, ...reauth } }),

    totpDisable: (code: string) =>
      request<{ ok: boolean }>('/api/admin/totp/disable', { json: { code } }),

    operations: () =>
      request<{
        enabled: boolean
        allowedServices: string[]
        templatesDir: string
        operations: AdminOperation[]
      }>('/api/admin/docker/operations'),

    /** 执行运维操作。变更类操作必须带 totpCode。 */
    execute: (operationId: string, params: Record<string, string> = {}, totpCode?: string) =>
      request<OperationResult>('/api/admin/docker/execute', {
        json: { operationId, params, totpCode },
      }),
  },

  // ---------------------------------------------------------------- 斗地主
  ddz: {
    rooms: (openOnly = false) =>
      request<{ rooms: DdzRoom[] }>(`/api/games/doudizhu/rooms${openOnly ? '?open=1' : ''}`),

    createRoom: (title = '') =>
      request<{ room: DdzRoom }>('/api/games/doudizhu/rooms', { json: { title } }),

    getRoom: (id: string) => request<{ room: DdzRoom }>(`/api/games/doudizhu/rooms/${id}`),

    join: (id: string) => request<{ room: DdzRoom }>(`/api/games/doudizhu/rooms/${id}/join`, { json: {} }),

    /** 叫地主（简化版：第一个叫的人拿到地主）。 */
    bid: (id: string, call: boolean) =>
      request<{ room: DdzRoom }>(`/api/games/doudizhu/rooms/${id}/bid`, { json: { call } }),

    /** 出牌。cardIds 是手牌里的牌 id —— 服务端会校验确实在你手里。 */
    play: (id: string, cardIds: number[]) =>
      request<{
        room: DdzRoom
        played: string[]
        typeLabel: string
        finished: { winnerSeat: number; landlordWon: boolean; reason: string } | null
      }>(`/api/games/doudizhu/rooms/${id}/play`, { json: { cardIds } }),

    pass: (id: string) => request<{ room: DdzRoom }>(`/api/games/doudizhu/rooms/${id}/pass`, { json: {} }),

    leave: (id: string) => request<{ room: DdzRoom | null }>(`/api/games/doudizhu/rooms/${id}/leave`, { json: {} }),
  },

  // ---------------------------------------------------------------- 你画我猜

  draw: {
    rooms: () => request<{ rooms: DrawRoom[] }>('/api/games/draw/rooms'),

    createRoom: (title = '', rounds = 2) =>
      request<{ room: DrawRoom }>('/api/games/draw/rooms', { json: { title, rounds } }),

    getRoom: (id: string) => request<{ room: DrawRoom }>(`/api/games/draw/rooms/${id}`),

    join: (id: string) => request<{ room: DrawRoom }>(`/api/games/draw/rooms/${id}/join`, { json: {} }),

    start: (id: string) => request<{ room: DrawRoom }>(`/api/games/draw/rooms/${id}/start`, { json: {} }),

    leave: (id: string) => request<{ room: DrawRoom }>(`/api/games/draw/rooms/${id}/leave`, { json: {} }),

    /** 画家选定要画的词（必须来自服务端下发的候选）。 */
    chooseWord: (id: string, word: string) =>
      request<{ room: DrawRoom }>(`/api/games/draw/rooms/${id}/word`, { json: { word } }),

    /** 画笔上报。调用方负责攒批（见 DrawApp 的 80ms 合并）。 */
    stroke: (id: string, op: DrawStrokeInput) =>
      request<{ ok: true }>(`/api/games/draw/rooms/${id}/strokes`, { json: op }),

    /** 中途进来 / 刷新：补发当前画布。 */
    canvas: (id: string) => request<{ strokes: DrawStrokeInput[] }>(`/api/games/draw/rooms/${id}/canvas`),

    /** 猜词 / 房内闲聊。 */
    guess: (id: string, text: string) =>
      request<{ room: DrawRoom; correct: boolean; close: boolean; allGuessed: boolean }>(
        `/api/games/draw/rooms/${id}/guess`,
        { json: { text } },
      ),

    /** 历史对局列表（已结束的局，倒序）。 */
    history: (limit = 30) => request<{ rooms: DrawHistoryItem[] }>(`/api/games/draw/history?limit=${limit}`),

    /** 某一局的全部回合（每个回合都带那一张画）。 */
    historyDetail: (id: string) => request<{ detail: DrawHistoryDetail }>(`/api/games/draw/history/${id}`),
  },

  // ---------------------------------------------------------------- 留言板

  board: {
    /** 留言列表（全站一份，倒序）。openOnly 只看未处理的。 */
    posts: (options: { openOnly?: boolean; kind?: BoardKind; limit?: number } = {}) => {
      const q = new URLSearchParams()
      if (options.openOnly) q.set('open', '1')
      if (options.kind) q.set('kind', options.kind)
      if (options.limit) q.set('limit', String(options.limit))
      const qs = q.toString()
      return request<{ posts: BoardPost[] }>(`/api/board/posts${qs ? `?${qs}` : ''}`)
    },

    create: (kind: BoardKind, body: string) =>
      request<{ post: BoardPost }>('/api/board/posts', { json: { kind, body } }),

    /** 标记已解决 / 撤销（仅管理员）。resolution 是可选的处理说明。 */
    resolve: (id: string, resolved: boolean, resolution?: string | null) =>
      request<{ post: BoardPost }>(`/api/board/posts/${id}/resolve`, {
        json: { resolved, resolution: resolution ?? null },
      }),

    remove: (id: string) => request<{ ok: true }>(`/api/board/posts/${id}`, { method: 'DELETE' }),
  },
}

// ---------------------------------------------------------------- 分片上传

export interface UploadProgress {
  uploaded: number
  total: number
  /** 0-100 */
  percent: number
  /** 文件已被跳过（秒传命中） */
  instant: boolean
  /** 阶段说明，用于界面提示 */
  phase: 'hashing' | 'uploading' | 'finalizing' | 'done'
}

const CHUNK_SIZE = 4 * 1024 * 1024 // 4MB

/**
 * 计算文件 sha256。
 *
 * 一次性把整个文件读进内存会在上传大文件时直接把浏览器标签页搞崩，所以
 * 按 4MB 分块喂给 SubtleCrypto —— 它内部维护状态，不需要我们把文件读完。
 * 代价是只有安全上下文（HTTPS 或 localhost）才有 crypto.subtle，这也是
 * 本项目坚持内网 HTTPS 的原因之一。
 */
export async function hashFile(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  try {
    const total = file.size
    let done = 0
    // 分块喂给 digest 需要自己实现增量：SubtleCrypto 没有流式接口，
    // 所以这里退化成"小于 64MB 才算 hash"，更大的文件直接跳过秒传检测。
    if (total > 64 * 1024 * 1024) return null
    const buffer = await file.arrayBuffer()
    done = total
    onProgress?.(done, total)
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

export async function uploadFile(
  file: File,
  parentId: string | null,
  space: 'shared' | 'private',
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ nodeId: string; instant: boolean }> {
  const total = file.size
  onProgress?.({ uploaded: 0, total, percent: 0, instant: false, phase: 'hashing' })
  const sha256 = await hashFile(file, (done) =>
    onProgress?.({
      uploaded: done,
      total,
      percent: total ? Math.round((done / total) * 5) : 0,
      instant: false,
      phase: 'hashing',
    }),
  )

  const init = await request<{ uploadId: string; offset: number; instant: boolean; nodeId: string | null }>(
    '/api/uploads',
    { json: { parentId, name: file.name, size: total, sha256: sha256 ?? undefined, space } },
  )

  if (init.instant) {
    onProgress?.({ uploaded: total, total, percent: 100, instant: true, phase: 'done' })
    return { nodeId: init.nodeId!, instant: true }
  }

  let offset = init.offset
  if (offset > 0) {
    // 断点续传：从服务端已收到的偏移继续
    onProgress?.({
      uploaded: offset,
      total,
      percent: Math.round((offset / total) * 100),
      instant: false,
      phase: 'uploading',
    })
  }

  while (offset < total) {
    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, total))
    const buffer = await slice.arrayBuffer()
    const result = await request<{ received: number }>(
      `/api/uploads/${init.uploadId}/chunk?offset=${offset}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: buffer,
      },
    )
    offset = result.received
    onProgress?.({
      uploaded: offset,
      total,
      percent: Math.round((offset / total) * 100),
      instant: false,
      phase: 'uploading',
    })
  }

  onProgress?.({ uploaded: total, total, percent: 100, instant: false, phase: 'finalizing' })
  const done = await request<{ nodeId: string }>(`/api/uploads/${init.uploadId}/complete`, {
    method: 'POST',
    json: {},
  })
  onProgress?.({ uploaded: total, total, percent: 100, instant: false, phase: 'done' })
  return { nodeId: done.nodeId, instant: false }
}

// ---------------------------------------------------------------- 聊天类型

export interface ChatConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  /** 单聊时对方的用户 id（用于显示头像与在线状态）。 */
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
  /** 未读数。由服务端的 max(seq) - 已读位置得出，不是本地估算。 */
  unread: number
  /**
   * 未读里"点名了我"的条数。
   *
   * 服务端算的，不是前端扫的 —— 没打开的那个会话前端只有 lastMessage 一条，
   * 扫不出来，而"有人@你"恰恰是没打开时最需要看到的提示。
   */
  mentionUnread: number
  lastReadSeq: number
  updatedAt: number
}

export interface ChatMessage {
  id: string
  seq: number
  conversationId: string
  senderId: string
  senderName: string
  kind: 'text' | 'file' | 'system'
  body: string | null
  fileNodeId: string | null
  replyTo: string | null
  /** 被引用那条的快照（服务端带回来，撤回的只给占位文字）。 */
  reply: {
    id: string
    senderId: string
    senderName: string
    preview: string
    recalled: boolean
  } | null
  editedAt: number | null
  deletedAt: number | null
  createdAt: number
  /** 已撤回。正文不会返回，界面应显示"消息已撤回"而不是原文。 */
  recalled: boolean
}

export interface ChatContact {
  id: string
  username: string
  displayName: string
  role: 'owner' | 'admin' | 'member'
  online: boolean
}

export interface ChatSearchHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  senderId: string
  senderName: string
  body: string
  createdAt: number
}

export interface ChatReceipt {
  userId: string
  displayName: string
  lastReadSeq: number
}

// ---------------------------------------------------------------- 记账类型

// ---------------------------------------------------------------- 财物管理

export type AssetCondition = 'good' | 'fair' | 'broken' | 'lost'
export type AssetStatus = 'active' | 'retired'

export interface AssetCategory {
  id: string
  name: string
  icon: string | null
  sortOrder: number
  archived: boolean
  createdAt: number
}

export interface AssetItem {
  id: string
  code: string | null
  name: string
  categoryId: string | null
  categoryName: string | null
  totalQty: number
  /** 当前可借数量。服务端**算出来**的，不是存的字段。 */
  availableQty: number
  onLoanQty: number
  valueCents: number
  totalValueCents: number
  purchasedOn: string | null
  location: string | null
  condition: AssetCondition
  note: string | null
  status: AssetStatus
  createdAt: number
  updatedAt: number
}

export interface AssetLoan {
  id: string
  itemId: string
  itemName: string
  qty: number
  borrowerId: string
  borrowerName: string
  lentAt: number
  dueOn: string | null
  returnedAt: number | null
  returnedByName: string | null
  returnCondition: AssetCondition | null
  purpose: string | null
  note: string | null
  /** 已作废（记错了更正用）。作废的记录不再计入可用量，但保留在历史里。 */
  voidedAt: number | null
  voidedByName: string | null
  overdue: boolean
  overdueDays: number
}

export interface AssetItemInput {
  name: string
  code?: string
  categoryId?: string | null
  totalQty?: number
  value?: string | number
  purchasedOn?: string
  location?: string
  condition?: AssetCondition
  note?: string
}

export interface AssetSummary {
  itemCount: number
  totalQty: number
  onLoanQty: number
  availableQty: number
  totalValueCents: number
  openLoans: number
  overdueLoans: number
  byCategory: Array<{
    categoryId: string | null
    categoryName: string
    itemCount: number
    totalValueCents: number
  }>
}

// ---------------------------------------------------------------- 待办

/** 一个待办分类：条数 + 前若干条 id（服务端最多给 20 条，够"点进去直接定位"）。 */
export interface TodoBucket {
  /** 与列表接口同一筛选条件下的条数 */
  count: number
  ids: string[]
}

export interface LedgerTodo {
  /** 待我审批（仅管理员/创建者非零） */
  review: TodoBucket
  /** 我提交的、被驳回待修改 */
  rejected: TodoBucket
  total: number
}

export interface AssetsTodo {
  /** 我借的、未还、已逾期 */
  overdue: TodoBucket
  /** 我借的、未还、dueSoonDays 天内到期（不含已逾期） */
  dueSoon: TodoBucket
  /** 「即将到期」的窗口天数，服务端给 —— 前端不硬编码，否则两边会漂 */
  dueSoonDays: number
  total: number
}

export interface TodoPayload {
  ledger: LedgerTodo
  assets: AssetsTodo
}

// ---------------------------------------------------------------- 狼人杀

export type WerewolfRole = 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager'
export type WerewolfTeam = 'wolf' | 'good'
export type WerewolfPhase =
  | 'waiting'
  | 'night'
  | 'day-announce'
  | 'day-discuss'
  | 'day-vote'
  | 'hunter'
  | 'finished'
export type WerewolfActionKind = 'kill' | 'check' | 'witch' | 'vote' | 'shoot'

export interface WerewolfSeat {
  seat: number
  userId: string | null
  name: string | null
  online: boolean
  alive: boolean
  isMe: boolean
}

export interface WerewolfLogEntry {
  day: number
  phase: WerewolfPhase
  kind: string
  /** 面向玩家的中文文案。只含座位号，绝不含身份。 */
  text: string
  seat?: number
  target?: number
  at: number
}

/** 房内文字频道：夜晚是狼队私频，其余是公开频道。 */
export type WerewolfChatScope = 'public' | 'wolf'

export interface WerewolfMessage {
  id: string
  /** 发送者座位。 */
  seat: number
  /** 发送者显示名（快照）。 */
  name: string
  text: string
  scope: WerewolfChatScope
  day: number
  at: number
}

/**
 * 房间视图。
 *
 * ⚠️ 这是**按我自己的视角裁剪过**的：myRole 只映射我自己，
 * 别人的身份在这份数据里根本不存在（不是前端藏起来）。
 * 所以界面不需要、也不应该去"猜"别人的身份。
 */
export interface WerewolfRoom {
  id: string
  kind: 'werewolf'
  title: string
  phase: WerewolfPhase
  day: number
  createdBy: string
  creatorName: string
  /** 本房间的目标人数（6~12）。 */
  playerCount: number
  board: Array<{ role: WerewolfRole; label: string; team: WerewolfTeam; count: number }>
  players: WerewolfSeat[]
  mySeat: number | null
  myRole: WerewolfRole | null
  myRoleLabel: string | null
  myTeam: WerewolfTeam | null
  /** 狼队友的座位（仅当我是狼）。 */
  teammates: number[] | null
  /** 预言家的查验记录（仅当我是预言家）。 */
  myChecks: Array<{ target: number; team: WerewolfTeam; day: number }> | null
  /** 女巫的药品剩余（仅当我是女巫）。 */
  myPotions: { heal: boolean; poison: boolean } | null
  /** 今晚被刀的人（仅当我是女巫、且处于夜晚）。 */
  witchNightVictim: number | null
  canAct: boolean
  actionKind: WerewolfActionKind | null
  legalTargets: number[]
  canHeal: boolean
  canPoison: boolean
  canAbstain: boolean
  acted: boolean
  myTurn: boolean
  waitingOn: number[]
  votes: Array<{ voter: number; target: number | null }>
  lastVote: { executed: number | null; tally: Array<{ target: number; count: number }> } | null
  lastNight: { victim: number | null; saved: boolean; poisoned: number | null } | null
  pendingHunter: number | null
  log: WerewolfLogEntry[]
  deadline: number | null
  winner: WerewolfTeam | null
  finishReason: string | null
  /** 房内频道里我这一视角能看到的消息（夜晚的狼队私频对非狼不存在）。 */
  messages: WerewolfMessage[]
  /** 当前频道（夜晚 = wolf）。 */
  chatScope: WerewolfChatScope
  /** 此刻我能不能发言。 */
  canChat: boolean
  createdAt: number
  updatedAt: number
}

export type LedgerKind = 'income' | 'expense'
export type LedgerStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid'

/**
 * 账目筛选条件。
 *
 * 列表查询（entries）与导出（exportUrl）**共用同一个形状**：导出必须跟着
 * 列表的筛选走。两边签名一旦分叉，就会长出"筛出来三行、导出几百行"那种
 * 不报错的错 —— 而它只能在对账时被人肉发现。
 */
export interface LedgerQueryOptions {
  from?: string
  to?: string
  kind?: LedgerKind
  categoryId?: string
  status?: LedgerStatus
  /** 只看某个活动下的账目 */
  eventId?: string
  /** 标题 / 备注模糊搜索 */
  search?: string
  /** 只看自己记的 */
  mine?: boolean
  /** 只看"待我审批"的（管理员） */
  pending?: boolean
}

/**
 * 筛选条件 → 查询串（列表与导出共用）。
 *
 * 空值一律不进查询串：`URLSearchParams` 会把 null/undefined 拼成字面量
 * "null"/"undefined"，而服务端只判有无、不认这两个词 —— 结果是"筛了个寂寞"。
 */
function ledgerQueryString(options: LedgerQueryOptions): string {
  const params = new URLSearchParams()
  if (options.from) params.set('from', options.from)
  if (options.to) params.set('to', options.to)
  if (options.kind) params.set('kind', options.kind)
  if (options.categoryId) params.set('categoryId', options.categoryId)
  if (options.status) params.set('status', options.status)
  if (options.eventId) params.set('eventId', options.eventId)
  if (options.search?.trim()) params.set('search', options.search.trim())
  if (options.mine) params.set('mine', '1')
  if (options.pending) params.set('pending', '1')
  return params.toString()
}

export interface LedgerCategory {
  id: string
  name: string
  kind: LedgerKind
  icon: string | null
  sortOrder: number
  archived: boolean
}

export interface LedgerSplit {
  id: string
  userId: string
  userName: string
  amountCents: number
  amount: string
  settled: boolean
}

export interface LedgerEntry {
  id: string
  kind: LedgerKind
  amountCents: number
  /** 已格式化的金额字符串，例如 "12.50"。直接显示这个，不要自己算。 */
  amount: string
  categoryId: string | null
  categoryName: string | null
  categoryIcon: string | null
  title: string
  note: string | null
  occurredOn: string
  status: LedgerStatus
  /** 归属的活动（比赛/活动）id；null = 日常账目（不归任何活动）。 */
  eventId: string | null
  eventName: string | null
  createdBy: string
  creatorName: string
  submittedAt: number | null
  decidedBy: string | null
  deciderName: string | null
  decidedAt: number | null
  decisionNote: string | null
  paidAt: number | null
  createdAt: number
  updatedAt: number
  attachments: Array<{ nodeId: string; name: string; size: number; mime: string | null }>
  splits: LedgerSplit[]
}

export interface LedgerSummary {
  from: string | null
  to: string | null
  incomeCents: number
  expenseCents: number
  balanceCents: number
  income: string
  expense: string
  balance: string
  entryCount: number
  byCategory: Array<{
    categoryId: string | null
    name: string
    kind: LedgerKind
    icon: string | null
    totalCents: number
    total: string
    count: number
  }>
  byMonth: Array<{
    month: string
    incomeCents: number
    expenseCents: number
    balanceCents: number
    income: string
    expense: string
    balance: string
  }>
}

export interface LedgerDebt {
  entryId: string
  entryTitle: string
  occurredOn: string
  userId: string
  userName: string
  amountCents: number
  amount: string
  payerId: string
  payerName: string
}

export interface LedgerEntryInput {
  kind: LedgerKind
  /** 金额用字符串传（"12.50"）。服务端解析成整数分，前端不要自己转。 */
  amount: string
  categoryId?: string | null
  title: string
  note?: string | null
  occurredOn: string
  /** 归属的活动（比赛/活动）id；不传或 null = 日常账目。 */
  eventId?: string | null
  attachmentNodeIds?: string[]
  splits?: Array<{ userId: string; amount: string }>
}

export type LedgerEventKind = 'competition' | 'activity' | 'other'
export type LedgerEventStatus = 'open' | 'closed'

export interface LedgerEvent {
  id: string
  name: string
  kind: LedgerEventKind
  startOn: string | null
  endOn: string | null
  status: LedgerEventStatus
  note: string | null
  createdBy: string
  creatorName: string
  createdAt: number
  updatedAt: number
  closedAt: number | null
  closedBy: string | null
  closedByName: string | null
  incomeCents: number
  expenseCents: number
  balanceCents: number
  /** 已格式化的金额字符串，直接显示，不要自己算。 */
  income: string
  expense: string
  balance: string
  /** 参与合计的账目笔数（与收支合计同口径：只算已通过/已支付）。 */
  entryCount: number
}

export interface LedgerEventInput {
  name: string
  kind?: LedgerEventKind
  startOn?: string | null
  endOn?: string | null
  note?: string | null
}

export interface LedgerEventSummary {
  event: LedgerEvent
  incomeCents: number
  expenseCents: number
  balanceCents: number
  income: string
  expense: string
  balance: string
  entryCount: number
  byCategory: Array<{
    categoryId: string | null
    name: string
    kind: LedgerKind
    icon: string | null
    totalCents: number
    total: string
    count: number
  }>
  byPerson: Array<{
    userId: string
    userName: string
    /** 这个人垫付的支出合计。 */
    paidCents: number
    paid: string
    /** 这个人应分摊的合计。 */
    shareCents: number
    share: string
    /** 这个人还没结清的分摊（还欠多少）。 */
    owedCents: number
    owed: string
  }>
  /** 逐笔明细（含草稿/待审批，带状态列；可见范围受权限约束）。 */
  entries: LedgerEntry[]
}

// ---------------------------------------------------------------- 游戏类型

export type GameColor = 'red' | 'black'
export type GameStatus = 'waiting' | 'playing' | 'finished'

export interface GameMove {
  from: string
  to: string
  color: GameColor
  /** 棋子类型字母：K 帅/将、A 仕/士、B 相/象、N 马、R 车、C 炮、P 兵/卒 */
  piece: string
  captured: string | null
  /** 走完这一手之后是否形成将军 */
  check: boolean
  at: number
  by: string
  byName: string
}

/** 机器人的难度档位。 */
export type GameBotLevel = 'easy' | 'normal' | 'hard'

/** 将死时识别出来的杀法（卧槽马、双车错……）。 */
export interface GameMatePattern {
  name: string
  detail: string
}

export interface GameResult {
  winner: GameColor | null
  reason: string
  /** 将死时的杀法；认不出来或不是将死就是 null */
  mate?: GameMatePattern | null
}

export interface GameRoom {
  id: string
  kind: 'xiangqi'
  title: string
  status: GameStatus
  createdBy: string
  creatorName: string
  redPlayer: string | null
  redName: string | null
  blackPlayer: string | null
  blackName: string | null
  /** 棋盘序列化：10 行 × 9 格，'/' 分隔；红方大写、黑方小写、空位 '.' */
  board: string
  turn: GameColor
  moves: GameMove[]
  result: GameResult | null
  inCheck: boolean
  /** 哪一边是电脑（人机对战）；两边都是人就是 null */
  botSide: GameColor | null
  botLevel: GameBotLevel | null
  /** 是否正轮到电脑走 —— 界面据此显示"电脑思考中…" */
  botThinking: boolean
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  /** 我在这一局坐哪一边；观战为 null */
  mySide: GameColor | null
  myTurn: boolean
}

export interface GameStats {
  played: number
  won: number
  lost: number
}

// ---------------------------------------------------------------- 运维（管理员）

export interface AdminOperation {
  id: string
  label: string
  description: string
  /** 变更类操作需要动态口令 */
  mutating: boolean
  /** 参数名 → 参数类型（'service' | 'template' | 'lines'） */
  params: Record<string, string>
}

export interface TotpStatus {
  bound: boolean
  enabledAt: number | null
  hasPending: boolean
  /** 已绑定但解不开（通常是会话密钥被换过）—— 必须在界面上明确提示 */
  broken: boolean
  dockerEnabled: boolean
  dockerConfigured: boolean
}

export interface OperationResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  argv: string[]
}

// ---------------------------------------------------------------- 斗地主

export interface DdzCard {
  id: number
  rank: number
  label: string
  suit: 'spade' | 'heart' | 'club' | 'diamond' | 'joker'
}

export type DdzPhase = 'waiting' | 'bidding' | 'playing' | 'finished'

export interface DdzPlay {
  seat: number
  cards: string[]
  type: string
  typeLabel: string
  at: number
}

export interface DdzSeat {
  seat: number
  userId: string | null
  name: string | null
  online: boolean
}

// ---------------------------------------------------------------- 你画我猜

export type DrawPhase = 'waiting' | 'choosing' | 'drawing' | 'reveal' | 'finished'

export interface DrawPlayerView {
  userId: string
  name: string
  score: number
  online: boolean
  /** 本回合是否已猜对。 */
  guessed: boolean
  isDrawer: boolean
}

export interface DrawChatMsg {
  userId: string
  name: string
  text: string
  at: number
  correct?: boolean
  close?: boolean
}

/** 画笔操作。与 DrawApp 画布的单位约定：坐标是 0-1000 的相对值。 */
export interface DrawStrokeInput {
  op: 'begin' | 'points' | 'end' | 'clear' | 'undo'
  strokeId: string
  points: Array<{ x: number; y: number }>
  color: string
  width: number
  tool: 'pen' | 'eraser'
}

/** SSE 广播的笔迹（服务端在 op 外再包一层发起人，供前端过滤自己的回声）。 */
export interface DrawStrokeBroadcast extends DrawStrokeInput {
  from: string
}

/** 按视角裁剪后的游戏状态（服务端 draw.ts viewFor 的镜像）。 */
export interface DrawGameView {
  phase: DrawPhase
  players: DrawPlayerView[]
  drawerIndex: number
  drawerName: string
  round: number
  totalRounds: number
  /** 只有画家 / 已猜对者 / reveal 后才有值；猜词者是 null。 */
  word: string | null
  masked: string | null
  revealed: boolean[]
  /** 只发给画家本人的候选词。 */
  wordChoices: string[]
  iGuessed: boolean
  iAmDrawer: boolean
  phaseEndsAt: number
  result: { ranking: Array<{ userId: string; name: string; score: number }> } | null
}

export interface DrawRoom {
  id: string
  kind: 'draw'
  title: string
  phase: DrawPhase
  status: string
  createdBy: string
  creatorName: string
  view: DrawGameView
  chat: DrawChatMsg[]
  createdAt: number
  updatedAt: number
}

/** 历史对局列表项。 */
export interface DrawHistoryItem {
  roomId: string
  title: string
  finishedAt: number
  ranking: Array<{ userId: string; name: string; score: number }>
  roundCount: number
}

/** 历史对局里的一个回合（含那一回合的画）。 */
export interface DrawHistoryRound {
  turnNo: number
  roundNo: number
  drawerId: string
  drawerName: string
  word: string
  strokes: DrawStrokeInput[]
  results: Array<{ userId: string; name: string; guessed: boolean; score: number }>
  endedAt: number
}

export interface DrawHistoryDetail {
  roomId: string
  title: string
  finishedAt: number
  ranking: Array<{ userId: string; name: string; score: number }>
  rounds: DrawHistoryRound[]
}

// ---------------------------------------------------------------- 留言板

export type BoardKind = 'bug' | 'idea' | 'complaint'

export interface BoardPost {
  id: string
  kind: BoardKind
  body: string
  authorId: string
  authorName: string
  resolvedAt: number | null
  resolvedBy: string | null
  resolvedByName: string | null
  resolution: string | null
  createdAt: number
  /** 是不是我发的（前端据此显示「撤回」）。 */
  mine: boolean
}

export interface DdzRoom {
  id: string
  kind: 'doudizhu'
  title: string
  phase: DdzPhase
  createdBy: string
  creatorName: string
  seats: DdzSeat[]
  /** 我坐第几号座；观战为 null。 */
  mySeat: number | null
  /** 三个座位各剩几张牌（公开信息）。 */
  handCounts: number[]
  /** **只有我自己**的手牌；观战或未发牌时为 null。 */
  myHand: DdzCard[] | null
  bottom: DdzCard[] | null
  landlord: number | null
  current: number
  lastPlay: { seat: number; cards: string[]; typeLabel: string } | null
  /** 轮到我时服务端算好的出牌提示（每项是一组牌面文字）。 */
  hints: string[][]
  history: DdzPlay[]
  result: { winnerSeat: number; landlordWon: boolean; reason: string } | null
  createdAt: number
  updatedAt: number
  myTurn: boolean
  canBid: boolean
}

// ---------------------------------------------------------------- 展示辅助

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${time}`
  const sameYear = date.getFullYear() === now.getFullYear()
  const md = `${date.getMonth() + 1}月${date.getDate()}日`
  return sameYear ? `${md} ${time}` : `${date.getFullYear()}年${md}`
}

/** 根据 MIME 与文件名给出一个用于显示的类型标签与图标种类。 */
export function fileKind(entry: FileEntry): {
  label: string
  icon: 'folder' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'file'
} {
  if (entry.kind === 'folder') return { label: '文件夹', icon: 'folder' }
  const mime = entry.mime ?? ''
  const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()

  if (mime === 'application/pdf' || ext === '.pdf') return { label: 'PDF 文档', icon: 'pdf' }
  if (mime.includes('wordprocessingml') || ext === '.docx' || ext === '.doc')
    return { label: 'Word 文档', icon: 'doc' }
  if (mime.includes('spreadsheetml') || ext === '.xlsx' || ext === '.xls' || mime === 'text/csv')
    return { label: '表格', icon: 'sheet' }
  if (mime.includes('presentationml') || ext === '.pptx' || ext === '.ppt')
    return { label: '演示文稿', icon: 'slide' }
  if (mime.startsWith('image/')) return { label: '图片', icon: 'image' }
  if (mime.startsWith('video/')) return { label: '视频', icon: 'video' }
  if (mime.startsWith('audio/')) return { label: '音频', icon: 'audio' }
  if (mime === 'application/zip' || ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext))
    return { label: '压缩包', icon: 'archive' }
  if (mime.startsWith('text/')) return { label: '文本', icon: 'text' }
  return { label: '文件', icon: 'file' }
}
