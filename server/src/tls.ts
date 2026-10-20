/**
 * 站点证书的到期探针。
 *
 * 存在的理由很具体：证书签的是 397 天，签发那一刻没人会记得 13 个月后要做什么，
 * 而到期那天的表现是**所有成员的浏览器同时红屏**（MOZILLA_PKIX_ERROR 或
 * NET::ERR_CERT_DATE_INVALID），PWA / Service Worker 一起失效，
 * 连"打开平台看一下怎么回事"都做不到 —— 因为平台本身打不开了。
 *
 * 所以把剩余天数放进 /api/health，让监控和运维页都能提前一个月看见。
 *
 * 为什么放在应用容器里读证书文件、而不是让 caddy 自己报：
 * caddy 的健康检查端点（:2019/config/）不提供证书元信息，而我们已经有
 * 一个稳定的 /api/health。代价是把**对外证书**挂进应用容器 ——
 * 只挂 .crt，**绝不挂 server.key**。
 */
import { readFileSync, statSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { CERT_WARN_DAYS, TLS_CERT_PATH } from './config.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export interface CertProbe {
  /** 证书存在且能解析。读不到时为 false（开发机、没挂载都是这种情况）。 */
  present: boolean
  path: string
  /** 到期时间（毫秒时间戳）。 */
  notAfter: number | null
  /** 剩余天数，向下取整（已过期是负数）。 */
  daysLeft: number | null
  expired: boolean
  /** 需要提醒（剩余天数 ≤ 阈值，但还没过期）。 */
  warn: boolean
  warnDays: number
  subject: string | null
  detail?: string
}

/**
 * 缓存：按文件的 mtime + size 认版本。
 *
 * 不按时间 TTL：换证书之后必须在**下一次探活**就反映出来，
 * 否则"我刚重签了证书，怎么还在报 30 天"会白白浪费一次排查。
 * 而 stat 一次几十微秒，比解析 X509 便宜得多。
 */
let cache: { key: string; result: CertProbe } | null = null

export function probeCert(nowMs = Date.now()): CertProbe {
  const path = TLS_CERT_PATH
  try {
    const stat = statSync(path)
    const key = `${stat.mtimeMs}:${stat.size}`
    if (cache && cache.key === key) {
      // 缓存的是解析结果，天数要按"现在"重算 —— 否则一个跑几周的进程里，
      // daysLeft 会永远停在第一次探活的那一天。
      return refreshDays(cache.result, nowMs)
    }

    const pem = readFileSync(path, 'utf8')
    const cert = new X509Certificate(pem)
    const notAfter = Date.parse(cert.validTo)
    const result = refreshDays(
      {
        present: true,
        path,
        notAfter: Number.isNaN(notAfter) ? null : notAfter,
        daysLeft: null,
        expired: false,
        warn: false,
        warnDays: CERT_WARN_DAYS,
        subject: cert.subject.replace(/\n/g, ', '),
      },
      nowMs,
    )
    cache = { key, result }
    return result
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // 没有证书文件不是故障：开发机本来就没有，生产上 caddy 那边会更早报出来。
    // 但要如实说清是"没挂载"还是"读坏了"，否则排查时会怀疑是代码问题。
    const detail =
      code === 'ENOENT'
        ? `${path} 不存在（开发机正常；生产上说明证书没挂进容器）`
        : code === 'EISDIR'
          ? `${path} 是个目录（docker 在宿主机缺少该文件时会自动建目录），请先跑 ca/gen-certs.sh`
          : `读取证书失败：${err instanceof Error ? err.message : String(err)}`
    cache = null
    return {
      present: false,
      path,
      notAfter: null,
      daysLeft: null,
      expired: false,
      warn: false,
      warnDays: CERT_WARN_DAYS,
      subject: null,
      detail,
    }
  }
}

function refreshDays(base: CertProbe, nowMs: number): CertProbe {
  if (base.notAfter === null) return base
  const daysLeft = Math.floor((base.notAfter - nowMs) / DAY_MS)
  return {
    ...base,
    daysLeft,
    expired: daysLeft < 0,
    warn: daysLeft >= 0 && daysLeft <= base.warnDays,
    detail: base.present
      ? daysLeft < 0
        ? `证书已于 ${new Date(base.notAfter).toISOString().slice(0, 10)} 过期`
        : daysLeft <= base.warnDays
          ? `证书还有 ${daysLeft} 天到期，该安排续签了`
          : undefined
      : base.detail,
  }
}
