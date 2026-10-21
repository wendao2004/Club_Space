/**
 * 记账数据层（社团报账）。
 *
 * 三条硬性设计决定：
 *
 * 1. **金额全程用整数「分」。** 不用浮点，一分钟都不用。
 *    0.1 + 0.2 !== 0.3 在记账里是灾难：几十笔之后余额就对不上，
 *    而用户的第一反应是"这软件算错了"。所有加减在整数域完成，只在显示时除 100。
 *    连解析字符串也不经过 parseFloat —— 见 parseAmountToCents 的注释。
 *
 * 2. **业务日期与记录时间分开。** `occurred_on` 是钱实际花出去的那天，
 *    `created_at` 是录入系统的那天。周五的聚餐周一补录，按创建时间统计
 *    会把账算进错误的月份，而月度报表正是记账最核心的用途。
 *
 * 3. **金额相关操作全部进审计日志。** 记账是唯一直接对应"钱"的模块，
 *    谁在什么时候把哪笔账从 submitted 改成 approved，必须留痕。
 *
 * 权限模型：
 *   - 成员：创建/编辑自己的 draft、提交自己的账目、查看全部已通过/已支付的账目
 *     （社团账目应当对成员透明，只把"未审批的草稿"藏起来）
 *   - 管理员：审批、驳回、标记支付，可编辑任意账目
 */
import { getDb, newId, now, transaction } from './db.ts'
import { HttpError } from './files.ts'

// ---------------------------------------------------------------- 金额

/**
 * 把用户输入的金额解析成整数分。
 *
 * **刻意不用 parseFloat。** `parseFloat('1.005') * 100` 得到 100.49999999999999，
 * 取整就变成 100 分而不是期望的 100.5 分。用字符串切分可以做到精确：
 * 整数部分乘 100，小数部分补齐到两位。
 */
export function parseAmountToCents(input: string | number): number {
  const raw = String(input).trim().replace(/[¥￥,\s]/g, '')
  if (!raw) throw new HttpError(400, '金额不能为空')

  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) {
    // 明确拒绝三位以上小数：那是用户输错了，静默四舍五入会埋下对不上账的隐患
    if (/^\d+\.\d{3,}$/.test(raw)) {
      throw new HttpError(400, '金额最多两位小数（分）')
    }
    throw new HttpError(400, `金额格式不正确：「${input}」（示例：12.50）`)
  }

  const yuan = Number.parseInt(match[1]!, 10)
  const fen = match[2] ? Number.parseInt(match[2]!.padEnd(2, '0'), 10) : 0

  // 上限 1 亿（= 100 亿分），远超社团规模，同时防止整数溢出类问题
  if (yuan > 100_000_000) throw new HttpError(400, '金额过大')

  return yuan * 100 + fen
}

/** 把整数分格式化成显示用的字符串（不带符号）。 */
export function formatCents(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`
}

/** 校验日期字符串是 YYYY-MM-DD 且真实存在（挡掉 2026-02-30 这种）。 */
export function assertValidDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(400, `日期格式应为 YYYY-MM-DD，收到「${date}」`)
  }
  const [y, m, d] = date.split('-').map((v) => Number.parseInt(v, 10))
  const parsed = new Date(Date.UTC(y!, m! - 1, d!))
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m! - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new HttpError(400, `日期不存在：${date}`)
  }
  return date
}

// ---------------------------------------------------------------- 分类

export interface Category {
  id: string
  name: string
  kind: 'income' | 'expense'
  icon: string | null
  sortOrder: number
  archived: boolean
}

const DEFAULT_CATEGORIES: Array<{ name: string; kind: 'income' | 'expense'; icon: string }> = [
  { name: '会费收入', kind: 'income', icon: 'users' },
  { name: '活动收入', kind: 'income', icon: 'star' },
  { name: '赞助', kind: 'income', icon: 'cloud' },
  { name: '其他收入', kind: 'income', icon: 'plus' },
  { name: '餐饮', kind: 'expense', icon: 'clock' },
  { name: '场地', kind: 'expense', icon: 'home' },
  { name: '物料', kind: 'expense', icon: 'archive' },
  { name: '交通', kind: 'expense', icon: 'move' },
  { name: '设备', kind: 'expense', icon: 'tools' },
  { name: '其他支出', kind: 'expense', icon: 'file' },
]

/** 首次访问记账模块时灌入默认分类。已经灌过就什么都不做。 */
export function seedDefaultCategories(): void {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM ledger_categories').get() as { n: number }
  if (count.n > 0) return

  transaction(() => {
    const insert = getDb().prepare(
      `INSERT INTO ledger_categories (id, name, kind, icon, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    let order = 0
    for (const cat of DEFAULT_CATEGORIES) {
      insert.run(newId('cat'), cat.name, cat.kind, cat.icon, order++, now())
    }
  })
}

export function listCategories(includeArchived = false): Category[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, kind, icon, sort_order, archived FROM ledger_categories
        ${includeArchived ? '' : 'WHERE archived = 0'}
        ORDER BY kind DESC, sort_order, name`,
    )
    .all() as unknown as Array<{
    id: string
    name: string
    kind: 'income' | 'expense'
    icon: string | null
    sort_order: number
    archived: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    icon: r.icon,
    sortOrder: r.sort_order,
    archived: r.archived === 1,
  }))
}

export function createCategory(input: {
  name: string
  kind: 'income' | 'expense'
  icon?: string
}): Category {
  const name = input.name.trim()
  if (!name) throw new HttpError(400, '分类名不能为空')
  if (name.length > 20) throw new HttpError(400, '分类名过长')

  const existing = getDb()
    .prepare('SELECT id FROM ledger_categories WHERE name = ? AND kind = ?')
    .get(name, input.kind)
  if (existing) throw new HttpError(409, `「${name}」已存在`)

  const id = newId('cat')
  const maxOrder = getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ledger_categories')
    .get() as { m: number }
  getDb()
    .prepare(
      `INSERT INTO ledger_categories (id, name, kind, icon, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, input.kind, input.icon ?? 'file', maxOrder.m + 1, now())

  return listCategories(true).find((c) => c.id === id)!
}

/**
 * 归档分类。
 *
 * 刻意用归档而不是删除：历史账目还引用着它，删掉会让旧账的分类变成空白，
 * 而"去年的餐饮支出"这种信息一旦丢失就补不回来了。
 */
export function archiveCategory(id: string, archived: boolean): void {
  const row = getDb().prepare('SELECT id FROM ledger_categories WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, '分类不存在')
  getDb().prepare('UPDATE ledger_categories SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

// ---------------------------------------------------------------- 账目

export type EntryStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid'

export interface EntryView {
  id: string
  kind: 'income' | 'expense'
  amountCents: number
  amount: string
  categoryId: string | null
  categoryName: string | null
  categoryIcon: string | null
  title: string
  note: string | null
  occurredOn: string
  status: EntryStatus
  /** 归属的活动（比赛/活动）。null = 不归任何活动的日常账目。 */
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
  splits: Array<{
    id: string
    userId: string
    userName: string
    amountCents: number
    amount: string
    settled: boolean
  }>
}

const ENTRY_SELECT = `
  SELECT e.*, c.name AS category_name, c.icon AS category_icon,
         ev.name AS event_name,
         u.display_name AS creator_name,
         d.display_name AS decider_name
    FROM ledger_entries e
    LEFT JOIN ledger_categories c ON c.id = e.category_id
    LEFT JOIN ledger_events ev ON ev.id = e.event_id
    JOIN users u ON u.id = e.created_by
    LEFT JOIN users d ON d.id = e.decided_by
`

interface RawEntry {
  id: string
  kind: 'income' | 'expense'
  amount_cents: number
  category_id: string | null
  category_name: string | null
  category_icon: string | null
  title: string
  note: string | null
  occurred_on: string
  status: EntryStatus
  event_id: string | null
  event_name: string | null
  created_by: string
  creator_name: string
  submitted_at: number | null
  decided_by: string | null
  decider_name: string | null
  decided_at: number | null
  decision_note: string | null
  paid_at: number | null
  created_at: number
  updated_at: number
}

function attachChildren(entry: RawEntry): EntryView {
  const attachments = getDb()
    .prepare(
      `SELECT a.node_id, n.name, n.size, n.mime
         FROM ledger_attachments a JOIN nodes n ON n.id = a.node_id
        WHERE a.entry_id = ? ORDER BY a.added_at`,
    )
    .all(entry.id) as unknown as Array<{
    node_id: string
    name: string
    size: number
    mime: string | null
  }>

  const splits = getDb()
    .prepare(
      `SELECT s.id, s.user_id, u.display_name, s.amount_cents, s.settled
         FROM ledger_splits s JOIN users u ON u.id = s.user_id
        WHERE s.entry_id = ? ORDER BY u.display_name`,
    )
    .all(entry.id) as unknown as Array<{
    id: string
    user_id: string
    display_name: string
    amount_cents: number
    settled: number
  }>

  return {
    id: entry.id,
    kind: entry.kind,
    amountCents: entry.amount_cents,
    amount: formatCents(entry.amount_cents),
    categoryId: entry.category_id,
    categoryName: entry.category_name,
    categoryIcon: entry.category_icon,
    title: entry.title,
    note: entry.note,
    occurredOn: entry.occurred_on,
    status: entry.status,
    eventId: entry.event_id,
    eventName: entry.event_name,
    createdBy: entry.created_by,
    creatorName: entry.creator_name,
    submittedAt: entry.submitted_at,
    decidedBy: entry.decided_by,
    deciderName: entry.decider_name,
    decidedAt: entry.decided_at,
    decisionNote: entry.decision_note,
    paidAt: entry.paid_at,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    attachments: attachments.map((a) => ({
      nodeId: a.node_id,
      name: a.name,
      size: a.size,
      mime: a.mime,
    })),
    splits: splits.map((s) => ({
      id: s.id,
      userId: s.user_id,
      userName: s.display_name,
      amountCents: s.amount_cents,
      amount: formatCents(s.amount_cents),
      settled: s.settled === 1,
    })),
  }
}

export function getEntry(id: string): EntryView | null {
  const row = getDb().prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as RawEntry | undefined
  return row ? attachChildren(row) : null
}

/**
 * 该用户能看到哪些账目。
 *
 * 社团账目对成员透明 —— 已提交/已通过/已支付的都能看到，
 * 只有"还没提交的草稿"是私密的（那是别人还在编辑的东西）。
 * 管理员看全部。
 */
function visibilityClause(userId: string, isAdmin: boolean): { sql: string; params: Array<string | number | null> } {
  if (isAdmin) return { sql: '1=1', params: [] }
  return {
    sql: `(e.status != 'draft' OR e.created_by = ?)`,
    params: [userId],
  }
}

export interface ListOptions {
  from?: string
  to?: string
  kind?: 'income' | 'expense'
  categoryId?: string
  status?: EntryStatus
  /** 只看某个活动下的账目 */
  eventId?: string
  /** 标题 / 备注模糊搜索 */
  search?: string
  /** 只看自己提交的 */
  mine?: boolean
  /** 只看到"待我审批"的（管理员用） */
  pendingReview?: boolean
  limit?: number
  offset?: number
}

/**
 * 筛选条件 → WHERE 片段。
 *
 * ⚠️ **列表、导出、待办计数三处必须共用这一份**。
 * 待办角标最怕的就是"自己另定一套口径"：角标写 3，点进去列表只有 2 条，
 * 用户会直接认定这个功能坏了。所以这里不复制粘贴条件，只被复用。
 */
function entryWhere(
  userId: string,
  isAdmin: boolean,
  options: ListOptions,
): { whereSql: string; params: Array<string | number | null> } {
  const vis = visibilityClause(userId, isAdmin)
  const where: string[] = [vis.sql]
  const params: Array<string | number | null> = [...vis.params]

  if (options.from) {
    where.push('e.occurred_on >= ?')
    params.push(options.from)
  }
  if (options.to) {
    where.push('e.occurred_on <= ?')
    params.push(options.to)
  }
  if (options.kind) {
    where.push('e.kind = ?')
    params.push(options.kind)
  }
  if (options.categoryId) {
    where.push('e.category_id = ?')
    params.push(options.categoryId)
  }
  if (options.status) {
    where.push('e.status = ?')
    params.push(options.status)
  }
  if (options.eventId) {
    where.push('e.event_id = ?')
    params.push(options.eventId)
  }
  if (options.search) {
    // 标题/备注模糊搜。用户输入里的 % _ \ 必须先转义，否则一个 "%" 就能
    // 把整本账都匹配出来（LIKE 的通配符），ESC 会当成字面量匹配。
    const term = `%${options.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    where.push("(e.title LIKE ? ESCAPE '\\' OR e.note LIKE ? ESCAPE '\\')")
    params.push(term, term)
  }
  if (options.mine) {
    where.push('e.created_by = ?')
    params.push(userId)
  }
  if (options.pendingReview) {
    where.push("e.status = 'submitted'")
  }

  return { whereSql: where.join(' AND '), params }
}

export function listEntries(userId: string, isAdmin: boolean, options: ListOptions = {}): {
  entries: EntryView[]
  total: number
} {
  const { whereSql, params } = entryWhere(userId, isAdmin, options)

  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ledger_entries e WHERE ${whereSql}`)
      .get(...params) as { n: number }
  ).n

  // ⚠️ 上限见 EXPORT_LIMIT 的注释：原来是写死的 500，而导出路径传的是 5000，
  // 于是导出被静默截断在 500 行。现在两边用同一个常量。
  const limit = Math.min(EXPORT_LIMIT, Math.max(1, options.limit ?? 100))
  const offset = Math.max(0, options.offset ?? 0)

  const rows = getDb()
    .prepare(
      `${ENTRY_SELECT} WHERE ${whereSql}
        ORDER BY e.occurred_on DESC, e.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as RawEntry[]

  return { entries: rows.map(attachChildren), total }
}

/**
 * 按筛选条件数条数（不拉行）。
 *
 * 存在的唯一理由是待办角标：它必须和列表的 `total` **完全一致**，
 * 所以和 listEntries 共用 entryWhere，而不是另写一个 COUNT。
 */
export function countEntries(userId: string, isAdmin: boolean, options: ListOptions = {}): number {
  const { whereSql, params } = entryWhere(userId, isAdmin, options)
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ledger_entries e WHERE ${whereSql}`)
      .get(...params) as { n: number }
  ).n
}

/** 待办里最多带多少个 id。角标只需要一个数字，id 是为了"点进去直接定位"。 */
export const TODO_ID_LIMIT = 20

/**
 * 按筛选条件取前几条 id，顺序与列表完全一致（同 ORDER BY）。
 * 用 LIMIT 而不是把全部 id 都吐出来：真实待办通常个位数，上万条时也不该把响应撑大。
 */
export function listEntryIds(
  userId: string,
  isAdmin: boolean,
  options: ListOptions = {},
  limit = TODO_ID_LIMIT,
): string[] {
  const { whereSql, params } = entryWhere(userId, isAdmin, options)
  const rows = getDb()
    .prepare(
      `SELECT e.id FROM ledger_entries e WHERE ${whereSql}
        ORDER BY e.occurred_on DESC, e.created_at DESC
        LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 200))) as unknown as Array<{ id: string }>
  return rows.map((r) => r.id)
}

export interface TodoBucket {
  /** 与列表同一筛选条件下的 total */
  count: number
  /** 该筛选条件下的前若干条 id（≤ TODO_ID_LIMIT） */
  ids: string[]
}

export interface LedgerTodo {
  /** 待我审批：仅管理员/创建者有审批权（decide 路由是 requireRole admin） */
  review: TodoBucket
  /** 我提交的、被驳回待修改 */
  rejected: TodoBucket
}

/**
 * 记账待办。
 *
 * 口径逐条对应列表筛选条件（见 server/src/index.ts 的 /api/ledger/entries）：
 *   - review   == `?pending=1`          （管理员；与列表的「待我审批」勾选框同一条件）
 *   - rejected == `?mine=1&status=rejected`
 *
 * 普通成员的 review 恒为 0：账目的审批动作在路由层就是管理员专属
 * （POST /api/ledger/entries/:id/decide 用 requireRole('admin')），
 * 给成员一个他点进去也审不了的角标只会制造挫败感。
 */
export function ledgerTodo(userId: string, isAdmin: boolean): LedgerTodo {
  const reviewFilters: ListOptions = { pendingReview: true }
  const review: TodoBucket = isAdmin
    ? {
        count: countEntries(userId, true, reviewFilters),
        ids: listEntryIds(userId, true, reviewFilters),
      }
    : { count: 0, ids: [] }

  const rejectedFilters: ListOptions = { mine: true, status: 'rejected' }
  return {
    review,
    rejected: {
      count: countEntries(userId, isAdmin, rejectedFilters),
      ids: listEntryIds(userId, isAdmin, rejectedFilters),
    },
  }
}

export interface EntryInput {
  kind: 'income' | 'expense'
  amountCents: number
  categoryId?: string | null
  title: string
  note?: string | null
  occurredOn: string
  /** 归属的活动。不传或传 null = 日常账目（不归任何活动）。 */
  eventId?: string | null
  attachmentNodeIds?: string[]
  /** 分摊。不传则由调用方决定是否自动均分。 */
  splits?: Array<{ userId: string; amountCents: number }>
}

/**
 * 建账目。
 *
 * 第三个参数是「创建者是不是管理员/创建者（owner）」。
 * 管理员建的账目**直接落成 approved**，而不是先 draft 再走 submit→decide：
 * 用户明确的反馈是"管理员记账上传为啥还需要通过"。
 * 原先只有管理员时更是个死锁 —— 审批流本身规定"不能审批自己提交的账目"，
 * 于是单人社团里管理员自己记的每一笔都永远批不了、进不了报表。
 *
 * 但**不能偷偷跳过记录**：直接入账同样要写 decided_by = 创建者本人、
 * decided_at = 当下、decision_note 说明这是管理员直接入账。
 * 这样审计里一眼就能看出"这条是管理员自己直接入的"，而不是"被谁审批过"。
 *
 * 普通成员建的账目**仍然是 draft**，审批流对他们一点没变。
 */
export function createEntry(userId: string, input: EntryInput, createdByAdmin = false): EntryView {
  const title = input.title.trim()
  if (!title) throw new HttpError(400, '请填写事由')
  if (title.length > 100) throw new HttpError(400, '事由过长（最多 100 字）')
  if (input.amountCents <= 0) throw new HttpError(400, '金额必须大于 0')
  assertValidDate(input.occurredOn)

  // 活动必须存在；已封账的活动不能再记新账（见 ledger_events 的注释）
  assertEventWritable(input.eventId)

  if (input.categoryId) {
    const cat = getDb()
      .prepare('SELECT id, kind, archived FROM ledger_categories WHERE id = ?')
      .get(input.categoryId) as { id: string; kind: string; archived: number } | undefined
    if (!cat) throw new HttpError(404, '分类不存在')
    if (cat.archived === 1) throw new HttpError(400, '该分类已归档，不能用于新账目')
    if (cat.kind !== input.kind) {
      throw new HttpError(400, '分类的收支类型与账目不一致')
    }
  }

  // 分摊金额之和必须等于总额 —— 否则会出现"账上是 300，分摊加起来 280"这种
  // 事后无法解释的差异，而且没人知道该信哪个
  if (input.splits && input.splits.length > 0) {
    const sum = input.splits.reduce((acc, s) => acc + s.amountCents, 0)
    if (sum !== input.amountCents) {
      throw new HttpError(
        400,
        `分摊合计 ${formatCents(sum)} 与总额 ${formatCents(input.amountCents)} 不一致`,
      )
    }
  }

  return transaction(() => {
    const id = newId('le')
    const ts = now()
    // 管理员直接入账：状态直接 approved，同时把"审批痕迹"如实补上。
    // 普通成员：draft，等提交/审批（保持原样）。
    getDb()
      .prepare(
        `INSERT INTO ledger_entries
           (id, kind, amount_cents, category_id, title, note, occurred_on, status, event_id,
            created_by, created_at, updated_at, submitted_at, decided_by, decided_at, decision_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.amountCents,
        input.categoryId ?? null,
        title,
        input.note?.trim() || null,
        input.occurredOn,
        createdByAdmin ? 'approved' : 'draft',
        input.eventId ?? null,
        userId,
        ts,
        ts,
        createdByAdmin ? ts : null,
        createdByAdmin ? userId : null,
        createdByAdmin ? ts : null,
        createdByAdmin ? '管理员直接入账（无需审批）' : null,
      )

    for (const nodeId of input.attachmentNodeIds ?? []) {
      getDb()
        .prepare('INSERT OR IGNORE INTO ledger_attachments (entry_id, node_id, added_at) VALUES (?, ?, ?)')
        .run(id, nodeId, ts)
    }

    for (const split of input.splits ?? []) {
      getDb()
        .prepare(
          'INSERT INTO ledger_splits (id, entry_id, user_id, amount_cents) VALUES (?, ?, ?, ?)',
        )
        .run(newId('sp'), id, split.userId, split.amountCents)
    }

    return getEntry(id)!
  })
}

export function updateEntry(id: string, userId: string, isAdmin: boolean, input: Partial<EntryInput>): EntryView {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (!isAdmin && current.createdBy !== userId) throw new HttpError(403, '只能修改自己创建的账目')
  // 已审批/已支付的账目不能再改 —— 否则审批就失去意义了
  if (!isAdmin && current.status !== 'draft' && current.status !== 'rejected') {
    throw new HttpError(400, `已提交的账目不能直接修改（当前状态：${statusLabel(current.status)}），请先撤回`)
  }

  // 已封账的活动里，账目一条都不许再改。比赛结算后这个活动的账目应当是定数，
  // 否则"这次比赛花了多少"会随着有人事后随手一改而漂移。
  assertEventWritable(current.eventId)
  // 换活动时，目标活动也必须还没封账（不能把账挪进一个已结算的活动里）
  if (input.eventId !== undefined && input.eventId !== current.eventId) {
    assertEventWritable(input.eventId)
  }

  if (input.occurredOn) assertValidDate(input.occurredOn)
  if (input.amountCents !== undefined && input.amountCents <= 0) {
    throw new HttpError(400, '金额必须大于 0')
  }

  // 分摊与总额的一致性校验。
  //
  // ⚠️ 关键点：**只要金额或分摊任一发生变化就要校验**，不能只在传了 splits 时校验。
  // 最初的写法把校验包在 `if (input.splits)` 里，于是"只改金额、不带分摊"就能
  // 绕过这个不变量：总额从 100 改成 10000，分摊还合计 100 —— 报表记 10000 元支出，
  // 欠款只让某人还 100 元，差额无人承担。而且这些坏数据会一路通过审批进入已支付状态。
  const nextTotal = input.amountCents ?? current.amountCents
  const nextSplits = input.splits ?? current.splits.map((s) => ({ userName: s.userName, amountCents: s.amountCents }))
  if (nextSplits.length > 0) {
    const sum = nextSplits.reduce((acc, s) => acc + s.amountCents, 0)
    if (sum !== nextTotal) {
      throw new HttpError(
        400,
        `分摊合计 ${formatCents(sum)} 与总额 ${formatCents(nextTotal)} 不一致` +
          (input.splits ? '' : '（你只改了金额，但已有的分摊没跟着改）'),
      )
    }
  }

  return transaction(() => {
    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (input.kind !== undefined) {
      sets.push('kind = ?')
      params.push(input.kind)
    }
    if (input.amountCents !== undefined) {
      sets.push('amount_cents = ?')
      params.push(input.amountCents)
    }
    if (input.categoryId !== undefined) {
      sets.push('category_id = ?')
      params.push(input.categoryId)
    }
    if (input.title !== undefined) {
      sets.push('title = ?')
      params.push(input.title.trim())
    }
    if (input.note !== undefined) {
      sets.push('note = ?')
      params.push(input.note?.trim() || null)
    }
    if (input.occurredOn !== undefined) {
      sets.push('occurred_on = ?')
      params.push(input.occurredOn)
    }
    if (input.eventId !== undefined) {
      sets.push('event_id = ?')
      params.push(input.eventId)
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(now(), id)
      getDb().prepare(`UPDATE ledger_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    if (input.attachmentNodeIds) {
      getDb().prepare('DELETE FROM ledger_attachments WHERE entry_id = ?').run(id)
      const insert = getDb().prepare(
        'INSERT OR IGNORE INTO ledger_attachments (entry_id, node_id, added_at) VALUES (?, ?, ?)',
      )
      for (const nodeId of input.attachmentNodeIds) insert.run(id, nodeId, now())
    }

    if (input.splits) {
      getDb().prepare('DELETE FROM ledger_splits WHERE entry_id = ?').run(id)
      const insert = getDb().prepare(
        'INSERT INTO ledger_splits (id, entry_id, user_id, amount_cents) VALUES (?, ?, ?, ?)',
      )
      for (const split of input.splits) insert.run(newId('sp'), id, split.userId, split.amountCents)
    }

    return getEntry(id)!
  })
}

export function deleteEntry(id: string, userId: string, isAdmin: boolean): void {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (!isAdmin && current.createdBy !== userId) throw new HttpError(403, '只能删除自己创建的账目')
  if (!isAdmin && (current.status === 'approved' || current.status === 'paid')) {
    throw new HttpError(400, '已审批或已支付的账目不能删除')
  }
  // 已封账活动里的账目也不能删：封账的意义就是"历史数据一条都不少"，
  // 允许删的话，删一笔就能把已定稿的汇总悄悄改小。
  assertEventWritable(current.eventId)
  getDb().prepare('DELETE FROM ledger_entries WHERE id = ?').run(id)
}

// ---------------------------------------------------------------- 审批流

export function statusLabel(status: EntryStatus): string {
  const labels: Record<EntryStatus, string> = {
    draft: '草稿',
    submitted: '待审批',
    approved: '已通过',
    rejected: '已驳回',
    paid: '已支付',
  }
  return labels[status]
}

/**
 * 提交：draft → submitted，进入审批流。
 *
 * **只有创建者能提交自己的账目，管理员也不行** —— 这是刻意的取舍：
 * "提交"是创建者对自己草稿的确认动作（"我确认这笔账该这么记"），
 * 管理员要替别人推进流程，正确做法是直接编辑那笔草稿再提交，或者驳回后
 * 让创建者自己改。让管理员能"替别人提交"，反而模糊了责任归属。
 * （管理员的编辑/删除权见 updateEntry / deleteEntry。）
 */
export function submitEntry(id: string, userId: string): EntryView {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (current.createdBy !== userId) throw new HttpError(403, '只能提交自己创建的账目')
  if (current.status !== 'draft' && current.status !== 'rejected') {
    throw new HttpError(400, `当前状态是「${statusLabel(current.status)}」，不能提交`)
  }
  // 封账闸门。这里原来漏了 —— 只堵了 create/update/delete/decide，
  // 于是封账后成员照样能把自己的草稿推进到"待审批"，与"封账后这个活动的账目只读"
  // 的说法不符。提交与撤回都属于**改动账目本身**，必须挡住。
  assertEventWritable(current.eventId)

  getDb()
    .prepare("UPDATE ledger_entries SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?")
    .run(now(), now(), id)
  return getEntry(id)!
}

export function decideEntry(
  id: string,
  reviewerId: string,
  decision: 'approve' | 'reject',
  note?: string,
  reviewerIsAdmin = false,
): EntryView {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (current.status !== 'submitted') {
    throw new HttpError(400, `只有「待审批」的账目可以审批（当前状态：${statusLabel(current.status)}）`)
  }
  // 已封账活动里的账目不再变动 —— 审批会把一笔账推进汇总，等于改了这次活动的数字。
  assertEventWritable(current.eventId)
  // 「不能审批自己提交的账目」这条规则**只约束普通成员**。
  // 对管理员/创建者放开：单人社团里管理员本来就只有自己一个人，
  // 硬卡着"不能审自己"会让走正常流程的账目永远卡在待审批（就是用户反馈的死锁）。
  // 管理员因此可以直接审自己的账；这是刻意的取舍，审计日志如实记录审批人是谁。
  if (current.createdBy === reviewerId && !reviewerIsAdmin) {
    throw new HttpError(400, '不能审批自己提交的账目，请找另一位管理员')
  }

  const status: EntryStatus = decision === 'approve' ? 'approved' : 'rejected'
  getDb()
    .prepare(
      `UPDATE ledger_entries
          SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(status, reviewerId, now(), note?.trim() || null, now(), id)
  return getEntry(id)!
}

export function markPaid(id: string, userId: string): EntryView {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (current.status !== 'approved') {
    throw new HttpError(400, `只有「已通过」的账目可以标记支付（当前状态：${statusLabel(current.status)}）`)
  }
  // ⚠️ **刻意不设封账闸门**，与 settleSplit 一致。
  //
  // 区别在于改的是什么：submit / withdraw / update / delete 改的是**账目本身**
  // （金额、事由、走什么流程），封账后当然不能动；
  // 而"标记已支付"和"标记分摊已还清"改的是**执行状态** —— 钱还没付完、
  // 有人还没还钱，这些事在比赛结束封账之后照样要能记。
  // 挡住它们只会让人绕过去（"那我先解封再标，标完再封"），反而更乱。
  //
  // 所以这里的边界是：**封账冻结账目内容，不冻结收付款动作。**
  getDb()
    .prepare("UPDATE ledger_entries SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?")
    .run(now(), now(), id)
  return getEntry(id)!
}

/** 撤回：把 submitted 打回 draft，让提交者能改。 */
export function withdrawEntry(id: string, userId: string): EntryView {
  const current = getEntry(id)
  if (!current) throw new HttpError(404, '账目不存在')
  if (current.createdBy !== userId) throw new HttpError(403, '只能撤回自己提交的账目')
  if (current.status !== 'submitted') {
    throw new HttpError(400, `只有「待审批」的账目可以撤回（当前状态：${statusLabel(current.status)}）`)
  }
  // 与 submitEntry 同理：撤回也是改动账目本身，封账后不该还能动
  assertEventWritable(current.eventId)
  getDb()
    .prepare("UPDATE ledger_entries SET status = 'draft', submitted_at = NULL, updated_at = ? WHERE id = ?")
    .run(now(), id)
  return getEntry(id)!
}

/** 标记某人已还清自己的分摊。 */
export function settleSplit(entryId: string, splitUserId: string, actorId: string, isAdmin: boolean, settled: boolean): void {
  const entry = getEntry(entryId)
  if (!entry) throw new HttpError(404, '账目不存在')
  if (!isAdmin && splitUserId !== actorId) {
    throw new HttpError(403, '只能标记自己的分摊')
  }
  getDb()
    .prepare('UPDATE ledger_splits SET settled = ?, settled_at = ? WHERE entry_id = ? AND user_id = ?')
    .run(settled ? 1 : 0, settled ? now() : null, entryId, splitUserId)
}

// ---------------------------------------------------------------- 统计

export interface Summary {
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
    kind: 'income' | 'expense'
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

/**
 * 汇总统计。
 *
 * **只统计已通过和已支付的钱。**
 * 草稿和待审批的不能进报表 —— 否则"这个月花了多少"会随着有人随手记一笔草稿
 * 而不断变化，报表就不可信了。这是记账里最容易被做错的一点。
 */
export function summary(options: { from?: string; to?: string } = {}): Summary {
  const where: string[] = ["e.status IN ('approved', 'paid')"]
  const params: Array<string | number | null> = []
  if (options.from) {
    where.push('e.occurred_on >= ?')
    params.push(options.from)
  }
  if (options.to) {
    where.push('e.occurred_on <= ?')
    params.push(options.to)
  }
  const whereSql = where.join(' AND ')

  const totals = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense,
         COUNT(*) AS n
       FROM ledger_entries e WHERE ${whereSql}`,
    )
    .get(...params) as { income: number; expense: number; n: number }

  const byCategoryRows = getDb()
    .prepare(
      `SELECT e.category_id, COALESCE(c.name, '未分类') AS name, e.kind,
              c.icon, SUM(e.amount_cents) AS total, COUNT(*) AS count
         FROM ledger_entries e
         LEFT JOIN ledger_categories c ON c.id = e.category_id
        WHERE ${whereSql}
        GROUP BY e.category_id, e.kind
        ORDER BY total DESC`,
    )
    .all(...params) as unknown as Array<{
    category_id: string | null
    name: string
    kind: 'income' | 'expense'
    icon: string | null
    total: number
    count: number
  }>

  // 按月分组用 substr(occurred_on, 1, 7) 取 "YYYY-MM"。
  // 不用 strftime：occurred_on 已经是规范化的 ISO 日期字符串，直接截取更直观也更快。
  const byMonthRows = getDb()
    .prepare(
      `SELECT substr(e.occurred_on, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense
         FROM ledger_entries e WHERE ${whereSql}
        GROUP BY month ORDER BY month DESC`,
    )
    .all(...params) as unknown as Array<{ month: string; income: number; expense: number }>

  return {
    from: options.from ?? null,
    to: options.to ?? null,
    incomeCents: totals.income,
    expenseCents: totals.expense,
    balanceCents: totals.income - totals.expense,
    income: formatCents(totals.income),
    expense: formatCents(totals.expense),
    balance: formatCents(totals.income - totals.expense),
    entryCount: totals.n,
    byCategory: byCategoryRows.map((r) => ({
      categoryId: r.category_id,
      name: r.name,
      kind: r.kind,
      icon: r.icon,
      totalCents: r.total,
      total: formatCents(r.total),
      count: r.count,
    })),
    byMonth: byMonthRows.map((r) => ({
      month: r.month,
      incomeCents: r.income,
      expenseCents: r.expense,
      balanceCents: r.income - r.expense,
      income: formatCents(r.income),
      expense: formatCents(r.expense),
      balance: formatCents(r.income - r.expense),
    })),
  }
}

/**
 * 谁欠谁多少钱。
 *
 * 只算已通过/已支付的支出账目里、尚未结清的分摊。
 * 这是"分摊"功能真正的用处：社团一起吃了饭，事后要能算清每个人该给谁转多少。
 */
export function outstandingDebts(eventId?: string): Array<{
  entryId: string
  entryTitle: string
  occurredOn: string
  userId: string
  userName: string
  amountCents: number
  amount: string
  payerId: string
  payerName: string
}> {
  const rows = getDb()
    .prepare(
      `SELECT s.entry_id, e.title, e.occurred_on, s.user_id, u.display_name AS user_name,
              s.amount_cents, e.created_by AS payer_id, p.display_name AS payer_name
         FROM ledger_splits s
         JOIN ledger_entries e ON e.id = s.entry_id
         JOIN users u ON u.id = s.user_id
         JOIN users p ON p.id = e.created_by
        WHERE s.settled = 0
          AND e.kind = 'expense'
          AND e.status IN ('approved', 'paid')
          ${eventId ? 'AND e.event_id = ?' : ''}
        ORDER BY e.occurred_on DESC`,
    )
    .all(...(eventId ? [eventId] : [])) as unknown as Array<{
    entry_id: string
    title: string
    occurred_on: string
    user_id: string
    user_name: string
    amount_cents: number
    payer_id: string
    payer_name: string
  }>

  return rows.map((r) => ({
    entryId: r.entry_id,
    entryTitle: r.title,
    occurredOn: r.occurred_on,
    userId: r.user_id,
    userName: r.user_name,
    amountCents: r.amount_cents,
    amount: formatCents(r.amount_cents),
    payerId: r.payer_id,
    payerName: r.payer_name,
  }))
}

// ---------------------------------------------------------------- 活动 / 比赛

/**
 * 活动（比赛 / 一次活动 / 其它）。
 *
 * 用户要的是"记账按一个比赛或一次活动来" —— 于是有了这一层归集。
 * 一个关键取舍：**汇总口径与总报表完全一致，只统计已通过/已支付的账目。**
 * 有人记了一笔草稿还没提交，这次比赛的支出不应该跟着变 ——
 * 否则"这次比赛花了多少"就不是一个能写进总结的定数。草稿仍然出现在逐笔明细里
 * （带状态列），只是不参与合计。
 */

export type EventKind = 'competition' | 'activity' | 'other'
export type EventStatus = 'open' | 'closed'

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  competition: '比赛',
  activity: '活动',
  other: '其它',
}

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  open: '进行中',
  closed: '已封账',
}

export interface LedgerEventView {
  id: string
  name: string
  kind: EventKind
  startOn: string | null
  endOn: string | null
  status: EventStatus
  note: string | null
  createdBy: string
  creatorName: string
  createdAt: number
  updatedAt: number
  closedAt: number | null
  closedBy: string | null
  closedByName: string | null
  /** 该活动已通过/已支付的收入合计（整数分） */
  incomeCents: number
  /** 该活动已通过/已支付的支出合计（整数分） */
  expenseCents: number
  balanceCents: number
  income: string
  expense: string
  balance: string
  /** 参与合计的账目笔数（即已通过/已支付，与收支合计同口径） */
  entryCount: number
}

const EVENT_SELECT = `
  SELECT ev.*, u.display_name AS creator_name, cu.display_name AS closed_by_name
    FROM ledger_events ev
    JOIN users u ON u.id = ev.created_by
    LEFT JOIN users cu ON cu.id = ev.closed_by
`

interface RawEvent {
  id: string
  name: string
  kind: EventKind
  start_on: string | null
  end_on: string | null
  status: EventStatus
  note: string | null
  created_by: string
  creator_name: string
  created_at: number
  updated_at: number
  closed_at: number | null
  closed_by: string | null
  closed_by_name: string | null
}

/**
 * 一次算出多个活动的收支合计。
 *
 * 刻意用一条 GROUP BY 查询而不是"每个活动查一次"：活动列表页会一次列几十个活动，
 * N+1 查询在这台 NAS 上是实打实的浪费，而且汇总口径只写一遍更不容易改歪。
 */
function eventTotals(eventIds: string[]): Map<string, { income: number; expense: number; count: number }> {
  const result = new Map<string, { income: number; expense: number; count: number }>()
  if (eventIds.length === 0) return result
  const placeholders = eventIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT event_id,
              COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense,
              COUNT(*) AS n
         FROM ledger_entries
        WHERE event_id IN (${placeholders}) AND status IN ('approved', 'paid')
        GROUP BY event_id`,
    )
    .all(...eventIds) as unknown as Array<{
    event_id: string
    income: number
    expense: number
    n: number
  }>
  for (const r of rows) {
    result.set(r.event_id, { income: r.income, expense: r.expense, count: r.n })
  }
  return result
}

function toEventView(row: RawEvent, totals: { income: number; expense: number; count: number }): LedgerEventView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    startOn: row.start_on,
    endOn: row.end_on,
    status: row.status,
    note: row.note,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedByName: row.closed_by_name,
    incomeCents: totals.income,
    expenseCents: totals.expense,
    balanceCents: totals.income - totals.expense,
    income: formatCents(totals.income),
    expense: formatCents(totals.expense),
    balance: formatCents(totals.income - totals.expense),
    entryCount: totals.count,
  }
}

/**
 * 已封账的活动是只读的：不能再往里加账目、也不能改/删里面的账目。
 * 封账不是删除，历史一条都不会少。
 * 建/改账目、审批都会调用这里做闸门；结算分摊（settleSplit）故意不设闸门 ——
 * 比赛结束后成员该还的钱仍然要能标记还清，那不影响这次活动已定稿的收支。
 */
function assertEventWritable(eventId: string | null | undefined): void {
  if (!eventId) return
  const row = getDb().prepare('SELECT id, status FROM ledger_events WHERE id = ?').get(eventId) as
    | { id: string; status: EventStatus }
    | undefined
  if (!row) throw new HttpError(404, '活动不存在')
  if (row.status === 'closed') {
    throw new HttpError(400, '该活动已封账，不能再新增或修改账目（如需调整请先解封）')
  }
}

export function getEvent(id: string): LedgerEventView | null {
  const row = getDb().prepare(`${EVENT_SELECT} WHERE ev.id = ?`).get(id) as RawEvent | undefined
  if (!row) return null
  const totals = eventTotals([id]).get(id) ?? { income: 0, expense: 0, count: 0 }
  return toEventView(row, totals)
}

export function listEvents(options: { includeClosed?: boolean } = {}): LedgerEventView[] {
  const where = options.includeClosed === false ? "WHERE ev.status = 'open'" : ''
  const rows = getDb()
    .prepare(`${EVENT_SELECT} ${where} ORDER BY (ev.status = 'closed'), ev.created_at DESC`)
    .all() as unknown as RawEvent[]
  const totals = eventTotals(rows.map((r) => r.id))
  return rows.map((r) => toEventView(r, totals.get(r.id) ?? { income: 0, expense: 0, count: 0 }))
}

function validateEventDates(startOn?: string | null, endOn?: string | null): void {
  if (startOn) assertValidDate(startOn)
  if (endOn) assertValidDate(endOn)
  if (startOn && endOn && startOn > endOn) {
    throw new HttpError(400, '结束日期不能早于开始日期')
  }
}

const EVENT_KINDS: EventKind[] = ['competition', 'activity', 'other']

export interface EventInput {
  name: string
  kind?: EventKind
  startOn?: string | null
  endOn?: string | null
  note?: string | null
}

/**
 * 建活动。
 *
 * 权限上**不限制为管理员**：活动往往是"谁张罗谁建"，
 * 卡成管理员专属只会让大家把账记到日常账里，活动归集就失去意义了。
 * 改/封账才收紧成"管理员或活动创建者"（见 updateEvent / closeEvent）。
 */
export function createEvent(userId: string, input: EventInput): LedgerEventView {
  const name = input.name.trim()
  if (!name) throw new HttpError(400, '活动名称不能为空')
  if (name.length > 60) throw new HttpError(400, '活动名称过长（最多 60 字）')
  if (input.kind && !EVENT_KINDS.includes(input.kind)) throw new HttpError(400, '活动类型不合法')
  validateEventDates(input.startOn, input.endOn)

  const id = newId('ev')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO ledger_events (id, name, kind, start_on, end_on, status, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.kind ?? 'activity',
      input.startOn ?? null,
      input.endOn ?? null,
      input.note?.trim() || null,
      userId,
      ts,
      ts,
    )
  return getEvent(id)!
}

export function updateEvent(
  id: string,
  userId: string,
  isAdmin: boolean,
  input: Partial<EventInput>,
): LedgerEventView {
  const current = getEvent(id)
  if (!current) throw new HttpError(404, '活动不存在')
  if (!isAdmin && current.createdBy !== userId) throw new HttpError(403, '只能修改自己创建的活动')

  const nextStart = input.startOn !== undefined ? input.startOn : current.startOn
  const nextEnd = input.endOn !== undefined ? input.endOn : current.endOn
  validateEventDates(nextStart, nextEnd)

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new HttpError(400, '活动名称不能为空')
    if (name.length > 60) throw new HttpError(400, '活动名称过长（最多 60 字）')
  }
  if (input.kind !== undefined && !EVENT_KINDS.includes(input.kind)) {
    throw new HttpError(400, '活动类型不合法')
  }

  const sets: string[] = []
  const params: Array<string | number | null> = []
  if (input.name !== undefined) {
    sets.push('name = ?')
    params.push(input.name.trim())
  }
  if (input.kind !== undefined) {
    sets.push('kind = ?')
    params.push(input.kind)
  }
  if (input.startOn !== undefined) {
    sets.push('start_on = ?')
    params.push(input.startOn)
  }
  if (input.endOn !== undefined) {
    sets.push('end_on = ?')
    params.push(input.endOn)
  }
  if (input.note !== undefined) {
    sets.push('note = ?')
    params.push(input.note?.trim() || null)
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?')
    params.push(now(), id)
    getDb().prepare(`UPDATE ledger_events SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  return getEvent(id)!
}

/**
 * 封账 / 解封。
 *
 * 为什么要封账：比赛结算之后，这次活动的账目不该再被改动 ——
 * "这次比赛到底花了多少"是要写进总结的定数，不能因为有人事后随手改一笔就漂移。
 * 封账**不删除任何数据**，只是把写操作关掉；需要调整时随时可以解封。
 */
export function closeEvent(id: string, userId: string, isAdmin: boolean, closed: boolean): LedgerEventView {
  const current = getEvent(id)
  if (!current) throw new HttpError(404, '活动不存在')
  if (!isAdmin && current.createdBy !== userId) throw new HttpError(403, '只能封账自己创建的活动')

  getDb()
    .prepare(
      `UPDATE ledger_events
          SET status = ?, closed_at = ?, closed_by = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(closed ? 'closed' : 'open', closed ? now() : null, closed ? userId : null, now(), id)
  return getEvent(id)!
}

/**
 * 删除活动（**仅管理员**）。
 *
 * 为什么只给管理员：活动是账目的"归属维度"，删掉它等于把一批账目的上下文
 * 抽走。建活动的人发现建错了可以改（改名/改日期/改类型），但不该有权把
 * 一个别人已经往里记过账的活动抹掉 —— 那些账不是他一个人的。
 *
 * 删除时**绝不删账目**：财务记录不能因为"活动建错了"而消失。归属它的账目
 * 退回"日常零散账目"（event_id 置 NULL），金额、状态、审批痕迹全部原样保留。
 * 于是总账的收支一分不变，只是这些账不再挂在某个活动名下。
 *
 * 返回值带上被"解除归属"的笔数，界面据此告诉用户发生了什么 —— 静默地把
 * 5 笔账从活动里摘出来，比直接报错更让人困惑。
 */
export function deleteEvent(
  id: string,
  userId: string,
  isAdmin: boolean,
): { name: string; detachedEntries: number } {
  void userId
  if (!isAdmin) throw new HttpError(403, '只有管理员能删除活动')
  const current = getEvent(id)
  if (!current) throw new HttpError(404, '活动不存在')

  return transaction(() => {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE event_id = ?')
      .get(id) as { n: number }
    // 先解绑再删行：ledger_entries.event_id 有 REFERENCES，
    // 开着 foreign_keys 时直接删会撞约束。
    getDb().prepare('UPDATE ledger_entries SET event_id = NULL WHERE event_id = ?').run(id)
    getDb().prepare('DELETE FROM ledger_events WHERE id = ?').run(id)
    return { name: current.name, detachedEntries: row.n }
  })
}

export interface EventSummary {
  event: LedgerEventView
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
    kind: 'income' | 'expense'
    icon: string | null
    totalCents: number
    total: string
    count: number
  }>
  byPerson: Array<{
    userId: string
    userName: string
    /** 这个人垫付的支出合计（他是那些支出账目的创建者/经手人） */
    paidCents: number
    paid: string
    /** 这个人应分摊的合计 */
    shareCents: number
    share: string
    /** 这个人还没结清的分摊（还欠多少） */
    owedCents: number
    owed: string
  }>
  entries: EntryView[]
}

/**
 * 按活动的完整汇总 —— 就是用户说的"快速汇总整个表格的收支明细"。
 *
 * 口径与总报表一致（只算已通过/已支付）。逐笔明细则把**你能看到的全部账目**列出来
 * （含草稿/待审批，带状态列），方便记账的人核对"还有哪些没入账"。
 * 可见范围沿用 listEntries 的规则：别人的草稿不出现。
 *
 * handedness（垫付/分摊/欠款）直接复用 ledger_splits：一笔支出里
 * created_by 是垫钱的人，splits 是每个人该承担多少，未结清的 splits 就是欠款。
 */
export function eventSummary(eventId: string, viewerId: string, isAdmin: boolean): EventSummary {
  const event = getEvent(eventId)
  if (!event) throw new HttpError(404, '活动不存在')

  const totalsRow = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense,
         COUNT(*) AS n
       FROM ledger_entries
      WHERE event_id = ? AND status IN ('approved', 'paid')`,
    )
    .get(eventId) as { income: number; expense: number; n: number }

  const byCategoryRows = getDb()
    .prepare(
      `SELECT e.category_id, COALESCE(c.name, '未分类') AS name, e.kind,
              c.icon, SUM(e.amount_cents) AS total, COUNT(*) AS count
         FROM ledger_entries e
         LEFT JOIN ledger_categories c ON c.id = e.category_id
        WHERE e.event_id = ? AND e.status IN ('approved', 'paid')
        GROUP BY e.category_id, e.kind
        ORDER BY total DESC`,
    )
    .all(eventId) as unknown as Array<{
    category_id: string | null
    name: string
    kind: 'income' | 'expense'
    icon: string | null
    total: number
    count: number
  }>

  // 垫付：谁创建的支出账目谁就是垫钱的人
  const payerRows = getDb()
    .prepare(
      `SELECT e.created_by AS user_id, u.display_name AS user_name, SUM(e.amount_cents) AS paid
         FROM ledger_entries e JOIN users u ON u.id = e.created_by
        WHERE e.event_id = ? AND e.status IN ('approved', 'paid') AND e.kind = 'expense'
        GROUP BY e.created_by`,
    )
    .all(eventId) as unknown as Array<{ user_id: string; user_name: string; paid: number }>

  // 分摊与欠款：未结清的分摊就是"还欠多少"
  const shareRows = getDb()
    .prepare(
      `SELECT s.user_id, u.display_name AS user_name, SUM(s.amount_cents) AS share,
              SUM(CASE WHEN s.settled = 0 THEN s.amount_cents ELSE 0 END) AS owed
         FROM ledger_splits s
         JOIN ledger_entries e ON e.id = s.entry_id
         JOIN users u ON u.id = s.user_id
        WHERE e.event_id = ? AND e.status IN ('approved', 'paid') AND e.kind = 'expense'
        GROUP BY s.user_id`,
    )
    .all(eventId) as unknown as Array<{ user_id: string; user_name: string; share: number; owed: number }>

  // 按人合并：垫付来自 payerRows，分摊/欠款来自 shareRows，两边的键是 user_id。
  // 同一个人可能既垫了钱又分摊了别人垫的钱，所以是合并而不是二选一。
  const persons = new Map<
    string,
    { userId: string; userName: string; paidCents: number; shareCents: number; owedCents: number }
  >()
  const person = (userId: string, userName: string) => {
    let p = persons.get(userId)
    if (!p) {
      p = { userId, userName, paidCents: 0, shareCents: 0, owedCents: 0 }
      persons.set(userId, p)
    }
    return p
  }
  for (const r of payerRows) person(r.user_id, r.user_name).paidCents = r.paid
  for (const r of shareRows) {
    const p = person(r.user_id, r.user_name)
    p.shareCents = r.share
    p.owedCents = r.owed
  }

  const { entries } = listEntries(viewerId, isAdmin, { eventId, limit: 1000 })

  return {
    event,
    incomeCents: totalsRow.income,
    expenseCents: totalsRow.expense,
    balanceCents: totalsRow.income - totalsRow.expense,
    income: formatCents(totalsRow.income),
    expense: formatCents(totalsRow.expense),
    balance: formatCents(totalsRow.income - totalsRow.expense),
    entryCount: totalsRow.n,
    byCategory: byCategoryRows.map((r) => ({
      categoryId: r.category_id,
      name: r.name,
      kind: r.kind,
      icon: r.icon,
      totalCents: r.total,
      total: formatCents(r.total),
      count: r.count,
    })),
    byPerson: [...persons.values()]
      .sort((a, b) => b.paidCents + b.shareCents - (a.paidCents + a.shareCents))
      .map((p) => ({
        userId: p.userId,
        userName: p.userName,
        paidCents: p.paidCents,
        paid: formatCents(p.paidCents),
        shareCents: p.shareCents,
        share: formatCents(p.shareCents),
        owedCents: p.owedCents,
        owed: formatCents(p.owedCents),
      })),
    entries,
  }
}

/**
 * 按活动导出 CSV。
 *
 * 与 exportCsv 一样是"忠实 dump"，含草稿/待审批，带状态列；
 * 公式注入防护与 BOM 都由调用方（路由）沿用既有做法，别漏。
 */
export function exportEventCsv(userId: string, isAdmin: boolean, eventId: string): string {
  const event = getEvent(eventId)
  if (!event) throw new HttpError(404, '活动不存在')
  // 不要在这里传 limit —— exportCsv 自己会用 EXPORT_LIMIT。
  // 上一版这里写死了 5000，而 listEntries 把上限钳在 500，于是导出少了一半还多。
  return exportCsv(userId, isAdmin, { eventId })
}

/**
 * 导出 CSV。
 *
 * 注意导出与汇总的**语义差异**，这是有意的：
 *   - 汇总（summary）只统计已通过/已支付 —— 否则"这个月花了多少"会随
 *     有人随手记一笔草稿而变，报表就不可信了。
 *   - 导出则忠实 dump 你能看到的**全部**账目（含草稿、待审批），并带上「状态」列。
 *     记账的人往往需要看到"还有哪些没审批"，静默过滤掉反而会造成
 *     "明明记了却导不出来"的困惑。可见范围仍受权限约束（别人的草稿不会出现）。
 */
export function exportCsv(userId: string, isAdmin: boolean, options: ListOptions = {}): string {
  const { entries, total } = listEntries(userId, isAdmin, { ...options, limit: EXPORT_LIMIT })

  const header = ['日期', '类型', '事由', '分类', '金额', '状态', '提交人', '审批人', '备注']
  const rows = entries.map((e) => [
    // ⚠️ 日期前面这个制表符是**故意的**，别顺手删掉（用户报过这个问题：
    // "导出的账目没有日期"）。Excel/WPS 打开 CSV 时会把 `2026-10-03` 认成日期，
    // 然后按它自己的日期格式渲染：列宽不够就整列显示成 `######`，
    // 列格式是"常规"时直接显示成 46292 这样的日期序列号 —— 用户看到的就是这两种。
    // 前缀一个制表符能让 Excel 把这格当**文本**，原样显示 2026-10-03。
    // 日期不需要参与求和，所以当文本没有代价；而且 ISO 文本本身就能正确排序。
    `\t${e.occurredOn}`,
    e.kind === 'income' ? '收入' : '支出',
    e.title,
    e.categoryName ?? '未分类',
    // 金额则相反，写纯数字（"12.50"）：**不要**给它加制表符前缀。
    // 加了会变成"带不可见制表符的文本"，在 Excel 里不能求和、复制出去还带着脏字符 ——
    // 而"能直接求和"恰恰是账目导出最重要的用途。代价值是 Excel 会按数字列
    // 显示（12.5 而不是 12.50），文件里仍是两位小数的精确值。
    // 财物模块的导出台账用的是同一套取舍（(分/100).toFixed(2) 纯数字）。
    e.amount,
    statusLabel(e.status),
    e.creatorName,
    e.deciderName ?? '',
    e.note ?? '',
  ])

  return finishCsv(header, rows, entries.length, total)
}

/**
 * 导出用的上限。
 *
 * ⚠️ 这个常量存在是因为一个曾经静默丢数据的 bug：
 * `listEntries` 里把 limit 钳死在 500，而导出路径传的是 5000 —— 于是
 * **账目超过 500 条之后，导出的 CSV 会悄悄少掉后面的**，而上面那段注释
 * 还写着"忠实 dump 你能看到的全部账目"。
 *
 * 一个社团记了两年账就会超过 500 条，而"导出的表少了行"这种事
 * 要在对账时才可能被发现。所以上限提到这里，并且下面 finishCsv
 * 会在**真的被截断时**在 CSV 末尾写一行说明，不再让它静默。
 */
export const EXPORT_LIMIT = 20_000

/**
 * 把表头与数据行拼成 CSV，并在被截断时**明说**。
 *
 * "no silent caps"：任何时候做了截断，都要让拿到结果的人看得见，
 * 否则他会以为这就是全部。
 */
export function finishCsv(
  header: string[],
  rows: Array<Array<string | number>>,
  written: number,
  total: number,
): string {
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell) => {
        const text = String(cell)
        // CSV 注入防护：以 = + - @ 开头的单元格会让 Excel 当公式执行。
        // 账目事由是用户可控内容，不改的话一个叫 "=cmd|..." 的事由就成了攻击载荷。
        const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
        return `"${safe.replace(/"/g, '""')}"`
      })
      .join(','),
  )
  if (total > written) {
    lines.push(`"# 注意：共 ${total} 条，本次只导出了前 ${written} 条。请缩小日期范围后再导。"`)
  }
  return lines.join('\r\n')
}
