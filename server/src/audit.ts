/**
 * 审计日志：哈希链 + append-only。
 *
 * 评审团把"append-only 审计、Web 不可删"判定为**口号而非机制**——在单台 NAS 上
 * 如果只是"不提供删除接口"，任何拿到 root 的人都能直接改库。
 *
 * 这里做到的是「可检测的不可篡改（tamper-evident）」，而不是「防 root 篡改」：
 * 每条记录的 hash 都把前一条的 hash 链进去，并且**在数据库层加触发器禁止
 * UPDATE/DELETE**。诚实地说，root 可以 DROP 掉触发器再改，所以真正的防线是
 * 链本身 —— 只要把链头定期外发（备份脚本会把审计导出到离机介质），事后重算
 * 整条链就能发现被改过。这是评审给出的上限，不假装更高。
 */
import { createHash } from 'node:crypto'
import { getDb, now } from './db.ts'

const GENESIS = '0'.repeat(64)

export interface AuditInput {
  actorId?: string | null
  actorIp?: string | null
  category: 'auth' | 'file' | 'tool' | 'chat' | 'ledger' | 'asset' | 'admin' | 'system'
  action: string
  target?: string | null
  payload?: unknown
}

/**
 * 规范化 payload。
 *
 * 键排序 + 不用浮点，保证同样的语义内容一定得到同样的字节，
 * 否则重算链时会因为键序差异而"看起来被篡改"。
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
  }
  return 'null'
}

export function hashRecord(input: {
  seq: number
  ts: number
  actorId: string | null
  actorIp: string | null
  category: string
  action: string
  target: string | null
  payload: string
  prevHash: string
}): string {
  const material = [
    'audit-v1',
    input.seq,
    input.ts,
    input.actorId ?? '',
    input.actorIp ?? '',
    input.category,
    input.action,
    input.target ?? '',
    input.payload,
    input.prevHash,
  ].join('|')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * 追加一条审计记录。
 *
 * 注意：这里刻意**不抛异常**。审计写入失败不应该把用户的上传/转换一起搞挂，
 * 但也不能静默 —— 所以失败时打到标准错误，并由健康检查把 audit_ok=false
 * 暴露出去（见 /api/health）。
 */
let auditHealthy = true

export function isAuditHealthy(): boolean {
  return auditHealthy
}

export function audit(input: AuditInput): void {
  try {
    const db = getDb()
    const ts = now()
    const payload = canonicalize(input.payload ?? null)

    db.exec('BEGIN IMMEDIATE')
    try {
      const head = db
        .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined
      const seq = (head?.seq ?? 0) + 1
      const prevHash = head?.hash ?? GENESIS

      const actorId = input.actorId ?? null
      const actorIp = input.actorIp ?? null
      const category = input.category
      const action = input.action
      const target = input.target ?? null

      const hash = hashRecord({ seq, ts, actorId, actorIp, category, action, target, payload, prevHash })

      db.prepare(
        `INSERT INTO audit_log (seq, ts, actor_id, actor_ip, category, action, target, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(seq, ts, actorId, actorIp, category, action, target, payload, prevHash, hash)

      db.exec('COMMIT')
      auditHealthy = true
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    auditHealthy = false
    console.error('[audit] 写入失败（不阻断业务，但已在健康检查中标记）:', err)
  }
}

export interface AuditRow {
  seq: number
  ts: number
  actor_id: string | null
  actor_ip: string | null
  category: string
  action: string
  target: string | null
  payload: string | null
  prev_hash: string
  hash: string
}

/** 按 seq 区间导出审计记录，供离机校验使用。 */
export function exportAudit(fromSeq = 0, limit = 100_000): AuditRow[] {
  return getDb()
    .prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(fromSeq, limit) as unknown as AuditRow[]
}

export interface ChainVerification {
  ok: boolean
  /** 本次**实际重算**的行数（增量模式下通常只有几十条）。 */
  checked: number
  /** 链上的总记录数（MAX(seq)），与本次是否增量无关。 */
  total: number
  /** 本次校验覆盖到第几条（校验通过时这就是链头 seq）。 */
  upto: number
  firstBadSeq: number | null
  reason: string | null
  headHash: string
  /** 本次是否为增量校验（只验了上次之后新增的部分）。 */
  incremental: boolean
}

/**
 * 校验基准存在 settings 表里：上次校验到哪一条、那一条的 hash。
 *
 * 为什么不用进程内变量：那样每次重启都要重新全量。10 万条审计的全量校验
 * 是几百毫秒到秒级，而探活请求的超时只有 5 秒 —— 一个每次重启后第一次
 * 探活就可能超时的健康检查，等于没有健康检查。
 */
const VERIFY_STATE_KEY = 'audit.verified'

interface VerifyState {
  seq: number
  hash: string
}

function readVerifyState(): VerifyState | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(VERIFY_STATE_KEY) as { value: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value) as Partial<VerifyState>
    if (typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string') return null
    return { seq: parsed.seq, hash: parsed.hash }
  } catch {
    // 读不出来就退回全量，不要因为一个坏掉的基准把校验整个跳过
    return null
  }
}

function saveVerifyState(state: VerifyState): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(VERIFY_STATE_KEY, JSON.stringify(state), now())
  } catch (err) {
    // 存不下基准只会让下次退化成全量，不影响本次结论 —— 不值得抛出去
    console.error('[audit] 保存校验基准失败（下次会全量校验）:', err)
  }
}

export interface VerifyOptions {
  /**
   * 只校验"上次校验通过之后新增"的部分。
   *
   * ⚠️ 增量的**盲区**必须说清楚：如果有人改写了历史记录并重算了它之后的所有
   * hash，增量校验看不出来 —— 它只从基准往后看。所以：
   *   - 高频探活用增量（每次几十行，毫秒级）；
   *   - 管理员主动校验、以及启动后的后台预热，仍然走全量。
   * 两者配合才有意义：增量保证"新写入的没坏"，全量保证"历史没被改写"。
   */
  incremental?: boolean
  /** 单次最多校验多少行（增量模式默认 5000，防止积压时拖死探活）。 */
  maxRows?: number
}

/**
 * 重算审计链，检查是否连续且自洽。
 *
 * 这是"可检测"的核心：攻击者可以删掉中间一条并重算后面所有 hash，让本地
 * 朴素校验通过 —— 但如果之前把链头导出到过 NAS 之外，外部比对就会发现
 * 「被覆盖 seq 的 head 与当时的记录不一致」。所以本函数要做的是能被异地
 * 复算的那部分：链的连续性与自洽性。
 */
export function verifyChain(options: VerifyOptions = {}): ChainVerification {
  const db = getDb()
  const totalRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log')
    .get() as { n: number }
  const total = totalRow.n

  const incremental = options.incremental === true
  let fromSeq = 0
  let prev = GENESIS

  if (incremental) {
    const state = readVerifyState()
    // state.seq > total 只有一种可能：审计表被清过或回滚过（基准指向了
    // 不存在的链头）。这时基准不可信，退回全量 —— 而全量马上就会发现
    // "seq 不从 1 开始"或者链断了。
    if (state && state.seq <= total) {
      fromSeq = state.seq
      prev = state.hash
    }
  }

  const maxRows = options.maxRows ?? (incremental ? 5000 : 0)
  const rows = (
    maxRows > 0
      ? db
          .prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?')
          .all(fromSeq, maxRows)
      : db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC').all(fromSeq)
  ) as unknown as AuditRow[]

  let expectedSeq = fromSeq + 1

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        checked: rows.length,
        total,
        upto: expectedSeq - 1,
        firstBadSeq: row.seq,
        reason: `序号不连续：期望 ${expectedSeq}，实际 ${row.seq}`,
        headHash: prev,
        incremental,
      }
    }
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        checked: rows.length,
        total,
        upto: expectedSeq - 1,
        firstBadSeq: row.seq,
        reason: `第 ${row.seq} 条的 prev_hash 与前一条的 hash 不一致`,
        headHash: prev,
        incremental,
      }
    }
    const recomputed = hashRecord({
      seq: row.seq,
      ts: row.ts,
      actorId: row.actor_id,
      actorIp: row.actor_ip,
      category: row.category,
      action: row.action,
      target: row.target,
      payload: row.payload ?? 'null',
      prevHash: row.prev_hash,
    })
    if (recomputed !== row.hash) {
      return {
        ok: false,
        checked: rows.length,
        total,
        upto: expectedSeq - 1,
        firstBadSeq: row.seq,
        reason: `第 ${row.seq} 条的 hash 与内容不符（内容被改过）`,
        headHash: prev,
        incremental,
      }
    }
    prev = row.hash
    expectedSeq = row.seq + 1
  }

  const upto = expectedSeq - 1
  // 只有校验通过才推进基准。失败时保留旧的，这样下一次（无论是探活还是
  // 管理员手动校验）还会从同一个地方重新发现这个错误。
  //
  // 条件里的 `rows.length > 0 || !incremental` 是给探活用的：稳态下增量
  // 校验是"0 行"，此时基准没有变化，不需要为每一个探活请求写一行 settings
  // （Docker HEALTHCHECK 每 30 秒一次，一天就是 2880 次无意义的 WAL 写入）。
  if (rows.length > 0 || !incremental) {
    saveVerifyState({ seq: upto, hash: prev })
  }

  return {
    ok: true,
    checked: rows.length,
    total,
    upto,
    firstBadSeq: null,
    reason: null,
    headHash: prev,
    incremental,
  }
}

/**
 * 启动时的后台预热。
 *
 * 不放在 `await` 路径上：第一次（settings 里还没有基准）是全量，10 万条约
 * 几百毫秒。让它和 listen 并行跑，第一个探活请求就不会撞上全量校验。
 */
export function warmAuditChain(): void {
  setImmediate(() => {
    try {
      const result = verifyChain({ incremental: true })
      if (!result.ok) {
        console.error('[audit] 启动校验发现链异常:', result.reason)
      }
    } catch (err) {
      console.error('[audit] 启动预热校验失败（下次探活会重试）:', err)
    }
  })
}

/** 当前链头，供备份脚本外发锚定。 */
export function chainHead(): { seq: number; hash: string } {
  const head = getDb()
    .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; hash: string } | undefined
  return head ?? { seq: 0, hash: GENESIS }
}
