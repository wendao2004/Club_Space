/**
 * 听歌房（轻量版）。
 *
 * u-wave 的 DJ 队列思路，全部自己实现。轻量版的边界（刻意不做）：
 *
 *  - **不做逐字节音频同步**：服务端只维护"当前曲目 + 起播时间戳"，
 *    客户端打开时 seek 到 (now - startedAt)，误差就是各自的加载耗时。
 *    对"挂着的听歌厅"完全够用，换来的是零媒体服务基础设施。
 *  - **不做房内聊天**：全站有聊天应用，进房间再聊一套是重复建设。
 *  - **自动切歌靠客户端上报**：服务端拿不到音频时长（不解析音频头），
 *    谁的播放器先 natural ended 谁上报；服务端用 played_token 比对，
 *    旧曲目的上报动不了新曲目。播放器全关了就停在当前曲目 —— 下一个
 *    进来的人会直接从进度处继续。
 *
 * 队列条目引用文件系统的 audio 节点（复用内容寻址存储与权限体系），
 * 不单独上传 —— 歌已经在文件区里了，听歌房只负责"排播"。
 */
import { getDb, newId, now } from './db.ts'
import { HttpError, canRead, getNode } from './files.ts'

export interface MusicQueueItem {
  id: string
  nodeId: string
  name: string
  addedBy: string
  addedByName: string
  addedAt: number
}

export interface MusicNowPlaying {
  nodeId: string
  name: string
  startedBy: string
  startedByName: string
  startedAt: number
  /** 暂停状态：true 时 positionMs 是固定进度，startedAt 不再增长。 */
  paused: boolean
  /** 当前进度（毫秒，服务端权威，客户端直接用，不许自己加减时钟）。 */
  positionMs: number
  pausedByName: string | null
  /** 客户端上报 ended 时必须带上的令牌（每次换曲自增）。 */
  playedToken: number
}

export interface MusicMember {
  id: string
  name: string
  /** 什么时候加入的（毫秒）。 */
  joinedAt: number
}

export interface MusicRoomView {
  nowPlaying: MusicNowPlaying | null
  queue: MusicQueueItem[]
  /** 在场成员（90 秒内有心跳的）。 */
  members: MusicMember[]
  /** 看这个响应的人自己是否在厅里。 */
  inRoom: boolean
}

/**
 * 超过这么久没心跳就算离开（前端每 30s 一次，容忍三次丢包）。
 *
 * 90s → 120s 是在后台标签页定时器被节流后仍然活着的前提：Chrome 隐藏页
 * 的定时器可能被压到 1 次/分钟，90s 窗口会在两次心跳之间到期，人还在听
 * 歌却被判离开 —— 下一次拉房间时 `inRoom=false`，播放器被整个卸载。
 */
const MEMBER_TTL_MS = 120_000

/**
 * 刚离开当前曲目的那首，在这么多毫秒内仍然允许取流。
 *
 * 切歌瞬间，慢设备的 Range 请求还在路上；如果它立刻收到 403，这一整首
 * 就会静音（浏览器不会因为一次 403 自动重试）。给一个短暂的宽限，
 * 只影响"刚退场的那一首"，不是长期共享。
 */
const RECENT_GRACE_MS = 15_000
const recentlyPlayed = new Map<string, number>()

/** 这个人现在在不在厅里（90 秒内有心跳）。 */
export function isMember(userId: string): boolean {
  if (!userId) return false
  const row = getDb()
    .prepare('SELECT last_seen FROM music_members WHERE user_id = ?')
    .get(userId) as { last_seen: number } | undefined
  return Boolean(row && row.last_seen >= now() - MEMBER_TTL_MS)
}

/** 加入（幂等）。已经在了就只续心跳。 */
export function joinRoom(userId: string): MusicRoomView {
  const db = getDb()
  const ts = now()
  db.prepare(
    `INSERT INTO music_members (user_id, joined_at, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(userId, ts, ts)
  return musicRoomView(userId)
}

/**
 * 心跳：不发广播（30 秒一次，广播会把 SSE 刷满）。
 *
 * 返回"这条心跳有没有命中一行"。**不用 upsert**：显式点过「离开」的人
 * 不该因为一个迟到的定时器又被加回厅里；这里只续期，不复活。客户端拿到
 * `inRoom=false` 后自己决定要不要重新加入（它知道自己是不是想留在厅里）。
 */
export function touchMember(userId: string): boolean {
  const result = getDb()
    .prepare('UPDATE music_members SET last_seen = ? WHERE user_id = ?')
    .run(now(), userId)
  return result.changes > 0
}

/** 离开。 */
export function leaveRoom(userId: string): MusicRoomView {
  getDb().prepare('DELETE FROM music_members WHERE user_id = ?').run(userId)
  return musicRoomView(userId)
}

/**
 * 需要在厅里才能做的动作（排歌/切歌/暂停/上报播完）。
 *
 * 不做这个校验的话，"打开窗口就在厅里"的老行为会残留 —— 用户明确要求
 * 加入才是成员。
 */
export function requireMember(userId: string): void {
  if (!isMember(userId)) throw new HttpError(403, '先加入听歌房再操作')
}



const MAX_QUEUE = 50

interface RawQueueRow {
  id: string
  node_id: string
  added_by: string
  added_at: number
  name: string
  added_by_name: string
}

function rawToQueueItem(row: RawQueueRow): MusicQueueItem {
  return {
    id: row.id,
    nodeId: row.node_id,
    name: row.name,
    addedBy: row.added_by,
    addedByName: row.added_by_name,
    addedAt: row.added_at,
  }
}

/**
 * 队列查询。
 *
 * `n.deleted_at IS NULL` 不能省：删除是软删除，节点行还在，FK 级联不会
 * 触发。删掉一个文件夹时，里面的歌会带着 deleted_at 留在队列里 —— 不做
 * 过滤的话，厅里会一直"播放"一首取不到流的歌，而 enqueueTrack 看到
 * hasNow 为真又不会再启动新歌。
 */
const QUEUE_SELECT = `
  SELECT q.id, q.node_id, q.added_by, q.added_at, n.name, u.display_name AS added_by_name
    FROM music_queue q
    JOIN nodes n ON n.id = q.node_id
    JOIN users u ON u.id = q.added_by
   WHERE n.deleted_at IS NULL
`

/**
 * 自愈：正在播的那首歌如果已经被删掉（软删或行没了），推进到下一首。
 *
 * 删除文件夹时只对根节点调过 purge（历史上），子节点是软删 —— 队列行和
 * music_state 都会指向一个取不到流的节点。这一层兜底保证"任何一次拉房间"
 * 都不会把这样的僵尸状态返回给客户端。
 */
function healDeletedCurrent(): void {
  const db = getDb()
  const state = db.prepare('SELECT node_id FROM music_state WHERE id = 1').get() as
    | { node_id: string }
    | undefined
  if (!state) return
  const row = db.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get(state.node_id) as
    | { deleted_at: number | null }
    | undefined
  if (row && row.deleted_at === null) return
  startNext()
}

export function musicRoomView(viewerId = ''): MusicRoomView {
  healDeletedCurrent()
  const state = getDb().prepare('SELECT * FROM music_state WHERE id = 1').get() as
    | {
        node_id: string
        started_by: string
        started_at: number
        played_token: number
        paused_position_ms: number
        paused_at: number | null
        paused_by: string | null
      }
    | undefined
  const nameOf = (nodeId: string, userId: string): { name: string; userName: string } => {
    const row = getDb()
      .prepare(
        `SELECT n.name, u.display_name AS user_name FROM nodes n, users u
          WHERE n.id = ? AND u.id = ? AND n.deleted_at IS NULL`,
      )
      .get(nodeId, userId) as { name: string; user_name: string } | undefined
    return { name: row?.name ?? '（文件已删除）', userName: row?.user_name ?? '（已注销）' }
  }

  const nowPlaying = state
    ? (() => {
        const { name, userName } = nameOf(state.node_id, state.started_by)
        const paused = state.paused_at !== null
        // 服务端算出当前进度，客户端只用这个数 + 自己测得的时钟偏移
        const positionMs = paused
          ? state.paused_position_ms
          : Math.max(0, now() - state.started_at)
        const pausedByRow = state.paused_by
          ? (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(state.paused_by) as
              | { display_name: string }
              | undefined)
          : undefined
        return {
          nodeId: state.node_id,
          name,
          startedBy: state.started_by,
          startedByName: userName,
          startedAt: state.started_at,
          playedToken: state.played_token,
          paused,
          positionMs,
          pausedByName: pausedByRow?.display_name ?? null,
        }
      })()
    : null

  const queue = (getDb().prepare(`${QUEUE_SELECT} ORDER BY q.added_at ASC`).all() as unknown as RawQueueRow[]).map(
    rawToQueueItem,
  )
  const members = (
    getDb()
      .prepare(
        `SELECT m.user_id, m.joined_at, u.display_name
           FROM music_members m JOIN users u ON u.id = m.user_id
          WHERE m.last_seen >= ?
          ORDER BY m.joined_at ASC`,
      )
      .all(now() - MEMBER_TTL_MS) as unknown as Array<{ user_id: string; joined_at: number; display_name: string }>
  ).map((r) => ({ id: r.user_id, name: r.display_name, joinedAt: r.joined_at }))

  return { nowPlaying, queue, members, inRoom: isMember(viewerId) }
}

function startNext(): void {
  const db = getDb()
  // 上一首进入"刚退场"宽限：慢设备的在途 Range 请求不该在切歌瞬间变成 403
  const previous = db.prepare('SELECT node_id FROM music_state WHERE id = 1').get() as
    | { node_id: string }
    | undefined
  if (previous?.node_id) recentlyPlayed.set(previous.node_id, now())
  for (const [nodeId, at] of recentlyPlayed) {
    if (at < now() - RECENT_GRACE_MS) recentlyPlayed.delete(nodeId)
  }

  const head = db
    .prepare(`${QUEUE_SELECT} ORDER BY q.added_at ASC LIMIT 1`)
    .get() as unknown as RawQueueRow | undefined

  const token = ((db.prepare('SELECT played_token FROM music_state WHERE id = 1').get() as
    | { played_token: number }
    | undefined)?.played_token ?? 0) + 1

  if (head) {
    db.prepare('DELETE FROM music_queue WHERE id = ?').run(head.id)
    db.prepare(
      `INSERT INTO music_state (id, node_id, started_by, started_at, played_token, paused_position_ms, paused_at, paused_by)
       VALUES (1, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, started_by = excluded.started_by,
                                     started_at = excluded.started_at, played_token = excluded.played_token,
                                     paused_position_ms = 0, paused_at = NULL, paused_by = NULL`,
    ).run(head.node_id, head.added_by, now(), token)
  } else {
    // 队列空了就停播（清空当前曲目），不自动循环 —— 循环播谁的歌是个偏好问题
    db.prepare('DELETE FROM music_state WHERE id = 1').run()
  }
}

/**
 * 暂停（同一个厅，谁都能按 —— 跟切歌一个权限级别）。
 *
 * 记下当前进度到 paused_position_ms，started_at 就不再被依赖。
 */
export function pauseRoom(userId: string): MusicRoomView {
  requireMember(userId)
  const db = getDb()
  const state = db.prepare('SELECT * FROM music_state WHERE id = 1').get() as
    | { started_at: number; paused_at: number | null }
    | undefined
  if (!state) throw new HttpError(400, '现在没有在放的歌')
  if (state.paused_at !== null) return musicRoomView(userId)
  const position = Math.max(0, now() - state.started_at)
  db.prepare('UPDATE music_state SET paused_at = ?, paused_position_ms = ?, paused_by = ? WHERE id = 1').run(
    now(),
    position,
    userId,
  )
  return musicRoomView(userId)
}

/** 继续：把 started_at 往回拨"已播时长"，进度就接上了。 */
export function resumeRoom(userId: string): MusicRoomView {
  const db = getDb()
  const state = db.prepare('SELECT * FROM music_state WHERE id = 1').get() as
    | { paused_at: number | null; paused_position_ms: number }
    | undefined
  if (!state) throw new HttpError(400, '现在没有在放的歌')
  if (state.paused_at === null) return musicRoomView(userId)
  db.prepare('UPDATE music_state SET started_at = ?, paused_at = NULL, paused_by = NULL WHERE id = 1').run(
    now() - state.paused_position_ms,
  )
  return musicRoomView(userId)
}

/**
 * 这首歌是不是"厅里的歌"（在队列里或正在播）。
 *
 * 用作 /api/music/stream 的鉴权：排进听歌房 = 主动把它分享给全厅，
 * 所以不再要求 `canRead` —— 否则把私人目录的歌排进来时，除上传者外的
 * 所有人都拿不到音频流（浏览器 <audio> 静默失败，表现为"别人没声音"）。
 */
export function isRoomTrack(nodeId: string): boolean {
  const db = getDb()
  const inQueue = db.prepare('SELECT 1 FROM music_queue WHERE node_id = ? LIMIT 1').get(nodeId)
  if (inQueue) return true
  const playing = db.prepare('SELECT 1 FROM music_state WHERE id = 1 AND node_id = ?').get(nodeId)
  if (playing) return true
  // 刚退场的上一首：切歌瞬间还在路上的 Range 请求不该 403
  const endedAt = recentlyPlayed.get(nodeId)
  return endedAt !== undefined && endedAt >= now() - RECENT_GRACE_MS
}

/** 把歌加进队列。必须是 audio 节点、且加歌人能读到（他人私有的直接拒）。 */
export function enqueueTrack(nodeId: string, userId: string, isAdmin: boolean): MusicRoomView {
  requireMember(userId)
  const node = getNode(nodeId)
  if (!node || node.kind !== 'file' || node.deleted_at !== null) {
    throw new HttpError(404, '这个文件不存在')
  }
  if (!node.mime?.startsWith('audio/')) throw new HttpError(400, '只能排播音频文件')
  if (!canRead(node, userId, isAdmin)) throw new HttpError(403, '这个文件你没有权限访问')

  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) AS c FROM music_queue').get() as { c: number }).c
  if (count >= MAX_QUEUE) throw new HttpError(400, `队列最多排 ${MAX_QUEUE} 首，先听听再说`)

  db.prepare('INSERT INTO music_queue (id, node_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(
    newId('mq'),
    nodeId,
    userId,
    now(),
  )

  // 没有正在播的就直接开播（首首歌不用等人按播放）
  const hasNow = db.prepare('SELECT id FROM music_state WHERE id = 1').get()
  if (!hasNow) startNext()
  return musicRoomView(userId)
}

/**
 * 切到下一首（"跳过"）。歌是大家的：任何登录成员都能跳过 —— 这是听歌厅
 * 的社交契约，不是权限漏洞（谁都有遥控器的客厅才是客厅）。
 */
export function skipTrack(userId: string): MusicRoomView {
  requireMember(userId)
  const db = getDb()
  if (!db.prepare('SELECT id FROM music_state WHERE id = 1').get()) {
    throw new HttpError(400, '现在没有在放歌')
  }
  startNext()
  return musicRoomView(userId)
}

/**
 * 把歌从队列里撤下来。
 *
 * 自己的随便撤；管理员可以撤任何人的 —— 否则队列被塞满时（50 首上限）
 * 除了"切歌"没有别的出路，而切歌只在当前曲目上有效，队列深处的东西
 * 谁都动不了。
 */
export function removeQueued(itemId: string, userId: string, isAdmin = false): MusicRoomView {
  const row = getDb().prepare('SELECT added_by FROM music_queue WHERE id = ?').get(itemId) as
    | { added_by: string }
    | undefined
  if (!row) throw new HttpError(404, '队列里没有这首歌')
  if (row.added_by !== userId && !isAdmin) throw new HttpError(403, '只能撤下自己排的歌')
  getDb().prepare('DELETE FROM music_queue WHERE id = ?').run(itemId)
  return musicRoomView(userId)
}

/**
 * 播放器自然播完的上报。带 playedToken 比对：换曲之后旧的上报直接忽略 ——
 * 多个客户端都会触发 ended，只有"当前曲目的 ended"才算数（第一个到达的
 * 生效，其余因 token 已变而被拒）。
 */
export function reportEnded(userId: string, playedToken: number): { advanced: boolean } {
  requireMember(userId)
  const state = getDb().prepare('SELECT played_token FROM music_state WHERE id = 1').get() as
    | { played_token: number }
    | undefined
  if (!state || state.played_token !== playedToken) return { advanced: false }
  // 暂停状态下不上报切歌（否则"暂停"会被别人的 ended 事件推着走）
  const pausedRow = getDb().prepare('SELECT paused_at FROM music_state WHERE id = 1').get() as
    | { paused_at: number | null }
    | undefined
  if (pausedRow?.paused_at != null) return { advanced: false }
  startNext()
  return { advanced: true }
}

/**
 * 文件删除前清听歌房引用（**必须在节点行删除之前调用** —— 推进到下一首
 * 需要读到队列里的节点名；节点行没了之后 FK 级联也会自己清行，但那样
 * 厅里就断声了，我们要的是"跳过被删的那首接着放"）。
 */
export function purgeDeletedNode(nodeId: string): void {
  const db = getDb()
  // 删除是递归的（删文件夹会把整个子树软删），但历史上这里只处理了根节点。
  // 不展开子树的话，子节点会带着 deleted_at 留在队列/当前曲里，表现为
  // "厅里显示在放，所有人没声音"，而且 enqueueTrack 因为 hasNow 为真不会
  // 启动新歌 —— 只能靠手动切歌救。
  const ids: string[] = []
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    ids.push(id)
    const children = db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(id) as Array<{
      id: string
    }>
    for (const child of children) stack.push(child.id)
  }

  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(`DELETE FROM music_queue WHERE node_id IN (${placeholders})`).run(...ids)

  const state = db.prepare('SELECT node_id, paused_at, paused_by FROM music_state WHERE id = 1').get() as
    | { node_id: string; paused_at: number | null; paused_by: string | null }
    | undefined
  if (!state || !ids.includes(state.node_id)) return

  const wasPaused = state.paused_at !== null
  const pausedBy = state.paused_by
  startNext()
  // 暂停是厅级状态：删掉正在播的文件不应该把它变成"自动继续播放"。
  // 推进到下一首后仍然停在 0 位置，等有人按继续。
  if (wasPaused && pausedBy !== null) {
    db.prepare(
      'UPDATE music_state SET paused_at = ?, paused_position_ms = 0, paused_by = ? WHERE id = 1',
    ).run(now(), pausedBy)
  }
}
