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
  drawRecipients,
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
  unwatchDrawRoom,
  watchDrawRoom,
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
  // 玩家 ∪ 旁观者。旁观者不是 players，但他们在看这一局 —— 没有他们，
  // 非成员打开进行中的房间只会看到进入时的那一帧快照。
  const recipients = drawRecipients(roomId)
  if (recipients.length === 0) return
  const online = onlineUserIds()

  // 房间可能刚被解散（最后一人退房即删行）。这时要给还在看的人发一条
  // room:null，否则他们会停在一个已经不存在的房间上。
  try {
    getDrawRoom(roomId, recipients[0]!, online)
  } catch (err) {
    // 只有 404 才是"房间确实没了"。临时数据库错误不能当成解散 ——
    // 那会让所有客户端把还活着的房间清掉。
    if (err instanceof HttpError && err.status === 404) {
      pushTo(recipients, { type: 'game-draw', data: { roomId, room: null } })
    }
    return
  }

  for (const userId of recipients) {
    try {
      pushTo([userId], { type: 'game-draw', data: { roomId, room: getDrawRoom(roomId, userId, online) } })
    } catch {
      // 房间刚好在这一刻被删了，忽略
    }
  }
}

export function pushDrawStroke(roomId: string, from: string, op: DrawStrokeOp): void {
  const recipients = drawRecipients(roomId)
  if (recipients.length === 0) return
  // 广播把 from **平铺**进 op（而不是包一层 { from, op }）。
  //
  // 这里踩过一次：最初发的是 { from, op }，而前端把整个 payload 当 op 用 ——
  // `op.op` 永远是 undefined，begin/points/clear 所有分支都不匹配，别人的
  // 笔迹被静默丢弃。症状是"画面不实时同步，关掉重开才看得到"（重开走的是
  // /canvas 补发）。协议形状必须和前端类型（DrawStrokeBroadcast）一致，
  // 否则是一个只在运行时暴露的静默失败。
  //
  // roomId 也必须带：draw 窗口不是单例，同一个用户可能同时开着两个画桌，
  // 客户端的 strokeListeners 是全局的 —— 不带房间标识就会串台。
  pushTo(recipients, { type: 'draw-stroke', data: { ...op, from, roomId } })
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
    // **必须在 leaveDrawRoom 之前取收件人**：最后一人离开时它内部会
    // disposeDrawRoom，把 watcher 登记一起清掉 —— 之后再看 audience 就空了，
    // 旁观者永远收不到 room:null。
    const recipientsBefore = drawRecipients(id)
    try {
      const room = leaveDrawRoom(id, user.id, onlineUserIds())
      pushDrawRoom(id)
      return { room }
    } catch (err) {
      // 只有 **404** 才是"房间解散"（最后一人退房时 leaveDrawRoom 删行后抛的）。
      // SQLITE_BUSY 之类的临时错误不能被当成解散 —— 那会把一个还活着的房间
      // 的画布缓冲和观看登记一起清掉。
      if (err instanceof HttpError && err.status === 404) {
        // 玩家都走了，但旁观者还在看：解散前先发一条 room:null，
        // 否则界面会停在一个已经不存在的房间上。
        pushTo(recipientsBefore, { type: 'game-draw', data: { roomId: id, room: null } })
        disposeDrawRoom(id)
      }
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
      origin: typeof body.origin === 'string' ? body.origin : undefined,
    })
    // clear（缓冲超限）时笔迹被重置，接收端要连画布一起清 —— op 原样带过去
    pushDrawStroke(id, user.id, op)
    return { ok: true }
  })

  /** 中途进来 / 刷新：补发当前画布。缓冲可能为空（服务端重启过），如实返回。 */
  app.get('/api/games/draw/rooms/:id/canvas', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    getDrawRoom(id, user.id, onlineUserIds()) // 顺带校验房间存在
    return { strokes: getDrawCanvas(id) }
  })

  /**
   * 旁观者登记：我还在看这个房间。
   *
   * 前端进入画桌时 POST 一次，之后每 20 秒续期；离开/关窗时 unwatch。
   * 服务端只做"房间存在"校验，不要求是玩家 —— 旁观者本来就不是玩家。
   * 推送时仍是按 viewer 裁剪的安全视图（word / wordChoices 对非成员为空）。
   */
  app.post('/api/games/draw/rooms/:id/watch', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const online = onlineUserIds()
    // 顺带把当前视图带回去：GET 房间与登记之间如果发生了最后一次状态变化
    // （比如刚好在注册前进入 finished），之后再没有任何推送能补 ——
    // 客户端必须能在登记成功时做一次对账。
    let room
    try {
      room = getDrawRoom(id, user.id, online)
    } catch (err) {
      // 房间已经没了：清掉可能残留的登记，避免它继续占用收件人集合
      unwatchDrawRoom(id, user.id)
      throw err
    }
    watchDrawRoom(id, user.id)
    return { ok: true, room }
  })

  app.post('/api/games/draw/rooms/:id/unwatch', async (req) => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    unwatchDrawRoom(id, user.id)
    return { ok: true }
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
