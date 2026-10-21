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
import { currentUser, roleAtLeast, type Role, type User } from '../auth.ts'

export class AuthError extends Error {}

export function requireUser(req: FastifyRequest): User {
  const user = currentUser(req)
  if (!user) throw new AuthError('请先登录')
  return user
}

export function requireRole(req: FastifyRequest, role: Role): User {
  const user = requireUser(req)
  if (!roleAtLeast(user.role, role)) throw new AuthError('权限不足')
  return user
}

export function actorIp(req: FastifyRequest): string | null {
  return req.ip ?? null
}
