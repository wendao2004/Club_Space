/**
 * 运维执行器。
 *
 * ============================================================================
 * 它为什么单独存在
 * ============================================================================
 *
 * 需求要"管理员对 Docker 最高权限操控"，而操作 Docker 就等于拿到宿主机 root
 * （起一个挂载宿主根目录的 privileged 容器即可）。同时，应用容器每天在处理
 * 用户上传的文件 —— 格式转换链路（LibreOffice / Chromium / ffmpeg）是经典的
 * 远程代码执行温床。
 *
 * 把这两件事放进同一个容器，等于"一次文件解析漏洞 = 整台 NAS 沦陷"。
 * 所以拆开：**只有这个执行器持有 /var/run/docker.sock**，它不接触任何用户内容、
 * 不提供业务接口、只在一个 internal 网络里监听。
 *
 * ============================================================================
 * 它不信任调用方
 * ============================================================================
 *
 * 即使应用侧已经做过参数白名单，这里**再独立校验一遍 argv**。
 * 原因是：如果应用被攻破，攻击者能直接构造请求打过来 —— 那时应用侧的校验
 * 已经不可信了。执行器侧的白名单是最后一道闸门，所以它的规则写死在本文件里，
 * 不接受任何来自请求的配置。
 *
 * 三条硬规则：
 *   1. 只允许执行 docker 命令（argv[0] 必须是 docker）
 *   2. 命令形状必须匹配下面 PATTERNS 里列举的某一类
 *   3. 服务名与模板名必须在环境变量给出的白名单内，且字符集受限
 *
 * 用 node:http 手写而不是引框架：这个服务越小越容易被审阅，而它只有一条路由。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const PORT = Number.parseInt(process.env.OPS_PORT ?? '9119', 10)
const TOKEN = process.env.OPS_TOKEN ?? ''
const COMPOSE_FILE = process.env.OPS_COMPOSE_FILE ?? '/compose/docker-compose.yml'
const TEMPLATES_DIR = process.env.OPS_TEMPLATES_DIR ?? '/compose/templates'
const ALLOWED_SERVICES = new Set(
  (process.env.OPS_ALLOWED_SERVICES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

if (!TOKEN) {
  // 没有令牌就直接拒绝启动：一个没有鉴权的"执行任意 docker 命令"的服务
  // 比没有这个服务危险得多。
  console.error('[ops-runner] 未设置 OPS_TOKEN，拒绝启动')
  process.exit(1)
}

/** 名称的安全字符集：挡掉路径穿越与 shell 元字符。 */
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i

/**
 * 允许的命令形状。
 *
 * 用「逐段比对」而不是正则去描述，因为正则在处理「参数来自白名单」这类
 * 约束时容易写得看似严格实则宽松。这里每个模式显式声明：
 *   - prefix：固定的前缀（必须逐字相等）
 *   - 可选的服务名/模板名参数位置
 */
const PATTERNS = [
  { prefix: ['docker', 'ps', '--format'], allowFreeLast: true, maxArgs: 4 },
  { prefix: ['docker', 'compose', '-f', COMPOSE_FILE, 'config', '--services'] },
  { prefix: ['docker', 'compose', '-f', COMPOSE_FILE, 'logs', '--tail'] },
  { prefix: ['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d'] },
  { prefix: ['docker', 'compose', '-f', COMPOSE_FILE, 'stop'] },
  { prefix: ['docker', 'compose', '-f', COMPOSE_FILE, 'restart'] },
  {
    prefix: ['docker', 'compose', '-f', `${TEMPLATES_DIR}/`],
    templateCommand: true,
  },
]

function startsWith(argv, prefix) {
  if (argv.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (argv[i] !== prefix[i]) return false
  }
  return true
}

/**
 * 校验 argv。返回 null 表示通过，否则返回拒绝原因。
 *
 * 注意这里**不修改** argv，只做判断 —— 执行器不改写命令，避免"改错了反而危险"。
 *
 * 导出是为了可测试：这层白名单是最后一道闸门，必须能在没有 Docker 的环境里
 * 完整验证（见 scripts/ops-runner-test.mjs）。
 */
export function validate(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '命令为空'
  if (argv[0] !== 'docker') return `只允许执行 docker 命令，收到：${argv[0]}`
  if (argv.some((a) => typeof a !== 'string')) return '参数必须是字符串'

  // 任何参数里出现 shell 元字符一律拒绝（应用侧已经查过，这里是独立复查）
  for (const arg of argv) {
    if (/[;&|`$()<>]|\n|\r/.test(arg)) return `参数含 shell 元字符：${arg}`
  }

  // docker ps --format <模板>
  if (startsWith(argv, ['docker', 'ps', '--format'])) {
    if (argv.length !== 4) return 'docker ps 的参数数量不对'
    return null
  }

  // docker compose config --services
  if (startsWith(argv, ['docker', 'compose', '-f', COMPOSE_FILE, 'config', '--services'])) {
    if (argv.length !== 6) return 'config 的参数数量不对'
    return null
  }

  // docker compose logs --tail <n> --no-color <service>
  if (startsWith(argv, ['docker', 'compose', '-f', COMPOSE_FILE, 'logs', '--tail'])) {
    if (argv.length !== 9) return 'logs 的参数数量不对'
    const lines = Number.parseInt(argv[6], 10)
    if (!Number.isFinite(lines) || lines < 1 || lines > 2000) return 'logs 的行数超出范围'
    if (argv[7] !== '--no-color') return 'logs 缺少 --no-color'
    return checkService(argv[8])
  }

  // docker compose up -d <service> / stop <service> / restart <service>
  //
  // 参数个数是硬约束：
  //   up       → docker compose -f <file> up -d <service>      共 7 段
  //   stop     → docker compose -f <file> stop <service>       共 6 段
  //   restart  → docker compose -f <file> restart <service>    共 6 段
  // 精确匹配个数就挡住了"多带一个 --force-recreate"之类的扩展。
  for (const verb of ['up', 'stop', 'restart']) {
    const prefix = ['docker', 'compose', '-f', COMPOSE_FILE, verb]
    if (startsWith(argv, prefix)) {
      const expectedLength = verb === 'up' ? 7 : 6
      if (argv.length !== expectedLength) {
        return `${verb} 的参数数量不对（期望 ${expectedLength} 段，收到 ${argv.length} 段）`
      }
      if (verb === 'up' && argv[5] !== '-d') return 'up 必须是 `up -d`'
      const service = argv[argv.length - 1]
      return checkService(service)
    }
  }

  // 模板相关：docker compose -f <templates>/<name>.yml --project-name wl-extension <verb>
  //
  // 这里不能用上面的 startsWith 逐元素比较：模板路径是"目录前缀 + 文件名"，
  // 不是逐字相等的固定值。所以显式判断 argv[3] 是否以模板目录开头。
  if (
    argv[0] === 'docker' &&
    argv[1] === 'compose' &&
    argv[2] === '-f' &&
    typeof argv[3] === 'string' &&
    argv[3].startsWith(`${TEMPLATES_DIR}/`)
  ) {
    const file = argv[3]
    // 只允许 一层目录 + 名字 + .yml，挡掉 ../../ 这类穿越
    const relative = file.slice(TEMPLATES_DIR.length + 1)
    if (!relative.endsWith('.yml')) return `模板文件必须是 .yml：${file}`
    const name = relative.slice(0, -4)
    if (!SAFE_NAME.test(name)) return `模板名不合法：${name}`
    if (argv[4] !== '--project-name' || argv[5] !== 'wl-extension') {
      return '模板命令必须使用固定的 project name'
    }
    const verb = argv[6]
    if (verb === 'pull' && argv.length === 7) return null
    if (verb === 'up' && argv[7] === '-d' && argv.length === 8) return null
    if (verb === 'down' && argv.length === 7) return null
    return `模板命令形状不被允许：${argv.slice(6).join(' ')}`
  }

  return `命令不在允许清单内：${argv.join(' ')}`
}

function checkService(service) {
  if (typeof service !== 'string' || !SAFE_NAME.test(service)) {
    return `服务名不合法：${service}`
  }
  if (!ALLOWED_SERVICES.has(service)) {
    return `服务「${service}」不在执行器的白名单内`
  }
  return null
}

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    const [command, ...args] = argv
    const child = spawn(command, args, { shell: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.min(120_000, Math.max(1000, timeoutMs || 30_000)))

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    child.on('error', (err) => {
      stderr += String(err.message)
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // 请求体很小（只有 argv），给个上限避免被喂爆内存
      if (raw.length > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, allowedServices: [...ALLOWED_SERVICES] })
  }

  if (req.method !== 'POST' || req.url !== '/exec') {
    return send(404, { error: '未知路径' })
  }

  // 常量时间比较令牌，避免通过响应时间逐字节猜出令牌
  const provided = req.headers['x-ops-token']
  if (typeof provided !== 'string' || !timingSafeEqualString(provided, TOKEN)) {
    return send(401, { error: '令牌不正确' })
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return send(400, { error: '请求体不是合法 JSON' })
  }

  const reason = validate(body?.argv)
  if (reason) {
    // 记录被拒绝的请求：这可能是应用被攻破后攻击者在试探
    console.error(`[ops-runner] 拒绝执行：${reason}`)
    return send(403, { error: reason })
  }

  console.log(`[ops-runner] 执行：${body.argv.join(' ')}`)
  const result = await run(body.argv, body.timeoutMs)
  send(200, result)
})

function timingSafeEqualString(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 只有在直接运行时才启动服务。
 *
 * 被 import（例如测试）时不应该监听端口 —— 那会让测试既占端口又留一个
 * 后台进程，跑完不退出。
 */
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isDirectRun) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ops-runner] 已启动，监听 :${PORT}`)
    console.log(`[ops-runner] 允许的服务：${[...ALLOWED_SERVICES].join(', ') || '（空）'}`)
    console.log(`[ops-runner] compose 文件：${COMPOSE_FILE}`)
  })
}

export { server, ALLOWED_SERVICES, COMPOSE_FILE, TEMPLATES_DIR }
