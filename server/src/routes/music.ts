/**
 * 听歌房路由。模式与 poll.ts 一致：鉴权、审计、广播在路由层，逻辑在 music.ts。
 *
 * 投歌不审计（太频繁），跳歌/上报也不审计 —— 这些是"听歌厅里的日常动作"，
 * 不是破坏性操作；唯一有存证价值的是"排了歌/撤了歌"，但那本身就是公开
 * 状态（队列人人可见），审计意义不大。文件删除对听歌房的波及在
 * purgeDeletedNode 里处理（见 music.ts）。
 */
import type { FastifyInstance } from 'fastify'
import {
  enqueueTrack,
  musicRoomView,
  purgeDeletedNode,
  removeQueued,
  reportEnded,
  skipTrack,
} from '../music.ts'
import { broadcast } from '../realtime.ts'
import { roleAtLeast } from '../auth.ts'
import { getDb } from '../db.ts'
import { canRead, getNode } from '../files.ts'
import { requireUser } from './auth-guard.ts'

/** 变化广播：payload 只带原因，客户端重拉整个房间（数据量是几十条）。 */
function notify(reason: string): void {
  broadcast({ type: 'music', data: { reason } })
}

export function registerMusicRoutes(app: FastifyInstance): void {
  app.get('/api/music/room', async (req) => {
    requireUser(req)
    return musicRoomView()
  })

  /** 可排播的音频：文件系统里用户读得到的 audio 文件（社团规模全量扫足够快）。 */
  app.get('/api/music/tracks', async (req) => {
    const user = requireUser(req)
    const isAdmin = roleAtLeast(user.role, 'admin')
    const rows = getDb()
      .prepare(
        `SELECT n.id, n.name, n.owner_id, u.display_name AS owner_name
           FROM nodes n JOIN users u ON u.id = n.owner_id
          WHERE n.kind = 'file' AND n.deleted_at IS NULL AND n.mime LIKE 'audio/%'
          ORDER BY n.updated_at DESC LIMIT 500`,
      )
      .all() as unknown as Array<{
      id: string
      name: string
      owner_id: string
      owner_name: string
      mime: string | null
    }>
    // 权限在应用层过滤：canRead 的规则（私有/空间成员）不适合塞进 SQL
    const tracks = rows
      .map((r) => ({ ...r, node: getNode(r.id)! }))
      .filter((t) => t.node && canRead(t.node, user.id, isAdmin))
      .map((t) => ({ id: t.id, name: t.name, ownerName: t.owner_name }))
    return { tracks }
  })

  app.post('/api/music/queue', async (req) => {
    const user = requireUser(req)
    const body = req.body as { nodeId?: unknown }
    const view = enqueueTrack(typeof body.nodeId === 'string' ? body.nodeId : '', user.id, roleAtLeast(user.role, 'admin'))
    notify('enqueued')
    return view
  })

  app.delete('/api/music/queue/:itemId', async (req) => {
    const user = requireUser(req)
    const { itemId } = req.params as { itemId: string }
    const view = removeQueued(itemId, user.id, roleAtLeast(user.role, 'admin'))
    notify('removed')
    return view
  })

  app.post('/api/music/skip', async (req) => {
    const user = requireUser(req)
    const view = skipTrack(user.id)
    notify('skipped')
    return view
  })

  app.post('/api/music/ended', async (req) => {
    const user = requireUser(req)
    const body = req.body as { playedToken?: unknown }
    const { advanced } = reportEnded(user.id, typeof body.playedToken === 'number' ? body.playedToken : -1)
    if (advanced) notify('ended')
    return { advanced }
  })
}

/** 文件删除前清听歌房引用 —— 由 index.ts 的删除路径调用（在删除之前）。 */
export function musicPurgeDeleted(nodeId: string): void {
  const before = musicRoomView()
  purgeDeletedNode(nodeId)
  const after = musicRoomView()
  if (
    before.nowPlaying?.nodeId !== after.nowPlaying?.nodeId ||
    before.queue.length !== after.queue.length
  ) {
    notify('purged')
  }
}
