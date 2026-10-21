/**
 * 打字练习路由。纯个人数据：每个接口都只碰 requireUser 那个人的行。
 */
import type { FastifyInstance } from 'fastify'
import { clearWrong, listProgress, listWrong, recordWrong, saveProgress } from '../typing.ts'
import { requireUser } from './auth-guard.ts'

export function registerTypingRoutes(app: FastifyInstance): void {
  app.get('/api/typing/progress', async (req) => {
    const user = requireUser(req)
    return { progress: listProgress(user.id) }
  })

  app.put('/api/typing/progress', async (req) => {
    const user = requireUser(req)
    const body = req.body as { dict?: unknown; chapter?: unknown; position?: unknown }
    const row = saveProgress(
      user.id,
      typeof body.dict === 'string' ? body.dict : '',
      typeof body.chapter === 'number' ? body.chapter : -1,
      typeof body.position === 'number' ? body.position : -1,
    )
    return { progress: row }
  })

  app.get('/api/typing/wrong', async (req) => {
    const user = requireUser(req)
    return { wrong: listWrong(user.id) }
  })

  app.post('/api/typing/wrong', async (req) => {
    const user = requireUser(req)
    const body = req.body as { dict?: unknown; word?: unknown }
    recordWrong(user.id, typeof body.dict === 'string' ? body.dict : '', typeof body.word === 'string' ? body.word : '')
    return { ok: true }
  })

  app.post('/api/typing/wrong/clear', async (req) => {
    const user = requireUser(req)
    const body = req.body as { dict?: unknown; word?: unknown }
    const removed = clearWrong(
      user.id,
      typeof body.dict === 'string' ? body.dict : null,
      typeof body.word === 'string' ? body.word : null,
    )
    return { removed }
  })
}
