/**
 * 实时推送层（Server-Sent Events）。
 *
 * 为什么用 SSE 而不是 WebSocket：
 *
 *   1. **零依赖。** Fastify 上直接写 reply.raw 即可，不需要 @fastify/websocket，
 *      也不需要自己实现 WS 的帧解析与 ping/pong。
 *   2. **符合实际的通信模式。** 聊天是"客户端发消息用 POST、服务端推进来用流"，
 *      本来就是单向推送为主，WebSocket 的全双工能力用不上。
 *   3. **EventSource 自带断线重连。** 浏览器会自动重连并带上 Last-Event-ID，
 *      我们自己写的 WebSocket 重连逻辑通常没有它可靠。
 *   4. **绕开一整类运维坑。** WebSocket 需要代理正确转发 Upgrade 头，
 *      配置漂移的表现是"连不上但没有明显报错"。SSE 就是普通的 HTTP 长响应，
 *      Caddy 默认就能正确流式转发。
 *
 * 后续做回合制游戏（象棋、斗地主）时延迟容忍度也够 —— 那类游戏的关键是
 * 状态正确而不是低延迟。
 *
 * 心跳：每 25 秒发一个注释行。没有它，中间的代理会在空闲一段时间后掐断连接，
 * 而现象是"用着用着收不到消息了"，很难排查。
 */
import type { FastifyReply } from 'fastify'
import { presenceConnected, presenceDisconnected } from './presence.ts'
import { getDb } from './db.ts'

export type RealtimeEvent =
  | { type: 'hello'; data: { connectionId: string; serverTime: number } }
  | { type: 'message'; data: unknown }
  | { type: 'message-updated'; data: unknown }
  | { type: 'conversation'; data: unknown }
  | { type: 'read'; data: { conversationId: string; userId: string; lastReadSeq: number } }
  | { type: 'typing'; data: { conversationId: string; userId: string; displayName: string } }
  | { type: 'presence'; data: { userId: string; online: boolean } }
  | { type: 'unread'; data: { total: number } }
  /** 房间状态变化（有人加入、有人退出、对局结束）。 */
  | { type: 'game'; data: unknown }
  /** 有人落子（象棋）。单独一个事件名，方便客户端做走子动画。 */
  | { type: 'game-move'; data: unknown }
  /**
   * 有人出牌（斗地主）。
   *
   * ⚠️ 这个事件的 payload 是**按人裁剪过的**：手牌是隐藏信息，
   * 所以它必须用 pushTo 定向发送，绝不能用 broadcast。
   * 见 index.ts 的 pushDoudizhuRoom()。
   */
  | { type: 'game-play'; data: unknown }
  /**
   * 狼人杀房间状态变化（有人加入、阶段推进、有人出局）。
   *
   * ⚠️ 和斗地主同理，甚至更严格：这个 payload **必须**是按视角裁剪过的。
   * 狼人杀里"谁是什么身份"就是全部的隐藏信息 —— 广播一份完整状态出去，
   * 前端再怎么藏都没用，打开控制台就能看见所有人的身份。
   * 只能 pushTo 给房间里的座位，见 index.ts 的 pushWerewolfRoom()。
   */
  | { type: 'game-werewolf'; data: unknown }
  /**
   * 狼人杀房内文字频道的新发言。
   *
   * ⚠️ 同样是按视角裁剪过的：夜晚的狼队发言只推到狼人，非狼/观战者收到的
   * payload 里不会有它。事件名单独一个（而不是复用 game-werewolf），
   * 方便前端做"新消息"的滚动/提示，而不用靠比对整份房间状态去猜。
   */
  | { type: 'game-werewolf-chat'; data: unknown }
  /**
   * 狼人杀大厅的"该刷新了"信号，**广播**给所有人。
   *
   * 载荷只有 roomId，没有任何房间内容 —— 房间详情依旧只推给房里的人。
   * 存在的理由：大厅列表过去只在打开应用时拉一次，别人建了房间/退了房间
   * 都不刷新，找人开局全靠吼。现在建/退房间时广播一个敲门声，
   * 在线的客户端刷新一下列表即可。
   */
  | { type: 'game-werewolf-lobby'; data: unknown }
  /**
   * 你画我猜的房间状态（阶段推进、计分、提示揭示）。
   *
   * ⚠️ 与斗地主 / 狼人杀同理：payload 是按人裁剪过的 —— **词**就是这个游戏的
   * 全部隐藏信息，未猜对者只能拿到掩码（见 draw.ts 的 viewFor）。
   * 只能 pushTo 给房间成员，见 index.ts 的 pushDrawRoom()。
   */
  | { type: 'game-draw'; data: unknown }
  /**
   * 画笔数据。与上面所有事件都不同：**没有视角差异**（画家画什么大家看什么，
   * 答案藏在 state 不在笔迹里），所以对所有成员发同一份 payload。
   * 单独一个事件名而不是复用 game-draw：它每秒会有好几条，前端按事件名分流，
   * 渲染路径和状态渲染路径完全分开。
   */
  | { type: 'draw-stroke'; data: unknown }
  /**
   * 留言板有变化（新留言、被标记已解决、被撤回）。
   *
   * 用 broadcast 而不是定向推送：留言板本来就是**全站共用一份**、没有隐藏
   * 信息。payload 只带原因与 id，正文让客户端自己重拉 —— 一条列表接口
   * 就够，没必要为了省一次请求把增量同步的复杂度引进来。
   */
  | { type: 'board'; data: unknown }

interface Connection {
  id: string
  userId: string
  /**
   * 建立这条连接时用的**会话 id**。
   *
   * 为什么要记它：SSE 只在建连那一刻鉴权一次，之后就是一条长活连接。
   * 不记会话的话，"登出""改口令""管理员强制下线"这些动作只能删掉库里的
   * 会话行，而**已经建立的流仍然在收消息** —— 共用电脑上点了登出，
   * 那个标签页还能继续看到新消息和未读数；被偷走的那条 EventSource
   * 更是能一直收到进程重启为止。
   *
   * 记下来之后，destroySession / revokeAllSessions 可以精确找到并关掉
   * 对应的连接（见 disconnectSession / disconnectUser）。
   */
  sessionId: string
  reply: FastifyReply
  heartbeat: NodeJS.Timeout
  closed: boolean
}

/** 每个用户可以有多个连接（多标签页 / 手机 + 电脑）。 */
const connections = new Map<string, Set<Connection>>()

let connectionSeq = 0

function writeEvent(conn: Connection, event: RealtimeEvent | { type: 'ping' }): void {
  if (conn.closed) return
  try {
    // SSE 格式：event: <名字>\ndata: <JSON>\n\n
    // 注释行（以冒号开头）用作心跳，客户端不解析但能防止连接被判定为空闲
    if (event.type === 'ping') {
      conn.reply.raw.write(`: ping ${Date.now()}\n\n`)
      return
    }
    conn.reply.raw.write(`event: ${event.type}\n`)
    conn.reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`)
  } catch {
    // 写失败说明连接已经断了，交给 close 清理
    closeConnection(conn)
  }
}

function closeConnection(conn: Connection, endResponse = false): void {
  if (conn.closed) return
  conn.closed = true
  clearInterval(conn.heartbeat)
  // 主动关闭（登出/强制下线）时要把 HTTP 响应真正结束掉，
  // 否则客户端那条 EventSource 会一直挂着、并且按浏览器的重连策略反复重试。
  // 被动路径（socket 已经 close）不需要这一步。
  if (endResponse) {
    try {
      conn.reply.raw.end()
    } catch {
      // 已经断了，忽略
    }
  }
  const set = connections.get(conn.userId)
  if (set) {
    set.delete(conn)
    if (set.size === 0) {
      connections.delete(conn.userId)
      // 最后一个连接断开才算离线。
      // 只减计数、不动 last_seen：用"刷新时间戳"来表达离线，会让刚关掉页面的人
      // 在接下来 60 秒里仍然被判成在线（头像亮着，人已经走了）。
      presenceDisconnected(conn.userId)
      broadcastPresence(conn.userId, false)
    }
  }
}

/**
 * 会话是否仍然有效（存在且未过期）。
 *
 * 成本：每 25 秒 × 每条连接一次主键点查。500 条连接约 20 qps，
 * 全部命中页缓存、且 WAL 下读不阻塞写，可以忽略。
 * 换来的是：会话过期或被人从库里删掉之后，连接最多再活 25 秒。
 *
 * 查不到证据时**放行**：数据库短暂 busy（SQLite 会抛 SQLITE_BUSY）
 * 不该被当成"会话失效"把全站用户一起踢下线。真正的撤销走
 * disconnectSession / disconnectUser 主动关闭，这里只是兜底。
 */
function sessionStillValid(sessionId: string): boolean {
  try {
    const row = getDb().prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sessionId) as
      | { expires_at: number }
      | undefined
    return row !== undefined && row.expires_at > Date.now()
  } catch {
    return true
  }
}

/**
 * 每个用户最多同时开多少条连接。
 *
 * 12 条 = 几台设备 × 几个标签页，正常使用碰不到；
 * 而一个脚本想开几千条时会被挡住。
 */
const MAX_CONNECTIONS_PER_USER = 12
/**
 * 全局连接上限。
 *
 * 数值依据：一条空闲的 SSE 连接在 Node 侧的开销是几十 KB 量级
 * （socket 缓冲 + 连接对象 + 心跳定时器），500 条约 15-30MB ——
 * 对 512MB 的 app 容器是安全余量。
 *
 * 为什么不设更小：100 个成员各开两三个标签页就能到 300 条。
 * 上限设得太紧会把**正常用户**挡在实时推送之外，那是修复引入的可用性问题。
 * 真正的防线是"每人 12 条"（挡住单点刷连接）+ 全站 500（挡住总量失控）。
 */
const MAX_TOTAL_CONNECTIONS = 500

/** 建立一条 SSE 连接。返回一个用于手动关闭的函数（超限时返回 null）。 */
export function subscribe(
  userId: string,
  sessionId: string,
  reply: FastifyReply,
): (() => void) | null {
  // 先判上限，再写响应头 —— 超限时应该干净地拒绝，而不是先建立连接再掐掉
  const own = connections.get(userId)
  if (own && own.size >= MAX_CONNECTIONS_PER_USER) {
    return null
  }
  if (totalConnections() >= MAX_TOTAL_CONNECTIONS) {
    return null
  }

  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 Caddy / nginx 的响应缓冲，否则事件会被攒着一起发
    'X-Accel-Buffering': 'no',
  })

  const id = `sse_${++connectionSeq}_${Date.now().toString(36)}`
  const conn: Connection = {
    id,
    userId,
    sessionId,
    reply,
    heartbeat: setInterval(() => {
      // 心跳同时承担"复核会话"的职责：会话被删/过期之后，这条连接最多再活
      // 一个心跳周期。主动关闭（登出、强制下线）会立刻断，这里是漏网兜底 ——
      // 比如会话行是被别的路径删掉的、或者某次主动关闭因为异常没走到。
      if (!sessionStillValid(conn.sessionId)) {
        closeConnection(conn, true)
        return
      }
      // 心跳**不再写库**。
      //
      // 以前这里调 touchPresence(userId, 0) 续期 last_seen。那个调用存在的理由是
      // 一段真实故障：在线判定曾经只看 last_seen 窗口（60 秒），而 touchPresence
      // 只在连接建立时调一次 —— 于是每个人连上 1 分钟之后就被判成离线，
      // 绿点闪一下然后永远变灰。
      //
      // 但那个故障真正的修法是"把 connection_count > 0 当成主依据"，不是
      // "让心跳多写几次库"。修完之后这段续期就成了纯粹的负担：
      // 100 条连接 = 4 次/秒的写事务，换来的信息量为零 —— "这个人还连着"
      // 是连接表自己就知道的事，比数据库更准。
      //
      // 现在心跳只做两件事：点查一次会话是否还有效（读），发一个 SSE 注释行。
      // 见 presence.ts 里关于"活连接表 + 库记录"的分工说明。
      writeEvent(conn, { type: 'ping' })
    }, 25_000),
    closed: false,
  }
  conn.heartbeat.unref?.()

  let set = connections.get(userId)
  if (!set) {
    set = new Set()
    connections.set(userId, set)
  }
  const wasOffline = set.size === 0
  set.add(conn)

  presenceConnected(userId)
  if (wasOffline) broadcastPresence(userId, true)

  writeEvent(conn, { type: 'hello', data: { connectionId: id, serverTime: Date.now() } })

  raw.on('close', () => closeConnection(conn))
  raw.on('error', () => closeConnection(conn))

  return () => closeConnection(conn)
}

function totalConnections(): number {
  let total = 0
  for (const set of connections.values()) total += set.size
  return total
}

/**
 * 关掉某个会话建立的所有连接（登出 / 单条会话被撤销）。
 *
 * 为什么必须主动关而不是等心跳：心跳最快也要 25 秒。共用电脑上点了"登出"，
 * 那 25 秒里消息照样推进来、未读数照样变 —— 用户以为已经退出了。
 *
 * 返回被关闭的连接数（测试与审计用）。
 */
export function disconnectSession(sessionId: string): number {
  let closed = 0
  // 先复制一份：closeConnection 会从 connections 里删条目，
  // 边遍历边删虽然对 Map 是安全的，但读起来容易让人怀疑。
  for (const set of [...connections.values()]) {
    for (const conn of [...set]) {
      if (conn.sessionId !== sessionId) continue
      closeConnection(conn, true)
      closed++
    }
  }
  return closed
}

/**
 * 关掉某个用户的**所有**连接（强制下线 / 改口令 / 停用账号 / 删除账号）。
 *
 * 这些动作调用的 revokeAllSessions 会把该用户的会话行全删掉，
 * 但库里删行不会通知一条已经建好的 SSE 流 —— 所以必须在这里配套关闭，
 * 否则"强制下线"对被偷走的那条 EventSource 完全无效。
 */
export function disconnectUser(userId: string): number {
  const set = connections.get(userId)
  if (!set) return 0
  const list = [...set]
  for (const conn of list) closeConnection(conn, true)
  return list.length
}

/**
 * 关掉**所有**连接（进程退出前调用）。
 *
 * 为什么必须在 `app.close()` 之前做：SSE 是长活连接，Fastify 的 close
 * 会等所有在途连接自然结束。不先断开的话，一次 `docker compose down`
 * 会一直卡到编排层的 SIGKILL —— 那样 SQLite 的 WAL 没有机会 checkpoint，
 * 正在跑的任务也没机会把状态收尾。
 */
export function disconnectAll(): number {
  let closed = 0
  for (const set of [...connections.values()]) {
    for (const conn of [...set]) {
      closeConnection(conn, true)
      closed++
    }
  }
  return closed
}

/** 推给指定用户的所有连接。 */
export function pushTo(userIds: Iterable<string>, event: RealtimeEvent): void {
  for (const userId of userIds) {
    const set = connections.get(userId)
    if (!set) continue
    for (const conn of set) writeEvent(conn, event)
  }
}

/**
 * 广播给所有在线连接。
 *
 * 只适用于**没有隐藏信息**的广播（棋类对局的落子、房间状态变化）。
 * 狼人杀那类需要按玩家视角裁剪状态，必须改成定向推送 —— 到那时再引入
 * room→subscribers 的映射。现在社团规模下连接数很少，做精确订阅的收益
 * 抵不上多维护一份映射的复杂度。
 */
export function broadcast(event: RealtimeEvent): void {
  for (const set of connections.values()) {
    for (const conn of set) writeEvent(conn, event)
  }
}

function broadcastPresence(userId: string, online: boolean): void {
  // 广播给所有在线的人。社团规模下这个集合很小（几十个连接），
  // 不做"只发给有共同会话的人"的优化 —— 那需要为每次上下线查一遍会话表，
  // 反而更贵。
  for (const set of connections.values()) {
    for (const conn of set) {
      if (conn.userId === userId) continue
      writeEvent(conn, { type: 'presence', data: { userId, online } })
    }
  }
}

/** 在线人数与连接数（健康检查/管理页用）。 */
export function realtimeStats(): { users: number; connections: number } {
  let total = 0
  for (const set of connections.values()) total += set.size
  return { users: connections.size, connections: total }
}

/**
 * 当前**确实连着** SSE 的用户。
 *
 * 与 chat.ts 的 onlineUserIds() 的区别：那个是"在线状态"（给界面显示绿点用的，
 * 带 60 秒宽限期，写库有延迟），这个是**实时连接表本身**，反映此刻真实连着谁。
 *
 * 按人推送状态时必须用这一个。理由：漏推的后果不是"状态显示不准"，而是
 * **界面直接卡住** —— 比如象棋，某个人没收到落子事件，他的棋盘就停在旧局面上，
 * 而且因为 myTurn 没更新，他连点都点不动。用在线状态窗口去驱动推送，
 * 等于让一次写库延迟变成一个用户玩不了棋。
 */
export function connectedUserIds(): string[] {
  return [...connections.keys()]
}
