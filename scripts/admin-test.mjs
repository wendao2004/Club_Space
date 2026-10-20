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

import { readFileSync } from 'node:fs'
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

/**
 * 取 compose 文件里 `services:` 下第一层的键。
 *
 * 故意手写而不是引入 YAML 库：这里只需要"服务名列表"，而且开发机没有 Docker
 * 也没有 YAML 依赖。缩进规则是 compose 文件自己保证的（两个空格一层）。
 */
function serviceNames(yaml) {
  const names = []
  let inside = false
  for (const line of yaml.split(/\r?\n/)) {
    if (/^services:\s*$/.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    if (line.trim() !== '' && /^\S/.test(line)) break // 回到顶格的顶层键，services 段结束
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

/** 取某个 service 的整段文本（到下一个两空格键或顶层键为止）。 */
function sectionOf(yaml, name) {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}:\\s*$`).test(line))
  if (start < 0) return ''
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break
    if (line.trim() !== '' && /^\S/.test(line)) break
    out.push(line)
  }
  return out.join('\n')
}

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
  // 回归：默认白名单里曾经写着 'convert'，而主 compose 文件里根本没有这个服务 ——
  // 于是运维页显示"启动转换服务"，点下去必然 no such service。
  // 现在默认是空的：宁可界面上没有这个按钮，也不要给一个必然失败的按钮。
  assert(
    !defaults.allowedServices.includes('convert'),
    '默认白名单里没有 convert（它不在主 compose 文件里）',
    defaults.allowedServices.join(',') || '（空）',
  )
  eq(defaults.allowedServices.length, 0, '默认不提供任何可从网页启停的服务')
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
  assert(
    failedOp.result.stderr.startsWith('Error: No such service'),
    '原始错误信息保留在最前面（不藏掉 docker 的原话，便于排查）',
    failedOp.result.stderr.slice(0, 60),
  )

  const timingOut = async () => ({
    code: -1,
    stdout: '',
    stderr: '',
    timedOut: true,
  })
  const timedOut = await executeOperation({ runner: timingOut, config }, 'start', { service: 'app' })
  assert(timedOut.result.timedOut, '超时的情况被标记出来')
  assert(timedOut.result.stderr === '', '超时不硬塞说明（那时没有任何真实错误可引用）')

  // ================================================================
  console.log('\n【失败信息要能指导下一步】')

  // 「服务不存在」是最常见的失败：白名单是管理员手填的，填错了只回一句
  // `no such service` 等于把排查工作全丢给用户。
  const noSuchConvert = await executeOperation(
    {
      runner: async () => ({ code: 1, stdout: '', stderr: 'no such service: convert', timedOut: false }),
      config,
    },
    'start',
    { service: 'convert' },
  )
  assert(
    noSuchConvert.result.stderr.includes('heavy-tools.compose.yml') &&
      noSuchConvert.result.stderr.includes('--profile convert up -d convert'),
    'convert 不存在时，错误里直接给出该跑的命令（而不是只说 No such service）',
    noSuchConvert.result.stderr.split('\n')[2] ?? '',
  )

  const noSuchOther = await executeOperation(
    {
      runner: async () => ({ code: 1, stdout: '', stderr: 'no such service: nginx', timedOut: false }),
      // nginx 必须在白名单里，否则命令根本构造不出来（会先被 403 挡住），
      // 也就走不到"服务不存在"这条失败路径上。
      config: makeConfig({ allowedServices: [...config.allowedServices, 'nginx'] }),
    },
    'stop',
    { service: 'nginx' },
  )
  assert(
    noSuchOther.result.stderr.includes('查看服务清单'),
    '其它服务不存在时，提示先查服务清单再填白名单',
  )

  const permissionDenied = await executeOperation(
    {
      runner: async () => ({
        code: 1,
        stdout: '',
        stderr: 'permission denied while trying to connect to the Docker daemon socket',
        timedOut: false,
      }),
      config,
    },
    'ps',
    {},
  )
  assert(
    permissionDenied.result.stderr.includes('WL_DOCKER_GID'),
    'docker.sock 权限不足时，提示去改 WL_DOCKER_GID（而不是让用户以为是平台 bug）',
  )

  const runnerDown = await executeOperation(
    {
      runner: async () => ({ code: -1, stdout: '', stderr: '无法连接执行器：fetch failed', timedOut: false }),
      config,
    },
    'ps',
    {},
  )
  assert(
    runnerDown.result.stderr.includes('--profile admin up -d'),
    '执行器连不上时，提示怎么把 ops-runner 起起来',
  )

  const okResult = await executeOperation({ runner: makeRecorder().runner, config }, 'ps', {})
  assert(
    okResult.result.stderr === '' && okResult.result.stdout === 'ok',
    '成功的命令不追加任何说明（不污染正常输出）',
    JSON.stringify({ stdout: okResult.result.stdout, stderr: okResult.result.stderr }),
  )

  // 服务名不在白名单、且这个名字恰好是 convert 时，403 里也要有可执行的下一步
  let convertMsg = ''
  try {
    await executeOperation({ runner: makeRecorder().runner, config: makeConfig({ allowedServices: [] }) }, 'start', {
      service: 'convert',
    })
  } catch (err) {
    convertMsg = err instanceof Error ? err.message : ''
  }
  assert(
    convertMsg.includes('heavy-tools.compose.yml') && convertMsg.includes('--profile convert up -d convert'),
    'convert 被白名单拒掉时，说明它在另一份编排里并给出命令',
    convertMsg.slice(0, 90),
  )

  // ================================================================
  console.log('\n【静态一致性：白名单 / compose 文件 / env 传递】')

  // 没有 Docker 的环境也能查的东西：白名单里的名字必须在这份 compose 文件里真实存在，
  // 否则就是"界面上看着有、点下去必然失败"。这里用最朴素的缩进解析，
  // 不引入 YAML 依赖 —— 我们要的只是 services: 下第一层的键。
  const mainCompose = readFileSync(new URL('../deploy/docker-compose.yml', import.meta.url), 'utf8')
  const heavyCompose = readFileSync(new URL('../deploy/heavy-tools.compose.yml', import.meta.url), 'utf8')
  const mainServices = serviceNames(mainCompose)
  const heavyServices = serviceNames(heavyCompose)

  assert(
    mainServices.includes('caddy') && mainServices.includes('app') && mainServices.includes('ops-runner'),
    '主 compose 的服务名解析正确（caddy / app / ops-runner）',
    mainServices.join(', '),
  )
  assert(
    !mainServices.includes('convert'),
    '主 compose 里确实没有 convert（这就是"启动转换服务"必然失败的原因）',
    mainServices.join(', '),
  )
  assert(heavyServices.includes('convert'), 'heavy-tools.compose.yml 里有 convert', heavyServices.join(', '))
  assert(
    /profiles:\s*\[\s*"convert"\s*\]/.test(heavyCompose),
    'convert 在 convert profile 下（默认不会随 up -d 起来）',
  )

  const appSection = sectionOf(mainCompose, 'app')
  const opsSection = sectionOf(mainCompose, 'ops-runner')
  assert(
    /WL_ADMIN_ALLOWED_SERVICES:\s*\$\{WL_ADMIN_ALLOWED_SERVICES:-\}/.test(appSection),
    'app 把 WL_ADMIN_ALLOWED_SERVICES 透传给后端，且默认值为空',
  )
  assert(
    /OPS_ALLOWED_SERVICES:\s*\$\{WL_ADMIN_ALLOWED_SERVICES:-\}/.test(opsSection),
    '执行器与后端共用同一个白名单变量（两边都要校验）',
  )
  assert(
    /\.\/docker-compose\.yml:\/compose\/docker-compose\.yml:ro/.test(opsSection) &&
      /\.\/\.env:\/compose\/\.env:ro/.test(opsSection),
    '执行器挂载了主 compose 文件与 .env（否则 compose 变量插值会在启动前就退出）',
  )
  assert(/group_add:/.test(opsSection) && /WL_DOCKER_GID/.test(opsSection), '执行器附带了 docker 组 GID')

  // 默认白名单里的每个名字都必须在这份 compose 文件里 —— 这是本轮修复的核心断言。
  // 现在默认为空，所以"空集 ⊆ 任何集合"必然成立；一旦有人把 convert 加回默认值，
  // 这里会立刻炸出来。
  const undeclared = defaults.allowedServices.filter((name) => !mainServices.includes(name))
  assert(
    undeclared.length === 0,
    '默认白名单里的服务名全部在主 compose 里存在',
    undeclared.length ? `多出来的：${undeclared.join(', ')}` : '（白名单为空）',
  )

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
