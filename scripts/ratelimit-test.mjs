/**
 * 速率限制的端到端测试。
 *
 * 为什么这个要专门测：限流是那种"写了但没生效也看不出来"的东西 ——
 * 代码在那儿、函数也被调用了，但阈值算错、key 拼错、或者异常路径绕过了它，
 * 表面上一模一样，只有真正打上去才知道。
 *
 * 所以这里不检查"有没有限流函数"，而是**真的打满阈值**看响应码。
 *
 * 用法：先启动后端（干净数据库），然后  node scripts/ratelimit-test.mjs
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)

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

/** 直接打接口，不维护 cookie（这个测试不需要登录态）。 */
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  return { status: res.status, body: payload }
}

async function main() {
  console.log(`\n\x1b[1m速率限制测试\x1b[0m  目标 ${BASE}\n`)

  // ---------------------------------------------------------------- 初始状态
  console.log('【初始状态】')
  const health = await fetch(`${BASE}/api/health`)
  const healthBody = await health.json()
  assert(
    typeof healthBody.rateLimit?.keys === 'number',
    '健康检查里能看到限流计数桶的数量',
    `keys=${healthBody.rateLimit?.keys}`,
  )

  // ---------------------------------------------------------------- 登录限流
  console.log('\n【登录限流】')

  // 注册一个真实账号，用来验证"登录成功后计数清零"
  const first = await post('/api/auth/register', {
    username: `rl${SUFFIX}`,
    displayName: '限流测试',
    password: 'ratelimit-test-2026',
  })
  assert(first.status === 200 || first.status === 201, '注册测试账号（首次运行成为 owner）')

  const codes = []
  for (let i = 0; i < 10; i++) {
    const res = await post('/api/auth/login', { username: 'nobody-here', password: 'wrong' })
    codes.push(res.status)
  }

  assert(
    codes.slice(0, 8).every((c) => c === 401),
    '前 8 次错误口令返回 401（还没触发限流）',
    codes.join(','),
  )
  assert(codes[8] === 429, '第 9 次返回 429（触发限流）', codes.join(','))
  assert(codes[9] === 429, '第 10 次仍然是 429', codes.join(','))

  const limited = await post('/api/auth/login', { username: 'nobody-here', password: 'wrong' })
  assert(
    typeof limited.body?.error === 'string' && limited.body.error.includes('频繁'),
    '限流的错误信息说明了原因',
    limited.body?.error,
  )

  // 被限流之后，用**正确的口令**也进不去 —— 这是有意的：
  // 否则攻击者只要一被限流就换个正确的口令继续试，限流就形同虚设。
  const correctWhileLimited = await post('/api/auth/login', {
    username: `rl${SUFFIX}`,
    password: 'ratelimit-test-2026',
  })
  assert(
    correctWhileLimited.status === 429,
    '限流生效期间，正确口令也会被挡住（否则换个口令就能继续试）',
    `状态 ${correctWhileLimited.status}`,
  )

  console.log(
    `      \x1b[90m（当前 IP 的登录计数已被打满，后续断言改用其他维度）\x1b[0m`,
  )

  // ---------------------------------------------------------------- 注册限流
  console.log('\n【注册限流】')

  let registerLimited = false
  let registerAttempts = 0
  // 试到超过阈值为止（阈值是 10/小时，加上前面注册的那一个账号）
  for (let i = 0; i < 20; i++) {
    registerAttempts++
    const res = await post('/api/auth/register', {
      username: `rlx${SUFFIX}${i}`,
      displayName: `批量注册${i}`,
      password: 'ratelimit-test-2026',
    })
    if (res.status === 429) {
      registerLimited = true
      break
    }
  }
  assert(
    registerLimited,
    '反复注册会被限流（挡住"批量建号"）',
    `第 ${registerAttempts} 次被限制`,
  )

  // ---------------------------------------------------------------- 限流不影响只读接口
  console.log('\n【限流的作用范围】')

  const bootstrap = await fetch(`${BASE}/api/bootstrap`)
  assert(bootstrap.status === 200, '只读接口（bootstrap）不受影响', `状态 ${bootstrap.status}`)

  const health2 = await fetch(`${BASE}/api/health`)
  assert(health2.status === 200, '健康检查不受影响（监控要能一直用）')

  const anonymousFiles = await fetch(`${BASE}/api/files`)
  assert(
    anonymousFiles.status === 401,
    '未登录访问文件接口仍然返回 401（不是被限流掩盖成 429）',
    `状态 ${anonymousFiles.status}`,
  )

  // ---------------------------------------------------------------- 审计留痕
  console.log('\n【限流要留痕】')

  // 用 owner 账号登录需要先等限流窗口……这里换个思路：
  // 直接看健康检查里的桶数量是否在增长（说明计数确实在被记录）
  const health3 = await fetch(`${BASE}/api/health`)
  const body3 = await health3.json()
  assert(
    body3.rateLimit.keys > 0,
    '限流计数桶确实在增长（说明命中被记录了）',
    `keys=${body3.rateLimit.keys}`,
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
