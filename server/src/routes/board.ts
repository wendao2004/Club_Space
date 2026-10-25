/**
 * 留言板路由。
 *
 * 从 index.ts 搬出来的第一个模块 —— 挑它是因为它最"干净"：只依赖
 * 留言板自己的领域函数、审计与广播，不碰任何 index.ts 的局部状态。
 * 搬的时候**一行逻辑都没改**（路由快照逐条比对过）。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  BOARD_KINDS,
  createBoardPost,
  deleteBoardPost,
  getBoardPost,
  listBoardPosts,
  resolveBoardPost,
  type BoardKind,
} from '../board.ts'
import { audit } from '../audit.ts'
import { broadcast } from '../realtime.ts'
import { roleAtLeast } from '../auth.ts'
import { actorIp, enforceRateLimit, requireUser } from './auth-guard.ts'

/**
 * 留言板（全站一份，登录即可读写）。
 *
 * 变化时 broadcast 一条 `board` 事件，payload 只带原因与 id —— 客户端重拉
 * 一次列表。留言板的数据量是几十条，做增量同步带来的复杂度远大于省下的
 * 一次请求。
 */
const boardKindSchema = z.enum(['bug', 'idea', 'complaint'])

export function registerBoardRoutes(app: FastifyInstance): void {
  app.get('/api/board/posts', async (req) => {
    const user = requireUser(req)
    const q = req.query as { open?: string; kind?: string; limit?: string }
    const kind = q.kind && (BOARD_KINDS as readonly string[]).includes(q.kind) ? (q.kind as BoardKind) : undefined
    return {
      posts: listBoardPosts(user.id, {
        openOnly: q.open === '1',
        kind,
        limit: Number.parseInt(q.limit ?? '100', 10) || 100,
      }),
    }
  })

  app.post('/api/board/posts', async (req) => {
    const user = requireUser(req)
    // 按账号限流：留言板全站一份，一个人刷屏就会把别人的留言挤出列表首页，
    // 而 NAT 后面的办公室按 IP 计会互相误伤（见 RATE_RULES.boardPost 的说明）。
    enforceRateLimit(req, 'boardPost', `:${user.id}`, true)
    const body = req.body as { kind?: unknown; body?: unknown }
    const post = createBoardPost({
      authorId: user.id,
      authorName: user.display_name,
      kind: boardKindSchema.parse(body.kind ?? 'bug'),
      body: typeof body.body === 'string' ? body.body : '',
    })
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'board-post',
      target: post.id,
      payload: { kind: post.kind, length: post.body.length },
    })
    broadcast({ type: 'board', data: { reason: 'created', postId: post.id } })
    return { post }
  })

  app.post('/api/board/posts/:id/resolve', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = req.body as { resolved?: unknown; resolution?: unknown }
    const post = resolveBoardPost(
      id,
      user.id,
      roleAtLeast(user.role, 'admin'),
      body.resolved !== false,
      typeof body.resolution === 'string' ? body.resolution : null,
    )
    // 标记状态也是"官方的处理动作"，谁在什么时候把哪条标掉的要留痕 ——
    // 与"删活动必须写审计"同一条原则（见 ledger-delete-event）。
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'board-resolve',
      target: id,
      payload: {
        kind: post.kind,
        resolved: post.resolvedAt !== null,
        noteLength: post.resolution?.length ?? 0,
      },
    })
    broadcast({ type: 'board', data: { reason: 'resolved', postId: id } })
    return { post }
  })

  app.delete('/api/board/posts/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    // 先读一遍：删完就查不到了，而审计里要留下"删的是谁的、什么类型、有没有被处理过"。
    const before = getBoardPost(id, user.id)
    deleteBoardPost(id, user.id, roleAtLeast(user.role, 'admin'))
    // 留言板的定位是"收集 bug 的工单"，删除是破坏性操作 —— 必须留痕。
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'board-delete',
      target: id,
      payload: {
        kind: before.kind,
        authorId: before.authorId,
        wasResolved: before.resolvedAt !== null,
        length: before.body.length,
      },
    })
    broadcast({ type: 'board', data: { reason: 'deleted', postId: id } })
    return { ok: true }
  })
}
