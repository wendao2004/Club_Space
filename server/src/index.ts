/**
 * HTTP 服务入口。
 *
 * 路由分组：健康检查 / 引导 / 认证 / 文件 / 上传 / 工具 / 任务 / 管理。
 * 所有涉及数据的路由都要先过 requireUser —— 评审团的基线是「内网不可信，
 * 每个请求都要鉴权授权」，绝不因为来源在内网就放行。
 */
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify'
import { existsSync } from 'node:fs'
import { ZodError, z } from 'zod'
import {
  createInvite,
  consumeInvite,
  consumeLoginChallenge,
  countActiveUsersByRole,
  createLoginChallenge,
  createSession,
  createUser,
  currentUser,
  destroySession,
  findUserByUsername,
  getUserById,
  hasTotpBound,
  isValidUsername,
  listActiveUsers,
  passwordProblem,
  revokeAllSessions,
  revokeInvite,
  roleAtLeast,
  setPassword,
  touchLastLogin,
  updateUser,
  userCount,
  verifyLoginChallenge,
  verifyPassword,
  type Role,
  type User,
} from './auth.ts'
import { audit, chainHead, exportAudit, isAuditHealthy, verifyChain } from './audit.ts'
import {
  conversationMembers,
  createGroup,
  editMessage,
  fetchMessage,
  getConversation,
  getOrCreateDirect,
  listContacts,
  listConversations,
  listMessages,
  markRead,
  memberIds,
  readReceipts,
  recallMessage,
  onlineUserIds,
  resetPresenceCounts,
  searchMessages,
  sendMessage,
  totalUnread,
} from './chat.ts'
import { pushTo, broadcast, realtimeStats, subscribe, connectedUserIds } from './realtime.ts'
import { RATE_RULES, checkRateLimit, clearRateLimit, rateLimitStats } from './ratelimit.ts'
import {
  AdminError,
  checkGate,
  describeOperations,
  executeOperation,
  findOperation,
  loadAdminConfig,
  selectRunner,
} from './admin/docker.ts'
import {
  decryptSecret,
  encryptSecret,
  formatSecretForDisplay,
  generateSecret,
  otpauthUrl,
  verifyTotp,
} from './admin/totp.ts'
import {
  cleanupStaleRooms,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  legalMovesFor,
  listRooms,
  makeMove,
  myStats,
  resign,
} from './games/rooms.ts'
import {
  bidLandlord,
  createDoudizhuRoom,
  doudizhuMembers,
  getDoudizhuView,
  joinDoudizhuRoom,
  leaveDoudizhuRoom,
  listDoudizhuRooms,
  passTurn,
  playCards,
} from './games/doudizhu-rooms.ts'
import {
  cleanupStaleWerewolfRooms,
  createWerewolfRoom,
  getWerewolfView,
  joinWerewolfRoom,
  leaveWerewolfRoom,
  listWerewolfRooms,
  processWerewolfTimeouts,
  werewolfCheck,
  werewolfChat,
  werewolfKill,
  werewolfMembers,
  werewolfShoot,
  werewolfVote,
  werewolfWitch,
} from './games/werewolf-rooms.ts'
import {
  archiveCategory,
  closeEvent,
  createCategory,
  createEntry,
  createEvent,
  decideEntry,
  deleteEntry,
  eventSummary,
  exportCsv,
  exportEventCsv,
  getEntry,
  getEvent,
  listCategories,
  listEntries,
  listEvents,
  markPaid,
  outstandingDebts,
  parseAmountToCents,
  seedDefaultCategories,
  settleSplit,
  submitEntry,
  summary,
  updateEntry,
  updateEvent,
  withdrawEntry,
  type ListOptions,
} from './ledger.ts'
// ⚠️ 财物模块和记账模块有几个重名导出（listCategories / createCategory /
// archiveCategory / summary / seedDefaultCategories）。这里给财物侧加别名，
// 免得读代码时分不清某个 listCategories() 到底是哪一个 —— 它们一个查的是
// 账目分类，一个查的是物品分类，搞混了不会报错，只会查错东西。
import {
  archiveCategory as archiveAssetCategory,
  createCategory as createAssetCategory,
  createItem,
  exportItemsCsv,
  exportLoansCsv,
  getItem as getAssetItem,
  lendItem,
  listCategories as listAssetCategories,
  listItems,
  listLoans,
  overdueLoans,
  restoreLoan,
  retireItem,
  returnLoan,
  seedAssetCategories,
  summary as assetSummary,
  updateItem,
  updateLoan,
  voidLoan,
} from './assets.ts'
import { getDb, now } from './db.ts'
import {
  HOST,
  IS_PROD,
  MAX_UPLOAD_BYTES,
  PORT,
  SITE_NAME,
  WEB_DIST,
} from './config.ts'
import {
  appendChunk,
  breadcrumb,
  canRead,
  auditBlobRefCounts,
  canWrite,
  cleanupStaleUploads,
  completeUpload,
  createFolder,
  deleteNode,
  discardUpload,
  getNode,
  getUpload,
  HttpError,
  initUpload,
  listChildren,
  moveNode,
  openNodeStream,
  renameNode,
  storageStats,
  type Space,
} from './files.ts'
import {
  createJob,
  describeTools,
  getJob,
  getTool,
  jobResult,
  jobView,
  startJobRunner,
} from './tools.ts'

/**
 * 反向代理信任配置。
 *
 * 这里**不能**写 `trustProxy: true`。那个值会让 Fastify 无条件采用
 * X-Forwarded-For 的最左值作为 req.ip —— 而那个头是客户端可以随便写的。
 * 于是"按 IP 限流"和"管理员运维的来源 IP 白名单"会同时失效：
 * 攻击者每个请求换一个伪造 IP，就落到全新的限流桶里，等于没有限流；
 * 白名单也能被一句 `X-Forwarded-For: <白名单里的IP>` 骗过去。
 *
 * 正确做法是只信任真实反向代理的地址。部署时在 .env 里设置
 * WL_TRUSTED_PROXIES（docker 网络网段），本机开发留空 → false。
 * Fastify 支持 string[] 形式，所以这里直接给数组。
 */
function trustedProxies(): boolean | string[] {
  const list = (process.env.WL_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : false
}

const app = Fastify({
  logger: {
    level: IS_PROD ? 'info' : 'warn',
    transport: IS_PROD ? undefined : { target: 'pino-pretty' },
  },
  bodyLimit: 8 * 1024 * 1024, // 普通 JSON 请求 8MB 上限；分片上传走流式，不受此限
  trustProxy: trustedProxies(),
})

// 分片上传用裸二进制体，不能按 JSON 解析
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 },
  (_req, body, done) => done(null, body),
)

await app.register(cookie)

// ---------------------------------------------------------------- 鉴权辅助

class AuthError extends Error {}

function requireUser(req: FastifyRequest): User {
  const user = currentUser(req)
  if (!user) throw new AuthError('请先登录')
  return user
}

function requireRole(req: FastifyRequest, role: Role): User {
  const user = requireUser(req)
  if (!roleAtLeast(user.role, role)) throw new AuthError('权限不足')
  return user
}

function spaceOf(req: FastifyRequest): Space {
  const raw = (req.query as { space?: string } | undefined)?.space
  return raw === 'private' ? 'private' : 'shared'
}

function actorIp(req: FastifyRequest): string | null {
  return req.ip ?? null
}

/** 会话成员 id 列表，供实时推送决定发给谁。 */
const memberIdsOf = memberIds

/**
 * 限流。超限时抛 429，并记一条审计。
 *
 * `globalKey = true` 表示**不把请求来源 IP 拼进键里**。
 * 用于"针对某个资源"的限流（例如某个用户名、某个账号的动态口令）——
 * 这类限流如果带上 IP，攻击者换个 IP 就绕过了。
 */
function enforceRateLimit(
  req: FastifyRequest,
  rule: keyof typeof RATE_RULES,
  extraKey = '',
  globalKey = false,
): void {
  const ip = actorIp(req) ?? 'unknown'
  const key = globalKey ? `${rule}${extraKey}` : `${rule}:${ip}${extraKey}`
  const result = checkRateLimit(key, RATE_RULES[rule])
  if (result.allowed) return

  audit({
    actorId: currentUser(req)?.id ?? null,
    actorIp: ip,
    category: 'auth',
    action: 'rate-limited',
    target: rule,
    payload: { retryAfterSeconds: result.retryAfterSeconds, extraKey, globalKey },
  })
  throw new HttpError(429, `操作过于频繁，请 ${result.retryAfterSeconds} 秒后再试`)
}

// 统一的错误响应：把各类错误翻译成合适的状态码
app.setErrorHandler((err: FastifyError, req, reply) => {
  if (err instanceof AuthError) {
    audit({
      actorId: currentUser(req)?.id ?? null,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'denied',
      target: req.url,
      payload: { reason: err.message },
    })
    return reply.code(401).send({ error: err.message })
  }

  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.message })
  }

  // ZodError 必须单独处理成 400。
  // 漏掉这一条的话，任何一个 zod 校验失败（用户输入超长、类型不对）都会掉到
  // 最后的兜底分支变成 500 —— 那是把"用户输入不合法"误报成"服务器故障"，
  // 既误导用户也让日志里充满假的服务器错误。
  if (err instanceof ZodError || err.name === 'ZodError') {
    const issues = (err as { issues?: Array<{ path?: Array<string | number>; message: string }> })
      .issues
    const first = issues?.[0]
    const field = first?.path?.join('.') || '请求体'
    const detail = first ? `${field}: ${first.message}` : '请求参数不合法'
    return reply.code(400).send({ error: `参数不合法（${detail}）`, issues: issues ?? [] })
  }

  if (err.validation) {
    return reply.code(400).send({ error: '请求参数不合法', detail: err.message })
  }

  if (err.statusCode === 413) {
    return reply.code(413).send({ error: '请求体过大' })
  }

  req.log.error(err)
  return reply.code(500).send({ error: '服务器内部错误' })
})

// ---------------------------------------------------------------- 健康与引导

/**
 * 健康检查。
 *
 * ⚠️ 这个接口**不需要登录**（监控要用），所以它做的事情必须便宜。
 *
 * 最初的实现每次请求都调 verifyChain() —— 那会把整张审计表读进内存并逐行重算
 * SHA-256。审计行数可以轻易涨到几十万（每次下载、登录、上传都写一行），
 * 于是任何人（连账号都不需要）并发打这个端点就能把容器 CPU 打满，
 * 而 Docker 的 HEALTHCHECK 每 30 秒也会打它一次。
 *
 * 现在：全链校验的结果按时间缓存（默认 60 秒），健康检查只读缓存。
 * 管理员仍可随时在管理页触发一次真实校验（那个接口要登录）。
 */
let chainCheckCache: { at: number; result: ReturnType<typeof verifyChain> } | null = null
const CHAIN_CHECK_TTL_MS = 60_000

function cachedChainCheck(): ReturnType<typeof verifyChain> {
  const now = Date.now()
  if (chainCheckCache && now - chainCheckCache.at < CHAIN_CHECK_TTL_MS) {
    return chainCheckCache.result
  }
  const result = verifyChain()
  chainCheckCache = { at: now, result }
  return result
}

app.get('/api/health', async () => {
  const chain = cachedChainCheck()
  return {
    ok: true,
    audit: { healthy: isAuditHealthy(), chainOk: chain.ok, records: chain.checked },
    realtime: realtimeStats(),
    rateLimit: rateLimitStats(),
    time: Date.now(),
  }
})

/** 管理页的"校验审计链"走这个，它每次都是真实计算（要登录，且管理员主动触发）。 */
app.get('/api/admin/audit/verify', async (req) => {
  const user = requireRole(req, 'admin')
  const result = verifyChain()
  chainCheckCache = { at: Date.now(), result }
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'verify-audit-chain',
    payload: { ok: result.ok, checked: result.checked },
  })
  return result
})

/** 引导信息：首次运行判定、站点名、当前登录态。无需鉴权。 */
app.get('/api/bootstrap', async (req) => {
  const user = currentUser(req)
  return {
    siteName: SITE_NAME,
    /** 一个用户都没有时，前端显示"创建管理员"而不是"登录"。 */
    firstRun: userCount() === 0,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    user: user ? publicUser(user) : null,
  }
})

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  }
}

// ---------------------------------------------------------------- 认证

const registerSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1).max(64),
  password: z.string().min(1),
  inviteCode: z.string().optional(),
})

app.post('/api/auth/register', async (req, reply) => {
  enforceRateLimit(req, 'register')
  const body = registerSchema.parse(req.body)

  if (!isValidUsername(body.username)) {
    throw new HttpError(400, '用户名需 3-32 位，可用字母、数字、下划线、连字符或中文')
  }
  const pwdProblem = passwordProblem(body.password)
  if (pwdProblem) throw new HttpError(400, pwdProblem)
  if (findUserByUsername(body.username)) throw new HttpError(409, '该用户名已被使用')

  const isFirstRun = userCount() === 0
  let role: Role

  if (isFirstRun) {
    // 自举：第一个用户成为 owner。前提是库里一个用户都没有 —— 这是唯一的
    // "无邀请码即可注册"的路径，之后所有注册都必须持码。
    role = 'owner'
  } else {
    if (!body.inviteCode) throw new HttpError(403, '需要邀请码才能注册，请向管理员索取')
    const granted = consumeInvite(body.inviteCode)
    if (!granted) throw new HttpError(403, '邀请码无效、已用完或已过期')
    role = granted.role
  }

  const user = createUser({
    username: body.username,
    displayName: body.displayName,
    password: body.password,
    role,
  })

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'auth',
    action: isFirstRun ? 'bootstrap-owner' : 'register',
    target: user.username,
    payload: { role },
  })
  audit({
    actorId: null,
    actorIp: actorIp(req),
    category: 'auth',
    action: 'invite-consumed',
    target: user.username,
    payload: { inviteCode: body.inviteCode ?? null },
  })

  createSession(reply, user.id, req)
  return { user: publicUser(user) }
})

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })

app.post('/api/auth/login', async (req, reply) => {
  const body = loginSchema.parse(req.body)

  // 两个维度各自限流，**但键的构造方式不同**：
  //   按 IP   —— 挡住"从一台机器试很多账号"
  //   按用户名 —— **不能把 IP 拼进键里**，否则换个 IP 就绕过针对某个账号的限流。
  //              （这条是安全审查抓出来的：最初的写法是 `login:<ip>:user:<name>`，
  //               攻击者每次换一个伪造 IP 就能无限次猜同一个账号的口令。）
  enforceRateLimit(req, 'login')
  enforceRateLimit(req, 'login', `:user:${body.username}`, true)

  const record = findUserByUsername(body.username)

  // 用户不存在与口令错误返回同样的信息，避免用户名枚举
  if (!record || !verifyPassword(body.password, record.password_hash)) {
    audit({
      actorId: record?.id ?? null,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'login-failed',
      target: body.username,
      payload: { userExists: Boolean(record) },
    })
    throw new HttpError(401, '用户名或口令不正确')
  }
  if (record.status !== 'active') throw new HttpError(403, '该账号已被停用')

  // **已绑定两步验证的账号，口令正确也先不发会话。**
  //
  // 这是 2FA 能不能成立的关键一步：如果登录只看口令，那么第二因子
  // 保护的只是"账号里的某些操作"，而攻击者拿到账号后能做的事远不止那些。
  // 必须由第二因子守住"进入账号"本身。
  if (hasTotpBound(record.id)) {
    audit({
      actorId: record.id,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'login-password-ok-need-totp',
      target: record.username,
    })
    return {
      needTotp: true,
      challenge: createLoginChallenge(record.id),
      displayName: record.display_name,
    }
  }

  createSession(reply, record.id, req)
  touchLastLogin(record.id)

  // 登录成功就清掉失败计数 —— 否则一个偶尔手滑的正常用户
  // 会被自己之前几次失败拖着，离限流阈值越来越近。
  clearRateLimit(`login:${actorIp(req) ?? 'unknown'}`)
  clearRateLimit(`login:user:${body.username}`)

  audit({
    actorId: record.id,
    actorIp: actorIp(req),
    category: 'auth',
    action: 'login',
    target: record.username,
  })

  const { password_hash: _drop, ...user } = record
  return { user: publicUser(user as User) }
})

const loginTotpSchema = z.object({
  challenge: z.string().min(1),
  code: z.string().min(1),
})

/**
 * 两步登录的第二步：用挑战令牌 + 动态口令换会话。
 *
 * 挑战令牌是用会话密钥签名的，不可伪造；有效期 5 分钟；且一次性
 * （verifyLoginChallenge 内部有已用集合）。所以即使令牌泄漏，
 * 攻击者仍然需要动态口令才能换成会话。
 */
app.post('/api/auth/login/totp', async (req, reply) => {
  const body = loginTotpSchema.parse(req.body)
  enforceRateLimit(req, 'totp', `:login`, true)

  const verdict = verifyLoginChallenge(body.challenge)
  if (!verdict.ok || !verdict.userId) {
    audit({
      actorId: null,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'login-totp-failed',
      payload: { reason: verdict.reason ?? 'unknown' },
    })
    throw new HttpError(401, verdict.reason ?? '挑战令牌无效')
  }

  const record = getUserById(verdict.userId)
  if (!record) throw new HttpError(401, '账号不存在')
  if (record.status !== 'active') throw new HttpError(403, '该账号已被停用')

  const secret = activeTotpSecret(record.id)
  if (!secret) {
    throw new HttpError(
      400,
      '两步验证的秘密无法解密（通常是 WL_SESSION_SECRET 被更换过），无法完成登录。请联系另一位管理员处理。',
    )
  }

  if (!verifyTotp(secret, body.code)) {
    audit({
      actorId: record.id,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'login-totp-failed',
      target: record.username,
      payload: { reason: 'code-mismatch' },
    })
    // 注意这里**不消费**挑战令牌 —— 用户打错一位不该被退回重输口令。
    // 暴力试的代价由限流承担（见上面的 enforceRateLimit）。
    throw new HttpError(401, '动态口令不正确或已过期')
  }

  // 口令正确 → 消费令牌（一次性），再发会话
  if (verdict.nonce) consumeLoginChallenge(verdict.nonce)

  createSession(reply, record.id, req)
  touchLastLogin(record.id)

  audit({
    actorId: record.id,
    actorIp: actorIp(req),
    category: 'auth',
    action: 'login',
    target: record.username,
    payload: { secondFactor: 'totp' },
  })

  return { user: publicUser(record) }
})

app.post('/api/auth/logout', async (req, reply) => {
  const user = currentUser(req)
  destroySession(req, reply)
  if (user) {
    audit({ actorId: user.id, actorIp: actorIp(req), category: 'auth', action: 'logout' })
  }
  return { ok: true }
})

app.get('/api/auth/me', async (req) => {
  const user = requireUser(req)
  return { user: publicUser(user) }
})

// ---------------------------------------------------------------- 个人资料（自助）

/**
 * 改自己的显示名。
 *
 * **只从会话取当前用户，绝不接受请求体里的 userId** —— 否则就等于开了一条
 * "改别人资料"的通道。用户名不允许改：它是登录身份，也是审计与邀请码留痕的
 * 依据，改掉会让历史记录对不上人。
 */
app.patch('/api/me', async (req) => {
  const user = requireUser(req)
  const body = z.object({ displayName: z.string().min(1).max(64) }).parse(req.body)
  const updated = updateUser(user.id, { displayName: body.displayName })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'auth',
    action: 'profile-update',
    target: user.id,
    payload: { displayName: updated.display_name },
  })
  return { user: publicUser(updated) }
})

/**
 * 改自己的口令。
 *
 * **必须验证旧口令。** 少了这一步，会话 cookie 一旦被窃（XSS / 借用设备），
 * 攻击者不用知道口令就能把口令改成自己的，等于静默夺号。
 * 改完之后吊销该用户的**全部**会话 —— 否则其它设备上的旧会话还活着，
 * 改口令等于没改（当前这个会话会一起失效，需要重新登录，这是应得的代价）。
 */
app.post('/api/me/password', async (req) => {
  const user = requireUser(req)
  const body = z
    .object({ oldPassword: z.string().min(1), newPassword: z.string().min(1) })
    .parse(req.body)

  const record = findUserByUsername(user.username)
  if (!record || !verifyPassword(body.oldPassword, record.password_hash)) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'auth',
      action: 'password-change-failed',
      target: user.id,
      payload: { reason: 'old-password-mismatch' },
    })
    throw new HttpError(400, '当前口令不正确')
  }
  const problem = passwordProblem(body.newPassword)
  if (problem) throw new HttpError(400, problem)
  if (body.newPassword === body.oldPassword) throw new HttpError(400, '新口令不能与旧口令相同')

  setPassword(user.id, body.newPassword)
  revokeAllSessions(user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'auth',
    action: 'password-change',
    target: user.id,
    // 只记事实，**绝不记口令内容或哈希**。
    payload: { note: 'password changed' },
  })
  return { ok: true }
})

/**
 * 轻量成员名册（仅 active）。
 *
 * 给"代谁借"这类选人下拉用：为了选一个人不必去拉整个管理概览
 * （那个接口带存储统计、审计链头等重数据，且仅管理员可用）。
 * 任意登录用户都能读 —— 成员之间本就能看到彼此（聊天联系人也是）。
 */
app.get('/api/members', async (req) => {
  requireUser(req)
  return { members: listActiveUsers() }
})

// ---------------------------------------------------------------- 文件

app.get('/api/files', async (req) => {
  const user = requireUser(req)
  const query = req.query as { parent?: string; space?: string }
  const space = spaceOf(req)
  const parentId = query.parent && query.parent !== 'root' ? query.parent : null

  if (parentId) {
    const parent = getNode(parentId)
    if (!parent) throw new HttpError(404, '目录不存在')
    if (!canRead(parent, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权访问该目录')
  }

  const entries = listChildren(parentId, user.id, {
    space,
    isAdmin: roleAtLeast(user.role, 'admin'),
  })
  return {
    space,
    parentId,
    breadcrumb: parentId ? breadcrumb(parentId) : [],
    entries: entries.map((entry) => ({
      id: entry.id,
      parentId: entry.parent_id,
      name: entry.name,
      kind: entry.kind,
      space: entry.space,
      size: entry.size,
      mime: entry.mime,
      sha256: entry.sha256,
      ownerId: entry.owner_id,
      ownerName: entry.owner_name,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })),
  }
})

const folderSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().min(1),
  space: z.enum(['shared', 'private']).optional(),
})

app.post('/api/files/folder', async (req) => {
  const user = requireUser(req)
  const body = folderSchema.parse(req.body)
  const space = body.space ?? 'shared'
  const node = createFolder({
    parentId: body.parentId ?? null,
    name: body.name,
    ownerId: user.id,
    space,
  })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'file',
    action: 'create-folder',
    target: node.id,
    payload: { name: node.name, space },
  })
  return { node: { id: node.id, name: node.name, kind: node.kind } }
})

const patchSchema = z.object({
  name: z.string().optional(),
  parentId: z.string().nullable().optional(),
})

app.patch('/api/files/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = patchSchema.parse(req.body)

  const node = getNode(id)
  if (!node) throw new HttpError(404, '节点不存在')
  if (!canWrite(node, user.id, roleAtLeast(user.role, 'admin'))) {
    throw new HttpError(403, '只能修改自己上传的内容')
  }

  let result = node
  if (body.name !== undefined) result = renameNode(id, body.name)
  if (body.parentId !== undefined) result = moveNode(id, body.parentId)

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'file',
    action: body.parentId !== undefined ? 'move' : 'rename',
    target: id,
    payload: { name: result.name, parentId: result.parent_id },
  })
  return { node: { id: result.id, name: result.name, parentId: result.parent_id } }
})

app.delete('/api/files/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const node = getNode(id)
  if (!node) throw new HttpError(404, '节点不存在')
  if (!canWrite(node, user.id, roleAtLeast(user.role, 'admin'))) {
    throw new HttpError(403, '只能删除自己上传的内容')
  }
  await deleteNode(id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'file',
    action: 'delete',
    target: id,
    payload: { name: node.name, kind: node.kind },
  })
  return { ok: true }
})

/** 下载（attachment）。 */
app.get('/api/files/:id/download', async (req, reply) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const node = getNode(id)
  if (!node) throw new HttpError(404, '文件不存在')
  if (!canRead(node, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权访问')

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'file',
    action: 'download',
    target: id,
    payload: {
      name: node.name,
      size: node.size,
      // 管理员下载他人私有文件属于敏感读取，单独标出来，便于事后审计。
      adminAccess: node.owner_id !== user.id && node.space === 'private',
    },
  })

  reply
    .header('content-type', node.mime ?? 'application/octet-stream')
    .header('content-length', String(node.size))
    .header('content-disposition', contentDisposition(node.name))
  return reply.send(openNodeStream(node))
})

/**
 * 预览（inline）。
 *
 * ⚠️ **SVG 绝不内联返回。**
 *
 * SVG 不是"图片"，它是一个可以包含 <script> 与 onload 的 XML 文档。
 * 如果以 image/svg+xml 内联返回，浏览器会把它当文档渲染并执行其中的脚本 ——
 * 而它跑在**本站同源**下，于是任何成员上传一个带脚本的 .svg，
 * 把预览链接发给管理员，脚本就能以管理员的会话调任意管理员接口。
 * 这是一条不需要任何前置权限的存储型 XSS。
 *
 * 所以 SVG 一律走 attachment（下载），并由 Caddy 的 CSP（script-src 'self'）
 * 作为第二道防线。两层都要有：CSP 是部署配置，可能被改动；attachment 是代码保证。
 */
app.get('/api/files/:id/preview', async (req, reply) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const node = getNode(id)
  if (!node) throw new HttpError(404, '文件不存在')
  if (!canRead(node, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权访问')

  const mime = node.mime ?? 'application/octet-stream'

  // 能安全内联的类型：位图、PDF、文本、音视频。
  // **不含 SVG**（活动内容），也不含任何 text/html。
  const inline =
    (mime.startsWith('image/') && mime !== 'image/svg+xml') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/')

  reply
    .header('content-type', mime)
    .header('content-length', String(node.size))
    .header(
      'content-disposition',
      inline ? `inline; filename*=UTF-8''${encodeURIComponent(node.name)}` : contentDisposition(node.name),
    )
    .header('x-content-type-options', 'nosniff')
    // 即使是允许内联的类型，也加一条最严格的 CSP：
    // 万一将来有人把某个活动类型加进了白名单，这条 CSP 还能兜住。
    .header('content-security-policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  return reply.send(openNodeStream(node))
})

/**
 * Content-Disposition 头。
 *
 * 文件名会进 HTTP 头，必须防注入：非 ASCII 用 RFC 5987 的 filename*，
 * 同时给一个净化过的 ASCII 回退名（`fallback` 用于"回退名不该是下划线"
 * 的场合，例如「社团账目-2026-10-19.csv」按字符替换会退成「______-…」）。
 *
 * ⚠️ `encodeURIComponent` 不转义 `' ( ) *`，而这四个字符不在 RFC 5987 的
 * attr-char 里 —— 留着会把整个头变成非法值。活动名是用户可控的，
 * 名字里带个单引号（`'`）就会中招，所以这里补上。
 */
function contentDisposition(name: string, fallback?: string): string {
  const ascii = (fallback ?? name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------- 分片上传

const initUploadSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64).optional(),
  space: z.enum(['shared', 'private']).optional(),
})

app.post('/api/uploads', async (req) => {
  const user = requireUser(req)
  // 上传会话会创建临时文件，且未完成的会话占着磁盘。
  // 不限流的话，一个人循环发起大文件上传就能把 NAS 盘写满。
  enforceRateLimit(req, 'upload', `:${user.id}`)
  const body = initUploadSchema.parse(req.body)
  // 单文件硬上限**默认关闭**（MAX_UPLOAD_BYTES = 0 表示不限）。
  // 真正保护机器的是 initUpload 里的磁盘余量守卫 —— 见 files.ts 的 assertDiskSpace。
  // 这里只留给"我就是想设个上限"的运维用。
  if (MAX_UPLOAD_BYTES > 0 && body.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      `文件超过上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` +
        `（这个限制是可选的，在 .env 里把 WL_MAX_UPLOAD_BYTES 设成 0 就取消。）`,
    )
  }
  const space = body.space ?? 'shared'

  const result = await initUpload({
    userId: user.id,
    parentId: body.parentId ?? null,
    name: body.name,
    size: body.size,
    sha256: body.sha256 ?? null,
    space,
  })

  if (result.instant) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'file',
      action: 'upload-instant',
      target: result.nodeId,
      payload: { name: body.name, size: body.size },
    })
  }

  return result
})

app.put('/api/uploads/:id/chunk', async (req, reply) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const offset = Number.parseInt((req.query as { offset?: string }).offset ?? '0', 10)
  if (!Number.isFinite(offset) || offset < 0) throw new HttpError(400, 'offset 不合法')
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请以 application/octet-stream 提交分片')

  const result = await appendChunk(id, user.id, offset, req.body)
  return reply.send(result)
})

app.post('/api/uploads/:id/complete', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const upload = getUpload(id)
  if (!upload) throw new HttpError(404, '上传会话不存在')

  // 空间跟着上传会话走（v10 起会话自己记着 space）：?space= 一律忽略。
  const result = await completeUpload(id, user.id)

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'file',
    action: 'upload',
    target: result.nodeId,
    payload: { name: upload.name, size: upload.declared_size, mime: result.mime },
  })
  return result
})

app.get('/api/uploads/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const upload = getUpload(id)
  if (!upload || upload.user_id !== user.id) throw new HttpError(404, '上传会话不存在')
  return { uploadId: upload.id, offset: upload.received, name: upload.name, status: upload.status }
})

app.delete('/api/uploads/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const upload = getUpload(id)
  if (!upload || upload.user_id !== user.id) throw new HttpError(404, '上传会话不存在')
  await discardUpload(id)
  return { ok: true }
})

// ---------------------------------------------------------------- 工具与任务

app.get('/api/tools', async (req) => {
  requireUser(req)
  return { tools: describeTools() }
})

const runToolSchema = z.object({
  nodeIds: z.array(z.string()).default([]),
  params: z.record(z.string(), z.unknown()).default({}),
  space: z.enum(['shared', 'private']).optional(),
})

app.post('/api/tools/:toolId/run', async (req) => {
  const user = requireUser(req)
  const { toolId } = req.params as { toolId: string }
  const body = runToolSchema.parse(req.body)
  const tool = getTool(toolId)
  if (!tool) throw new HttpError(404, `未知工具：${toolId}`)

  const verdict = tool.availability()
  if (!verdict.available) throw new HttpError(503, verdict.reason)

  if (body.nodeIds.length < tool.minInputs) {
    throw new HttpError(400, `${tool.name} 需要至少 ${tool.minInputs} 个输入文件`)
  }
  if (body.nodeIds.length > tool.maxInputs) {
    throw new HttpError(400, `${tool.name} 最多接受 ${tool.maxInputs} 个输入文件`)
  }

  for (const id of body.nodeIds) {
    const node = getNode(id)
    if (!node) throw new HttpError(404, `输入文件不存在：${id}`)
    if (!canRead(node, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权使用该文件')
  }

  const jobId = createJob({
    userId: user.id,
    toolId,
    inputNodeIds: body.nodeIds,
    params: body.params,
    space: body.space ?? 'shared',
  })

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'tool',
    action: 'run',
    target: jobId,
    payload: { tool: toolId, inputs: body.nodeIds.length },
  })

  return { jobId }
})

app.get('/api/jobs/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const job = getJob(id)
  if (!job) throw new HttpError(404, '任务不存在')
  if (job.user_id !== user.id && !roleAtLeast(user.role, 'admin')) {
    throw new HttpError(403, '无权查看该任务')
  }
  const view = jobView(job)
  const extra = jobResult(id)
  return {
    job: {
      id: view.id,
      kind: view.kind,
      state: view.state,
      progress: view.progress,
      error: view.error,
      outputNodeIds: extra?.outputIds ?? view.output_node_ids,
      data: extra?.data ?? view.data,
      message: extra?.message ?? null,
      createdAt: view.created_at,
      finishedAt: view.finished_at,
    },
  }
})

app.get('/api/jobs', async (req) => {
  const user = requireUser(req)
  const rows = getDb()
    .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(user.id) as unknown as Array<Parameters<typeof jobView>[0]>
  return { jobs: rows.map((row) => jobView(row)).map((view) => ({
    id: view.id,
    kind: view.kind,
    state: view.state,
    progress: view.progress,
    error: view.error,
    outputNodeIds: jobResult(view.id)?.outputIds ?? view.output_node_ids,
    createdAt: view.created_at,
  })) }
})

// ---------------------------------------------------------------- 管理

app.get('/api/admin/overview', async (req) => {
  const user = requireRole(req, 'admin')
  const stats = storageStats()
  const users = getDb()
    .prepare('SELECT id, username, display_name, role, status, created_at, last_login_at FROM users ORDER BY created_at')
    .all() as Array<Record<string, unknown>>
  const invites = getDb()
    .prepare('SELECT code, role, max_uses, uses, expires_at, created_at, note FROM invites ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>
  const chain = verifyChain()
  return {
    stats,
    users,
    invites,
    audit: { records: chain.checked, chainOk: chain.ok, head: chainHead() },
    canManage: roleAtLeast(user.role, 'admin'),
    // 存储一致性自检。
    // 这个函数原本写了却从没被调用（等于装了报警器没接电源）——
    // 现在管理员打开管理页就能看到：引用计数有没有对不上的、有没有内容丢了。
    blobAudit: auditBlobRefCounts(),
  }
})

const inviteSchema = z.object({
  role: z.enum(['member', 'admin']).default('member'),
  maxUses: z.number().int().positive().max(100).default(1),
  expiresInDays: z.number().int().positive().max(365).optional(),
  note: z.string().max(200).optional(),
})

app.post('/api/admin/invites', async (req) => {
  const user = requireRole(req, 'admin')
  const body = inviteSchema.parse(req.body ?? {})
  const code = createInvite({
    createdBy: user.id,
    role: body.role,
    maxUses: body.maxUses,
    expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * 86400_000 : null,
    note: body.note,
  })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'create-invite',
    target: code,
    payload: { role: body.role, maxUses: body.maxUses },
  })
  return { code }
})

/** 作废邀请码（软删不存在，直接删行；用过的邀请码不再有用，历史留痕在审计里）。 */
app.delete('/api/admin/invites/:code', async (req) => {
  const user = requireRole(req, 'admin')
  const { code } = req.params as { code: string }
  const removed = revokeInvite(code)
  if (!removed) throw new HttpError(404, '邀请码不存在或已被删除')
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'revoke-invite',
    target: code,
  })
  return { ok: true }
})

// ---------------------------------------------------------------- 成员管理

/**
 * 操作者能否管理某个目标用户。
 *
 * 规则（越权一律 403，且**拒绝本身也记审计**，见调用处）：
 *   ① 管理员只能管"比自己低一级"的账号。admin 管不了别的 admin，更管不了 owner；
 *      owner 可以管 admin 与 member。
 *   ② 任何人都不能改自己的角色，也不能停用自己 —— 防止误操作把自己锁在外面，
 *      也堵住"自我提权"这条最容易被忽视的路径。
 *   ③ 角色只能由 owner 调整（撤销/授予管理员属于高风险管理动作）。
 */
function assertCanManageUser(req: FastifyRequest, actor: User, target: User): void {
  if (actor.id === target.id) {
    // 自己不能动自己的角色/状态；显示名请走 /api/me。
    return
  }
  if (!roleAtLeast(actor.role, 'owner') && roleAtLeast(target.role, 'admin')) {
    // ⚠️ 拒绝**也要留痕**。这不是"顺手加的"，而是这类接口唯一能发现
    // "有人在试探边界"的地方 —— 一个普通管理员反复尝试操作 owner，
    // 审计里应该看得见；只在成功时记日志等于把探测行为全部放过。
    auditDeniedUserManage(req, actor, target.id, '试图操作同级或更高级别的账号')
    throw new HttpError(403, '管理员只能管理普通成员，不能操作其他管理员或创建者')
  }
}

/** 记录一条被拒的管理尝试（红线触发时用）。 */
function auditDeniedUserManage(req: FastifyRequest, actor: User, targetId: string, reason: string): void {
  audit({
    actorId: actor.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'user-manage-denied',
    target: targetId,
    payload: { reason },
  })
}

const userUpdateSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

/**
 * 改成员资料：显示名 / 角色 / 状态（启用停用）。
 *
 * 凡涉及权限与账户的写操作都写审计（谁改了谁、改了哪几项），口令相关一律不落明文。
 */
app.patch('/api/admin/users/:id', async (req) => {
  const actor = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = userUpdateSchema.parse(req.body)

  const target = getUserById(id)
  if (!target) throw new HttpError(404, '用户不存在')

  assertCanManageUser(req, actor, target)

  // 红线①：不能停用/降级最后一个 owner。
  //
  // 放在"不能改自己"之前，是有意的：唯一 owner 停用/降级自己时，
  // 用户看到的最该是"这是最后一位创建者，不能这么做"，而不是一句
  // "不能停用自己的账号" —— 后者没解释清楚会造成多大后果。
  const losingOwner =
    target.role === 'owner' &&
    ((body.role !== undefined && body.role !== 'owner') || body.status === 'disabled')
  if (losingOwner) {
    // 只有当前是 active 的 owner 才算"还能管事的人"。
    const remaining = countActiveUsersByRole('owner') - (target.status === 'active' ? 1 : 0)
    if (remaining < 1) {
      auditDeniedUserManage(req, actor, id, 'last-owner')
      throw new HttpError(400, '这是最后一位创建者（owner），停用或降级后将无人能管理系统')
    }
  }

  // 红线②：不能改自己的角色，也不能停用自己（防止自我提权 / 把自己锁在外面）。
  // 注意：对"唯一 owner 停用/降级自己"这种更危险的情况，上面那条已经先拦下了。
  if (actor.id === target.id) {
    if (body.role !== undefined && body.role !== target.role) {
      auditDeniedUserManage(req, actor, id, 'role-self-change')
      throw new HttpError(400, '不能修改自己的角色')
    }
    if (body.status === 'disabled') {
      auditDeniedUserManage(req, actor, id, 'status-self-disable')
      throw new HttpError(400, '不能停用自己的账号')
    }
  }

  // 红线③：只有 owner 能调整角色。
  if (body.role !== undefined && body.role !== target.role && !roleAtLeast(actor.role, 'owner')) {
    auditDeniedUserManage(req, actor, id, 'role-change-needs-owner')
    throw new HttpError(403, '只有创建者（owner）可以调整成员角色')
  }

  const changed: Record<string, [string, string]> = {}
  if (body.displayName !== undefined && body.displayName.trim() !== target.display_name) {
    changed.displayName = [target.display_name, body.displayName.trim()]
  }
  if (body.role !== undefined && body.role !== target.role) {
    changed.role = [target.role, body.role]
  }
  if (body.status !== undefined && body.status !== target.status) {
    changed.status = [target.status, body.status]
  }

  const updated = updateUser(id, body)

  // 停用账号要同时踢下线，否则那个人的旧会话还活着，停用等于没停。
  if (body.status === 'disabled' && target.status !== 'disabled') {
    revokeAllSessions(id)
  }

  audit({
    actorId: actor.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'user-update',
    target: id,
    payload: { username: target.username, changes: changed },
  })
  return { user: updated }
})

/**
 * 重置某个成员的口令（管理员操作）。
 *
 * 不要求旧口令 —— 管理员本来就不该知道成员的口令。但正因为是"异常操作"，
 * 必须：过 passwordProblem 强度校验、audit 留痕（只记"已重置"、绝不记口令）、
 * 并吊销目标用户的全部会话，逼他重新登录（否则旧会话还活着，重置等于没重置）。
 */
app.post('/api/admin/users/:id/password', async (req) => {
  const actor = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z
    .object({ password: z.string().min(1), oldPassword: z.string().optional() })
    .parse(req.body)

  const target = getUserById(id)
  if (!target) throw new HttpError(404, '用户不存在')
  assertCanManageUser(req, actor, target)

  /**
   * ⚠️ **改自己的口令时，必须验旧口令。**
   *
   * 这一条是审查抓出来的真漏洞：`assertCanManageUser` 对"自己"是直接放行的，
   * 而这条路由原来不要求旧口令 —— 于是任何人只要拿到一个管理员的
   * **会话 cookie**（XSS、公用设备没退、cookie 被抄），就能：
   *   POST /api/admin/users/<他自己>/password { password: '我的新口令' }
   * 静默把口令换掉 —— 原主被锁在外面，攻击者拿到了账号。
   *
   * 而"改自己的口令"这条路径在 /api/me/password 里是**要求旧口令**的。
   * 同一个动作，两条路径两种强度，等于白设一道防线。
   *
   * 管理员重置**别人**的口令仍然不需要旧口令（他本来就不该知道）。
   */
  if (target.id === actor.id) {
    if (!body.oldPassword) {
      throw new HttpError(400, '改自己的口令需要先验证当前口令')
    }
    const record = findUserByUsername(target.username)
    if (!record || !verifyPassword(body.oldPassword, record.password_hash)) {
      auditDeniedUserManage(req, actor, target.id, '改自己口令时旧口令不正确')
      throw new HttpError(401, '当前口令不正确')
    }
  }

  const problem = passwordProblem(body.password)
  if (problem) throw new HttpError(400, problem)

  setPassword(id, body.password)
  revokeAllSessions(id)
  audit({
    actorId: actor.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'user-password-reset',
    target: id,
    // 口令本身绝不落库；这里只记"谁重置了谁的口令、是不是自己改自己"
    payload: { username: target.username, note: 'password reset', self: target.id === actor.id },
  })
  return { ok: true }
})

/** 强制某个成员下线（吊销其全部会话）。 */
app.post('/api/admin/users/:id/sessions/revoke', async (req) => {
  const actor = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const target = getUserById(id)
  if (!target) throw new HttpError(404, '用户不存在')
  assertCanManageUser(req, actor, target)

  revokeAllSessions(id)
  audit({
    actorId: actor.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'user-session-revoke',
    target: id,
    payload: { username: target.username },
  })
  return { ok: true }
})

app.get('/api/admin/audit', async (req) => {
  requireRole(req, 'admin')
  const query = req.query as { from?: string; limit?: string }
  const from = Number.parseInt(query.from ?? '0', 10) || 0
  const limit = Math.min(2000, Number.parseInt(query.limit ?? '200', 10) || 200)
  const rows = exportAudit(from, limit)
  return {
    records: rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      actorId: row.actor_id,
      category: row.category,
      action: row.action,
      target: row.target,
      payload: row.payload,
      hash: row.hash,
    })),
  }
})

// ---------------------------------------------------------------- 聊天

/**
 * 实时事件流（SSE）。
 *
 * 这里必须 reply.hijack()：我们直接写 raw response，不能让 Fastify 再发一次
 * 它自己的响应头。
 */
app.get('/api/chat/stream', async (req, reply) => {
  const user = requireUser(req)
  reply.hijack()
  // hijack 之后要自己处理错误：连接建立阶段就失败的话，至少给个状态码
  try {
    const unsubscribe = subscribe(user.id, reply)
    // subscribe 返回 null 表示连接数超限。这里必须明确拒绝 ——
    // 否则会留下一个已经写了 200 头、但没有任何东西喂给它的空响应。
    if (!unsubscribe) {
      reply.raw.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' })
      reply.raw.end(
        JSON.stringify({
          error: '实时连接过多（每人最多 12 条、全站最多 500 条）。请关掉一些页面后重试。',
        }),
      )
      return
    }
    req.raw.on('close', unsubscribe)
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'chat-stream-open',
    })
  } catch (err) {
    req.log.error(err)
    reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
    reply.raw.end(JSON.stringify({ error: '无法建立实时连接' }))
  }
})

app.get('/api/chat/contacts', async (req) => {
  const user = requireUser(req)
  return { contacts: listContacts(user.id) }
})

app.get('/api/chat/conversations', async (req) => {
  const user = requireUser(req)
  const list = listConversations(user.id)
  const overview = {
    conversations: list,
    totalUnread: list.reduce((sum, c) => sum + c.unread, 0),
  }
  // 顺手推一次未读总数，让任务栏角标保持准确
  pushTo([user.id], { type: 'unread', data: { total: overview.totalUnread } })
  return overview
})

const directSchema = z.object({ peerId: z.string().min(1) })

app.post('/api/chat/conversations/direct', async (req) => {
  const user = requireUser(req)
  const body = directSchema.parse(req.body)
  const id = getOrCreateDirect(user.id, body.peerId)

  const conversation = getConversation(id, user.id)
  const ids = memberIdsOf(id)
  pushTo(ids, { type: 'conversation', data: { conversationId: id } })

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'chat',
    action: 'open-direct',
    target: id,
    payload: { peerId: body.peerId },
  })
  return { conversation }
})

const groupSchema = z.object({
  title: z.string().min(1).max(64),
  memberIds: z.array(z.string()).max(200).default([]),
})

app.post('/api/chat/conversations/group', async (req) => {
  const user = requireUser(req)
  const body = groupSchema.parse(req.body)
  const id = createGroup(user.id, body.title, body.memberIds)

  pushTo(memberIdsOf(id), { type: 'conversation', data: { conversationId: id } })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'chat',
    action: 'create-group',
    target: id,
    payload: { title: body.title, memberCount: body.memberIds.length + 1 },
  })
  return { conversation: getConversation(id, user.id) }
})

app.get('/api/chat/conversations/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  return {
    conversation: getConversation(id, user.id),
    members: conversationMembers(id, user.id),
    receipts: readReceipts(id, user.id),
  }
})

app.get('/api/chat/conversations/:id/messages', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const query = req.query as { before?: string; since?: string; limit?: string }
  const options: { before?: number; since?: number; limit?: number } = {}
  if (query.before) options.before = Number.parseInt(query.before, 10)
  if (query.since) options.since = Number.parseInt(query.since, 10)
  if (query.limit) options.limit = Number.parseInt(query.limit, 10)
  return listMessages(id, user.id, options)
})

const sendSchema = z.object({
  kind: z.enum(['text', 'file']).default('text'),
  body: z.string().max(4000).optional(),
  fileNodeId: z.string().optional(),
  replyTo: z.string().optional(),
})

app.post('/api/chat/conversations/:id/messages', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = sendSchema.parse(req.body)

  // 发言限流。一条消息的代价不止是写一行：它还要触发 FTS 索引、
  // 对每个其他成员算一次未读数（那是全表聚合）、再各推一次 SSE。
  // 不限流的话，一个人刷屏就能把单核 CPU 打满。
  enforceRateLimit(req, 'chatSend', `:${user.id}`)

  // 文件消息要确认用户确实能读到这个文件，否则等于给了一条越权读取的通道
  if (body.kind === 'file' && body.fileNodeId) {
    const node = getNode(body.fileNodeId)
    if (!node) throw new HttpError(404, '文件不存在')
    if (!canRead(node, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权分享该文件')
  }

  const message = sendMessage({
    conversationId: id,
    senderId: user.id,
    kind: body.kind,
    body: body.body ?? null,
    fileNodeId: body.fileNodeId ?? null,
    replyTo: body.replyTo ?? null,
  })

  const ids = memberIdsOf(id)
  pushTo(ids, { type: 'message', data: message })
  // 发给其他成员的未读总数
  for (const uid of ids) {
    if (uid === user.id) continue
    pushTo([uid], { type: 'unread', data: { total: totalUnread(uid) } })
  }

  return { message }
})

const readSchema = z.object({ seq: z.number().int().nonnegative() })

app.post('/api/chat/conversations/:id/read', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = readSchema.parse(req.body)
  const lastReadSeq = markRead(id, user.id, body.seq)

  pushTo(memberIdsOf(id), {
    type: 'read',
    data: { conversationId: id, userId: user.id, lastReadSeq },
  })
  pushTo([user.id], { type: 'unread', data: { total: totalUnread(user.id) } })
  return { lastReadSeq }
})

app.patch('/api/chat/messages/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z.object({ body: z.string().min(1).max(4000) }).parse(req.body)
  const message = editMessage(id, user.id, body.body)
  pushTo(memberIdsOf(message.conversationId), { type: 'message-updated', data: message })
  return { message }
})

app.post('/api/chat/messages/:id/recall', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const before = fetchMessage(id)
  const message = recallMessage(id, user.id, roleAtLeast(user.role, 'admin'))
  pushTo(memberIdsOf(message.conversationId), { type: 'message-updated', data: message })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'chat',
    action: 'recall',
    target: id,
    payload: { conversationId: before.conversationId },
  })
  return { message }
})

const typingSchema = z.object({ conversationId: z.string().min(1) })

app.post('/api/chat/typing', async (req) => {
  const user = requireUser(req)
  const body = typingSchema.parse(req.body)
  const ids = memberIdsOf(body.conversationId)
  // 先确认是成员再广播，否则任何人都能对任意会话制造"正在输入"
  if (!ids.includes(user.id)) throw new HttpError(403, '你不是该会话的成员')
  pushTo(
    ids.filter((uid) => uid !== user.id),
    {
      type: 'typing',
      data: { conversationId: body.conversationId, userId: user.id, displayName: user.display_name },
    },
  )
  return { ok: true }
})

app.get('/api/chat/search', async (req) => {
  const user = requireUser(req)
  const query = req.query as { q?: string }
  return { hits: searchMessages(user.id, query.q ?? '') }
})

app.post('/api/admin/chat/group', async (req) => {
  const user = requireRole(req, 'admin')
  const body = z
    .object({ title: z.string().min(1), memberIds: z.array(z.string()).default([]) })
    .parse(req.body)
  const id = createGroup(user.id, body.title, body.memberIds)
  pushTo(memberIdsOf(id), { type: 'conversation', data: { conversationId: id } })
  return { conversationId: id }
})

// ---------------------------------------------------------------- 记账

/**
 * 记账的所有路由。
 *
 * 权限边界（与 ledger.ts 里的注释一致）：
 *   成员 —— 建/改/提交自己的草稿，查看全部非草稿账目（社团账目对成员透明）
 *   管理员 —— 审批、驳回、标记支付，管理分类，可改任意账目
 *
 * 每一处涉及金额或状态变更的操作都写审计日志：这是唯一直接对应"钱"的模块。
 */

/** 分类列表。首次访问时灌入默认分类，避免空界面让人以为功能坏了。 */
app.get('/api/ledger/categories', async (req) => {
  requireUser(req)
  seedDefaultCategories()
  const query = req.query as { includeArchived?: string }
  return { categories: listCategories(query.includeArchived === '1') }
})

const categorySchema = z.object({
  name: z.string().min(1).max(20),
  kind: z.enum(['income', 'expense']),
  icon: z.string().max(32).optional(),
})

app.post('/api/ledger/categories', async (req) => {
  const user = requireRole(req, 'admin')
  seedDefaultCategories()
  const body = categorySchema.parse(req.body)
  const category = createCategory(body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'ledger-create-category',
    target: category.id,
    payload: { name: category.name, kind: category.kind },
  })
  return { category }
})

app.patch('/api/ledger/categories/:id', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z.object({ archived: z.boolean() }).parse(req.body)
  archiveCategory(id, body.archived)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: body.archived ? 'ledger-archive-category' : 'ledger-restore-category',
    target: id,
  })
  return { ok: true }
})

/**
 * 查询串 → 账目筛选条件。
 *
 * ⚠️ **列表接口和导出接口必须共用这一份解析**，这是修一个真实事故留下的：
 * 导出原来自己抄了一遍条件（只认 from/to/kind/status/eventId），于是
 * **搜索词 / 分类 / 只看我的 / 待我审批 这四项在导出里被静默丢掉** ——
 * 用户筛出 3 条，点「导出 CSV」拿到的是全部几百条，而界面上的筛选摘要
 * 还写着「搜索「场地」· 仅支出」。这种错最坏的地方是它不报错：
 * 你得拿筛出来的列表一行行去对，才会发现导出的表多了东西。
 *
 * 所以这里不复制粘贴：两个入口引用同一个函数，将来加筛选条件也只会加一次。
 */
function ledgerFiltersFromQuery(q: Record<string, string | undefined>): ListOptions {
  return {
    from: q.from,
    to: q.to,
    kind: q.kind === 'income' || q.kind === 'expense' ? q.kind : undefined,
    categoryId: q.categoryId,
    status: q.status as never,
    eventId: q.eventId,
    search: q.search?.trim().slice(0, 60) || undefined,
    mine: q.mine === '1',
    pendingReview: q.pending === '1',
  }
}

app.get('/api/ledger/entries', async (req) => {
  const user = requireUser(req)
  seedDefaultCategories()
  const q = req.query as Record<string, string | undefined>
  return listEntries(user.id, roleAtLeast(user.role, 'admin'), {
    ...ledgerFiltersFromQuery(q),
    limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
    offset: q.offset ? Number.parseInt(q.offset, 10) : undefined,
  })
})

/**
 * 新建账目。
 *
 * 金额用字符串传进来（"12.50"），在服务端解析成整数分。
 * 不让前端传分：那样前端就得自己做浮点转整数，而浮点误差恰恰是从那里进来的。
 */
const entrySchema = z.object({
  kind: z.enum(['income', 'expense']),
  amount: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  title: z.string().min(1).max(100),
  note: z.string().max(1000).nullable().optional(),
  occurredOn: z.string().min(1),
  /** 归属的活动（比赛/活动）。不传或 null = 日常账目。 */
  eventId: z.string().nullable().optional(),
  attachmentNodeIds: z.array(z.string()).max(20).optional(),
  splits: z
    .array(z.object({ userId: z.string(), amount: z.string() }))
    .max(50)
    .optional(),
})

function parseSplits(splits?: Array<{ userId: string; amount: string }>): Array<{
  userId: string
  amountCents: number
}> | undefined {
  if (!splits) return undefined
  return splits.map((s) => ({
    userId: s.userId,
    amountCents: parseAmountToCents(s.amount),
  }))
}

app.post('/api/ledger/entries', async (req) => {
  const user = requireUser(req)
  const body = entrySchema.parse(req.body)

  const amountCents = parseAmountToCents(body.amount)

  // 附件必须是当前用户能读到的文件，否则等于开了一条越权引用通道
  for (const nodeId of body.attachmentNodeIds ?? []) {
    const node = getNode(nodeId)
    if (!node) throw new HttpError(404, `凭证文件不存在：${nodeId}`)
    if (!canRead(node, user.id, roleAtLeast(user.role, 'admin'))) throw new HttpError(403, '无权引用该文件作为凭证')
  }

  const entry = createEntry(
    user.id,
    {
      kind: body.kind,
      amountCents,
      categoryId: body.categoryId ?? null,
      title: body.title,
      note: body.note ?? null,
      occurredOn: body.occurredOn,
      eventId: body.eventId ?? null,
      attachmentNodeIds: body.attachmentNodeIds,
      splits: parseSplits(body.splits),
    },
    // 管理员/创建者建的账目直接入账（不经审批），理由见 ledger.ts 的 createEntry
    roleAtLeast(user.role, 'admin'),
  )

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-create',
    target: entry.id,
    payload: {
      kind: entry.kind,
      amountCents,
      title: entry.title,
      occurredOn: entry.occurredOn,
      eventId: entry.eventId,
      status: entry.status,
    },
  })
  return { entry }
})

app.get('/api/ledger/entries/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const entry = getEntry(id)
  if (!entry) throw new HttpError(404, '账目不存在')
  // 草稿只有创建者和管理员能看到
  if (
    entry.status === 'draft' &&
    entry.createdBy !== user.id &&
    !roleAtLeast(user.role, 'admin')
  ) {
    throw new HttpError(403, '无权查看该账目')
  }
  return { entry }
})

app.patch('/api/ledger/entries/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = entrySchema.partial().parse(req.body)

  const patch: Parameters<typeof updateEntry>[3] = {}
  if (body.kind) patch.kind = body.kind
  if (body.amount) patch.amountCents = parseAmountToCents(body.amount)
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId
  if (body.title) patch.title = body.title
  if (body.note !== undefined) patch.note = body.note
  if (body.occurredOn) patch.occurredOn = body.occurredOn
  if (body.eventId !== undefined) patch.eventId = body.eventId
  if (body.attachmentNodeIds) patch.attachmentNodeIds = body.attachmentNodeIds
  if (body.splits) patch.splits = parseSplits(body.splits)

  const entry = updateEntry(id, user.id, roleAtLeast(user.role, 'admin'), patch)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-update',
    target: id,
    payload: { amountCents: entry.amountCents, title: entry.title },
  })
  return { entry }
})

app.delete('/api/ledger/entries/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const before = getEntry(id)
  deleteEntry(id, user.id, roleAtLeast(user.role, 'admin'))
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-delete',
    target: id,
    payload: { title: before?.title, amountCents: before?.amountCents },
  })
  return { ok: true }
})

app.post('/api/ledger/entries/:id/submit', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const entry = submitEntry(id, user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-submit',
    target: id,
    payload: { amountCents: entry.amountCents },
  })
  return { entry }
})

app.post('/api/ledger/entries/:id/withdraw', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const entry = withdrawEntry(id, user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-withdraw',
    target: id,
  })
  return { entry }
})

app.post('/api/ledger/entries/:id/decide', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z
    .object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() })
    .parse(req.body)

  const entry = decideEntry(id, user.id, body.decision, body.note, true)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: body.decision === 'approve' ? 'ledger-approve' : 'ledger-reject',
    target: id,
    payload: { amountCents: entry.amountCents, title: entry.title, note: body.note ?? null },
  })
  return { entry }
})

app.post('/api/ledger/entries/:id/pay', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const entry = markPaid(id, user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-pay',
    target: id,
    payload: { amountCents: entry.amountCents },
  })
  return { entry }
})

app.post('/api/ledger/entries/:id/splits/:userId/settle', async (req) => {
  const user = requireUser(req)
  const { id, userId } = req.params as { id: string; userId: string }
  const body = z.object({ settled: z.boolean() }).parse(req.body)
  settleSplit(id, userId, user.id, roleAtLeast(user.role, 'admin'), body.settled)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: body.settled ? 'ledger-settle' : 'ledger-unsettle',
    target: id,
    payload: { splitUserId: userId },
  })
  return { ok: true }
})

app.get('/api/ledger/summary', async (req) => {
  requireUser(req)
  const q = req.query as { from?: string; to?: string }
  return { summary: summary({ from: q.from, to: q.to }) }
})

app.get('/api/ledger/debts', async (req) => {
  requireUser(req)
  const q = req.query as { eventId?: string }
  return { debts: outstandingDebts(q.eventId) }
})

app.get('/api/ledger/export.csv', async (req, reply) => {
  const user = requireUser(req)
  const q = req.query as Record<string, string | undefined>
  // 与 /api/ledger/entries 用同一份筛选解析：导出的表必须就是用户筛出来的那张表。
  const filters = ledgerFiltersFromQuery(q)
  const csv = exportCsv(user.id, roleAtLeast(user.role, 'admin'), filters)

  // 审计里记下**实际生效**的筛选，而不是只记日期。
  // "这份表是按什么条件导出来的"在事后对账时是必须能回答的问题，
  // 只记 from/to 的话，一次"按分类导出的表"在审计里会和"全量导出"长得一样。
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-export',
    payload: {
      from: filters.from ?? null,
      to: filters.to ?? null,
      kind: filters.kind ?? null,
      categoryId: filters.categoryId ?? null,
      status: filters.status ?? null,
      eventId: filters.eventId ?? null,
      search: filters.search ?? null,
      mine: filters.mine ?? false,
      pending: filters.pendingReview ?? false,
    },
  })

  const filename = `社团账目-${new Date().toISOString().slice(0, 10)}.csv`
  // 加 BOM：不加的话 Excel 打开会把中文显示成乱码，这是中文 CSV 最常见的翻车点
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    // 回退名给一个干净的 ASCII（按字符替换的话中文会退成一排下划线）
    .header('content-disposition', contentDisposition(filename, 'ledger.csv'))
  return reply.send(`﻿${csv}`)
})

// ---------------------------------------------------------------- 活动 / 比赛

/**
 * 活动（比赛/活动/其它）的归集接口。
 *
 * 权限：
 *   - 看（列表/详情/汇总/导出）：所有登录成员。活动账目应当对社团透明。
 *   - 建活动：所有登录成员 —— 活动往往是"谁张罗谁建"。
 *   - 改活动 / 封账：管理员或该活动的创建者（封账会让活动变成只读，属于管理动作）。
 */

const eventSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['competition', 'activity', 'other']).optional(),
  startOn: z.string().nullable().optional(),
  endOn: z.string().nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
})

app.get('/api/ledger/events', async (req) => {
  requireUser(req)
  const q = req.query as { open?: string }
  return { events: listEvents({ includeClosed: q.open !== '1' }) }
})

app.post('/api/ledger/events', async (req) => {
  const user = requireUser(req)
  const body = eventSchema.parse(req.body)
  const event = createEvent(user.id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-create-event',
    target: event.id,
    payload: { name: event.name, kind: event.kind },
  })
  return { event }
})

app.get('/api/ledger/events/:id', async (req) => {
  requireUser(req)
  const { id } = req.params as { id: string }
  const event = getEvent(id)
  if (!event) throw new HttpError(404, '活动不存在')
  return { event }
})

app.patch('/api/ledger/events/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = eventSchema.partial().parse(req.body)
  const event = updateEvent(id, user.id, roleAtLeast(user.role, 'admin'), body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-update-event',
    target: id,
    payload: { name: event.name, kind: event.kind },
  })
  return { event }
})

app.post('/api/ledger/events/:id/close', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z.object({ closed: z.boolean() }).parse(req.body)
  const event = closeEvent(id, user.id, roleAtLeast(user.role, 'admin'), body.closed)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: body.closed ? 'ledger-close-event' : 'ledger-reopen-event',
    target: id,
    payload: { name: event.name },
  })
  return { event }
})

app.get('/api/ledger/events/:id/summary', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  return eventSummary(id, user.id, roleAtLeast(user.role, 'admin'))
})

app.get('/api/ledger/events/:id/export.csv', async (req, reply) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const event = getEvent(id)
  if (!event) throw new HttpError(404, '活动不存在')

  const csv = exportEventCsv(user.id, roleAtLeast(user.role, 'admin'), id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'ledger',
    action: 'ledger-export',
    payload: { eventId: id, name: event.name },
  })

  const filename = `${event.name}-账目-${new Date().toISOString().slice(0, 10)}.csv`
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    // 活动名是用户可控的，contentDisposition 里做了头注入与 RFC 5987 的转义
    .header('content-disposition', contentDisposition(filename, 'ledger-event.csv'))
  return reply.send(`﻿${csv}`)
})

// ---------------------------------------------------------------- 财物管理

/**
 * 社团物品台账与借还记录。
 *
 * 权限模型（刻意的取舍，理由写在下面）：
 *   - **看**：所有登录成员都能看完整台账。社团的家当是公共信息，
 *     而且"柜子里到底有没有这个东西"不问就看得到，才有人愿意用。
 *   - **增删改物品**：只有管理员。改台账会让账面价值变化，属于管理动作。
 *   - **借出 / 归还**：所有成员都能操作，包括替别人还。
 *     这里**不做严格限制**：社团里"他先走了我帮他带回来"太常见，
 *     强制本人操作只会让大家干脆不记账，那样台账会更快烂掉。
 *     所以谁都能操作，但审计日志会如实记下是谁做的。
 */

app.get('/api/assets/categories', async (req) => {
  requireUser(req)
  const q = req.query as { all?: string }
  return { categories: listAssetCategories(q.all === '1') }
})

app.post('/api/assets/categories', async (req) => {
  const user = requireRole(req, 'admin')
  const body = z.object({ name: z.string().min(1).max(24), icon: z.string().max(24).optional() }).parse(req.body)
  const category = createAssetCategory(body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-category-create',
    target: category.id,
    payload: { name: category.name },
  })
  return { category }
})

app.post('/api/assets/categories/:id/archive', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z.object({ archived: z.boolean() }).parse(req.body)
  archiveAssetCategory(id, body.archived)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: body.archived ? 'asset-category-archive' : 'asset-category-restore',
    target: id,
  })
  return { ok: true }
})

app.get('/api/assets/items', async (req) => {
  requireUser(req)
  const q = req.query as {
    categoryId?: string
    q?: string
    status?: string
    available?: string
    onLoan?: string
  }
  return {
    items: listItems({
      categoryId: q.categoryId,
      q: q.q,
      status: q.status === 'retired' || q.status === 'active' ? q.status : undefined,
      onlyAvailable: q.available === '1',
      onlyOnLoan: q.onLoan === '1',
    }),
  }
})

app.get('/api/assets/items/:id', async (req) => {
  requireUser(req)
  const { id } = req.params as { id: string }
  const item = getAssetItem(id)
  if (!item) throw new HttpError(404, '物品不存在')
  // 详情页顺带把它的借还历史带上 —— 点开一件东西，最想知道的
  // 就是"它现在在谁手上、以前被谁借过"
  return { item, loans: listLoans({ itemId: id, limit: 100 }) }
})

const assetItemSchema = z.object({
  name: z.string().min(1).max(60),
  code: z.string().max(40).optional(),
  categoryId: z.string().nullable().optional(),
  totalQty: z.number().int().min(0).max(100000).optional(),
  value: z.union([z.string(), z.number()]).optional(),
  purchasedOn: z.string().optional(),
  location: z.string().max(80).optional(),
  condition: z.enum(['good', 'fair', 'broken', 'lost']).optional(),
  note: z.string().max(1000).optional(),
})

app.post('/api/assets/items', async (req) => {
  const user = requireRole(req, 'admin')
  const body = assetItemSchema.parse(req.body)
  const item = createItem(user.id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-item-create',
    target: item.id,
    payload: { name: item.name, totalQty: item.totalQty, valueCents: item.valueCents },
  })
  return { item }
})

app.patch('/api/assets/items/:id', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = assetItemSchema.partial().parse(req.body)
  const item = updateItem(id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-item-update',
    target: id,
    payload: { name: item.name, totalQty: item.totalQty, condition: item.condition },
  })
  return { item }
})

app.post('/api/assets/items/:id/retire', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z.object({ retired: z.boolean() }).parse(req.body)
  const item = retireItem(id, body.retired)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: body.retired ? 'asset-item-retire' : 'asset-item-restore',
    target: id,
  })
  return { item }
})

app.get('/api/assets/loans', async (req) => {
  const user = requireUser(req)
  const q = req.query as {
    itemId?: string
    mine?: string
    open?: string
    overdue?: string
    search?: string
    limit?: string
  }
  return {
    loans: listLoans({
      itemId: q.itemId,
      // mine=1 是"我借的东西"，个人视角最常用的过滤
      borrowerId: q.mine === '1' ? user.id : undefined,
      q: q.search?.trim().slice(0, 60) || undefined,
      open: q.open === '1',
      overdue: q.overdue === '1',
      limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
    }),
  }
})

app.post('/api/assets/loans', async (req) => {
  const user = requireUser(req)
  const body = z
    .object({
      itemId: z.string().min(1),
      qty: z.number().int().min(1).max(10000).optional(),
      borrowerId: z.string().optional(),
      dueOn: z.string().optional(),
      purpose: z.string().max(200).optional(),
      note: z.string().max(500).optional(),
    })
    .parse(req.body)

  // 普通成员只能"给自己借"。否则任何人都能把"借了 3 台投影仪"记到别人名下，
  // 伪造出一笔别人根本没做过的借款。替他人登记借出是管理员（财务）的权限。
  const isAdmin = roleAtLeast(user.role, 'admin')
  if (body.borrowerId !== undefined && body.borrowerId !== user.id && !isAdmin) {
    throw new HttpError(403, '只有管理员可以代他人登记借出')
  }

  const loan = lendItem(user.id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-lend',
    target: loan.itemId,
    payload: { loanId: loan.id, qty: loan.qty, borrowerId: loan.borrowerId, dueOn: loan.dueOn },
  })
  return { loan }
})

app.post('/api/assets/loans/:id/return', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z
    .object({
      condition: z.enum(['good', 'fair', 'broken', 'lost']).optional(),
      note: z.string().max(500).optional(),
    })
    .parse(req.body ?? {})

  const loan = returnLoan(id, user.id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-return',
    target: loan.itemId,
    payload: { loanId: loan.id, qty: loan.qty, condition: loan.returnCondition },
  })
  return { loan }
})

/** 更正一条借还记录（管理员）：改借用人 / 数量 / 应还日期 / 用途 / 备注。 */
app.patch('/api/assets/loans/:id', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const body = z
    .object({
      qty: z.number().int().min(1).max(10000).optional(),
      borrowerId: z.string().min(1).optional(),
      dueOn: z.string().nullable().optional(),
      purpose: z.string().max(200).nullable().optional(),
      note: z.string().max(500).nullable().optional(),
    })
    .parse(req.body)

  const loan = updateLoan(id, body)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-loan-update',
    target: loan.itemId,
    payload: { loanId: loan.id, qty: loan.qty, borrowerId: loan.borrowerId, dueOn: loan.dueOn },
  })
  return { loan }
})

/**
 * 作废一条借还记录（管理员）。
 *
 * 用"作废"而非删除：借还历史是这模块的主要价值，硬删会连带抹掉
 * "谁记过一笔、谁把它抹了"的痕迹。作废后账面不再把它算作在外，记录仍在。
 */
app.delete('/api/assets/loans/:id', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const loan = voidLoan(id, user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-loan-void',
    target: loan.itemId,
    payload: { loanId: loan.id, qty: loan.qty, borrowerId: loan.borrowerId },
  })
  return { loan }
})

/** 恢复一条被作废的记录（管理员）：作废点错了、或者那笔借款其实成立。 */
app.post('/api/assets/loans/:id/restore', async (req) => {
  const user = requireRole(req, 'admin')
  const { id } = req.params as { id: string }
  const loan = restoreLoan(id, user.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'asset',
    action: 'asset-loan-restore',
    target: loan.itemId,
    payload: { loanId: loan.id, qty: loan.qty, borrowerId: loan.borrowerId },
  })
  return { loan }
})

app.get('/api/assets/summary', async (req) => {
  requireUser(req)
  return { summary: assetSummary(), overdue: overdueLoans().slice(0, 20) }
})

app.get('/api/assets/export/items.csv', async (req, reply) => {
  requireUser(req)
  const csv = exportItemsCsv()
  reply.header('content-type', 'text/csv; charset=utf-8')
  reply.header('content-disposition', `attachment; filename="assets.csv"; filename*=UTF-8''${encodeURIComponent('物品台账.csv')}`)
  // BOM：不加的话 Excel 打开中文是乱码
  return reply.send(`﻿${csv}`)
})

app.get('/api/assets/export/loans.csv', async (req, reply) => {
  requireUser(req)
  const csv = exportLoansCsv()
  reply.header('content-type', 'text/csv; charset=utf-8')
  reply.header('content-disposition', `attachment; filename="loans.csv"; filename*=UTF-8''${encodeURIComponent('借还记录.csv')}`)
  return reply.send(`﻿${csv}`)
})

// ---------------------------------------------------------------- 游戏

/**
 * 游戏房间（当前只有中国象棋）。
 *
 * 服务端权威：客户端提交的只是"我想从 a 走到 b"这个意图，合法性完全由服务端
 * 用规则引擎裁定。前端算的合法性一概不采信 —— 否则改一行前端代码就能作弊。
 */

/**
 * 把象棋房间**按每个人各自的视角**推给所有正在连着的人。
 *
 * ⚠️ 这里绝不能用 broadcast，虽然象棋的棋盘本身是公开信息。
 *
 * 原因：房间视图里的 `mySide` 与 `myTurn` 是**因人而异**的 ——
 * getRoom(id, viewerId) 的第二个参数就是"以谁的视角看"。
 * 而 broadcast 把同一份 payload 发给所有人，于是对手收到的是
 * **落子者视角**的那一份：mySide 变成对面那一边、myTurn 恒为 false。
 *
 * 后果很严重，而且从代码上很难一眼看出来：
 *   - 棋盘上下颠倒（XiangqiBoard 按 mySide === 'black' 决定是否翻转）
 *   - 轮到自己也点不动棋子（GamesApp 用 myTurn 控制棋盘是否可交互）
 *   - 双方就此都卡住 —— 用户看到的就是"象棋无法游玩且 UI 显示异常"
 *
 * 对比斗地主（一直能正常玩）就能看出差别：它用 pushTo 按人推送，
 * 因为手牌是隐藏信息，不得不这么做。象棋是公开信息，但**视角字段**同样是
 * 因人而异的，所以一样不能广播。公开的是棋盘，不是视角。
 *
 * 推送对象用 connectedUserIds()（真实连接表）而不是 onlineUserIds()
 * （带 60 秒宽限期的在线状态）：这里漏推的后果是那个人**界面直接卡住**，
 * 不是状态显示不准，不该让一次写库延迟变成"某人玩不了棋"。
 */
function pushXiangqiRoom(
  roomId: string,
  event: 'game' | 'game-move' = 'game',
  extra: Record<string, unknown> = {},
): void {
  for (const userId of connectedUserIds()) {
    try {
      pushTo([userId], { type: event, data: { roomId, room: getRoom(roomId, userId), ...extra } })
    } catch {
      // 房间可能刚好被删了，忽略这一个订阅者即可，不要让整轮推送中断
    }
  }
}

app.get('/api/games/rooms', async (req) => {
  const user = requireUser(req)
  const q = req.query as { status?: string; kind?: string }
  const status =
    q.status === 'waiting' || q.status === 'playing' || q.status === 'finished'
      ? q.status
      : undefined
  return {
    // ⚠️ 必须**无条件**按 kind 过滤，不能写成"客户端传了才过滤"。
    //
    // `game_rooms` 这张表是象棋 / 斗地主 / 狼人杀**共用**的，而它们的 board 列
    // 语义不同：象棋写的是一局棋盘，另外两个写的是空串（它们的局面在 state 列里）。
    // 不过滤就会把别人的房间也拿来做 deserializeBoard('')，而
    // `''.split('/')` 只有 1 段 —— 于是整个大厅接口 500：
    //   「棋盘应有 10 行，收到 1 行」
    // 用户看到的是"象棋打开就报服务器内部出错"，而根因是隔壁那张斗地主的桌子。
    //
    // 而且这个路由（/api/games/rooms）本来就只服务象棋 —— 斗地主和狼人杀
    // 各有自己的 /api/games/xxx/rooms。所以这里不需要、也不该接受客户端的 kind。
    rooms: listRooms(user.id, { status, kind: 'xiangqi' }),
    stats: myStats(user.id),
  }
})

const roomSchema = z.object({
  kind: z.enum(['xiangqi']).default('xiangqi'),
  title: z.string().max(40).default(''),
  side: z.enum(['red', 'black']).optional(),
})

app.post('/api/games/rooms', async (req) => {
  const user = requireUser(req)
  enforceRateLimit(req, 'createRoom', `:${user.id}`)
  const body = roomSchema.parse(req.body ?? {})
  const room = createRoom({
    kind: body.kind,
    title: body.title || `${user.display_name} 的棋局`,
    creatorId: user.id,
    side: body.side,
  })
  // 大厅里的每个人都要看到新房间，但各自视角不同 —— 按人推
  pushXiangqiRoom(room.id, 'game', { action: 'created' })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'game-create-room',
    target: room.id,
    payload: { kind: room.kind, title: room.title, side: body.side ?? 'red' },
  })
  return { room }
})

app.get('/api/games/rooms/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  return { room: getRoom(id, user.id) }
})

app.post('/api/games/rooms/:id/join', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z.object({ side: z.enum(['red', 'black']).optional() }).parse(req.body ?? {})
  const room = joinRoom(id, user.id, body.side)
  // 一坐下就轮到谁，对两边是不一样的。必须按人推 —— 这里曾经用 broadcast，
  // 结果 creator 立刻收到 joiner 视角的 room，myTurn 变 false，双方当场都点不动。
  pushXiangqiRoom(id, 'game', { action: 'joined' })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'game-join-room',
    target: id,
    payload: { side: room.mySide, status: room.status },
  })
  return { room }
})

app.post('/api/games/rooms/:id/move', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z
    .object({ from: z.string().min(2).max(2), to: z.string().min(2).max(2) })
    .parse(req.body)

  const result = makeMove(id, user.id, user.display_name, body.from, body.to)

  // 落子单独用一个事件名，方便客户端做走子动画而不是整盘重绘。
  //
  // 这里曾经是 broadcast —— 那是"象棋无法游玩"的直接原因：
  // 落子后轮到的是对手，而 broadcast 把**落子者视角**的 room 发给了所有人，
  // 于是对手收到的 myTurn 永远是 false，从此一步也走不了。
  pushXiangqiRoom(id, 'game-move', { move: result.move, finished: result.finished })

  // 对局结束时额外记一条审计（棋局本身不敏感，但"谁跟谁下、结果如何"值得留痕）
  if (result.finished) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'game-finished',
      target: id,
      payload: { winner: result.finished.winner, reason: result.finished.reason, plies: result.room.moves.length },
    })
  }

  return { room: result.room, move: result.move, finished: result.finished }
})

app.post('/api/games/rooms/:id/resign', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const room = resign(id, user.id)
  pushXiangqiRoom(id, 'game', { action: 'finished' })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'game-resign',
    target: id,
  })
  return { room }
})

app.post('/api/games/rooms/:id/leave', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const { room, abandoned } = leaveRoom(id, user.id)
  const action = abandoned ? 'abandoned' : 'left'
  if (room) {
    pushXiangqiRoom(id, 'game', { action })
  } else {
    // 房间已经空了、被删掉 —— 这时候没法再算"以谁的视角看"（getRoom 会抛），
    // 只告诉还在看着它的人"这个房间没了"，前端据此退回大厅。
    pushTo(connectedUserIds(), { type: 'game', data: { roomId: id, room: null, action } })
  }
  if (abandoned) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'game-abandon',
      target: id,
    })
  }
  return { room }
})

/** 某个棋子的合法着法（前端点击棋子时高亮用）。 */
app.get('/api/games/rooms/:id/legal', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const q = req.query as { from?: string }
  if (!q.from) throw new HttpError(400, '缺少 from 参数')
  // 先确认能看到这个房间（getRoom 会做存在性检查）
  getRoom(id, user.id)
  return { targets: legalMovesFor(id, q.from) }
})

// ---------------------------------------------------------------- 管理员两步验证与 Docker 管控

/**
 * 两步验证的绑定流程（三步，刻意不让用户把自己锁在外面）：
 *
 *   1. POST /totp/setup   生成秘密并存入 totp_pending 列（**此时还不生效**）
 *   2. 管理员把它录进验证器 App
 *   3. POST /totp/enable  提交一个动态口令确认，验证通过后才写入 totp_secret 并启用
 *
 * 中间那一步如果用户关掉页面走人，pending 里的秘密不会生效，
 * 账号仍然是原来的状态 —— 不会出现"绑了一半，两边都用不了"。
 */

const adminConfig = loadAdminConfig()

function currentAdminRow(req: FastifyRequest) {
  const user = requireRole(req, 'admin')
  const row = getDb()
    .prepare('SELECT totp_secret, totp_pending, totp_enabled_at FROM users WHERE id = ?')
    .get(user.id) as
    | { totp_secret: string | null; totp_pending: string | null; totp_enabled_at: number | null }
    | undefined
  return { user, row }
}

/** 取出该管理员已启用的 TOTP 秘密（明文），未启用返回 null。 */
function activeTotpSecret(userId: string): string | null {
  const row = getDb().prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as
    | { totp_secret: string | null }
    | undefined
  if (!row?.totp_secret) return null
  try {
    return decryptSecret(row.totp_secret, process.env.WL_SESSION_SECRET ?? '')
  } catch (err) {
    // 解不开通常意味着 WL_SESSION_SECRET 变了。此时不能"当作没绑"放行 ——
    // 那等于悄悄降级掉第二因子。返回 null 会让后续的 checkGate 拒绝变更操作，
    // 并且下面的状态接口会把这种异常状态暴露出来。
    console.error('[admin] TOTP 秘密解密失败（WL_SESSION_SECRET 是否被改过？）:', err)
    return null
  }
}

app.get('/api/admin/totp/status', async (req) => {
  const { user, row } = currentAdminRow(req)
  const secret = row?.totp_secret ?? null
  return {
    bound: Boolean(secret),
    enabledAt: row?.totp_enabled_at ?? null,
    hasPending: Boolean(row?.totp_pending),
    /** 已绑定但解不开（通常是会话密钥被换过）—— 需要在界面上明确提示 */
    broken: Boolean(secret) && activeTotpSecret(user.id) === null,
    dockerEnabled: adminConfig.enabled,
  }
})

/**
 * 重新绑定两步验证时的门禁。
 *
 * 为什么必须有：如果 setup/enable 只要求"当前是管理员"，那么任何拿到
 * 管理员会话的人都能调 setup 拿到一个新秘密、再用自己的验证器算码调 enable，
 * 把账号的第二因子**静默换成他自己的**。
 *
 * ⚠️ 关键设计点：**口令不能单独作为替代**。
 *
 * 登录接口（/api/auth/login）只校验口令、不校验 TOTP —— 所以"知道口令"
 * 既能拿到会话，又如果允许它通过这里，就同时能换掉第二因子。
 * 那等于把 2FA 想挡的"口令泄漏"威胁原样放回来了。
 * 所以已绑定且可解密时，**只接受当前验证器上的动态口令**。
 *
 * 唯一的例外是"秘密解不开"的状态（WL_SESSION_SECRET 被换过）：
 * 此时第二因子已经无法验证（activeTotpSecret 返回 null），再怎么要求动态口令
 * 都验不了。这种情况允许用登录口令恢复，并单独记一条审计 ——
 * 这是刻意的可用性取舍，而不是疏漏。
 */
function assertRebindAllowed(req: FastifyRequest, userId: string, body: unknown): void {
  const existing = getDb().prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as
    | { totp_secret: string | null }
    | undefined

  // 从未绑定过 → 首次绑定，不需要再认证（此时第二因子还不存在）
  if (!existing?.totp_secret) return

  const payload = (body ?? {}) as { currentCode?: unknown; password?: unknown }
  const currentCode = typeof payload.currentCode === 'string' ? payload.currentCode : ''
  const password = typeof payload.password === 'string' ? payload.password : ''

  const secret = activeTotpSecret(userId)

  if (secret) {
    // 正常情况：只能用当前动态口令
    if (currentCode && verifyTotp(secret, currentCode)) return
    audit({
      actorId: userId,
      actorIp: actorIp(req),
      category: 'admin',
      action: 'totp-rebind-denied',
      target: userId,
      payload: { reason: '需要当前动态口令', hadCode: Boolean(currentCode), hadPassword: Boolean(password) },
    })
    throw new HttpError(
      403,
      '账号已绑定两步验证。重新绑定需要先证明身份：请提交当前验证器上的 6 位动态口令。' +
        '（出于安全考虑，登录口令不能替代动态口令 —— 否则口令泄漏就等于 2FA 失效。）',
    )
  }

  // 秘密解不开的恢复路径：此时第二因子已经无法验证，只能用登录口令
  if (password) {
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined
    if (row && verifyPassword(password, row.password_hash)) {
      audit({
        actorId: userId,
        actorIp: actorIp(req),
        category: 'admin',
        action: 'totp-rebind-broken-secret',
        target: userId,
        payload: { note: '秘密无法解密，用登录口令恢复绑定' },
      })
      return
    }
  }

  audit({
    actorId: userId,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'totp-rebind-denied',
    target: userId,
    payload: { reason: '秘密不可解密且口令不正确' },
  })
  throw new HttpError(
    403,
    '两步验证的秘密已无法解密（通常是 WL_SESSION_SECRET 被更换过）。' +
      '这种情况下请用登录口令完成恢复绑定。',
  )
}

app.post('/api/admin/totp/setup', async (req) => {
  const { user } = currentAdminRow(req)

  // 再加一道限流：不带再认证的反复试探也该被挡住
  enforceRateLimit(req, 'totp', `:${user.id}`, true)
  assertRebindAllowed(req, user.id, req.body)

  const secret = generateSecret()
  // 先存 pending，等用户提交一个有效动态口令后再启用
  getDb()
    .prepare('UPDATE users SET totp_pending = ? WHERE id = ?')
    .run(encryptSecret(secret, process.env.WL_SESSION_SECRET ?? ''), user.id)

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'totp-setup-started',
    target: user.id,
  })

  return {
    secret,
    formatted: formatSecretForDisplay(secret),
    otpauthUrl: otpauthUrl({
      secret,
      account: user.username,
      issuer: SITE_NAME,
    }),
  }
})

app.post('/api/admin/totp/enable', async (req) => {
  const { user } = currentAdminRow(req)
  const body = z
    .object({ code: z.string().min(1), currentCode: z.string().optional(), password: z.string().optional() })
    .parse(req.body)

  // 动态口令只有 6 位，不限流的话可以暴力试出来
  enforceRateLimit(req, 'totp', `:${user.id}`, true)
  // 覆盖已有绑定必须先证明身份（见 assertRebindAllowed 的说明）
  assertRebindAllowed(req, user.id, body)

  const row = getDb().prepare('SELECT totp_pending FROM users WHERE id = ?').get(user.id) as
    | { totp_pending: string | null }
    | undefined
  if (!row?.totp_pending) throw new HttpError(400, '请先获取二维码（没有待确认的绑定）')

  let pending: string
  try {
    pending = decryptSecret(row.totp_pending, process.env.WL_SESSION_SECRET ?? '')
  } catch {
    throw new HttpError(400, '待确认的秘密无法解开，请重新获取二维码')
  }

  if (!verifyTotp(pending, body.code)) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'admin',
      action: 'totp-enable-failed',
      payload: { reason: 'code-mismatch' },
    })
    throw new HttpError(400, '动态口令不正确。请确认手机时间准确，再输入验证器当前显示的 6 位数字。')
  }

  getDb()
    .prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled_at = ? WHERE id = ?')
    .run(row.totp_pending, now(), user.id)

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'totp-enabled',
    target: user.id,
  })
  return { ok: true }
})

app.post('/api/admin/totp/disable', async (req) => {
  const { user } = currentAdminRow(req)
  const body = z.object({ code: z.string().min(1) }).parse(req.body)

  // 关掉第二因子同样是敏感操作，必须限流 ——
  // 否则 6 位码可以被暴力枚举，试中就能把两步验证摘掉。
  enforceRateLimit(req, 'totp', `:${user.id}`, true)

  const secret = activeTotpSecret(user.id)
  if (!secret) throw new HttpError(400, '当前没有启用两步验证')
  if (!verifyTotp(secret, body.code)) {
    throw new HttpError(401, '动态口令不正确，无法关闭两步验证')
  }

  getDb()
    .prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL WHERE id = ?')
    .run(user.id)

  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'admin',
    action: 'totp-disabled',
    target: user.id,
  })
  return { ok: true }
})

/** 可执行的运维操作清单。 */
app.get('/api/admin/docker/operations', async (req) => {
  requireRole(req, 'admin')
  return {
    enabled: adminConfig.enabled,
    allowedServices: adminConfig.allowedServices,
    templatesDir: adminConfig.templatesDir,
    operations: describeOperations(),
  }
})

const executeSchema = z.object({
  operationId: z.string().min(1),
  params: z.record(z.string(), z.string()).default({}),
  totpCode: z.string().optional(),
})

/**
 * 执行一个运维操作。
 *
 * 顺序是刻意的：**先过门禁，再构造命令**。门禁不过就绝不会构造出任何 argv，
 * 也就不可能执行。而构造 argv 的过程本身包含全部参数校验。
 */
app.post('/api/admin/docker/execute', async (req, reply) => {
  const user = requireUser(req)
  const body = executeSchema.parse(req.body)

  const operation = findOperation(body.operationId)
  if (!operation) throw new HttpError(404, `未知操作：${body.operationId}`)

  // 即使是管理员也不该在短时间内刷几十条运维命令 ——
  // 这既防手滑，也防"管理员会话被劫持后攻击者批量操作"。
  enforceRateLimit(req, 'ops', `:${user.id}`)

  // 用请求者**本人**的 TOTP 秘密，而不是服务器级的全局秘密 ——
  // 这样每个人各自绑定、各自吊销，也才真正证明"操作的人是他本人"。
  const adminTotpSecret = activeTotpSecret(user.id)
  const gate = checkGate(
    {
      verifyTotp: (secret, code) => verifyTotp(secret, code),
      config: adminConfig,
    },
    {
      isAdmin: roleAtLeast(user.role, 'admin'),
      totpSecret: adminTotpSecret,
      totpCode: body.totpCode,
      clientIp: actorIp(req),
      operation,
    },
  )

  if (!gate.allowed) {
    // 被拒绝的尝试也要留痕 —— "谁反复在试"本身就是重要信号
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'admin',
      action: 'docker-execute-denied',
      target: body.operationId,
      payload: { reason: gate.reason, params: body.params },
    })
    return reply.code(gate.status).send({ error: gate.reason })
  }

  const started = Date.now()
  try {
    const executed = await executeOperation(
      // selectRunner：配了 WL_ADMIN_RUNNER_URL 就转发给独立执行器容器，
      // 否则在本进程执行。容器化部署应当配前者 —— 见 admin/docker.ts 的说明。
      { runner: selectRunner(adminConfig), config: adminConfig },
      body.operationId,
      body.params,
    )

    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'admin',
      action: 'docker-execute',
      target: body.operationId,
      payload: {
        argv: executed.argv,
        exitCode: executed.result.code,
        timedOut: executed.result.timedOut,
        durationMs: Date.now() - started,
      },
    })

    return {
      exitCode: executed.result.code,
      stdout: executed.result.stdout,
      stderr: executed.result.stderr,
      timedOut: executed.result.timedOut,
      argv: executed.argv,
    }
  } catch (err) {
    // AdminError 是"拒绝执行"（参数不合法等），其它是执行期异常。
    // 两者都要进审计 —— 尤其前者，它可能是有人在试探边界。
    const status = err instanceof AdminError ? err.status : 500
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'admin',
      action: 'docker-execute-rejected',
      target: body.operationId,
      payload: { status, message: err instanceof Error ? err.message : String(err), params: body.params },
    })
    if (err instanceof AdminError) return reply.code(status).send({ error: err.message })
    req.log.error(err)
    return reply.code(500).send({ error: '执行失败，请查看审计日志' })
  }
})

// ---------------------------------------------------------------- 斗地主

/**
 * 把房间状态**按每个人各自的视角**推给三个玩家。
 *
 * 这里绝不能用 broadcast：斗地主的手牌是隐藏信息，广播等于把所有人的牌
 * 都发给了每个人（前端藏起来没有用，打开控制台就看见了）。
 *
 * 所以每个玩家收到的 payload 是用 toDoudizhuView(row, 他自己) 算出来的 ——
 * 他的手牌是具体的，别人的只有张数。观战者不推送（他们的界面是只读的，
 * 靠主动拉取即可）。
 */
function pushDoudizhuRoom(roomId: string, event: 'game' | 'game-play' = 'game'): void {
  const playerIds = doudizhuMembers(roomId)
  if (playerIds.length === 0) return
  const online = onlineUserIds()
  for (const userId of playerIds) {
    try {
      const view = getDoudizhuView(roomId, userId, online)
      pushTo([userId], { type: event, data: { roomId, room: view } })
    } catch {
      // 房间可能刚好被删了，忽略
    }
  }
}

app.get('/api/games/doudizhu/rooms', async (req) => {
  const user = requireUser(req)
  const q = req.query as { open?: string }
  return {
    rooms: listDoudizhuRooms(user.id, onlineUserIds(), q.open === '1'),
  }
})

app.post('/api/games/doudizhu/rooms', async (req) => {
  const user = requireUser(req)
  enforceRateLimit(req, 'createRoom', `:${user.id}`)
  const body = z.object({ title: z.string().max(40).default('') }).parse(req.body ?? {})
  const room = createDoudizhuRoom({
    title: body.title || `${user.display_name} 的牌局`,
    creatorId: user.id,
  })
  pushDoudizhuRoom(room.id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'doudizhu-create-room',
    target: room.id,
    payload: { title: room.title },
  })
  return { room }
})

app.get('/api/games/doudizhu/rooms/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  return { room: getDoudizhuView(id, user.id, onlineUserIds()) }
})

app.post('/api/games/doudizhu/rooms/:id/join', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const room = joinDoudizhuRoom(id, user.id, onlineUserIds())
  pushDoudizhuRoom(id)
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'doudizhu-join',
    target: id,
    payload: { seat: room.mySeat, phase: room.phase },
  })
  return { room }
})

app.post('/api/games/doudizhu/rooms/:id/bid', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z.object({ call: z.boolean() }).parse(req.body)
  const room = bidLandlord(id, user.id, body.call, onlineUserIds())
  pushDoudizhuRoom(id)
  return { room }
})

app.post('/api/games/doudizhu/rooms/:id/play', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const body = z
    .object({ cardIds: z.array(z.number().int()).min(1).max(20) })
    .parse(req.body)

  const result = playCards(id, user.id, body.cardIds, onlineUserIds())
  pushDoudizhuRoom(id, 'game-play')

  if (result.finished) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'doudizhu-finished',
      target: id,
      payload: result.finished,
    })
  }

  return { room: result.room, played: result.played, typeLabel: result.typeLabel, finished: result.finished }
})

app.post('/api/games/doudizhu/rooms/:id/pass', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const room = passTurn(id, user.id, onlineUserIds())
  pushDoudizhuRoom(id, 'game-play')
  return { room }
})

app.post('/api/games/doudizhu/rooms/:id/leave', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const { view, abandoned } = leaveDoudizhuRoom(id, user.id, onlineUserIds())
  pushDoudizhuRoom(id)
  if (abandoned) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'doudizhu-abandon',
      target: id,
    })
  }
  return { room: view }
})

// ---------------------------------------------------------------- 狼人杀

/**
 * 把狼人杀房间**按每个人各自的视角**推给他的座位。
 *
 * 和斗地主同理，甚至更严格：狼人杀里"谁是什么身份"就是全部的隐藏信息。
 * 广播一份完整状态出去，前端再怎么藏都没用 —— 打开控制台就看见所有人的身份，
 * 这个游戏当场就没了。
 *
 * 所以推送名单**只包含房间里的人**，不包括观战者：
 * 观战者看的是"上帝视角的公开信息"（谁死了、谁被投了），
 * 让他去主动拉取即可，不值得为观战者多维护一条实时通道。
 */
function pushWerewolfRoom(
  roomId: string,
  event: 'game' | 'game-werewolf' | 'game-werewolf-chat' = 'game',
): void {
  const online = onlineUserIds()
  for (const userId of werewolfMembers(roomId)) {
    try {
      pushTo([userId], { type: event, data: { roomId, room: getWerewolfView(roomId, userId, online) } })
    } catch {
      // 房间可能刚好被删了，忽略这一个座位
    }
  }
}

app.get('/api/games/werewolf/rooms', async (req) => {
  const user = requireUser(req)
  const q = req.query as { open?: string }
  return { rooms: listWerewolfRooms(user.id, onlineUserIds(), q.open === '1') }
})

app.post('/api/games/werewolf/rooms', async (req) => {
  const user = requireUser(req)
  enforceRateLimit(req, 'createRoom', `:${user.id}`)
  const body = z
    .object({
      title: z.string().max(40).default(''),
      // 自定义人数：6~12，默认 9（老棋盘）。越界直接 400。
      playerCount: z.number().int().min(6).max(12).default(9),
    })
    .parse(req.body ?? {})
  const room = createWerewolfRoom({
    title: body.title || `${user.display_name} 的狼人杀`,
    creatorId: user.id,
    playerCount: body.playerCount,
  })
  pushWerewolfRoom(room.id)
  // 大厅信号：别人也能看到新房间冒出来，不用手动刷新（载荷里没有房间详情）
  broadcast({ type: 'game-werewolf-lobby', data: { roomId: room.id } })
  audit({
    actorId: user.id,
    actorIp: actorIp(req),
    category: 'system',
    action: 'werewolf-create-room',
    target: room.id,
  })
  return { room }
})

app.get('/api/games/werewolf/rooms/:id', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  return { room: getWerewolfView(id, user.id, onlineUserIds()) }
})

app.post('/api/games/werewolf/rooms/:id/join', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const room = joinWerewolfRoom(id, user.id, onlineUserIds())
  // 最后一个人坐下时房间会自动开局（见 joinWerewolfRoom），
  // 所以这一次推送里可能已经带着各自的身份了
  pushWerewolfRoom(id)
  // 让大厅里的其他人看到"人又多了/开局了"
  broadcast({ type: 'game-werewolf-lobby', data: { roomId: id } })
  return { room }
})

app.post('/api/games/werewolf/rooms/:id/leave', async (req) => {
  const user = requireUser(req)
  const { id } = req.params as { id: string }
  const { view, abandoned, dissolved } = leaveWerewolfRoom(id, user.id, onlineUserIds())
  // 房间被房主解散时，还留在房里的人不会收到 pushWerewolfRoom（房间行都没了），
  // 必须单独告诉他们"房间没了"，否则界面会停在一个不存在的房间上。
  for (const uid of dissolved ?? []) {
    try {
      pushTo([uid], {
        type: 'game-werewolf',
        data: { roomId: id, room: null, reason: 'creator-left' },
      })
    } catch {
      // 推送失败不影响退房本身
    }
  }
  pushWerewolfRoom(id)
  broadcast({ type: 'game-werewolf-lobby', data: { roomId: id } })
  if (dissolved) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'werewolf-dissolve-room',
      target: id,
    })
  }
  if (abandoned) {
    audit({
      actorId: user.id,
      actorIp: actorIp(req),
      category: 'system',
      action: 'werewolf-abandon',
      target: id,
    })
  }
  return { room: view }
})

/**
 * 各阶段行动的统一入口。
 *
 * 五个动作的请求体都不一样，但**响应与推送方式完全一致**，
 * 所以包一层：每个路由只负责解析参数与鉴权，剩下的交给它。
 */
function werewolfAction(
  handler: (roomId: string, userId: string, body: Record<string, unknown>, online: Set<string>) => unknown,
  event: 'game' | 'game-werewolf' | 'game-werewolf-chat' = 'game',
) {
  return async (req: FastifyRequest): Promise<{ room: unknown }> => {
    const user = requireUser(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const room = handler(id, user.id, body, onlineUserIds())
    pushWerewolfRoom(id, event)
    return { room }
  }
}

// 座位号上限：最大人数 12 → 座位 0~11。真正的边界由引擎按实际人数再判一次，
// 这里只挡"明显越界"的脏输入（负数、99 这种）。
const seatNum = z.number().int().min(0).max(11)

app.post(
  '/api/games/werewolf/rooms/:id/kill',
  werewolfAction((roomId, userId, body, online) =>
    werewolfKill(roomId, userId, seatNum.parse(body.target), online),
  ),
)

app.post(
  '/api/games/werewolf/rooms/:id/check',
  werewolfAction((roomId, userId, body, online) =>
    werewolfCheck(roomId, userId, seatNum.parse(body.target), online),
  ),
)

app.post(
  '/api/games/werewolf/rooms/:id/witch',
  werewolfAction((roomId, userId, body, online) =>
    werewolfWitch(
      roomId,
      userId,
      z
        .object({
          // 解药：救「今晚被狼刀的那个人」。救不了别人 —— 所以没被刀时传 true 也会被规则拒绝。
          heal: z.boolean().optional(),
          // 毒药：毒杀目标。null / 省略表示不毒。
          poisonTarget: seatNum.nullable().optional(),
        })
        .parse(body),
      online,
    ),
  ),
)

app.post(
  '/api/games/werewolf/rooms/:id/vote',
  werewolfAction((roomId, userId, body, online) =>
    werewolfVote(roomId, userId, seatNum.nullable().parse(body.target ?? null), online),
  ),
)

app.post(
  '/api/games/werewolf/rooms/:id/shoot',
  werewolfAction((roomId, userId, body, online) =>
    werewolfShoot(roomId, userId, seatNum.nullable().parse(body.target ?? null), online),
  ),
)

/**
 * 房内文字发言。
 *
 * 用单独的事件名 game-werewolf-chat 推送（见 pushWerewolfRoom 的 event 参数），
 * 前端可据此做新消息提示。payload 同样是**按视角裁剪**的：夜晚狼队的发言
 * 只会推给狼人，非狼/观战者收到的 room 里不含它。
 */
app.post(
  '/api/games/werewolf/rooms/:id/chat',
  werewolfAction(
    (roomId, userId, body, online) =>
      werewolfChat(roomId, userId, z.string().max(200).parse(body.text), online),
    'game-werewolf-chat',
  ),
)

// ---------------------------------------------------------------- 静态资源

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' })
  // SPA 回退：非 /api 的未命中路径一律交给前端路由
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: '接口不存在' })
    }
    return reply.sendFile('index.html')
  })
}

// ---------------------------------------------------------------- 启动

startJobRunner()

/**
 * 启动时清零在线连接计数。
 *
 * connection_count 的语义是"此刻有几条 SSE 连接"。进程刚起来时一条都没有，
 * 而上一次若是被强杀（kill -9、OOM）就没机会执行断开逻辑，计数会残留在库里 ——
 * 于是那些人会被**永远**显示成在线（onlineUserIds 把计数 > 0 当作在线依据）。
 * 时间窗兜底只能挡住 60 秒内的幽灵，重启时直接清一次才干净。
 */
resetPresenceCounts()

// 启动时先扫一遍废弃棋局。上一次进程是被强杀的话，房间里会留着已经离线的人，
// 而那些座位别人也坐不了 —— 让它们在启动时就消失，而不是等第一次定时清理。
try {
  cleanupStaleRooms(new Set(connectedUserIds()))
} catch (err) {
  app.log.error({ err }, '启动时清理废弃棋局失败')
}

// 财物模块的分类：空白的分类列表会让人不知道怎么用，首次运行时塞一批常见的。
// 只在一条都没有的时候才播种（实现里判断），所以不会把用户删掉的分类塞回来。
seedAssetCategories()

/**
 * 清理废弃的象棋房间。
 *
 * ⚠️ `cleanupStaleRooms` 写了很久但**从来没被调用过**（死代码），
 * 于是"关掉窗口就走的房间"会永远留在列表里，而且它占着的那个座位
 * 别人也坐不了 —— 线上真的堆了一排这样的房间。
 *
 * 每 2 分钟跑一次：够快，也不至于在 8GB 的 NAS 上白费力气。
 */
setInterval(
  () => {
    try {
      cleanupStaleRooms(new Set(connectedUserIds()))
    } catch (err) {
      app.log.error({ err }, '清理废弃棋局失败')
    }
  },
  2 * 60_000,
).unref?.()

/**
 * 狼人杀的阶段推进与超时兜底。
 *
 * 为什么必须有个定时器：狼人杀是**回合制且有行动时限**的游戏。某个人不行动
 * （关掉页面、临时走开、睡着了）不能让其他 8 个人干等着 —— 这局就废了。
 * 间隔取 5 秒：远快于人的反应速度，又不会把 8GB 的 NAS 吵醒。
 *
 * 只在**真的发生了变化**时才推送（advanceWerewolfRoom 返回布尔值就是为了这个），
 * 否则每 5 秒就会把同一份状态重推给房间里的每个人。
 */
setInterval(() => {
  try {
    for (const roomId of processWerewolfTimeouts()) {
      pushWerewolfRoom(roomId)
    }
  } catch (err) {
    app.log.error({ err }, '狼人杀超时推进失败')
  }
}, 5_000).unref?.()

// 长期没人进的房间定期清掉，别让游戏列表里堆着一堆空房
setInterval(
  () => {
    try {
      cleanupStaleWerewolfRooms()
    } catch (err) {
      app.log.error({ err }, '清理狼人杀房间失败')
    }
  },
  30 * 60_000,
).unref?.()

/**
 * 定期回收超时未完成的上传（删临时文件）。
 *
 * 启动时先跑一次：上次进程被强杀时可能留下了没清的 .part。
 */
void cleanupStaleUploads().catch((err) => {
  app.log.error({ err }, '启动时回收上传临时文件失败')
})
setInterval(
  () => {
    void cleanupStaleUploads().catch((err) => {
      app.log.error({ err }, '定期回收上传临时文件失败')
    })
  },
  30 * 60_000,
).unref?.()

try {
  await app.listen({ port: PORT, host: HOST })
  // eslint-disable-next-line no-console
  console.log(`\n  ${SITE_NAME} 后端已启动  http://${HOST}:${PORT}\n`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
