/**
 * 一键跑全部测试。
 *
 * 做三件事，省掉手工步骤：
 *   1. 纯逻辑测试直接跑（不需要服务端）
 *   2. 需要 API 的测试：起一个**独立的**服务端 → 跑测试 → 收拾干净
 *      （每个都需要干净数据库，因为"首次运行自举创建管理员"只发生一次）
 *   3. 汇总结果，任何一项失败就以非零码退出
 *
 * ⚠️ 测试服务端用自己的端口和自己的数据目录（见下面 TEST_PORT / TEST_DATA_DIR），
 * **不碰**你 `pnpm dev` 的那一份。这一点很重要：早先它共用 3000 端口和 `data/`，
 * 于是"跑个测试"会把你正在用的后端杀掉、把开发数据库删掉重建 ——
 * 而且你只会看到后端莫名其妙不响应，很难联想到是测试干的。
 *
 * 用法：
 *   node scripts/run-all-tests.mjs
 *   node scripts/run-all-tests.mjs --only chat-test,games-test
 *   node scripts/run-all-tests.mjs --skip-ui        # 跳过需要浏览器的那个
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 测试专用端口。刻意不用 3000：那是 `pnpm dev` 的端口。 */
const TEST_PORT = Number(process.env.WL_TEST_PORT ?? 3100)
/**
 * 测试专用数据目录。刻意不用 `data/`：那是 `pnpm dev` 的库。
 *
 * ⚠️ **目录名跟着端口走**，不是固定的 `.test-data`。
 *
 * 起因是一次真实的互相打架：两个 agent 同时各跑一套测试，都用 3100 端口
 * 和同一个 `.test-data`，于是一边的 `killPort()` 把另一边的服务端杀了
 * （表现是莫名其妙的 `ECONNRESET`），而且两边还在往同一个库里写。
 *
 * 端口不同 → 目录不同，这样 `WL_TEST_PORT=3200 pnpm test` 就是完全隔离的一套，
 * 想并行跑几套都行。
 */
const TEST_DATA_DIR = join(ROOT, `.test-data-${TEST_PORT}`)

/**
 * 给"证书到期提醒"用例现签两张证书。
 *
 * 为什么不往仓库里放一张固定的测试证书：证书有有效期，一张 2026 年签的
 * 固定证书到了 2027 年会变成"已过期" —— 于是某一天这个测试会毫无征兆地变红，
 * 而代码一行没动。现签就没有这个问题，代价是二百毫秒。
 *
 * 两张：
 *   good.crt —— 397 天（与 gen-certs.sh 的默认一致），用来验"正常时 status=ok"
 *   soon.crt —— 5 天，用来验"快到期时只是提醒、不是红"
 *
 * 没有 openssl 的机器（比如只装 git 的精简环境）返回 null，相关用例会打印跳过，
 * 而不是报一个"环境问题"的失败。
 */
const TEST_CERTS_DIR = join(ROOT, '.test-certs')

function ensureTestCerts() {
  try {
    rmSync(TEST_CERTS_DIR, { recursive: true, force: true })
    mkdirSync(TEST_CERTS_DIR, { recursive: true })
    const make = (name, days) => {
      const out = join(TEST_CERTS_DIR, name)
      const r = spawnSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
          '-days', String(days),
          '-keyout', join(TEST_CERTS_DIR, `${name}.key`),
          '-out', out,
          '-subj', '/O=WL Test/CN=wl.test',
        ],
        { encoding: 'utf8' },
      )
      if (r.status !== 0 || !existsSync(out)) throw new Error(r.stderr || 'openssl 失败')
      return out
    }
    return { dir: TEST_CERTS_DIR, good: make('good.crt', 397), soon: make('soon.crt', 5) }
  } catch {
    return null
  }
}

const TEST_CERTS = ensureTestCerts()

/** 不需要服务端的测试：纯逻辑，秒级完成。 */
const OFFLINE_TESTS = [
  { name: 'xiangqi-test', label: '象棋规则引擎（含 perft）' },
  // 机器人用的是另写的一套快速走法生成/将军判定，必须与规则引擎**逐局面比对**，
  // 不许两份实现悄悄分叉（见 xiangqi-ai-test.mjs 开头）。
  { name: 'xiangqi-ai-test', label: '象棋机器人（差分测试 / 棋力 / 性能）' },
  // 杀法识别：每个名局都用"先确认确实是将死、再确认名字"的方式验过。
  { name: 'xiangqi-mate-test', label: '绝杀识别（卧槽马 / 双车错 / 对面笑…）' },
  { name: 'doudizhu-test', label: '斗地主规则引擎（牌型与比较）' },
  // 斗地主反馈效果的纯逻辑部分：驱动动画的"这一手"标识（回归 history 封顶那个坑）
  // 与结算原因的中文映射。真跑动画需要浏览器，那部分只能靠 ui-smoke-test / 肉眼。
  { name: 'doudizhu-ux-test', label: '斗地主反馈效果（动画触发源与文案）' },
  { name: 'werewolf-test', label: '狼人杀（身份/阶段/隐藏信息）' },
  // 你画我猜的规则引擎：计分/提示公式、阶段机，以及**视角裁剪**（词漏了游戏就死了）
  { name: 'draw-test', label: '你画我猜（计分提示公式/阶段机/视角裁剪）' },
  { name: 'totp-test', label: 'TOTP（RFC 6238 标准向量）' },
  // 听歌房的时钟基准：它 import 的就是 web/src/lib/music-clock.ts 本体
  // （Node 22.18+ 默认剥离类型）。重点回归"采样全失败时绝不写 0" ——
  // 那是一条静默把同步基准换成裸墙钟的路径。
  { name: 'music-clock-test', label: '听歌房时钟（失败保留旧锚/epoch/休眠）' },
  { name: 'admin-test', label: '运维管控安全逻辑' },
  { name: 'ops-runner-test', label: '执行器白名单校验' },
  // 起 4 个真子进程同时迁移一个空库 —— 复现"版本号在锁外读"的那个撞车
  { name: 'db-migrate-test', label: '数据库迁移（并发启动只迁一次）' },
]

/** 需要服务端 + 干净数据库的测试。 */
const ONLINE_TESTS = [
  { name: 'e2e-test', label: '文件与账号 API' },
  {
    name: 'upload-limit-test',
    label: '上传限制（磁盘余量守卫）',
    // 把「必须保留的磁盘余量」设成 1 PiB —— 大于任何真实磁盘，
    // 于是无论测试机磁盘多空，守卫都必然触发，断言是确定性的。
    serverEnv: { WL_MIN_FREE_BYTES: String(1024 ** 5) },
  },
  { name: 'ratelimit-test', label: '速率限制（真打满阈值）' },
  // 第二步登录的限流曾经是**全站单桶**：匿名者打满它就能让所有人（含管理员）
  // 登不进去。这个测试用 node:http 的 localAddress 从 127.0.0.x 发请求，
  // 真的模拟多个源 IP —— 普通 fetch 做不到这件事，所有请求都来自 127.0.0.1。
  { name: 'totp-ratelimit-test', label: '两步登录限流（按 IP / 按账号分桶）' },
  // 健康检查原来恒返回 ok:true，等于装了个永远不响的报警器。
  // 这个测试要读服务端的库去伪造一条坏审计记录，所以需要数据目录。
  { name: 'health-test', label: '健康检查（写探针 / 磁盘 / 增量审计链）', passDataDir: true },
  {
    name: 'health-degraded-test',
    label: '健康检查（磁盘告急时必须 503）',
    // 把底线设成 1 PiB —— 大于任何真实磁盘，于是"磁盘不足"这条路必然触发。
    // 断言因此是确定性的，不依赖测试机还剩多少空间。
    serverEnv: { WL_HEALTH_MIN_FREE_BYTES: String(1024 ** 5) },
  },
  {
    name: 'cert-health-test',
    label: '证书到期（剩余天数进健康检查）',
    // 用一张 5 天后到期的证书启动服务端：验证"快到期"只是提醒（degraded），
    // 不是 503 —— 重启修不好一张过期的证书，把它变成 503 只会让 Docker
    // 反复重启容器。然后把文件换成 397 天的，验证缓存按 mtime 失效。
    serverEnv: TEST_CERTS ? { WL_TLS_CERT_PATH: TEST_CERTS.soon } : {},
    passCertPath: true,
  },
  { name: 'image-tools-test', label: '图片工具（格式/缩放/压缩）' },
  { name: 'tools-extra-test', label: '工具集扩展（PDF/图片/文本/抽签）' },
  // 表格预览的解析器。**不需要服务端**：它 import 的是 web/src/lib/csv.ts 本体
  // （Node 22.18+ 默认剥离类型），跑的就是界面用的那份代码。
  { name: 'csv-parser-test', label: 'CSV/TSV 解析（引号/换行/分隔符识别）' },
  // 在线编辑的保存接口：权限、类型白名单、409 并发、引用计数、内容正确性。
  // 它会**真的**用 ExcelJS 把产物解析回来比对，所以装配 exceljs / fflate 这两个
  // 依赖是必要的 —— 这两个库在 web 侧也是同一份（编辑器用的就是它们）。
  { name: 'office-edit-test', label: '在线编辑（保存/权限/并发/引用计数）' },
  { name: 'chat-test', label: '聊天（含 SSE 实时推送）' },
  {
    name: 'realtime-test',
    label: '实时推送与在线状态',
    // 这个测试要伪造一条"心跳已过期"的 presence 记录，所以需要知道数据库在哪。
    // 直接把测试数据目录传给它 —— 它自己会开读那个库（是本次测试自己的库，不是开发库）。
    passDataDir: true,
  },
  { name: 'ledger-test', label: '记账（金额精度与状态机）' },
  { name: 'assets-test', label: '财物管理（台账与借还）' },
  { name: 'user-admin-test', label: '用户管理 / 个人资料 / 权限补全' },
  { name: 'games-test', label: '象棋房间（与引擎差分比对）' },
  // 人机对战的两条命门：搜索不能堵主线程（否则整站卡顿），落子链断了要能自愈
  // （否则界面永远停在"电脑正在思考…"）。它要直接改库造一个"调度丢了"的房间，
  // 所以需要数据目录。
  { name: 'xiangqi-bot-test', label: '人机对战（不阻塞主线程 / 卡死自愈）', passDataDir: true },
  // 三种游戏共用 game_rooms 一张表，单独测谁都测不出隔离问题 —— 见这个文件头的说明
  { name: 'game-isolation-test', label: '三种游戏共存时的隔离' },
  { name: 'doudizhu-room-test', label: '斗地主房间（手牌隐藏）' },
  {
    name: 'draw-room-test',
    label: '你画我猜房间（画笔校验/猜词计分/超时推进）',
    // 超时加速用例直接改测试库里的 phaseEndsAt
    passDataDir: true,
  },
  { name: 'board-test', label: '留言板（发帖/处理标记/撤回/权限边界）' },
  { name: 'poll-test', label: '投票（一人一票/改票/关闭与截止/权限边界）' },
  { name: 'music-room-test', label: '听歌房（排播权限/切歌状态机/删除不断声）' },
  // 外网不通时它自己会降级成 skip（上游不可用不是本服务故障），所以允许常驻在这一套里
  {
    name: 'music-online-test',
    label: '在线曲库（哔哩哔哩搜索/代理拉流/SSRF 防线）',
    // 让服务端把"每次真实上游调用"记进一个文件：测试要在**另一个进程**里证明
    // "连续两次 Range 之间 playurl 只被打了一次"（<audio> 会打几十个 Range，
    // 每个都重新解析就会卡死 + 触发风控）。不设这个变量生产环境零开销。
    // 路径必须与 music-online-test.mjs 里的默认值一致 —— runTest 不转发 serverEnv。
    serverEnv: { WL_MUSIC_ONLINE_TRACE: join(ROOT, '.test-music-online-trace.log') },
  },
  { name: 'typing-test', label: '打字练习（个人进度/错题本/数据隔离）' },
  { name: 'whiteboard-test', label: '白板（全员可读/作者可写/场景校验）' },
  {
    name: 'file-range-test',
    label: '文件 Range 请求（视频拖进度条/断点续传）',
  },
  {
    name: 'werewolf-route-test',
    label: '狼人杀路由（视角裁剪与接口契约）',
    // 这个测试要拿**真实身份**去比对每个人的 view 有没有泄露，所以需要读服务端的库
    passDataDir: true,
  },
  { name: 'admin-e2e-test', label: '两步验证绑定流程' },
  {
    name: 'convert-test',
    label: '文档转换（与 Gotenberg 的契约）',
    // 这条测试需要一个"转换服务"存在，它自己会在 9919 上起一个假的 Gotenberg。
    // 应用侧必须在**启动时**就拿到这个地址（availability() 在启动时读配置），
    // 所以这里给服务端补一个环境变量。
    serverEnv: { WL_CONVERT_SERVICE_URL: 'http://127.0.0.1:9919' },
  },
  {
    name: 'video-seek-test',
    label: '视频预览（真浏览器里播放与拖进度条）',
    // 它用真 Chrome 录一段视频再上传、播放、seek —— 必须排在 ui-smoke 之外单独起浏览器
  },
  { name: 'ui-smoke-test', label: '真实浏览器渲染与交互' },
]

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2)
const onlyArg = args.find((a) => a.startsWith('--only'))
const only = onlyArg
  ? (args[args.indexOf(onlyArg) + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : null
const skipUi = args.includes('--skip-ui')

function wanted(test) {
  if (skipUi && test.name === 'ui-smoke-test') return false
  if (only && !only.includes(test.name)) return false
  return true
}

// ---------------------------------------------------------------- 服务端生命周期

const SERVER_LOG = join(ROOT, '.test-server.log')

/**
 * 找到占用**测试端口**的进程并杀掉。
 *
 * 只针对 TEST_PORT —— 绝不去动 3000 上那个可能正在被你使用的开发后端。
 * （之前这里用的是 3000，于是跑测试会顺手把你 `pnpm dev` 的后端杀掉。）
 */
function killPort() {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
    const line = out
      .split('\n')
      .find((l) => l.includes(`:${TEST_PORT}`) && l.includes('LISTENING'))
    const pid = line?.trim().split(/\s+/).pop()
    if (pid) spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' })
    return
  }
  const out =
    spawnSync('sh', ['-c', `lsof -ti tcp:${TEST_PORT} || true`], { encoding: 'utf8' }).stdout ?? ''
  for (const pid of out.trim().split('\n').filter(Boolean)) {
    spawnSync('kill', ['-9', pid], { stdio: 'ignore' })
  }
}

async function startServer(extraEnv = {}) {
  killPort()
  await sleep(400)

  // 清空**测试**数据目录。"首次运行自举创建管理员"每个测试都要重来一次，
  // 所以要一个干净库 —— 但只清自己的，开发库不动。
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true })

  const child = spawn('node', ['src/index.ts'], {
    cwd: join(ROOT, 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 测试服务端跑在自己的端口和自己的数据目录上，与 `pnpm dev` 互不干扰。
      WL_PORT: String(TEST_PORT),
      WL_DATA_DIR: TEST_DATA_DIR,
      // 个别测试需要服务端启动时就带上的变量（比如转换服务地址）
      ...extraEnv,
    },
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d.toString()
  })
  child.stderr.on('data', (d) => {
    output += d.toString()
  })

  // 等它就绪：轮询 /api/health 而不是固定 sleep，慢机器上更稳
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      // 只要能拿到响应就说明在监听了。**不能用 `res.ok` 判断** ——
      // health-degraded-test 会故意让服务端返回 503，那种情况同样是"已就绪"。
      await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`)
      return child
    } catch {
      // 还没起来
    }
  }
  console.error('\n服务端启动失败，输出如下：\n' + output)
  child.kill()
  process.exit(1)
}

// ---------------------------------------------------------------- 执行

/**
 * 跑 UI 测试之前必须重建前端。
 *
 * ⚠️ 不重建的话，`ui-smoke-test` 测的是**上一次构建的产物**，而不是你刚改的源码 ——
 * 于是它会一路全绿，你却是拿着旧代码在自欺欺人。这个坑真实踩过一次：
 * 修好了前端的键盘归属问题，UI 测试照样报"多开了一个窗口"，查半天才发现
 * 是 dist 没重建。
 *
 * vite 构建只要 1 秒左右，所以不搞增量判断，每次都重建 —— 确定性比省那一秒重要。
 */
function buildWeb() {
  const started = Date.now()
  const result = spawnSync('pnpm', ['-F', '@wl/web', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  })
  if (result.status !== 0) {
    console.error('\n\x1b[31m前端构建失败：\x1b[0m\n' + (result.stdout ?? '') + (result.stderr ?? ''))
    process.exit(1)
  }
  console.log(`\x1b[90m（已重建前端产物，${Date.now() - started}ms）\x1b[0m`)
}

/**
 * 收拾测试留下的数据目录。
 *
 * 失败时**故意保留**：那时候数据库是排查现场，删掉等于毁掉证据。
 * 成功时清掉，这样磁盘上不会留下一份没人知道是什么的测试库。
 */
function cleanupDataDir(ok) {
  if (!existsSync(TEST_DATA_DIR)) return
  if (!ok) {
    console.log(
      `\x1b[33m注：有测试失败，保留了 ${TEST_DATA_DIR} 供排查。\x1b[0m\n` +
        `\x1b[90m    它是一个独立的测试库，留着不影响你 pnpm dev 的那份数据。\x1b[0m\n`,
    )
    return
  }
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  } catch {
    console.log(`\x1b[33m⚠ 没能清掉 ${TEST_DATA_DIR}\x1b[0m\n`)
  }
}

let totalPassed = 0
let totalFailed = 0
const failures = []
const crashedTests = []
/** 上一次 runTest 是否真的跑起来了（输出里有没有结果行）。 */
let lastRunProducedOutput = false

function runTest(test, isRetry = false) {
  const { name, label } = test
  const result = spawnSync('node', [`scripts/${name}.mjs`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WL_TEST_BASE: `http://127.0.0.1:${TEST_PORT}`,
      // 少数测试需要直接检查服务端的数据（比如伪造一条过期的心跳记录）
      ...(test.passDataDir ? { WL_TEST_DATA_DIR: TEST_DATA_DIR } : {}),
      // 证书用例要能改那份证书文件（验缓存按 mtime 失效）
      ...(test.passCertPath && TEST_CERTS
        ? { WL_TEST_CERT_PATH: TEST_CERTS.soon, WL_TEST_CERT_GOOD: TEST_CERTS.good }
        : {}),
    },
  })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  // 剥掉 ANSI 颜色再解析
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
  const match = plain.match(/通过 (\d+)\s+失败 (\d+)/)
  const passed = match ? Number(match[1]) : 0
  // ⚠️ 测试崩溃（进程非零退出但没打出结果行）必须计为失败。
  // 最初这里让它保持 0，于是套件会**报告成功** —— 那比不稳定更糟：
  // 一个静默放行的测试套件等于没有测试套件。
  const crashed = match === null
  const failed = match ? Number(match[2]) : 1

  lastRunProducedOutput = match !== null
  totalPassed += passed
  totalFailed += failed
  if (crashed) crashedTests.push({ name, label })

  const status = result.status === 0 && !crashed ? '\x1b[32m通过\x1b[0m' : '\x1b[31m失败\x1b[0m'
  console.log(
    `  ${status}  ${label.padEnd(28, ' ')} 通过 ${String(passed).padStart(3)}  失败 ${String(failed).padStart(2)}${crashed ? '  \x1b[31m(测试进程崩溃，没有输出结果行)\x1b[0m' : ''}${isRetry ? '  \x1b[90m(重试)\x1b[0m' : ''}`,
  )

  if (result.status !== 0 || crashed) {
    failures.push({ name, label, output: plain || '(测试进程没有任何输出)' })
  }
  return result.status === 0 && !crashed
}

async function main() {
  console.log('\n\x1b[1m全部测试\x1b[0m\n')

  // ---- 纯逻辑测试 ----
  const offline = OFFLINE_TESTS.filter(wanted)
  if (offline.length > 0) {
    console.log('\x1b[1m纯逻辑（无需服务端）\x1b[0m')
    for (const test of offline) runTest(test)
    console.log('')
  }

  // ---- 需要服务端的测试 ----
  const online = ONLINE_TESTS.filter(wanted)
  if (online.length > 0) {
    // UI 测试跑的是 web/dist 而不是源码，先保证它是最新的（见 buildWeb 的注释）
    if (online.some((t) => t.name === 'ui-smoke-test')) buildWeb()
    console.log('\x1b[1m端到端（每项使用全新的数据库）\x1b[0m')
    for (const test of online) {
      let attempt = 0
      let okRun = false
      while (attempt < 2 && !okRun) {
        attempt++
        process.stdout.write(
          `  \x1b[90m准备环境：${test.label}${attempt > 1 ? '（重试）' : ''}…\x1b[0m`,
        )
        const server = await startServer(test.serverEnv ?? {})
        process.stdout.write('\r\x1b[K')
        try {
          okRun = runTest(test, attempt > 1)
        } finally {
          server.kill()
          await sleep(600)
        }
        // 只有"整个测试没跑起来"（没有结果行）才重试。
        // 测试跑起来了但断言失败 → 那是真失败，不该靠重试掩盖。
        if (!okRun && lastRunProducedOutput) break
      }
    }
    killPort()
    console.log('')
  }

  // ---- 汇总 ----
  const ok = totalFailed === 0
  console.log(
    `\x1b[1m合计\x1b[0m  通过 \x1b[32m${totalPassed}\x1b[0m  失败 \x1b[${ok ? '32' : '31'}m${totalFailed}\x1b[0m\n`,
  )

  if (!ok) {
    for (const f of failures) {
      console.log(`\x1b[31m──── ${f.name} 的输出 ────\x1b[0m`)
      const lines = f.output.split('\n').filter((l) => l.includes('✗') || l.includes('Error') || l.includes('异常'))
      console.log(lines.slice(0, 20).join('\n') || f.output.slice(-1500))
      console.log('')
    }
  }

  cleanupDataDir(ok)

  process.exit(ok ? 0 : 1)
}

main()
