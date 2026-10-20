/**
 * 两步登录第二步的限流分桶测试。
 *
 * 为什么单独一个文件：这条限流曾经是**全站单桶**（键里不含 IP），
 * 后果是任何人不需要任何凭据，每 15 分钟发 20 个伪造请求，就能让
 * 所有绑了 2FA 的账号第二步全部 429 —— 包括做运维必须用 TOTP 的管理员，
 * 持续发就能无限锁死登录。这类 bug 用"读代码"很难确认，必须真打。
 *
 * 而"按 IP 分桶"这件事，普通的 fetch 测试做不到 —— 所有请求都来自
 * 127.0.0.1，看起来永远是同一个桶。所以这里用 node:http 的 localAddress
 * 指定**源地址**，从 127.0.0.2 / .5 / .10 … 发请求，真的模拟多个客户端。
 * （127/8 整段在 Linux 与 Windows 上都指向本机，不需要配网卡。）
 *
 * 覆盖：
 *   1. 按 IP 分桶：一个 IP 打满后，另一个 IP 不受影响
 *   2. 按账号分桶：同一个账号，换 IP 也绕不过（密码泄漏场景的最后防线）
 *   3. 登录成功清桶：成功后计数归零，不会把偶尔手滑的用户越推越远
 *
 * 用法：先启动后端（干净数据库），然后  node scripts/totp-ratelimit-test.mjs
 */

import http from 'node:http'
import { totpAt } from '../server/src/admin/totp.ts'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const TARGET = new URL(BASE)
const PORT = Number(TARGET.port || 80)
const SUFFIX = String(process.pid).slice(-5)
const USERNAME = `trl${SUFFIX}`
const PASSWORD = 'totp-rl-2026'

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

/** 带 cookie 的普通客户端（注册、绑定 2FA 用，都从默认地址发出）。 */
function makeClient() {
  let cookie = ''
  return {
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        options.body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const body = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body }
    },
  }
}

/**
 * 从指定**源地址**发一次 POST。
 *
 * 这是整个测试的关键：`localAddress` 让内核用 127.0.0.x 作为源 IP，
 * 服务端看到的 `req.ip` 就跟着变，于是"按 IP 分桶"才能被真正验证。
 */
function postFrom(localAddress, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      {
        host: TARGET.hostname,
        port: PORT,
        path,
        method: 'POST',
        localAddress,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let body = null
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
          resolve({ status: res.statusCode, body })
        })
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

/** 打同一个请求 N 次，返回状态码序列。 */
async function hammer(localAddress, path, payload, times) {
  const codes = []
  for (let i = 0; i < times; i++) {
    const res = await postFrom(localAddress, path, payload)
    codes.push(res.status)
  }
  return codes
}

async function main() {
  console.log(`\n\x1b[1m两步登录限流分桶测试\x1b[0m  目标 ${BASE}\n`)

  const admin = makeClient()

  // ---------------------------------------------------------------- 准备账号
  console.log('【准备一个绑了 2FA 的账号】')
  const reg = await admin.api('/api/auth/register', {
    method: 'POST',
    json: { username: USERNAME, displayName: '限流分桶', password: PASSWORD },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册（首次运行成为创建者）')

  const setup = await admin.api('/api/admin/totp/setup', { method: 'POST', json: {} })
  if (setup.status !== 200 || !setup.body?.secret) {
    bad('获取 2FA 秘密', `状态 ${setup.status}：${JSON.stringify(setup.body)}`)
    process.exit(1)
  }
  const secret = setup.body.secret

  // 用**上一个**窗口的码启用，把当前窗口的码留给后面的登录测试 ——
  // verifyTotp 有"同一时间步不许重放"的保护，两个动作必须用不同的码。
  const nowSec = Math.floor(Date.now() / 1000)
  const enable = await admin.api('/api/admin/totp/enable', {
    method: 'POST',
    json: { code: totpAt(secret, nowSec - 30) },
  })
  if (enable.status !== 200) {
    bad('启用两步验证', `状态 ${enable.status}：${JSON.stringify(enable.body)}`)
    process.exit(1)
  }
  ok('两步验证已启用')

  /** 用口令换一个 challenge（这一步本身受 login 限流，别多调）。 */
  async function freshChallenge(fromIp = null) {
    const payload = { username: USERNAME, password: PASSWORD }
    const res = fromIp
      ? await postFrom(fromIp, '/api/auth/login', payload)
      : await admin.api('/api/auth/login', { method: 'POST', json: payload })
    if (res.status !== 200 || !res.body?.challenge) {
      throw new Error(`拿不到 challenge：状态 ${res.status} ${JSON.stringify(res.body)}`)
    }
    return res.body.challenge
  }

  const challenge = await freshChallenge()
  ok('口令登录返回 challenge（没直接发会话）')

  // ---------------------------------------------------------------- 按 IP 分桶
  console.log('\n【按 IP 分桶：一个人刷不爆别人的登录】')

  // 用**伪造的 challenge**：它在签名校验处就被拒（401），走不到账号限流，
  // 所以这里刷的纯粹是 IP 维度的桶 —— 正是"匿名者能不能锁死全站"那条路径。
  const forged = { challenge: 'forged-token-not-signed', code: '000000' }
  const ipFlood = await hammer('127.0.0.10', '/api/auth/login/totp', forged, 61)

  assert(
    ipFlood.slice(0, 60).every((c) => c === 401),
    '单个 IP 的前 60 次伪造请求都是 401（未被提前限流）',
    `60 次全部 401`,
  )
  assert(ipFlood[60] === 429, '第 61 次返回 429（这个 IP 的桶被打满）', `状态 ${ipFlood[60]}`)

  // 这一发就是原来的 P0：全站单桶时它会是 429 —— 所有绑了 2FA 的人一起登不进去，
  // 而攻击者自己不需要任何凭据、也不用猜对任何东西。
  const otherIp = await postFrom('127.0.0.11', '/api/auth/login/totp', forged)
  assert(
    otherIp.status === 401,
    '换一个 IP 仍然正常走流程（401，不是 429）—— 不再全站共用一滴水',
    `状态 ${otherIp.status}`,
  )

  // 对照：被打满的那个 IP 自己确实被限住了，说明限流绑在来源上、不是随机失效。
  const floodSelf = await postFrom('127.0.0.10', '/api/auth/login/totp', forged)
  assert(
    floodSelf.status === 429,
    '（对照）同一个 IP 再次请求仍然 429 —— 限流真的绑在这个来源上',
    `状态 ${floodSelf.status}`,
  )

  // ---------------------------------------------------------------- 清桶 + 按账号分桶
  console.log('\n【登录成功要清桶，且计数按账号而非全站】')

  // 先用错误的口令把**账号维度**打到 19 次（都应当 401）。
  // 这时桶里 19 个，还差一个才满 —— 留这一个空隙，下一段才是有效对照。
  const warmup = await hammer('127.0.0.5', '/api/auth/login/totp', { challenge, code: '000000' }, 19)
  assert(
    warmup.every((c) => c === 401),
    '账号维度连试 19 次，全部是 401（还没触发 429）',
    `19 次全部 401`,
  )

  // 换成正确的码从另一个地址登录 —— 成功后两个维度的计数都该被清掉。
  const goodLogin = await postFrom('127.0.0.6', '/api/auth/login/totp', {
    challenge: await freshChallenge('127.0.0.6'),
    code: totpAt(secret, Math.floor(Date.now() / 1000)),
  })
  assert(goodLogin.status === 200, '用正确的动态口令登录成功', `状态 ${goodLogin.status}`)

  // 关键断言在这里：如果没清桶，桶里还剩 19 个，那么下面这一串里
  // **第 2 次**就会 429（第 1 次是第 20 个，仍然 allowed）。
  // 只有真的清零了，20 次才可能全是 401。
  const afterClear = await hammer(
    '127.0.0.30',
    '/api/auth/login/totp',
    { challenge, code: '000000' },
    21,
  )
  assert(
    afterClear.slice(0, 20).every((c) => c === 401),
    '成功登录之后计数归零：再试 20 次仍然都是 401',
    `20 次全部 401`,
  )
  assert(
    afterClear[20] === 429,
    '第 21 次才 429 —— 阈值确实是从零重新开始算的',
    `状态 ${afterClear[20]}`,
  )

  // 换一个干净的 IP 继续试：账号维度不含 IP，所以仍然 429。
  // 这正是"密码已经泄漏、TOTP 是最后一道防线"时该生效的维度。
  const acctOtherIp = await postFrom('127.0.0.31', '/api/auth/login/totp', {
    challenge,
    code: '000000',
  })
  assert(
    acctOtherIp.status === 429,
    '换 IP 仍然被账号维度挡住（密码泄漏后 TOTP 是最后一道防线）',
    `状态 ${acctOtherIp.status}`,
  )

  // 未通过签名校验的请求走的是 IP 桶，不会被账号桶连坐 ——
  // 也就是说"某个账号被锁"不会变成"所有人被锁"。
  const unrelated = await postFrom('127.0.0.32', '/api/auth/login/totp', forged)
  assert(
    unrelated.status === 401,
    '伪造 challenge 只受 IP 桶约束，不会被别的账号的桶连坐',
    `状态 ${unrelated.status}`,
  )

  // ---------------------------------------------------------------- 结果
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
