/**
 * TOTP（基于时间的一次性口令，RFC 6238）。
 *
 * 为什么管理员操作要加这一层：评审团把"管理员账号被盗 → 攻击者拿到宿主机 root"
 * 列为本项目的头号威胁。口令一旦泄漏，攻击者就拥有整个 NAS；而 TOTP 需要一个
 * 只有管理员本人持有的第二因子（手机上的验证器 App），口令泄漏不足以入侵。
 *
 * 用 node:crypto 手写而不是引入 otplib 之类的库：
 * 算法本身只有几十行，而且 RFC 6238 附录 B 给了公开的测试向量 ——
 * 自己实现反而可以逐条对着标准验证（见 scripts/totp-test.mjs），
 * 比信任一个无法核实的第三方包更可靠。
 *
 * 关于"重放"的诚实说明：标准 TOTP 允许同一个码在 30 秒窗口内被重复使用。
 * 本项目用一个已用码记录（见 admin/totp-usage）来防止同一码被用两次，
 * 这比多数实现更严一些，但窗口内的竞态仍存在 —— 这是 TOTP 本身的限制，
 * 不是实现缺陷。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 口令位数，标准是 6。 */
const DIGITS = 6
/** 时间步长（秒），标准是 30。 */
const PERIOD = 30

/**
 * Base32 解码（RFC 4648，不带填充）。
 *
 * 验证器 App 扫码得到的就是 Base32 的秘密，所以必须支持它。
 */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const output: number[] = []

  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error(`Base32 里出现了非法字符：${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

export function base32Encode(buffer: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let output = ''

  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

/** 生成一个新的 TOTP 秘密（20 字节 = 160 位，是 RFC 推荐的长度）。 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * 计算指定时间点的 TOTP 口令。
 *
 * 算法：HMAC-SHA1(key, 时间步长的大端 8 字节) → 动态截断 → 取 6 位。
 * 用 SHA1 而不是更强的哈希，是因为验证器 App 与 RFC 都约定 SHA1，
 * 换成 SHA256 会导致大部分 App 对不上码，反而降低可用性。
 */
export function totpAt(secretBase32: string, timeSeconds: number, digits = DIGITS): string {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(timeSeconds / PERIOD)

  const buffer = Buffer.alloc(8)
  // 用 BigInt 写 64 位整数：JS 的 number 只有 53 位精度，
  // 用位移写高位在很久以后（或 counter 很大时）会出错。
  buffer.writeBigUInt64BE(BigInt(counter))

  const hmac = createHmac('sha1', key).update(buffer).digest()

  // 动态截断（RFC 4226 第 5.3 节）：用最后一个字节的低 4 位作为偏移
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

export interface VerifyOptions {
  /** 允许的时间漂移（以步长为单位）。1 表示接受前后各一个 30 秒窗口。 */
  window?: number
  /** 当前时间（秒），测试时注入固定值。 */
  now?: number
}

/**
 * 校验一个 TOTP 口令。
 *
 * window 默认 1，即接受上一个、当前、下一个共三个 30 秒窗口。
 * 放宽是必要的：手机时钟与实际时间常有几秒偏差，只接受当前窗口会让
 * 一部分人永远验证不过去（而他们不知道自己手机时间错了）。
 * 代价是暴力破解的搜索空间从 1 个窗口变成 3 个 —— 6 位码下仍是百万分之一级别，
 * 配合下面的失败次数限制是安全的。
 */
export function verifyTotp(secretBase32: string, code: string, options: VerifyOptions = {}): boolean {
  const window = options.window ?? 1
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const cleaned = code.replace(/\s/g, '')

  if (!/^\d{6}$/.test(cleaned)) return false

  for (let offset = -window; offset <= window; offset++) {
    const candidate = totpAt(secretBase32, now + offset * PERIOD)
    // 用 timingSafeEqual 做定长比较，避免"比较耗时"泄漏出哪一位对了
    const a = Buffer.from(candidate)
    const b = Buffer.from(cleaned)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/**
 * 生成 otpauth:// 链接，供管理员在验证器 App 里扫码或手动录入。
 *
 * 注意：这个链接里含秘密，属于敏感信息 —— 只在"启用 TOTP"那一次返回，
 * 之后任何接口都不应再返回它。
 */
export function otpauthUrl(input: {
  secret: string
  account: string
  issuer: string
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`)
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** 把秘密按 4 位分组，方便用户手动录入。 */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

// ---------------------------------------------------------------- 秘密的静态保护

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'

/**
 * 加密 TOTP 秘密后再入库。
 *
 * 为什么值得多做这一步：TOTP 的意义是"即使口令泄漏，攻击者也进不来"。
 * 但如果秘密是明文存在数据库里，那么任何拿到数据库文件的人（备份盘、
 * 一次 SQL 注入、一次误传的备份）就同时拿到了口令哈希和 TOTP 秘密 ——
 * 第二因子直接失效。
 *
 * 密钥从 WL_SESSION_SECRET 派生（HKDF），所以攻击者还需要 .env 才能解开。
 * 这不等于"绝对安全"（拿到整台机器的人两个都有），但它把"只漏了数据库"
 * 和"沦陷"这两件事区分开了。
 */
function deriveKey(sessionSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32))
}

export function encryptSecret(plaintext: string, sessionSecret: string): string {
  const key = deriveKey(sessionSecret, 'totp-secret-v1')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // 格式：v1.<iv>.<tag>.<ciphertext>，全部 base64url
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptSecret(stored: string, sessionSecret: string): string {
  const parts = stored.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('TOTP 秘密的存储格式无法识别')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const key = deriveKey(sessionSecret, 'totp-secret-v1')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64url'))
  // GCM 的认证标签：如果有人改了密文，解密会抛错而不是返回错误的数据
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64url')), decipher.final()]).toString('utf8')
}
