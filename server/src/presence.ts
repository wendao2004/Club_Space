/**
 * 在线状态。
 *
 * 判定一个用户"在线"有两条来源，两条都要，但职责不同：
 *
 *   1. **进程内的活连接表**（`live`）。这是"此刻真的连着 SSE"的唯一真相，
 *      连上 +1、断开 -1，纯内存、零成本、精确到毫秒。
 *   2. **库里的 `presence` 行**。只在上下线时写一次，用来跨进程重启保留
 *      "上次动过"的痕迹，也是 `connection_count` 的宿主。
 *
 * 为什么要把这两件事分开写：心跳以前每 25 秒刷新一次 `last_seen`，
 * 100 条连接就是 4 次/秒的写事务。那些写**没有换来任何信息** ——
 * "这个人还连着"这件事，连接表本身就知道，而且比数据库更准。
 * 现在心跳只发一个 SSE 注释行、顺带点查一次会话是否还有效（读），
 * 整个心跳路径不再产生任何写入。
 *
 * ⚠️ 这里出过一次真故障，值得留档：早先 `onlineUserIds()` **只**看
 * `last_seen` 窗口，而 `touchPresence` 只在连接建立时调用一次 ——
 * 于是每个人连上 1 分钟之后就被判成离线，界面上绿点闪一下就永远变灰，
 * 哪怕连接好端端开着、人正在打字。
 *
 * 现在的主依据是 `connection_count > 0`（干净断开时立刻归零，比等窗口过期准得多），
 * `last_seen` 窗口退化成兜底：进程被 kill -9 时没机会执行断开逻辑，
 * 计数会残留，时间窗保证这类幽灵连接最多活 60 秒（启动时还会再清一次）。
 */
import { getDb, now } from './db.ts'

/** 在线判定窗口。兜底用，主依据是连接计数。 */
const ONLINE_WINDOW_MS = 60_000

/**
 * 每个用户当前有几条活连接。
 *
 * 用内存而不是只信库里的计数：`touchPresence` 要写库，写库可能因 SQLITE_BUSY
 * 失败；而"这个 socket 还开着"是进程自己就能回答的问题，没有理由去问数据库。
 */
const live = new Map<string, number>()

/**
 * 建立一条连接。
 *
 * 库里的 `last_seen` 仍然要刷 —— 那是**给人看的**（"上次出现在线是什么时候"），
 * 而且只在上下线这种低频动作里写，一天几百次，不值得为它做优化。
 */
export function presenceConnected(userId: string): void {
  live.set(userId, (live.get(userId) ?? 0) + 1)
  getDb()
    .prepare(
      `INSERT INTO presence (user_id, last_seen, connection_count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         connection_count = MAX(0, presence.connection_count + 1)`,
    )
    .run(userId, now())
}

/**
 * 断开一条连接：只减计数，**不动 last_seen**。
 *
 * 早先这里走的是 `touchPresence(userId, -1)`，它会把 `last_seen` 一起刷成 now ——
 * 于是刚关掉页面的人在接下来整整 60 秒里仍被判成在线。
 * 用户看到的是"明明退出了，头像还是亮的"。
 */
export function presenceDisconnected(userId: string): void {
  const next = (live.get(userId) ?? 1) - 1
  if (next <= 0) live.delete(userId)
  else live.set(userId, next)

  try {
    getDb()
      .prepare(
        'UPDATE presence SET connection_count = MAX(0, connection_count - 1) WHERE user_id = ?',
      )
      .run(userId)
  } catch {
    // 库写在断开路径上，失败不该把关闭流程搞挂 —— 内存计数已经减了，
    // 下次启动的 resetPresenceCounts 会把残留清零。
  }
}

/**
 * 进程启动时把所有连接计数清零。
 *
 * `connection_count` 的语义是"此刻有几条 SSE 连接"，而进程刚重启时一条都没有。
 * 不清的话，上一次崩溃前留下的计数会让那些人**永远**显示在线 ——
 * 因为下面的判定把 `connection_count > 0` 当作在线依据。
 */
export function resetPresenceCounts(): void {
  live.clear()
  getDb().prepare('UPDATE presence SET connection_count = 0').run()
}

/**
 * 当前在线的人 = 活连接 ∪ 有最近心跳的库记录。
 *
 * 只有"有活连接"这一条是强信号，库里的窗口是给异常残留兜底的。
 */
export function onlineUserIds(): Set<string> {
  const rows = getDb()
    .prepare('SELECT user_id FROM presence WHERE connection_count > 0 OR last_seen > ?')
    .all(now() - ONLINE_WINDOW_MS) as unknown as Array<{ user_id: string }>

  const online = new Set(rows.map((r) => r.user_id))
  // 内存里的活连接一定是准的，哪怕库那边刚才没写成功
  for (const userId of live.keys()) online.add(userId)
  return online
}
