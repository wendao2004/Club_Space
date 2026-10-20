/**
 * 桌面交互的性能探针。
 *
 * 用法：先起一个后端（`WL_PORT=3311 node server/src/index.ts`），然后
 *   WL_PERF_BASE=http://127.0.0.1:3311 node scripts/perf-probe.mjs
 *
 * 它用真实 Chrome 开三个窗口、按住标题栏拖 60 步，统计拖拽期间的 rAF 帧间隔。
 * "卡不卡"最后就是这个数 —— 靠肉眼看动画判断不出 26 fps 和 33 fps 的差别，
 * 但手上能感觉到，改完之后也能确认到底有没有变好。
 *
 * 几个容易踩的坑，写在这里免得下次重踩：
 *  1. `Input.dispatchMouseEvent` **不要 await**。每次 CDP 往返 2-5ms，await 进去
 *     会把事件间隔拉到 25ms 以上，测出来的是管道速度而不是渲染速度。
 *  2. `Runtime.evaluate` 的输出必须落盘再看：`| tail` 会把整段输出吞掉。
 *  3. 注册第二个账号会 403（首个用户之后需要邀请码），所以脚本走"注册失败就
 *     登录"，账号密码可用 WL_PERF_USER / WL_PERF_PASS 覆盖。
 *
 * 无头浏览器是软件渲染，绝对值比真机差（没有 GPU 合成）。它的用处是**对比**：
 * 改之前跑一次、改之后跑一次。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.WL_PERF_BASE ?? 'http://127.0.0.1:3311'
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(String(e.message ?? e))))
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id === undefined) return
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(msg.error.message))
        else waiter.resolve(msg.result)
      })
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

async function waitDevtools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起 */
    }
    await sleep(200)
  }
  throw new Error('DevTools 没起来')
}

async function main() {
  if (!CHROME) {
    console.log('没有 Chrome，跳过')
    return
  }
  const user = process.env.WL_PERF_USER ?? 'perfprobe'
  const password = process.env.WL_PERF_PASS ?? 'perf-pass-2026'
  let reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, displayName: '性能探针', password }),
  })
  if (!reg.ok) {
    reg = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
    })
  }
  if (!reg.ok) throw new Error(`登录失败 ${reg.status}`)
  const [cookieName, cookieValue] = (reg.headers.get('set-cookie') ?? '').split(';')[0].split('=')

  const debugPort = await freePort()
  const profileDir = join(tmpdir(), `wl-perf-${Date.now()}`)
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const version = await waitDevtools(debugPort)
    const cdp = new Cdp(version.webSocketDebuggerUrl)
    await cdp.connect()

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.send(
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

    const evaluate = async (expression) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result?.value
    }

    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(4500)

    // 清掉旧布局并重载，保证每次都是同样的窗口组合
    await evaluate(`localStorage.removeItem('wl.desktop.layout'), true`)
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
    await sleep(4000)

    // 开三个窗口：聊天、文件、设置（模拟真实使用下的多窗口）
    for (const name of ['聊天', '文件', '设置']) {
      await evaluate(`document.querySelector('.taskbar__start').click()`)
      await sleep(400)
      await evaluate(`
        (() => {
          const t = [...document.querySelectorAll('.start__tile')].find((x) => x.textContent.includes(${JSON.stringify(name)}))
          if (t) t.click()
          return !!t
        })()
      `)
      await sleep(1200)
    }

    const windowCount = await evaluate(`document.querySelectorAll('.window').length`)
    console.log(`窗口数：${windowCount}`)

    // 找最上面那个窗口的标题栏坐标
    const target = await evaluate(`
      (() => {
        const wins = [...document.querySelectorAll('.window')]
        const w = wins[wins.length - 1]
        if (!w) return null
        const bar = w.querySelector('.window__titlebar')
        const r = bar.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) })
      })()
    `)
    const { x, y } = JSON.parse(target)

    // 开始采样帧
    await evaluate(`
      (() => {
        window.__frames = []
        window.__stop = false
        const tick = (t) => { window.__frames.push(t); if (!window.__stop) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        return true
      })()
    `)

    const mouse = (type, px, py, buttons = 1) =>
      cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: px, y: py, button: 'left', buttons, clickCount: 1 },
        sessionId,
      )

    await mouse('mousePressed', x, y)
    // 不 await：每个 CDP 往返要 2-5ms，await 进去会把事件间隔拉长到 25ms 以上，
    // 测出来的"帧率"其实是这条管道的速度，而不是页面的渲染速度。
    for (let i = 1; i <= 60; i++) {
      void mouse('mouseMoved', x + i * 4, y + Math.sin(i / 6) * 30)
      await sleep(16)
    }
    await mouse('mouseReleased', x + 240, y, 0)
    await sleep(300)

    const frames = await evaluate(`window.__stop = true, JSON.stringify(window.__frames)`)
    const list = JSON.parse(frames)
    const gaps = []
    for (let i = 1; i < list.length; i++) gaps.push(list[i] - list[i - 1])
    gaps.sort((a, b) => a - b)
    const pct = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0
    const avg = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)

    console.log(`\n拖拽期间帧数：${list.length}`)
    console.log(`平均帧间隔：${avg.toFixed(1)} ms  (≈${(1000 / avg).toFixed(1)} fps)`)
    console.log(`p50 ${pct(0.5).toFixed(1)}ms  p90 ${pct(0.9).toFixed(1)}ms  p99 ${pct(0.99).toFixed(1)}ms  max ${gaps[gaps.length - 1]?.toFixed(1)}ms`)

    // 再测一次"静态"下的空闲帧，作为对照
    await evaluate(`
      (() => {
        window.__frames = []
        window.__stop = false
        const tick = (t) => { window.__frames.push(t); if (!window.__stop) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        return true
      })()
    `)
    await sleep(1000)
    const idle = JSON.parse(await evaluate(`window.__stop = true, JSON.stringify(window.__frames)`))
    console.log(`空闲 1 秒的帧数：${idle.length}`)
  } finally {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
