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

export interface MusicRoomView {
  nowPlaying: MusicNowPlaying | null
  queue: MusicQueueItem[]
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

const QUEUE_SELECT = `
  SELECT q.id, q.node_id, q.added_by, q.added_at, n.name, u.display_name AS added_by_name
    FROM music_queue q
    JOIN nodes n ON n.id = q.node_id
    JOIN users u ON u.id = q.added_by
`

export function musicRoomView(): MusicRoomView {
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
        `SELECT n.name, u.display_name AS user_name FROM nodes n, users u WHERE n.id = ? AND u.id = ?`,
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
  return { nowPlaying, queue }
}

function startNext(): void {
  const db = getDb()
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
  const db = getDb()
  const state = db.prepare('SELECT * FROM music_state WHERE id = 1').get() as
    | { started_at: number; paused_at: number | null }
    | undefined
  if (!state) throw new HttpError(400, '现在没有在放的歌')
  if (state.paused_at !== null) return musicRoomView()
  const position = Math.max(0, now() - state.started_at)
  db.prepare('UPDATE music_state SET paused_at = ?, paused_position_ms = ?, paused_by = ? WHERE id = 1').run(
    now(),
    position,
    userId,
  )
  return musicRoomView()
}

/** 继续：把 started_at 往回拨"已播时长"，进度就接上了。 */
export function resumeRoom(): MusicRoomView {
  const db = getDb()
  const state = db.prepare('SELECT * FROM music_state WHERE id = 1').get() as
    | { paused_at: number | null; paused_position_ms: number }
    | undefined
  if (!state) throw new HttpError(400, '现在没有在放的歌')
  if (state.paused_at === null) return musicRoomView()
  db.prepare('UPDATE music_state SET started_at = ?, paused_at = NULL, paused_by = NULL WHERE id = 1').run(
    now() - state.paused_position_ms,
  )
  return musicRoomView()
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
  return Boolean(playing)
}

/** 把歌加进队列。必须是 audio 节点、且加歌人能读到（他人私有的直接拒）。 */
export function enqueueTrack(nodeId: string, userId: string, isAdmin: boolean): MusicRoomView {
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
  return musicRoomView()
}

/**
 * 切到下一首（"跳过"）。歌是大家的：任何登录成员都能跳过 —— 这是听歌厅
 * 的社交契约，不是权限漏洞（谁都有遥控器的客厅才是客厅）。
 */
export function skipTrack(userId: string): MusicRoomView {
  const db = getDb()
  if (!db.prepare('SELECT id FROM music_state WHERE id = 1').get()) {
    throw new HttpError(400, '现在没有在放歌')
  }
  startNext()
  return musicRoomView()
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
  return musicRoomView()
}

/**
 * 播放器自然播完的上报。带 playedToken 比对：换曲之后旧的上报直接忽略 ——
 * 多个客户端都会触发 ended，只有"当前曲目的 ended"才算数（第一个到达的
 * 生效，其余因 token 已变而被拒）。
 */
export function reportEnded(userId: string, playedToken: number): { advanced: boolean } {
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
  db.prepare('DELETE FROM music_queue WHERE node_id = ?').run(nodeId)
  const state = db.prepare('SELECT node_id FROM music_state WHERE id = 1').get() as
    | { node_id: string }
    | undefined
  if (state?.node_id === nodeId) startNext()
}
