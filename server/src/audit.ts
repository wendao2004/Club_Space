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
  checked: number
  firstBadSeq: number | null
  reason: string | null
  headHash: string
}

/**
 * 重算整条链，检查是否连续且自洽。
 *
 * 这是"可检测"的核心：攻击者可以删掉中间一条并重算后面所有 hash，让本地
 * 朴素校验通过 —— 但如果之前把链头导出到过 NAS 之外，外部比对就会发现
 * 「被覆盖 seq 的 head 与当时的记录不一致」。所以本函数要做的是能被异地
 * 复算的那部分：链的连续性与自洽性。
 */
export function verifyChain(): ChainVerification {
  const rows = getDb()
    .prepare('SELECT * FROM audit_log ORDER BY seq ASC')
    .all() as unknown as AuditRow[]
  let prev = GENESIS
  let expectedSeq = 1

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        checked: rows.length,
        firstBadSeq: row.seq,
        reason: `序号不连续：期望 ${expectedSeq}，实际 ${row.seq}`,
        headHash: prev,
      }
    }
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        checked: rows.length,
        firstBadSeq: row.seq,
        reason: `第 ${row.seq} 条的 prev_hash 与前一条的 hash 不一致`,
        headHash: prev,
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
        firstBadSeq: row.seq,
        reason: `第 ${row.seq} 条的 hash 与内容不符（内容被改过）`,
        headHash: prev,
      }
    }
    prev = row.hash
    expectedSeq = row.seq + 1
  }

  return { ok: true, checked: rows.length, firstBadSeq: null, reason: null, headHash: prev }
}

/** 当前链头，供备份脚本外发锚定。 */
export function chainHead(): { seq: number; hash: string } {
  const head = getDb()
    .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; hash: string } | undefined
  return head ?? { seq: 0, hash: GENESIS }
}
