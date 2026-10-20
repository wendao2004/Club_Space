/**
 * 轻量速率限制（内存滑动窗口）。
 *
 * 为什么需要它：内网也不能假设"没人会暴力破解"。一台被感染的终端、
 * 一个访客 WiFi 上的手机，都能对着登录接口跑字典。而 scrypt 是故意慢的，
 * 所以没有限流时，攻击者不仅有机会猜中口令，还能顺带把 NAS 的 CPU 打满
 * （这本身就是一个 DoS）。
 *
 * 为什么不上 Redis：整个项目刻意不引入额外的常驻进程（本地项目只有 2-4GB 内存预算）。
 * 单进程 + 内存计数对"社团规模 + 单个实例"完全够用。
 *
 * 诚实的局限：计数存在进程内存里，所以
 *   - 重启后清零（可接受：重启本身就要几秒，攻击者拿不到多少额外机会）
 *   - 多实例部署时每个实例各自计数（本项目是单实例，不涉及）
 * 这两条都是刻意的取舍，不是遗漏。
 */

interface Bucket {
  /** 窗口内的时间戳（毫秒）。 */
  hits: number[]
}

const buckets = new Map<string, Bucket>()

/** 定期清理过期桶，防止内存无限增长。 */
let sweepTimer: NodeJS.Timeout | null = null

function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      // 保留最长的窗口（1 小时）之外的桶没意义
      bucket.hits = bucket.hits.filter((t) => now - t < 3_600_000)
      if (bucket.hits.length === 0) buckets.delete(key)
    }
  }, 60_000)
  sweepTimer.unref?.()
}

export interface RateLimitRule {
  /** 窗口长度（毫秒）。 */
  windowMs: number
  /** 窗口内允许的次数。 */
  max: number
}

export interface RateLimitResult {
  allowed: boolean
  /** 剩余可用次数。 */
  remaining: number
  /** 被拒绝时，还要等多少秒。 */
  retryAfterSeconds: number
}

/**
 * 记一次命中并判断是否超限。
 *
 * 注意：**超限时也记一次命中**。否则攻击者在被限流后只要一直打，
 * 窗口就会不断"滚动"，反而更快恢复 —— 那是反的：持续的滥用应该让等待更久。
 */
export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  ensureSweeper()
  const now = Date.now()
  const bucket = buckets.get(key) ?? { hits: [] }

  // 丢掉窗口之外的
  bucket.hits = bucket.hits.filter((t) => now - t < rule.windowMs)

  const allowed = bucket.hits.length < rule.max
  bucket.hits.push(now)
  buckets.set(key, bucket)

  const oldest = bucket.hits[0] ?? now
  const retryAfterMs = Math.max(0, rule.windowMs - (now - oldest))

  return {
    allowed,
    remaining: Math.max(0, rule.max - bucket.hits.length),
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  }
}

/** 成功之后清掉计数（例如登录成功就不该继续累积失败次数）。 */
export function clearRateLimit(key: string): void {
  buckets.delete(key)
}

/** 当前有多少个活跃的计数桶（健康检查/管理面板用）。 */
export function rateLimitStats(): { keys: number } {
  return { keys: buckets.size }
}

/** 仅供测试：清空所有计数。 */
export function resetRateLimits(): void {
  buckets.clear()
}

/**
 * 预设规则。
 *
 * 数值的取法：既要挡住字典攻击，又不能把正常用户挡在门外。
 * 内网场景下"同一个人连错 8 次口令"已经很可疑了，所以登录给 8 次/15 分钟。
 */
export const RATE_RULES = {
  /** 登录：按 IP 与按用户名各算一份（见 index.ts 的说明）。 */
  login: { windowMs: 15 * 60_000, max: 8 },
  /**
   * 注册：内网平台本来就不该被反复注册。
   *
   * 取值说明：注册本身要求邀请码，没有码的人试也是 403，
   * 所以这里的限流主要是挡住两类事 ——
   *   ① 拿着一张码反复试（配合 invite 规则）
   *   ② 有人在被授权的情况下批量建号
   * 给到 10 次/小时是留出正常使用的余量（管理员一次性给几个成员开号），
   * 同时仍然远低于"批量刷号"的量级。
   */
  register: { windowMs: 60 * 60_000, max: 10 },
  /** 邀请码尝试：防止枚举邀请码。 */
  invite: { windowMs: 60 * 60_000, max: 10 },
  /**
   * TOTP 校验：动态口令只有 6 位，必须限流否则可以暴力试。
   *
   * 取值权衡：6 位码的搜索空间是 100 万，而窗口放宽后一次提交覆盖 3 个码 ——
   * 单次命中概率约 3e-6。20 次/15 分钟意味着要试到命中需要几万年，
   * 挡暴力破解绰绰有余；同时给正常管理员留出余量
   * （绑定、重绑、开关、几次验证加起来可能用到十几次）。
   * 最初设成 10 次，结果连正常流程都会撞上限流。
   *
   * ⚠️ 这条规则**按账号**计（键里不含 IP，见 index.ts 的 enforceRateLimit）。
   * 两步登录的第二步用它，键是 `totp:login:user:<uid>`。
   */
  totp: { windowMs: 15 * 60_000, max: 20 },
  /**
   * 两步登录第二步的**按 IP** 限流。
   *
   * 为什么单独一条、而且比 totp 宽松：这条要同时满足两个相反的要求。
   *   - 必须能挡住"匿名者用伪造请求刷满桶"。原来第二步用的是全站单桶
   *     （键里不含 IP），任何人每 15 分钟发 20 个请求就能让**所有**绑了 2FA
   *     的人（包括必须用 TOTP 的管理员）第二步全部 429 —— 不需要任何凭据，
   *     持续发就能永久锁死登录。
   *   - 不能误伤"同一个出口 IP 后面的一群人"。社团办公室走同一个 NAT 是常态，
   *     早上集中登录时 20 次/15 分钟真的会被正常使用撞到。
   *
   * 所以这里给到 60 次/15 分钟：单 IP 的洪水仍会被拦（而且要伪造出能通过
   * 签名校验的 challenge 本身就需要会话密钥，这条限流主要是防失控重试），
   * 而真正的暴破防护交给按账号的 `totp` 规则 —— 那个维度才是
   * "密码泄漏后 TOTP 是最后一道防线"时该守的地方，且换 IP 也绕不过。
   */
  totpLoginIp: { windowMs: 15 * 60_000, max: 60 },
  /** 运维操作：即使是管理员也不该在短时间内刷几十条命令。 */
  ops: { windowMs: 5 * 60_000, max: 30 },
  /** 建房间：防止刷爆房间列表。 */
  createRoom: { windowMs: 10 * 60_000, max: 20 },
  /** 聊天发言：防刷屏（每条消息还有 FTS 索引与未读聚合的代价）。 */
  chatSend: { windowMs: 60_000, max: 60 },
  /**
   * 发起上传：每次都会建一个临时文件，未完成的会话占着磁盘。
   *
   * ⚠️ 这条限流**不再承担"防止把盘写满"的职责** —— 那件事已经由
   * files.ts 的 assertDiskSpace 直接管了（按真实剩余空间判断，
   * 比"限制请求次数"准得多）。
   *
   * 原来的值是 60 次/10 分钟，那是按"防写满"来定的；但它同时把正常使用
   * 也卡住了：一次活动传三百张照片就是三百次发起，直接被限流。
   * 现在放宽到 600 次/10 分钟（持续 1 次/秒），人怎么用都碰不到，
   * 而一个失控的循环仍然会被挡住。
   */
  upload: { windowMs: 10 * 60_000, max: 600 },
} as const satisfies Record<string, RateLimitRule>
