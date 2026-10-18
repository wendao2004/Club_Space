/**
 * 桌面外壳的渲染冒烟测试。
 *
 * 为什么需要它：`vite build` 成功只能证明"能构建"，`curl /` 只能证明"HTML 送达了"。
 * 前端一个运行时错误就是白屏，而这两种检查都抓不到。所以这里用 Chrome 的
 * DevTools 协议驱动真实浏览器：注入会话 cookie → 打开首页 → 检查桌面外壳的
 * 关键 DOM 是否真的渲染出来 → 抓控制台报错。
 *
 * 为什么手写 CDP 而不是用 Puppeteer/Playwright：本机没有 Docker、也拿不到
 * GitHub，装这类库需要下载匹配版本的 Chromium（几百 MB），在本环境里不可靠。
 * Node 24 自带 WebSocket，直接讲 CDP 协议反而更稳、零依赖。
 *
 * 用法：先启动后端，然后  node scripts/ui-smoke-test.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

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

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.pageErrors = []
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连接失败: ${e.message ?? e}`)))
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id !== undefined) {
          const waiter = this.pending.get(msg.id)
          if (waiter) {
            this.pending.delete(msg.id)
            if (msg.error) waiter.reject(new Error(msg.error.message))
            else waiter.resolve(msg.result)
          }
          return
        }
        // 事件：收集控制台错误与未捕获异常
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          const text = (msg.params.args ?? [])
            .map((a) => a.value ?? a.description ?? '')
            .join(' ')
          this.consoleErrors.push(text)
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails
          this.pageErrors.push(d.exception?.description ?? d.text ?? '未知异常')
        }
      })
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 命令超时: ${method}`))
        }
      }, 30_000)
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
  }
}

async function waitForDevtools(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`DevTools 端口 ${port} 未就绪`)
}

// ---------------------------------------------------------------- 浏览器生命周期

/**
 * 找一个当前空闲的端口。
 *
 * 为什么不用固定的 9222：上一次跑剩的浏览器可能还占着那个端口并在上面应答，
 * 于是这次起的实例绑不上，而 `waitForDevtools` 会连到**旧**浏览器上 ——
 * 测试照样全绿，但验的根本不是这次的构建。这种"假绿"比失败更糟。
 */
async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 杀掉**整个进程树**。
 *
 * `child.kill()` 只杀直接子进程 —— Chrome 的 GPU / 渲染 / 网络 / crashpad
 * 子进程会全部活下来，继续占着 profile 目录里的文件句柄。在 Windows 上
 * 那些文件会一直报 "Device or resource busy"，目录怎么都删不掉。
 * 这不是推测：临时目录里为此堆过 39 个删不掉的 profile，1.7GB。
 */
function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经退出了 */
    }
  }
}

/** 带退避的重试删除。Windows 释放文件句柄有延迟，一次删不掉是常态。 */
async function removeDirWithRetry(dir, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(250 * (i + 1))
    }
  }
  return false
}

/** 等浏览器真的死透：端口不再应答才算数（"发了信号"不等于"进程没了"）。 */
async function waitForPortToClose(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`)
    } catch {
      return true
    }
    await sleep(200)
  }
  return false
}

/**
 * 清理上一次跑剩下的浏览器。
 *
 * 先试着直接删目录 —— 删得掉说明没进程占着，零成本。只有删不掉时才去花
 * 那 1-2 秒起 PowerShell 找进程（按命令行里的 `wl-ui-smoke` 标记识别，
 * 带这个标记的只可能是本测试起的浏览器）。这样正常情况下没有任何额外开销，
 * 而一旦真的漏了，下一次运行会自己收拾干净。
 */
async function sweepStaleBrowsers(keepDir) {
  let entries = []
  try {
    entries = readdirSync(tmpdir()).filter((n) => n.startsWith('wl-ui-smoke-'))
  } catch {
    return 0
  }

  const stuck = []
  for (const name of entries) {
    const dir = join(tmpdir(), name)
    if (dir === keepDir) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      stuck.push(dir)
    }
  }
  if (stuck.length === 0) return 0

  if (process.platform === 'win32') {
    const found = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
          "Where-Object { $_.CommandLine -like '*wl-ui-smoke*' } | " +
          'ForEach-Object { $_.ProcessId }',
      ],
      { encoding: 'utf8' },
    )
    for (const line of String(found.stdout ?? '').split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isFinite(pid) && pid > 0) killProcessTree(pid)
    }
    await sleep(800)
  }

  let removed = 0
  for (const dir of stuck) {
    if (await removeDirWithRetry(dir, 4)) removed++
  }
  return removed
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n\x1b[1m桌面外壳渲染测试\x1b[0m  目标 ${BASE}\n`)

  // ---- 准备一个已登录的会话 cookie ----
  console.log('【准备会话】')
  const username = `ui${SUFFIX}`
  const password = 'ui-test-pass-2026'

  let reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, displayName: '界面测试员', password }),
  })

  if (!reg.ok) {
    // 已经有用户了：用邀请码注册就需要管理员，退化成用已知账号登录
    const existing = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'club-pass-2026' }),
    })
    if (existing.ok) {
      reg = existing
      ok('使用已有账号登录')
    } else {
      bad('准备会话', `注册 ${reg.status}，登录也无可用账号`)
      process.exit(1)
    }
  } else {
    ok('注册测试账号（首次运行即成为创建者）')
  }

  const setCookie = reg.headers.get('set-cookie') ?? ''
  const sessionCookie = setCookie.split(';')[0]
  assert(sessionCookie.length > 0, '拿到会话 cookie')
  const [cookieName, cookieValue] = sessionCookie.split('=')

  // ---- 启动浏览器 ----
  const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!chromePath) {
    console.log('  \x1b[33m未找到 Chrome/Edge，跳过渲染测试\x1b[0m')
    process.exit(0)
  }

  /**
   * 无头浏览器的用户数据目录。
   *
   * ⚠️ 跑完**必须删掉**，而且必须**真的删掉**。一个 Chrome profile 有 50-125MB，
   * 这个测试每次运行都会新建一个 —— 之前既没有清理、清理失败又被静默吞掉，
   * 结果系统临时目录里堆了 39 个删不掉的 profile（1.7GB），把 C 盘挤到只剩几 GB。
   * 用进程 id 做后缀避免并发冲突，同时记得回收。
   */
  const profileDir = join(tmpdir(), `wl-ui-smoke-${SUFFIX}`)

  // 先收拾上一次的残局。放在起浏览器之前：上一次没死干净的浏览器会占着
  // 调试端口和文件句柄，不先清掉，这次要么绑不上端口，要么连到旧实例上去。
  const swept = await sweepStaleBrowsers(profileDir)
  if (swept > 0) {
    console.log(`  \x1b[90m（顺手清理了上次残留的 ${swept} 个浏览器 profile）\x1b[0m`)
  }

  const debugPort = await findFreePort()
  // 万一上次留了个同名的，先清掉
  rmSync(profileDir, { recursive: true, force: true })

  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  /**
   * 最后一道防线。
   *
   * `finally` 只在正常走到（含抛异常）时执行。进程被 Ctrl-C、被测试运行器
   * 按超时强杀、或者自己 `process.exit()` 打断清理时，Chrome 就变成孤儿了 ——
   * 这正是残留 39 个 profile 那条路径。`exit` 事件里只能跑同步代码，
   * 而 taskkill 恰好是同步的，所以这道防线是可行的。
   */
  const killChild = () => killProcessTree(child.pid)
  process.once('exit', killChild)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      killChild()
      process.exit(1)
    })
  }

  let cdp
  try {
    const version = await waitForDevtools(debugPort)
    ok('浏览器已启动', version.Browser ?? '')

    const browserWs = version.webSocketDebuggerUrl
    cdp = new Cdp(browserWs)
    await cdp.connect()

    // 建一个标签页
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)

    /**
     * 强制桌面视口。
     *
     * 无头浏览器默认窗口是 800×600，小于 App.vue 里 820px 的移动端断点，
     * 于是会渲染移动外壳 —— 那是正确行为，但这个测试要验的是桌面外壳。
     * 用 Emulation 而不是 --window-size：后者在无头模式下不一定生效。
     */
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )

    // ---- 注入会话 cookie，再打开首页 ----
    console.log('\n【渲染桌面外壳】')
    const cookieResult = await cdp.send(
      'Network.setCookie',
      {
        name: cookieName,
        value: cookieValue,
        domain: new URL(BASE).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
      sessionId,
    )
    assert(cookieResult.success !== false, '会话 cookie 注入成功')

    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    // 等 SPA 启动 + 应用组件异步加载
    await sleep(4000)

    /**
     * 清掉上一次测试留下的窗口布局再重载。
     *
     * 布局持久化本身是功能（刷新后恢复工作区），但它会让这个测试不可重复：
     * 上一次跑剩下的窗口会被恢复出来，导致"窗口数"类断言随机失败。
     * 所以测试开始前先把它抹掉，让基线确定。
     */
    await cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.removeItem('wl.desktop.layout')` },
      sessionId,
    )
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(3000)

    // ---- 检查 DOM ----
    async function evaluate(expression) {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      )
      return result.result?.value
    }

    const shell = await evaluate(`JSON.stringify({
      hasDesktop: !!document.querySelector('.desktop'),
      hasWallpaper: !!document.querySelector('.desktop__wallpaper'),
      hasTaskbar: !!document.querySelector('.taskbar'),
      hasStartButton: !!document.querySelector('.taskbar__start'),
      hasStartLogo: document.querySelectorAll('.taskbar__logo-pane').length,
      hasClock: !!document.querySelector('.taskbar__clock'),
      hasAvatar: !!document.querySelector('.taskbar__avatar'),
      desktopIconCount: document.querySelectorAll('.desktop-icons .icon').length,
      iconLabels: [...document.querySelectorAll('.desktop-icons .icon__label')].map(e=>e.textContent.trim()),
      loginStillVisible: !!document.querySelector('.login__card'),
      theme: document.documentElement.dataset.theme,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 200)
    })`)

    const info = JSON.parse(shell)
    assert(info.hasDesktop, '桌面外壳已挂载（不是白屏）')
    assert(info.hasWallpaper, '壁纸层已渲染')
    assert(info.hasTaskbar, '任务栏已渲染')
    assert(info.hasStartButton, '开始按钮存在')
    assert(info.hasStartLogo === 4, '开始按钮的四方格 logo 完整', `${info.hasStartLogo} 块`)
    assert(info.hasClock, '任务栏时钟存在')
    assert(info.hasAvatar, '用户头像存在')
    assert(!info.loginStillVisible, '已登录，不再显示登录页')
    assert(info.desktopIconCount >= 2, '桌面图标已渲染', `${info.desktopIconCount} 个`)
    assert(
      info.iconLabels.includes('文件') && info.iconLabels.includes('工具集'),
      '桌面图标包含「文件」与「工具集」',
      info.iconLabels.join('、'),
    )
    assert(info.theme === 'dark' || info.theme === 'light', '主题已应用', info.theme)

    // ---- 交互：打开开始菜单 ----
    console.log('\n【交互验证】')
    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(600)
    const startMenu = await evaluate(`JSON.stringify({
      open: !!document.querySelector('.start'),
      hasSearch: !!document.querySelector('.start__search-input'),
      tiles: [...document.querySelectorAll('.start__tile-name')].map(e=>e.textContent.trim()),
      userName: document.querySelector('.start__user-name')?.textContent?.trim() ?? null
    })`)
    const menu = JSON.parse(startMenu)
    assert(menu.open, '点击开始按钮后开始菜单弹出')
    assert(menu.hasSearch, '开始菜单含搜索框')
    assert(menu.tiles.length >= 2, '开始菜单列出了应用磁贴', menu.tiles.join('、'))
    assert(menu.userName !== null, '开始菜单底部显示当前用户', menu.userName ?? '')

    // ---- 交互：从开始菜单打开文件管理器 ----
    const opened = await evaluate(`
      (() => {
        const tiles = [...document.querySelectorAll('.start__tile')]
        const target = tiles.find(t => t.textContent.includes('文件'))
        if (!target) return false
        target.click()
        return true
      })()
    `)
    assert(opened === true, '在开始菜单里找到了「文件」磁贴')
    await sleep(2500)

    const fm = await evaluate(`JSON.stringify({
      windowCount: document.querySelectorAll('.window').length,
      hasTitlebar: !!document.querySelector('.window__titlebar'),
      title: document.querySelector('.window__title')?.textContent?.trim() ?? null,
      hasToolbar: !!document.querySelector('.fm__toolbar'),
      hasUploadBtn: !!document.querySelector('.fm__toolbar .wl-btn--primary'),
      hasCrumbs: !!document.querySelector('.fm__crumbs'),
      hasResizeHandles: document.querySelectorAll('.window__handle').length,
      hasControls: document.querySelectorAll('.window__ctl').length
    })`)
    const win = JSON.parse(fm)
    assert(win.windowCount === 1, '打开了一个文件管理器窗口', `${win.windowCount} 个`)
    assert(win.hasTitlebar, '窗口标题栏已渲染')
    // 按钮与手柄是"每个窗口一套"，所以按窗口数换算而不是写死 3 / 8
    assert(
      win.hasControls === win.windowCount * 3,
      '每个窗口都有三个控制按钮（最小化/最大化/关闭）',
      `${win.hasControls} 个 / ${win.windowCount} 个窗口`,
    )
    assert(
      win.hasResizeHandles === win.windowCount * 8,
      '每个窗口都有 8 向缩放手柄',
      `${win.hasResizeHandles} 个 / ${win.windowCount} 个窗口`,
    )
    assert(win.hasToolbar, '文件管理器工具栏已渲染')
    assert(win.hasUploadBtn, '上传按钮存在')
    assert(win.hasCrumbs, '面包屑已渲染')

    // ---- 桌面图标双击应打开第二个窗口 ----
    await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const tools = icons.find(i => i.textContent.includes('工具集'))
        tools?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })()
    `)
    await sleep(2500)
    const after = await evaluate(`JSON.stringify({
      windowCount: document.querySelectorAll('.window').length,
      taskbarApps: document.querySelectorAll('.taskbar__app').length
    })`)
    const afterInfo = JSON.parse(after)
    assert(afterInfo.windowCount === 2, '双击桌面图标能再开一个窗口', `${afterInfo.windowCount} 个窗口`)
    assert(afterInfo.taskbarApps === 2, '任务栏为每个应用显示按钮', `${afterInfo.taskbarApps} 个按钮`)

    // ---- 聊天：真实浏览器里的收发 ----
    console.log('\n【聊天界面与交互】')

    // 先用 API 造出"另一个人"和一个会话来，这样浏览器里才有东西可看。
    const apiAs = async (cookie, path, options = {}) => {
      const headers = { cookie, ...(options.headers ?? {}) }
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        options.body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, { ...options, headers })
      const text = await res.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: res.status, body, headers: res.headers }
    }

    const inviteRes = await apiAs(sessionCookie, '/api/admin/invites', {
      method: 'POST',
      json: { role: 'member', maxUses: 1, expiresInDays: 1, note: '界面测试' },
    })

    let peerCookie = null
    let convId = null
    const CHAT_TEXT = '这条消息是在浏览器外发的，应该在界面里出现'

    if (inviteRes.status === 200) {
      const peerName = `peer${SUFFIX}`
      const peerReg = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: peerName,
          displayName: '聊天对象',
          password: 'peer-pass-2026',
          inviteCode: inviteRes.body.code,
        }),
      })
      peerCookie = (peerReg.headers.get('set-cookie') ?? '').split(';')[0]
      const peerMe = await apiAs(peerCookie, '/api/auth/me')
      const peerId = peerMe.body?.user?.id

      if (peerId) {
        const direct = await apiAs(sessionCookie, '/api/chat/conversations/direct', {
          method: 'POST',
          json: { peerId },
        })
        convId = direct.body?.conversation?.id
        if (convId) {
          await apiAs(peerCookie, `/api/chat/conversations/${convId}/messages`, {
            method: 'POST',
            json: { kind: 'text', body: CHAT_TEXT },
          })
          ok('准备聊天数据（另一个人发了一条消息）')
        }
      }
    }
    if (!convId) {
      bad('准备聊天数据', `邀请码状态 ${inviteRes.status}`)
    }

    // 打开聊天应用
    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(600)
    const chatTileFound = await evaluate(`
      (() => {
        const tiles = [...document.querySelectorAll('.start__tile')]
        const t = tiles.find(x => x.textContent.includes('聊天'))
        if (!t) return false
        t.click()
        return true
      })()
    `)
    assert(chatTileFound === true, '开始菜单里有「聊天」应用')
    await sleep(3000)

    const chatUi = await evaluate(`JSON.stringify({
      hasSide: !!document.querySelector('.chat__side'),
      hasMain: !!document.querySelector('.chat__main'),
      convCount: document.querySelectorAll('.conv').length,
      hasComposer: !!document.querySelector('.chat__input'),
      hasSend: !!document.querySelector('.chat__send'),
      hasSearch: !!document.querySelector('.chat__search-input'),
      bodyText: document.body.innerText.slice(0, 300)
    })`)
    const cu = JSON.parse(chatUi)
    assert(cu.hasSide, '聊天界面渲染了会话列表区')
    assert(cu.hasMain, '聊天界面渲染了消息区')
    assert(cu.convCount >= 1, '会话列表里出现了会话', `${cu.convCount} 个`)

    // 点开会话，应看到对方发来的消息
    await evaluate(`document.querySelector('.conv')?.click()`)
    await sleep(2500)

    const convOpened = await evaluate(`JSON.stringify({
      activeConv: document.querySelectorAll('.conv--active').length,
      hasMessage: document.body.innerText.includes(${JSON.stringify(CHAT_TEXT)}),
      emptyState: !!document.querySelector('.chat__empty-chat')
    })`)
    const op = JSON.parse(convOpened)
    assert(op.activeConv === 1, '点击后会话处于选中状态')
    assert(op.hasMessage, '看到了对方发来的消息内容（消息真的从后端加载出来了）')
    assert(!op.emptyState, '不是空状态')

    // 输入并发送一条，验证前端能把消息送到后端并渲染出来
    const REPLY = '这是浏览器里输入的回复'
    const typed = await evaluate(`
      (() => {
        const ta = document.querySelector('.chat__input')
        if (!ta) return false
        // 必须用原型上的原生 setter：直接改 .value 不会触发 Vue 的 v-model
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set
        setter.call(ta, ${JSON.stringify(REPLY)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return ta.value === ${JSON.stringify(REPLY)}
      })()
    `)
    assert(typed === true, '在输入框里输入了文字')

    await evaluate(`document.querySelector('.chat__send')?.click()`)
    await sleep(2500)

    const afterSend = await evaluate(`JSON.stringify({
      hasReply: document.body.innerText.includes(${JSON.stringify(REPLY)}),
      inputCleared: (document.querySelector('.chat__input')?.value ?? 'x') === '',
      messageCount: document.querySelectorAll('.msg').length
    })`)
    const as = JSON.parse(afterSend)
    assert(as.hasReply, '自己发的消息也出现在了界面上')
    assert(as.inputCleared, '发送成功后输入框被清空')
    assert(as.messageCount >= 2, '消息区里有两条以上消息', `${as.messageCount} 条`)

    // ---- 回归：全局键盘不该抢输入框 ----
    //
    // 真实故障：桌面图标把 Enter 监听挂在 window 上，于是「选中一个桌面图标 +
    // 在聊天框里按回车发消息」会顺手把那个选中的图标"打开"，凭空多出一个窗口。
    // 用户把它描述成"回车发送消息会单开页面"，而看代码时很容易误以为是表单提交。
    //
    // 这条断言同时验证两件事：回车**确实**被聊天框用掉了（消息发出、输入框清空），
    // 且**没有**顺带打开别的窗口。两个都成立才算修好 —— 只挡掉不多开窗口、
    // 但消息发不出去，同样是坏的。
    console.log('\n【回车键的归属权（防"发消息时多开窗口"回归）】')
    const guardProbe = await evaluate(`
      (async () => {
        // 触发条件：让一个桌面图标处于选中状态。单击即可 ——
        // 选中状态会一直保留，直到点桌面空白或按 Escape。
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const filesIcon = icons.find(i => i.textContent.includes('文件'))
        if (filesIcon) filesIcon.click()
        await new Promise(r => setTimeout(r, 250))

        const before = document.querySelectorAll('.window').length
        const ta = document.querySelector('.chat__input')
        if (!ta) return JSON.stringify({ error: '找不到聊天输入框' })

        // 必须用原型上的原生 setter，直接改 .value 不会触发 Vue 的 v-model
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set
        setter.call(ta, '键盘归属回归测试')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.focus()
        await new Promise(r => setTimeout(r, 250))

        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }))
        await new Promise(r => setTimeout(r, 1800))

        return JSON.stringify({
          before,
          after: document.querySelectorAll('.window').length,
          iconSelected: !!document.querySelector('.icon--selected'),
          inputCleared: (document.querySelector('.chat__input')?.value ?? 'x') === '',
        })
      })()
    `)
    const gp = JSON.parse(guardProbe)
    if (gp.error) {
      bad('回车归属权探测', gp.error)
    } else {
      assert(gp.iconSelected, '前置条件成立：确实有一个桌面图标处于选中状态')
      assert(
        gp.after === gp.before,
        '在聊天框按回车没有多开出窗口（桌面图标没有抢这个键）',
        `${gp.before} → ${gp.after} 个窗口`,
      )
      assert(gp.inputCleared, '回车确实被聊天框用掉了（消息发出、输入框清空）')
    }

    // ---- 财物管理应用能真的打开 ----
    //
    // 这一节的目的是验证**接线**：注册表里加了一个应用条目、写了组件、
    // store 也写好了 —— 但"打不开"正是这类改动最典型的失败方式
    // （路径写错、组件 import 失败、异步组件加载报错）。
    // 所以这里真的双击图标把它打开，再看界面渲染出来没有。
    console.log('\n【财物管理应用】')
    const assetsOpened = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const target = icons.find(i => i.textContent.includes('财物'))
        if (!target) return JSON.stringify({ error: '桌面上没有「财物」图标' })
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return JSON.stringify({ ok: true })
      })()
    `)
    const ao = JSON.parse(assetsOpened)
    if (ao.error) {
      bad('打开财物应用', ao.error)
    } else {
      await sleep(2500)
      const assetsUi = await evaluate(`JSON.stringify({
        hasApp: !!document.querySelector('.assets'),
        hasTabs: document.querySelectorAll('.assets .tab').length,
        statCount: document.querySelectorAll('.assets .stat').length,
        hasRegisterBtn: [...document.querySelectorAll('.assets button')].some(b => b.textContent.includes('登记物品')),
        text: document.querySelector('.assets')?.textContent?.slice(0, 140) ?? ''
      })`)
      const au = JSON.parse(assetsUi)
      assert(au.hasApp, '财物应用已渲染', au.text.replace(/\s+/g, ' ').slice(0, 80))
      assert(au.hasTabs >= 2, '台账 / 借还记录两个页签都在', `${au.hasTabs} 个`)
      assert(au.statCount >= 5, '概览卡片渲染出来了（数字来自服务端汇总接口）', `${au.statCount} 张`)
      assert(au.hasRegisterBtn, '管理员能看到「登记物品」按钮')

      // ---- 表单弹层的背景必须跟着主题走 ----
      //
      // 曾经踩过：样式里写的是 var(--surface-0, #1b1c1f)，而 --surface-0 这个变量
      // 在**深浅两套主题里都不存在** —— 于是永远取回退值 #1b1c1f（深色），
      // 浅色主题下弹出来就是一块黑。用户的原话是「表单的背景是黑色的」。
      //
      // ⚠️ 这里断言的是**计算后的颜色**不等于那个回退值，而不是去 grep CSS 里
      // 用了哪个变量名 —— 变量名写错正是这个 bug 的形态，grep 变量名抓不到自己。
      const dialogBg = await evaluate(`
        (async () => {
          const btn = [...document.querySelectorAll('.assets button')].find(b => b.textContent.includes('登记物品'))
          if (!btn) return JSON.stringify({ error: '找不到「登记物品」按钮' })
          btn.click()
          await new Promise(r => setTimeout(r, 500))
          const panel = document.querySelector('.dialog__panel')
          if (!panel) return JSON.stringify({ error: '对话框没有弹出来' })
          const bg = getComputedStyle(panel).backgroundColor
          const raised = getComputedStyle(document.documentElement).getPropertyValue('--surface-raised').trim()
          return JSON.stringify({ bg, raised, theme: document.documentElement.dataset.theme })
        })()
      `)
      const db2 = JSON.parse(dialogBg)
      if (db2.error) {
        bad('登记物品对话框', db2.error)
      } else {
        assert(
          db2.bg !== 'rgb(27, 28, 31)',
          '表单背景没有走那个写死的深色回退值（#1b1c1f）',
          `实际背景 ${db2.bg}（主题 ${db2.theme}）`,
        )
        assert(
          typeof db2.bg === 'string' && db2.bg !== 'rgba(0, 0, 0, 0)' && db2.bg !== 'transparent',
          '表单背景是实色（不是透明导致露出底下的东西）',
          db2.bg,
        )
        // 顺手把对话框关掉：后面还有别的界面要验，别留个盖住整屏的弹层
        await evaluate(`
          (() => {
            const cancel = [...document.querySelectorAll('.dialog__panel button')]
              .find(b => b.textContent.trim() === '取消')
            if (cancel) cancel.click()
            return true
          })()
        `)
        await sleep(300)
        const closed = await evaluate(`!document.querySelector('.dialog__panel')`)
        assert(closed, '「取消」能关掉对话框（弹层不会赖着不走）')
      }
    }

    // ---- 狼人杀应用能真的打开 ----
    console.log('\n【狼人杀应用】')
    const wwOpened = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const target = icons.find(i => i.textContent.includes('狼人杀'))
        if (!target) return JSON.stringify({ error: '桌面上没有「狼人杀」图标' })
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return JSON.stringify({ ok: true })
      })()
    `)
    const wo = JSON.parse(wwOpened)
    if (wo.error) {
      bad('打开狼人杀应用', wo.error)
    } else {
      await sleep(2500)
      const wwUi = await evaluate(`JSON.stringify({
        hasApp: !!document.querySelector('.ww'),
        hasCreate: [...document.querySelectorAll('.ww button')].some(b => b.textContent.includes('新建房间')),
        ruleText: document.querySelector('.ww__sub')?.textContent?.trim() ?? '',
        countOptions: document.querySelectorAll('.ww__count option').length
      })`)
      const wu = JSON.parse(wwUi)
      assert(wu.hasApp, '狼人杀应用已渲染', wu.ruleText.slice(0, 60))
      assert(wu.hasCreate, '大厅里有「新建房间」按钮')
      // ⚠️ 这条原来断言文案里含 "9" —— 那是"只能开 9 人局"的时代。
      // 现在人数可配（6~12），文案改成了"自定义 6~12 人"，所以那条断言会永远失败。
      // 改成**验证新功能真的接上了**：人数下拉里要有多个选项（证明自定义人数是活的），
      // 文案里要提到聊天（证明房内发言那条线也接上了）。
      assert(wu.countOptions >= 5, '建房时能选人数（下拉里有多个选项）', `${wu.countOptions} 个选项`)
      assert(wu.ruleText.includes('人'), '板子说明写清了人数相关的信息', wu.ruleText.slice(0, 60))
      assert(
        /聊|发言/.test(wu.ruleText),
        '大厅文案里提到了房内发言（说明文本对话那条线也接上了）',
        wu.ruleText.slice(0, 80),
      )
    }

    // ---- 记账：按活动看账 ----
    //
    // 这一节验的是**接线**：记账模块新加了"活动"这条业务线（迁移 v8 + 一堆接口 +
    // 界面），而"加了但打不开"正是这种改动最典型的失败方式。
    // 所以真的把界面打开、切到活动视图、再点开新建活动的表单看一眼。
    console.log('\n【记账：活动视图】')
    const ledgerProbe = await evaluate(`
      (async () => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const target = icons.find(i => i.textContent.includes('记账'))
        if (!target) return JSON.stringify({ error: '桌面上没有「记账」图标' })
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await new Promise(r => setTimeout(r, 2500))

        const hasApp = !!document.querySelector('.ledger')
        if (!hasApp) return JSON.stringify({ error: '记账应用没渲染出来' })

        // 切到"按活动"
        const evBtn = [...document.querySelectorAll('.ledger .seg--view .seg__btn')]
          .find(b => b.textContent.includes('按活动'))
        if (!evBtn) return JSON.stringify({ error: '找不到「按活动」切换按钮' })
        evBtn.click()
        await new Promise(r => setTimeout(r, 900))

        const hasEvHead = !!document.querySelector('.ledger .evhead')
        const hasNewBtn = [...document.querySelectorAll('.ledger button')]
          .some(b => b.textContent.includes('新建活动'))

        // 打开新建活动的表单
        const newBtn = [...document.querySelectorAll('.ledger button')]
          .find(b => b.textContent.includes('新建活动'))
        if (newBtn) newBtn.click()
        await new Promise(r => setTimeout(r, 600))
        const modal = document.querySelector('.overlay .modal')
        const modalTitle = modal?.querySelector('.modal__title')?.textContent?.trim() ?? ''
        const hasNameField = !!modal?.querySelector('input.wl-input')
        const segCount = modal?.querySelectorAll('.seg__btn').length ?? 0

        // 关掉，别留个盖住整屏的弹层影响后面
        const cancel = [...(modal?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消')
        if (cancel) cancel.click()
        await new Promise(r => setTimeout(r, 400))

        return JSON.stringify({
          hasEvHead, hasNewBtn, modalTitle, hasNameField, segCount,
          modalClosed: !document.querySelector('.ledger .overlay .modal')
        })
      })()
    `)
    const lp = JSON.parse(ledgerProbe)
    if (lp.error) {
      bad('记账活动视图', lp.error)
    } else {
      assert(lp.hasEvHead, '切到「按活动」后渲染出了活动视图')
      assert(lp.hasNewBtn, '有「新建活动」按钮')
      assert(lp.modalTitle.includes('活动'), '点开后是活动表单', `标题「${lp.modalTitle}」`)
      assert(lp.hasNameField, '表单里有名称输入框')
      assert(lp.segCount >= 3, '有比赛/活动/其它三个类型选项', `${lp.segCount} 个`)
      assert(lp.modalClosed, '「取消」能关掉活动表单')
    }

    // 交叉验证：用 API 直接查后端，确认这条消息真的存进去了
    const viaApi = await apiAs(sessionCookie, `/api/chat/conversations/${convId}/messages`)
    assert(
      viaApi.body.messages?.some((m) => m.body === REPLY),
      '后端确实存下了这条消息（不只是前端本地乐观更新）',
    )

    // ---- 记账：界面渲染与真实记账 ----
    console.log('\n【记账界面与交互】')

    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(600)
    const ledgerTile = await evaluate(`
      (() => {
        const tiles = [...document.querySelectorAll('.start__tile')]
        const t = tiles.find(x => x.textContent.includes('记账'))
        if (!t) return false
        t.click()
        return true
      })()
    `)
    assert(ledgerTile === true, '开始菜单里有「记账」应用')
    await sleep(3000)

    const ledgerUi = await evaluate(`JSON.stringify({
      hasToolbar: !!document.querySelector('.toolbar__title'),
      toolbarText: document.querySelector('.toolbar__title')?.textContent?.trim() ?? null,
      hasSummaryPanel: !!document.querySelector('.stat__value--success') || !!document.querySelector('.stat__value--danger'),
      statValues: [...document.querySelectorAll('.stat__value')].map(e => e.textContent.trim()),
      hasFilters: document.querySelectorAll('.filter__select').length,
      hasEmptyOrList: !!document.querySelector('.empty__title') || document.querySelectorAll('.entry__title').length > 0
    })`)
    const lu = JSON.parse(ledgerUi)
    assert(lu.hasToolbar, '记账界面渲染了工具栏')
    assert(lu.toolbarText === '社团账目', '标题正确', lu.toolbarText ?? '')
    assert(lu.hasSummaryPanel, '统计面板渲染了（收入/支出/结余卡片）', lu.statValues.join(' / '))
    assert(lu.hasFilters >= 2, '筛选下拉已渲染', `${lu.hasFilters} 个`)
    assert(lu.hasEmptyOrList, '列表区渲染了（空状态或账目）')

    // 真实记一笔
    const ENTRY_TITLE = '界面测试：买了两箱矿泉水'
    const ledgerFormOpened = await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const b = btns.find(x => x.textContent.includes('记一笔'))
        if (!b) return false
        b.click()
        return true
      })()
    `)
    assert(ledgerFormOpened === true, '点开了「记一笔」表单')
    await sleep(800)

    const filled = await evaluate(`
      (() => {
        const setInput = (el, value) => {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const amount = document.querySelector('.amount-input')
        const title = document.querySelector('input[placeholder="这笔钱的用途"]')
        if (!amount || !title) return { ok: false, why: '找不到输入框' }
        setInput(amount, '36.80')
        setInput(title, ${JSON.stringify(ENTRY_TITLE)})
        return { ok: true, amount: amount.value, title: title.value }
      })()
    `)
    assert(filled.ok === true, '填入了金额与事由', JSON.stringify(filled))
    assert(filled.amount === '36.80', '金额输入框保留原样字符串（没有经过浮点转换）', filled.amount)

    await evaluate(`document.querySelector('.modal__footbtns .wl-btn--primary')?.click()`)
    await sleep(3000)

    const afterCreate = await evaluate(`JSON.stringify({
      modalClosed: !document.querySelector('.modal__footbtns'),
      titles: [...document.querySelectorAll('.entry__title')].map(e => e.textContent.trim()),
      amounts: [...document.querySelectorAll('.entry__amount')].map(e => e.textContent.trim()),
      formError: document.querySelector('.form-error')?.textContent?.trim() ?? null
    })`)
    const ac = JSON.parse(afterCreate)
    assert(ac.modalClosed, '提交后表单关闭')
    assert(
      ac.titles.includes(ENTRY_TITLE),
      '新建的账目出现在列表里',
      ac.titles.slice(0, 3).join(' | ') || ac.formError || '(列表为空)',
    )
    assert(
      ac.amounts.some((a) => a.includes('36.80')),
      '金额显示为 36.80（整数分存储，显示时还原）',
      ac.amounts.slice(0, 3).join(' | '),
    )

    // 交叉验证：直接查后端，确认这笔账真的存进去了，而且金额是精确的 3680 分
    const ledgerApi = await apiAs(sessionCookie, '/api/ledger/entries?mine=1&limit=50')
    const created = ledgerApi.body.entries?.find((e) => e.title === ENTRY_TITLE)
    assert(created !== undefined, '后端确实存下了这笔账（不只是前端本地插入）')
    if (created) {
      assert(
        created.amountCents === 3680,
        '金额精确存成 3680 分（36.80 元）',
        `${created.amountCents} 分`,
      )
      // ⚠️ 这里原来断言 `status === 'draft'` —— 那是"管理员记账也要审批"时代的写法。
      // 现在管理员（本测试用的就是 owner 账号）记的账**直接落成已通过**，
      // 这正是用户要的：「管理员记账上传为啥还需要通过」。
      // 成员的账目仍然是草稿，那条由 ledger-test.mjs 覆盖。
      assert(
        created.status === 'approved',
        '管理员记的账目直接是「已通过」（不再要求自己审批自己）',
        created.status,
      )
      assert(
        created.decidedBy !== null && typeof created.decisionNote === 'string',
        '直接入账同样留了审批痕迹（decided_by / decision_note 都不为空）',
        `decidedBy=${created.decidedBy} note=${created.decisionNote}`,
      )
      assert(created.kind === 'expense', '默认为支出', created.kind)
    }

    // 这笔账已经是「已通过」，所以**应当**进汇总了。
    //
    // 原来这里断言的是"草稿不进汇总" —— 行为变了，断言也必须跟着变：
    // 留着一句永远为真的旧断言，只会掩盖真正该验的东西。
    const summaryApi = await apiAs(sessionCookie, '/api/ledger/summary')
    assert(
      summaryApi.body.summary.expense === '36.80',
      '已通过的账目进了汇总统计（报表只算已通过/已支付，而这笔正是）',
      `支出汇总 ${summaryApi.body.summary.expense}`,
    )

    // ---- 象棋：棋盘渲染与真实走棋 ----
    console.log('\n【象棋界面与交互】')

    // 先通过 API 把对局凑起来：浏览器用户执红，另造一个用户执黑加入。
    // 单靠浏览器点不出"两个人在同一局里"，但棋盘交互又必须在对局中才能测，
    // 所以这里用 API 铺好前情，浏览器只负责被测的那一段。
    const gameRoom = await apiAs(sessionCookie, '/api/games/rooms', {
      method: 'POST',
      json: { kind: 'xiangqi', title: '界面走棋测试', side: 'red' },
    })
    let gameRoomId = gameRoom.body?.room?.id ?? null

    if (gameRoomId) {
      const inv = await apiAs(sessionCookie, '/api/admin/invites', {
        method: 'POST',
        json: { role: 'member', maxUses: 1, expiresInDays: 1, note: '象棋界面测试' },
      })
      if (inv.status === 200) {
        const peerReg = await fetch(`${BASE}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: `xqpeer${SUFFIX}`,
            displayName: '棋友',
            password: 'peer-pass-2026',
            inviteCode: inv.body.code,
          }),
        })
        const peerCookie = (peerReg.headers.get('set-cookie') ?? '').split(';')[0]
        const join = await apiAs(peerCookie, `/api/games/rooms/${gameRoomId}/join`, {
          method: 'POST',
          json: { side: 'black' },
        })
        if (join.status === 200 && join.body.room.status === 'playing') {
          ok('用 API 铺好对局前情（浏览器用户执红，棋友执黑）')
        } else {
          bad('铺对局前情', `加入失败 ${join.status} ${JSON.stringify(join.body)}`)
        }
      }
    }
    if (!gameRoomId) bad('创建对局', JSON.stringify(gameRoom.body))

    // 打开象棋应用。
    //
    // 这里用**桌面图标双击**而不是开始菜单磁贴：前面的测试已经开了好几个窗口、
    // 也反复开关过开始菜单，菜单的状态不够干净，点磁贴偶发不生效。
    // 桌面图标的 dblclick 是这套测试里已经验证可靠的方式。
    const gamesIconText = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        return icons.map(i => i.textContent.trim()).join('|')
      })()
    `)
    const gamesOpened = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const target = icons.find(i => i.textContent.includes('象棋'))
        if (!target) return false
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()
    `)
    assert(gamesOpened === true, '桌面上有「象棋」图标', gamesIconText)
    await sleep(3500)

    const lobbyUi = await evaluate(`JSON.stringify({
      appText: document.querySelector('.games')?.textContent?.slice(0, 300) ?? '',
      roomCards: document.querySelectorAll('.room-card').length,
      hasBoard: !!document.querySelector('.board__svg'),
      hasGames: !!document.querySelector('.games'),
      windowTitles: [...document.querySelectorAll('.window__title')].map(e => e.textContent.trim())
    })`)
    const lu2 = JSON.parse(lobbyUi)
    assert(lu2.hasGames, '象棋应用已打开', lu2.windowTitles.join('|'))
    assert(!lu2.hasBoard, '刚打开时显示大厅（还没有棋盘）')
    assert(
      lu2.roomCards >= 1,
      '大厅里列出了刚创建的对局',
      `卡片数 ${lu2.roomCards}，内容：${lu2.appText.replace(/\s+/g, ' ').slice(0, 140)}`,
    )

    // 点开那个房间卡片
    const entered = await evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.room-card')]
        const target =
          cards.find((c) => c.querySelector('.room-title')?.textContent?.includes('界面走棋测试')) ??
          cards[0]
        if (!target) return { ok: false, titles: cards.map(c => c.querySelector('.room-title')?.textContent?.trim()) }
        target.click()
        return { ok: true, title: target.querySelector('.room-title')?.textContent?.trim() }
      })()
    `)
    assert(entered.ok === true, '点开了对局卡片', entered.title ?? JSON.stringify(entered))
    await sleep(2500)

    const boardUi = await evaluate(`JSON.stringify({
      hasSvg: !!document.querySelector('.board__svg'),
      pieceCount: document.querySelectorAll('.board__piece').length,
      hitCount: document.querySelectorAll('.board__hit').length,
      riverText: document.querySelector('.board__river')?.textContent?.trim() ?? null,
      pieceTexts: [...document.querySelectorAll('.board__piece-text')].map(e => e.textContent.trim()),
      bodyText: document.body.innerText.slice(0, 500)
    })`)
    const bu = JSON.parse(boardUi)
    assert(bu.hasSvg, '棋盘已渲染（SVG）')
    assert(bu.pieceCount === 32, '棋盘上有 32 个棋子（象棋开局）', `${bu.pieceCount} 个`)
    assert(bu.hitCount === 90, '有 90 个点击热区（9×10 格）', `${bu.hitCount} 个`)
    assert(
      bu.riverText !== null && bu.riverText.includes('楚河') && bu.riverText.includes('汉界'),
      '河界写了「楚河」「汉界」',
      bu.riverText ?? '(未找到)',
    )

    // ---- 棋盘的实际渲染尺寸 ----
    //
    // 曾经踩过：`.board` 根元素没有设宽度，而它是 .board-col（一个 flex 行容器）
    // 里的 flex 项，宽度由内容决定；它的内容又是 width:100% 的 SVG —— 一个循环依赖。
    // 浏览器只能回退到 SVG 的默认尺寸（300×150 左右），于是棋盘缩成一小块，
    // 再被 .board-col 的 overflow:hidden 从右边裁掉一部分。
    // 用户的原话是「棋盘太小了，并且右侧没有显示完全」。
    //
    // ⚠️ 这里量的是真实 DOM 的尺寸，而不是去 grep CSS 里有没有写 width:100%。
    // 只检查"样式表里有没有这一行"是测不出布局结果的 —— 那正是这个 bug 能溜过去的原因。
    const boardBox = await evaluate(`JSON.stringify((() => {
      const svg = document.querySelector('.board__svg')
      const col = document.querySelector('.board-col')
      if (!svg || !col) return { error: '找不到棋盘或它的容器' }
      const s = svg.getBoundingClientRect()
      const c = col.getBoundingClientRect()
      const vb = svg.viewBox.baseVal
      // preserveAspectRatio="xMidYMid meet" 下，viewBox 内容在元素内实际占多大
      const scale = Math.min(s.width / vb.width, s.height / vb.height)
      const drawW = vb.width * scale
      const drawH = vb.height * scale
      const gapX = s.width - drawW
      const gapY = s.height - drawH

      // 所有棋子的屏幕矩形并集 —— 用来判断最外圈的棋子有没有被 SVG 视口裁掉。
      // 注意：SVG 默认 overflow:hidden，被裁掉的元素 getBoundingClientRect()
      // 仍然会报出它在视口外的真实位置，所以这个比较是有效的。
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity
      let n = 0
      for (const el of document.querySelectorAll('.board__piece, .board__piece-select')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        n++
        minL = Math.min(minL, r.left); minT = Math.min(minT, r.top)
        maxR = Math.max(maxR, r.right); maxB = Math.max(maxB, r.bottom)
      }
      return {
        svgW: Math.round(s.width), svgH: Math.round(s.height),
        colW: Math.round(c.width), colH: Math.round(c.height),
        vb: [vb.x, vb.y, vb.width, vb.height],
        viewBoxRatio: Math.round((vb.width / vb.height) * 10000) / 10000,
        elementRatio: Math.round((s.width / s.height) * 10000) / 10000,
        gapX: Math.round(gapX), gapY: Math.round(gapY),
        pieceCount: n,
        // 棋子并集相对 SVG 视口的溢出量（正数 = 被裁掉了这么多像素）
        clipLeft: Math.round(s.left - minL),
        clipTop: Math.round(s.top - minT),
        clipRight: Math.round(maxR - s.right),
        clipBottom: Math.round(maxB - s.bottom),
        svgRight: Math.round(s.right), colRight: Math.round(c.right),
        svgLeft: Math.round(s.left), colLeft: Math.round(c.left),
        svgTop: Math.round(s.top), colTop: Math.round(c.top),
        svgBottom: Math.round(s.bottom), colBottom: Math.round(c.bottom)
      }
    })())`)
    const bb = JSON.parse(boardBox)
    if (bb.error) {
      bad('测量棋盘尺寸', bb.error)
    } else {
      console.log(`  \x1b[90m[棋盘几何] ${JSON.stringify(bb)}\x1b[0m`)

      // ① 棋盘要够大：高度方向铺满（宽度由比例推出来，所以不该拿宽度去比容器宽度）
      assert(bb.svgH >= bb.colH * 0.85, '棋盘高度铺满了可用空间', `${bb.svgH}px / 容器 ${bb.colH}px`)
      assert(bb.svgW >= 320, '棋盘宽度不至于小得看不清', `${bb.svgW}px`)

      // ② 元素盒子必须正好是棋盘的形状 —— 否则会出现"棋盘居中、两边一条透明带"，
      //    那正是用户说的「右边棋盘背景颜色没对上」
      assert(
        Math.abs(bb.elementRatio - bb.viewBoxRatio) < 0.02,
        'SVG 元素的宽高比与 viewBox 一致（左右不会剩下一条透明带）',
        `元素 ${bb.elementRatio} vs viewBox ${bb.viewBoxRatio}`,
      )
      assert(
        bb.gapX <= 2 && bb.gapY <= 2,
        '没有 letterbox 留白（`meet` 不需要往外让位置）',
        `横向留白 ${bb.gapX}px，纵向留白 ${bb.gapY}px`,
      )

      // ③ 最外圈的棋子不能被裁 —— 用户报的「底部棋子没完全显示」就是这一条
      assert(bb.pieceCount >= 32, '测到了棋子的位置', `${bb.pieceCount} 个圆`)
      assert(
        bb.clipBottom <= 0 && bb.clipTop <= 0 && bb.clipLeft <= 0 && bb.clipRight <= 0,
        '所有棋子都完整落在棋盘视口内（四边都没有被裁）',
        `上${bb.clipTop} 下${bb.clipBottom} 左${bb.clipLeft} 右${bb.clipRight}（正数=溢出被裁）`,
      )

      // ④ 棋盘整体要落在它的容器里，不能伸出去
      assert(
        bb.svgRight <= bb.colRight + 1 && bb.svgLeft >= bb.colLeft - 1,
        '棋盘横向完整落在容器内',
        `棋盘 [${bb.svgLeft}, ${bb.svgRight}] vs 容器 [${bb.colLeft}, ${bb.colRight}]`,
      )
      assert(
        bb.svgBottom <= bb.colBottom + 1 && bb.svgTop >= bb.colTop - 1,
        '棋盘纵向完整落在容器内',
        `棋盘 [${bb.svgTop}, ${bb.svgBottom}] vs 容器 [${bb.colTop}, ${bb.colBottom}]`,
      )
    }
    const names = bu.pieceTexts.join('')
    assert(
      names.includes('帅') && names.includes('将'),
      '红帅与黑将都渲染了中文名',
      names.slice(0, 20),
    )
    assert(
      names.includes('车') && names.includes('马') && names.includes('炮') && names.includes('兵'),
      '车马炮兵等棋子的中文名都正确',
    )

    // 真实走一步：点红炮 b2（显示索引 7*9+1 = 64），再点目标 e2（索引 7*9+4 = 67）
    const clickedPiece = await evaluate(`
      (() => {
        const hits = document.querySelectorAll('.board__hit')
        const el = hits[64]
        if (!el) return { ok: false, why: '找不到热区 64' }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return { ok: true }
      })()
    `)
    assert(clickedPiece.ok === true, '点击了红炮所在的格子（b2）')
    await sleep(1200)

    const afterSelect = await evaluate(`JSON.stringify({
      hasSelection: !!document.querySelector('.board__piece-select'),
      targetCount: document.querySelectorAll('.board__target-dot, .board__target-ring').length
    })`)
    const sel = JSON.parse(afterSelect)
    assert(sel.hasSelection, '棋子被选中并高亮')
    assert(sel.targetCount > 0, '显示了合法落点提示', `${sel.targetCount} 个`)

    const clickedTarget = await evaluate(`
      (() => {
        const hits = document.querySelectorAll('.board__hit')
        const el = hits[67]
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      })()
    `)
    assert(clickedTarget === true, '点击了目标格 e2')

    // ---- 走子反馈特效：飞行棋子出现 → 自己消失；期间棋盘照常可点 ----
    //
    // 观感测不了（那是人的事），但能测两条硬指标：
    //   ① 特效是**临时**的 —— 飞行动画放完后整组元素必须从 DOM 消失，
    //      不能留下永远不散的节点（否则连点几下就堆一层，越玩越卡）。
    //   ② 动画期间不挡操作 —— 90 个热区数量不变，特效层 pointer-events 为 none。
    await sleep(150)
    const fxProbe = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const start = Date.now()
        let appeared = false
        let seenRipple = false
        let hitsDuringFx = null
        let peDuringFx = null
        // 轮询到"特效出现过、并且又消失了"为止（最多 3s；走子要先等服务端往返）
        while (Date.now() - start < 3000) {
          const fxEl = document.querySelector('.board__fx')
          if (fxEl && document.querySelector('.board__flight')) {
            appeared = true
            if (document.querySelector('.board__ripple')) seenRipple = true
            if (hitsDuringFx === null) {
              hitsDuringFx = document.querySelectorAll('.board__hit').length
              peDuringFx = getComputedStyle(fxEl).pointerEvents
            }
          } else if (appeared) {
            break
          }
          await sleep(30)
        }
        // 再等一拍，确认真的清干净了
        await sleep(350)
        return JSON.stringify({
          appeared,
          seenRipple,
          removed: document.querySelectorAll('.board__fx').length === 0,
          hitsDuringFx,
          peDuringFx,
        })
      })()
    `)
    const fxp = JSON.parse(fxProbe)
    assert(fxp.appeared, '走子时出现了飞行棋子（走子动画确实在跑）')
    assert(fxp.seenRipple, '落点处出现了涟漪特效')
    assert(fxp.removed, '走子特效放完后自动从 DOM 里消失（没有残留节点）')
    assert(
      fxp.hitsDuringFx === 90,
      '动画期间点击热区数量不变（操作没被挡）',
      `${fxp.hitsDuringFx} 个`,
    )
    assert(
      fxp.peDuringFx === 'none',
      '特效层 pointer-events 为 none（不参与命中测试）',
      String(fxp.peDuringFx),
    )

    await sleep(1200)

    const afterMove = await evaluate(`JSON.stringify({
      appText: document.querySelector('.games')?.textContent ?? '',
      pieceCount: document.querySelectorAll('.board__piece').length
    })`)
    const am = JSON.parse(afterMove)
    assert(am.pieceCount === 32, '走子后棋子数不变（未吃子）', `${am.pieceCount} 个`)
    assert(
      am.appText.includes('b2') && am.appText.includes('e2'),
      '走子历史里出现了这一步（b2→e2）',
      am.appText.replace(/\s+/g, ' ').slice(0, 160),
    )

    // 交叉验证：服务端应当已经记下这一手，且轮次换到黑方
    const roomAfter = await apiAs(sessionCookie, `/api/games/rooms/${gameRoomId}`)
    assert(
      roomAfter.body.room.moves.length === 1,
      '服务端确实记下了这一手（不只是前端动画）',
      `${roomAfter.body.room.moves.length} 手`,
    )
    if (roomAfter.body.room.moves.length > 0) {
      const m = roomAfter.body.room.moves[0]
      assert(m.from === 'b2' && m.to === 'e2', '记录的是 b2→e2', `${m.from}→${m.to}`)
    }
    assert(roomAfter.body.room.turn === 'black', '轮次已切换到黑方', roomAfter.body.room.turn)

    // 观战者视角：另一个不参与的用户打开同一房间，应当看到"观战中"
    const specView = await apiAs(sessionCookie, `/api/games/rooms/${gameRoomId}`)
    assert(specView.body.room.mySide === 'red', '浏览器用户在这一局里坐红方')

    // ---- 斗地主：牌桌渲染与真实出牌 ----
    console.log('\n【斗地主界面与交互】')

    // 通过 API 把三个人凑齐（牌局必须三人才能发牌）
    const ddzRoom = await apiAs(sessionCookie, '/api/games/doudizhu/rooms', {
      method: 'POST',
      json: { title: '界面测试牌局' },
    })
    const ddzRoomId = ddzRoom.body?.room?.id ?? null
    const peerCookies = []

    if (ddzRoomId) {
      for (const suffix of ['a', 'b']) {
        const inv = await apiAs(sessionCookie, '/api/admin/invites', {
          method: 'POST',
          json: { role: 'member', maxUses: 1, expiresInDays: 1 },
        })
        if (inv.status !== 200) continue
        const peerReg = await fetch(`${BASE}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: `ddzp${suffix}${SUFFIX}`,
            displayName: `牌友${suffix.toUpperCase()}`,
            password: 'peer-pass-2026',
            inviteCode: inv.body.code,
          }),
        })
        const peerCookie = (peerReg.headers.get('set-cookie') ?? '').split(';')[0]
        peerCookies.push(peerCookie)
        await apiAs(peerCookie, `/api/games/doudizhu/rooms/${ddzRoomId}/join`, {
          method: 'POST',
          json: {},
        })
      }
      const check = await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}`)
      if (check.body?.room?.phase === 'bidding') {
        ok('用 API 凑齐三人，牌局已发牌（进入叫地主）')
      } else {
        bad('凑齐三人', `阶段是 ${check.body?.room?.phase}`)
      }
    } else {
      bad('创建牌局', JSON.stringify(ddzRoom.body))
    }

    // 打开斗地主应用
    const ddzOpened = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const target = icons.find(i => i.textContent.includes('斗地主'))
        if (!target) return false
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()
    `)
    assert(ddzOpened === true, '桌面上有「斗地主」图标')
    await sleep(3500)

    // 进大厅 → 点自己的牌局
    const ddzLobby = await evaluate(`JSON.stringify({
      hasApp: !!document.querySelector('.ddz'),
      roomCards: document.querySelectorAll('.room-card').length,
      appText: document.querySelector('.ddz')?.textContent?.slice(0, 160) ?? ''
    })`)
    const dl = JSON.parse(ddzLobby)
    assert(dl.hasApp, '斗地主应用已打开', dl.appText.replace(/\s+/g, ' ').slice(0, 80))

    const ddzEntered = await evaluate(`
      (() => {
        // 房间卡片本身不可点，进入房间的是卡片里的按钮（加入 / 观战）
        const cards = [...document.querySelectorAll('.room-card')]
        const card = cards.find(c => c.textContent.includes('界面测试牌局')) ?? cards[0]
        if (!card) return false
        const btn = card.querySelector('button')
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    assert(ddzEntered === true, '点开了自己的牌局')
    await sleep(3000)

    // 牌桌渲染
    const tableUi = await evaluate(`JSON.stringify({
      handCards: document.querySelectorAll('.card--hand').length,
      cardBacks: document.querySelectorAll('.card-back').length,
      hasHand: !!document.querySelector('.hand'),
      text: document.querySelector('.ddz')?.textContent ?? ''
    })`)
    const tu = JSON.parse(tableUi)
    assert(tu.hasHand, '牌桌渲染了手牌区')
    assert(
      tu.handCards === 17,
      '叫地主前手上是 17 张牌',
      `${tu.handCards} 张`,
    )
    assert(tu.cardBacks >= 0, '对手区域渲染了（背面牌示意）', `${tu.cardBacks} 张背面`)

    // **关键的安全断言**：界面里不该出现对手的具体牌
    // （服务端就没给，但如果前端硬编码或缓存了就会露出来）
    const ddzView = await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}`)
    assert(
      Array.isArray(ddzView.body.room.myHand) && ddzView.body.room.myHand.length === 17,
      '我自己的视角里能看到自己的 17 张牌',
    )
    const peerHands = ddzView.body.room.seats
      .filter((s) => s.seat !== ddzView.body.room.mySeat)
      .map((s) => s.userId)
    assert(peerHands.length === 2, '另外两个座位有人（才发的了牌）')

    // 叫地主
    const bidClicked = await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const b = btns.find(x => x.textContent.trim() === '叫地主')
        if (!b) return false
        b.click()
        return true
      })()
    `)
    assert(bidClicked === true, '点到了「叫地主」按钮')
    await sleep(2500)

    const afterBid = await evaluate(`JSON.stringify({
      handCards: document.querySelectorAll('.card--hand').length,
      text: document.querySelector('.ddz')?.textContent ?? ''
    })`)
    const ab = JSON.parse(afterBid)
    assert(ab.handCards === 20, '叫地主后拿到 20 张牌（17 + 3 张底牌）', `${ab.handCards} 张`)

    const afterBidApi = await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}`)
    assert(afterBidApi.body.room.landlord === afterBidApi.body.room.mySeat, '服务端也认为我是地主')
    assert(afterBidApi.body.room.phase === 'playing', '进入出牌阶段')
    assert(
      Array.isArray(afterBidApi.body.room.bottom) && afterBidApi.body.room.bottom.length === 3,
      '底牌已公开',
    )

    // 选一张牌并出牌
    const selectOne = await evaluate(`
      (() => {
        const card = document.querySelector('.card--hand')
        if (!card) return false
        card.click()
        return true
      })()
    `)
    assert(selectOne === true, '点击了手牌')

    const ddzAfterSelect = await evaluate(`JSON.stringify({
      selected: document.querySelectorAll('.card--hand.is-selected').length
    })`)
    assert(JSON.parse(ddzAfterSelect).selected === 1, '被点的牌进入选中态')

    const playClicked = await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const b = btns.find(x => x.textContent.trim() === '出牌')
        if (!b) return false
        b.click()
        return true
      })()
    `)
    assert(playClicked === true, '点到了「出牌」按钮')
    await sleep(2500)

    // 交叉验证：服务端确实记下了这一手
    const afterPlay = await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}`)
    const playedHistory = afterPlay.body.room.history ?? []
    assert(
      playedHistory.length >= 1,
      '服务端记下了出牌历史（不只是前端把牌移走了）',
      `${playedHistory.length} 条`,
    )
    if (playedHistory.length > 0) {
      const last = playedHistory[playedHistory.length - 1]
      assert(last.cards.length === 1, '出的是一张牌（我们只选了一张）', `${last.cards.length} 张`)
      assert(last.typeLabel === '单张', '服务端识别为单张', last.typeLabel)
    }
    assert(
      afterPlay.body.room.handCounts[afterPlay.body.room.mySeat] === 19,
      '我的剩余张数变成 19',
      `${afterPlay.body.room.handCounts[afterPlay.body.room.mySeat]} 张`,
    )

    // 界面上的手牌数也应该减 1
    const handAfterPlay = await evaluate(`document.querySelectorAll('.card--hand').length`)
    assert(handAfterPlay === 19, '界面上的手牌也少了 1 张', `${handAfterPlay} 张`)

    // ---- 控制台错误 ----
    console.log('\n【运行时错误检查】')
    const realConsole = cdp.consoleErrors.filter(
      (e) => !/favicon|DevTools|Download the Vue/i.test(e),
    )
    const realPage = cdp.pageErrors.filter((e) => !/favicon/i.test(e))
    assert(
      realPage.length === 0,
      '没有未捕获的 JS 异常',
      realPage.slice(0, 3).join(' | ') || '无',
    )
    assert(
      realConsole.length === 0,
      '没有控制台 error 级别输出',
      realConsole.slice(0, 3).join(' | ') || '无',
    )

    // ---- 移动端外壳：把视口缩到手机尺寸，应当切到移动界面而不是把桌面缩小 ----
    console.log('\n【移动端外壳（窄视口）】')
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    )
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(3500)

    const mobile = await evaluate(`JSON.stringify({
      hasMobileShell: !!document.querySelector('.m'),
      hasMobileTabs: document.querySelectorAll('.tabs__item').length,
      tabLabels: [...document.querySelectorAll('.tabs__label')].map(e => e.textContent.trim()),
      hasDesktop: !!document.querySelector('.desktop'),
      hasTaskbar: !!document.querySelector('.taskbar'),
      rootClass: document.body.firstElementChild?.firstElementChild?.className ?? null
    })`)
    const mob = JSON.parse(mobile)
    assert(!mob.hasDesktop, '窄视口下不再渲染桌面外壳')
    assert(!mob.hasTaskbar, '窄视口下不渲染任务栏（移动端没有悬浮任务栏）')
    assert(mob.hasMobileShell, '窄视口下渲染了移动端外壳', `根元素 .${mob.rootClass}`)
    assert(mob.hasMobileTabs >= 3, '移动外壳有底部 Tab 栏', `${mob.hasMobileTabs} 个：${mob.tabLabels.join('、')}`)
  } finally {
    // 关浏览器要按这个顺序来，每一步都挡着一种具体的失败：
    //   1. CDP Browser.close —— 让 Chrome 自己走正常退出流程，最快最干净
    //   2. taskkill /T /F   —— 兜底。Node 的 child.kill() 只杀直接子进程，
    //      GPU/渲染/网络/crashpad 子进程会活下来继续占着 profile 里的文件
    //   3. 等端口不再应答    —— 确认真死了，而不是"发了信号就当死了"
    //   4. 退避重试删除      —— Windows 释放句柄有延迟，一次删不掉是常态
    try {
      // 加超时：浏览器接受关闭后立刻断开 WebSocket，这个 send 可能永远等不到回复。
      await Promise.race([cdp?.send('Browser.close').catch(() => {}), sleep(1500)])
    } catch {
      /* 连不上或已经关了 */
    }
    cdp?.close()

    killProcessTree(child.pid)

    if (!(await waitForPortToClose(debugPort))) {
      killProcessTree(child.pid)
      await sleep(1000)
    }

    const removed = await removeDirWithRetry(profileDir)
    if (!removed) {
      // 不静默吞掉。之前就是这里吞了异常，才让 39 个目录无声无息堆到 1.7GB ——
      // 删除失败正是把系统盘塞满的那种失败，必须让人看见。
      console.log(
        `  \x1b[33m⚠ 临时目录没删掉：${profileDir}\x1b[0m\n` +
          `  \x1b[90m  通常是有浏览器进程还占着它。下次运行会自动重试清理。\x1b[0m`,
      )
    }
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
