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
 * 队列条目有两种来源，靠 source 列区分：
 *   · 'file'   —— 引用文件系统的 audio 节点（复用内容寻址存储与权限体系），
 *                 不单独上传：歌已经在文件区里了，听歌房只负责"排播"；
 *   · 'online' —— 引用在线曲库的哔哩哔哩曲目，nodeId 是 bi:BV... 这样的
 *                 "不透明引用符"（见 music-online.ts 的 ONLINE_TRACK_ID）。
 *
 * ⚠️ 两种曲目的**同步机制完全相同**：服务端只维护权威 positionMs +
 * startedAt + playedToken，客户端照旧用 music-clock 做漂移校正。在线曲目
 * 的低延迟靠服务端磁盘缓存 + 预热（music-online.ts），不是另造一套同步。
 */
import { getDb, newId, now } from './db.ts'
import { HttpError, canRead, getNode } from './files.ts'
import { parseOnlineTrackId, prewarmOnlineTrack } from './music-online.ts'

/**
 * 曲目来源。
 *
 * `nodeId` 是**不透明引用符**：文件曲目就是 nodes.id 原样，在线曲目是 bi:BV...
 * 前端只看它的前缀决定走哪条流通道（bi: → /api/music/online/stream），
 * 服务端靠这一列决定要不要去查 nodes 表。
 */
export type MusicTrackSource = 'file' | 'online'

export interface MusicQueueItem {
  id: string
  /** 不透明引用符：nodes.id（source='file'）或 bi:BV...（source='online'）。 */
  nodeId: string
  source: MusicTrackSource
  name: string
  addedBy: string
  addedByName: string
  addedAt: number
}

export interface MusicNowPlaying {
  nodeId: string
  source: MusicTrackSource
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

/** 在线曲目标题的长度上限（标题来自前端回传的搜索结果，必须夹住）。 */
const MAX_ONLINE_TITLE = 200

interface RawQueueRow {
  id: string
  node_id: string
  source: string
  online_title: string | null
  added_by: string
  added_at: number
  name: string | null
  added_by_name: string
}

function rawToQueueItem(row: RawQueueRow): MusicQueueItem {
  return {
    id: row.id,
    nodeId: row.node_id,
    source: row.source === 'online' ? 'online' : 'file',
    name: row.name ?? '（在线曲目）',
    addedBy: row.added_by,
    addedByName: row.added_by_name,
    addedAt: row.added_at,
  }
}

/**
 * 队列查询。
 *
 * 三个细节都不能省：
 *   · **LEFT JOIN** nodes：在线曲目没有节点行，INNER JOIN 会让它们整条消失；
 *   · COALESCE(n.name, q.online_title)：名字有两个来源 —— 文件看节点、在线看标题；
 *   · 过滤条件必须是"在线条目一律放行，文件条目才查 deleted_at"。删除是软删除，
 *     节点行还在，删掉一个文件夹时里面的歌会带着 deleted_at 留在队列里 ——
 *     不过滤的话厅里会一直"播放"一首取不到流的歌，而 enqueueTrack 看到
 *     hasNow 为真又不会再启动新歌。
 */
const QUEUE_SELECT = `
  SELECT q.id, q.node_id, q.source, q.online_title, q.added_by, q.added_at,
         COALESCE(n.name, q.online_title) AS name,
         u.display_name AS added_by_name
    FROM music_queue q
    LEFT JOIN nodes n ON n.id = q.node_id
    JOIN users u ON u.id = q.added_by
   WHERE q.source = 'online' OR n.deleted_at IS NULL
`

/**
 * 自愈：正在播的那首歌如果已经被删掉（软删或行没了），推进到下一首。
 *
 * 删除文件夹时只对根节点调过 purge（历史上），子节点是软删 —— 队列行和
 * music_state 都会指向一个取不到流的节点。这一层兜底保证"任何一次拉房间"
 * 都不会把这样的僵尸状态返回给客户端。
 *
 * ⚠️ **只对 source='file' 生效**：在线曲目的 nodeId 是 bi:BV...，在 nodes 表里
 * 查不到任何行。照旧逻辑会被判成"文件已删除"，于是每一次拉房间都会把正在播的
 * 在线曲目切掉 —— 表现是"厅里刚排的在线歌一秒就自己跳走"。这比显示不出来严重得多。
 */
function healDeletedCurrent(): void {
  const db = getDb()
  const state = db.prepare('SELECT node_id, source FROM music_state WHERE id = 1').get() as
    | { node_id: string; source: string }
    | undefined
  if (!state) return
  if (state.source === 'online') return
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
        source: MusicTrackSource
        online_title: string | null
        started_by: string
        started_at: number
        played_token: number
        paused_position_ms: number
        paused_at: number | null
        paused_by: string | null
      }
    | undefined
  const userNameOf = (userId: string): string =>
    (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
      | { display_name: string }
      | undefined)?.display_name ?? '（已注销）'

  /**
   * 曲目的显示名。
   *
   * 在线曲目**不能**去 nodes 表查：nodeId 是 bi:BV...，查不到会被兜底成
   * "（文件已删除）"，于是厅里显示一条"已删除"的在线曲目 —— 而它其实好好的。
   */
  const trackNameOf = (ref: string, source: MusicTrackSource, onlineTitle: string | null): string => {
    if (source === 'online') return onlineTitle ?? '（在线曲目）'
    const row = getDb()
      .prepare('SELECT name FROM nodes WHERE id = ? AND deleted_at IS NULL')
      .get(ref) as { name: string } | undefined
    return row?.name ?? '（文件已删除）'
  }

  const nowPlaying = state
    ? (() => {
        const name = trackNameOf(state.node_id, state.source, state.online_title)
        const userName = userNameOf(state.started_by)
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
          source: state.source,
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
  // 上一首进入"刚退场"宽限：慢设备的在途 Range 请求不该在切歌瞬间变成 403。
  // key 是引用符字符串，所以文件曲目和在线曲目**都**天然适用。
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
      `INSERT INTO music_state (id, node_id, source, online_title, started_by, started_at, played_token, paused_position_ms, paused_at, paused_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, source = excluded.source,
                                     online_title = excluded.online_title,
                                     started_by = excluded.started_by, started_at = excluded.started_at,
                                     played_token = excluded.played_token,
                                     paused_position_ms = 0, paused_at = NULL, paused_by = NULL`,
    ).run(head.node_id, head.source, head.online_title, head.added_by, now(), token)
  } else {
    // 队列空了就停播（清空当前曲目），不自动循环 —— 循环播谁的歌是个偏好问题
    db.prepare('DELETE FROM music_state WHERE id = 1').run()
  }

  // 换完曲立刻给"正在播的那首 + 队头那首"预热磁盘缓存。
  prewarmRoomQueue()
}

/**
 * 给房间里的在线曲目预热磁盘缓存（fire-and-forget）。
 *
 * 为什么放在 startNext 里而不是路由里：排歌、切歌、播完上报、自愈都会走到
 * startNext，而"下一首是哪首"只有服务端知道。放在这个唯一出口，客户端
 * 不可能漏掉预热；写完 broadcast 之后下一次拉房间也已经是热的。
 *
 * 只预热"在播的那首 + 队头那首"：整个队列都预热等于把没人会听的歌也下一遍，
 * 而 LRU 就那么大。任何失败都只是没预热上（prewarmOnlineTrack 自己吞掉异常），
 * 播放该走的代理路径照样走得通 —— 预热是优化，不是播放的前置条件。
 */
function prewarmRoomQueue(): void {
  const db = getDb()
  const refs = new Set<string>()
  const state = db.prepare('SELECT node_id, source FROM music_state WHERE id = 1').get() as
    | { node_id: string; source: string }
    | undefined
  if (state?.source === 'online') refs.add(state.node_id)
  const head = db
    .prepare("SELECT node_id FROM music_queue WHERE source = 'online' ORDER BY added_at ASC LIMIT 1")
    .get() as { node_id: string } | undefined
  if (head) refs.add(head.node_id)
  for (const ref of refs) {
    // 绝对不 await：一次预热要下整首歌，把它塞进请求路径就是"排歌要等 20 秒"。
    prewarmOnlineTrack(ref).catch(() => {})
  }
}

/** 队列上限检查（两种曲目共用，在线曲目不额外占额度）。 */
function assertQueueRoom(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM music_queue').get() as { c: number }).c
  if (count >= MAX_QUEUE) throw new HttpError(400, `队列最多排 ${MAX_QUEUE} 首，先听听再说`)
}

/**
 * 入队后的共同尾巴：没有正在播的就立刻开播，再把房间视图还给调用方。
 *
 * 两种曲目必须走同一个结尾 —— "首首自动开播"是听歌房的既有语义，
 * 不能因为这首是在线曲目就退化成"要等人按播放"。
 */
function afterEnqueue(userId: string): MusicRoomView {
  const db = getDb()
  const hasNow = db.prepare('SELECT id FROM music_state WHERE id = 1').get()
  if (!hasNow) startNext()
  // 队列头可能正是刚排进来的在线曲目：现在就预热，切歌那一刻首字节来自本地磁盘
  prewarmRoomQueue()
  return musicRoomView(userId)
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

  assertQueueRoom()
  getDb()
    .prepare(
      'INSERT INTO music_queue (id, node_id, source, online_title, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(newId('mq'), nodeId, 'file', null, userId, now())
  return afterEnqueue(userId)
}

/**
 * 把一首**在线曲目**（哔哩哔哩）排进队列。
 *
 * 与 enqueueTrack 的差别只有三处，其余（成员校验 / 队列上限 / 首首自动开播）
 * 刻意保持一致 —— 否则"在线曲目"会变成听歌房里一条行为不同的旁路：
 *   ① 引用符是 bi:BV...，没有节点行可查，所以这里只校验**格式**。这不是偷懒：
 *      那个正则就是 SSRF 防线（见 parseOnlineTrackId），而"这首到底有没有音轨"
 *      只能等真正播放时由上游回答（那时才 404，与单人试听完全一致）；
 *   ② 名字来自前端回传的搜索结果标题，落在 music_queue.online_title 里；
 *   ③ 入队后立刻预热磁盘缓存，切到它时首字节来自本地磁盘而不是 CDN。
 */
export function enqueueOnlineTrack(ref: string, title: string, userId: string): MusicRoomView {
  requireMember(userId)
  // 回写规范形态：库里的引用符只有 bi:<bvid> 一种写法，前端传 bi:BVxxx 之外
  // 的任何变体（大小写、空白、多余前缀）都在这里被拒，而不是带着脏值进库。
  const bvid = parseOnlineTrackId(ref)
  if (!bvid) throw new HttpError(400, '在线曲目 ID 不合法（只接受 bi:BV...）')
  const onlineTitle = typeof title === 'string' ? title.trim().slice(0, MAX_ONLINE_TITLE) : ''
  if (!onlineTitle) throw new HttpError(400, '在线曲目缺少歌名')

  assertQueueRoom()
  getDb()
    .prepare(
      'INSERT INTO music_queue (id, node_id, source, online_title, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(newId('mq'), `bi:${bvid}`, 'online', onlineTitle, userId, now())
  return afterEnqueue(userId)
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
