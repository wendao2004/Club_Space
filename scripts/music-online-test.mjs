/**
 * 在线曲库（哔哩哔哩搜索 + 服务端代理拉流）的 HTTP 层测试。
 *
 * 四条命脉：
 *   ① SSRF 防线：/online/stream 只认 bi:BV...，任何 URL / 主机名 / 别的平台前缀
 *      都必须 400 —— 它拿着服务端的网络出口去 fetch，放开一个口子等于给全内网开一台代理。
 *   ② 上游不可用不是本服务的故障：搜索必须仍然 200 + degraded:true，绝不许 5xx。
 *   ③ 换 provider 最容易错的两处数据整形：标题里的 <em> 高亮标签必须剥掉，
 *      duration "4:30" 是字符串必须解析成毫秒（上一版那条口径是毫秒）。
 *   ④ Range 请求绝不能每次都去打 playurl：<audio> 一次播放会打出几十上百个
 *      Range，每个都解析一次既卡成幻灯片又会触发 B 站风控。
 *
 * 这个套件必须在**断网机器上也能全绿**：先按「生日快乐」探一次真实上游，探测到
 * degraded:true 就把依赖真实上游的断言打印成 skip，而不是判失败 —— 否则"这台 NAS
 * 今天没网"会变成一次假红灯，把真正的回归埋掉。纯函数那一段永远跑，永不 skip。
 *
 * 用法：node scripts/music-online-test.mjs（run-all-tests.mjs 会自己起服务端）
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)
const PASSWORD = 'online-pass-2026'

/**
 * 服务端"每一次真实上游调用落一行"的文件。
 *
 * 为什么需要它：验收"两次 Range 之间 playurl 只被打一次"必须**跨进程**观察 ——
 * 本脚本在另一个进程里，只能通过 HTTP 摸服务端。run-all-tests.mjs 会给服务端
 * 设这个变量；直接手跑（自己起的服务端没开它）时这里读不到任何行，于是打印 skip。
 */
const TRACE_PATH =
  process.env.WL_MUSIC_ONLINE_TRACE ?? fileURLToPath(new URL('../.test-music-online-trace.log', import.meta.url))

let passed = 0
let failed = 0
let skipped = 0

function dim(s) { return '\x1b[90m' + s + '\x1b[0m' }
function ok(name, extra) { passed += 1; console.log('  \x1b[32m✓\x1b[0m ' + name + (extra ? '  ' + dim(extra) : '')) }
function bad(name, detail) { failed += 1; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      \x1b[31m' + (detail || '断言失败') + '\x1b[0m') }
function assert(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail) }
function eq(actual, expected, name) { assert(actual === expected, name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)) }
function skip(name, reason) { skipped += 1; console.log('  \x1b[33m∅\x1b[0m ' + name + '  ' + dim('跳过：' + reason)) }

// ---------------------------------------------------------------- 本进程内的曲库模块（上游 = 本地 stub）

/**
 * 为什么这里要自己起一个 stub 上游、并且用**动态 import** 加载曲库模块：
 *
 * 这次事故的通用形态是"上游回 200，但一条 cookie 都不下发" —— 而当时的
 * bootstrapCookie 把"手上有 cookie"当成硬前置，于是整条曲库静默全灭。要长期
 * 防住它，断言就不能依赖真实上游（上游随时会变），也不能通过 HTTP 摸服务端
 * （服务端进程的上游地址在它启动那一刻就固定了）。所以：先在随机端口起一个
 * stub，把四个 WL_MUSIC_ONLINE_*_URL 指过去，**再** import 模块 —— 端点是
 * import 时读的 env，于是本进程里这一份实例的上游就是这个 stub。
 * 走真实服务端的断言仍然打在另一个进程里，两边互不干扰。
 */
const stub = { home: 0, search: 0, cookieOnSearch: [], riskLeft: 0, pagelist: 0, playurl: 0, audio: 0, audioQualities: [] }

/**
 * stub 的"音频本体"：一份确定性的字节序列。
 *
 * 为什么要自己造字节而不是打真实 CDN：磁盘缓存的断言是"发出去的字节数 == 缓存
 * 文件大小"和"第二次请求零上游命中"——前者需要知道确切的长度，后者需要能数上游
 * 调用次数。真实 CDN 两样都给不了。
 */
const STUB_AUDIO = Uint8Array.from({ length: 98304 }, (_, i) => (i * 7 + 13) & 0xff)

/** 音频地址的 host 必须是 0.0.0.0：服务端 toSafeMediaUrl 会挡掉 127./10./192.168. 这些私网段，
 *  而 0.0.0.0 不在黑名单里、连接时又被系统当成回环 —— 这是"零外网地测完整代理链"的唯一入口。 */
let STUB_AUDIO_BASE = ''

/** 20 条"像 B 站搜索回包"的记录：带 <em> 高亮、duration 是 "4:30" 字符串。 */
const STUB_RESULTS = Array.from({ length: 20 }, (_, i) => ({
  bvid: 'BV' + ('stub' + i).padEnd(10, 'x'),
  title: '<em class="keyword">晴天</em> 第 ' + (i + 1) + ' 首（stub）',
  author: 'stub UP 主',
  duration: '4:30',
}))

const stubServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/home') {
    stub.home += 1
    // 关键：200 但**一个 set-cookie 都没有**。set-cookie 只在这里、且永远不发。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>stub</body></html>')
    return
  }
  if (url.pathname === '/search') {
    stub.search += 1
    stub.cookieOnSearch.push(req.headers.cookie ?? null)
    const keyword = url.searchParams.get('keyword') ?? ''
    const risk = keyword.includes('风控') && stub.riskLeft > 0
    if (risk) stub.riskLeft -= 1
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(risk ? { code: -352, message: '风控校验失败' } : { code: 0, data: { result: STUB_RESULTS } }))
    return
  }
  if (url.pathname === '/pagelist') {
    stub.pagelist += 1
    const bvid = url.searchParams.get('bvid') ?? ''
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 0, data: [{ cid: 2000 + (bvid.charCodeAt(4) || 0) }] }))
    return
  }
  if (url.pathname === '/playurl') {
    stub.playurl += 1
    const bvid = url.searchParams.get('bvid') ?? ''
    // 两档码率，故意把低码率排在数组前面：断言"取 192 那档"才能证明真按 bandwidth 降序。
    const audio = [
      { baseUrl: STUB_AUDIO_BASE + '/audio?bvid=' + bvid + '&q=64', backupUrl: [], bandwidth: 30216 },
      { baseUrl: STUB_AUDIO_BASE + '/audio?bvid=' + bvid + '&q=192', backupUrl: [], bandwidth: 30280 },
    ]
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 0, data: { dash: { audio } } }))
    return
  }
  if (url.pathname === '/audio') {
    stub.audio += 1
    stub.audioQualities.push(url.searchParams.get('q') ?? '')
    const total = STUB_AUDIO.byteLength
    const range = req.headers.range
    let start = 0
    let end = total - 1
    let status = 200
    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (m) {
        const rawStart = m[1] ?? ''
        const rawEnd = m[2] ?? ''
        if (!rawStart && rawEnd) {
          start = Math.max(0, total - Number(rawEnd))
        } else {
          start = Number(rawStart || 0)
          end = rawEnd ? Math.min(Number(rawEnd), total - 1) : total - 1
        }
        if (start >= total) {
          res.writeHead(416, { 'content-range': 'bytes */' + total })
          res.end()
          return
        }
        status = 206
      }
    }
    const headers = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
    }
    if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + total
    res.writeHead(status, headers)
    res.end(Buffer.from(STUB_AUDIO.subarray(start, end + 1)))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end('{"code":-404}')
})
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
stubServer.unref()
const STUB_BASE = 'http://127.0.0.1:' + stubServer.address().port
STUB_AUDIO_BASE = 'http://0.0.0.0:' + stubServer.address().port
process.env.WL_MUSIC_ONLINE_HOME_URL = STUB_BASE + '/home'
process.env.WL_MUSIC_ONLINE_SEARCH_URL = STUB_BASE + '/search'
process.env.WL_MUSIC_ONLINE_PAGELIST_URL = STUB_BASE + '/pagelist'
process.env.WL_MUSIC_ONLINE_PLAYURL_URL = STUB_BASE + '/playurl'

// stub 的上游调用不能写进服务端那份 trace 文件：那边在用"行数"做 playurl 计数断言。
const TRACE_ENV_SAVED = process.env.WL_MUSIC_ONLINE_TRACE
delete process.env.WL_MUSIC_ONLINE_TRACE

/**
 * 本进程的磁盘缓存目录。
 *
 * 曲库模块的缓存目录来自 config.ts 的 TMP_DIR，而那个常量是 **import 时** 读
 * WL_TMP_DIR 的 —— 所以必须在 import 之前指过去。指到 mkdtemp 的目录里是为了
 * 绝不写进开发库的 data/：测试污染开发数据是最难查的一类事故。
 */
const CACHE_TMP_DIR = mkdtempSync(join(tmpdir(), 'wl-online-cache-'))
process.env.WL_TMP_DIR = CACHE_TMP_DIR

const {
  MUSIC_ONLINE_DEGRADED_MESSAGE,
  MUSIC_ONLINE_NO_AUDIO_MESSAGE,
  MUSIC_ONLINE_PROVIDER,
  ONLINE_CACHE_MAX_BYTES,
  attachOnlineCacheTee,
  openCachedOnlineTrack,
  openOnlineStream,
  parseDurationMs,
  parseOnlineTrackId,
  prewarmOnlineTrack,
  resolveOnlineStreamSource,
  searchOnlineTracks,
} = await import('../server/src/music-online.ts')

if (TRACE_ENV_SAVED !== undefined) process.env.WL_MUSIC_ONLINE_TRACE = TRACE_ENV_SAVED

// ---------------------------------------------------------------- 客户端

function makeClient() {
  const jar = { cookie: '' }
  const request = async function request(path, method = 'GET', body, extraHeaders = null, timeoutMs = 0) {
    const headers = Object.assign({}, extraHeaders ?? {})
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (jar.cookie) headers.cookie = jar.cookie
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) jar.cookie = setCookie.split(';')[0]
    const text = await res.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed, headers: res.headers }
  }
  request.jar = jar
  return request
}

/** 取流要原样看响应头与字节，不能经过 JSON 解析。 */
async function streamRaw(client, id, extraHeaders) {
  const headers = Object.assign({}, extraHeaders ?? {})
  if (client.jar.cookie) headers.cookie = client.jar.cookie
  return await fetch(BASE + '/api/music/online/stream?id=' + encodeURIComponent(id), { headers })
}

function searchUrl(q, extra) {
  const base = '/api/music/online/search?q=' + encodeURIComponent(q)
  return extra ? base + '&' + extra : base
}

const hex = (bytes) => Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
const bvidOf = (track) => String(track.id ?? '').replace(/^bi:/, '')

/** 把观测窗口清零（窗口 = 一次或几次 Range 请求期间新增的上游调用）。 */
function resetTrace() {
  try { writeFileSync(TRACE_PATH, '') } catch { /* 没有 trace 就只是观测不到，不是失败 */ }
}

function countTrace(tag) {
  let text = ''
  try { text = readFileSync(TRACE_PATH, 'utf8') } catch { return -1 }
  let n = 0
  for (const line of text.split('\n')) if (line === tag) n += 1
  return n
}

function traceAll() {
  try { return readFileSync(TRACE_PATH, 'utf8') } catch { return '' }
}

/**
 * 按前缀计数。cache-hit 那行后面跟着文件大小（`cache-hit <bvid> <size>`），
 * 全等匹配数不到，但前缀是稳定的。
 */
function countTracePrefix(prefix) {
  let text = ''
  try { text = readFileSync(TRACE_PATH, 'utf8') } catch { return -1 }
  let n = 0
  for (const line of text.split(String.fromCharCode(10))) if (line.startsWith(prefix)) n += 1
  return n
}

/** 把任意可读流读成 Buffer（缓存/代理两侧的字节断言都要它）。 */
async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------- 纯函数（永不 skip）

console.log('\n【曲目 ID 解析（SSRF 白名单本体）】')
{
  eq(parseOnlineTrackId('bi:BV1BZbSzZEGT'), 'BV1BZbSzZEGT', '合法 bi:BV... → 取出 bvid')
  eq(parseOnlineTrackId('  bi:BV1BZbSzZEGT  '), 'BV1BZbSzZEGT', '前后空白会被 trim 掉')
  eq(parseOnlineTrackId('bi:BV1BZbSzZEG'), null, 'BV 后面只有 9 位 → null')
  eq(parseOnlineTrackId('bi:BV1BZbSzZEGTX'), null, 'BV 后面 11 位 → null')
  eq(parseOnlineTrackId('bi:bv1BZbSzZEGT'), null, '小写 bv 前缀 → null（B 站区分大小写）')
  eq(parseOnlineTrackId('BV1BZbSzZEGT'), null, '少了 bi: 前缀 → null')
  eq(parseOnlineTrackId('ne:60371'), null, '旧 provider 前缀 ne: → null')
  eq(parseOnlineTrackId('bi:BV1BZbSzZEGT/x'), null, '带路径尾巴 → null')
  eq(parseOnlineTrackId('http://127.0.0.1:3000/api/health'), null, '整条 URL → null')
  eq(parseOnlineTrackId(undefined), null, 'undefined → null')
  eq(parseOnlineTrackId(12345), null, '数字 → null')
}

console.log('\n【时长解析（B 站给的是 "4:30" 字符串）】')
{
  eq(parseDurationMs('4:30'), 270000, '"4:30" → 270000ms')
  eq(parseDurationMs('0:07'), 7000, '"0:07" → 7000ms')
  eq(parseDurationMs('1:02:33'), 3753000, '"1:02:33" → 3753000ms（超过一小时）')
  eq(parseDurationMs('99:00'), 5940000, '"99:00" → 5940000ms')
  eq(parseDurationMs(270), 270000, '裸数字 270 按秒算 → 270000ms')
  eq(parseDurationMs('270'), 0, '裸数字字符串 "270" 不是时分秒格式 → 0（宁可 0 也不要错）')
  eq(parseDurationMs(''), 0, '空串 → 0')
  eq(parseDurationMs('abc'), 0, '乱码 → 0')
  eq(parseDurationMs('1:2:3:4'), 0, '四段 → 0')
  eq(parseDurationMs(null), 0, 'null → 0')
  eq(MUSIC_ONLINE_PROVIDER, 'bilibili', 'provider 常量是 bilibili')
}

// ---------------------------------------------------------------- 账号

const anon = makeClient()
const admin = makeClient()
{
  let res = await admin('/api/auth/register', 'POST', { username: 'onlineown' + SUFFIX, displayName: '调度者', password: PASSWORD })
  if (res.status !== 200) res = await admin('/api/auth/login', 'POST', { username: 'onlineown' + SUFFIX, password: PASSWORD })
  assert(res.status === 200, '账号就绪：管理员', 'status=' + res.status)
}

async function makeMember(username, display) {
  const client = makeClient()
  const invite = await admin('/api/admin/invites', 'POST', { role: 'member', maxUses: 1, expiresInDays: 1, note: 'online 测试' })
  let res = await client('/api/auth/register', 'POST', { username, displayName: display, password: PASSWORD, inviteCode: invite.body?.code })
  if (res.status !== 200) res = await client('/api/auth/login', 'POST', { username, password: PASSWORD })
  assert(res.status === 200, '账号就绪：' + display, 'status=' + res.status)
  return client
}

const alice = await makeMember('onlinealice' + SUFFIX, '小爱')
const bob = await makeMember('onlinebob' + SUFFIX, '小波')

// ---------------------------------------------------------------- 鉴权与参数

console.log('\n【鉴权与参数校验】')

{
  eq((await anon(searchUrl('生日快乐'))).status, 401, '未登录搜在线曲库 → 401')
  eq((await anon('/api/music/online/stream?id=bi:BV1BZbSzZEGT')).status, 401, '未登录取流 → 401')

  let res = await alice('/api/music/online/search')
  eq(res.status, 400, '缺 q → 400')
  assert(String(res.body?.error ?? '').includes('关键词'), '400 文案点明关键词', String(res.body?.error ?? ''))

  res = await alice(searchUrl('   '))
  eq(res.status, 400, 'q 全是空白 → 400（去空白后为空）')

  res = await alice(searchUrl('x'.repeat(61)))
  eq(res.status, 400, 'q 61 字 → 400（上限 60）')

  res = await alice(searchUrl('x'.repeat(60)))
  eq(res.status, 200, 'q 正好 60 字 → 200（边界放行）')

  // limit 越界/非法只做夹取，不 400 —— 前端传坏参数不该是一次搜索失败
  eq((await alice(searchUrl('limitprobe', 'limit=999'))).status, 200, 'limit=999 → 200（夹到 30）')
  eq((await alice(searchUrl('limitprobe', 'limit=abc'))).status, 200, 'limit=abc → 200（回落到 20）')
}

// ---------------------------------------------------------------- SSRF

console.log('\n【SSRF 防线（stream 只认 bi:BV...）】')

{
  const hostile = [
    'http://127.0.0.1:3000/api/health',
    'https://api.bilibili.com/x/player/playurl?bvid=BV1BZbSzZEGT',
    'file:///etc/passwd',
    'ne:60371',
    'bi:60371',
    'bi:BV1BZbSzZEG',
    'bi:BV1BZbSzZEGTX',
    'bi:bv1BZbSzZEGT',
    'bi:BV1BZbSzZEGT/../../etc/passwd',
    'bi:%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    'BV1BZbSzZEGT',
    '',
  ]
  for (const id of hostile) {
    const res = await alice('/api/music/online/stream?id=' + encodeURIComponent(id))
    eq(res.status, 400, '拒绝 id=' + (id === '' ? '(空)' : id))
    assert(!JSON.stringify(res.body ?? '').includes('127.0.0.1'), '错误体不回显请求里的地址', id)
  }
  eq((await alice('/api/music/online/stream')).status, 400, '完全缺 id → 400')
}

// ---------------------------------------------------------------- 限流

console.log('\n【限流按账号（搜索 20 次/分钟）】')

{
  let firstRejected = 0
  let rejections = 0
  for (let i = 1; i <= 21; i += 1) {
    let res = { status: 0 }
    // 每次只给 1.2s：被限流是立刻返回的，慢说明它在等上游（也算"没被拦"）
    try { res = await bob(searchUrl('限流探测'), 'GET', undefined, null, 1200) } catch { res = { status: 0 } }
    if (res.status === 429) { rejections += 1; if (!firstRejected) firstRejected = i }
  }
  eq(firstRejected, 21, '第 21 次才被拦（前 20 次放行）')
  assert(rejections >= 1, '超限返回 429', '共 ' + rejections + ' 次')
  assert(rejections <= 2, '次数不会莫名其妙多', '共 ' + rejections + ' 次')

  const other = await alice(searchUrl('限流不误伤'))
  assert(other.status !== 429, '换个账号不受影响（按 userId 计，不是按 IP）', 'status=' + other.status)
}

// ---------------------------------------------------------------- 搜索

console.log('\n【搜索：真实上游 / 断网降级】')

const KEYWORD = '晴天'
const found = await alice(searchUrl(KEYWORD))
eq(found.status, 200, '搜索永远 200（外网不通也不许 5xx）')
const payload = found.body ?? {}
eq(payload.query, KEYWORD, '原样回显 query')
eq(payload.provider, MUSIC_ONLINE_PROVIDER, 'provider=bilibili')
eq(payload.provider, 'bilibili', 'provider 契约值就是 bilibili')

const roomBefore = (await admin('/api/music/room')).body
const online = payload.degraded === false

if (online) {
  assert(true, '外网探测：通（跑真实上游断言）')
  const results = Array.isArray(payload.results) ? payload.results : []
  assert(results.length > 0, '搜到了结果', results.length + ' 条')
  const first = results[0] ?? {}
  assert(/^bi:BV[0-9A-Za-z]{10}$/.test(String(first.id ?? '')), 'id 形如 bi:BV + 10 位', String(first.id))
  assert(typeof first.name === 'string' && first.name.length > 0, 'name 非空字符串', String(first.name))
  assert(!/[<>]/.test(String(first.name)), 'name 里没有 HTML 标签（<em> 高亮已剥掉）', String(first.name))
  assert(!/&(amp|lt|gt|quot|#39);/.test(String(first.name)), 'name 里没有残留 HTML 实体', String(first.name))
  assert(typeof first.artist === 'string' && first.artist.length > 0, 'artist 是 UP 主名字', String(first.artist))
  eq(first.album, '', 'album 恒为空串（视频没有专辑）')
  assert(typeof first.durationMs === 'number' && first.durationMs > 0, 'durationMs 解析成了正数毫秒', String(first.durationMs))
  eq(first.playable, true, 'B 站没有付费墙 → playable 恒 true')
  assert(results.every((t) => t.playable === true), '每一条都是 playable:true', results.length + ' 条')
  eq(Object.keys(first).sort().join(','), 'album,artist,durationMs,id,name,playable', '结果字段恰好是契约里那七个')
  assert(payload.message === undefined, '正常路径不塞 message')
} else {
  eq(payload.degraded, true, '外网探测：不通 → degraded=true（降级分支）')
  eq(Array.isArray(payload.results) && payload.results.length, 0, '降级时 results 是空数组（不是 null）')
  eq(payload.message, MUSIC_ONLINE_DEGRADED_MESSAGE, '降级文案与契约逐字一致')
  skip('真实上游搜索（结果非空 / 字段形状 / 剥标签 / 时长）', '外网不通')
  skip('真实代理拉流（200/206 + audio + 首字节）', '外网不通')
  skip('Range 206 与 content-range', '外网不通')
  skip('playurl 只打一次的计数证据', '外网不通')
  skip('取不到音轨 → 404 人话文案', '外网不通')

  // 降级时取流必须 502（"取不到这首歌"），不能是 500（"本服务坏了"）
  const s = await alice('/api/music/online/stream?id=bi:BV1BZbSzZEGT')
  eq(s.status, 502, '外网不通时取流 → 502')
  assert(String(s.body?.error ?? '').includes('取不到这首歌'), '502 文案点明取不到这首歌', String(s.body?.error ?? ''))
}

// ---------------------------------------------------------------- 回归：cookie 不是硬前置

/**
 * 这一节是本轮事故的**通用形态**的长效断言，与服务端进程、真实上游都无关：
 *   上游首页回 200 → set-cookie 一条没有 → 搜索仍然必须成功。
 * 它比"断言某个具体 UA 版本号"值钱：UA 会继续变，这个形态不会。
 */
console.log('\n【回归：首页 200 但一条 cookie 都不下发（这次事故的通用形态）】')
{
  stub.home = 0
  stub.search = 0
  const payload = await searchOnlineTracks('回归晴天', 20)
  assert(stub.home >= 1, 'stub 首页被真的打过（bootstrap 走到了）', 'home=' + stub.home)
  assert(stub.home >= 2, '首个 UA 拿不到 cookie 就换了下一个候选', 'home=' + stub.home)
  eq(payload.degraded, false, '首页没下发任何 cookie → 搜索仍然成功（cookie 不是硬前置）')
  eq(payload.message, undefined, '成功路径不塞 message')
  const list = payload.results
  eq(list.length, 20, 'stub 的 20 条结果全部解析出来')
  const first = list[0] ?? {}
  eq(first.id, 'bi:' + STUB_RESULTS[0].bvid, 'id 是 bi:<stub bvid>')
  assert(
    typeof first.name === 'string' && !/[<>]/.test(first.name),
    'name 里的 <em> 高亮已经剥掉',
    String(first.name),
  )
  eq(first.durationMs, 270000, 'duration "4:30" → 270000ms（走的是同一条整形逻辑）')
  eq(first.playable, true, 'playable 恒 true')
  assert(
    stub.cookieOnSearch.length === 1 && stub.cookieOnSearch.every((c) => c === null),
    '空 cookie 时不发空的 Cookie 头（没有就不发，而不是发一个空值）',
    JSON.stringify(stub.cookieOnSearch),
  )

  // 同一形态下的风控重试：cookie 为空时也必须走 -352 → 强制重新 bootstrap → 再打一次
  stub.riskLeft = 1
  stub.home = 0
  stub.search = 0
  const retried = await searchOnlineTracks('风控检验', 20)
  eq(retried.degraded, false, '-352 且 cookie 为空 → 换 cookie 重试后仍成功（没有被"没有 cookie"挡掉）')
  eq(retried.results.length, 20, '重试后拿到完整 20 条')
  eq(stub.search, 2, '确实打了两次上游（第一次 -352，第二次成功）')
  assert(
    stub.cookieOnSearch.length === 3 && stub.cookieOnSearch.every((c) => c === null),
    '重试那两次也照样不带 Cookie 头（空 cookie 不影响重试路径）',
    JSON.stringify(stub.cookieOnSearch),
  )
  assert(stub.home >= 1, '重试前强制重新 bootstrap（不是拿旧 cookie 空转）', 'home=' + stub.home)
}

// ---------------------------------------------------------------- 磁盘缓存（进程内，上游 = stub）

/**
 * 这一节是"在线曲目能排进听歌房队列"的物理前提：切歌那一刻的首字节必须来自本地磁盘。
 *
 * 断言全打在本进程的曲库模块上（它的上游是 stub，调用次数可精确到 1）；真实服务端
 * 是另一个进程、另一个上游，两边互不干扰。
 */
console.log('\n【磁盘缓存：预热零重复 / 字节一致 / Range 自算】')
{
  const CACHE_DIR = join(CACHE_TMP_DIR, 'online-audio')
  const cachedFile = (bvid) => join(CACHE_DIR, bvid + '.m4a')
  const resetStub = () => {
    stub.pagelist = 0
    stub.playurl = 0
    stub.audio = 0
    stub.audioQualities = []
  }
  const stubHits = () => stub.pagelist + stub.playurl + stub.audio

  eq(ONLINE_CACHE_MAX_BYTES, 2 * 1024 * 1024 * 1024, '缓存总量上限常量 = 2GiB')

  const bvid = STUB_RESULTS[3].bvid
  const ref = 'bi:' + bvid
  resetStub()
  await prewarmOnlineTrack(ref)
  eq(stub.pagelist, 1, '预热：pagelist 打了 1 次')
  eq(stub.playurl, 1, '预热：playurl 打了 1 次')
  eq(stub.audio, 1, '预热：音频本体整份只下了 1 次（不带 Range）')
  eq(stub.audioQualities[0], '192', '预热取的是最高码率那档（真按 bandwidth 降序）')
  const warmSize = statSync(cachedFile(bvid)).size
  eq(warmSize, STUB_AUDIO.byteLength, '缓存文件大小 == 上游音频字节数')
  console.log(dim('    缓存文件：' + cachedFile(bvid) + '（' + warmSize + ' bytes）'))

  resetStub()
  await prewarmOnlineTrack(ref)
  eq(stubHits(), 0, '第二次预热：一个上游请求都不打（磁盘即答案）')

  // ---- 命中缓存时 Range 由我们自己算（不再回头问上游要 content-range）
  resetStub()
  const whole = await openCachedOnlineTrack(bvid, undefined)
  eq(whole.kind, 'hit', '预热后查询：命中磁盘缓存')
  if (whole.kind === 'hit') {
    eq(whole.status, 200, '无 Range → 200（整份）')
    eq(whole.size, STUB_AUDIO.byteLength, '总长来自本地文件')
    eq(whole.contentRange, null, '200 不带 content-range')
    const bytes = await readAll(whole.body)
    eq(bytes.byteLength, STUB_AUDIO.byteLength, '发出去的字节数 == 缓存文件大小')
    assert(Buffer.compare(bytes, Buffer.from(STUB_AUDIO)) === 0, '字节内容与上游逐字节一致')
  }

  const ranged = await openCachedOnlineTrack(bvid, 'bytes=0-1023')
  eq(ranged.kind, 'hit', 'Range 查询同样命中缓存')
  if (ranged.kind === 'hit') {
    eq(ranged.status, 206, 'Range → 206')
    eq(ranged.contentRange, 'bytes 0-1023/' + STUB_AUDIO.byteLength, 'content-range 自己算，总数来自本地文件')
    eq((await readAll(ranged.body)).byteLength, 1024, 'Range 只发 1024 字节')
  }

  const suffixed = await openCachedOnlineTrack(bvid, 'bytes=-64')
  if (suffixed.kind === 'hit') {
    eq(
      suffixed.contentRange,
      'bytes ' + (STUB_AUDIO.byteLength - 64) + '-' + (STUB_AUDIO.byteLength - 1) + '/' + STUB_AUDIO.byteLength,
      '后缀式 bytes=-64 与文件曲目通道同语义',
    )
    eq((await readAll(suffixed.body)).byteLength, 64, '后缀式只发 64 字节')
  }

  const beyond = await openCachedOnlineTrack(bvid, 'bytes=' + STUB_AUDIO.byteLength + '-')
  eq(beyond.kind, 'unsatisfiable', '起点越过文件末尾 → unsatisfiable（路由回 416）')
  if (beyond.kind === 'unsatisfiable') eq(beyond.size, STUB_AUDIO.byteLength, '416 的总长取自本地文件')

  const missing = await openCachedOnlineTrack('BVaaaaaaaaaa', undefined)
  eq(missing.kind, 'miss', '没缓存过 → miss（继续走代理）')
  eq(stubHits(), 0, '命中/未命中的查询本身零上游调用（缓存不反向触发解析）')

  // ---- 冷曲目：代理这条路上顺手 tee 出一份缓存
  const cold = STUB_RESULTS[4].bvid
  resetStub()
  const source = await resolveOnlineStreamSource(cold)
  assert(source.kind === 'direct', '冷曲目解析出直连地址', String(source.kind))
  if (source.kind === 'direct') {
    const controller = new AbortController()
    const upstream = await openOnlineStream(source.urls, undefined, controller.signal)
    assert(upstream !== null, '打开上游音频流成功')
    eq(stub.audio, 1, '打开上游音频流只打了 1 次')
    if (upstream) {
      const body = await attachOnlineCacheTee(
        cold,
        upstream.body,
        { status: upstream.status, contentRange: upstream.contentRange, contentLength: upstream.contentLength },
        controller.signal,
      )
      const bytes = await readAll(body)
      eq(bytes.byteLength, STUB_AUDIO.byteLength, 'tee 这一路发给客户端的字节数 == 上游整份')
      eq(statSync(cachedFile(cold)).size, bytes.byteLength, 'tee 落盘大小 == 发出去的字节数（响应结束即缓存就绪）')
      assert(Buffer.compare(bytes, Buffer.from(STUB_AUDIO)) === 0, 'tee 发出去的字节与上游逐字节一致')
      eq(stub.audio, 1, '整条代理路径只打了 1 次上游音频（没有为了缓存再下一遍）')
    }
  }

  const files = readdirSync(CACHE_DIR).sort()
  eq(files.join(','), [bvid + '.m4a', cold + '.m4a'].sort().join(','), '缓存目录里只有两个正式文件，没有残留 .part')
  console.log(dim('    目录：' + files.join(' / ')))
}

// ---------------------------------------------------------------- 代理拉流

console.log('\n【服务端代理拉流】')
{
  eq((await alice('/api/music/room')).body.inRoom, false, '小爱没加入听歌房（在线试听不需要加入）')
}

if (online) {
  const results = Array.isArray(payload.results) ? payload.results : []
  const first = results[0]
  console.log(dim('  第一条：' + first.name + ' / ' + first.artist + ' / ' + first.id + ' / ' + first.durationMs + 'ms'))

  const full = await streamRaw(alice, first.id)
  assert(full.status === 200 || full.status === 206, '取流 200/206', 'status=' + full.status)
  const contentType = String(full.headers.get('content-type') ?? '')
  assert(contentType.includes('audio'), 'content-type 含 audio（上游是 video/mp4，我们自己盖成 audio/mp4）', contentType)
  eq(full.headers.get('accept-ranges'), 'bytes', '自补 accept-ranges: bytes')
  eq(full.headers.get('x-content-type-options'), 'nosniff', '自补 x-content-type-options: nosniff')
  eq(full.headers.get('location'), null, '不把 CDN 地址透给浏览器（无 location）')
  const bytes = new Uint8Array(await full.arrayBuffer())
  assert(bytes.byteLength > 10000, '真的收到了音频字节', bytes.byteLength + ' bytes')
  console.log(dim('    status=' + full.status + ' content-type=' + contentType + ' content-length=' + full.headers.get('content-length') + ' 实际=' + bytes.byteLength + ' 首字节=' + hex(bytes.slice(0, 4))))

  const ranged = await streamRaw(alice, first.id, { range: 'bytes=0-1023' })
  eq(ranged.status, 206, 'Range 请求 → 206')
  const contentRange = String(ranged.headers.get('content-range') ?? '')
  assert(/^bytes 0-1023\/\d+$/.test(contentRange), 'content-range 形如 bytes 0-1023/<总数>', contentRange)
  eq(ranged.headers.get('content-length'), '1024', 'content-length 与 Range 一致')
  const part = new Uint8Array(await ranged.arrayBuffer())
  eq(part.byteLength, 1024, 'Range 只回了 1024 字节')
  const total = full.headers.get('content-length')
  if (full.status === 200 && total) eq(contentRange, 'bytes 0-1023/' + total, 'content-range 的总数与完整响应的 content-length 一致')
  console.log(dim('    Range: status=' + ranged.status + ' content-range=' + contentRange + ' content-length=' + ranged.headers.get('content-length') + ' 首字节=' + hex(part.slice(0, 4))))

  // ------------------------------------------------------------ 缓存证据

  console.log('\n【playurl 只打一次（每个 Range 都重新解析会让播放卡死并触发风控）】')
  resetTrace()
  traceAll()
  let evidence = null
  // 从第 2 条起挑：第 1 条前面已经解析并缓存过，拿它测不出"第一次"的计数。
  for (const candidate of results.slice(1, 6)) {
    resetTrace()
    const a = await streamRaw(alice, candidate.id, { range: 'bytes=0-1023' })
    await a.arrayBuffer()
    if (a.status !== 206) continue // 这条稿件没有音轨，换下一条
    const tagPlayurl = 'playurl ' + bvidOf(candidate)
    const tagPagelist = 'pagelist ' + bvidOf(candidate)
    const playurlFirst = countTrace(tagPlayurl)
    const pagelistFirst = countTrace(tagPagelist)
    const b = await streamRaw(alice, candidate.id, { range: 'bytes=1024-2047' })
    await b.arrayBuffer()
    evidence = {
      candidate,
      secondStatus: b.status,
      playurlFirst,
      pagelistFirst,
      playurlSecond: countTrace(tagPlayurl),
      pagelistSecond: countTrace(tagPagelist),
      secondRange: String(b.headers.get('content-range') ?? ''),
    }
    break
  }

  if (!evidence) {
    skip('playurl 只打一次的计数证据', '这一轮搜索结果里没有第二条能拉到音轨的视频')
  } else {
    if (evidence.playurlFirst < 1) {
      skip(
        'playurl 只打一次的计数证据',
        '服务端没开 WL_MUSIC_ONLINE_TRACE（只有 run-all-tests.mjs 会开；手跑时请给服务端加这个变量）',
      )
    } else {
      const c = evidence.candidate
      console.log(dim('    测量对象：' + c.name + ' / ' + c.id))
      console.log(dim('    第一次 Range(bytes=0-1023) 之后：playurl=' + evidence.playurlFirst + ' pagelist=' + evidence.pagelistFirst))
      eq(evidence.playurlFirst, 1, '第一次 Range：playurl 恰好打了 1 次', 'playurl=' + evidence.playurlFirst)
      eq(evidence.pagelistFirst, 1, '第一次 Range：pagelist 恰好打了 1 次', 'pagelist=' + evidence.pagelistFirst)
      eq(evidence.secondStatus, 206, '第二次 Range 仍然 206（走的是缓存里的地址）')
      console.log(dim('    第二次 Range(bytes=1024-2047) 之后：playurl=' + evidence.playurlSecond + ' pagelist=' + evidence.pagelistSecond + '  content-range=' + evidence.secondRange))
      eq(evidence.playurlSecond, evidence.playurlFirst, '第二次 Range 一次 playurl 都没再打（命中缓存）', 'playurl=' + evidence.playurlFirst + ' → ' + evidence.playurlSecond)
      eq(evidence.pagelistSecond, evidence.pagelistFirst, '第二次 Range 一次 pagelist 都没再打', 'pagelist=' + evidence.pagelistFirst + ' → ' + evidence.pagelistSecond)
      assert(/^bytes 1024-2047\/\d+$/.test(evidence.secondRange), '第二次 Range 的 content-range 跟着变', evidence.secondRange)
    }
  }

  // ------------------------------------------------------------ 取不到音轨

  console.log('\n【取不到音轨 → 404 + 人话】')
  {
    // 语法合法但一定不存在的稿件：B 站回 code=-400，映射成"这个视频取不到音轨"。
    // 这不是故障，是 404 —— 500/502 都会让前端当成服务坏了去重试。
    const res = await streamRaw(alice, 'bi:BV0000000000')
    const text = await res.text()
    console.log(dim('    不存在的稿件 bi:BV0000000000 → status=' + res.status + ' body=' + text.slice(0, 160)))
    if (res.status === 502) {
      skip('取不到音轨 → 404', '上游此刻风控/网络抖动（502），不是映射逻辑的问题')
    } else {
      eq(res.status, 404, '取不到音轨 → 404（不是 500/502）')
      let parsed = {}
      try { parsed = JSON.parse(text) } catch { parsed = {} }
      const message = String(parsed?.error ?? '')
      eq(message, MUSIC_ONLINE_NO_AUDIO_MESSAGE, '404 文案与常量逐字一致')
      assert(message.includes('音轨'), '404 文案点明取不到音轨', message)
      assert(message.includes('大会员'), '404 文案提到大会员', message)
    }
  }
}

// ---------------------------------------------------------------- 房间不受影响

console.log('\n【在线曲目不碰听歌房状态】')
{
  const roomAfter = (await admin('/api/music/room')).body
  eq(roomAfter.queue.length, roomBefore.queue.length, 'music_queue 长度不变')
  eq(JSON.stringify(roomAfter.nowPlaying), JSON.stringify(roomBefore.nowPlaying), 'nowPlaying 不变')
  eq(roomAfter.members.length, roomBefore.members.length, '在场成员不变（在线试听不广播）')
}

// ---------------------------------------------------------------- 在线曲目进听歌房队列

/**
 * 这一节才是本轮的目的：在线曲目**真的能排进听歌房队列**并成为 nowPlaying。
 *
 * 打的是真实服务端进程（另一个进程、真上游）。磁盘缓存那条链路的跨进程证据只能在
 * trace 文件里看：cache-hit 行 = 首字节来自本地磁盘，且 playurl/pagelist 计数为 0。
 */
console.log('\n【在线曲目排进听歌房队列（本地多人同步播放）】')
{
  const before = (await alice('/api/music/room')).body
  const wasEmpty = Array.isArray(before.queue) && before.queue.length === 0
  eq((await alice('/api/music/join', 'POST')).body.inRoom, true, '小爱加入听歌房')

  const pick = (payload.degraded === false ? (payload.results ?? []) : [])[1] ?? null
  const ref = pick ? pick.id : 'bi:BV1GJ411x7h7'
  const title = pick ? pick.name : '在线测试曲（占位）'
  console.log(dim('    入队对象：' + ref + ' / ' + title))

  const enq = await alice('/api/music/queue', 'POST', { onlineId: ref, title })
  eq(enq.status, 200, '在线曲目入队 → 200')
  // 房间空着时这首歌会直接开播（与文件曲目一样不等第二个人），所以它可能出现在
  // queue 里，也可能已经是 nowPlaying —— 两处都算"排进去了"。
  const queued = (enq.body?.queue ?? []).find((item) => item.nodeId === ref) ?? null
  const nowItem = enq.body?.nowPlaying ?? null
  const started = nowItem !== null && nowItem.nodeId === ref
  assert(queued !== null || started, '这个引用符出现在返回的房间视图里', ref + (started ? '（正在播）' : '（在队列里）'))
  // 房间已经在放歌时，再排同一首（换个标题）一定留在队列里 —— 队列项字段的断言落在这里。
  // 故意复用同一个引用符：磁盘缓存已经热了，这一步骤零上游开销，而标题必须是
  // **这一行自己的** online_title（不是从 nowPlaying 抄来的）。
  const title2 = title + ' #2'
  const enq2 = await alice('/api/music/queue', 'POST', { onlineId: ref, title: title2 })
  eq(enq2.status, 200, '同一首在线曲目再排一次 → 200')
  const queued2 = (enq2.body?.queue ?? []).find((item) => item.nodeId === ref) ?? null
  assert(queued2 !== null, '第二行留在队列里（房间已在播放，不抢当前曲目）', ref)
  if (queued2) {
    eq(queued2.source, 'online', '队列项 source=online')
    eq(queued2.name, title2, '队列项 name 是这一行自己的标题（不是 nowPlaying 抄来的）')
    assert(typeof queued2.addedBy === 'string' && queued2.addedBy.length > 0, 'addedBy 有值', queued2.addedBy)
    assert(typeof queued2.addedAt === 'number' && queued2.addedAt > 0, 'addedAt 是服务端毫秒时间戳', String(queued2.addedAt))
  }

  if (wasEmpty) {
    const now = enq.body?.nowPlaying ?? null
    assert(now !== null, '队列原本为空 → 入队即开播（与文件曲目同一套 startNext）')
    if (now) {
      eq(now.nodeId, ref, 'nowPlaying.nodeId 就是那个引用符')
      eq(now.source, 'online', 'nowPlaying.source=online')
      eq(now.name, title, 'nowPlaying.name 用在线标题兜底')
      // positionMs 是"按服务端时钟算出来的当前进度"，刚开播时是几十毫秒而不是 0
      assert(typeof now.positionMs === 'number' && now.positionMs >= 0 && now.positionMs < 5000, '刚落地 positionMs 是一个很小的正数', String(now.positionMs))
      assert(typeof now.startedAt === 'number' && now.startedAt > 0, 'startedAt 是服务端时间戳（同步时钟的锚点）', String(now.startedAt))
      assert(typeof now.playedToken === 'number' && now.playedToken > 0, 'playedToken 递增到正数', String(now.playedToken))
    }
  } else {
    skip('入队即开播', '房间原本就有歌在放（不在这一节的范围里）')
  }

  // healDeletedCurrent 只对文件曲目生效：在线曲目不能因为"nodes 里没有这一行"被切掉。
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    const view = (await admin('/api/music/room')).body
    seen.push(view.nowPlaying ? view.nowPlaying.nodeId + '|' + view.nowPlaying.source : 'none')
  }
  eq(seen[0], seen[1], '连拉三次房间：nowPlaying 没被 heal 切走（第 1、2 次一致）')
  eq(seen[1], seen[2], '连拉三次房间：nowPlaying 没被 heal 切走（第 2、3 次一致）')
  eq(seen[2], ref + '|online', '在线曲目一直是当前曲目（没被判成"文件已删除"）')

  // ---- 非法入参
  const badRef = await alice('/api/music/queue', 'POST', { onlineId: 'bi:BV123', title: 'x' })
  eq(badRef.status, 400, '格式不对的在线引用符 → 400')
  const noTitle = await alice('/api/music/queue', 'POST', { onlineId: ref })
  eq(noTitle.status, 400, '缺 title → 400')
  assert(String(noTitle.body?.error ?? '').includes('歌名'), '缺 title 的文案点明歌名', String(noTitle.body?.error ?? ''))

  // ---- 磁盘缓存：跨进程证据（trace 只看得见真实服务端进程）
  const bvid = ref.replace(/^bi:/, '')
  let warm = false
  for (let i = 0; i < 60; i += 1) {
    if (countTracePrefix('cache-ready ' + bvid) > 0) { warm = true; break }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!warm) {
    skip('第二次取流零上游命中（磁盘缓存）', '预热没落盘：可能出不了网 / 缓存目录不可写（服务端进程的 WL_MUSIC_ONLINE_TRACE 也可能没开）')
  } else {
    resetTrace()
    const first = await streamRaw(alice, ref)
    const firstBytes = new Uint8Array(await first.arrayBuffer())
    const hitFirst = countTracePrefix('cache-hit ' + bvid)
    const playFirst = countTrace('playurl ' + bvid) + countTrace('pagelist ' + bvid)
    console.log(dim('    第 1 次取流：status=' + first.status + ' bytes=' + firstBytes.byteLength + ' cache-hit=' + hitFirst + ' playurl+pagelist=' + playFirst))
    eq(first.status, 200, '预热之后取流 → 200（首字节来自本地磁盘）')
    assert(firstBytes.byteLength > 10000, '真的收到了整首音频字节', firstBytes.byteLength + ' bytes')

    resetTrace()
    const second = await streamRaw(alice, ref, { range: 'bytes=0-1023' })
    const secondBytes = new Uint8Array(await second.arrayBuffer())
    const hitSecond = countTracePrefix('cache-hit ' + bvid)
    const playSecond = countTrace('playurl ' + bvid) + countTrace('pagelist ' + bvid)
    console.log(dim('    第 2 次取流：status=' + second.status + ' bytes=' + secondBytes.byteLength + ' cache-hit=' + hitSecond + ' playurl+pagelist=' + playSecond))
    eq(second.status, 206, '第二次 Range 请求 → 206')
    eq(second.headers.get('content-range'), 'bytes 0-1023/' + firstBytes.byteLength, 'content-range 的总长 == 第一次整份的字节数（同一份缓存）')
    eq(secondBytes.byteLength, 1024, '第二次只发 1024 字节')
    assert(hitSecond >= 1, '第二次请求确实命中磁盘缓存（trace 里有 cache-hit 行）', 'cache-hit=' + hitSecond)
    eq(playSecond, 0, '第二次请求零上游命中（playurl + pagelist 都是 0）')
  }

  // ---- 队列上限 50（在线曲目与文件曲目共用同一条上限）
  const view = (await alice('/api/music/room')).body
  let count = Array.isArray(view.queue) ? view.queue.length : 0
  let cap = null
  for (let i = count; i < 52; i += 1) {
    const res = await alice('/api/music/queue', 'POST', { onlineId: ref, title: '上限检验 ' + i })
    if (res.status !== 200) { cap = res; break }
    count += 1
  }
  assert(cap !== null, '排到第 51 首时被挡住（没被无限排下去）', '当前 ' + count + ' 首')
  if (cap) {
    eq(cap.status, 400, '超上限 → 400')
    assert(String(cap.body?.error ?? '').includes('50'), '400 文案点明上限 50', String(cap.body?.error ?? ''))
  }
  eq(count, 50, '队列正好停在 50 首')
  const finalView = (await alice('/api/music/room')).body
  eq(finalView.queue.length <= 50, true, '房间视图里的队列不超过 50 首', String(finalView.queue.length))
  eq(finalView.nowPlaying.nodeId, ref, '排满队列也没把正在放的在线曲目挤掉')
}

// ---------------------------------------------------------------- 汇总

console.log('\n\x1b[1m结果\x1b[0m  通过 \x1b[32m' + passed + '\x1b[0m  失败 \x1b[31m' + failed + '\x1b[0m' + (skipped ? '  跳过 \x1b[33m' + skipped + '\x1b[0m' : '') + '\n')
if (failed > 0) process.exit(1)
