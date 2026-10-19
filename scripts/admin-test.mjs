/**
 * 管理员 Docker 管控的安全逻辑测试。
 *
 * 这个模块是全项目风险最高的地方（能操作 Docker = 能拿到宿主机 root），
 * 所以它的安全逻辑必须能在本地完整验证 —— 而不是"部署到 NAS 上小心点试试"。
 *
 * 能做到这一点的原因是设计上把三件事分开了：
 *   门禁（谁可以操作）→ 参数白名单（能操作什么）→ 命令构造（怎么执行）
 * 前两层是纯逻辑，第三层通过可注入的 runner 观察，全都不需要真的 Docker。
 *
 * 用法：node scripts/admin-test.mjs
 */

import {
  AdminError,
  assertNoShell,
  checkGate,
  describeOperations,
  executeOperation,
  findOperation,
  loadAdminConfig,
} from '../server/src/admin/docker.ts'
import { generateSecret, totpAt } from '../server/src/admin/totp.ts'

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

/** 记录被调用过的命令，用来断言"哪些命令真的被执行了"。 */
function makeRecorder() {
  const calls = []
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false }
    },
  }
}

const SECRET = generateSecret()

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    composeFile: '/compose/docker-compose.yml',
    templatesDir: '/compose/templates',
    allowedServices: ['app', 'caddy', 'convert'],
    allowedIps: [],
    timeoutMs: 5000,
    ...overrides,
  }
}

async function main() {
  console.log('\n\x1b[1m管理员 Docker 管控 · 安全逻辑测试\x1b[0m\n')

  // ================================================================
  console.log('【配置加载：默认关闭】')

  const defaults = loadAdminConfig({})
  assert(!defaults.enabled, '默认不启用（不会留一个默认可用的后门）')
  assert(defaults.allowedServices.length > 0, '默认服务白名单非空', defaults.allowedServices.join(','))
  assert(
    !('totpSecret' in defaults),
    '配置里没有"服务器级 TOTP 秘密"——每个管理员各自绑定自己的（见下方门禁测试）',
  )

  const enabled = loadAdminConfig({
    WL_ADMIN_DOCKER_ENABLED: '1',
    // 故意传进来：这个变量是早期设计的残留，现在必须被完全忽略
    // （真正的秘密在 users.totp_secret，按人各存一份）
    WL_ADMIN_TOTP_SECRET: 'ABC',
    WL_ADMIN_ALLOWED_SERVICES: 'a, b ,c',
    WL_ADMIN_ALLOWED_IPS: '192.168.1.5, 10.0.0.2',
  })
  assert(enabled.enabled, '显式设置后启用')
  assert(
    JSON.stringify(enabled.allowedServices) === JSON.stringify(['a', 'b', 'c']),
    '服务白名单会去掉空白',
    enabled.allowedServices.join(','),
  )
  eq(enabled.allowedIps.length, 2, 'IP 白名单解析正确')

  // ================================================================
  console.log('\n【门禁：谁可以操作】')

  const op = findOperation('start')
  const readOp = findOperation('ps')
  const verify = (secret, code) => {
    // 用一个固定时间点校验，避免测试跨越 30 秒窗口边界时偶发失败
    const now = Math.floor(Date.now() / 1000)
    for (const offset of [-30, 0, 30]) {
      if (totpAt(secret, now + offset) === code) return true
    }
    return false
  }
  const validCode = totpAt(SECRET, Math.floor(Date.now() / 1000))

  const gate = (input = {}) =>
    checkGate(
      { verifyTotp: verify, config: makeConfig() },
      {
        isAdmin: true,
        totpSecret: SECRET,
        totpCode: validCode,
        clientIp: '192.168.1.10',
        operation: op,
        ...input,
      },
    )

  let r = checkGate({ verifyTotp: verify, config: makeConfig({ enabled: false }) }, {
    isAdmin: true, totpSecret: SECRET, totpCode: validCode, clientIp: null, operation: op,
  })
  assert(!r.allowed && r.status === 503, '未启用时一律拒绝（503）', r.allowed ? '' : r.reason)

  // 每个管理员用自己的秘密。这里验证"别人的码开不了我的门"——
  // 这正是"各自绑定、各自吊销"能成立的前提。
  const anotherSecret = generateSecret()
  const anotherCode = totpAt(anotherSecret, Math.floor(Date.now() / 1000))
  r = checkGate({ verifyTotp: verify, config: makeConfig() }, {
    isAdmin: true, totpSecret: SECRET, totpCode: anotherCode, clientIp: '192.168.1.10', operation: op,
  })
  assert(
    !r.allowed && r.status === 401,
    '另一个管理员的动态口令开不了我的门（秘密是按人隔离的）',
    r.allowed ? '' : r.reason,
  )

  r = gate({ isAdmin: false })
  assert(!r.allowed && r.status === 401, '非管理员被拒（401）', r.allowed ? '' : r.reason)

  // 顺序回归：即使功能没启用，非管理员也必须先拿到 401 而不是 503 ——
  // 否则响应就把服务端的配置状态泄漏给了无权访问的人。
  r = checkGate({ verifyTotp: verify, config: makeConfig({ enabled: false }) }, {
    isAdmin: false, totpSecret: null, totpCode: undefined, clientIp: null, operation: op,
  })
  assert(
    !r.allowed && r.status === 401,
    '先鉴权后看配置：非管理员在功能未启用时也得到 401（不泄漏配置状态）',
    r.allowed ? '' : `状态 ${r.status} ${r.reason}`,
  )

  r = checkGate({ verifyTotp: verify, config: makeConfig({ allowedIps: ['192.168.1.5'] }) }, {
    isAdmin: true, totpSecret: SECRET, totpCode: validCode, clientIp: '192.168.1.99', operation: op,
  })
  assert(!r.allowed && r.status === 403, '来源 IP 不在白名单时被拒（403）', r.allowed ? '' : r.reason)

  r = checkGate({ verifyTotp: verify, config: makeConfig({ allowedIps: ['192.168.1.5'] }) }, {
    isAdmin: true, totpSecret: SECRET, totpCode: validCode, clientIp: '192.168.1.5', operation: op,
  })
  assert(r.allowed, '来源 IP 在白名单内时通过')

  // ---- TOTP 相关 ----

  r = gate({ totpSecret: null })
  assert(
    !r.allowed && r.status === 403,
    '未绑定两步验证时不能做变更操作（403）',
    r.allowed ? '' : r.reason,
  )

  r = gate({ totpCode: undefined })
  assert(!r.allowed && r.status === 401, '变更操作没提交动态口令时被拒（401）', r.allowed ? '' : r.reason)

  r = gate({ totpCode: '000000' })
  assert(!r.allowed && r.status === 401, '动态口令错误时被拒（401）', r.allowed ? '' : r.reason)

  r = gate()
  assert(r.allowed, '管理员 + 正确动态口令 → 允许变更操作')

  // 只读操作不需要 TOTP
  r = checkGate({ verifyTotp: verify, config: makeConfig() }, {
    isAdmin: true, totpSecret: null, totpCode: undefined, clientIp: '192.168.1.10', operation: readOp,
  })
  assert(r.allowed, '只读操作（查看状态）不需要动态口令')

  // ================================================================
  console.log('\n【参数白名单：能操作什么】')

  const config = makeConfig()

  // 服务名必须在白名单里
  let threw = false
  try {
    await executeOperation({ runner: makeRecorder().runner, config }, 'start', { service: 'not-in-list' })
  } catch (err) {
    threw = err instanceof AdminError && err.status === 403
  }
  assert(threw, '服务名不在白名单里被拒（403）')

  // 路径穿越
  for (const evil of ['../../etc/passwd', 'a/b', '..', 'app;rm -rf /', '$(whoami)', 'app`id`']) {
    let rejected = false
    try {
      await executeOperation({ runner: makeRecorder().runner, config }, 'template-up', { template: evil })
    } catch (err) {
      rejected = err instanceof AdminError
    }
    assert(rejected, `模板名「${evil}」被拒绝`)
  }

  // 服务名里带 shell 元字符
  for (const evil of ['app;id', 'app&&id', 'app|id', 'app$()']) {
    let rejected = false
    try {
      await executeOperation({ runner: makeRecorder().runner, config }, 'restart', { service: evil })
    } catch (err) {
      rejected = err instanceof AdminError
    }
    assert(rejected, `服务名「${evil}」被拒绝`)
  }

  // 缺少必填参数
  threw = false
  try {
    await executeOperation({ runner: makeRecorder().runner, config }, 'stop', {})
  } catch (err) {
    threw = err instanceof AdminError && err.status === 400
  }
  assert(threw, '缺少服务名时报 400')

  // 未知操作
  threw = false
  try {
    await executeOperation({ runner: makeRecorder().runner, config }, 'rm-rf-everything', {})
  } catch (err) {
    threw = err instanceof AdminError && err.status === 404
  }
  assert(threw, '未知操作被拒（404）')

  // ================================================================
  console.log('\n【命令构造：不经过 shell】')

  const recorder = makeRecorder()

  const ps = await executeOperation({ runner: recorder.runner, config }, 'ps', {})
  eq(ps.argv[0], 'docker', '命令以 docker 开头（不是 sh -c）')
  assert(!ps.argv.includes('-c'), '命令里没有 -c')
  eq(recorder.calls.length, 1, '命令被真正执行了一次')

  const start = await executeOperation({ runner: recorder.runner, config }, 'start', { service: 'caddy' })
  eq(start.argv[0], 'docker', '启动服务也以 docker 开头')
  assert(start.argv.includes('-f'), '带 -f 指定 compose 文件')
  assert(start.argv.includes(config.composeFile), '使用的是固定配置里的 compose 文件（管理员不能指定别的）')
  assert(start.argv.includes('caddy'), '服务名作为独立参数传入（不是拼进字符串）')
  eq(start.argv[start.argv.length - 1], 'caddy', '服务名是最后一个参数')
  assert(!start.argv.some((a) => a.includes(' ')), '没有任何参数里含空格（不会意外被 shell 拆分）')

  // logs 的行数要夹紧
  const logs = await executeOperation({ runner: recorder.runner, config }, 'logs', {
    service: 'app',
    lines: '999999',
  })
  const tailIndex = logs.argv.indexOf('--tail')
  assert(tailIndex >= 0, 'logs 命令带 --tail')
  eq(logs.argv[tailIndex + 1], '2000', '行数被夹到上限 2000（防止一次拉爆内存）')

  const logsSmall = await executeOperation({ runner: recorder.runner, config }, 'logs', {
    service: 'app',
    lines: '50',
  })
  eq(logsSmall.argv[logsSmall.argv.indexOf('--tail') + 1], '50', '合理的行数保持原样')

  const logsBad = await executeOperation({ runner: recorder.runner, config }, 'logs', {
    service: 'app',
    lines: '-5',
  })
  eq(logsBad.argv[logsBad.argv.indexOf('--tail') + 1], '100', '非法行数退回默认 100')

  // 模板命令用的是模板目录 + 项目名隔离
  const tpl = await executeOperation({ runner: recorder.runner, config }, 'template-up', {
    template: 'jellyfin',
  })
  assert(
    tpl.argv.includes(`${config.templatesDir}/jellyfin.yml`),
    '模板路径由服务端拼接（管理员只提供名字）',
    tpl.argv.join(' '),
  )
  assert(tpl.argv.includes('--project-name'), '模板用独立的 project name（与主栈隔离）')
  eq(tpl.argv[tpl.argv.indexOf('--project-name') + 1], 'wl-extension', '项目名固定为 wl-extension')

  // ================================================================
  console.log('\n【纵深防御：运行时断言】')

  threw = false
  try {
    assertNoShell(['sh', '-c', 'rm -rf /'])
  } catch {
    threw = true
  }
  assert(threw, '拒绝以 shell 作为执行入口')

  for (const shell of ['bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh']) {
    let rejected = false
    try {
      assertNoShell([shell, '-c', 'x'])
    } catch {
      rejected = true
    }
    assert(rejected, `拒绝以 ${shell} 作为执行入口`)
  }

  for (const arg of ['a;b', 'a&&b', 'a|b', 'a`b`', 'a$(b)', 'a>b', 'a<b', 'a&b', 'a\nb']) {
    let rejected = false
    try {
      assertNoShell(['docker', 'ps', arg])
    } catch {
      rejected = true
    }
    assert(rejected, `参数含 shell 元字符时拒绝执行：${JSON.stringify(arg)}`)
  }

  // 花括号**不能**算危险字符：docker 的 --format 用的是 Go 模板语法，
  // 而我们对子进程用 shell:false，花括号根本没有展开的机会。
  // 这条是回归测试 —— 最初把 {} 也列进了危险字符，结果误杀了
  // 自己发出的 `docker ps --format "{{.Names}}"`。
  assertNoShell(['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}'])
  ok('docker 的 Go 模板格式串（含花括号）不被误判为危险参数')

  assertNoShell(['docker', 'ps', '--format', '{{.Names}}'])
  ok('正常的 argv 不被误伤')

  // ================================================================
  console.log('\n【操作清单】')

  const ops = describeOperations()
  assert(ops.length >= 8, '操作清单已定义', `${ops.length} 个`)
  assert(
    ops.every((o) => o.id && o.label && o.description),
    '每个操作都有 id、名称与说明',
  )
  assert(
    ops.some((o) => !o.mutating) && ops.some((o) => o.mutating),
    '既有只读操作也有变更操作',
    `只读 ${ops.filter((o) => !o.mutating).length} / 变更 ${ops.filter((o) => o.mutating).length}`,
  )
  assert(
    ops.every((o) => typeof o.params === 'object'),
    '每个操作都声明了参数（前端据此渲染表单，也不会出现"传了没声明的参数"）',
  )
  // 不存在"执行任意命令"这类操作
  assert(
    !ops.some((o) => /exec|run|shell|terminal|command/i.test(o.id)),
    '操作清单里没有任何"执行任意命令"的入口',
    ops.map((o) => o.id).join(', '),
  )

  // ================================================================
  console.log('\n【执行失败的处理】')

  const failing = async () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: No such service',
    timedOut: false,
  })
  const failedOp = await executeOperation({ runner: failing, config }, "start", { service: "app" })
  eq(failedOp.result.code, 1, '命令失败时把退出码原样返回（由上层记录审计并告知用户）')
  eq(failedOp.result.stderr, "Error: No such service", '错误信息保留，便于用户看到真实原因')

  const timingOut = async () => ({
    code: -1,
    stdout: '',
    stderr: '',
    timedOut: true,
  })
  const timedOut = await executeOperation({ runner: timingOut, config }, 'start', { service: 'app' })
  assert(timedOut.result.timedOut, '超时的情况被标记出来')

  // ================================================================
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
