/**
 * 投票 / 约时间。
 *
 * 社团排活动时间、决定团建去哪儿的刚需。设计取舍：
 *
 *  - **实名投票，结果全透明**。社团内部没有"匿名保护举报人"这种需求，
 *    反倒是"谁投了什么"能帮创建者看出谁还没表态 —— 点名去催比看冷冰冰的
 *    计数有用得多。
 *  - **改票自由**（截止/关闭前）。约时间的本质是"等大家都方便"，改主意
 *    是常态，锁死改票只会逼人删了重投、污染列表。
 *  - 选项存 JSON 数组而不是单独的表：选项永远跟着投票走，没有自己的
 *    生命周期，拆表只多一次 JOIN（见 db.ts v15 的注释）。
 *  - 截止（deadline_at）与手动关闭（closed_at）是两回事：前者到点自动
 *    不能投，后者是创建者的"就现在定稿"。重开 = 清掉 closed_at。
 */
import { getDb, newId, now } from './db.ts'
import { HttpError } from './files.ts'

const MAX_TITLE = 100
const MAX_DESCRIPTION = 500
const MAX_OPTIONS = 20
const MAX_OPTION_TEXT = 60

export interface PollOptionResult {
  idx: number
  text: string
  count: number
  voters: Array<{ id: string; name: string }>
}

export interface PollView {
  id: string
  title: string
  description: string
  multi: boolean
  /** 选项与实时结果。 */
  options: PollOptionResult[]
  /** 有多少人来投过（不是总票数 —— 多选时票数 > 人数）。 */
  totalVoters: number
  creatorId: string
  creatorName: string
  createdAt: number
  deadlineAt: number | null
  closedAt: number | null
  /** 对当前查看者：能不能改/关（创建者或管理员）。 */
  canManage: boolean
  /** 当前查看者的票（选项下标）。 */
  myVotes: number[]
}

interface RawPoll {
  id: string
  creator_id: string
  title: string
  description: string
  multi: number
  options: string
  deadline_at: number | null
  closed_at: number | null
  created_at: number
  creator_name: string
}

interface RawVote {
  user_id: string
  option_idx: number
  voted_at: number
  display_name: string
}

function parseOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : []
  } catch {
    return []
  }
}

/**
 * 是否已不可投票。deadline 用"读的那一刻"判断 —— 不需要定时器去把投票
 * 标记成"已截止"，一个比较就够了（列表排序时同理）。
 */
export function isVotingClosed(poll: { closedAt: number | null; deadlineAt: number | null }): boolean {
  if (poll.closedAt !== null) return true
  return poll.deadlineAt !== null && now() >= poll.deadlineAt
}

function toView(row: RawPoll, viewerId: string, isAdmin: boolean): PollView {
  const texts = parseOptions(row.options)
  const votes = getDb()
    .prepare(
      `SELECT v.user_id, v.option_idx, v.voted_at, u.display_name
         FROM poll_votes v JOIN users u ON u.id = v.user_id
        WHERE v.poll_id = ? ORDER BY v.voted_at ASC`,
    )
    .all(row.id) as unknown as RawVote[]

  const byOption: PollOptionResult[] = texts.map((text, idx) => ({
    idx,
    text,
    count: 0,
    voters: [],
  }))
  for (const v of votes) {
    const slot = byOption[v.option_idx]
    if (slot) {
      slot.count += 1
      slot.voters.push({ id: v.user_id, name: v.display_name })
    }
  }

  const myVotes = [...new Set(votes.filter((v) => v.user_id === viewerId).map((v) => v.option_idx))]

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    multi: row.multi === 1,
    options: byOption,
    totalVoters: new Set(votes.map((v) => v.user_id)).size,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    closedAt: row.closed_at,
    canManage: row.creator_id === viewerId || isAdmin,
    myVotes,
  }
}

const POLL_SELECT = `
  SELECT p.*, u.display_name AS creator_name
    FROM polls p JOIN users u ON u.id = p.creator_id
`

export function getPoll(id: string, viewerId: string, isAdmin: boolean): PollView {
  const row = getDb().prepare(`${POLL_SELECT} WHERE p.id = ?`).get(id) as RawPoll | undefined
  if (!row) throw new HttpError(404, '这个投票不存在')
  return toView(row, viewerId, isAdmin)
}

export interface ListPollsOptions {
  /** 只看还没截止/未关闭的（默认全部，进行中的排前面）。 */
  openOnly?: boolean
  limit?: number
}

export function listPolls(viewerId: string, isAdmin: boolean, options: ListPollsOptions = {}): PollView[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const rows = getDb()
    .prepare(`${POLL_SELECT} ORDER BY p.created_at DESC LIMIT ?`)
    .all(limit) as unknown as RawPoll[]
  const views = rows.map((row) => toView(row, viewerId, isAdmin))
  if (!options.openOnly) return views
  return views.filter((p) => !isVotingClosed({ closedAt: p.closedAt, deadlineAt: p.deadlineAt }))
}

export interface CreatePollInput {
  creatorId: string
  title: string
  description?: string
  multi?: boolean
  options: string[]
  /** 相对时长（毫秒）或 null = 不限时。 */
  deadlineInMs?: number | null
}

export function createPoll(input: CreatePollInput): PollView {
  const title = input.title.trim()
  if (!title) throw new HttpError(400, '先给投票起个标题')
  if (title.length > MAX_TITLE) throw new HttpError(400, `标题最多 ${MAX_TITLE} 字`)
  const description = (input.description ?? '').trim()
  if (description.length > MAX_DESCRIPTION) throw new HttpError(400, `说明最多 ${MAX_DESCRIPTION} 字`)

  // 选项去重保序：同样的选项出现两次只会让人困惑，结果也会算重
  const seen = new Set<string>()
  const options: string[] = []
  for (const raw of input.options) {
    const text = raw.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    options.push(text)
  }
  if (options.length < 2) throw new HttpError(400, '至少要两个不同的选项')
  if (options.length > MAX_OPTIONS) throw new HttpError(400, `最多 ${MAX_OPTIONS} 个选项`)
  if (options.some((o) => o.length > MAX_OPTION_TEXT)) {
    throw new HttpError(400, `单个选项最多 ${MAX_OPTION_TEXT} 字`)
  }

  const deadlineInMs = input.deadlineInMs ?? null
  if (deadlineInMs !== null && (!Number.isFinite(deadlineInMs) || deadlineInMs < 60_000)) {
    // 下限 1 分钟：更短的"截止"只会是填错的数字
    throw new HttpError(400, '截止时间至少要 1 分钟以后')
  }

  const id = newId('poll')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO polls (id, creator_id, title, description, multi, options, deadline_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.creatorId,
      title,
      description,
      input.multi ? 1 : 0,
      JSON.stringify(options),
      deadlineInMs === null ? null : ts + deadlineInMs,
      ts,
    )
  return getPoll(id, input.creatorId, false)
}

/**
 * 投票（全量替换语义：把 voter 在这个投票下的票整体换成 options）。
 *
 * 用"替换"而不是"增删"：前端不用区分"第一次投"和"改票"，一个接口就够；
 * 多选时界面本来就是一组勾选框，提交的天然就是全量。
 */
export function votePoll(
  id: string,
  userId: string,
  chosen: number[],
): PollView {
  const poll = getPoll(id, userId, false)
  if (isVotingClosed({ closedAt: poll.closedAt, deadlineAt: poll.deadlineAt })) {
    throw new HttpError(400, '这个投票已经截止或关闭了')
  }
  if (!Array.isArray(chosen)) throw new HttpError(400, '参数不合法')

  // 去重 + 越界/负数全拒：越界的下标悄悄忽略会掩盖前端 bug
  const unique = [...new Set(chosen)]
  if (unique.some((idx) => !Number.isInteger(idx) || idx < 0 || idx >= poll.options.length)) {
    throw new HttpError(400, '选项不存在')
  }
  if (!poll.multi) {
    if (unique.length !== 1) throw new HttpError(400, '单选投票只能选一个')
  } else if (unique.length > poll.options.length) {
    throw new HttpError(400, '选的比选项还多，参数不合法')
  }

  const db = getDb()
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(id, userId)
    const insert = db.prepare('INSERT INTO poll_votes (poll_id, user_id, option_idx, voted_at) VALUES (?, ?, ?, ?)')
    for (const idx of unique) insert.run(id, userId, idx, now())
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return getPoll(id, userId, false)
}

/**
 * 关闭 / 重开。截止前关掉 = 提前定稿（人齐了不用等到点）。
 * 重开只对手动关闭有效：过了 deadline 的重开等于改历史，不做。
 */
export function setPollClosed(id: string, userId: string, isAdmin: boolean, closed: boolean): PollView {
  const poll = getPoll(id, userId, isAdmin)
  if (!poll.canManage) throw new HttpError(403, '只有创建者或管理员能操作')
  if (closed) {
    if (poll.closedAt !== null) throw new HttpError(400, '已经关闭了')
    getDb().prepare('UPDATE polls SET closed_at = ? WHERE id = ?').run(now(), id)
  } else {
    if (poll.closedAt === null) throw new HttpError(400, '这个投票没有被手动关闭过')
    if (poll.deadlineAt !== null && now() >= poll.deadlineAt) {
      throw new HttpError(400, '已过截止时间的投票不能重开，请新建一个')
    }
    getDb().prepare('UPDATE polls SET closed_at = NULL WHERE id = ?').run(id)
  }
  return getPoll(id, userId, isAdmin)
}

/** 删除（创建者或管理员）。先读一遍留审计素材，再连票一起删。 */
export function deletePoll(id: string, userId: string, isAdmin: boolean): PollView {
  const poll = getPoll(id, userId, isAdmin)
  if (!poll.canManage) throw new HttpError(403, '只有创建者或管理员能删除')
  const db = getDb()
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(id)
    db.prepare('DELETE FROM polls WHERE id = ?').run(id)
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return poll
}
