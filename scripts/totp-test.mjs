/**
 * TOTP 测试。
 *
 * 用的是 **RFC 6238 附录 B 的公开测试向量** —— 这是标准里给出的权威期望值，
 * 所以能精确验证实现是否符合规范，而不是"跑出来一个数就当家"。
 * 这也是我选择手写而不引入第三方库的原因：能对着标准逐条验。
 *
 * 用法：node scripts/totp-test.mjs
 */

import {
  base32Decode,
  base32Encode,
  formatSecretForDisplay,
  generateSecret,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from '../server/src/admin/totp.ts'

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
}

function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

function eq(actual, expected, name) {
  assert(actual === expected, name, `期望 ${expected}，实际 ${actual}`)
}

// ---------------------------------------------------------------- Base32

console.log('\n\x1b[1mTOTP 测试\x1b[0m\n')
console.log('【Base32 编解码（RFC 4648）】')

// RFC 4648 的示例
eq(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI', 'base32 编码 "foobar" → MZXW6YTBOI')
eq(base32Decode('MZXW6YTBOI').toString('utf8'), 'foobar', 'base32 解码 MZXW6YTBOI → "foobar"')

// RFC 6238 用的秘密（ASCII "12345678901234567890"）
const RFC_SECRET_ASCII = '12345678901234567890'
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))
eq(RFC_SECRET_B32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'RFC 测试秘密的 Base32 表示与标准一致', RFC_SECRET_B32)
eq(
  base32Decode(RFC_SECRET_B32).toString('ascii'),
  RFC_SECRET_ASCII,
  'Base32 往返后与原文一致',
)

// 带空格的输入、小写输入都要能解析（用户手抄秘密时经常带空格或小写）
eq(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii'), RFC_SECRET_ASCII, '容忍小写与空格')
let rejected = false
try {
  base32Decode('!!!invalid!!!')
} catch {
  rejected = true
}
assert(rejected, '含非法字符的 Base32 被拒绝')

// ---------------------------------------------------------------- RFC 6238 向量

console.log('\n【RFC 6238 附录 B 的标准测试向量】')

// RFC 6238 的向量是 8 位码，所以这里用 digits=8
const RFC_VECTORS = [
  { time: 59, expected: '94287082' },
  { time: 1111111109, expected: '07081804' },
  { time: 1111111111, expected: '14050471' },
  { time: 1234567890, expected: '89005924' },
  { time: 2000000000, expected: '69279037' },
  { time: 20000000000, expected: '65353130' },
]

for (const vector of RFC_VECTORS) {
  const actual = totpAt(RFC_SECRET_B32, vector.time, 8)
  eq(actual, vector.expected, `T=${vector.time} → ${vector.expected}`)
}

// 6 位码（本项目实际使用的位数）应当等于 8 位码的后 6 位
// 这不是 RFC 的要求，但它是实现正确性的一个自洽性检查
const eight = totpAt(RFC_SECRET_B32, 59, 8)
const six = totpAt(RFC_SECRET_B32, 59, 6)
eq(six, eight.slice(-6), '6 位码是 8 位码的后 6 位（自洽性检查）', `${six} vs ${eight}`)

// ---------------------------------------------------------------- 校验逻辑

console.log('\n【校验逻辑】')

const secret = generateSecret()
const now = 1700000000
const code = totpAt(secret, now)

assert(verifyTotp(secret, code, { now }), '当前窗口的码可以通过')
assert(
  verifyTotp(secret, totpAt(secret, now - 30), { now }),
  '上一个窗口的码可以通过（容忍手机时钟慢几秒）',
)
assert(
  verifyTotp(secret, totpAt(secret, now + 30), { now }),
  '下一个窗口的码可以通过（容忍手机时钟快几秒）',
)
assert(
  !verifyTotp(secret, totpAt(secret, now - 90), { now }),
  '三个窗口之前的码不通过（不放宽到无意义）',
)
assert(
  !verifyTotp(secret, totpAt(secret, now + 90), { now }),
  '三个窗口之后的码不通过',
)

// 窗口可配置为 0（最严格）
assert(
  verifyTotp(secret, code, { now, window: 0 }),
  'window=0 时当前码仍然通过',
)
assert(
  !verifyTotp(secret, totpAt(secret, now - 30), { now, window: 0 }),
  'window=0 时不接受上一个窗口（严格模式生效）',
)

// 格式检查
assert(!verifyTotp(secret, '12345', { now }), '5 位码被拒（长度不对）')
assert(!verifyTotp(secret, '1234567', { now }), '7 位码被拒')
assert(!verifyTotp(secret, 'abcdef', { now }), '非数字被拒')
assert(!verifyTotp(secret, '', { now }), '空字符串被拒')
assert(verifyTotp(secret, ` ${code} `, { now }), '容忍用户输入里的空格')

// 用错误的秘密
const otherSecret = generateSecret()
assert(!verifyTotp(otherSecret, code, { now }), '用另一个秘密生成的同位数码不通过')

// ---------------------------------------------------------------- 秘密生成

console.log('\n【秘密生成】')

const secrets = new Set()
for (let i = 0; i < 200; i++) secrets.add(generateSecret())
eq(secrets.size, 200, '连续生成 200 个秘密无重复')
assert(
  [...secrets].every((s) => /^[A-Z2-7]+$/.test(s)),
  '生成的秘密都是合法的 Base32 字符集',
)
eq(base32Decode([...secrets][0]).length, 20, '秘密长度是 20 字节（RFC 推荐 160 位）')

// ---------------------------------------------------------------- otpauth 链接

console.log('\n【otpauth 链接与展示格式】')

const url = otpauthUrl({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', account: 'admin', issuer: '社团空间' })
assert(url.startsWith('otpauth://totp/'), '链接以 otpauth://totp/ 开头', url)
assert(url.includes('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), '链接里含秘密')
assert(url.includes('algorithm=SHA1'), '算法是 SHA1（验证器 App 通用）')
assert(url.includes('digits=6'), '位数是 6')
assert(url.includes('period=30'), '步长是 30 秒')
assert(url.includes('issuer='), '带发行方，验证器里能看出是哪个站')

eq(
  formatSecretForDisplay('GEZDGNBVGY3TQOJQ'),
  'GEZD GNBV GY3T QOJQ',
  '展示用的秘密按 4 位分组（方便手抄）',
)

// ---------------------------------------------------------------- 结果

console.log(
  `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
)
process.exit(failed === 0 ? 0 : 1)
