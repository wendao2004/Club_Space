/**
 * 留言板。
 *
 * 用途是**收集 bug**（用户原话："大家都可以在上面留言吐槽，我主要是用来
 * 收集 bug 的"）。这个定位决定了几个取舍：
 *
 *  - 一行一条，不做楼层/回复树。收集不是讨论；讨论会跑到聊天里去，
 *    留言板要的是"一眼扫完所有待处理项"。
 *  - 不删留言，只标"已解决"。留言本身就是一个工单 —— 删掉它，"这个问题
 *    后来修没修"就没了证据。只有作者本人或管理员能删（发错了、重复了）。
 *  - 类型只有三类：bug / idea / complaint。再多就是给填写者出选择题，
 *    而留言板的门槛必须低到"打完字就能发"。
 *
 * 为什么不用聊天替代：聊天是会话结构，消息被会话成员边界切开；留言板要
 * 的是"谁都能看见同一个列表"。硬塞进聊天会让"上礼拜那个 bug 提过没有"
 * 变成翻十个会话。
 */
import { getDb, newId, now } from './db.ts'
import { HttpError } from './files.ts'

export const BOARD_KINDS = ['bug', 'idea', 'complaint'] as const
export type BoardKind = (typeof BOARD_KINDS)[number]

export const BOARD_KIND_LABELS: Record<BoardKind, string> = {
  bug: 'Bug',
  idea: '建议',
  complaint: '吐槽',
}

/** 单条留言的长度上限。够写清一个复现步骤，又不至于变成一篇文章。 */
const MAX_BODY = 800

export interface BoardPostView {
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
  /** 是不是我发的（前端据此显示"撤回"）。 */
  mine: boolean
}

const POST_SELECT = `
  SELECT p.*, a.display_name AS author_name, r.display_name AS resolved_by_name
    FROM board_posts p
    JOIN users a ON a.id = p.author_id
    LEFT JOIN users r ON r.id = p.resolved_by
`

interface RawPost {
  id: string
  author_id: string
  kind: string
  body: string
  resolved_at: number | null
  resolved_by: string | null
  resolution: string | null
  created_at: number
  author_name: string
  resolved_by_name: string | null
}

function toView(row: RawPost, viewerId: string): BoardPostView {
  return {
    id: row.id,
    kind: (BOARD_KINDS as readonly string[]).includes(row.kind) ? (row.kind as BoardKind) : 'bug',
    body: row.body,
    authorId: row.author_id,
    authorName: row.author_name,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    resolution: row.resolution,
    createdAt: row.created_at,
    mine: row.author_id === viewerId,
  }
}

export interface ListBoardOptions {
  /** 只列未解决的（默认全部）。 */
  openOnly?: boolean
  kind?: BoardKind
  limit?: number
}

/**
 * 列表。
 *
 * 全站共用一份，不做"按人过滤" —— 留言板的意义就是让大家看见彼此提过什么，
 * 避免同一个 bug 被提五遍。默认按时间倒序（最新在最上面）。
 */
export function listBoardPosts(viewerId: string, options: ListBoardOptions = {}): BoardPostView[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.openOnly) where.push('p.resolved_at IS NULL')
  if (options.kind) {
    where.push('p.kind = ?')
    params.push(options.kind)
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300)
  const sql = `${POST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY p.created_at DESC LIMIT ?`
  params.push(limit)
  const rows = getDb()
    .prepare(sql)
    .all(...params) as unknown as RawPost[]
  return rows.map((row) => toView(row, viewerId))
}

export function getBoardPost(id: string, viewerId: string): BoardPostView {
  const row = getDb().prepare(`${POST_SELECT} WHERE p.id = ?`).get(id) as RawPost | undefined
  if (!row) throw new HttpError(404, '这条留言不存在')
  return toView(row, viewerId)
}

export function createBoardPost(input: {
  authorId: string
  authorName: string
  kind: BoardKind
  body: string
}): BoardPostView {
  const body = input.body.trim()
  if (!body) throw new HttpError(400, '先写点什么再发')
  if (body.length > MAX_BODY) throw new HttpError(400, `一条留言最多 ${MAX_BODY} 字`)
  if (!(BOARD_KINDS as readonly string[]).includes(input.kind)) {
    throw new HttpError(400, '类型不合法')
  }

  const id = newId('post')
  getDb()
    .prepare('INSERT INTO board_posts (id, author_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.authorId, input.kind, body, now())
  return getBoardPost(id, input.authorId)
}

/**
 * 标记已解决 / 撤销标记（**仅管理员**）。
 *
 * 只有管理员能改状态：这个标记的语义是"官方已经处理了"，被提的人自己标
 * "已解决"会让列表失去可信度。resolution 是可选的说明（"下个版本修"、
 * "这是设计如此"）。
 */
export function resolveBoardPost(
  id: string,
  userId: string,
  isAdmin: boolean,
  resolved: boolean,
  resolution?: string | null,
): BoardPostView {
  if (!isAdmin) throw new HttpError(403, '只有管理员能标记处理状态')
  // getBoardPost 自己就会抛 404，不必再判一次（这里的 null 分支永远走不到）
  getBoardPost(id, userId)

  const note = resolution?.trim() || null
  if (note && note.length > 200) throw new HttpError(400, '处理说明最多 200 字')

  getDb()
    .prepare('UPDATE board_posts SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?')
    .run(resolved ? now() : null, resolved ? userId : null, resolved ? note : null, id)
  return getBoardPost(id, userId)
}

/**
 * 删除留言：作者本人或管理员。
 *
 * 允许作者撤回（发错了、重复提交），但管理员的"已解决"记录不因此消失 ——
 * 如果这条已经被标记过，删除会连带删掉那条工单证据。所以只有**未处理**的
 * 留言允许作者撤回；已处理的只有管理员能删（他知道自己在删什么）。
 */
export function deleteBoardPost(id: string, userId: string, isAdmin: boolean): void {
  const current = getBoardPost(id, userId)
  if (!isAdmin) {
    if (current.authorId !== userId) throw new HttpError(403, '只能撤回自己的留言')
    if (current.resolvedAt !== null) throw new HttpError(400, '这条已被管理员处理，不能撤回了')
  }
  getDb().prepare('DELETE FROM board_posts WHERE id = ?').run(id)
}
