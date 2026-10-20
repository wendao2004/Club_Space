/**
 * 健康检查在"真的有问题"时必须返回 503。
 *
 * 这个测试由 run-all-tests.mjs 用一个必然触发的配置启动服务端：
 * `WL_HEALTH_MIN_FREE_BYTES` 设成 1 PiB —— 大于任何真实磁盘，
 * 于是无论测试机多空，磁盘余量检查都必然判定不足，断言是确定性的。
 * （同样的手法见 upload-limit-test：不依赖机器状态，才不会有"在我这跑步过"的测试。）
 *
 * 为什么值得单独一个文件：这是 health 唯一一条会让 HTTP 状态变成非 200 的路径，
 * 而它原来永远不会发生 —— 因为整个接口硬编码 `ok: true`。Docker 的 HEALTHCHECK
 * 和任何外部监控都依赖这个状态码，所以它必须真的能红。
 *
 * 用法：由 run-all-tests.mjs 启动服务端后运行。
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'

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

async function main() {
  console.log(`\n\x1b[1m健康检查的失败路径\x1b[0m  目标 ${BASE}\n`)

  const res = await fetch(`${BASE}/api/health`)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  assert(
    res.status === 503,
    '磁盘余量低于底线时返回 503（Docker HEALTHCHECK 与监控才看得见）',
    `状态 ${res.status}`,
  )
  assert(body?.ok === false, 'ok = false', `ok=${body?.ok}`)
  assert(body?.status === 'unhealthy', 'status = unhealthy', body?.status)
  assert(body?.disk?.ok === false, 'disk.ok = false', JSON.stringify(body?.disk))
  assert(
    typeof body?.disk?.detail === 'string' && body.disk.detail.includes('MB'),
    '说清了还差多少（不是只给一个 false）',
    body?.disk?.detail,
  )

  // 数据库本身是好的 —— 这一点必须仍然如实报告，否则运维会去查错方向。
  assert(
    body?.db?.ok === true,
    '数据库探针仍然如实报告"能写"（不因为磁盘红了就一起报假）',
    JSON.stringify(body?.db),
  )

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
