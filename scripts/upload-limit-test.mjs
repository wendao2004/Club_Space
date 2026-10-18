/**
 * 上传限制的测试。
 *
 * 这条测试是为用户的一句话写的：「上传文件为什么有限制，我不希望有限制」。
 *
 * 原来的实现是一道写死的单文件上限（默认 4GiB）。它有两个毛病：
 *   - **该拦的没拦住**：传 4 个大文件照样能把盘写满，4GiB 上限毫无作用；
 *   - **不该拦的拦了**：一个 5GB 的活动录像在这台 878GB 的 NAS 上放得下，却被拒。
 *
 * 现在改成两道：
 *   1. 单文件上限**默认关闭**（WL_MAX_UPLOAD_BYTES=0 = 不限）；
 *   2. 真正保护机器的是**磁盘余量守卫** —— 上传前算「可用空间 − 本次要写的字节
 *      是否还够留出 WL_MIN_FREE_BYTES（默认 2GB）」，不够就拒绝并说清数字。
 *
 * 这个测试专门验证第 2 条。做法是把 WL_MIN_FREE_BYTES 设成一个**大于任何真实磁盘**
 * 的值（1 PiB），于是无论跑在哪台机器上、磁盘多空，守卫都必然触发 ——
 * 这样断言是确定性的，不依赖测试机的剩余空间。
 *
 * 第 1 条（不再有单文件上限）由 e2e-test.mjs 里的「5GiB 的声明不再被 413 拒绝」覆盖。
 *
 * 用法：由 scripts/run-all-tests.mjs 以 WL_MIN_FREE_BYTES=1PiB 启动服务端后运行。
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

function makeClient() {
  let cookie = ''
  return {
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      let body = options.body
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const parsed = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body: parsed }
    },
  }
}

async function main() {
  console.log(`\n\x1b[1m上传限制（磁盘余量守卫）\x1b[0m  目标 ${BASE}\n`)

  const c = makeClient()
  const reg = await c.api('/api/auth/register', {
    method: 'POST',
    json: { username: `upl${SUFFIX}`, displayName: '上传测试', password: 'upload-limit-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册账号')

  const folder = await c.api('/api/files/folder', {
    method: 'POST',
    json: { parentId: null, name: '上传限制测试', space: 'shared' },
  })
  assert(folder.status === 200 || folder.status === 201, '建测试目录')
  const parentId = folder.body.node?.id ?? null

  // ---------------------------------------------------------------- 守卫触发
  console.log('\n【磁盘余量不足时必须被挡住】')
  // 服务端是用 WL_MIN_FREE_BYTES=1PiB 起的，所以任何上传都必然不足
  const small = await c.api('/api/uploads', {
    method: 'POST',
    json: { parentId, name: '小文件.txt', size: 1024, space: 'shared' },
  })
  assert(
    small.status === 507,
    '磁盘余量不足 → 507（Insufficient Storage）',
    `状态 ${small.status}${small.body?.error ? '：' + String(small.body.error).slice(0, 100) : ''}`,
  )
  assert(
    typeof small.body?.error === 'string',
    '返回了可读的错误说明（不是一串看不懂的东西）',
    typeof small.body?.error,
  )
  const msg = String(small.body?.error ?? '')
  assert(msg.includes('磁盘') || msg.includes('空间'), '错误信息说明了是磁盘空间问题', msg.slice(0, 90))
  // 关键：要把**数字**说出来，否则用户只知道"不行"，不知道差多少
  assert(
    /GB|MB|KB/.test(msg),
    '错误信息里带了具体数字（还剩多少、要留多少）—— 否则用户不知道差多远',
    msg.slice(0, 140),
  )

  // 1 字节也一样被拒：因为**保留量本身**就超过了磁盘，跟文件多大无关
  const tiny = await c.api('/api/uploads', {
    method: 'POST',
    json: { parentId, name: '一字节.bin', size: 1, space: 'shared' },
  })
  assert(
    tiny.status === 507,
    '即使只有 1 字节也被拒（保留量本身不够）—— 说明判据是余量，不是文件大小',
    `状态 ${tiny.status}`,
  )

  // ---------------------------------------------------------------- 不误伤
  console.log('\n【别把其它功能一起挡住】')
  const list = await c.api(`/api/files?parent=${parentId}&space=shared`)
  assert(list.status === 200, '文件列表照常可读（守卫只挡上传，不挡读）')
  const health = await fetch(`${BASE}/api/health`)
  assert(health.ok, '健康检查正常')
  const me = await c.api('/api/auth/me')
  assert(me.status === 200, '会话正常')

  // 建目录、改名字这些都不写大文件，不该被影响
  const sub = await c.api('/api/files/folder', {
    method: 'POST',
    json: { parentId, name: '子目录', space: 'shared' },
  })
  assert(sub.status === 200 || sub.status === 201, '仍然能建目录（守卫不该误伤元数据操作）')

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
