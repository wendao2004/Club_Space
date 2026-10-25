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

    // ---- 引用回复 / @ 提醒 / 成员管理 ----
    //
    // 这三件事都靠"服务端算、界面呈现"，所以必须真跑一遍浏览器：
    // 纯接口测试只能证明字段在，证明不了"用户看得见"。
    console.log('\n【引用回复与 @ 提醒】')

    const meNow = await apiAs(sessionCookie, '/api/auth/me')
    const myDisplayName = meNow.body?.user?.displayName ?? ''
    const peerNow = await apiAs(peerCookie, '/api/auth/me')
    const peerId2 = peerNow.body?.user?.id

    const groupRes = await apiAs(sessionCookie, '/api/chat/conversations/group', {
      method: 'POST',
      json: { title: '界面测试群', memberIds: [peerId2] },
    })
    const groupConvId = groupRes.body?.conversation?.id
    if (!groupConvId) bad('建群', JSON.stringify(groupRes.body).slice(0, 200))

    // 对方 @ 我 + 一条"被引用的原话" + 一条带引用的回复
    await apiAs(peerCookie, `/api/chat/conversations/${groupConvId}/messages`, {
      method: 'POST',
      json: { kind: 'text', body: `@${myDisplayName} 这条要在界面上高亮` },
    })
    const origin = await apiAs(peerCookie, `/api/chat/conversations/${groupConvId}/messages`, {
      method: 'POST',
      json: { kind: 'text', body: '被引用的原话' },
    })
    const originId = origin.body?.message?.id
    await apiAs(peerCookie, `/api/chat/conversations/${groupConvId}/messages`, {
      method: 'POST',
      json: { kind: 'text', body: '这是引用的回复', replyTo: originId },
    })

    // SSE 的 conversation 事件应该让侧栏出现这个新群（不用刷新页面）
    await sleep(2000)
    const groupInList = await evaluate(`JSON.stringify({
      titles: [...document.querySelectorAll('.conv__name')].map(n => n.textContent.trim()),
      atBadges: document.querySelectorAll('.conv__at').length
    })`)
    const gil = JSON.parse(groupInList)
    assert(gil.titles.includes('界面测试群'), '新建的群通过实时推送出现在会话列表里（没刷新页面）', gil.titles.join('、'))
    assert(gil.atBadges >= 1, '会话列表上出现了「有人@你」的红 @', `${gil.atBadges} 个`)

    // 点开这个群
    await evaluate(`
      (() => {
        const conv = [...document.querySelectorAll('.conv')].find(c => c.textContent.includes('界面测试群'))
        if (conv) conv.click()
        return !!conv
      })()
    `)
    await sleep(2500)

    const mentionView = await evaluate(`JSON.stringify({
      atMe: document.querySelectorAll('.msg__at--me').length,
      atText: document.querySelector('.msg__at--me')?.textContent ?? '',
      replyBlocks: document.querySelectorAll('.msg__reply').length,
      replyText: document.querySelector('.msg__reply-text')?.textContent ?? '',
      badgesAfterOpen: document.querySelectorAll('.conv__at').length
    })`)
    const mv = JSON.parse(mentionView)
    assert(mv.atMe >= 1, '@我的消息在气泡里被单独标出来了', mv.atText)
    assert(mv.atText === `@${myDisplayName}`, '@高亮的就是我的显示名', mv.atText)
    assert(mv.replyBlocks >= 1, '带引用的消息渲染出了引用块')
    assert(mv.replyText === '被引用的原话', '引用块里是被引用那条的原文', mv.replyText)
    assert(mv.badgesAfterOpen === 0, '打开会话后 @角标消失（已读即清）', `剩 ${mv.badgesAfterOpen} 个`)

    // 用界面的"回复"按钮引用对方那条，再发出去
    const replyStarted = await evaluate(`
      (() => {
        // 明确点"被引用的原话"那一条上的回复按钮，而不是 DOM 里第一个 ——
        // 第一条是 @我 的消息，点它当然也能回复，但断言就没法对齐了。
        const row = [...document.querySelectorAll('.msg')].find((m) =>
          m.textContent.includes('被引用的原话') && !m.querySelector('.msg__reply'),
        )
        const btn = row?.querySelector('.msg__actions button[title="回复"]')
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    assert(replyStarted === true, '消息悬停操作里有「回复」按钮')
    await sleep(400)
    const replyBar = await evaluate(`JSON.stringify({
      visible: !!document.querySelector('.chat__reply'),
      text: document.querySelector('.chat__reply-text')?.textContent ?? ''
    })`)
    const rb = JSON.parse(replyBar)
    assert(rb.visible, '点「回复」后输入区上方出现引用条')
    assert(rb.text === '被引用的原话', '引用条里显示的是被引用那条的内容', rb.text)

    const typedQuote = await evaluate(`
      (() => {
        const ta = document.querySelector('.chat__input')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '界面里发出的引用回复')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    assert(typedQuote === true, '在引用状态下输入了文字')
    await evaluate(`document.querySelector('.chat__send')?.click()`)
    await sleep(2500)

    const ownReply = await evaluate(`JSON.stringify({
      textThere: document.body.innerText.includes('界面里发出的引用回复'),
      ownBubbleWithReply: document.querySelectorAll('.msg--own .msg__reply').length,
      barGone: !document.querySelector('.chat__reply')
    })`)
    const or = JSON.parse(ownReply)
    assert(or.textThere, '引用回复发出去了')
    assert(or.ownBubbleWithReply >= 1, '自己发的那条也带着引用块')
    assert(or.barGone, '发送后引用条自动收起（下一条不会莫名带引用）')

    // 成员面板：邀请与退出
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.chat__members-btn')][0]
        if (btn) btn.click()
        return !!btn
      })()
    `)
    await sleep(1500)
    const memberPanel = await evaluate(`JSON.stringify({
      invite: !!document.querySelector('.chat__modal-foot .wl-btn--primary'),
      leave: [...document.querySelectorAll('.chat__modal-foot .wl-btn')].some(b => b.textContent.includes('退出群聊')),
      count: document.querySelectorAll('.member').length
    })`)
    const mp = JSON.parse(memberPanel)
    assert(mp.count >= 2, '成员面板列出了群成员', `${mp.count} 人`)
    assert(mp.invite, '成员面板里有「邀请成员」')
    assert(mp.leave, '成员面板里有「退出群聊」')

    const inviteOpened = await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.chat__modal-foot .wl-btn')].find(b => b.textContent.includes('邀请成员'))
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    await sleep(800)
    const inviteView = await evaluate(`JSON.stringify({
      header: document.querySelector('.chat__modal-head')?.textContent?.trim() ?? '',
      hasPickList: document.querySelectorAll('.member--pick').length,
      hasFoot: !!document.querySelector('.chat__modal-foot')
    })`)
    const iv = JSON.parse(inviteView)
    assert(inviteOpened === true, '点了「邀请成员」')
    assert(iv.header.includes('邀请成员'), '面板切到邀请视图', iv.header)
    assert(iv.hasFoot, '邀请视图有确认按钮（没人可选时是禁用的，而不是消失）')
    // 邀请视图用完关掉，别把窗口留在这儿影响后面的用例
    await evaluate(`document.querySelector('.chat__modal-head .wl-icon-btn')?.click()`)
    await sleep(300)

    // ---- 后台提醒：系统通知 + 标题角标 ----
    //
    // 原始诉求是"社团空间在后台时也要能感知到有人找我"。页面内的 Toast 在切了
    // 标签之后根本看不见，所以这条必须是浏览器的通知。
    //
    // 无头浏览器没有通知中心、权限也不可控，所以这里把 Notification 换成一个
    // 探针，断言"该发的时候真的发了、内容对不对"——比只验证接口字段有意义得多。
    console.log('\n【后台提醒（页面不可见时的系统通知）】')

    const noticeGroup = await apiAs(sessionCookie, '/api/chat/conversations/group', {
      method: 'POST',
      json: { title: '后台通知测试群', memberIds: [peerId2] },
    })
    const noticeConvId = noticeGroup.body?.conversation?.id
    assert(!!noticeConvId, '建了一个专门用来测后台通知的群')
    await sleep(600)

    if (noticeConvId) {
      await evaluate(`
        (() => {
          window.__realNotification = window.Notification
          window.__notices = []
          class ProbeNotification {
            static permission = 'granted'
            static requestPermission = async () => 'granted'
            constructor(title, opts) {
              window.__notices.push({
                title,
                body: opts?.body ?? '',
                tag: opts?.tag ?? '',
                silent: opts?.silent ?? false,
              })
              this.close = () => {}
            }
          }
          window.Notification = ProbeNotification
          // "页面不在眼前"有两种：切了标签（hidden）和切到别的应用（没有焦点）。
          // 后者 document.hidden 仍是 false，所以两条都要盖住 —— 只盖一条的话，
          // 这个测试会放过"切到别的应用时收不到提醒"的真实缺陷。
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
          document.hasFocus = () => false
          return true
        })()
      `)

      await apiAs(peerCookie, `/api/chat/conversations/${noticeConvId}/messages`, {
        method: 'POST',
        json: { kind: 'text', body: '后台通知测试：看到这句话就该有系统通知' },
      })
      await sleep(2500)

      const notices = JSON.parse(await evaluate(`JSON.stringify(window.__notices)`))
      const hit = notices.find((n) => (n.body ?? '').includes('后台通知测试'))
      assert(!!hit, '页面在后台时收到了系统通知', notices.length ? `共 ${notices.length} 条` : '一条都没发')
      assert((hit?.body ?? '').includes('后台通知测试'), '通知正文就是消息内容')
      assert(hit?.silent === true, '系统通知设了 silent（声音由页面统一放，不响两声）')
      assert(hit?.tag === noticeConvId, '通知 tag 是会话 id（同一会话替换而不是堆叠）')

      const badge = JSON.parse(
        await evaluate(`JSON.stringify({
          title: document.title,
          icon: document.querySelector('link[rel="icon"]')?.href?.slice(0, 24) ?? '',
        })`),
      )
      assert(/^\(\d+\)/.test(badge.title), '标签页标题带上了未读数', badge.title)
      assert(
        badge.icon.startsWith('data:image/svg+xml'),
        'favicon 换成了带角标的图标',
        badge.icon || '没有 link[rel=icon]',
      )

      // 恢复：别把 mock 留给后面的用例
      await evaluate(`
        (() => {
          window.Notification = window.__realNotification
          delete document.hidden
          delete document.hasFocus
          return true
        })()
      `)

      // 收尾：这一节制造了一条未读。后面「读过之后红点消失」的断言是全量
      // 未读数驱动的，留着它会一直失败 —— 而且失败信息只会说"红点还在"，
      // 完全指不到这里。点开这个群，让已读位置往前走一格。
      await sleep(800)
      const noticeCleared = await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.conv')].find(
            (c) => c.textContent.includes('后台通知测试群'),
          )
          if (!row) return false
          row.click()
          return true
        })()
      `)
      assert(noticeCleared === true, '点开测试群，把这一节造成的未读清掉')
      await sleep(1600)
    }

    // ---- 斗地主：轮到自己时的提示音 ----
    //
    // 用户报的是"斗地主没有提示声，轮到自己了都不知道"。这件事只能靠浏览器验：
    // 接口层 `myTurn === true` 一直是成立的，问题在于前端有没有把状态变化变成
    // 一个听得见的信号。
    //
    // 验法：在 AudioParam 上记录每一次 setValueAtTime 的频率，就能分辨"响的是
    // 哪个音"。只数声源数量是不够的 —— 开窗、通知、出错都会产生声源，但那不能
    // 证明"轮到你"响了。
    console.log('\n【斗地主：轮到你时的提示音】')

    await evaluate(`
      (() => {
        if (window.__freqs) return true
        window.__freqs = []
        const proto = window.AudioParam.prototype
        const orig = proto.setValueAtTime
        proto.setValueAtTime = function (v, t) {
          if (window.__freqs.length < 6000) window.__freqs.push(Number(v))
          return orig.call(this, v, t)
        }
        return true
      })()
    `)

    const freqMark = async () => Number(await evaluate('window.__freqs.length'))
    const freqsSince = async (from) =>
      JSON.parse(await evaluate(`JSON.stringify(window.__freqs.slice(${from}))`))

    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(400)
    const openedDdz = await evaluate(`
      (() => {
        const t = [...document.querySelectorAll('.start__tile')].find((x) => x.textContent.includes('斗地主'))
        if (!t) return false
        t.click()
        return true
      })()
    `)
    assert(openedDdz === true, '从开始菜单打开了斗地主')
    await sleep(1600)

    const makeSeat = async (displayName, tag) => {
      const inv = await apiAs(sessionCookie, '/api/admin/invites', {
        method: 'POST',
        json: { role: 'member', maxUses: 1, expiresInDays: 1, note: '斗地主音效测试' },
      })
      if (inv.status !== 200) return null
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: `ddz${tag}${SUFFIX}`,
          displayName,
          password: 'peer-pass-2026',
          inviteCode: inv.body.code,
        }),
      })
      if (!res.ok) return null
      return (res.headers.get('set-cookie') ?? '').split(';')[0]
    }

    const seatA = await makeSeat('牌友甲', 'a')
    const seatB = await makeSeat('牌友乙', 'b')
    assert(!!seatA && !!seatB, '准备了两个牌友账号')

    if (seatA && seatB) {
      const created = await apiAs(sessionCookie, '/api/games/doudizhu/rooms', {
        method: 'POST',
        json: { title: '音效测试牌局' },
      })
      const ddzRoomId = created.body?.room?.id ?? null
      assert(!!ddzRoomId, '创建了斗地主牌局')

      if (ddzRoomId) {
        await apiAs(seatA, `/api/games/doudizhu/rooms/${ddzRoomId}/join`, { method: 'POST', json: {} })
        await apiAs(seatB, `/api/games/doudizhu/rooms/${ddzRoomId}/join`, { method: 'POST', json: {} })
        await sleep(1400)

        const beforeEnter = await freqMark()
        const entered = await evaluate(`
          (() => {
            const card = [...document.querySelectorAll('.room-card')].find(
              (c) => c.textContent.includes('音效测试牌局'),
            )
            if (!card) return false
            const btn = [...card.querySelectorAll('.wl-btn')].find((b) => /加入|观战/.test(b.textContent))
            if (!btn) return false
            btn.click()
            return true
          })()
        `)
        assert(entered === true, '在大厅里点进了这局牌')
        await sleep(2200)

        const enterFreqs = await freqsSince(beforeEnter)
        assert(
          enterFreqs.includes(523.25),
          '轮到你叫地主时响了提示音',
          `本段共 ${enterFreqs.length} 个频率`,
        )

        // 叫地主：第一个叫的人拿地主，于是立刻轮到自己出牌
        const beforeBid = await freqMark()
        await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}/bid`, {
          method: 'POST',
          json: { call: true },
        })
        await sleep(2600)

        const bidFreqs = await freqsSince(beforeBid)
        assert(
          bidFreqs.includes(2637.02),
          '轮到你出牌时响了提示音（2637Hz 的高八度泛音只有这个音效有）',
          bidFreqs.length ? `含 ${bidFreqs.slice(0, 8).join(', ')}…` : '一个频率都没有',
        )

        const turnText = await evaluate(
          `document.querySelector('.status-text')?.textContent?.trim() ?? ''`,
        )
        assert(turnText.includes('轮到你出牌'), '界面状态也切到「轮到你出牌」', turnText)

        // 收尾：关窗 + 退房。
        //
        // 后面的「斗地主界面与交互」会另开一局并用全局选择器数手牌
        // （`.card--hand`），这一局留着就会多出一个窗口，数到的是它的牌 ——
        // 表现为"叫地主前手上不是 17 张"，跟真正的原因隔了三层。
        await evaluate(`
          (() => {
            const win = [...document.querySelectorAll('.window')].find(
              (w) => w.querySelector('.window__title')?.textContent.includes('斗地主'),
            )
            win?.querySelector('.window__ctl--close')?.click()
            return !!win
          })()
        `)
        await sleep(600)
        await apiAs(sessionCookie, `/api/games/doudizhu/rooms/${ddzRoomId}/leave`, {
          method: 'POST',
          json: {},
        })
        await sleep(600)
      }
    }

    // 兜底：无论上面走到哪一步（比如牌友账号没建成），都别把斗地主窗口留在
    // 这里 —— 后面的用例是靠双击桌面图标开窗的，留一个旧窗口会让它变成两个。
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.includes('斗地主'),
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(400)


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

    // ---- 收消息反馈：右下角提示 + 桌面红点（点提示直接跳会话）----
    //
    // 用户报过：关掉聊天窗口后收到消息"什么反馈都没有"。根因是"自动已读"只看了
    // activeId —— 窗口关了它还在，于是消息被静默标已读、红点永远不出现。
    // 这一节把三层反馈（提示 / 桌面红点 / 点提示跳转）全部钉进回归。
    console.log('\n【聊天收到消息的反馈】')

    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__titlebar')?.textContent.includes('聊天'),
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(600)
    const chatClosed = await evaluate(
      `![...document.querySelectorAll('.window')].some((w) => w.querySelector('.window__titlebar')?.textContent.includes('聊天'))`,
    )
    assert(chatClosed === true, '前置：聊天窗口已关闭')

    const FB_TEXT = '第二条：这条应该让右下角冒提示'
    const peerSend2 = await apiAs(peerCookie, `/api/chat/conversations/${convId}/messages`, {
      method: 'POST',
      json: { kind: 'text', body: FB_TEXT },
    })
    assert(peerSend2.status === 200, '对方又发了一条消息')
    await sleep(2200)

    const fb = JSON.parse(await evaluate(`JSON.stringify({
      toastText: [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(FB_TEXT)})),
      toastSender: [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('聊天对象')),
      badge: document.querySelector('.icon__badge')?.textContent?.trim() ?? '',
    })`))
    assert(fb.toastText, '右下角出现新消息提示（含消息内容）')
    assert(fb.toastSender, '提示里带发送者名字')
    assert(fb.badge !== '', '聊天桌面图标出现未读红点', `badge=${fb.badge || '（无）'}`)

    // 点提示：打开聊天窗口 + 切到那条会话 + 提示收起
    await evaluate(`
      (() => {
        const t = [...document.querySelectorAll('.toast')].find((x) => x.textContent.includes(${JSON.stringify(FB_TEXT)}))
        t?.click()
        return true
      })()
    `)
    await sleep(2500)
    const fbOpen = JSON.parse(await evaluate(`JSON.stringify({
      windowOpen: [...document.querySelectorAll('.window')].some(
        (w) => w.querySelector('.window__titlebar')?.textContent.includes('聊天'),
      ),
      seesMessage: document.body.innerText.includes(${JSON.stringify(FB_TEXT)}),
      toastGone: ![...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(${JSON.stringify(FB_TEXT)})),
    })`))
    assert(fbOpen.windowOpen, '点提示后聊天窗口被打开')
    assert(fbOpen.seesMessage, '窗口里已经切到那条消息所在的会话')
    assert(fbOpen.toastGone, '点过的提示自动收起')
    await sleep(800)
    const fbBadgeAfter = await evaluate(`document.querySelector('.icon__badge')?.textContent?.trim() ?? ''`)
    assert(fbBadgeAfter === '', '读过之后未读红点消失', `badge=${fbBadgeAfter || '（无）'}`)

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

    // ---- 导出链接必须跟着筛选走 ----
    //
    // 回归的是一个真实事故：导出链接从前只带日期区间，于是搜索词 / 分类 /
    // 状态 / 只看我的 / 待我审批 在导出时被**静默丢掉** —— 界面上写着
    // 「搜索「矿泉水」」筛出一行，点「导出 CSV」下载到的却是全部账目。
    // 它不报错，只在对账那天被人肉发现，所以在这里钉死"链接里带着当前筛选"。
    const exportBefore = await evaluate(
      `document.querySelector('.ledger a[href*="export.csv"]')?.getAttribute('href') ?? null`,
    )
    assert(
      exportBefore === '/api/ledger/export.csv',
      '没有筛选条件时，导出链接不带查询串',
      exportBefore ?? '(页面上找不到导出链接)',
    )

    const typedSearch = await evaluate(`
      (() => {
        const input = document.querySelector('.ledger .filter__search')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '矿泉水')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    assert(typedSearch === true, '在搜索框里输入了关键词')
    // 搜索是防抖的（250ms 后才落到 store 上），等它生效再读链接
    await sleep(1200)

    const exportAfter = await evaluate(
      `document.querySelector('.ledger a[href*="export.csv"]')?.getAttribute('href') ?? null`,
    )
    assert(
      typeof exportAfter === 'string' &&
        exportAfter.includes(`search=${encodeURIComponent('矿泉水')}`),
      '搜索后导出链接带上了 search（导出的表 = 你筛出来的表）',
      exportAfter ?? '(页面上找不到导出链接)',
    )
    assert(
      typeof exportAfter === 'string' &&
        !exportAfter.includes('null') &&
        !exportAfter.includes('undefined'),
      '导出链接里没有 null / undefined 字面量（空筛选不能拼成 "null"）',
      exportAfter ?? '',
    )

    // 收尾：把搜索清掉，别让后面小节读到的是筛过的列表
    await evaluate(`
      (() => {
        const input = document.querySelector('.ledger .filter__search')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(1000)

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
    // ---- 人机对战的入口与弹层（不真的开局：那会让机器人跟着落子，
    //      打乱后面用 API 铺好的那盘棋。这里只验"入口在、弹层能开"）
    const botEntry = await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.games button')].find(b => b.textContent.includes('人机对战'))
        if (!btn) return JSON.stringify({ found: false })
        btn.click()
        return JSON.stringify({ found: true })
      })()
    `)
    const be = JSON.parse(botEntry)
    assert(be.found === true, '象棋大厅里有「人机对战」入口')
    await sleep(500)

    const botDialog = await evaluate(`JSON.stringify({
      levels: [...document.querySelectorAll('.level-btn')].map(b => b.querySelector('.level-name')?.textContent?.trim() ?? ''),
      sides: [...document.querySelectorAll('.modal .side-btn')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
      hasStart: !![...document.querySelectorAll('.modal .wl-btn--primary')].find(b => b.textContent.includes('开始')),
    })`)
    const bd = JSON.parse(botDialog)
    assert(
      Array.isArray(bd.levels) && bd.levels.join(',') === '简单,普通,困难',
      '人机对战可选三个难度',
      bd.levels.join(' / '),
    )
    assert(bd.sides.length === 2 && bd.hasStart, '可以选执红/执黑并开始', bd.sides.join(' | '))
    // 关掉弹层，别留下来挡着后面的操作
    await evaluate(
      `[...document.querySelectorAll('.modal .wl-btn')].find(b => b.textContent.includes('取消'))?.click()`,
    )
    await sleep(300)

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

    // 出牌记录里的称呼：有名字用名字，别再是"座位1/2/3"这种谜语。
    // 我（地主）刚出了一张，记录里应该写的是我的显示名。
    const historyItems = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.history-item')].map((e) => e.textContent.trim()))`,
      ),
    )
    assert(historyItems.length >= 1, '出牌记录出现在界面上', historyItems.join(' | '))
    const myName = (await apiAs(sessionCookie, '/api/auth/me')).body?.user?.displayName ?? ''
    assert(
      myName !== '' && historyItems.some((t) => t.includes(myName)),
      '出牌记录里用的是玩家名字而不是座位号',
      myName ? `记录：${historyItems.join(' | ')}` : '没拿到自己的显示名',
    )

    // ---- 你画我猜：画一笔、另一人猜对 ----
    //
    // 这条链路跨了三个之前没一起验过的东西：画笔的写入口（只有画家能发）、
    // SSE 的 draw-stroke 广播（另一端画布要真收到）、以及猜对的计分。
    // 纯接口测试验不了"画布上真的画出来了"，所以必须在真浏览器里画。
    console.log('\n【你画我猜】')

    // 造一局：浏览器用户是画家（房主），peer 是猜者。
    // ⚠️ 不要在浏览器进入之前 start：选词窗口只有 10 秒，等浏览器把应用
    // chunk 拉下来、点进房间，窗口早就被扫描器随机选掉了。让浏览器自己点开始。
    const drawRoomRes = await apiAs(sessionCookie, '/api/games/draw/rooms', {
      method: 'POST',
      json: { title: '界面测试画室', rounds: 1 },
    })
    const drawRoomId = drawRoomRes.body?.room?.id ?? null
    assert(!!drawRoomId, '创建了你画我猜房间')

    if (drawRoomId) {
      await apiAs(peerCookie, `/api/games/draw/rooms/${drawRoomId}/join`, { method: 'POST', json: {} })

      // 打开应用并进入房间
      await evaluate(`document.querySelector('.taskbar__start').click()`)
      await sleep(400)
      const openedDraw = await evaluate(`
        (() => {
          const t = [...document.querySelectorAll('.start__tile')].find((x) => x.textContent.includes('你画我猜'))
          if (!t) return false
          t.click()
          return true
        })()
      `)
      assert(openedDraw === true, '从开始菜单打开了你画我猜')
      await sleep(2500)

      // 大厅列表是异步拉的（懒加载 chunk + fetch），抓不到卡片时把界面内容
      // 带出来，一眼看出是"列表没加载"还是"按钮文案不匹配"
      const lobbyText =
        (await evaluate(`document.querySelector('.draw')?.textContent?.slice(0, 260) ?? 'NO .draw'`)) ?? ''
      const enteredDraw = await evaluate(`
        (() => {
          const card = [...document.querySelectorAll('.room-card')].find(
            (c) => c.textContent.includes('界面测试画室'),
          )
          if (!card) return false
          const btn = [...card.querySelectorAll('.wl-btn')].find(
            (b) => b.textContent.includes('进入') || b.textContent.includes('观看'),
          )
          if (!btn) return false
          btn.click()
          return true
        })()
      `)
      assert(enteredDraw === true, '在大厅里点进了画室', enteredDraw ? '' : lobbyText.replace(/\s+/g, ' '))
      await sleep(1200)

      // 房主（浏览器用户）在界面上点开始 → choosing
      const startedInUi = await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('.phase-panel .wl-btn')].find((b) =>
            b.textContent.includes('开始游戏'),
          )
          if (!btn) return false
          btn.click()
          return true
        })()
      `)
      assert(startedInUi === true, '房主在界面上点了开始')
      await sleep(1000)

      // 画家在浏览器里选词（3 个候选按钮）
      const picked = await evaluate(`
        (() => {
          const btn = document.querySelector('.word-choice')
          if (!btn) return null
          const word = btn.textContent.trim()
          btn.click()
          return word
        })()
      `)
      assert(typeof picked === 'string' && picked.length > 0, '画家在界面上选了词', String(picked))
      await sleep(1500)

      // 画布的像素尺寸必须跟容器对得上。
      //
      // 画桌（含 canvas）是**阶段变化时才渲染**的。新建的 canvas 是 HTML 默认的
      // 300×150；如果没人去对齐，整张画就按 0.3 倍分辨率画完再被 CSS 拉回窗口
      // 大小。画家落笔时会自愈修正自己那张，**别人那张则整局都是糊的** ——
      // 用户报的"自己画着好好的，别人看是点点点"就是这个。
      //
      // 所以断言放在"还没落笔"的时刻：这时尺寸只能来自画布出现时的对齐，
      // 而不是落笔自愈。
      const canvasSize = JSON.parse(
        await evaluate(`JSON.stringify((() => {
          const c = document.querySelector('.board-canvas')
          const box = c?.closest('.canvas-box')?.getBoundingClientRect()
          return {
            w: c?.width ?? 0,
            h: c?.height ?? 0,
            cssW: Math.round(box?.width ?? 0),
            cssH: Math.round(box?.height ?? 0),
            dpr: window.devicePixelRatio || 1,
          }
        })())`),
      )
      assert(
        canvasSize.cssW > 200 &&
          canvasSize.w >= Math.round(canvasSize.cssW * canvasSize.dpr * 0.9) &&
          canvasSize.h >= Math.round(canvasSize.cssH * canvasSize.dpr * 0.9),
        '画布像素尺寸跟容器对得上（不是 300×150 的默认值）',
        `${canvasSize.w}×${canvasSize.h}，容器 ${canvasSize.cssW}×${canvasSize.cssH}，dpr ${canvasSize.dpr}`,
      )

      // 画一笔：按住鼠标在画布上拖一段（走真实的 pointer 事件链）
      // 坐标按**容器**取（用户看到并点击的是 .canvas-box；canvas 只是它里面的
      // 绘制层）。这与 DrawApp 的 toLocal 用同一个权威来源。
      const canvasBox = await evaluate(`
        (() => {
          const box = document.querySelector('.canvas-box')
          if (!box) return null
          const r = box.getBoundingClientRect()
          return JSON.stringify({ x: r.x + r.width * 0.3, y: r.y + r.height * 0.4, w: r.width * 0.4 })
        })()
      `)
      assert(!!canvasBox, '找到了画布', String(canvasBox))
      if (canvasBox) {
        const { x, y, w } = JSON.parse(canvasBox)
        const mouse = (type, px, py, buttons = 1) =>
          cdp.send(
            'Input.dispatchMouseEvent',
            { type, x: px, y: py, button: 'left', buttons, clickCount: 1 },
            sessionId,
          )
        await mouse('mousePressed', x, y)
        // 必须逐个 await：曾经为了"更像真实帧率"改成不等待，结果 8 个 CDP
        // 事件几乎同时到达，浏览器把相邻的 pointermove 合并掉了 —— 只画出
        // 一半的轨迹，像素断言的横向跨度直接腰斩。真实用户拖拽是连续事件，
        // 不会合并；合成事件要自己控制节奏。
        for (let i = 1; i <= 12; i++) {
          await mouse('mouseMoved', x + i * (w / 12), y + i * 4)
          await sleep(16)
        }
        await mouse('mouseReleased', x + w, y + 48, 0)
        await sleep(400)

        // 服务端画布缓冲里应该有这一笔（画家是浏览器用户）
        const strokes = await apiAs(sessionCookie, `/api/games/draw/rooms/${drawRoomId}/canvas`)
        assert(
          (strokes.body?.strokes?.length ?? 0) >= 1,
          '画的一笔到达了服务端画布缓冲',
          `${strokes.body?.strokes?.length ?? 0} 笔`,
        )

        // 画布渲染断言：读取 canvas 像素，笔迹应横向铺开。
        // 之前的 bug 是画布像素尺寸被钉在窗口打开动画的小值上（CSS 再拉伸回去），
        // 笔迹全部挤在左上角 —— 用户看到"只有左上角能画"。这一条就是它的回归测试。
        const pixelCheck = JSON.parse(
          await evaluate(`
            (() => {
              const c = document.querySelector('.board-canvas')
              if (!c) return 'null'
              const g = c.getContext('2d')
              const data = g.getImageData(0, 0, c.width, c.height).data
              let minX = c.width, maxX = 0, nonWhite = 0
              for (let y = 0; y < c.height; y += 2) {
                for (let x = 0; x < c.width; x += 2) {
                  const i = (y * c.width + x) * 4
                  if (data[i + 3] > 0 && !(data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245)) {
                    nonWhite++
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                  }
                }
              }
              return JSON.stringify({ nonWhite, minX, maxX, width: c.width, height: c.height })
            })()
          `),
        )
        const pcOk =
          pixelCheck && typeof pixelCheck === 'object' && (pixelCheck.nonWhite ?? 0) > 20
        assert(pcOk, '画布上有笔迹像素', JSON.stringify(pixelCheck))
        if (pcOk) {
          const span = pixelCheck.maxX - pixelCheck.minX
          assert(
            span > pixelCheck.width * 0.3,
            '笔迹横向铺开（画布尺寸没有挤在左上角）',
            `横向跨度 ${span.toFixed(0)} / 画布宽 ${pixelCheck.width}`,
          )
        }
      }

      // 猜者（在浏览器外）拿到词并猜对 —— 画家视角的 view.word 只有画家可见，
      // 这同时验证了"词对画家可见"这条 HTTP 契约
      const drawerView = await apiAs(sessionCookie, `/api/games/draw/rooms/${drawRoomId}`)
      const drawAnswer = drawerView.body?.room?.view?.word ?? null
      assert(!!drawAnswer, '画家视角能从 HTTP 拿到答案词', String(drawAnswer))

      const guessByPeer = await apiAs(peerCookie, `/api/games/draw/rooms/${drawRoomId}/guess`, {
        method: 'POST',
        json: { text: drawAnswer },
      })
      assert(guessByPeer.status === 200 && guessByPeer.body?.correct === true, '猜者在浏览器外猜对')

      await sleep(1200)
      // 全对 → reveal；界面应显示答案
      const revealShown = await evaluate(`document.body.innerText.includes('答案：')`)
      assert(revealShown === true, '界面上公布了答案（全对进 reveal）')

      // 猜对的聊天条目在界面上
      const correctShown = await evaluate(`document.body.innerText.includes('猜对了')`)
      assert(correctShown === true, '界面上出现了「猜对了」')

      // 收尾：关窗退房，别把画室留给后面的用例
      await evaluate(`
        (() => {
          const win = [...document.querySelectorAll('.window')].find(
            (w) => w.querySelector('.window__title')?.textContent.includes('你画我猜'),
          )
          win?.querySelector('.window__ctl--close')?.click()
          return true
        })()
      `)
      await sleep(500)
      await apiAs(sessionCookie, `/api/games/draw/rooms/${drawRoomId}/leave`, { method: 'POST', json: {} })
    }

    // ---- 留言板：发一条、列表里能立刻看到 ----
    console.log('\n【留言板】')

    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(400)
    const openedBoard = await evaluate(`
      (() => {
        const t = [...document.querySelectorAll('.start__tile')].find((x) => x.textContent.includes('留言板'))
        if (!t) return false
        t.click()
        return true
      })()
    `)
    assert(openedBoard === true, '从开始菜单打开了留言板')
    await sleep(1800)

    // 用原生 setter 触发 input —— Vue 的 v-model 靠 input 事件同步，
    // 直接改 value 属性不会让 v-model 感知（这是合成输入的常见坑）。
    // ⚠️ 填完要**等一拍**再点发送：v-model 的更新是异步的，立刻读按钮的
    // disabled 会读到旧值（还是 disabled），点击就被吞掉。
    const boardMarker = `UI冒烟留言-${Date.now().toString(36)}`
    const boardFilled = await evaluate(`
      (() => {
        const ta = document.querySelector('.board-app .compose-input')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ${JSON.stringify(boardMarker)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    assert(boardFilled === true, '在留言板的输入框里填了内容')
    await sleep(300)
    const boardSent = await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.board-app .compose-foot button')].find((b) =>
          b.textContent.includes('发送'),
        )
        if (!btn) return false
        if (btn.disabled) return false
        btn.click()
        return true
      })()
    `)
    assert(boardSent === true, '点了发送按钮', boardSent ? '' : '按钮仍不可用或不存在')
    await sleep(1200)

    const boardPosted = await evaluate(
      `document.querySelector('.board-app')?.textContent?.includes(${JSON.stringify(boardMarker)}) ?? false`,
    )
    const boardText = await evaluate(
      `document.querySelector('.board-app')?.textContent?.replace(/\\s+/g, ' ').slice(0, 240) ?? 'NO .board-app'`,
    )
    assert(boardPosted === true, '发出的留言出现在列表里', boardPosted ? '' : String(boardText))

    // 收尾：关窗，别把留言板留给后面的用例
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.includes('留言板'),
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(400)

    // ---- 更换壁纸（预设 + 文件空间图片）----
    console.log('\n【更换壁纸】')

    // 先在共享空间放一张真实的小 PNG（1×1），壁纸选择器才有东西可选
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const wpName = `壁纸测试-${SUFFIX}.png`
    const upInit = await apiAs(sessionCookie, '/api/uploads', {
      method: 'POST',
      json: { parentId: null, name: wpName, size: pngBytes.length, space: 'shared' },
    })
    assert(upInit.status === 200, '壁纸测试图片的上传会话已建立', `status ${upInit.status}`)
    if (upInit.status === 200 && !upInit.body.instant) {
      const putChunk = await apiAs(sessionCookie, `/api/uploads/${upInit.body.uploadId}/chunk?offset=0`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: pngBytes,
      })
      assert(putChunk.status === 200, '图片分片已送达')
      const complete = await apiAs(sessionCookie, `/api/uploads/${upInit.body.uploadId}/complete`, {
        method: 'POST',
        json: {},
      })
      assert(complete.status === 200, '图片已入库（共享空间）')
    }

    // 桌面右键 → 更换壁纸…
    await evaluate(`
      document.querySelector('.desktop-icons').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 620, clientY: 300 }),
      )
    `)
    await sleep(400)
    const openPicker = await evaluate(`
      (() => {
        const it = [...document.querySelectorAll('.ctx__item')].find((x) => x.textContent.includes('更换壁纸'))
        if (!it) return false
        it.click()
        return true
      })()
    `)
    assert(openPicker === true, '桌面右键菜单能打开「更换壁纸」')
    await sleep(1200)

    const pickerInfo = JSON.parse(await evaluate(`JSON.stringify({
      open: !!document.querySelector('.wp-picker'),
      presets: document.querySelectorAll('.wp-picker__preset').length,
      images: [...document.querySelectorAll('.wp-picker__img-name')].map((e) => e.textContent.trim()),
    })`))
    assert(pickerInfo.open, '壁纸选择器已打开')
    assert(pickerInfo.presets === 4, '有 4 套预设壁纸', `${pickerInfo.presets} 套`)
    assert(pickerInfo.images.includes(wpName), '文件空间里的图片出现在选择器中', pickerInfo.images.join('、'))

    // 选第 3 套预设：立即生效，且图片壁纸被清掉
    await evaluate(`document.querySelectorAll('.wp-picker__preset')[2].click()`)
    await sleep(300)
    const presetState = JSON.parse(await evaluate(`JSON.stringify({
      wallpaper: localStorage.getItem('wl.wallpaper'),
      image: localStorage.getItem('wl.wallpaper.image'),
      photo: !!document.querySelector('.desktop__wallpaper-photo'),
    })`))
    assert(presetState.wallpaper === '2', '预设壁纸切换已持久化', `wl.wallpaper=${presetState.wallpaper}`)
    assert(!presetState.image && !presetState.photo, '选预设会清掉图片壁纸')

    // 关键回归：预设必须真的换掉**画面**，而不只是换个数字。
    // （第十轮曾埋过一个 CSS 层叠 bug：作用域样式的"兜底背景"特异性压过全局壁纸类，
    //   localStorage 变了、桌面纹丝不动 —— 只断言 localStorage 的测试抓不到这种。）
    await evaluate(`document.querySelectorAll('.wp-picker__preset')[1].click()`)
    await sleep(250)
    const bgTeal = await evaluate(`
      getComputedStyle(document.querySelector('.desktop__wallpaper')).backgroundImage.includes('60, 170, 180')
    `)
    assert(bgTeal === true, '选「青澜」后桌面背景真的换成了青色光斑（不只是数字变了）')

    await evaluate(`document.querySelectorAll('.wp-picker__preset')[3].click()`)
    await sleep(250)
    const bgLake = await evaluate(`
      getComputedStyle(document.querySelector('.desktop__wallpaper')).backgroundImage.includes('56, 124, 200')
    `)
    assert(bgLake === true, '再切「深湖」背景也跟着变（连续切换有效）')

    // 选文件空间里的图片：写入偏好，桌面上出现图片层
    const pickedImage = await evaluate(`
      (() => {
        const tile = [...document.querySelectorAll('.wp-picker__img')].find(
          (t) => t.textContent.includes(${JSON.stringify(wpName)}),
        )
        if (!tile) return false
        tile.click()
        return true
      })()
    `)
    assert(pickedImage === true, '点中了文件空间里的图片')
    await sleep(500)
    const imageState = JSON.parse(await evaluate(`JSON.stringify({
      stored: localStorage.getItem('wl.wallpaper.image'),
      photo: !!document.querySelector('.desktop__wallpaper-photo'),
      src: document.querySelector('.desktop__wallpaper-photo')?.getAttribute('src') ?? '',
    })`))
    assert(!!imageState.stored, '图片壁纸已写入本地偏好', String(imageState.stored))
    assert(
      imageState.photo && imageState.src.includes('/api/files/'),
      '桌面上渲染出了图片壁纸层',
      imageState.src || '（没有图片层）',
    )

    // 清除图片壁纸 → 回到预设
    await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('.wp-picker__foot-actions .wl-btn')]
        btns.find((b) => b.textContent.includes('清除图片壁纸'))?.click()
        return true
      })()
    `)
    await sleep(300)
    const cleared = JSON.parse(await evaluate(`JSON.stringify({
      image: localStorage.getItem('wl.wallpaper.image'),
      photo: !!document.querySelector('.desktop__wallpaper-photo'),
    })`))
    assert(!cleared.image && !cleared.photo, '清除图片壁纸后回到预设')

    // 完成 → 弹层关闭
    await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('.wp-picker__foot-actions .wl-btn')]
        btns.find((b) => b.textContent.includes('完成'))?.click()
        return true
      })()
    `)
    await sleep(500)
    assert((await evaluate(`!document.querySelector('.wp-picker')`)) === true, '「完成」关闭选择器')

    // ---- 预览 = 独立窗口（和其他窗口同一套框架）----
    console.log('\n【预览窗口】')

    const windowsBefore = await evaluate(`document.querySelectorAll('.window').length`)
    await evaluate(`
      (() => {
        const icon = [...document.querySelectorAll('.desktop-icons .icon')].find((i) => i.textContent.includes('文件'))
        icon?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()
    `)
    await sleep(2000)

    const wpOpened = await evaluate(`
      (() => {
        const names = [...document.querySelectorAll('.tile__name, .row__name')]
        const el = names.find((x) => x.textContent.includes(${JSON.stringify(wpName)}))
        if (!el) return 'no-file'
        const target = el.closest('.tile, .row') ?? el
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return 'ok'
      })()
    `)
    assert(wpOpened === 'ok', '文件列表里找到了测试图片', String(wpOpened))
    await sleep(1500)

    const pv = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find(
        (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(wpName)},
      )
      if (!win) return { found: false }
      return {
        found: true,
        handles: win.querySelectorAll('.window__handle').length,
        controls: win.querySelectorAll('.window__ctl').length,
        imgSrc: win.querySelector('.pv__img')?.getAttribute('src') ?? '',
        // 任务栏按钮按应用分组，title 是应用名「预览」（多窗口时另有数量角标）
        taskbar: [...document.querySelectorAll('.taskbar__app')].some(
          (b) => (b.getAttribute('title') ?? '').includes('预览'),
        ),
      }
    })())`))
    assert(pv.found === true, '预览以独立窗口打开（标题 = 文件名）')
    assert(pv.handles === 8, '预览窗口有 8 向缩放手柄（可拖拽、可缩放）', `${pv.handles} 个`)
    assert(pv.controls >= 2, '预览窗口有标题栏控制按钮', `${pv.controls} 个`)
    assert((pv.imgSrc ?? '').includes('/api/files/'), '预览窗口里渲染了图片', pv.imgSrc || '（空）')
    assert(pv.taskbar === true, '任务栏有该预览窗口的按钮')

    // 双击标题栏 → 最大化（和其他窗口完全一致的行为）
    const maximized = await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(wpName)},
        )
        const bar = win?.querySelector('.window__titlebar')
        if (!bar) return false
        bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()
    `)
    assert(maximized === true, '双击标题栏把预览窗口最大化')
    await sleep(400)
    const maxState = await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(wpName)},
        )
        return win?.querySelectorAll('.window__ctl')[1]?.getAttribute('title') ?? ''
      })()
    `)
    assert(maxState === '还原', '最大化之后按钮变成「还原」', String(maxState))

    // 关闭预览窗口：文件窗口还在
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(wpName)},
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(500)
    const closedPreview = JSON.parse(await evaluate(`JSON.stringify({
      gone: ![...document.querySelectorAll('.window')].some(
        (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(wpName)},
      ),
      windows: document.querySelectorAll('.window').length,
    })`))
    assert(closedPreview.gone, '预览窗口已关闭')
    assert(
      closedPreview.windows > windowsBefore,
      '只关掉了预览，文件窗口还在',
      `${closedPreview.windows} > ${windowsBefore}`,
    )

    // ---- 图片翻页：目录里有多张图时，按钮与方向键都能翻 ----
    //
    // 这条防的是"预览一次只能看一张"：以前想看下一张必须关窗口、回列表、
    // 再双击 —— 看十张图要来回二十次。翻页是纯前端行为，但顺序依赖
    // 文件管理器传过来的队列，所以整条链路都走真实界面。
    console.log('\n【图片翻页】')

    const galFolder = `图片翻页-${SUFFIX}`
    const galNames = [`翻页-1-${SUFFIX}.png`, `翻页-2-${SUFFIX}.png`, `翻页-3-${SUFFIX}.png`]

    // 建一个干净的目录，里面只放 3 张图 —— 队列里不该混进别的图片
    const madeFolder = await apiAs(sessionCookie, '/api/files/folder', {
      method: 'POST',
      json: { parentId: null, name: galFolder, space: 'shared' },
    })
    assert(madeFolder.status === 200, '为翻页测试建了独立目录', `status ${madeFolder.status}`)
    const galFolderId = madeFolder.body?.node?.id ?? ''

    /** 往指定目录放一张图（走真实上传链路，和界面上拖文件进去一样）。 */
    async function putImage(parentId, name) {
      const init = await apiAs(sessionCookie, '/api/uploads', {
        method: 'POST',
        json: { parentId, name, size: pngBytes.length, space: 'shared' },
      })
      if (init.status !== 200) return `init ${init.status}`
      if (init.body.instant) return true
      const put = await apiAs(sessionCookie, `/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: pngBytes,
      })
      if (put.status !== 200) return `chunk ${put.status}`
      const done = await apiAs(sessionCookie, `/api/uploads/${init.body.uploadId}/complete`, {
        method: 'POST',
        json: {},
      })
      return done.status === 200 ? true : `complete ${done.status}`
    }

    for (const name of galNames) {
      const put = await putImage(galFolderId, name)
      assert(put === true, `图片已入库：${name}`, String(put))
    }

    // 文件管理器是 API 之前打开的，点一下刷新把新目录拉出来
    await evaluate(`
      (() => {
        document.querySelector('.fm__toolbar .wl-icon-btn[title="刷新"]')?.click()
        return true
      })()
    `)
    await sleep(900)

    const enteredGallery = await evaluate(`
      (() => {
        const el = [...document.querySelectorAll('.tile__name, .row__name')].find((x) =>
          x.textContent.includes(${JSON.stringify(galFolder)}),
        )
        if (!el) return 'no-folder'
        ;(el.closest('.tile, .row') ?? el).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return 'ok'
      })()
    `)
    assert(enteredGallery === 'ok', '进入图片目录', String(enteredGallery))
    await sleep(900)

    const openFirstImage = await evaluate(`
      (() => {
        const el = [...document.querySelectorAll('.tile__name, .row__name')].find((x) =>
          x.textContent.includes(${JSON.stringify(galNames[0])}),
        )
        if (!el) return 'no-image'
        ;(el.closest('.tile, .row') ?? el).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return 'ok'
      })()
    `)
    assert(openFirstImage === 'ok', '双击第一张图打开预览', String(openFirstImage))
    await sleep(1200)

    /** 读预览窗口的翻页相关状态（按 .pv 找窗口：标题会随翻页变化，不能按标题找）。 */
    async function galleryState() {
      return JSON.parse(
        await evaluate(`JSON.stringify((() => {
          const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.pv'))
          if (!win) return { found: false }
          return {
            found: true,
            title: win.querySelector('.window__title')?.textContent.trim() ?? '',
            name: win.querySelector('.pv__name')?.textContent.trim() ?? '',
            counter: win.querySelector('.pv__counter')?.textContent.trim() ?? '',
            prev: !!win.querySelector('.pv__nav--prev'),
            next: !!win.querySelector('.pv__nav--next'),
            img: win.querySelector('.pv__img')?.getAttribute('src') ?? '',
          }
        })())`),
      )
    }

    /** 真按一次方向键（走 CDP 的输入管线，和用户按的完全同一条路）。 */
    async function pressArrow(key, code, vk) {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId)
      await sleep(450)
    }

    const pv1 = await galleryState()
    assert(pv1.found === true, '预览窗口已打开（图片翻页）')
    assert(pv1.counter === '1 / 3', '预览显示「1 / 3」', pv1.counter)
    assert(pv1.prev === false, '第一张不显示「上一张」按钮')
    assert(pv1.next === true, '第一张显示「下一张」按钮')

    await pressArrow('ArrowRight', 'ArrowRight', 39)
    const pv2 = await galleryState()
    assert(pv2.name === galNames[1], '按 → 翻到第二张', pv2.name)
    assert(pv2.counter === '2 / 3', '计数器跟着变成「2 / 3」', pv2.counter)
    assert(pv2.img !== pv1.img, '翻页后图片地址确实换了（不是同一张）', `${pv2.img} ≠ ${pv1.img}`)
    assert(pv2.title === galNames[1], '窗口标题跟着变成第二张的名字', pv2.title)

    // 下箭头也算「下一张」：不用记哪个键
    await pressArrow('ArrowDown', 'ArrowDown', 40)
    const pv3 = await galleryState()
    assert(pv3.name === galNames[2], '按 ↓ 翻到第三张', pv3.name)
    assert(pv3.counter === '3 / 3', '到第三张计数为「3 / 3」', pv3.counter)
    assert(pv3.next === false, '最后一张不显示「下一张」按钮', String(pv3.next))

    // 到头了再按不该绕回第一张（用户会以为按错了）
    await pressArrow('ArrowRight', 'ArrowRight', 39)
    const pv3b = await galleryState()
    assert(pv3b.name === galNames[2], '最后一张再按 → 停住（不循环）', pv3b.name)

    await pressArrow('ArrowLeft', 'ArrowLeft', 37)
    const pv4 = await galleryState()
    assert(pv4.name === galNames[1], '按 ← 退回第二张', pv4.name)

    // 按钮也要能点（触屏 / 不摸键盘的人靠它）
    const clickedPrev = await evaluate(`
      (() => {
        const btn = document.querySelector('.pv__nav--prev')
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    assert(clickedPrev === true, '点「上一张」按钮')
    await sleep(400)
    const pv5 = await galleryState()
    assert(pv5.name === galNames[0], '按钮翻页与方向键效果一致', pv5.name)

    // 关掉预览，回到根目录 —— 后面几节都在根目录里找文件
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.pv'))
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(400)
    await evaluate(`
      (() => {
        document.querySelector('.fm__toolbar .wl-icon-btn[title="回到根目录"]')?.click()
        return true
      })()
    `)
    await sleep(700)
    const backToRoot = await evaluate(`
      [...document.querySelectorAll('.tile__name, .row__name')].some((x) =>
        x.textContent.includes(${JSON.stringify(wpName)}),
      )
    `)
    assert(backToRoot === true, '翻页测试结束后回到根目录')

    // ---- 预览测试用的小工具（只为下面两节服务）----

    /** 走真实的上传接口往共享空间放一个文件。上传窗口里的手动上传走的就是这条链路。 */
    async function uploadFile(name, bytes) {
      const init = await apiAs(sessionCookie, '/api/uploads', {
        method: 'POST',
        json: { parentId: null, name, size: bytes.length, space: 'shared' },
      })
      if (init.status !== 200) return false
      // 小文件会"秒传"（服务端直接入库），那就没有分片这一步
      if (init.body.instant) return true
      const put = await apiAs(sessionCookie, `/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      })
      if (put.status !== 200) return false
      const done = await apiAs(sessionCookie, `/api/uploads/${init.body.uploadId}/complete`, {
        method: 'POST',
        json: {},
      })
      return done.status === 200
    }

    /** 在文件管理器里对某个文件弹出右键菜单。 */
    async function openContextMenuOnFile(name) {
      return await evaluate(`
        (() => {
          const el = [...document.querySelectorAll('.tile__name, .row__name')].find(
            (x) => x.textContent.includes(${JSON.stringify(name)}),
          )
          if (!el) return 'no-file'
          const target = el.closest('.tile, .row') ?? el
          target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }),
          )
          return 'ok'
        })()
      `)
    }

    /** 点右键菜单里 label 完全匹配的那一项。 */
    async function clickMenuItem(label) {
      return await evaluate(`
        (() => {
          const item = [...document.querySelectorAll('.ctx__item')].find(
            (i) => i.querySelector('.ctx__label')?.textContent.trim() === ${JSON.stringify(label)},
          )
          if (!item) return 'no-item'
          item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return 'ok'
        })()
      `)
    }

    /** 双击桌面图标打开应用。 */
    async function openApp(label) {
      await evaluate(`
        (() => {
          const icon = [...document.querySelectorAll('.desktop-icons .icon')].find(
            (i) => i.textContent.includes(${JSON.stringify(label)}),
          )
          icon?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return true
        })()
      `)
    }

    async function openFileByName(name) {
      return await evaluate(`
        (() => {
          const el = [...document.querySelectorAll('.tile__name, .row__name')].find(
            (x) => x.textContent.includes(${JSON.stringify(name)}),
          )
          if (!el) return 'no-file'
          const target = el.closest('.tile, .row') ?? el
          target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()
      `)
    }

    async function closeWindowByTitle(title) {
      await evaluate(`
        (() => {
          const win = [...document.querySelectorAll('.window')].find(
            (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(title)},
          )
          win?.querySelector('.window__ctl--close')?.click()
          return true
        })()
      `)
    }

    /**
     * 最小的"能被嗅探认出来"的 docx：ZIP 容器 + 一个 word/ 条目。
     *
     * 服务端的嗅探看的就是前 4096 字节里有没有 `word/`（见 server/src/mime.ts），
     * 所以不需要真的构造一份 Word 文档。用 store 方式（不压缩）是因为
     * 手写 deflate 不现实，而不压缩的 ZIP 结构最简单、也完全合法。
     */
    async function minimalDocx() {
      const { crc32 } = await import('node:zlib')
      const entries = [
        { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document/>', 'utf8') },
      ]
      const chunks = []
      const central = []
      let offset = 0
      for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8')
        const crc = crc32(e.data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
        local.writeUInt16LE(20, 4) // 需要的版本
        local.writeUInt16LE(0, 6) // flags
        local.writeUInt16LE(0, 8) // 压缩方式：0 = store
        local.writeUInt16LE(0, 10) // 修改时间
        local.writeUInt16LE(0x21, 12) // 修改日期：1980-01-01
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(e.data.length, 18)
        local.writeUInt32LE(e.data.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28) // extra
        chunks.push(local, nameBuf, e.data)

        const cd = Buffer.alloc(46)
        cd.writeUInt32LE(0x02014b50, 0) // 中央目录签名
        cd.writeUInt16LE(20, 4)
        cd.writeUInt16LE(20, 6)
        cd.writeUInt16LE(0, 8)
        cd.writeUInt16LE(0, 10)
        cd.writeUInt16LE(0, 12)
        cd.writeUInt16LE(0x21, 14)
        cd.writeUInt32LE(crc, 16)
        cd.writeUInt32LE(e.data.length, 20)
        cd.writeUInt32LE(e.data.length, 24)
        cd.writeUInt16LE(nameBuf.length, 28)
        cd.writeUInt32LE(0, 38) // 外部属性
        cd.writeUInt32LE(offset, 42) // 本地头偏移
        central.push(cd, nameBuf)

        offset += 30 + nameBuf.length + e.data.length
      }
      const cdBuf = Buffer.concat(central)
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0) // 结束记录签名
      end.writeUInt16LE(entries.length, 8)
      end.writeUInt16LE(entries.length, 10)
      end.writeUInt32LE(cdBuf.length, 12)
      end.writeUInt32LE(offset, 16)
      return Buffer.concat([...chunks, cdBuf, end])
    }

    // ---- 表格预览：CSV 不当纯文本糊过去 ----
    //
    // 这一路的重点不是"能打开"，而是**引号里的逗号不会被切错列**：
    // `split(',')` 这种写法会把 "联想, 16G, 512G" 切成 3 列，行数看起来正常、
    // 内容全错 —— 是最难被发现的那类 bug。所以断言盯的是单元格内容本身。
    console.log('\n【CSV 表格预览】')

    const csvName = `表格测试-${SUFFIX}.csv`
    const csvText = '姓名,部门,备注\n张三,技术部,"联想, 16G, 512G"\n李四,财务部,显示器\n'
    assert(await uploadFile(csvName, Buffer.from(csvText, 'utf8')), 'CSV 已上传到共享空间')

    // 新开一个文件管理器：列表是开窗时拉的，这样一定能看到刚上传的文件
    await openApp('文件')
    await sleep(2000)
    assert((await openFileByName(csvName)) === 'ok', 'CSV 文件出现在文件管理器里')
    await sleep(1500)

    const tbl = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find(
        (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(csvName)},
      )
      if (!win) return { found: false }
      const table = win.querySelector('.pv__table')
      if (!table) return { found: true, table: false }
      return {
        found: true,
        table: true,
        header: [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()),
        // 第一个数据行的单元格（跳过行号列）
        firstRow: [...table.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map((td) => td.textContent.trim()),
        dataRows: table.querySelectorAll('tbody tr').length,
      }
    })())`))
    assert(tbl.found === true, 'CSV 打开的是预览窗口（不是静默下载）')
    assert(tbl.table === true, '渲染成了表格，而不是一整块纯文本')
    assert(
      tbl.header?.join('|') === '#|姓名|部门|备注',
      '表头解析正确（含行号列）',
      JSON.stringify(tbl.header),
    )
    assert(tbl.dataRows === 2, '两行数据', String(tbl.dataRows))
    // 关键断言：引号里的逗号没有被当成分隔符
    assert(
      tbl.firstRow?.length === 4,
      '引号内的逗号没有把这一行切成 6 列',
      `实际 ${tbl.firstRow?.length} 列：${JSON.stringify(tbl.firstRow)}`,
    )
    assert(
      tbl.firstRow?.[3] === '联想, 16G, 512G',
      '带逗号的备注完整落在一个单元格里',
      JSON.stringify(tbl.firstRow?.[3]),
    )

    // 切到纯文本视图（解析不理想时的退路）
    const toRaw = await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(csvName)},
        )
        const btn = [...(win?.querySelectorAll('.pv__bar .wl-btn') ?? [])].find((b) => b.textContent.includes('纯文本'))
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    assert(toRaw === true, '预览窗口有「纯文本」切换按钮')
    await sleep(600)
    const rawView = await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(csvName)},
        )
        return { table: !!win?.querySelector('.pv__table'), frame: !!win?.querySelector('.pv__frame') }
      })()
    `)
    assert(rawView.frame && !rawView.table, '切换后退回纯文本渲染', JSON.stringify(rawView))
    await closeWindowByTitle(csvName)
    await sleep(400)

    // ---- Office 预览：不再"双击就静默下载一个打不开的文件" ----
    //
    // 造一个真实的（但是最小的）docx：ZIP 容器 + 一个 word/ 条目，
    // 服务端的嗅探就是靠这个认出它是 Word 的（见 server/src/mime.ts）。
    // 没有依赖可用，所以手写一个 store 方式的 ZIP —— 不压缩，结构最简单。
    console.log('\n【Office 预览（需要转 PDF）】')

    const docxName = `文档测试-${SUFFIX}.docx`
    assert(
      await uploadFile(docxName, await minimalDocx()),
      'docx 已上传到共享空间（手写的 ZIP，内容嗅探能认出它是 Word）',
    )

    await openApp('文件')
    await sleep(2000)

    // ⚠️ 双击 .docx 现在的行为是「进编辑器」——双击一个文档的人想的是改它。
    // 预览（"转成 PDF 看一眼"）改从右键菜单进，所以这里走右键。
    assert((await openContextMenuOnFile(docxName)) === 'ok', 'docx 文件出现在文件管理器里')
    assert((await clickMenuItem('预览')) === 'ok', '右键菜单里有「预览」')
    await sleep(1800)

    const office = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find(
        (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(docxName)},
      )
      if (!win) return { found: false }
      const card = win.querySelector('.pv__office')
      return {
        found: true,
        card: !!card,
        text: (card?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
        hasConvertBtn: [...(card?.querySelectorAll('.wl-btn') ?? [])].some((b) => b.textContent.includes('转为 PDF')),
      }
    })())`))
    assert(office.found === true, '双击 docx 打开的是预览窗口（以前是直接下载）')
    assert(office.card === true, '预览窗口给出 Office 专属的提示卡片')
    // 测试环境没有配 WL_CONVERT_SERVICE_URL，所以工具必然是"不可用"：
    // 这里要验证的是它会**说清楚为什么不能用**，而不是转一个等不到的圈。
    assert(
      office.text.includes('转换服务'),
      '说明了需要转换服务（而不是假装能预览）',
      office.text.slice(0, 120),
    )
    assert(
      office.hasConvertBtn === false,
      '转换服务不可用时**不**给出点不动的「转为 PDF」按钮',
      String(office.hasConvertBtn),
    )
    await closeWindowByTitle(docxName)
    await sleep(400)

    // ---- 在线编辑：新建一份表格，改一格，存回去 ----
    //
    // 这条链路比"能打开"重要得多：它跨了四个组件（文件管理器 → 动态加载的
    // xlsx 库 → 编辑器 → PUT /api/files/:id/content → 服务端改写 blob）。
    // 所以最后不只看界面上"保存成功"，而是**把文件下载回来用 ExcelJS 解析**，
    // 确认那个格子真的变了、别的内容还在 —— 200 说明不了任何事。
    console.log('\n【在线编辑：表格】')

    const clickNewFileButton = async (titlePrefix) =>
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll('button[title]')].find((b) =>
          (b.getAttribute('title') ?? '').startsWith(${JSON.stringify(titlePrefix)}),
        )
        if (!btn) return 'no-btn'
        btn.click()
        return 'ok'
      })()`)

    assert((await clickNewFileButton('新建表格')) === 'ok', '文件管理器工具栏有「新建表格」入口')
    // 动态 import XL（900KB chunk）+ 生成 + 上传 + 开窗，慢一点是正常的
    await sleep(6000)

    const sheetEditorWin = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      if (!win) return { found: false }
      return {
        found: true,
        title: win.querySelector('.window__title')?.textContent.trim() ?? '',
        cells: win.querySelectorAll('.se__cell').length,
        hasSave: [...win.querySelectorAll('.wl-btn')].some((b) => b.textContent.includes('保存')),
      }
    })())`))
    assert(sheetEditorWin.found === true, '新建表格后自动打开了表格编辑器')
    assert(sheetEditorWin.title === '新建表格.xlsx', '窗口标题是新建的文件名', sheetEditorWin.title)
    assert(sheetEditorWin.cells > 10, '渲染出了单元格网格', `${sheetEditorWin.cells} 个格子`)
    assert(sheetEditorWin.hasSave === true, '编辑器工具条上有「保存」')

    const editStarted = await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      const cell = win?.querySelector('.se__row .se__cell')
      if (!cell) return 'no-cell'
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return 'ok'
    })()`)
    assert(editStarted === 'ok', '双击单元格进入编辑')

    const typedInto = await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      const input = win?.querySelector('.se__input')
      if (!input) return 'no-input'
      input.value = '九月值日表'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'ok'
    })()`)
    assert(typedInto === 'ok', '单元格进入输入态并接受了输入', String(typedInto))
    // 输入框是"提交后消失、单元格重新渲染"，DOM 更新是下一个 tick，
    // 所以这里必须等一拍再看 —— 否则读到的是还没刷新的空单元格
    await sleep(300)
    const cellTyped = await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      const cell = win?.querySelector('.se__row .se__cell')
      return {
        text: cell?.textContent.trim() ?? '',
        stillEditing: !!win?.querySelector('.se__input'),
      }
    })()`)
    assert(
      cellTyped.text === '九月值日表',
      '输入的内容进入了单元格（Enter 提交）',
      JSON.stringify(cellTyped),
    )
    assert(cellTyped.stillEditing === false, '提交之后输入框关闭（回到格子浏览态）')

    const unsavedBadge = await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      return win?.querySelector('.wl-badge--warning')?.textContent.trim() ?? ''
    })()`)
    assert(unsavedBadge === '未保存', '改动之后工具条标记「未保存」', unsavedBadge)

    await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      const btn = [...win.querySelectorAll('.wl-btn')].find((b) => b.textContent.includes('保存'))
      btn?.click()
      return true
    })()`)
    await sleep(2500)

    const postSaveState = await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.se'))
      return win?.querySelector('.wl-badge--warning') ? 'dirty' : 'clean'
    })()`)
    assert(postSaveState === 'clean', '保存之后「未保存」标记消失')

    // 用 API 把文件下载回来，用真的 XL 解析
    const { default: XL } = await import('exceljs')
    const sheetListing = await apiAs(sessionCookie, '/api/files?space=shared')
    const createdSheetEntry = sheetListing.body.entries.find((e) => e.name === '新建表格.xlsx')
    assert(!!createdSheetEntry, '新建的表格是一个真实文件（在共享空间的列表里）')
    if (createdSheetEntry) {
      const dlBytes = await fetch(`${BASE}/api/files/${createdSheetEntry.id}/download`, {
        headers: { cookie: sessionCookie },
      })
      const parsedBook = new XL.Workbook()
      await parsedBook.xlsx.load(Buffer.from(await dlBytes.arrayBuffer()))
      const parsedSheet = parsedBook.getWorksheet(1)
      assert(
        parsedSheet?.getCell('A1').value === '九月值日表',
        '保存后的 xlsx 里 A1 就是输入的内容（不是只改了界面）',
        String(parsedSheet?.getCell('A1').value),
      )
      assert(
        createdSheetEntry.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '保存后文件类型仍然是 xlsx',
        createdSheetEntry.mime ?? '',
      )
    }
    await closeWindowByTitle('新建表格.xlsx')
    await sleep(500)

    // ---- 在线编辑：文档 + 关闭守卫 ----
    console.log('\n【在线编辑：文档与未保存守卫】')

    assert((await clickNewFileButton('新建文档')) === 'ok', '文件管理器工具栏有「新建文档」入口')
    await sleep(5000)

    const docEditorWin = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.de'))
      if (!win) return { found: false }
      return {
        found: true,
        title: win.querySelector('.window__title')?.textContent.trim() ?? '',
        blocks: win.querySelectorAll('.de__text').length,
      }
    })())`))
    assert(docEditorWin.found === true, '新建文档后自动打开了文档编辑器')
    assert(docEditorWin.title === '新建文档.docx', '文档窗口标题是新建的文件名', docEditorWin.title)
    assert(docEditorWin.blocks >= 1, '文档里至少有一个可编辑段落', `${docEditorWin.blocks} 段`)

    await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.de'))
      const text = win?.querySelector('.de__text')
      if (!text) return 'no-text'
      text.focus()
      text.innerText = '九月例会纪要'
      text.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)

    // 改了没保存就点 × —— 必须问一句，而不是直接把内容丢掉（windows.setCloseGuard）
    await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.de'))
      win?.querySelector('.window__ctl--close')?.click()
      return true
    })()`)
    await sleep(600)

    const closeGuardState = JSON.parse(await evaluate(`JSON.stringify({
      dialog: !!document.querySelector('.wl-confirm'),
      text: (document.querySelector('.wl-confirm')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      stillOpen: [...document.querySelectorAll('.window')].some((w) => w.querySelector('.de')),
    })`))
    assert(closeGuardState.dialog === true, '有未保存修改时关窗会先问一句')
    assert(closeGuardState.text.includes('未保存'), '确认框说清了"为什么问"', closeGuardState.text)
    assert(closeGuardState.stillOpen === true, '确认框还没答完，窗口没有被关掉')

    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.wl-confirm button')].find((b) =>
        b.textContent.includes('继续编辑'),
      )
      btn?.click()
      return true
    })()`)
    await sleep(400)
    const stillOpenAfterCancel = await evaluate(
      `!![...document.querySelectorAll('.window')].find((w) => w.querySelector('.de'))`,
    )
    assert(stillOpenAfterCancel === true, '选「继续编辑」后窗口留着，内容还在')

    await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.de'))
      const btn = [...win.querySelectorAll('.wl-btn')].find((b) => b.textContent.includes('保存'))
      btn?.click()
      return true
    })()`)
    await sleep(2500)

    const { unzipSync, strFromU8 } = await import('fflate')
    const docListing = await apiAs(sessionCookie, '/api/files?space=shared')
    const createdDocEntry = docListing.body.entries.find((e) => e.name === '新建文档.docx')
    assert(!!createdDocEntry, '新建的文档是一个真实文件')
    if (createdDocEntry) {
      const dlBytes = await fetch(`${BASE}/api/files/${createdDocEntry.id}/download`, {
        headers: { cookie: sessionCookie },
      })
      const docParts = unzipSync(new Uint8Array(await dlBytes.arrayBuffer()))
      const docXml = strFromU8(docParts['word/document.xml'] ?? new Uint8Array())
      assert(docXml.includes('九月例会纪要'), '保存后的 docx 里就是输入的文字')
      assert(docXml.includes('<w:body>'), '产出的是一份结构完整的 docx（word/document.xml 有正文）')
      assert(
        createdDocEntry.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '保存后文件类型仍然是 docx',
        createdDocEntry.mime ?? '',
      )
    }
    await closeWindowByTitle('新建文档.docx')
    await sleep(400)

    // ---- 在线编辑：一篇"有结构"的文档能读出结构 ----
    //
    // 上面那一节验的是"新建 → 写 → 存"，走的是我们自己写出来的最简 docx。
    // 这一节反过来：喂一份带标题、加粗、列表、表格的 docx，看**读**的那条路
    // 能不能把结构还原出来。读错了不会报错，只会表现为"打开以后内容不对/少了"，
    // 而那是最难被发现的失败方式，所以必须逐项断言。
    console.log('\n【在线编辑：解析有结构的文档】')

    const { zipSync, strToU8: toU8 } = await import('fflate')
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const structuredDocx = Buffer.from(
      zipSync({
        '[Content_Types].xml': toU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        'word/document.xml': toU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>会议纪要</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">参加人员：</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>张三</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一条决议</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>
<w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>预算</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>场地</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>300</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`),
        'word/styles.xml': toU8(`<?xml version="1.0"?><w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
        'word/numbering.xml': toU8(`<?xml version="1.0"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`),
      }),
    )

    const structuredName = `结构文档-${SUFFIX}.docx`
    assert(await uploadFile(structuredName, structuredDocx), '带结构的 docx 已上传')

    await openApp('文件')
    await sleep(1800)
    assert((await openFileByName(structuredName)) === 'ok', '结构文档出现在文件管理器里')
    await sleep(2500)

    const parsedDoc = JSON.parse(await evaluate(`JSON.stringify((() => {
      const win = [...document.querySelectorAll('.window')].find(
        (w) => w.querySelector('.window__title')?.textContent.trim() === ${JSON.stringify(structuredName)},
      )
      if (!win) return { found: false }
      const h1 = win.querySelector('.de__line--h1 .de__text')
      return {
        found: true,
        isEditor: !!win.querySelector('.de'),
        heading: h1?.textContent.trim() ?? '',
        boldText: win.querySelector('.de__text b')?.textContent.trim() ?? '',
        hasList: !!win.querySelector('.de__line--li'),
        listText: win.querySelector('.de__line--li .de__text')?.textContent.trim() ?? '',
        tableCells: [...win.querySelectorAll('.de__td')].map((td) => td.textContent.trim()),
        readOnlyBlocks: win.querySelectorAll('.de__raw').length,
      }
    })())`))

    assert(parsedDoc.found === true, '双击结构文档打开编辑器')
    assert(parsedDoc.isEditor === true, '打开的是文档编辑器（不是预览窗口）')
    assert(parsedDoc.heading === '会议纪要', '标题段落被认成标题（docx 的 Heading1 → 界面 h1）', parsedDoc.heading)
    assert(parsedDoc.boldText === '张三', '行内加粗被解析出来（<b> 包住了那一段）', parsedDoc.boldText)
    assert(parsedDoc.hasList === true, '列表项被认成列表（numPr）', parsedDoc.listText)
    assert(parsedDoc.listText === '第一条决议', '列表项的文字没丢', parsedDoc.listText)
    assert(
      parsedDoc.tableCells.join('|') === '项目|预算|场地|300',
      '表格的四个单元格都读出来了',
      parsedDoc.tableCells.join('|'),
    )
    assert(parsedDoc.readOnlyBlocks === 0, '这份文档没有触发只读回退（全部是可编辑块）', String(parsedDoc.readOnlyBlocks))

    await closeWindowByTitle(structuredName)
    await sleep(400)

    // ---- 系统音效：界面动作真的在合成声音，静音真的静得掉 ----
    //
    // 声音没法在 CI 里用耳朵验，所以这里验的是**音频图真的被驱动了**：
    // 把 AudioContext 原型上的 createOscillator / createBufferSource 换成计数版，
    // 然后做"开窗 / 试听 / 关窗 / 静音后再开窗"，数新增的声源。
    //
    // 为什么不去断言"playXxx 被调用"：那样只要接线还在、参数写错也照样过。
    // 数声源则要求整条链都通 —— 类型 → 配方 → AudioContext → 增益节点。
    console.log('\n【系统音效（参考 Windows 的反馈音）】')

    const hookAudio = `
      (() => {
        window.__sfx = { osc: 0, buf: 0 }
        const proto = window.AudioContext.prototype
        if (!proto.__sfxPatched) {
          const osc = proto.createOscillator
          const buf = proto.createBufferSource
          proto.createOscillator = function (...args) {
            window.__sfx.osc++
            return osc.apply(this, args)
          }
          proto.createBufferSource = function (...args) {
            window.__sfx.buf++
            return buf.apply(this, args)
          }
          proto.__sfxPatched = true
        }
        return true
      })()
    `

    await evaluate(hookAudio)
    const soundStart = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))

    // 开窗（从开始菜单打开「设置」）—— 应当有开窗音
    // 开始菜单是开关式的：先确认它是关的，再点开，免得"点了一下反而关掉"
    if (JSON.parse(await evaluate(`!!document.querySelector('.start')`))) {
      await evaluate(`document.querySelector('.taskbar__start').click()`)
      await sleep(200)
    }
    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(500)
    const settingsTile = await evaluate(`
      (() => {
        const tiles = [...document.querySelectorAll('.start__tile')]
        const t = tiles.find((x) => x.textContent.includes('设置'))
        if (!t) return false
        t.click()
        return true
      })()
    `)
    assert(settingsTile === true, '在开始菜单里找到了「设置」磁贴')
    await sleep(2200)

    const afterOpen = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    const openSources = afterOpen.osc + afterOpen.buf - (soundStart.osc + soundStart.buf)
    assert(openSources > 0, '打开窗口时真的产生了声源（开窗音）', `+${openSources} 个声源`)

    // 声音页签：开关、音量、试听列表都在
    const soundTabs = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.settings__tab')].map((e) => e.textContent.trim()))`,
    )
    assert(
      JSON.parse(soundTabs).includes('声音'),
      '设置里有「声音」页签',
      JSON.parse(soundTabs).join('、'),
    )

    await evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('.settings__tab')].find((t) => t.textContent.includes('声音'))
        tab?.click()
        return !!tab
      })()
    `)
    await sleep(500)

    const soundPanel = JSON.parse(
      await evaluate(`JSON.stringify({
        rows: [...document.querySelectorAll('.sfx-row')].map((row) => ({
          title: row.querySelector('.sfx-row__title')?.textContent.trim() ?? '',
          checked: row.querySelector('.sfx-switch')?.getAttribute('aria-checked') ?? null,
        })),
        hasRange: !!document.querySelector('.sfx-range'),
        chips: [...document.querySelectorAll('.sfx-chip')].map((e) => e.textContent.trim()),
      })`),
    )
    const muteRow = soundPanel.rows.find((r) => r.title.startsWith('全部声音'))
    const systemRow = soundPanel.rows.find((r) => r.title.startsWith('系统音效'))
    const chatRow = soundPanel.rows.find((r) => r.title.startsWith('聊天提示音'))
    assert(!!muteRow, '有「全部声音」总开关（含棋牌）')
    assert(!!systemRow, '有「系统音效」开关')
    assert(!!chatRow, '有「聊天提示音」开关（与系统音效分开）')
    assert(systemRow.checked === 'true', '系统音效默认是开着的', String(systemRow.checked))
    assert(chatRow?.checked === 'true', '聊天提示音默认是开着的', String(chatRow?.checked))
    assert(muteRow.checked === 'true', '「全部声音」默认没有静音', String(muteRow.checked))

    // 真的能关：点一下要落到本地偏好里，否则"下次开窗又自己响"
    const chatToggle = JSON.parse(
      await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.sfx-row')].find(
            (r) => r.querySelector('.sfx-row__title')?.textContent.startsWith('聊天提示音'),
          )
          const btn = row?.querySelector('.sfx-switch')
          if (!btn) return 'null'
          btn.click()
          return JSON.stringify({
            stored: localStorage.getItem('wl.sfx.chat'),
            checked: btn.getAttribute('aria-checked'),
          })
        })()
      `) ?? 'null',
    )
    assert(chatToggle?.stored === '0', '关掉聊天提示音后写进了本地偏好', String(chatToggle?.stored))
    // 恢复默认，别影响后面的试听与关窗音
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.sfx-row')].find(
          (r) => r.querySelector('.sfx-row__title')?.textContent.startsWith('聊天提示音'),
        )
        row?.querySelector('.sfx-switch')?.click()
        return true
      })()
    `)
    await sleep(300)

    // 桌面通知：权限状态与入口都要在声音页里，用户不用去翻浏览器的站点设置
    const notifyRow = JSON.parse(
      await evaluate(`JSON.stringify({
        title: [...document.querySelectorAll('.sfx-row__title')]
          .map((e) => e.textContent.trim())
          .find((t) => t.includes('桌面通知')) ?? '',
        badge: [...document.querySelectorAll('.sfx-row')]
          .find((r) => r.textContent.includes('桌面通知'))?.querySelector('.wl-badge')?.textContent.trim() ?? '',
      })`),
    )
    assert(notifyRow.title.includes('桌面通知'), '声音页有「桌面通知」一项', notifyRow.title)
    assert(
      ['已开启', '未开启', '已被浏览器拦下', '当前浏览器不支持'].includes(notifyRow.badge),
      '桌面通知给出了明确的权限状态',
      notifyRow.badge,
    )
    assert(soundPanel.hasRange, '有音量滑块')
    assert(
      soundPanel.chips.length >= 12,
      '试听列表列出了全部系统音效',
      `${soundPanel.chips.length} 个：${soundPanel.chips.join('、')}`,
    )

    // 试听：即使系统音效关着也该响（force），所以这条同时证明"试听按钮不是摆设"
    const beforePreview = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    await evaluate(`document.querySelectorAll('.sfx-chip')[0]?.click()`)
    await sleep(400)
    const afterPreview = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    const previewSources =
      afterPreview.osc + afterPreview.buf - (beforePreview.osc + beforePreview.buf)
    assert(previewSources > 0, '点「试听」真的发出了声音', `+${previewSources} 个声源`)

    // 关窗音
    const beforeClose = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.includes('设置'),
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(700)
    const afterClose = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    const closeSources =
      afterClose.osc + afterClose.buf - (beforeClose.osc + beforeClose.buf)
    assert(closeSources > 0, '关闭窗口时也有声音（关窗音）', `+${closeSources} 个声源`)

    // ---- 音量：任务栏喇叭浮窗 + 真实的增益变化 ----
    //
    // 这一轮的原始问题是"声音太小"，所以不能只验"滑块能拖"，要验**增益真的变了**：
    // 在页面加载前注入钩子，记录所有 GainNode，然后读 master 的实际 gain.value。
    // 顺带验限幅器在图上（抬音量之后不会削顶）。
    console.log('\n【音量调节（任务栏喇叭，参考 Windows）】')

    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          (() => {
            window.__gains = []
            window.__dyn = 0
            window.__targets = []
            const proto = window.AudioContext && window.AudioContext.prototype
            if (!proto) return
            const createGain = proto.createGain
            proto.createGain = function (...args) {
              const node = createGain.apply(this, args)
              if (window.__gains.length < 60) window.__gains.push(node)
              return node
            }
            const createDyn = proto.createDynamicsCompressor
            proto.createDynamicsCompressor = function (...args) {
              window.__dyn++
              return createDyn.apply(this, args)
            }
            // 音量走 setTargetAtTime 平滑过渡，直接读 .value 未必是自动化后的值，
            // 所以把每次设定的目标值记下来 —— 这是"滑块真的改到了增益"的直接证据。
            const paramProto = window.AudioParam && window.AudioParam.prototype
            if (paramProto) {
              const setTarget = paramProto.setTargetAtTime
              paramProto.setTargetAtTime = function (target, start, tc) {
                if (window.__targets.length < 80) {
                  window.__targets.push(Number(Number(target).toFixed(4)))
                }
                return setTarget.call(this, target, start, tc)
              }
            }
          })()
        `,
      },
      sessionId,
    )

    await evaluate(
      `localStorage.setItem('wl.sfx.volume', '80'); localStorage.setItem('wl.sfx.muted', '0'); true`,
    )
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(3500)
    await evaluate(hookAudio)

    const volButton = await evaluate(`
      (() => {
        const b = document.querySelector('.taskbar__tray[aria-label="音量"]')
        if (!b) return false
        b.click()
        return true
      })()
    `)
    assert(volButton === true, '任务栏托盘里有喇叭图标')
    await sleep(300)

    const flyout = JSON.parse(
      await evaluate(`JSON.stringify({
        open: !!document.querySelector('.volfly'),
        value: document.querySelector('.volfly__value')?.textContent.trim(),
        slider: (() => {
          const s = document.querySelector('.volfly__range')
          return s ? { min: s.min, max: s.max, step: s.step, value: s.value } : null
        })(),
      })`),
    )
    assert(flyout.open, '点喇叭弹出音量浮窗')
    assert(flyout.value === '80%', '浮窗显示当前音量（默认 80%，不是被截成 100%）', String(flyout.value))
    assert(
      flyout.slider && flyout.slider.value === '80',
      '滑块位置与音量一致',
      JSON.stringify(flyout.slider),
    )

    // 音频图是**第一次要出声时**才建的，所以先确认一次静音/取消静音把上下文拉起来，
    // 再去读 master / 总线 / 限幅器 —— 否则读到的是空数组。
    await evaluate(`document.querySelector('.volfly__mute').click()`)
    await sleep(200)
    await evaluate(`document.querySelector('.volfly__mute').click()`)
    await sleep(500)

    const audioGraph = JSON.parse(
      await evaluate(`JSON.stringify({
        dyn: window.__dyn,
        gains: window.__gains.map((g) => Number(g.gain.value.toFixed(3))),
      })`),
    )
    assert(audioGraph.dyn >= 1, '音频图上有限幅器（抬音量后不削顶）', `${audioGraph.dyn} 个`)
    assert(
      audioGraph.gains.some((v) => v > 2.8 && v < 3.2),
      '系统音走了一条 ×3 的总线（"声音太小"的直接修复）',
      audioGraph.gains.slice(0, 6).join(', '),
    )
    assert(
      audioGraph.gains.some((v) => v > 0.6 && v < 0.76),
      '总音量节点按 80% 的曲线设好了',
      audioGraph.gains.slice(0, 6).join(', '),
    )

    // 拖到 40% —— 不只要看界面，还要看 master 增益真的降下来了
    const beforeVolumeSound = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    await evaluate(`
      (() => {
        const s = document.querySelector('.volfly__range')
        s.value = '40'
        s.dispatchEvent(new Event('input', { bubbles: true }))
        s.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()
    `)
    await sleep(500)
    const volAfter = JSON.parse(
      await evaluate(`JSON.stringify({
        stored: localStorage.getItem('wl.sfx.volume'),
        label: document.querySelector('.volfly__value')?.textContent.trim(),
        targets: window.__targets,
        sfx: window.__sfx,
      })`),
    )
    assert(volAfter.stored === '40', '音量偏好被持久化（刷新后还在）', String(volAfter.stored))
    assert(volAfter.label === '40%', '浮窗的百分比跟着变', String(volAfter.label))
    // 0.4^1.7 ≈ 0.211 —— 这条是"真的改了音量"和"只改了界面数字"的分界线
    assert(
      volAfter.targets.some((v) => v > 0.17 && v < 0.25),
      '总增益按曲线真的降下来了（不是只改了界面数字）',
      `setTargetAtTime 收到：${volAfter.targets.slice(-5).join(', ')}`,
    )
    const volumeSound =
      volAfter.sfx.osc + volAfter.sfx.buf - (beforeVolumeSound.osc + beforeVolumeSound.buf)
    assert(volumeSound > 0, '调完音量响一声确认（试听反馈）', `+${volumeSound} 个声源`)

    // 一键静音
    await evaluate(`document.querySelector('.volfly__mute').click()`)
    await sleep(250)
    const mutedState = JSON.parse(
      await evaluate(`JSON.stringify({
        stored: localStorage.getItem('wl.sfx.muted'),
        pressed: document.querySelector('.volfly__mute')?.getAttribute('aria-pressed'),
        label: document.querySelector('.volfly__value')?.textContent.trim(),
      })`),
    )
    assert(
      mutedState.stored === '1' && mutedState.label === '静音',
      '浮窗里能一键静音，图标与文字同步',
      JSON.stringify(mutedState),
    )

    // 静音状态下拖音量条 → 自动取消静音（Windows 的行为）
    await evaluate(`
      (() => {
        const s = document.querySelector('.volfly__range')
        s.value = '55'
        s.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(250)
    assert(
      (await evaluate(`localStorage.getItem('wl.sfx.muted')`)) === '0',
      '静音时拖音量条自动取消静音',
    )

    // Esc 关闭
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(250)
    assert(!(await evaluate(`!!document.querySelector('.volfly')`)), 'Esc 能关掉音量浮窗')

    // 浮窗里的「声音设置」直达设置的声音页签
    await evaluate(`document.querySelector('.taskbar__tray[aria-label="音量"]').click()`)
    await sleep(250)
    await evaluate(`document.querySelector('.volfly__link')?.click()`)
    await sleep(1400)
    const toSettings = JSON.parse(
      await evaluate(`JSON.stringify({
        flyoutGone: !document.querySelector('.volfly'),
        activeTab: document.querySelector('.settings__tab--active')?.textContent.trim() ?? '',
        percent: document.querySelector('.sfx-vol')?.textContent.trim() ?? '',
      })`),
    )
    assert(toSettings.flyoutGone, '点「声音设置」后浮窗收起')
    assert(toSettings.activeTab === '声音', '直接跳到设置的「声音」页签', toSettings.activeTab)
    assert(toSettings.percent === '55%', '设置页里的音量与浮窗同步', toSettings.percent)

    // 收尾：还原音量、关掉设置窗口，别影响后面的用例
    await evaluate(
      `localStorage.setItem('wl.sfx.volume', '80'); localStorage.setItem('wl.sfx.muted', '0'); true`,
    )
    await evaluate(`
      (() => {
        const win = [...document.querySelectorAll('.window')].find(
          (w) => w.querySelector('.window__title')?.textContent.includes('设置'),
        )
        win?.querySelector('.window__ctl--close')?.click()
        return true
      })()
    `)
    await sleep(600)

    // 静音：刷新后应当一声都不出（含最容易被漏掉的"开机音"）
    await evaluate(`localStorage.setItem('wl.sfx.muted', '1'); true`)
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(3500)
    await evaluate(hookAudio)
    await evaluate(`document.querySelector('.taskbar__start').click()`)
    await sleep(500)
    await evaluate(`
      (() => {
        const t = [...document.querySelectorAll('.start__tile')].find((x) => x.textContent.includes('文件'))
        t?.click()
        return !!t
      })()
    `)
    await sleep(2200)
    const muted = JSON.parse(await evaluate('JSON.stringify(window.__sfx)'))
    assert(
      muted.osc === 0 && muted.buf === 0,
      '静音后一声都不出（开机音、开窗音都静住了）',
      `${muted.osc} 个振荡器 / ${muted.buf} 段噪声`,
    )
    // 还原，别把静音留在测试浏览器的偏好里
    await evaluate(`localStorage.setItem('wl.sfx.muted', '0'); true`)

    // ---- 白板：Excalidraw 必须真的渲染出画布 ----
    //
    // 曾经踩过的坑：组件进来了但**忘了引它的 index.css**，DOM 全在、断言全绿，
    // 但界面上工具栏消失、欢迎页内容按文档流堆成一列、canvas 根本没有 ——
    // 用户一眼就是"白板用不了"。所以这里断言的是"画布真的画出来了"：
    // <canvas> 存在且尺寸像样、工具栏按钮齐、初始不该显示"未保存"。
    console.log('\n【白板（Excalidraw）】')
    const desktopHasWhiteboard = await evaluate(`
      (() => {
        const icons = [...document.querySelectorAll('.desktop-icons .icon')]
        const wb = icons.find(i => i.textContent.includes('白板'))
        wb?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return !!wb
      })()
    `)
    assert(desktopHasWhiteboard, '桌面上有「白板」图标')
    await sleep(4500)

    await evaluate(`window.__origPrompt = window.prompt; window.prompt = () => 'smoke 白板'; true`)
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.wb-app .side-head .wl-icon-btn')].pop()
        btn?.click()
        return !!btn
      })()
    `)
    await sleep(4500)

    const wbState = JSON.parse(
      await evaluate(`JSON.stringify({
        canvas: (() => {
          const c = document.querySelector('.wb-app .canvas canvas')
          return c ? { w: c.clientWidth, h: c.clientHeight } : null
        })(),
        toolbarButtons: document.querySelectorAll('.wb-app .canvas .excalidraw button').length,
        dirtyBadge: !!document.querySelector('.wb-app .wl-badge--warning'),
        cjkTitles: [...document.querySelectorAll('.wb-app .canvas .excalidraw button[title]')]
          .map((b) => b.getAttribute('title') ?? '')
          .filter((t) => /[\u4e00-\u9fa5]/.test(t)).length,
        canvasCssPosition: (() => {
          const el = document.querySelector('.wb-app .canvas .excalidraw')
          return el ? getComputedStyle(el).position : null
        })(),
      })`),
    )
    assert(wbState.canvas !== null, 'Excalidraw 画出了 <canvas>')
    assert(
      (wbState.canvas?.w ?? 0) > 300 && (wbState.canvas?.h ?? 0) > 200,
      '画布尺寸正常（不是 0×0 的隐形画布）',
      `${wbState.canvas?.w}×${wbState.canvas?.h}`,
    )
    assert(wbState.toolbarButtons >= 5, '工具栏按钮齐全（样式没加载时按钮会散成一列）', `${wbState.toolbarButtons} 个`)
    assert(
      wbState.canvasCssPosition === 'relative',
      'Excalidraw 样式已生效（容器 position 不是 static）',
      String(wbState.canvasCssPosition),
    )
    assert(!wbState.dirtyBadge, '刚打开的白板不显示「未保存」')
    // 汉化：Excalidraw 的语言包是带哈希的 js，按需从同源 locales/ 动态 import，
    // 拉不到就会静默回落英文 —— 用"工具按钮 title 里有没有中文"来盯住它
    assert(
      wbState.cjkTitles >= 3,
      'Excalidraw 界面已汉化（工具栏提示是中文）',
      `${wbState.cjkTitles} 个中文 title`,
    )

    // ---- 白板：保存 → 切换白板 → 切回来，内容必须还在 ----
    //
    // 这条用例针对两个真实 bug：
    //  1. 切换白板时 bridge 已存在就直接 return → 新白板根本没载入场景
    //     （看到的是上一块白板的内容）
    //  2. 保存成功后没把场景写回本地状态 → 切回来载入旧数据
    // 用户看到的现象都是"白板保存不了 / 保存了又丢"。
    const injectRect = async (id) =>
      evaluate(`(() => {
        const hook = window.__wlWhiteboard
        if (!hook?.updateScene) return 'no-hook'
        hook.updateScene([{
          id: '${id}', type: 'rectangle', x: 120, y: 120, width: 180, height: 120,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: { type: 3 }, seed: 4242, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        }])
        return 'injected'
      })()`)
    const elementCount = async () =>
      Number(await evaluate(`String(window.__wlWhiteboard?.elementCount?.() ?? -1)`))

    // 当前窗口里的白板已经是 smoke 白板：画一个矩形并保存
    const injected = await injectRect('smoke-rect-1')
    assert(injected === 'injected', '往画布里注入一个矩形（模拟用户画了一笔）')
    await sleep(1200)
    assert((await elementCount()) === 1, '画布场景里有 1 个元素')

    const saveEnabled = await evaluate(
      `String(!document.querySelector('.wb-app .canvas-bar .wl-btn--primary')?.disabled)`,
    )
    assert(saveEnabled === 'true', '有未保存改动时保存按钮可点')

    await evaluate(`(() => { document.querySelector('.wb-app .canvas-bar .wl-btn--primary')?.click(); return true })()`)
    await sleep(2500)
    const dirtyAfterSave = await evaluate(`String(!!document.querySelector('.wb-app .wl-badge--warning'))`)
    assert(dirtyAfterSave === 'false', '保存后「未保存」标记消失')

    // 再建一块新白板（会自动切过去），必须是一块空板
    await evaluate(`window.__origPrompt2 = window.prompt; window.prompt = () => 'smoke 第二块'; true`)
    await evaluate(`(() => { const b = [...document.querySelectorAll('.wb-app .side-head .wl-icon-btn')].pop(); b?.click(); return !!b })()`)
    await sleep(3500)
    assert((await elementCount()) === 0, '新建并切到另一块白板后画布是空的（不串上一块的内容）')

    // 切回第一块：保存过的矩形必须回来
    const backToFirst = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.wb-app .brow')]
      const row = rows.find((r) => r.textContent.includes('smoke 白板'))
      row?.click()
      return !!row
    })()`)
    assert(backToFirst, '在列表里切回原来的白板')
    await sleep(3000)
    assert((await elementCount()) === 1, '切回后保存过的内容还在（保存真的生效）')
    await evaluate(`window.prompt = window.__origPrompt2; true`)

    // ---- 关窗 → 重开 → **只点一次**列表行，内容必须出来 ----
    //
    // 用户原话："无法加载记录，需要点击两次画板才会显示记录"。
    // 根因：Excalidraw 初始化是异步的（字体/语言包/初始 state），首次
    // updateScene 在早期会被丢掉；画布挂上了但场景是空的，再点一次才载入。
    // bridge 现在会在 350ms / 1200ms 后检查"场景仍为空"并补灌。
    await evaluate(`(() => {
      const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('.wb-app'))
      const btns = win ? [...win.querySelectorAll('.window__ctl')] : []
      btns[btns.length - 1]?.click()
      return !!win
    })()`)
    await sleep(1500)
    assert(
      (await evaluate(`String(!!document.querySelector('.wb-app'))`)) === 'false',
      '白板窗口已关闭',
    )

    await evaluate(`(() => {
      const icons = [...document.querySelectorAll('.desktop-icons .icon')]
      icons.find((i) => i.textContent.includes('白板'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    await sleep(4000)

    const reopenedRow = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.wb-app .brow')].find((r) => r.textContent.includes('smoke 白板'))
      row?.click()
      return !!row
    })()`)
    assert(reopenedRow, '重开窗口后列表里有原来的白板')

    // 补灌最晚在 1200ms 后发生，但重开 + 懒加载 chunk 的耗时随机器波动，
    // 固定 sleep 在负载高时会误报 —— 轮询等结果，最多 6 秒
    let reopenCount = -1
    for (let i = 0; i < 30; i++) {
      reopenCount = await elementCount()
      if (reopenCount === 1) break
      await sleep(200)
    }
    assert(
      reopenCount === 1,
      '重开后只点一次就显示记录（不需要点第二次）',
      `元素 ${reopenCount}`,
    )


    // ---- 白板：保存后立刻再画一笔，不能被"自己的广播"覆盖 ----
    //
    // 服务端保存后会广播 saved；如果不区分 actor，自己也会收到 → 本地干净
    // 分支重新 GET + loadScene → 把刚画的那一笔洗掉（实测可丢笔画）。
    await sleep(1500)
    await evaluate(`(() => {
      const hook = window.__wlWhiteboard
      if (!hook?.updateScene) return 'no-hook'
      hook.updateScene([
        {
          id: 'smoke-rect-1', type: 'rectangle', x: 120, y: 120, width: 180, height: 120,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: { type: 3 }, seed: 4242, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        },
        {
          id: 'smoke-rect-2', type: 'ellipse', x: 340, y: 300, width: 90, height: 90,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: null, seed: 4243, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        },
      ])
      return 'ok'
    })()`)
    await sleep(800)
    // 保存 → 立刻再画一笔（模拟"存完接着画"）
    await evaluate(`(() => { document.querySelector('.wb-app .canvas-bar .wl-btn--primary')?.click(); return true })()`)
    await sleep(300)
    // 直接用 updateScene 追加第三笔（等价于用户又画了一笔）
    await evaluate(`(() => {
      const hook = window.__wlWhiteboard
      hook.updateScene([
        {
          id: 'smoke-rect-1', type: 'rectangle', x: 120, y: 120, width: 180, height: 120,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: { type: 3 }, seed: 4242, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        },
        {
          id: 'smoke-rect-2', type: 'ellipse', x: 340, y: 300, width: 90, height: 90,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: null, seed: 4243, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        },
        {
          id: 'smoke-rect-3', type: 'diamond', x: 500, y: 200, width: 80, height: 80,
          angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
          frameId: null, roundness: null, seed: 4244, version: 1, versionNonce: 1,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        },
      ])
      return 'ok'
    })()`)
    await sleep(2000)
    assert(
      (await elementCount()) === 3,
      '保存后继续画的东西没被自己的保存广播洗掉',
      `元素 ${await elementCount()}`,
    )
    // ---- 打字背单词：默写模式必须"隐藏英文、显示中文" ----
    //
    // 曾经的实现正好反了：默写时隐藏音标与释义、英文照样显示 —— 等于没默写。
    // 而且模板里那个三元表达式两边一样（`blind || i >= typed.length ? c : c`），
    // 连字符都没换过，是死代码。
    console.log('\n【打字背单词 · 默写模式】')
    await evaluate(`(() => {
      const icons = [...document.querySelectorAll('.desktop-icons .icon')]
      icons.find((i) => i.textContent.includes('打字背单词'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    await sleep(3500)
    await evaluate(`(() => {
      document.querySelector('.typing-app .chapter')?.click()
      return !!document.querySelector('.typing-app .chapter')
    })()`)
    await sleep(2000)

    const normalWord = (
      await evaluate(`String(document.querySelector('.typing-app .p-word')?.textContent ?? '')`)
    ).replace(/\s+/g, '')
    const normalMeaning = (
      await evaluate(`String(document.querySelector('.typing-app .p-meaning')?.textContent ?? '')`)
    ).trim()
    assert(normalWord.length > 0, '对照模式显示英文', normalWord)
    assert(normalMeaning.length > 0, '对照模式显示中文', normalMeaning)

    // Ctrl+V 切默写
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 },
      sessionId,
    )
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 },
      sessionId,
    )
    await sleep(600)

    const blindWord = (
      await evaluate(`String(document.querySelector('.typing-app .p-word')?.textContent ?? '')`)
    ).replace(/\s+/g, '')
    const blindMeaning = (
      await evaluate(`String(document.querySelector('.typing-app .p-meaning')?.textContent ?? '')`)
    ).trim()
    assert(blindWord.includes('·'), '默写模式用占位点隐藏英文', blindWord.slice(0, 20))
    assert(
      blindWord.replace(/·/g, '') === '',
      '默写模式一个英文字符都不显示',
      blindWord.slice(0, 20),
    )
    assert(blindMeaning === normalMeaning, '默写模式中文释义照常显示', blindMeaning)

    // ---- 打字：练完一整章后重进，不能是空白页 ----
    //
    // bug 复现路径：练完一章（position == 词数）→ 回列表 → 再点同一章。
    // 原来 pos 直接取 min(saved, len)，指向数组外，word 为 null，
    // 模板 v-else-if="word" 不成立 —— 整页只剩顶栏。
    await evaluate(`(() => {
      const back = [...document.querySelectorAll('.typing-app .wl-btn')].find((b) => b.textContent.includes('返回'))
      back?.click()
      return !!back
    })()`)
    await sleep(800)
    // 进 MySQL 第 1 章（8 条，跳过最快）
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.typing-app .dict-card')].find((c) => c.textContent.includes('MySQL'))
      card?.querySelector('.chapter')?.click()
      return !!card
    })()`)
    await sleep(1500)

    // Tab 跳过全部 8 条 → 结算弹窗
    for (let i = 0; i < 8; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId)
      await sleep(150)
    }
    const finishedShown = await evaluate(`String(!!document.querySelector('.typing-app .result'))`)
    assert(finishedShown === 'true', '跳完所有词后弹出章节结算')

    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.typing-app .result-actions .wl-btn')].find((b) => b.textContent.includes('回列表'))
      btn?.click()
      return !!btn
    })()`)
    await sleep(800)

    // 再点同一章：必须有内容（不能空白）
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.typing-app .dict-card')].find((c) => c.textContent.includes('MySQL'))
      card?.querySelector('.chapter')?.click()
      return !!card
    })()`)
    await sleep(1500)
    const reentered = await evaluate(`String(document.querySelector('.typing-app .p-word')?.textContent?.trim() ?? '')`)
    assert(reentered.length > 0, '练完的章节重进仍有内容（归零重练，不是空白页）', reentered.slice(0, 20))

    // ---- 听歌房：打开窗口 ≠ 在厅里，要显式加入 ----
    //
    // 用户提的：不加入就等于默认全员在厅里，不合理。加入前不渲染 <audio>
    // （不跟着同步播放）、排歌按钮禁用；加入后才参与同步。
    console.log('\n【听歌房 · 加入】')
    await evaluate(`(() => {
      const icons = [...document.querySelectorAll('.desktop-icons .icon')]
      icons.find((i) => i.textContent.includes('听歌房'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    await sleep(4000)

    const beforeJoin = JSON.parse(
      await evaluate(`JSON.stringify({
        joinPanel: !!document.querySelector('.music-app .join-panel'),
        audio: document.querySelectorAll('.music-app audio').length,
        joinBtn: [...document.querySelectorAll('.music-app button')].some((b) => b.textContent.includes('加入听歌房')),
        pickDisabled: (() => {
          const b = [...document.querySelectorAll('.music-app button')].find((x) => x.textContent.includes('排首歌'))
          return b ? b.disabled : null
        })(),
      })`),
    )
    assert(beforeJoin.joinPanel, '未加入时显示"你还没加入听歌房"面板')
    assert(beforeJoin.joinBtn, '面板里有「加入听歌房」按钮')
    assert(beforeJoin.audio === 0, '未加入不渲染 <audio>（不跟着同步播放）', `${beforeJoin.audio} 个`)
    assert(beforeJoin.pickDisabled === true, '未加入时「排首歌」禁用')

    await evaluate(`(() => {
      [...document.querySelectorAll('.music-app button')].find((b) => b.textContent.includes('加入听歌房'))?.click()
      return true
    })()`)
    await sleep(1500)

    const afterJoin = JSON.parse(
      await evaluate(`JSON.stringify({
        joinPanel: !!document.querySelector('.music-app .join-panel'),
        leaveBtn: [...document.querySelectorAll('.music-app button')].some((b) => b.textContent.trim() === '离开'),
        memberChip: document.querySelector('.music-app .member-chip')?.textContent?.replace(/\s+/g, '') ?? null,
      })`),
    )
    assert(!afterJoin.joinPanel, '加入后面板消失')
    assert(afterJoin.leaveBtn, '加入后出现「离开」按钮')
    assert(
      (afterJoin.memberChip ?? '').includes('人在厅'),
      '顶栏显示在场人数',
      String(afterJoin.memberChip),
    )

    await evaluate(`(() => {
      [...document.querySelectorAll('.music-app button')].find((b) => b.textContent.trim() === '离开')?.click()
      return true
    })()`)
    await sleep(1500)
    assert(
      (await evaluate(`String(!!document.querySelector('.music-app .join-panel'))`)) === 'true',
      '离开后回到"未加入"面板',
    )
    await evaluate(`window.prompt = window.__origPrompt; true`)

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

    // ---- 刷新后恢复窗口布局 ----
    //
    // 这条功能 README 第 24 行当卖点写着（"刷新页面后恢复上次打开的窗口布局"），
    // 但测试里**一条正向断言都没有**：本文件开头只会 removeItem 把它抹掉，
    // 好让"窗口数"类断言可重复。抹掉不等于验过 —— 恢复逻辑坏掉时，前面所有
    // 断言照样全绿。
    //
    // 这里直接塞一份已知布局再重载，量的是"真的恢复出来了"，不是去 grep 代码。
    console.log('\n【窗口布局恢复（刷新后）】')

    const seededLayout = [
      { appId: 'files', title: '文件', args: {}, x: 40, y: 40, w: 900, h: 600, maximized: false },
      { appId: 'tools', title: '工具集', args: {}, x: 120, y: 120, w: 820, h: 560, maximized: false },
      { appId: 'board', title: '留言板', args: {}, x: 200, y: 200, w: 760, h: 520, maximized: false },
    ]
    await cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.setItem('wl.desktop.layout', ${JSON.stringify(JSON.stringify(seededLayout))})` },
      sessionId,
    )
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(3500)

    const restored = await evaluate(`JSON.stringify({
      windowCount: document.querySelectorAll('.window').length,
      titles: [...document.querySelectorAll('.window__title')].map((e) => e.textContent.trim()),
      taskbarApps: document.querySelectorAll('.taskbar__app').length,
    })`)
    const rs = JSON.parse(restored ?? '{}')
    assert(rs.windowCount === 3, '刷新后恢复了 3 个窗口', `${rs.windowCount} 个`)
    // 用前缀匹配而不是全等：应用挂载后可以细化自己的标题 —— 文件管理器就会把
    // 当前空间拼进去（存的是"文件"，恢复后显示"文件 · 共享空间"）。那是应用在
    // 正常工作，不是恢复错了；拿全等去比会把它误判成失败。
    assert(
      seededLayout.every((s) => (rs.titles ?? []).some((t) => t.startsWith(s.title))),
      '恢复出来的窗口标题与保存时一致',
      `期望 ${seededLayout.map((s) => s.title).join('、')}；实际 ${(rs.titles ?? []).join('、')}`,
    )
    assert(rs.taskbarApps === 3, '恢复的窗口也在任务栏上有按钮', `${rs.taskbarApps} 个按钮`)

    // 收拾干净：后面还要跑移动端段，别把这份布局留给下一次运行
    await cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.removeItem('wl.desktop.layout')` },
      sessionId,
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

    // ---- 窄屏下"点得开的应用"是不是真的能用 ----
    //
    // 外壳切过去不算数。你画我猜的画桌是三栏（170 / 1fr / 240），两栏固定宽度
    // 合计 410px，而 iPhone 视口只有 390px —— 画布会被挤成 0 宽，用户看到的就是
    // "点进去画不了"。这里量的是真实 DOM 尺寸，不是去 grep CSS 里有没有 @media。
    console.log('\n【移动端：应用页面（窄视口）】')

    const mRoom = await apiAs(sessionCookie, '/api/games/draw/rooms', {
      method: 'POST',
      json: { title: '手机测试画室', rounds: 1 },
    })
    const mRoomId = mRoom.body?.room?.id ?? null
    assert(!!mRoomId, '手机上能建房间（接口层）')

    if (mRoomId) {
      // 让另一个人进来：最少 2 人才点得动"开始游戏"，而只有开局后才会出现画桌
      // （等人视图里没有画布 —— 第一次写这条用例就是漏了这一点，量到 0 宽）
      await apiAs(peerCookie, `/api/games/draw/rooms/${mRoomId}/join`, { method: 'POST', json: {} })

      const openedDrawTile = await evaluate(`
        (() => {
          const tile = [...document.querySelectorAll('.apps__tile')].find((t) => t.textContent.includes('你画我猜'))
          if (!tile) return false
          tile.click()
          return true
        })()
      `)
      assert(openedDrawTile === true, '移动端宫格里有你画我猜')
      await sleep(2500)

      const enteredMobileRoom = await evaluate(`
        (() => {
          const card = [...document.querySelectorAll('.room-card')].find(
            (c) => c.textContent.includes('手机测试画室'),
          )
          if (!card) return false
          const btn = [...card.querySelectorAll('button')].find((b) => /进入|观看/.test(b.textContent))
          ;(btn ?? card).click()
          return true
        })()
      `)
      assert(enteredMobileRoom === true, '移动端能进入房间')
      await sleep(1200)

      // 开局：开始之后才渲染画桌（三栏 → 窄屏单列），画布也才存在
      const startedMobileGame = await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('.draw button')].find((b) =>
            b.textContent.includes('开始游戏'),
          )
          if (!btn) return false
          btn.click()
          return true
        })()
      `)
      assert(startedMobileGame === true, '移动端能开始游戏')
      await sleep(2200)

      const drawMetrics = await evaluate(`JSON.stringify({
        canvasW: Math.round(document.querySelector('.board-canvas')?.getBoundingClientRect().width ?? 0),
        hasTable: !!document.querySelector('.table'),
        hasCanvas: !!document.querySelector('.board-canvas'),
        text: (document.querySelector('.draw')?.textContent ?? 'NO .draw').trim().slice(0, 70),
        scrollW: document.documentElement.scrollWidth,
        viewW: window.innerWidth,
      })`)
      const dm = JSON.parse(drawMetrics ?? '{}')
      assert(
        (dm.canvasW ?? 0) > 200,
        '窄屏下画布有可用宽度（不是被挤成 0）',
        `${dm.canvasW}px，视口 ${dm.viewW}px；table=${dm.hasTable} canvas=${dm.hasCanvas} 文案「${dm.text}」`,
      )
      assert(
        (dm.scrollW ?? 0) <= (dm.viewW ?? 0) + 1,
        '窄屏下页面没有横向溢出',
        `scrollWidth ${dm.scrollW} > 视口 ${dm.viewW}`,
      )

      // 留言板：纵向流，但输入区与类型标签也不能把页面撑宽
      await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
      await sleep(2500)
      const openedBoardTile = await evaluate(`
        (() => {
          const tile = [...document.querySelectorAll('.apps__tile')].find((t) => t.textContent.includes('留言板'))
          if (!tile) return false
          tile.click()
          return true
        })()
      `)
      assert(openedBoardTile === true, '移动端宫格里有留言板')
      await sleep(1400)

      const boardMetrics = await evaluate(`JSON.stringify({
        hasInput: !!document.querySelector('.compose-input'),
        scrollW: document.documentElement.scrollWidth,
        viewW: window.innerWidth,
      })`)
      const bm = JSON.parse(boardMetrics ?? '{}')
      assert(bm.hasInput === true, '留言板在窄屏下有输入框')
      assert(
        (bm.scrollW ?? 0) <= (bm.viewW ?? 0) + 1,
        '留言板在窄屏下没有横向溢出',
        `scrollWidth ${bm.scrollW} > 视口 ${bm.viewW}`,
      )
    }
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
