/**
 * 投票路由。
 *
 * 与 board.ts 同一模式：路由只做鉴权、参数清洗、审计与广播，
 * 领域逻辑全在 poll.ts。变化时 broadcast 一条 `poll` 事件（payload 只带
 * 原因与 id），客户端重拉 —— 投票不是你画我猜那种高频实时，全量刷新够了。
 */
import type { FastifyInstance } from 'fastify'
import {
  createPoll,
  deletePoll,
  getPoll,
  listPolls,
  setPollClosed,
  votePoll,
} from '../poll.ts'
import { audit } from '../audit.ts'
import { broadcast } from '../realtime.ts'
import { roleAtLeast } from '../auth.ts'
import { HttpError } from '../files.ts'
import { actorIp, requireUser } from './auth-guard.ts'

export function registerPollRoutes(app: FastifyInstance): void {
  app.get('/api/polls', async (req) => {
    const user = requireUser(req)
    const q = req.query as { open?: string; limit?: string }
    return {
      polls: listPolls(user.id, roleAtLeast(user.role, 'admin'), {
        openOnly: q.open === '1',
        limit: Number.parseInt(q.limit ?? '100', 10) || 100,
      }),
    }
  })

  app.get('/api/polls/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    return { poll: getPoll(id, user.id, roleAtLeast(user.role, 'admin')) }
  })

  app.post('/api/polls', async (req) => {
    const user = requireUser(req)
    const body = req.body as {
      title?: unknown
      description?: unknown
      multi?: unknown
      options?: unknown
      deadlineInMs?: unknown
    }
    if (!Array.isArray(body.options)) throw new HttpError(400, '选项必须是数组')
    const poll = createPoll({
      creatorId: user.id,
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : undefined,
      multi: body.multi === true,
      options: body.options.filter((o): o is string => typeof o === 'string'),
      deadlineInMs: typeof body.deadlineInMs === 'number' ? body.deadlineInMs : null,
    })
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'poll-create',
      target: poll.id,
      payload: {
        title: poll.title,
        multi: poll.multi,
        options: poll.options.length,
        hasDeadline: poll.deadlineAt !== null,
      },
    })
    broadcast({ type: 'poll', data: { reason: 'created', pollId: poll.id } })
    return { poll }
  })

  app.post('/api/polls/:id/vote', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = req.body as { options?: unknown }
    const options = Array.isArray(body.options) ? body.options.filter((o): o is number => typeof o === 'number') : []
    const poll = votePoll(id, user.id, options)
    broadcast({ type: 'poll', data: { reason: 'voted', pollId: id } })
    return { poll }
  })

  app.post('/api/polls/:id/close', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = req.body as { closed?: unknown }
    const closed = body.closed !== false
    const before = getPoll(id, user.id, roleAtLeast(user.role, 'admin'))
    const poll = setPollClosed(id, user.id, roleAtLeast(user.role, 'admin'), closed)
    // 关/开是"官方定稿"动作，跟留言板的处理标记同理要留痕
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: closed ? 'poll-close' : 'poll-reopen',
      target: id,
      payload: { title: before.title, totalVoters: before.totalVoters },
    })
    broadcast({ type: 'poll', data: { reason: closed ? 'closed' : 'reopened', pollId: id } })
    return { poll }
  })

  app.delete('/api/polls/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    // 先读留审计素材（删完就查不到了）
    const before = getPoll(id, user.id, roleAtLeast(user.role, 'admin'))
    deletePoll(id, user.id, roleAtLeast(user.role, 'admin'))
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'poll-delete',
      target: id,
      payload: {
        title: before.title,
        creatorId: before.creatorId,
        totalVoters: before.totalVoters,
      },
    })
    broadcast({ type: 'poll', data: { reason: 'deleted', pollId: id } })
    return { ok: true }
  })
}
