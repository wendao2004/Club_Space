/**
 * 白板路由。模式同 poll.ts：鉴权/审计/广播在路由层。
 *
 * 协作语义（最后写入胜）的实现位置：保存时 broadcast 一条 `whiteboard`
 * 事件，其他开着这块白板的客户端收到后自行决定"自动载入"（本地没有
 * 未保存改动时）或"提示有新版本"（有改动时）—— 选择权在客户端，
 * 服务端只负责通知。
 */
import type { FastifyInstance } from 'fastify'
import {
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  listWhiteboards,
  saveWhiteboard,
} from '../whiteboard.ts'
import { audit } from '../audit.ts'
import { broadcast } from '../realtime.ts'
import { roleAtLeast } from '../auth.ts'
import { actorIp, requireUser } from './auth-guard.ts'

export function registerWhiteboardRoutes(app: FastifyInstance): void {
  app.get('/api/whiteboards', async (req) => {
    const user = requireUser(req)
    return { boards: listWhiteboards(user.id, roleAtLeast(user.role, 'admin')) }
  })

  app.get('/api/whiteboards/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    return { board: getWhiteboard(id, user.id, roleAtLeast(user.role, 'admin')) }
  })

  app.post('/api/whiteboards', async (req) => {
    const user = requireUser(req)
    const body = req.body as { name?: unknown }
    const board = createWhiteboard(typeof body.name === 'string' ? body.name : '', user.id)
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'whiteboard-create',
      target: board.id,
      payload: { name: board.name },
    })
    broadcast({ type: 'whiteboard', data: { reason: 'created', boardId: board.id } })
    return { board }
  })

  app.put('/api/whiteboards/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = req.body as { data?: unknown }
    const board = saveWhiteboard(
      id,
      user.id,
      roleAtLeast(user.role, 'admin'),
      typeof body.data === 'string' ? body.data : '',
    )
    // actorId 让客户端能认出"这是我自己刚保存的"，不必回灌自己的画布
    broadcast({ type: 'whiteboard', data: { reason: 'saved', boardId: id, by: user.display_name, actorId: user.id } })
    return { board: { ...board, data: undefined } }
  })

  app.delete('/api/whiteboards/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const before = getWhiteboard(id, user.id, roleAtLeast(user.role, 'admin'))
    deleteWhiteboard(id, user.id, roleAtLeast(user.role, 'admin'))
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'whiteboard-delete',
      target: id,
      payload: { name: before.name, ownerId: before.ownerId },
    })
    broadcast({ type: 'whiteboard', data: { reason: 'deleted', boardId: id } })
    return { ok: true }
  })
}
