/**
 * 机器人搜索的执行器：把搜索送进 worker 线程，别堵主线程。
 *
 * 这一层只管"把活儿送出去、把结果收回来"，不关心任何棋规。四条硬要求：
 *
 * 1. **失败必须能退化。** worker 起不来（部署环境限制、`NODE_OPTIONS` 里禁了
 *    类型擦除导致 `.ts` 进不去、线程 OOM……）就退回主线程直接调 `chooseMove`。
 *    那会像以前一样卡一下主线程，但功能还在 —— 比"机器人不落子"好得多。
 *
 * 2. **不能无限等。** 单次任务有超时（时间预算 + 余量）。超时就把线程换掉；
 *    换过两次还不行，就认定这台机器上 worker 不可用，之后一律走主线程。
 *
 * 3. **排队而不是并发。** 一台 NAS 上同时开几局人机对战是正常的，但象棋搜索
 *    是纯 CPU 活，并行跑只会让每一手都变慢。这里用一个线程串行消化队列，
 *    单局体感不变，多局也不至于把 4 个核全占满（留核给 HTTP 与 SSE）。
 *
 * 4. **不拖住进程退出。** 空闲时 `unref()`，有任务时 `ref()`
 *    —— 既不阻止 SIGTERM 之后正常退出，也不会让一个在途任务的 Promise 悬着。
 */

import { Worker } from 'node:worker_threads'
import { serializeBoard, type Board, type Color } from './xiangqi.ts'
import { chooseMove, timeBudgetMs, type BotLevel, type Choice } from './xiangqi-ai.ts'
import type { SearchJob, SearchReply } from './xiangqi-worker.ts'

export interface BotSearchRequest {
  board: Board
  side: Color
  level: BotLevel
  seenKeys?: string[]
  seed?: number
}

/** 队列里的一个任务。`resolve/reject` 是给调用方的，`timer` 是超时兜底。 */
interface QueuedJob {
  payload: SearchJob
  resolve: (choice: Choice | null) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

let worker: Worker | null = null
/** worker 在这台机器上是否已被判定不可用（连续失败两次之后）。 */
let disabled = false
/** 重建次数，用来判断"是不是怎么都起不来"。 */
let restarts = 0
/** 同一时刻只允许一个任务在线程里跑。 */
let current: QueuedJob | null = null
const queue: QueuedJob[] = []
let seq = 0

/** 超时余量：线程启动 + 消息往返 + 主线程调度，给足 5 秒。 */
const TIMEOUT_SLACK_MS = 5000
/** 最多重建几次线程，超过就认定 worker 不可用。 */
const MAX_RESTARTS = 2

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 线程不可用：拒掉在途任务、清空线程引用，必要时标记彻底禁用。 */
function dropWorker(reason: string): void {
  console.error(`[象棋] 搜索线程不可用（${reason}）`)
  const dying = worker
  worker = null
  if (dying) {
    // 先摘掉监听再终止：terminate() 会让线程以非 0 退出，如果不摘，'exit'
    // 回调又会走一遍 dropWorker —— 一次故障记成两次重建，很快就误判成"不可用"。
    dying.removeAllListeners('exit')
    dying.removeAllListeners('error')
    try {
      void dying.terminate()
    } catch {
      // 已经死了就算了
    }
  }
  // 在途任务交给调用方处理：它会把这一手降级成"随便挑一步合法棋"，
  // 绝不让房间停在"该电脑走"的状态上。
  rejectCurrent(new Error(reason))
  restarts++
  if (restarts >= MAX_RESTARTS) {
    disabled = true
    console.error('[象棋] 搜索线程反复失败，后续改为在主线程搜索（会短暂阻塞，但不影响落子）')
  }
}

function rejectCurrent(err: unknown): void {
  if (!current) return
  const job = current
  current = null
  if (job.timer) clearTimeout(job.timer)
  job.reject(err)
}

function onMessage(reply: SearchReply): void {
  if (!current || reply.id !== current.payload.id) return
  const job = current
  current = null
  if (job.timer) clearTimeout(job.timer)
  if (reply.ok) {
    job.resolve(reply.choice)
  } else {
    // 线程还活着，只是这个局面算崩了。让调用方退化成"挑一步合法棋"。
    job.reject(new Error(reply.error))
  }
  if (!current) worker?.unref()
  pump()
}

function ensureWorker(): Worker | null {
  if (worker) return worker
  if (disabled) return null
  try {
    const w = new Worker(new URL('./xiangqi-worker.ts', import.meta.url))
    w.on('message', onMessage)
    w.on('error', (err) => dropWorker(describe(err)))
    // exit code 0 = 我们主动 terminate 的，不算故障
    w.on('exit', (code) => {
      if (code !== 0) dropWorker(`线程退出，code=${code}`)
    })
    w.unref()
    worker = w
    return w
  } catch (err) {
    dropWorker(describe(err))
    return null
  }
}

function pump(): void {
  if (current || queue.length === 0) return
  const w = ensureWorker()
  if (!w) {
    // 线程用不了：把队列里的任务全部交给调用方的降级路径。
    while (queue.length > 0) queue.shift()!.reject(new Error('搜索线程不可用'))
    return
  }
  const job = queue.shift()!
  current = job
  w.ref()
  try {
    w.postMessage(job.payload)
  } catch (err) {
    dropWorker(describe(err))
    return
  }
  job.timer = setTimeout(() => {
    // 超时：线程可能卡在某个局面上。换掉它，这一手由调用方兜底。
    if (current === job) dropWorker('搜索超时')
    pump()
  }, timeBudgetMs(job.payload.level) + TIMEOUT_SLACK_MS)
  job.timer.unref?.()
}

function enqueue(req: BotSearchRequest): Promise<Choice | null> {
  return new Promise((resolve, reject) => {
    const payload: SearchJob = {
      id: ++seq,
      board: serializeBoard(req.board),
      side: req.side,
      level: req.level,
      seenKeys: req.seenKeys ?? [],
      // 不给种子就让线程那边用 Date.now() —— 每盘棋才会走得不一样
      seed: req.seed ?? ((Math.random() * 0x7fffffff) | 0),
    }
    queue.push({ payload, resolve, reject, timer: null })
    pump()
  })
}

/**
 * 选一步棋。返回 null 表示没有合法着法（已被将死或困毙）。
 *
 * 任何异常都不会冒出去：顶层调用方只需要处理"有棋 / 没棋"两种情况，
 * 而"搜索坏了"的兜底是**走一步合法棋**，不是把对局冻住。
 */
export async function searchBotMove(req: BotSearchRequest): Promise<Choice | null> {
  if (!disabled) {
    try {
      return await enqueue(req)
    } catch (err) {
      console.error(`[象棋] 线程搜索失败，本手退回主线程：${describe(err)}`)
    }
  }
  return chooseMove(req)
}

/** 进程退出时收干净（worker 已经 unref，这里主要是别让它在关闭期间还在算）。 */
export async function shutdownBotRunner(): Promise<void> {
  const w = worker
  worker = null
  disabled = true
  rejectCurrent(new Error('服务正在关闭'))
  while (queue.length > 0) queue.shift()!.reject(new Error('服务正在关闭'))
  if (w) {
    // 主动终止会以非 0 退出，先摘监听，免得关闭流程里刷一行"线程不可用"
    w.removeAllListeners('exit')
    w.removeAllListeners('error')
    try {
      await w.terminate()
    } catch {
      // 忽略
    }
  }
}
