/**
 * 证书到期提醒的真实性测试。
 *
 * 为什么值得单独测：证书签 397 天，签发那一刻没人会记得 13 个月后要做什么。
 * 到期那天的表现是**所有成员的浏览器同时红屏**（NET::ERR_CERT_DATE_INVALID），
 * PWA 与 Service Worker 一起失效，连"打开平台看看怎么回事"都做不到 ——
 * 因为平台本身打不开了。所以 /api/health 必须提前一个月说出来。
 *
 * 这里验四件事：
 *   1. 剩余天数是真的从证书文件里算出来的（不是写死的常量）
 *   2. 快到期（≤ 30 天）时状态变 degraded，但 **HTTP 仍是 200**
 *      —— 重启修不好一张过期的证书，把它变成 503 只会让 Docker 反复重启容器，
 *      而真正的线索会被重启日志淹没
 *   3. 换掉证书文件之后**下一次探活**就反映出来（缓存按 mtime 失效，不是按 TTL）
 *   4. 正常证书时 status 回到 ok、warn 回到 false
 *
 * 用法：由 scripts/run-all-tests.mjs 用一张 5 天后到期的证书启动服务端后运行。
 *      WL_TEST_CERT_PATH 指向那张证书（本测试会改写它，结束时还原）。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const CERT_PATH = process.env.WL_TEST_CERT_PATH ?? ''
const GOOD_PATH = process.env.WL_TEST_CERT_GOOD ?? ''

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

async function health() {
  const res = await fetch(`${BASE}/api/health`)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`\n\x1b[1m证书到期提醒\x1b[0m  目标 ${BASE}\n`)

  if (!CERT_PATH || !GOOD_PATH) {
    // 没有 openssl 的机器上跑不了这个用例。**不能说"通过"**，但也不该算失败 ——
    // 那会把环境缺件伪装成代码问题。
    console.log(
      '  \x1b[33m⚠ 没有拿到测试证书（openssl 不可用？），跳过\x1b[0m\n\n' +
        '\x1b[1m结果\x1b[0m  通过 \x1b[0m0\x1b[0m  失败 \x1b[0m0\x1b[0m\n',
    )
    process.exit(0)
  }

  const original = readFileSync(CERT_PATH)

  try {
    // ---------------------------------------------------------------- 快到期
    console.log('【5 天后到期：只提醒，不报错】')
    const h1 = await health()
    const cert = h1.body?.cert ?? {}
    assert(cert.present === true, '证书被读到了（不是"未知"）', `path=${cert.path}`)
    assert(
      typeof cert.daysLeft === 'number' && cert.daysLeft >= 3 && cert.daysLeft <= 6,
      '剩余天数来自证书文件本身（5 天）',
      `daysLeft=${cert.daysLeft}`,
    )
    assert(cert.expired === false, '还没过期（expired = false）')
    assert(cert.warn === true, '进了提醒区（warn = true）')
    assert(
      typeof cert.detail === 'string' && cert.detail.includes('天'),
      'detail 里说清还有几天',
      cert.detail,
    )
    assert(
      h1.status === 200 && h1.body?.status === 'degraded',
      '状态变 degraded，但 HTTP 仍是 200（重启修不好过期证书）',
      `状态 ${h1.status} / ${h1.body?.status}`,
    )
    assert(h1.body?.ok === true, 'ok 仍为 true —— 它只回答"现在能不能读写"')
    assert(cert.warnDays === 30, '提醒阈值是 30 天', `warnDays=${cert.warnDays}`)

    // ---------------------------------------------------------------- 换证书
    console.log('\n【换掉证书文件：下一次探活就该看到】')
    // 缓存按 mtime + size 认版本。两张证书都是 2048 位自签，大小可能完全一样，
    // 所以这里必须让 mtime 真的变 —— 隔 50ms 再写，不靠"两次写恰好不同毫秒"。
    await sleep(50)
    writeFileSync(CERT_PATH, readFileSync(GOOD_PATH))

    const h2 = await health()
    const cert2 = h2.body?.cert ?? {}
    assert(
      typeof cert2.daysLeft === 'number' && cert2.daysLeft > 300,
      '换成 397 天的证书后剩余天数立刻变了（缓存按 mtime 失效，不是等 TTL）',
      `daysLeft=${cert2.daysLeft}`,
    )
    assert(cert2.warn === false, '不再提醒（warn = false）')
    assert(
      h2.body?.status === 'ok',
      '整体状态回到 ok',
      `status=${h2.body?.status}`,
    )
    assert(
      cert2.notAfter !== cert.notAfter,
      '到期时间戳确实换了（不是同一张证书的缓存）',
      `${cert.notAfter} → ${cert2.notAfter}`,
    )
  } finally {
    // 还原：这个文件是下一轮重试要用的"5 天后到期"的证书
    try {
      writeFileSync(CERT_PATH, original)
    } catch {
      // 还原失败最多让下一次重试红一次，不值得把整轮结果搞挂
    }
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
