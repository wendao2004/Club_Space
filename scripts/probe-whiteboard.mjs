/**
 * 白板线上复现探针（排查"白板用不了"之类只在生产暴露的问题）。
 *
 * 为什么需要它：本地测试直连 node 服务，**没有 Caddy 的 CSP、没有 HTTPS、
 * 没有真实网络路径** —— 字体从 CDN 拉、样式没引、语言包加载失败这类
 * 问题本地全绿、线上全挂。这个探针用本地 Chrome（忽略自签证书）连线上
 * 站点，走真实浏览器链路，抓 console 错误 / 未捕获异常 / 失败请求，
 * 并断言画布真的渲染出来了（canvas 尺寸、工具栏、汉化文案）。
 *
 * 用法（cookie 从容器里造临时会话拿，见 docs/部署记录 第二十四轮）：
 *   WB_URL=https://192.168.1.112:9443 WB_COOKIE="wl_session=..." \
 *     NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-whiteboard.mjs
 *
 * 注意：Excalidraw 的字体加载是"候选列表"机制（同源第一、esm.sh 兜底），
 * 兜底尝试被 CSP 拦时 console 里会有 font 相关报错 —— 那是**噪音**，
 * 字体已从同源 200 拿到，不影响功能。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.WB_URL ?? 'https://192.168.1.112:9443'
const cookie = process.env.WB_COOKIE ?? ''
if (!cookie.includes('=')) { console.log('缺 WB_COOKIE'); process.exit(1) }

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.handlers = [] }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(e.error ?? e))
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data)
        for (const h of this.handlers) h(msg)
      })
    })
  }
  on(fn) { this.handlers.push(fn) }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 20000)
      const handler = (msg) => {
        if (msg.id === id) {
          this.handlers = this.handlers.filter((h) => h !== handler)
          clearTimeout(timer)
          if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
          else resolve(msg.result)
        }
      }
      this.handlers.push(handler)
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })
console.log('会话预检：', me.status, (await me.text()).slice(0, 120))

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
const profileDir = join(tmpdir(), 'wl-wbprobe-live')

const net = await import('node:net')
const debugPort = await new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

const child = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--ignore-certificate-errors',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore' })

process.once('exit', () => {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
})

let version = null
for (let i = 0; i < 30; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break } catch { await sleep(500) }
}
if (!version) { console.log('浏览器起不来'); process.exit(1) }

const cdp = new Cdp(version.webSocketDebuggerUrl)
await cdp.connect()

const errors = []
cdp.on((msg) => {
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    errors.push('[console.error] ' + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    errors.push('[exception] ' + (d.exception?.description ?? d.text ?? '').slice(0, 400))
  }
  if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
    errors.push('[log] ' + (msg.params.entry.text ?? '').slice(0, 400) + (msg.params.entry.url ? ` (${msg.params.entry.url})` : ''))
  }
  if (msg.method === 'Network.loadingFailed') {
    errors.push(`[req-failed] ${msg.params.errorText} ${msg.params.blockedReason ?? ''}`)
  }
})

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)
await cdp.send('Log.enable', {}, sessionId)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
await cdp.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }, sessionId)
await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
await sleep(5000)

const evaluate = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
  return r.result?.value
}

console.log('桌面图标：', await evaluate(`JSON.stringify([...document.querySelectorAll('.desktop-icons .icon__label')].map(e=>e.textContent.trim()))`))

await evaluate(`
  (() => {
    const icons = [...document.querySelectorAll('.desktop-icons .icon')]
    const wb = icons.find(i => i.textContent.includes('白板'))
    if (wb) { wb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok' }
    return 'no-icon'
  })()
`)
await sleep(5000)
console.log('打开白板后：', await evaluate(`JSON.stringify({
  windowCount: document.querySelectorAll('.window').length,
  hasWbApp: !!document.querySelector('.wb-app'),
  boardRows: document.querySelectorAll('.wb-app .brow').length,
})`))

await evaluate(`window.prompt = () => '线上探针白板'; true`)
await evaluate(`
  (() => {
    const btn = [...document.querySelectorAll('.wb-app .side-head .wl-icon-btn')].pop()
    btn?.click(); return !!btn
  })()
`)
await sleep(6000)
console.log('新建后：', await evaluate(`JSON.stringify({
  hasCanvas: !!document.querySelector('.wb-app .canvas'),
  excalidrawDom: !!document.querySelector('.wb-app .canvas .excalidraw'),
  canvasChildren: document.querySelector('.wb-app .canvas')?.childElementCount ?? -1,
  canvasSize: (() => { const c = document.querySelector('.wb-app .canvas'); return c ? c.offsetWidth + 'x' + c.offsetHeight : 'none' })(),
  tools: document.querySelectorAll('.wb-app .canvas .excalidraw button').length,
})`))

console.log('中文检查：', await evaluate(`JSON.stringify({
  menuTitles: [...document.querySelectorAll('.wb-app .canvas .excalidraw button[title]')].slice(0, 6).map(b => b.getAttribute('title')),
  cjkText: ((document.querySelector('.wb-app .canvas .excalidraw')?.textContent ?? '').match(/[\\u4e00-\\u9fa5]{2,10}/g) ?? []).slice(0, 8),
  localeRequested: true,
})`))

console.log('\n错误与失败请求（最多 15 条）：')
for (const e of errors.slice(0, 15)) console.log('  •', e)
if (errors.length === 0) console.log('  （无）')
process.exit(0)
