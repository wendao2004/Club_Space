/**
 * 路由层共用的鉴权小工具。
 *
 * 原先写在 index.ts 里。拆路由时它们必须"跟着路由走"：否则 routes/*.ts
 * 要么反向依赖 index.ts（循环依赖），要么每个模块各抄一份 —— 后者正是
 * 上一轮评审里最反对的"同一个东西两种实现"。
 *
 * AuthError 一起搬：index.ts 的错误处理用 `instanceof AuthError` 把它转成
 * 401，两处必须是同一个类对象，不能各定义一份。
 */
import type { FastifyRequest } from 'fastify'
import { audit } from '../audit.ts'
import { currentUser, roleAtLeast, type Role, type User } from '../auth.ts'
import { HttpError } from '../files.ts'
import { RATE_RULES, checkRateLimit } from '../ratelimit.ts'

export class AuthError extends Error {}

/**
 * 已登录，但权限不够。
 *
 * **必须和 AuthError 分开**：AuthError 会被全局错误处理翻译成 401，而前端
 * 把所有非 /api/auth/* 的 401 当成"会话过期"直接跳登录页。普通成员点开
 * 设置里的"存储"、或打开管理应用时，拿到 403 应该看到"仅管理员可查看"，
 * 而不是被踢回登录界面（刷新后又"正常"了，因为不再自动打开那个页签）。
 */
export class ForbiddenError extends Error {}

export function requireUser(req: FastifyRequest): User {
  const user = currentUser(req)
  if (!user) throw new AuthError('请先登录')
  return user
}

export function requireRole(req: FastifyRequest, role: Role): User {
  const user = requireUser(req)
  if (!roleAtLeast(user.role, role)) throw new ForbiddenError('权限不足')
  return user
}

export function actorIp(req: FastifyRequest): string | null {
  return req.ip ?? null
}

/**
 * 限流。超限时抛 429，并记一条审计。
 *
 * `globalKey = true` 表示**不把请求来源 IP 拼进键里**。
 * 用于"针对某个资源"的限流（例如某个用户名、某个账号的动态口令）——
 * 这类限流如果带上 IP，攻击者换个 IP 就绕过了。
 *
 * 放在这里而不是 index.ts：拆出去的路由模块（board/poll/music…）也要限流，
 * 留在入口文件里它们就只能反向 import index.ts —— 那是循环依赖。
 * 搬的时候一行逻辑都没改（路由快照与全量测试都逐条比对过）。
 */
export function enforceRateLimit(
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
