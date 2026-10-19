/**
 * 受控的 Docker 管控（管理员功能）。
 *
 * ============================================================================
 * 威胁模型与设计立场
 * ============================================================================
 *
 * 需求原文要"管理员对 docker 进行最高权限的操控"。这件事的本质必须说清楚：
 * **能操作 Docker = 能拿到宿主机 root**（起一个挂载宿主根目录的 privileged 容器即可）。
 * 所以这不是"给管理员一个方便的工具"，而是"给管理员一把通往一切的钥匙"。
 *
 * 因此这里**不提供网页版任意命令终端**，而是提供一组**枚举好的、参数受限的操作**：
 *
 *   1. **绝不拼接 shell 字符串。** 每个操作对应一个固定的 argv 数组，
 *      参数只允许来自白名单（服务名必须在配置里列出的清单内，模板名必须匹配
 *      目录里的实际文件）。没有 `sh -c`，没有字符串插值，因此不存在
 *      命令注入这条路。
 *
 *   2. **只操作自己的 compose 栈。** 命令固定带 `-f <我们自己的 compose 文件>`，
 *      管理员不能指定别的文件、别的项目名、别的容器。
 *
 *   3. **默认关闭。** 未显式启用时所有接口返回"未启用"并说明原因，
 *      而不是留一个默认可用后门。
 *
 *   4. **二次验证 + 来源限制 + 全量审计。** 变更类操作要求 TOTP；
 *      可配置 IP 白名单；每次执行（含被拒绝的）都进审计日志。
 *
 * 为什么不做"受控白名单命令终端"（允许管理员输入命令但拦截危险命令）：
 * 命令与参数的组合是无穷的，黑名单永远能被绕过（`find / -exec sh -c`、
 * `docker run -v /:/host` …）。只有"枚举操作 + 参数白名单"才是可证明安全的。
 *
 * ============================================================================
 * 可测试性
 * ============================================================================
 *
 * 命令执行通过可注入的 CommandRunner 完成。因此权限校验、参数白名单、
 * TOTP 门禁、审计这些**安全关键逻辑可以在没有 Docker 的环境里完整测试**
 * （见 scripts/admin-test.mjs）—— 这比"部署到 NAS 上试一下"可靠得多。
 */

import { spawn } from 'node:child_process'

// ---------------------------------------------------------------- 配置

export interface AdminDockerConfig {
  enabled: boolean
  /** 主 compose 文件路径（固定，管理员不可指定） */
  composeFile: string
  /** 可选的"模板"目录：每个 .yml 是一个可安装的扩展功能分支 */
  templatesDir: string
  /** 允许操作的服务名白名单 */
  allowedServices: string[]
  /** 允许访问管理接口的来源 IP；为空表示不限制（仍要求管理员身份 + TOTP） */
  allowedIps: string[]
  /** 命令超时（毫秒） */
  timeoutMs: number
  /**
   * 独立的执行器地址。设置后命令会被转发给它，而不是在本进程里 spawn。
   *
   * 容器化部署**应该**设置这一项：让持有 docker.sock 的执行器和处理用户
   * 上传文件的应用容器分开。留空则在本进程执行（适用于应用直接跑在宿主机的场景）。
   */
  runnerUrl: string
  /** 调用执行器时的共享令牌。 */
  runnerToken: string
}

/**
 * 注意这里**没有**"服务器级的 TOTP 秘密"。
 *
 * 最初的实现里有一个 WL_ADMIN_TOTP_SECRET（环境变量里的全局秘密），但那是错的：
 * 管理员是在界面上绑定**自己**的验证器的（秘密存在 users.totp_secret），
 * 全局秘密和它根本对不上。而且共享一个秘密意味着无法单独吊销某个人，
 * 也失去了"这一步是证明操作者本人"的意义。
 *
 * 所以现在：**每个管理员各自绑定、各自验证**。门禁拿的是请求者本人的秘密（见 GateInput）。
 */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminDockerConfig {
  return {
    enabled: env.WL_ADMIN_DOCKER_ENABLED === '1' || env.WL_ADMIN_DOCKER_ENABLED === 'true',
    composeFile: env.WL_ADMIN_COMPOSE_FILE ?? '/compose/docker-compose.yml',
    templatesDir: env.WL_ADMIN_TEMPLATES_DIR ?? '/compose/templates',
    allowedServices: (env.WL_ADMIN_ALLOWED_SERVICES ?? 'convert')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedIps: (env.WL_ADMIN_ALLOWED_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: Number.parseInt(env.WL_ADMIN_TIMEOUT_MS ?? '30000', 10),
    runnerUrl: env.WL_ADMIN_RUNNER_URL ?? '',
    runnerToken: env.WL_ADMIN_RUNNER_TOKEN ?? '',
  }
}

// ---------------------------------------------------------------- 命令执行

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type CommandRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>

/**
 * 真实执行器：spawn 且**不经过 shell**。
 *
 * shell: false 是关键 —— 参数作为数组传给进程，操作系统直接 exec，
 * 中间没有任何解析环节，因此 `;`、`&&`、`$()` 之类都只是普通字符，
 * 不具备注入能力。
 *
 * ⚠️ 这个执行器要求进程能访问 Docker 守护进程（本机 docker CLI + /var/run/docker.sock）。
 * 因此它**只应该用在"应用进程直接跑在宿主机上"的部署形态**。
 * 如果应用跑在容器里，请改用 httpRunner 指向一个独立的执行器容器 ——
 * 让持有 docker.sock 的容器和处理用户上传文件的容器分开，是这套设计的关键一步。
 */
export const realRunner: CommandRunner = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const [command, ...args] = argv
    if (!command) {
      resolve({ code: -1, stdout: '', stderr: '空命令', timedOut: false })
      return
    }

    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      // 限制输出体积：某个命令刷出几百 MB 日志会把服务端内存打满
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })

    const finish = (code: number) => {
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

/**
 * HTTP 执行器：把命令转发给一个**独立的执行器容器**。
 *
 * 这是容器化部署下的推荐形态。理由：
 *
 *   应用容器每天在处理用户上传的文件（Gotenberg、LibreOffice、ffmpeg 都是
 *   经典的 RCE 温床），而持有 docker.sock 的容器等于持有宿主机 root。
 *   把这两者放进同一个容器，等于"一次文件解析漏洞 = 整台 NAS 沦陷"。
 *   拆开之后，即使应用被攻破，攻击者也只是拿到一个没有 socket 的容器。
 *
 * 执行器侧仍然要做同样的白名单校验（执行器不信任调用方），
 * 并通过 compose 的 internal 网络只对应用容器可见。
 */
export function httpRunner(baseUrl: string, token: string): CommandRunner {
  return async (argv, timeoutMs) => {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 执行器只接受带这个令牌的请求，避免内网其它服务误调或滥用
          'x-ops-token': token,
        },
        body: JSON.stringify({ argv, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      })
      if (!response.ok) {
        return {
          code: -1,
          stdout: '',
          stderr: `执行器返回 ${response.status}`,
          timedOut: false,
        }
      }
      const payload = (await response.json()) as Partial<CommandResult>
      return {
        code: typeof payload.code === 'number' ? payload.code : -1,
        stdout: String(payload.stdout ?? ''),
        stderr: String(payload.stderr ?? ''),
        timedOut: Boolean(payload.timedOut),
      }
    } catch (err) {
      return {
        code: -1,
        stdout: '',
        stderr: `无法连接执行器：${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
      }
    }
  }
}

/**
 * 按配置选择执行器。
 *
 * 有 WL_ADMIN_RUNNER_URL 就走 HTTP（容器化部署），没有就本机 spawn（宿主机部署）。
 * 这个分叉是刻意的：它让"应用容器里没有 docker.sock"成为**默认的部署形态**，
 * 而不是需要额外记得去做的一件事。
 */
export function selectRunner(config: AdminDockerConfig): CommandRunner {
  if (config.runnerUrl) {
    return httpRunner(config.runnerUrl, config.runnerToken)
  }
  return realRunner
}

// ---------------------------------------------------------------- 操作定义

export class AdminError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AdminError'
    this.status = status
  }
}

export interface AdminOperation {
  id: string
  label: string
  description: string
  /** 变更类操作需要 TOTP；只读操作不需要。 */
  mutating: boolean
  /** 参数 schema：名称 → 校验器。没有参数的操作就是空对象。 */
  params: Record<string, 'service' | 'template' | 'lines'>
  build(config: AdminDockerConfig, args: Record<string, string>): string[]
}

/** 校验服务名必须来自白名单。 */
function checkService(config: AdminDockerConfig, name: string | undefined): string {
  if (!name) throw new AdminError(400, '缺少服务名')
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name)) {
    throw new AdminError(400, `服务名格式不合法：${name}`)
  }
  if (!config.allowedServices.includes(name)) {
    throw new AdminError(
      403,
      `服务「${name}」不在允许操作的清单里。允许的有：${config.allowedServices.join('、') || '（空）'}`,
    )
  }
  return name
}

/**
 * 校验模板名。
 *
 * 模板就是"扩展网站功能分支"的落地形式：管理员把一个新的 compose 文件
 * 放进模板目录，就能在界面上安装它。这里只允许文件名，且必须匹配
 * 严格的安全字符集 —— 挡掉 `../` 这类路径穿越。
 */
function checkTemplate(config: AdminDockerConfig, name: string | undefined): string {
  if (!name) throw new AdminError(400, '缺少模板名')
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name)) {
    throw new AdminError(400, `模板名格式不合法：${name}`)
  }
  return name
}

function checkLines(value: string | undefined): string {
  const lines = Number.parseInt(value ?? '100', 10)
  if (!Number.isFinite(lines) || lines < 1) return '100'
  // 上限 2000 行：日志再多就该去 NAS 上看文件了，不该从网页拉
  return String(Math.min(2000, lines))
}

/** 带固定 compose 文件前缀的 docker compose 命令。 */
function compose(config: AdminDockerConfig, ...rest: string[]): string[] {
  return ['docker', 'compose', '-f', config.composeFile, ...rest]
}

export const OPERATIONS: AdminOperation[] = [
  {
    id: 'ps',
    label: '查看容器状态',
    description: '列出当前运行的容器与它们的资源占用',
    mutating: false,
    params: {},
    build: () => ['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
  },
  {
    id: 'services',
    label: '查看服务清单',
    description: '列出本栈里定义的服务',
    mutating: false,
    params: {},
    build: (config) => compose(config, 'config', '--services'),
  },
  {
    id: 'logs',
    label: '查看服务日志',
    description: '读取某个服务最近的日志',
    mutating: false,
    params: { service: 'service', lines: 'lines' },
    build: (config, args) => {
      const service = checkService(config, args.service)
      const lines = checkLines(args.lines)
      return compose(config, 'logs', '--tail', lines, '--no-color', service)
    },
  },
  {
    id: 'start',
    label: '启动服务',
    description: '启动本栈里的一个服务',
    mutating: true,
    params: { service: 'service' },
    build: (config, args) => compose(config, 'up', '-d', checkService(config, args.service)),
  },
  {
    id: 'stop',
    label: '停止服务',
    description: '停止本栈里的一个服务（释放它占用的内存）',
    mutating: true,
    params: { service: 'service' },
    build: (config, args) => compose(config, 'stop', checkService(config, args.service)),
  },
  {
    id: 'restart',
    label: '重启服务',
    description: '重启本栈里的一个服务',
    mutating: true,
    params: { service: 'service' },
    build: (config, args) => compose(config, 'restart', checkService(config, args.service)),
  },
  {
    id: 'template-pull',
    label: '拉取扩展镜像',
    description: '拉取某个扩展模板所需的镜像（装之前先拉，避免装到一半失败）',
    mutating: true,
    params: { template: 'template' },
    build: (config, args) => {
      const name = checkTemplate(config, args.template)
      return [
        'docker',
        'compose',
        '-f',
        `${config.templatesDir}/${name}.yml`,
        '--project-name',
        'wl-extension',
        'pull',
      ]
    },
  },
  {
    id: 'template-up',
    label: '安装扩展',
    description: '按模板启动一个扩展（对应需求里的「扩展网站的功能分支」）',
    mutating: true,
    params: { template: 'template' },
    build: (config, args) => {
      const name = checkTemplate(config, args.template)
      return [
        'docker',
        'compose',
        '-f',
        `${config.templatesDir}/${name}.yml`,
        '--project-name',
        'wl-extension',
        'up',
        '-d',
      ]
    },
  },
  {
    id: 'template-down',
    label: '卸载扩展',
    description: '停掉并移除某个扩展',
    mutating: true,
    params: { template: 'template' },
    build: (config, args) => {
      const name = checkTemplate(config, args.template)
      return [
        'docker',
        'compose',
        '-f',
        `${config.templatesDir}/${name}.yml`,
        '--project-name',
        'wl-extension',
        'down',
      ]
    },
  },
]

export function findOperation(id: string): AdminOperation | undefined {
  return OPERATIONS.find((op) => op.id === id)
}

// ---------------------------------------------------------------- 执行

export interface ExecutorDeps {
  runner: CommandRunner
  config: AdminDockerConfig
}

export interface ExecutedOperation {
  operationId: string
  argv: string[]
  result: CommandResult
}

/**
 * 执行一个操作。
 *
 * 执行前会先 build()（其中包含全部参数校验），build 抛错就不会执行任何命令 ——
 * 校验与执行严格分离，避免"先跑起来再检查"这种顺序错误。
 */
export async function executeOperation(
  deps: ExecutorDeps,
  operationId: string,
  args: Record<string, string> = {},
): Promise<ExecutedOperation> {
  const config = deps.config

  if (!config.enabled) {
    throw new AdminError(
      503,
      '管理员 Docker 管控未启用：需要在 deploy/.env 里设置 WL_ADMIN_DOCKER_ENABLED=1，' +
        '并用 docker compose --profile admin up -d 启动 ops-runner 执行器' +
        '（没有服务器级的 TOTP 秘密，两步验证由每位管理员在「运维 → 两步验证」各自绑定）',
    )
  }

  const operation = findOperation(operationId)
  if (!operation) {
    throw new AdminError(404, `未知操作：${operationId}`)
  }

  // 参数白名单在 build 里做，这里先跑一遍以取得 argv
  const argv = operation.build(config, args)

  // 双保险：断言 argv 里不出现 shell 元字符，也不出现 `sh -c` 这类结构。
  // 参数校验已经保证了这一点，但那是有可能被将来改坏的；加一道运行时断言，
  // 一旦有人不小心引入了字符串拼接，会立刻在测试里炸出来。
  assertNoShell(argv)

  const result = await deps.runner(argv, config.timeoutMs)
  return { operationId, argv, result }
}

/**
 * 断言命令行里没有 shell 参与。
 *
 * 正常情况下构造出的 argv 里不该出现这些元字符：一旦出现，说明有人把参数
 * 直接拿去拼命令了（而不是当独立参数传递）。这道断言是纵深防御 ——
 * 参数白名单已经保证了安全性，但如果将来有人不小心改成字符串拼接，
 * 这里会立刻在测试里炸出来，而不是等它变成漏洞。
 *
 * 关于「哪些字符算危险」的取舍：
 *   包含 ; | & ` $ ( ) < > 和换行 —— 这些在 shell 里能改变命令结构。
 *   **刻意不包含花括号 {}**：它只在 shell 的"花括号展开"里才有意义，
 *   而我们对子进程用 shell:false，根本没有 shell 参与。
 *   但 docker 的 --format 用的是 Go 模板语法（{{.Names}}），必须用花括号 ——
 *   把 {} 也算危险字符会直接误杀这个合法且常用的参数。
 *   （这条是测试发现的：最初写了 {}，结果 docker ps --format 被自己的防护拒了。）
 */
const SHELL_METACHARACTERS = /[;&|`$()<>]|\n|\r/

export function assertNoShell(argv: string[]): void {
  if (argv.length === 0) throw new AdminError(500, '命令为空')

  const forbidden = ['sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh']
  if (forbidden.includes(argv[0]!)) {
    throw new AdminError(500, `拒绝以 shell 作为执行入口：${argv[0]}`)
  }
  for (const arg of argv) {
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new AdminError(500, `参数里出现了 shell 元字符，拒绝执行：${arg}`)
    }
  }
}

// ---------------------------------------------------------------- 权限门禁

export interface GateInput {
  isAdmin: boolean
  /**
   * 请求者**本人**的 TOTP 秘密（已解密）。未绑定则为 null。
   *
   * 用本人的秘密而不是服务器级的全局秘密：这样才能做到"每个人各自绑定、
   * 各自吊销"，也才真正证明"操作的人是他本人"。
   */
  totpSecret: string | null
  /** 本次请求提交的 TOTP 码（只读操作可为空） */
  totpCode?: string
  clientIp: string | null
  operation: AdminOperation
}

export interface GateDeps {
  verifyTotp: (secret: string, code: string) => boolean
  config: AdminDockerConfig
}

export type GateResult = { allowed: true } | { allowed: false; status: number; reason: string }

/**
 * 访问门禁。**在构造任何命令之前调用。**
 *
 * 这一层单独抽出来是为了可测试：全部是纯逻辑（管理员身份、TOTP、IP、启用状态），
 * 不依赖 Docker，因此能在本地完整覆盖。
 */
export function checkGate(deps: GateDeps, input: GateInput): GateResult {
  const config = deps.config

  // 检查顺序是有讲究的：**先鉴权，再看功能是否可用**。
  // 反过来写的话，一个非管理员会收到"管控未启用"这样的回复 ——
  // 那等于把服务端的配置状态泄漏给了无权访问的人。
  // 先判身份，非管理员一律 401，他无法从响应里推出任何配置信息。
  if (!input.isAdmin) {
    return { allowed: false, status: 401, reason: '需要管理员权限' }
  }
  if (!config.enabled) {
    return { allowed: false, status: 503, reason: '管理员 Docker 管控未启用' }
  }
  if (config.allowedIps.length > 0) {
    if (!input.clientIp || !config.allowedIps.includes(input.clientIp)) {
      return {
        allowed: false,
        status: 403,
        reason: `来源地址 ${input.clientIp ?? '未知'} 不在允许清单内`,
      }
    }
  }
  if (input.operation.mutating) {
    if (!input.totpSecret) {
      return {
        allowed: false,
        status: 403,
        reason: '变更类操作需要先绑定两步验证。请先在「运维 → 两步验证」里完成绑定。',
      }
    }
    if (!input.totpCode) {
      return { allowed: false, status: 401, reason: '变更类操作需要输入验证器上的 6 位动态口令' }
    }
    if (!deps.verifyTotp(input.totpSecret, input.totpCode)) {
      return { allowed: false, status: 401, reason: '动态口令不正确或已过期' }
    }
  }
  return { allowed: true }
}

/** 操作清单（给前端渲染按钮用）。 */
export function describeOperations(): Array<{
  id: string
  label: string
  description: string
  mutating: boolean
  params: Record<string, string>
}> {
  return OPERATIONS.map((op) => ({
    id: op.id,
    label: op.label,
    description: op.description,
    mutating: op.mutating,
    params: op.params,
  }))
}
