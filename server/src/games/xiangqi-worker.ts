/**
 * 象棋搜索线程的入口。
 *
 * 它只做一件事：收到一份局面 → 跑 `chooseMove` → 把结果发回去。棋规、评估、
 * 时间预算全都在 `xiangqi-ai.ts` 里，这里不重复任何逻辑。
 *
 * 为什么要单独开线程（而不是像原来那样在主线程直接调 `chooseMove`）：
 * 搜索是同步递归，困难档一手棋要跑满 1.2 秒的时间预算。放在主线程时，这 1.2 秒
 * 里整个 Node 进程是停摆的 —— 实测在机器人思考期间打 `/api/health`，p99 延迟
 * 从 4ms 变成 1195ms。用户那边的体感就是"下棋卡顿"：点棋子后合法性请求在排队、
 * SSE 心跳发不出去、别人的聊天/上传也一起卡住。挪到 worker 之后主线程照常服务。
 *
 * 通信格式刻意用**序列化字符串**而不是对象数组：棋盘 90 格，字符串一行的克隆
 * 成本远低于 90 个 `{color,type}` 对象，而且和库里的存档格式一致，出问题时
 * 打印日志直接能看懂。
 */

import { parentPort } from 'node:worker_threads'
import { deserializeBoard, type Color } from './xiangqi.ts'
import { chooseMove, type BotLevel } from './xiangqi-ai.ts'

export interface SearchJob {
  id: number
  /** 局面，`serializeBoard` 的格式。 */
  board: string
  side: Color
  level: BotLevel
  /** 已经出现过的局面，用于躲开无谓重复。 */
  seenKeys: string[]
  seed: number
}

export type SearchReply =
  | { id: number; ok: true; choice: ReturnType<typeof chooseMove> }
  | { id: number; ok: false; error: string }

parentPort?.on('message', (job: SearchJob) => {
  let reply: SearchReply
  try {
    const choice = chooseMove({
      board: deserializeBoard(job.board),
      side: job.side,
      level: job.level,
      seenKeys: job.seenKeys,
      seed: job.seed,
    })
    reply = { id: job.id, ok: true, choice }
  } catch (err) {
    // 搜索内部抛错不能把线程带崩：回一条失败消息，主线程那边会挑一步合法棋兜底。
    reply = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  parentPort?.postMessage(reply)
})
