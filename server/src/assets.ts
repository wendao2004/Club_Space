/**
 * 财物管理：社团物品台账 + 借还记录。
 *
 * ============================================================================
 * 三条设计决定，都是被社团的实际场景逼出来的
 * ============================================================================
 *
 * 1. **可用数量是算出来的，绝不存。**
 *    "这件东西现在能借几件" = 总数 − 未归还的借出数。
 *    如果存一个 available_qty 字段，它就一定会漂移：改总数忘了同步、
 *    归还时算错、并发两条借出各读到旧值……而这类不一致事后根本查不出来
 *    （账面上还有 3 件，柜子里只剩 1 件，谁都说不清是哪一步错的）。
 *    算出来的代价是一次 GROUP BY，换来的是**永远自洽**。
 *
 * 2. **借出在事务里校验可用量。**
 *    两个人同时借最后一件伞，如果先查后写、中间不加锁，两笔都会成功。
 *    所以"校验 + 写入"必须在同一个事务里，参数化更新会因此串行化。
 *
 * 3. **退役而不是删除。**
 *    一件东西坏了、丢了，它**过去**的借还记录仍然是社团的资产历史 ——
 *    硬删会把那段历史一起抹掉（外键 CASCADE），而"谁什么时候借走了什么"
 *    恰恰是这个模块存在的主要理由。所以用 status='retired' 软退役。
 */

import { getDb, newId, now, transaction } from './db.ts'
import { HttpError } from './files.ts'
import { assertValidDate, parseAmountToCents } from './ledger.ts'

// ---------------------------------------------------------------- 分类

export interface AssetCategory {
  id: string
  name: string
  icon: string | null
  sortOrder: number
  archived: boolean
  createdAt: number
}

interface RawCategory {
  id: string
  name: string
  icon: string | null
  sort_order: number
  archived: number
  created_at: number
}

function toCategory(row: RawCategory): AssetCategory {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    archived: row.archived === 1,
    createdAt: row.created_at,
  }
}

/**
 * 首次运行时塞一批常见分类。
 *
 * 空白的分类列表会让人不知道怎么用 —— 社团最容易有的就是这几类东西。
 * 只在**一条都没有**的时候播种，用户删光了也不会被硬塞回来。
 */
export function seedAssetCategories(): void {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM asset_categories').get() as { n: number }
  if (count.n > 0) return
  // 图标名必须取自 web/src/components/Icon.vue 里真实存在的那一组 ——
  // 写一个不存在的名字不会报错，只会安静地渲染成空白。
  const defaults: Array<[string, string]> = [
    ['活动器材', 'star'],
    ['电子设备', 'db'],
    ['文具耗材', 'text'],
    ['服装道具', 'users'],
    ['书籍资料', 'file'],
    ['其它', 'archive'],
  ]
  transaction(() => {
    defaults.forEach(([name, icon], index) => {
      getDb()
        .prepare(
          'INSERT INTO asset_categories (id, name, icon, sort_order, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
        )
        .run(newId('ac'), name, icon, index, now())
    })
  })
}

export function listCategories(includeArchived = false): AssetCategory[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM asset_categories
        ${includeArchived ? '' : 'WHERE archived = 0'}
        ORDER BY sort_order, name`,
    )
    .all() as unknown as RawCategory[]
  return rows.map(toCategory)
}

export function createCategory(input: { name: string; icon?: string }): AssetCategory {
  const name = input.name.trim()
  if (!name) throw new HttpError(400, '分类名不能为空')
  if (name.length > 24) throw new HttpError(400, '分类名过长（最多 24 字）')
  const exists = getDb().prepare('SELECT id FROM asset_categories WHERE name = ?').get(name)
  if (exists) throw new HttpError(409, '这个分类已经存在了')

  const id = newId('ac')
  const maxRow = getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM asset_categories')
    .get() as { m: number }
  getDb()
    .prepare(
      'INSERT INTO asset_categories (id, name, icon, sort_order, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    )
    .run(id, name, input.icon ?? null, maxRow.m + 1, now())
  return toCategory(
    getDb().prepare('SELECT * FROM asset_categories WHERE id = ?').get(id) as unknown as RawCategory,
  )
}

export function archiveCategory(id: string, archived: boolean): void {
  const row = getDb().prepare('SELECT id FROM asset_categories WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, '分类不存在')
  // 归档而不是删除：下面挂着东西的分类一旦删掉，那些东西就变成孤儿了
  getDb().prepare('UPDATE asset_categories SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

// ---------------------------------------------------------------- 物品

export type AssetCondition = 'good' | 'fair' | 'broken' | 'lost'
export type AssetStatus = 'active' | 'retired'

export const CONDITION_LABELS: Record<AssetCondition, string> = {
  good: '完好',
  fair: '有磨损',
  broken: '已损坏',
  lost: '已遗失',
}

export interface AssetLoanView {
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
  /** 未归还且已过应还日期。派生的，不存 —— 它每天都在变。 */
  overdue: boolean
  overdueDays: number
}

export interface AssetItemView {
  id: string
  code: string | null
  name: string
  categoryId: string | null
  categoryName: string | null
  totalQty: number
  /** 当前可借数量（总数 − 未归还）。 */
  availableQty: number
  /** 当前在外面的数量。 */
  onLoanQty: number
  /** 单价（分）。 */
  valueCents: number
  /** 总价值 = 单价 × 总数（分）。 */
  totalValueCents: number
  purchasedOn: string | null
  location: string | null
  condition: AssetCondition
  note: string | null
  status: AssetStatus
  createdAt: number
  updatedAt: number
}

interface RawItem {
  id: string
  code: string | null
  name: string
  category_id: string | null
  category_name: string | null
  total_qty: number
  on_loan_qty: number
  value_cents: number
  purchased_on: string | null
  location: string | null
  condition: string
  note: string | null
  status: string
  created_at: number
  updated_at: number
}

function today(): string {
  // 用本地日期而不是 UTC：社团的人看的是墙上的日历，
  // "今天到期"应该是他们那边的今天。
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/**
 * 在 YYYY-MM-DD 上加减天数（本地时区，与 today() 同源）。
 *
 * 不直接用 Date 的 toISOString：那会切到 UTC，在东八区的晚上会差一天，
 * 而"3 天内到期"差一天就是一条漏提醒。
 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((v) => Number.parseInt(v, 10))
  const dt = new Date(y!, m! - 1, d!)
  dt.setDate(dt.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

/**
 * 「即将到期」的窗口天数。
 *
 * 与待办接口、借还列表的 dueWithin 参数共用同一个常量：角标写 3、点进去
 * 列表按 2 天筛，比一个坏按钮更让人困惑。
 */
export const DUE_SOON_DAYS = 3

function toItem(row: RawItem): AssetItemView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    totalQty: row.total_qty,
    availableQty: Math.max(0, row.total_qty - row.on_loan_qty),
    onLoanQty: row.on_loan_qty,
    valueCents: row.value_cents,
    totalValueCents: row.value_cents * row.total_qty,
    purchasedOn: row.purchased_on,
    location: row.location,
    condition: row.condition as AssetCondition,
    note: row.note,
    status: row.status as AssetStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 物品列表查询。
 *
 * 借出数量用**一个 LEFT JOIN + GROUP BY** 一次算出来，而不是每件物品再查一次 ——
 * 后者在物品多起来之后就是典型的 N+1，几十件就开始卡。
 * 注意 JOIN 的条件里必须带 `returned_at IS NULL AND voided_at IS NULL`，
 * 否则已归还的、已作废的也会被算进"在外"。
 */
const ITEM_SELECT = `
  SELECT i.*, c.name AS category_name,
         COALESCE(l.out_qty, 0) AS on_loan_qty
    FROM asset_items i
    LEFT JOIN asset_categories c ON c.id = i.category_id
    LEFT JOIN (
      SELECT item_id, SUM(qty) AS out_qty
        FROM asset_loans
       WHERE returned_at IS NULL AND voided_at IS NULL
       GROUP BY item_id
    ) l ON l.item_id = i.id
`

export interface ItemQuery {
  categoryId?: string
  q?: string
  status?: AssetStatus
  /** 只看还有得借的。 */
  onlyAvailable?: boolean
  /** 只看外借中的。 */
  onlyOnLoan?: boolean
}

export function listItems(options: ItemQuery = {}): AssetItemView[] {
  const where: string[] = []
  const params: Array<string | number> = []

  if (options.status) {
    where.push('i.status = ?')
    params.push(options.status)
  }
  if (options.categoryId) {
    where.push('i.category_id = ?')
    params.push(options.categoryId)
  }
  if (options.q?.trim()) {
    // 名称、编号、存放位置、备注都搜 —— 找东西的时候没人记得自己当初填在哪一栏
    where.push('(i.name LIKE ? OR i.code LIKE ? OR i.location LIKE ? OR i.note LIKE ?)')
    const like = `%${options.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    params.push(like, like, like, like)
  }
  if (options.onlyAvailable) where.push('(i.total_qty - COALESCE(l.out_qty, 0)) > 0')
  if (options.onlyOnLoan) where.push('COALESCE(l.out_qty, 0) > 0')

  const rows = getDb()
    .prepare(
      `${ITEM_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.status, c.sort_order, i.name`,
    )
    .all(...params) as unknown as RawItem[]
  return rows.map(toItem)
}

export function getItem(id: string): AssetItemView | null {
  const row = getDb().prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as unknown as RawItem | undefined
  return row ? toItem(row) : null
}

export interface ItemInput {
  name: string
  code?: string
  categoryId?: string | null
  totalQty?: number
  /** 单价。接受 "12.50" 这样的字符串，内部转成整数分。 */
  value?: string | number
  purchasedOn?: string
  location?: string
  condition?: AssetCondition
  note?: string
}

function normalizeQty(input: number | undefined): number {
  const qty = input ?? 1
  if (!Number.isInteger(qty) || qty < 0) throw new HttpError(400, '数量必须是非负整数')
  if (qty > 100_000) throw new HttpError(400, '数量过大')
  return qty
}

export function createItem(userId: string, input: ItemInput): AssetItemView {
  const name = input.name?.trim()
  if (!name) throw new HttpError(400, '物品名称不能为空')
  if (name.length > 60) throw new HttpError(400, '物品名称过长（最多 60 字）')

  const totalQty = normalizeQty(input.totalQty)
  const valueCents = input.value === undefined || input.value === '' ? 0 : parseAmountToCents(input.value)
  if (input.categoryId) {
    const cat = getDb().prepare('SELECT id FROM asset_categories WHERE id = ?').get(input.categoryId)
    if (!cat) throw new HttpError(400, '分类不存在')
  }
  if (input.purchasedOn) assertValidDate(input.purchasedOn)
  if (input.code?.trim()) {
    const dup = getDb().prepare('SELECT id FROM asset_items WHERE code = ?').get(input.code.trim())
    if (dup) throw new HttpError(409, '这个编号已经被占用了')
  }

  const id = newId('as')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO asset_items
         (id, code, name, category_id, total_qty, value_cents, purchased_on,
          location, condition, note, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      id,
      input.code?.trim() || null,
      name,
      input.categoryId || null,
      totalQty,
      valueCents,
      input.purchasedOn || null,
      input.location?.trim() || null,
      input.condition ?? 'good',
      input.note?.trim() || null,
      userId,
      ts,
      ts,
    )
  return getItem(id)!
}

export function updateItem(id: string, input: Partial<ItemInput>): AssetItemView {
  const existing = getItem(id)
  if (!existing) throw new HttpError(404, '物品不存在')

  const sets: string[] = []
  const params: Array<string | number | null> = []
  const push = (col: string, value: string | number | null) => {
    sets.push(`${col} = ?`)
    params.push(value)
  }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new HttpError(400, '物品名称不能为空')
    push('name', name)
  }
  if (input.code !== undefined) {
    const code = input.code.trim() || null
    if (code) {
      const dup = getDb().prepare('SELECT id FROM asset_items WHERE code = ? AND id <> ?').get(code, id)
      if (dup) throw new HttpError(409, '这个编号已经被占用了')
    }
    push('code', code)
  }
  if (input.categoryId !== undefined) push('category_id', input.categoryId || null)
  if (input.totalQty !== undefined) {
    const qty = normalizeQty(input.totalQty)
    // 总数不能改到比"已经借出去的"还少 —— 否则可用量算出来是负数，
    // 界面会显示成 0 而实际外面还漂着东西，两边对不上。
    if (qty < existing.onLoanQty) {
      throw new HttpError(400, `现在还有 ${existing.onLoanQty} 件在外面，总数不能改成比它更少`)
    }
    push('total_qty', qty)
  }
  if (input.value !== undefined) {
    push('value_cents', input.value === '' ? 0 : parseAmountToCents(input.value))
  }
  if (input.purchasedOn !== undefined) {
    if (input.purchasedOn) assertValidDate(input.purchasedOn)
    push('purchased_on', input.purchasedOn || null)
  }
  if (input.location !== undefined) push('location', input.location.trim() || null)
  if (input.condition !== undefined) push('condition', input.condition)
  if (input.note !== undefined) push('note', input.note.trim() || null)

  if (sets.length === 0) return existing
  push('updated_at', now())
  params.push(id)
  getDb().prepare(`UPDATE asset_items SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getItem(id)!
}

/**
 * 退役 / 恢复。
 *
 * 不提供硬删除接口 —— 一件东西被删掉之后，它借出过的历史会跟着一起消失，
 * 而"上个月那顶帐篷是谁借走弄丢的"正是要查的东西。
 */
export function retireItem(id: string, retired: boolean): AssetItemView {
  const existing = getItem(id)
  if (!existing) throw new HttpError(404, '物品不存在')
  if (!retired && existing.status !== 'retired') return existing
  if (retired && existing.onLoanQty > 0) {
    throw new HttpError(400, `还有 ${existing.onLoanQty} 件在外面没还，先把它们收回来再退役`)
  }
  getDb()
    .prepare('UPDATE asset_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(retired ? 'retired' : 'active', now(), id)
  return getItem(id)!
}

// ---------------------------------------------------------------- 借还

export interface LoanInput {
  itemId: string
  qty?: number
  /** 代谁借（默认是自己）。社团里很常见"我帮室友借一把伞"。 */
  borrowerId?: string
  dueOn?: string
  purpose?: string
  note?: string
}

/**
 * 借出。
 *
 * ⚠️ 校验可用量与写入必须在**同一个事务**里。
 * 两个人同时借最后一件东西时，如果先查后写中间留了空隙，
 * 两笔都会通过校验、都会写进去，账面上超借了 —— 而柜子里根本没有那么多。
 * 参数化的 UPDATE ... WHERE 会在事务里串行化，这正是我们要的。
 */
export function lendItem(actorId: string, input: LoanInput): AssetLoanView {
  const item = getItem(input.itemId)
  if (!item) throw new HttpError(404, '物品不存在')
  if (item.status === 'retired') throw new HttpError(400, `「${item.name}」已经退役，不能再借出`)

  const qty = input.qty ?? 1
  if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, '借出数量必须是正整数')
  if (input.dueOn) assertValidDate(input.dueOn)

  const borrowerId = input.borrowerId ?? actorId
  const borrower = getDb()
    .prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
    .get(borrowerId)
  if (!borrower) throw new HttpError(400, '借用人不存在或已停用')

  const loanId = newId('al')
  const ts = now()

  transaction(() => {
    // 在事务里重新读一次可用量 —— 不能用上面那个 item 的快照，
    // 它可能是几百毫秒之前读的，中间已经有人借走了。
    const outRow = getDb()
      .prepare(
        'SELECT COALESCE(SUM(qty), 0) AS out FROM asset_loans WHERE item_id = ? AND returned_at IS NULL AND voided_at IS NULL',
      )
      .get(input.itemId) as { out: number }
    const fresh = getDb()
      .prepare('SELECT total_qty FROM asset_items WHERE id = ?')
      .get(input.itemId) as { total_qty: number }
    const available = fresh.total_qty - outRow.out
    if (available < qty) {
      throw new HttpError(
        409,
        available <= 0
          ? `「${item.name}」现在全在外面没有余量`
          : `「${item.name}」现在只剩 ${available} 件可借，你要借 ${qty} 件`,
      )
    }
    getDb()
      .prepare(
        `INSERT INTO asset_loans
           (id, item_id, qty, borrower_id, lent_at, due_on, purpose, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        loanId,
        input.itemId,
        qty,
        borrowerId,
        ts,
        input.dueOn || null,
        input.purpose?.trim() || null,
        input.note?.trim() || null,
        ts,
        ts,
      )
  })

  return getLoan(loanId)!
}

export interface ReturnInput {
  condition?: AssetCondition
  note?: string
}

/**
 * 归还。
 *
 * 这里**不限制必须是借用人自己**：社团里替人还东西太常见了（"他先走了，我帮他带回来"），
 * 强制本人操作只会让记录失真（大家会干脆不记）。所以谁都能点归还，
 * 但 returned_by 会如实记下是谁操作的，审计日志里查得到。
 */
export function returnLoan(loanId: string, actorId: string, input: ReturnInput = {}): AssetLoanView {
  const loan = getDb()
    .prepare('SELECT id, item_id, returned_at, voided_at FROM asset_loans WHERE id = ?')
    .get(loanId) as { id: string; item_id: string; returned_at: number | null; voided_at: number | null } | undefined
  if (!loan) throw new HttpError(404, '借出记录不存在')
  if (loan.voided_at) throw new HttpError(409, '这条借出记录已作废，不能归还')
  if (loan.returned_at) throw new HttpError(409, '这件东西已经还过了')

  getDb()
    .prepare(
      `UPDATE asset_loans
          SET returned_at = ?, returned_by = ?, return_condition = ?, note = COALESCE(?, note), updated_at = ?
        WHERE id = ?`,
    )
    .run(now(), actorId, input.condition ?? null, input.note?.trim() || null, now(), loanId)

  // 归还时如果报告损坏/遗失，顺手把物品本身的状态也改掉 ——
  // 否则台账上它还写着"完好"，下一个人借走才发现是坏的。
  if (input.condition === 'broken' || input.condition === 'lost') {
    getDb()
      .prepare('UPDATE asset_items SET condition = ?, updated_at = ? WHERE id = ?')
      .run(input.condition, now(), loan.item_id)
  }
  return getLoan(loanId)!
}

export interface LoanPatch {
  qty?: number
  borrowerId?: string
  dueOn?: string | null
  purpose?: string | null
  note?: string | null
}

/**
 * 更正一条借还记录（管理员）。
 *
 * 借错人 / 借错数量 / 记错日期之后，唯一能"更正"的办法不再是把错的还掉 ——
 * 那会污染可用量与历史。这里允许直接改借用人、数量、应还日期、用途、备注。
 *
 * ⚠️ 改了数量就得重新过一遍可用量校验，而且要和写入放在**同一个事务**里，
 * 理由与 lendItem 相同（先查后写之间留缝就会超借）。
 * 校验时要把"这条记录自己"排除在外 —— 它本来就占着额度。
 */
export function updateLoan(loanId: string, patch: LoanPatch): AssetLoanView {
  const row = getDb()
    .prepare('SELECT id, item_id, qty, returned_at, voided_at FROM asset_loans WHERE id = ?')
    .get(loanId) as
    | { id: string; item_id: string; qty: number; returned_at: number | null; voided_at: number | null }
    | undefined
  if (!row) throw new HttpError(404, '借出记录不存在')
  if (row.voided_at) throw new HttpError(409, '这条借出记录已作废，不能再修改')

  if (patch.qty !== undefined) {
    if (!Number.isInteger(patch.qty) || patch.qty <= 0) throw new HttpError(400, '借出数量必须是正整数')
  }
  if (patch.dueOn) assertValidDate(patch.dueOn)

  if (patch.borrowerId !== undefined && patch.borrowerId !== null) {
    const borrower = getDb()
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
      .get(patch.borrowerId)
    if (!borrower) throw new HttpError(400, '借用人不存在或已停用')
  }

  const ts = now()
  transaction(() => {
    // 数量变大时要挡超借。已归还的记录不占额度，不必校验。
    if (patch.qty !== undefined && row.returned_at === null) {
      const outRow = getDb()
        .prepare(
          `SELECT COALESCE(SUM(qty), 0) AS out FROM asset_loans
            WHERE item_id = ? AND returned_at IS NULL AND voided_at IS NULL AND id != ?`,
        )
        .get(row.item_id, loanId) as { out: number }
      const fresh = getDb()
        .prepare('SELECT total_qty FROM asset_items WHERE id = ?')
        .get(row.item_id) as { total_qty: number }
      const available = fresh.total_qty - outRow.out
      if (available < patch.qty) {
        throw new HttpError(409, `改完之后会超借：这件物品最多还剩 ${available} 件可在外`)
      }
    }

    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (patch.qty !== undefined) {
      sets.push('qty = ?')
      params.push(patch.qty)
    }
    if (patch.borrowerId !== undefined) {
      sets.push('borrower_id = ?')
      params.push(patch.borrowerId)
    }
    if (patch.dueOn !== undefined) {
      sets.push('due_on = ?')
      params.push(patch.dueOn || null)
    }
    if (patch.purpose !== undefined) {
      sets.push('purpose = ?')
      params.push(patch.purpose?.trim() || null)
    }
    if (patch.note !== undefined) {
      sets.push('note = ?')
      params.push(patch.note?.trim() || null)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(ts)
    getDb()
      .prepare(`UPDATE asset_loans SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, loanId)
  })

  return getLoan(loanId)!
}

/**
 * 作废一条借还记录（管理员）。
 *
 * 用"作废"而不是删除：借还历史是这模块存在的主要理由，硬删会连带抹掉
 * "谁在什么时候记过一笔、谁把它抹了"这条痕迹。作废后账面不再把它算作在外，
 * 界面上标记为"已作废"，原始字段一条不动。
 */
export function voidLoan(loanId: string, actorId: string): AssetLoanView {
  const row = getDb()
    .prepare('SELECT id, voided_at FROM asset_loans WHERE id = ?')
    .get(loanId) as { id: string; voided_at: number | null } | undefined
  if (!row) throw new HttpError(404, '借出记录不存在')
  if (row.voided_at) throw new HttpError(409, '这条借出记录已经作废过了')
  getDb()
    .prepare('UPDATE asset_loans SET voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?')
    .run(now(), actorId, now(), loanId)
  return getLoan(loanId)!
}

/**
 * 恢复一条被作废的借还记录（管理员）。
 *
 * 作废是"记错了，这笔不算"的软删除；管理员点错了或者对方又把东西还回来时，
 * 需要一条反悔的路。恢复前必须重新过一遍账面校验：作废期间物品可能被退役、
 * 总数也可能被调小，直接恢复会让"在外数量"超过总数 —— 那正是这个模块
 * 最不该出现的状态。
 *
 * 已归还的记录恢复后仍然算"已归还"（不占用可用量），不需要再校验数量。
 */
export function restoreLoan(loanId: string, actorId: string): AssetLoanView {
  return transaction(() => {
    const row = getDb()
      .prepare(
        `SELECT l.item_id, l.qty, l.returned_at, l.voided_at, i.total_qty, i.status
           FROM asset_loans l
           JOIN asset_items i ON i.id = l.item_id
          WHERE l.id = ?`,
      )
      .get(loanId) as
      | {
          item_id: string
          qty: number
          returned_at: number | null
          voided_at: number | null
          total_qty: number
          status: string
        }
      | undefined
    if (!row) throw new HttpError(404, '借出记录不存在')
    if (!row.voided_at) throw new HttpError(409, '这条记录没有被作废')

    if (!row.returned_at) {
      if (row.status !== 'active') {
        throw new HttpError(409, '物品已退役，恢复这条记录前请先恢复物品')
      }
      const onLoan = getDb()
        .prepare(
          `SELECT COALESCE(SUM(qty), 0) AS n FROM asset_loans
            WHERE item_id = ? AND returned_at IS NULL AND voided_at IS NULL`,
        )
        .get(row.item_id) as { n: number }
      if (onLoan.n + row.qty > row.total_qty) {
        throw new HttpError(
          409,
          `恢复后外借数量会超过总数（现在在外 ${onLoan.n} 件，共 ${row.total_qty} 件）`,
        )
      }
    }

    getDb()
      .prepare('UPDATE asset_loans SET voided_at = NULL, voided_by = NULL, updated_at = ? WHERE id = ?')
      .run(now(), loanId)
    return getLoan(loanId)!
  })
}

const LOAN_SELECT = `
  SELECT l.*, i.name AS item_name,
         b.display_name AS borrower_name,
         r.display_name AS returned_by_name,
         v.display_name AS voided_by_name
    FROM asset_loans l
    JOIN asset_items i ON i.id = l.item_id
    JOIN users b ON b.id = l.borrower_id
    LEFT JOIN users r ON r.id = l.returned_by
    LEFT JOIN users v ON v.id = l.voided_by
`

interface RawLoan {
  id: string
  item_id: string
  item_name: string
  qty: number
  borrower_id: string
  borrower_name: string
  lent_at: number
  due_on: string | null
  returned_at: number | null
  returned_by_name: string | null
  return_condition: string | null
  purpose: string | null
  note: string | null
  voided_at: number | null
  voided_by_name: string | null
}

function toLoan(row: RawLoan): AssetLoanView {
  const t = today()
  // 逾期是**派生**的，不存字段：它每天都在变，存下来就一定会有一批数据是过期的
  const overdue = row.voided_at === null && row.returned_at === null && !!row.due_on && row.due_on < t
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    qty: row.qty,
    borrowerId: row.borrower_id,
    borrowerName: row.borrower_name,
    lentAt: row.lent_at,
    dueOn: row.due_on,
    returnedAt: row.returned_at,
    returnedByName: row.returned_by_name,
    returnCondition: (row.return_condition as AssetCondition | null) ?? null,
    purpose: row.purpose,
    note: row.note,
    voidedAt: row.voided_at,
    voidedByName: row.voided_by_name,
    overdue,
    overdueDays: overdue && row.due_on ? daysBetween(row.due_on, t) : 0,
  }
}

export function getLoan(id: string): AssetLoanView | null {
  const row = getDb().prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id) as unknown as RawLoan | undefined
  return row ? toLoan(row) : null
}

export interface LoanQuery {
  itemId?: string
  borrowerId?: string
  /** 物品名称/编号、借用人、用途的模糊搜索。 */
  q?: string
  /** 只看还没还的。 */
  open?: boolean
  /** 只看逾期的。 */
  overdue?: boolean
  /**
   * 只看「N 天内到期、且还没逾期」的（未归还、未作废、应还日期 >= 今天）。
   * 默认窗口见 DUE_SOON_DAYS；单独做成参数是为了让待办角标和列表筛选能对上。
   */
  dueWithin?: number
  limit?: number
}

/**
 * 借还记录的筛选条件 → WHERE 片段。
 *
 * ⚠️ 列表、计数、待办三处共用。逾期/未归还的判定只写一遍 ——
 * 角标的口径和列表一旦分叉，用户点进去就会发现数量对不上。
 */
function loanWhere(options: LoanQuery): { whereSql: string; params: Array<string | number> } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.itemId) {
    where.push('l.item_id = ?')
    params.push(options.itemId)
  }
  if (options.borrowerId) {
    where.push('l.borrower_id = ?')
    params.push(options.borrowerId)
  }
  if (options.q) {
    // LIKE 通配符要转义，否则一个 "%" 就能把整本借还记录捞出来
    const term = `%${options.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    where.push(
      `(i.name LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\' OR b.display_name LIKE ? ESCAPE '\\' OR l.purpose LIKE ? ESCAPE '\\')`,
    )
    params.push(term, term, term, term)
  }
  if (options.open) where.push('l.returned_at IS NULL AND l.voided_at IS NULL')
  if (options.overdue) {
    // 逾期 = 没还（且没作废） 且 应还日期早于今天。字符串比较即可，YYYY-MM-DD 是按字典序排列的。
    // 「刚好今天到期」不算逾期（严格小于），它落在下面的"即将到期"里。
    where.push('l.returned_at IS NULL AND l.voided_at IS NULL AND l.due_on IS NOT NULL AND l.due_on < ?')
    params.push(today())
  }
  if (options.dueWithin !== undefined) {
    const days = Math.max(0, Math.min(365, Math.trunc(options.dueWithin)))
    where.push(
      'l.returned_at IS NULL AND l.voided_at IS NULL AND l.due_on IS NOT NULL AND l.due_on >= ? AND l.due_on <= ?',
    )
    params.push(today(), addDays(today(), days))
  }
  return { whereSql: where.join(' AND '), params }
}

export function listLoans(options: LoanQuery = {}): AssetLoanView[] {
  const { whereSql, params } = loanWhere(options)
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  params.push(limit)

  const rows = getDb()
    .prepare(
      `${LOAN_SELECT}
       ${whereSql ? `WHERE ${whereSql}` : ''}
       ORDER BY (l.returned_at IS NULL) DESC, l.due_on IS NOT NULL AND l.due_on < '${today()}' DESC, l.lent_at DESC
       LIMIT ?`,
    )
    .all(...params) as unknown as RawLoan[]
  return rows.map(toLoan)
}

/** 按同样的筛选条件数条数（待办角标用；不拉行）。 */
export function countLoans(options: LoanQuery = {}): number {
  const { whereSql, params } = loanWhere(options)
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n
           FROM asset_loans l
           JOIN asset_items i ON i.id = l.item_id
           JOIN users b ON b.id = l.borrower_id
          ${whereSql ? `WHERE ${whereSql}` : ''}`,
      )
      .get(...params) as { n: number }
  ).n
}

/** 借还记录里最多带多少个待办 id。 */
export const LOAN_TODO_ID_LIMIT = 20

/** 按同样条件取前几条 id，顺序与 listLoans 的前几条一致。 */
export function listLoanIds(options: LoanQuery = {}, limit = LOAN_TODO_ID_LIMIT): string[] {
  const { whereSql, params } = loanWhere(options)
  const rows = getDb()
    .prepare(
      `${LOAN_SELECT}
       ${whereSql ? `WHERE ${whereSql}` : ''}
       ORDER BY (l.returned_at IS NULL) DESC, l.due_on IS NOT NULL AND l.due_on < '${today()}' DESC, l.lent_at DESC
       LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 200))) as unknown as RawLoan[]
  return rows.map((r) => r.id)
}

export interface AssetTodoBucket {
  count: number
  ids: string[]
}

export interface AssetTodo {
  /** 我借的、未还、已逾期 */
  overdue: AssetTodoBucket
  /** 我借的、未还、DUE_SOON_DAYS 天内到期（不含已逾期） */
  dueSoon: AssetTodoBucket
  dueSoonDays: number
}

/**
 * 财物待办（只算"我借的"，不替管理员操心别人的逾期）。
 *
 * 口径逐条对应列表筛选条件（GET /api/assets/loans）：
 *   - overdue == `?mine=1&overdue=1`
 *   - dueSoon == `?mine=1&dueWithin=3`
 *
 * 为什么不做"全社团逾期"的角标：那是管理视角的统计（/api/assets/summary
 * 已经有 overdueLoans），而这里要回答的是"**我**该做什么"。
 */
export function assetTodo(userId: string): AssetTodo {
  const overdue = { borrowerId: userId, overdue: true }
  const dueSoon = { borrowerId: userId, dueWithin: DUE_SOON_DAYS }
  return {
    overdue: { count: countLoans(overdue), ids: listLoanIds(overdue) },
    dueSoon: { count: countLoans(dueSoon), ids: listLoanIds(dueSoon) },
    dueSoonDays: DUE_SOON_DAYS,
  }
}

// ---------------------------------------------------------------- 汇总

export interface AssetSummary {
  itemCount: number
  totalQty: number
  onLoanQty: number
  availableQty: number
  totalValueCents: number
  openLoans: number
  overdueLoans: number
  byCategory: Array<{ categoryId: string | null; categoryName: string; itemCount: number; totalValueCents: number }>
}

export function summary(): AssetSummary {
  const items = listItems()
  const openLoans = listLoans({ open: true, limit: 1000 })
  const t = today()
  const overdueLoans = openLoans.filter((l) => l.overdue)

  const byCat = new Map<string | null, { name: string; itemCount: number; value: number }>()
  for (const item of items) {
    if (item.status !== 'active') continue
    const key = item.categoryId
    const entry = byCat.get(key) ?? { name: item.categoryName ?? '未分类', itemCount: 0, value: 0 }
    entry.itemCount += 1
    entry.value += item.totalValueCents
    byCat.set(key, entry)
  }

  return {
    itemCount: items.filter((i) => i.status === 'active').length,
    totalQty: items.filter((i) => i.status === 'active').reduce((s, i) => s + i.totalQty, 0),
    onLoanQty: items.reduce((s, i) => s + i.onLoanQty, 0),
    availableQty: items.filter((i) => i.status === 'active').reduce((s, i) => s + i.availableQty, 0),
    totalValueCents: items.filter((i) => i.status === 'active').reduce((s, i) => s + i.totalValueCents, 0),
    openLoans: openLoans.length,
    overdueLoans: overdueLoans.length,
    byCategory: [...byCat.entries()]
      .map(([categoryId, v]) => ({
        categoryId,
        categoryName: v.name,
        itemCount: v.itemCount,
        totalValueCents: v.value,
      }))
      .sort((a, b) => b.totalValueCents - a.totalValueCents),
  }
}

/** 逾期清单（未还 + 已过期），按逾期天数从多到少。界面首页拿它做提醒。 */
export function overdueLoans(): AssetLoanView[] {
  return listLoans({ overdue: true, limit: 1000 }).sort((a, b) => b.overdueDays - a.overdueDays)
}

// ---------------------------------------------------------------- 导出

/** CSV 里的公式注入防护：以这些字符开头的单元格会被 Excel 当公式执行。 */
function csvCell(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export function exportItemsCsv(): string {
  const header = ['编号', '名称', '分类', '总数', '可借', '在外', '单价(元)', '总价(元)', '购入日期', '存放位置', '状态', '备注']
  const lines = [header.map(csvCell).join(',')]
  for (const item of listItems({ status: 'active' })) {
    lines.push(
      [
        item.code,
        item.name,
        item.categoryName,
        item.totalQty,
        item.availableQty,
        item.onLoanQty,
        (item.valueCents / 100).toFixed(2),
        (item.totalValueCents / 100).toFixed(2),
        item.purchasedOn,
        item.location,
        CONDITION_LABELS[item.condition],
        item.note,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\r\n')
}

export function exportLoansCsv(): string {
  const header = ['物品', '数量', '借用人', '借出时间', '应还日期', '归还时间', '归还人', '归还状态', '用途', '备注']
  const fmt = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : '')
  const lines = [header.map(csvCell).join(',')]
  for (const loan of listLoans({ limit: 1000 })) {
    lines.push(
      [
        loan.itemName,
        loan.qty,
        loan.borrowerName,
        fmt(loan.lentAt),
        loan.dueOn,
        fmt(loan.returnedAt),
        loan.returnedByName,
        loan.returnCondition ? CONDITION_LABELS[loan.returnCondition] : '',
        loan.purpose,
        loan.note,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\r\n')
}
