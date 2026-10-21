/**
 * 视频预览在真实浏览器里能不能播、能不能拖进度条。
 *
 * 为什么光有 file-range-test 还不够：那条测试钉死的是服务端的 206 语义，
 * 但用户的症状发生在浏览器里 —— `<video>` 有没有拿到元数据、
 * `currentTime` 一设、`seeked` 事件有没有来、画面有没有真的跳过去。
 * 这条测试用真 Chrome 把整条链走一遍：
 *
 *   1. 页面里用 canvas.captureStream + MediaRecorder 现录一个 2 秒的 webm
 *      （仓库里没有现成视频，现录的才是真编码器产物，seek 才有意义）；
 *   2. 从页面里把它上传（走的就是前端同款接口与鉴权）；
 *   3. 建一个 `<video>` 指向 preview 接口，等 loadedmetadata；
 *   4. 设 `currentTime` 跳到中段，断言 `seeked` 触发且位置真的变了；
 *   5. 顺带用 CDP 的网络事件确认浏览器拿到的关键响应确实是 206。
 *
 * MediaRecorder 产出的 webm 没有 duration 元数据（Chrome 的老毛病，
 * duration 会是 Infinity），所以断言不依赖 duration，只依赖 seek 行为本身。
 *
 * 用法：先启动后端（由 run-all-tests.mjs 代劳），然后 node scripts/video-seek-test.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
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

// ---------------------------------------------------------------- CDP（与 ui-smoke 同款，精简版）

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.handlers = []
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
        for (const h of this.handlers) h(msg)
      })
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 30_000)
    })
  }

  on(handler) {
    this.handlers.push(handler)
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForDevtools(port) {
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error('浏览器 DevTools 端口迟迟未就绪')
}

function killProcessTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 尽力而为 */
  }
}

// ---------------------------------------------------------------- 准备会话

console.log('【准备】')

const VSEEK_USER = `vseek${SUFFIX}`
const VSEEK_PASS = 'vseek-password-2026'

const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: VSEEK_USER,
    displayName: `视频 seek 测试${SUFFIX}`,
    password: VSEEK_PASS,
  }),
})
let sessionCookie
if (reg.ok) {
  ok('注册测试账号（首次运行即成为创建者）')
  sessionCookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
} else {
  // 库里已有其他用户（比如手动重复跑）：用同名账号登录。这个名字上次运行
  // 注册成功过，密码是写死的，登录得上；登录不上就真的是环境不对了。
  const existing = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: VSEEK_USER, password: VSEEK_PASS }),
  })
  if (!existing.ok) {
    bad('准备会话', `注册 ${reg.status}，同名登录也不可用（${existing.status}）`)
    process.exit(1)
  }
  ok('使用上次运行注册的账号登录')
  sessionCookie = (existing.headers.get('set-cookie') ?? '').split(';')[0]
}
assert(sessionCookie.length > 0, '拿到会话 cookie')
const [cookieName, cookieValue] = sessionCookie.split('=')

// ---------------------------------------------------------------- 起浏览器

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.log('  \x1b[33m未找到 Chrome/Edge，跳过\x1b[0m')
  process.exit(0)
}

const profileDir = join(tmpdir(), `wl-video-seek-${SUFFIX}`)
rmSync(profileDir, { recursive: true, force: true })
const debugPort = await findFreePort()

const child = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

const killChild = () => killProcessTree(child.pid)
process.once('exit', killChild)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    killChild()
    process.exit(1)
  })
}

let cdp
try {
  const version = await waitForDevtools(debugPort)
  ok('浏览器已启动', version.Browser ?? '')

  cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.connect()
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Network.enable', {}, sessionId)

  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
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
  await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId)
  await sleep(2500)

  // 统计 preview 请求的响应状态：拖进度条若真的生效，浏览器一定会发 Range
  // 并拿到 206 —— 这是"浏览器侧确认"的最后一块拼图。
  // 请求头要从 requestWillBeSent 拿，responseReceived 里不带。
  const requestRanges = new Map()
  const previewResponses = []
  cdp.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const url = msg.params?.request?.url ?? ''
      if (url.includes('/api/files/')) {
        requestRanges.set(msg.params.requestId, msg.params.request.headers?.Range ?? null)
      }
      return
    }
    if (msg.method !== 'Network.responseReceived') return
    const url = msg.params?.response?.url ?? ''
    if (url.includes('/api/files/')) {
      previewResponses.push({
        status: msg.params.response.status,
        range: requestRanges.get(msg.params.requestId) ?? null,
      })
    }
  })

  /** 页面里跑一段 async 函数并拿回结果。 */
  async function evaluate(expression) {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面内脚本异常')
    }
    return result.result?.value
  }

  // ---- 录一个真视频并上传 ----
  console.log('\n【页面内录制并上传视频】')

  const uploadResult = await evaluate(`(async () => {
    try {
      // -- 录制：每 50ms 推一帧，颜色逐帧变化，保证编码器有内容可压 --
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const ctx = canvas.getContext('2d')
      const stream = canvas.captureStream(0)
      const track = stream.getVideoTracks()[0]
      const mime = ['video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
      if (!mime) return { error: '浏览器不支持 MediaRecorder webm' }
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      const chunks = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      const stopped = new Promise((resolve) => { recorder.onstop = resolve })
      recorder.start()
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = 'rgb(' + (i * 6) + ',' + (255 - i * 6) + ',' + ((i * 13) % 255) + ')'
        ctx.fillRect(0, 0, 320, 240)
        ctx.fillStyle = '#fff'
        ctx.font = '24px monospace'
        ctx.fillText('frame ' + i, 20, 120)
        track.requestFrame()
        await new Promise((r) => setTimeout(r, 50))
      }
      recorder.stop()
      await stopped
      const blob = new Blob(chunks, { type: mime })
      if (blob.size < 1000) return { error: '录出来的视频太小: ' + blob.size }

      // -- 上传：与前端 api.ts 同款的三步分片 --
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const initRes = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: null, name: 'seek-test.webm', size: bytes.byteLength, sha256: sha, space: 'shared' }),
      })
      if (!initRes.ok) return { error: '开启上传失败: ' + initRes.status }
      const init = await initRes.json()
      if (init.instant) return { error: '意外命中秒传' }
      const putRes = await fetch('/api/uploads/' + init.uploadId + '/chunk?offset=0', {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      })
      if (!putRes.ok) return { error: '上传分片失败: ' + putRes.status }
      const doneRes = await fetch('/api/uploads/' + init.uploadId + '/complete', { method: 'POST' })
      if (!doneRes.ok) return { error: '完成上传失败: ' + doneRes.status }
      const done = await doneRes.json()
      return { nodeId: done.nodeId, mime: done.mime, size: bytes.byteLength }
    } catch (err) {
      return { error: String(err && err.stack ? err.stack : err) }
    }
  })()`)

  assert(!uploadResult?.error, '页面内录制 + 上传成功', uploadResult?.error ?? '')
  assert(uploadResult?.mime === 'video/webm', '上传被识别为 video/webm', String(uploadResult?.mime))

  if (!uploadResult?.nodeId) {
    console.log('  \x1b[33m没有可用的视频节点，后续断言跳过\x1b[0m')
    process.exit(failed > 0 ? 1 : 0)
  }

  // ---- 播放与 seek ----
  console.log('\n【真实浏览器里的播放与拖动进度条】')

  const playResult = await evaluate(`(async () => {
    try {
      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.src = '/api/files/${uploadResult.nodeId}/preview'
      document.body.appendChild(video)

      const once = (el, ev, timeout) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等 ' + ev + ' 超时（' + timeout + 'ms）')), timeout)
        el.addEventListener(ev, () => { clearTimeout(t); resolve() }, { once: true })
      })

      await once(video, 'loadedmetadata', 20000)
      const readyAfterMeta = video.readyState
      const duration = video.duration
      const seekableEnd = video.seekable.length > 0 ? video.seekable.end(0) : null
      if (seekableEnd === null || seekableEnd <= 0) {
        return { error: 'seekable 为空，浏览器认为这个源不能拖', readyAfterMeta, duration }
      }

      // 拖到可拖范围的 60% 处 —— MediaRecorder 的 webm duration 是 Infinity，
      // 用 seekable 的实际终点做目标，不依赖 duration 元数据
      const target = seekableEnd * 0.6
      video.currentTime = target
      await once(video, 'seeked', 15000)
      const afterSeek = video.currentTime
      // 拖过去之后画面真的有内容（HAVE_CURRENT_DATA 及以上）
      const readyAfterSeek = video.readyState

      // 再拖回开头附近，模拟"拖回去"的操作
      video.currentTime = 0.05
      await once(video, 'seeked', 15000)
      const afterSeekBack = video.currentTime

      return {
        readyAfterMeta,
        duration,
        seekableEnd,
        target,
        afterSeek,
        afterSeekBack,
        readyAfterSeek,
        videoW: video.videoWidth,
        videoH: video.videoHeight,
      }
    } catch (err) {
      return { error: String(err && err.stack ? err.stack : err) }
    }
  })()`)

  assert(!playResult?.error, 'video 加载出元数据且 seekable 非空', playResult?.error ?? JSON.stringify(playResult))
  if (playResult && !playResult.error) {
    assert(playResult.videoW > 0 && playResult.videoH > 0, '视频尺寸解码成功', `${playResult.videoW}x${playResult.videoH}`)
    assert(
      Math.abs(playResult.afterSeek - playResult.target) < 0.5,
      '拖到 60% 处，位置到位',
      `目标 ${playResult.target.toFixed(2)}s，实际 ${playResult.afterSeek.toFixed(2)}s`,
    )
    assert(playResult.afterSeek > 0.5, '位置确实跳过了开头', `${playResult.afterSeek.toFixed(2)}s`)
    assert(playResult.afterSeekBack < 0.5, '再拖回开头也到位', `${playResult.afterSeekBack.toFixed(2)}s`)
    assert(playResult.readyAfterSeek >= 2, '拖过去后画面已就绪（HAVE_CURRENT_DATA+）', `readyState=${playResult.readyAfterSeek}`)
  }

  // ---- 浏览器拿到的响应确实是 206 ----
  console.log('\n【网络层验证】')

  const withRange = previewResponses.filter((r) => r.range && r.status === 206)
  assert(
    withRange.length > 0,
    '浏览器发出的 Range 请求拿到了 206',
    JSON.stringify(previewResponses.slice(0, 5)),
  )
} finally {
  killChild()
  child.kill()
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* profile 偶尔被句柄占住，尽力而为 */
  }
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
// Chrome 是 detached 的子进程，它的句柄会让 Node 不肯自然退出 —— 显式走
process.exit(failed > 0 ? 1 : 0)
