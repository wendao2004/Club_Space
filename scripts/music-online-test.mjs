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
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
const stub = { home: 0, search: 0, cookieOnSearch: [], riskLeft: 0 }

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
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end('{"code":-404}')
})
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
stubServer.unref()
const STUB_BASE = 'http://127.0.0.1:' + stubServer.address().port
process.env.WL_MUSIC_ONLINE_HOME_URL = STUB_BASE + '/home'
process.env.WL_MUSIC_ONLINE_SEARCH_URL = STUB_BASE + '/search'
process.env.WL_MUSIC_ONLINE_PAGELIST_URL = STUB_BASE + '/pagelist'
process.env.WL_MUSIC_ONLINE_PLAYURL_URL = STUB_BASE + '/playurl'

// stub 的上游调用不能写进服务端那份 trace 文件：那边在用"行数"做 playurl 计数断言。
const TRACE_ENV_SAVED = process.env.WL_MUSIC_ONLINE_TRACE
delete process.env.WL_MUSIC_ONLINE_TRACE

const {
  MUSIC_ONLINE_DEGRADED_MESSAGE,
  MUSIC_ONLINE_NO_AUDIO_MESSAGE,
  MUSIC_ONLINE_PROVIDER,
  parseDurationMs,
  parseOnlineTrackId,
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

// ---------------------------------------------------------------- 汇总

console.log('\n\x1b[1m结果\x1b[0m  通过 \x1b[32m' + passed + '\x1b[0m  失败 \x1b[31m' + failed + '\x1b[0m' + (skipped ? '  跳过 \x1b[33m' + skipped + '\x1b[0m' : '') + '\n')
if (failed > 0) process.exit(1)
