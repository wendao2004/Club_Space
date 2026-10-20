/**
 * 认证与会话。
 *
 * 安全基线（评审团结论）：内网不可信 —— 每个请求都要鉴权授权，绝不能因为
 * 来源 IP 在内网就放行。任何一台被感染的终端、访客 WiFi、IoT 设备都在内网。
 *
 * 选型说明：
 *  - 口令哈希用 node:crypto 的 scrypt，不用 argon2/bcrypt：后两者需要原生编译，
 *    而开发机没有 Docker、也没有编译链，会把"能不能跑起来"变成赌注。scrypt
 *    是内存硬的 KDF，参数调到位后同样是可接受的选择。
 *  - 会话用 httpOnly cookie + 服务端会话表，不用 JWT 放 localStorage：
 *    会话可即时吊销（改密码、踢下线），而 localStorage 里的 JWT 做不到。
 */
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SESSION_DAYS, loadSessionSecret } from './config.ts'
import { getDb, newId, now, transaction } from './db.ts'
// 会话撤销时必须**同步关掉已经建立的 SSE 连接** —— 只删库里的会话行
// 对一条已经建好的长连接没有任何作用（详见 realtime.ts 的 Connection.sessionId）。
// 依赖方向是 auth → realtime → chat → db，没有环。
import { disconnectSession, disconnectUser } from './realtime.ts'

const SESSION_COOKIE = 'wl_session'
const SCRYPT_KEYLEN = 64
// N=16384 是 scrypt 的常用平衡点：单次约 50-100ms，足以让离线爆破代价高昂，
// 又不会在 NAS 的弱 CPU 上让登录变成等待。
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

export type Role = 'owner' | 'admin' | 'member'

export interface User {
  id: string
  username: string
  display_name: string
  role: Role
  status: string
  created_at: number
  last_login_at: number | null
}

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 }

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required]
}

/** 哈希口令，返回 "<salt-hex>:<hash-hex>"。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/** 校验口令。用 timingSafeEqual 避免把"口令对不对"变成可测的时间侧信道。 */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  let expected: Buffer
  try {
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_PARAMS)
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/** 用户名规则：3-32 位，字母数字下划线连字符与中文。 */
export function isValidUsername(name: string): boolean {
  return /^[\w一-龥-]{3,32}$/u.test(name)
}

/** 口令强度下限。宁可提示清楚，也不要事后被撞库。 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return '口令至少 8 位'
  if (password.length > 200) return '口令过长'
  return null
}

// ---------------------------------------------------------------- 会话

function signSessionId(id: string): string {
  const mac = createHmac('sha256', loadSessionSecret()).update(id).digest('base64url')
  return `${id}.${mac}`
}

function unsignSessionId(signed: string): string | null {
  const idx = signed.lastIndexOf('.')
  if (idx <= 0) return null
  const id = signed.slice(0, idx)
  const mac = signed.slice(idx + 1)
  const expected = createHmac('sha256', loadSessionSecret()).update(id).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? id : null
}

/** 建会话并把 cookie 写到响应上。 */
export function createSession(
  reply: FastifyReply,
  userId: string,
  req: FastifyRequest,
): { id: string; expiresAt: number } {
  const id = randomUUID()
  const createdAt = now()
  const expiresAt = createdAt + SESSION_DAYS * 24 * 60 * 60 * 1000

  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, createdAt, expiresAt, req.headers['user-agent'] ?? null, req.ip ?? null)

  reply.setCookie(SESSION_COOKIE, signSessionId(id), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // 内网部署最终会走 HTTPS（评审要求：没有 HTTPS 就没有 Service Worker /
    // 摄像头 / 剪贴板）。开发机上通常是 http://127.0.0.1，此时 Secure 会让
    // cookie 根本发不出去，所以按请求是否走 https 决定。
    secure: req.protocol === 'https',
    expires: new Date(expiresAt),
  })

  return { id, expiresAt }
}

/**
 * 从 cookie 里解析当前会话 id（不查库）。
 *
 * 只给"已经过 requireUser 的请求"用 —— 它不验证会话是否有效，
 * 验证由 requireUser / currentUser 负责。SSE 路由需要它把连接与会话绑起来。
 */
export function currentSessionId(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return null
  return unsignSessionId(raw)
}

/** 销毁会话（登出）。 */
export function destroySession(req: FastifyRequest, reply: FastifyReply): void {
  const raw = req.cookies[SESSION_COOKIE]
  if (raw) {
    const id = unsignSessionId(raw)
    if (id) {
      getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
      // 库里那行没了，但这条会话开着的 SSE 还活着 —— 不关掉它，
      // 用户点了登出之后那个标签页仍在收新消息与未读数。
      disconnectSession(id)
    }
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

/** 让某个用户的全部会话失效（改密码 / 停用账号 / 强制下线）。 */
export function revokeAllSessions(userId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  // 同上，而且这里更重要：强制下线如果断不了已建立的流，对被偷走的
  // EventSource 就等于没生效 —— 它会一直收到新消息直到进程重启。
  disconnectUser(userId)
}

/** 从请求里解析当前用户；未登录返回 null。 */
export function currentUser(req: FastifyRequest): User | null {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return null
  const id = unsignSessionId(raw)
  if (!id) return null

  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
              s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(id) as (User & { expires_at: number }) | undefined

  if (!row) return null
  if (row.expires_at < now()) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return null
  }
  if (row.status !== 'active') return null

  const { expires_at: _drop, ...user } = row
  return user
}

// ---------------------------------------------------------------- 用户与邀请码

export function findUserByUsername(username: string): (User & { password_hash: string }) | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as (User & { password_hash: string }) | undefined
  return row ?? null
}

export function getUserById(id: string): User | null {
  const row = getDb()
    .prepare('SELECT id, username, display_name, role, status, created_at, last_login_at FROM users WHERE id = ?')
    .get(id) as User | undefined
  return row ?? null
}

/** 是否还没有任何用户 —— 用来决定要不要允许"首个用户自举为 owner"。 */
export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

export function createUser(input: {
  username: string
  displayName: string
  password: string
  role: Role
}): User {
  const id = newId('u')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, input.username, input.displayName, hashPassword(input.password), input.role, ts)
  return getUserById(id)!
}

export function touchLastLogin(userId: string): void {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId)
}

/** 用户显示名长度下限/上限，与管理端和自助改名共用同一套口径。 */
export const DISPLAY_NAME_MAX = 64

/**
 * 改用户资料（显示名 / 角色 / 状态）。**只改传入的字段**，未传的保持原样。
 *
 * 权限与安全红线（最后一个 owner 不可停用/降级、不能改自己角色等）由路由层判定 ——
 * 那需要知道"谁是操作者"，而这里是纯粹的数据写入。这样拆开的好处是：
 * 改库这件事只有一个入口，不会出现"某条新路径忘了写 audit/忘了校验"的漂移。
 */
export function updateUser(
  id: string,
  patch: { displayName?: string; role?: Role; status?: string },
): User {
  const current = getUserById(id)
  if (!current) throw new Error(`用户不存在：${id}`)

  const sets: string[] = []
  const params: Array<string> = []
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim()
    if (!name) throw new Error('显示名不能为空')
    if (name.length > DISPLAY_NAME_MAX) throw new Error('显示名过长')
    sets.push('display_name = ?')
    params.push(name)
  }
  if (patch.role !== undefined) {
    sets.push('role = ?')
    params.push(patch.role)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (sets.length === 0) return current

  getDb()
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params, id)
  return getUserById(id)!
}

/**
 * 直接重设某个用户的口令（哈希后写入）。
 *
 * 调用方负责两件事：① 用 passwordProblem 校验强度（这里只做防御性拒绝空口令）；
 * ② 调用 revokeAllSessions 让旧会话失效。**口令明文绝不写日志/审计**。
 */
export function setPassword(id: string, password: string): void {
  if (!password) throw new Error('口令不能为空')
  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), id)
}

/** 某角色的活跃用户数。用于"最后一个 owner 不可停用/降级"这道红线。 */
export function countActiveUsersByRole(role: Role): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'")
    .get(role) as { n: number }
  return row.n
}

/**
 * 轻量成员名册（只含 active 用户）。
 *
 * 供"代谁借"这类选人下拉使用 —— 不该为了选一个人去拉整个管理概览
 * （那个接口带着存储统计、审计链头这些重数据，而且仅管理员可用）。
 */
export function listActiveUsers(): Array<{
  id: string
  username: string
  displayName: string
  role: Role
}> {
  const rows = getDb()
    .prepare(
      "SELECT id, username, display_name, role FROM users WHERE status = 'active' ORDER BY display_name COLLATE NOCASE",
    )
    .all() as unknown as Array<{ id: string; username: string; display_name: string; role: Role }>
  return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role }))
}

/** 作废（删除）一个邀请码；不存在返回 false。 */
export function revokeInvite(code: string): boolean {
  const info = getDb().prepare('DELETE FROM invites WHERE code = ?').run(code)
  return Number(info.changes) > 0
}

/** 生成一个邀请码。 */export function createInvite(input: {
  createdBy: string
  role: Role
  maxUses: number
  expiresAt?: number | null
  note?: string
}): string {
  const code = randomBytes(9).toString('base64url')
  getDb()
    .prepare(
      `INSERT INTO invites (code, created_by, role, max_uses, uses, expires_at, created_at, note)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(code, input.createdBy, input.role, input.maxUses, input.expiresAt ?? null, now(), input.note ?? null)
  return code
}

/**
 * 核销一个邀请码并返回它授予的角色；无效返回 null。
 *
 * 放在事务里做"检查 + 自增"，避免并发注册时同一个单次邀请码被两个人用掉。
 */
export function consumeInvite(code: string): { role: Role } | null {
  return transaction(() => {
    const row = getDb()
      .prepare('SELECT * FROM invites WHERE code = ?')
      .get(code) as
      | { code: string; role: Role; max_uses: number; uses: number; expires_at: number | null }
      | undefined
    if (!row) return null
    if (row.uses >= row.max_uses) return null
    if (row.expires_at !== null && row.expires_at < now()) return null
    getDb().prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code)
    return { role: row.role }
  })
}

// ---------------------------------------------------------------- 两步登录

/**
 * 已绑定两步验证的账号，登录要分两步。
 *
 * 为什么必须这么做：
 *
 * 最初的设计里，TOTP 只保护"运维操作"这一步，而**登录只要口令**。
 * 于是"口令泄漏"仍然等于账号沦陷 —— 攻击者用口令登录拿到会话，
 * 再走"重新绑定"把第二因子换成自己的（那道门禁现在要求当前动态口令了，
 * 但那只是把问题推后一步：他仍然拿不到动态口令，可他也并不需要，
 * 因为登录本身不校验它）。
 *
 * 换句话说：**第二因子必须保护"进入账号"这件事本身**，否则它保护的只是
 * 账号里的一部分东西，而攻击者拿到账号后能做的事远不止那些。
 *
 * 实现方式：口令校验通过后，若该账号已绑定 TOTP，**先不发会话**，
 * 而是返回一个短效的挑战令牌；客户端拿它 + 动态口令换真正的会话。
 * 挑战令牌用会话密钥签名（HMAC），所以不可伪造；有效期 5 分钟；
 * 并且用一个已用集合防止同一令牌被重放。
 */
const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000

/** 已经用过的挑战 nonce。定期清理，避免无限增长。 */
const usedChallenges = new Map<string, number>()

function sweepUsedChallenges(nowMs: number): void {
  for (const [nonce, at] of usedChallenges) {
    if (nowMs - at > LOGIN_CHALLENGE_TTL_MS) usedChallenges.delete(nonce)
  }
}

export function createLoginChallenge(userId: string): string {
  const expiresAt = now() + LOGIN_CHALLENGE_TTL_MS
  const nonce = randomBytes(12).toString('base64url')
  const payload = `${userId}.${expiresAt}.${nonce}`
  const mac = createHmac('sha256', loadSessionSecret()).update(`login-challenge|${payload}`).digest('base64url')
  return `${payload}.${mac}`
}

export interface ChallengeResult {
  ok: boolean
  userId?: string
  /** 令牌里的 nonce，验证通过后用它标记消费。 */
  nonce?: string
  reason?: string
}

/**
 * 校验挑战令牌（**不消费**）。
 *
 * 分成"校验"与"消费"两步，是为了让"动态口令输错"不至于把整个挑战作废 ——
 * 否则用户手滑打错一位，就得退回去重新输口令。校验通过之后再由调用方
 * 在确认口令正确时调用 consumeLoginChallenge。
 */
export function verifyLoginChallenge(token: string): ChallengeResult {
  const parts = token.split('.')
  if (parts.length !== 4) return { ok: false, reason: '挑战令牌格式不正确' }
  const [userId, expiresAtRaw, nonce, mac] = parts as [string, string, string, string]

  const payload = `${userId}.${expiresAtRaw}.${nonce}`
  const expected = createHmac('sha256', loadSessionSecret())
    .update(`login-challenge|${payload}`)
    .digest('base64url')

  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: '挑战令牌无效' }
  }

  const expiresAt = Number.parseInt(expiresAtRaw, 10)
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: '挑战令牌无效' }
  if (expiresAt < now()) return { ok: false, reason: '挑战令牌已过期，请重新输入口令' }

  const nowMs = now()
  sweepUsedChallenges(nowMs)
  if (usedChallenges.has(nonce)) {
    return { ok: false, reason: '该挑战令牌已被使用，请重新输入口令' }
  }

  return { ok: true, userId, nonce }
}

/**
 * 标记挑战令牌已使用（在动态口令验证通过之后调用）。
 *
 * 一次性是必要的：否则一个被抓到的令牌可以在 5 分钟内反复换会话，
 * 那就等于把"5 分钟的有效会话"泄漏出去了。
 */
export function consumeLoginChallenge(nonce: string): void {
  usedChallenges.set(nonce, now())
}

/** 该账号是否已绑定两步验证（登录流程据此决定要不要走第二步）。 */
export function hasTotpBound(userId: string): boolean {
  const row = getDb().prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as
    | { totp_secret: string | null }
    | undefined
  return Boolean(row?.totp_secret)
}
