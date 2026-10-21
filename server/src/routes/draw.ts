/**
 * 你画我猜路由。
 *
 * 从 index.ts 搬出来的第二个模块。为什么先挑游戏：它们的路由只依赖
 * games/* 的领域函数 + 实时推送，不碰文件/记账那些共享状态，
 * 搬家时最容易做到只搬不改。
 *
 * ⚠️ pushDrawRoom / pushDrawStroke 必须 export：超时扫描（index.ts 的 2 秒 tick）
 * 在阶段推进后要靠它们广播，那部分留在 index.ts 里更合适（它是全站定时器，
 * 不属于任何单个路由模块）。
 */
import type { FastifyInstance } from 'fastify'
import {
  chooseDrawWord,
  createDrawRoom,
  disposeDrawRoom,
  drawMembers,
  getDrawCanvas,
  getDrawHistoryDetail,
  getDrawRoom,
  guessDrawWord,
  joinDrawRoom,
  leaveDrawRoom,
  listDrawHistory,
  listDrawRooms,
  startDrawRoom,
  submitStroke,
  type DrawStrokeOp,
} from '../games/draw-rooms.ts'
import { onlineUserIds } from '../presence.ts'
import { pushTo } from '../realtime.ts'
import { HttpError } from '../files.ts'
import { requireUser } from './auth-guard.ts'

/**
 * 房间状态推送（按人裁剪）。
 *
 * 事件分两个：game-draw 是状态（词藏在这条里，必须逐人算视图）；
 * draw-stroke 是画笔（无视角差异，所有成员同一份 payload）。
 */
export function pushDrawRoom(roomId: string): void {
  const memberIds = drawMembers(roomId)
  if (memberIds.length === 0) return
  const online = onlineUserIds()
  for (const userId of memberIds) {
    try {
      pushTo([userId], { type: 'game-draw', data: { roomId, room: getDrawRoom(roomId, userId, online) } })
    } catch {
      // 房间可能刚好被删了（最后一人退房即解散），忽略
    }
  }
}

export function pushDrawStroke(roomId: string, from: string, op: DrawStrokeOp): void {
  const memberIds = drawMembers(roomId)
  if (memberIds.length === 0) return
  // 广播把 from **平铺**进 op（而不是包一层 { from, op }）。
  //
  // 这里踩过一次：最初发的是 { from, op }，而前端把整个 payload 当 op 用 ——
  // `op.op` 永远是 undefined，begin/points/clear 所有分支都不匹配，别人的
  // 笔迹被静默丢弃。症状是"画面不实时同步，关掉重开才看得到"（重开走的是
  // /canvas 补发）。协议形状必须和前端类型（DrawStrokeBroadcast）一致，
  // 否则是一个只在运行时暴露的静默失败。
  pushTo(memberIds, { type: 'draw-stroke', data: { ...op, from } })
}

export function registerDrawRoutes(app: FastifyInstance): void {
  app.get('/api/games/draw/rooms', async (req) => {
    const user = requireUser(req)
    return { rooms: listDrawRooms(user.id, onlineUserIds()) }
  })

  app.post('/api/games/draw/rooms', async (req) => {
    const user = requireUser(req)
    const body = (req.body ?? {}) as { title?: unknown; rounds?: unknown }
    const room = createDrawRoom({
      title: typeof body.title === 'string' ? body.title : '',
      creatorId: user.id,
      creatorName: user.display_name,
      rounds: typeof body.rounds === 'number' ? body.rounds : undefined,
    })
    // 建房不广播大厅刷新（与斗地主一致）：大厅打开时拉一次，加入/开始时各自推送
    return { room }
  })

  app.get('/api/games/draw/rooms/:id', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    return { room: getDrawRoom(id, user.id, onlineUserIds()) }
  })

  app.post('/api/games/draw/rooms/:id/join', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const room = joinDrawRoom(id, user.id, user.display_name, onlineUserIds())
    pushDrawRoom(id)
    return { room }
  })

  app.post('/api/games/draw/rooms/:id/leave', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    try {
      const room = leaveDrawRoom(id, user.id, onlineUserIds())
      pushDrawRoom(id)
      return { room }
    } catch (err) {
      // 最后一人退房 = 房间解散（leaveDrawRoom 删行后 404）。把这件事告诉
      // 留下的人之外没有别人（都走了），但 room 404 本身就是有效信号，照抛。
      disposeDrawRoom(id)
      throw err
    }
  })

  app.post('/api/games/draw/rooms/:id/start', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const room = startDrawRoom(id, user.id, onlineUserIds())
    pushDrawRoom(id)
    return { room }
  })

  app.post('/api/games/draw/rooms/:id/word', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { word?: unknown }
    if (typeof body.word !== 'string') throw new HttpError(400, '缺少 word')
    const room = chooseDrawWord(id, user.id, body.word, onlineUserIds())
    pushDrawRoom(id)
    return { room }
  })

  /**
   * 画笔上报。
   *
   * 客户端攒批（约 80ms 一条）后 POST；服务端校验"是画家 + 字段合法"，
   * 追加进内存缓冲，然后把**同一份 payload** 广播给房间全员 ——
   * 画笔没有视角差异，答案藏在 state 里，不在笔迹里。
   */
  app.post('/api/games/draw/rooms/:id/strokes', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const op = submitStroke(id, user.id, {
      op: (body.op as DrawStrokeOp['op']) ?? 'points',
      strokeId: String(body.strokeId ?? ''),
      points: Array.isArray(body.points) ? (body.points as DrawStrokeOp['points']) : [],
      color: typeof body.color === 'string' ? body.color : '#000000',
      width: typeof body.width === 'number' ? body.width : 4,
      tool: body.tool === 'eraser' ? 'eraser' : 'pen',
    })
    // clear（缓冲超限）时笔迹被重置，接收端要连画布一起清 —— op 原样带过去
    pushDrawStroke(id, user.id, op)
    return { ok: true }
  })

  /** 中途进来 / 刷新：补发当前画布。缓冲可能为空（服务端重启过），如实返回。 */
  app.get('/api/games/draw/rooms/:id/canvas', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    getDrawRoom(id, user.id, onlineUserIds()) // 顺带做成员校验
    return { strokes: getDrawCanvas(id) }
  })

  /**
   * 历史对局。
   *
   * 登录用户都能看：这是社团内部的娱乐记录，不是私密内容；如果限定"只看自己
   * 参加过的"，"我们上礼拜那局"这种最常见的问法反而查不出来。
   */
  app.get('/api/games/draw/history', async (req) => {
    requireUser(req)
    const q = req.query as { limit?: string }
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '30', 10) || 30, 1), 100)
    return { rooms: listDrawHistory(limit) }
  })

  app.get('/api/games/draw/history/:id', async (req) => {
    requireUser(req)
    const { id } = req.params as { id: string }
    return { detail: getDrawHistoryDetail(id) }
  })

  app.post('/api/games/draw/rooms/:id/guess', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { text?: unknown }
    if (typeof body.text !== 'string') throw new HttpError(400, '缺少 text')
    const result = guessDrawWord(id, user.id, user.display_name, body.text, onlineUserIds())
    // 猜对 / 阶段推进（全对进 reveal）都会改状态；纯闲聊只动内存，状态推送无害
    pushDrawRoom(id)
    return result
  })
}
