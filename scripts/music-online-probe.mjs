#!/usr/bin/env node
/**
 * 在线曲库（哔哩哔哩）连通性自检 —— 零依赖、不连数据库、不起服务端。
 *
 * 为什么要有这个脚本：
 *   "在线曲库不能用"在 NAS 上有两种完全不同的原因：① 这台机器出不了网（内网
 *   封闭部署很常见）；② 能出网但 B 站改了接口/风控加了码。这两种故障的处理
 *   方式完全不同，但服务端那边都会表现为 degraded/404，光看日志分不清。
 *   一条命令跑三行结论，用户自己就能判断"是不是我的网的问题"。
 *
 * 为什么它必须零依赖、不碰服务端：
 *   用户是在 NAS 的 SSH 里跑它。要求 pnpm install 一遍、或者先起一个 Fastify
 *   服务再另开一个终端发请求，就没人会跑了。Node 24 自带 fetch，一行 node 就够。
 *
 * 用法：node scripts/music-online-probe.mjs
 * 退出码：0 = 三行全通；1 = 任一失败（在线曲库会降级成不可用）
 */

const HOME = 'https://www.bilibili.com/'
const SEARCH = 'https://api.bilibili.com/x/web-interface/search/type'
const PAGELIST = 'https://api.bilibili.com/x/player/pagelist'
const PLAYURL = 'https://api.bilibili.com/x/player/playurl'

/**
 * UA 候选列表 —— 与服务端 server/src/music-online.ts 用同一套。
 *
 * ⚠️ 不能只写一个版本号：UA 版本是会被上游淘汰的外部常量。实测同一台机器同一
 * 时刻，首页用 Chrome/124 回 200 但 set-cookie **0 条**，用 Chrome/131 回 2 条，
 * 而搜索接口两种 UA 都能回 20 条。钉死单个版本的自检脚本会跟着上游一起坏。
 * WL_MUSIC_ONLINE_USER_AGENT 可以显式指定（排查"是不是又轮到某个版本了"）。
 */
const UA_OVERRIDE = (process.env.WL_MUSIC_ONLINE_USER_AGENT ?? '').trim()
const UA_CANDIDATES = UA_OVERRIDE
  ? [UA_OVERRIDE]
  : [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ]

/** 本次运行真正生效的 UA：后续每一步都用它，别中途换身份（风控会看成两个人）。 */
let UA = UA_CANDIDATES[0]

const TIMEOUT_MS = 15_000
const KEYWORD = '晴天'

const dim = (s) => '\x1b[90m' + s + '\x1b[0m'
const green = (s) => '\x1b[32m' + s + '\x1b[0m'
const red = (s) => '\x1b[31m' + s + '\x1b[0m'
const bold = (s) => '\x1b[1m' + s + '\x1b[0m'

/** 把 set-cookie 数组收成一个 name=value; name=value 的 Cookie 头。 */
function cookieHeaderFrom(setCookies) {
  const pairs = []
  for (const raw of setCookies) {
    const first = String(raw).split(';')[0].trim()
    if (!first) continue
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    pairs.push(first)
  }
  return pairs.join('; ')
}

/**
 * ① bootstrap：先访问首页**尽量**拿 buvid3 / b_nut。
 *
 * 这一步拿到 cookie 是加分项，不是通行证：server/src/music-online.ts 里已经
 * 把"必须有 cookie"这个硬前置去掉了（实测不改 UA 的空 cookie 直连也能回 20 条）。
 * 所以这里对每个候选 UA 各试一次，首个下发 cookie 的胜出；一个都没下发就空手
 * 继续，让 ② 去证明"到底能不能用" —— 这才是自检该回答的问题。
 */
async function bootstrap() {
  let lastStatus = 0
  for (const ua of UA_CANDIDATES) {
    const res = await fetch(HOME, {
      headers: { 'user-agent': ua, referer: HOME, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // 首页 HTML 有几百 KB，我们只要 set-cookie，body 立刻丢掉。
    await res.body?.cancel().catch(() => {})
    lastStatus = res.status
    const cookie = cookieHeaderFrom(res.headers.getSetCookie?.() ?? [])
    if (!cookie) continue
    UA = ua
    const hasBuvid3 = /(?:^|;\s*)buvid3=[^;]+/.test(cookie)
    return { status: res.status, cookie, hasBuvid3, ua }
  }
  return { status: lastStatus, cookie: '', hasBuvid3: false, ua: UA }
}

/** 解析 "4:30" / "1:02:33" 为毫秒；拿不到就 0。 */
function parseDuration(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 1000 ? raw : raw * 1000
  if (typeof raw !== 'string') return 0
  const parts = raw.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return 0
  let total = 0
  for (const p of parts) {
    const n = Number.parseInt(p, 10)
    if (!Number.isFinite(n) || n < 0) return 0
    total = total * 60 + n
  }
  return total * 1000
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '')

async function search(keyword, cookie) {
  const url = new URL(SEARCH)
  url.searchParams.set('search_type', 'video')
  url.searchParams.set('keyword', keyword)
  url.searchParams.set('page', '1')
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: HOME,
      accept: 'application/json, text/plain, */*',
      ...(cookie ? { cookie } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.json()
  const list = Array.isArray(body?.data?.result) ? body.data.result : []
  return { status: res.status, code: body?.code, list }
}

/** ② 取 cid + ③ 取音轨列表（按 bandwidth 降序）。 */
async function resolveAudio(bvid, cookie) {
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/video/' + bvid,
    accept: 'application/json, text/plain, */*',
    ...(cookie ? { cookie } : {}),
  }
  const pageRes = await fetch(PAGELIST + '?bvid=' + encodeURIComponent(bvid), {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const pageBody = await pageRes.json()
  const cid = pageBody?.data?.[0]?.cid
  if (!Number.isFinite(cid)) return { cid: null, audios: [] }

  const playUrl = new URL(PLAYURL)
  playUrl.searchParams.set('bvid', bvid)
  playUrl.searchParams.set('cid', String(cid))
  playUrl.searchParams.set('fnval', '16')
  playUrl.searchParams.set('fourk', '1')
  const playRes = await fetch(playUrl, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const playBody = await playRes.json()
  const raw = Array.isArray(playBody?.data?.dash?.audio) ? playBody.data.dash.audio : []
  const audios = raw
    .filter((a) => a && typeof a.baseUrl === 'string' && a.baseUrl.length > 0)
    .map((a) => ({ id: a.id, baseUrl: a.baseUrl, backfills: a.backupUrl, bandwidth: Number(a.bandwidth) || 0 }))
    .sort((a, b) => b.bandwidth - a.bandwidth)
  return { cid, audios }
}

/** ④ 拉前 1KB：这是"浏览器真的能播"的最低证据。 */
async function fetchFirstKb(baseUrl) {
  const res = await fetch(baseUrl, {
    headers: { 'user-agent': UA, referer: HOME, range: 'bytes=0-1023', accept: '*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  return {
    status: res.status,
    contentRange: res.headers.get('content-range'),
    contentType: res.headers.get('content-type'),
    bytes: buf.byteLength,
    head: Array.prototype.map.call(buf.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' '),
  }
}

// ---------------------------------------------------------------- 主流程

function fail(reason) {
  console.log('  ' + red('✗') + ' ' + reason)
  console.log('')
  console.log(red(bold('这台机器访问不了哔哩哔哩，在线曲库会降级成不可用（不影响文件区听歌）')))
  process.exit(1)
}

console.log(bold('\n在线曲库（哔哩哔哩）连通性自检') + dim('  关键词「' + KEYWORD + '」\n'))

// ① bootstrap
let boot
try {
  boot = await bootstrap()
} catch (err) {
  console.log('  ' + red('✗') + ' ① bootstrap 失败：' + String(err?.message ?? err))
  fail('连 https://www.bilibili.com/ 都打不开，是网络出口的问题。')
}
// 首页能打开就算过：没有 cookie 不是故障（服务端也按"空手继续"处理），
// 能不能搜到歌由 ② 回答 —— 那才是"在线曲库能不能用"的直接证据。
if (!boot.cookie) {
  console.log('  ' + green('✓') + ' ① bootstrap  ' + dim('首页 ' + boot.status + ' 可访问，但没下发 cookie（不致命，按无 cookie 继续）'))
} else if (!boot.hasBuvid3) {
  console.log('  ' + green('✓') + ' ① bootstrap  ' + dim('首页 ' + boot.status + ' 下发了 cookie 但没有 buvid3（不致命，按无 buvid3 继续）'))
} else {
  console.log('  ' + green('✓') + ' ① bootstrap buvid3  ' + dim(boot.cookie.slice(0, 60) + (boot.cookie.length > 60 ? '…' : '')))
}

// ② 搜索
let found
try {
  found = await search(KEYWORD, boot.cookie)
} catch (err) {
  fail('② 搜索接口请求失败：' + String(err?.message ?? err))
}
if (found.code !== 0)
  fail('② 搜索接口返回 code=' + found.code + '（风控拒绝：UA 可能又过时了，可用 WL_MUSIC_ONLINE_USER_AGENT 换一个版本试）')
if (found.list.length === 0) fail('② 搜索「' + KEYWORD + '」返回 0 条（接口还在，但结果被拦了）')
const first = found.list[0]
const firstBvid = String(first?.bvid ?? '')
console.log(
  '  ' + green('✓') + ' ② 搜索返回 ' + bold(found.list.length + ' 条') +
    '  第一条 ' + dim(firstBvid + ' / ' + stripTags(first?.title) + ' / ' + (first?.author ?? '') + ' / ' + parseDuration(first?.duration) + 'ms'),
)
if (!/^BV[0-9A-Za-z]{10}$/.test(firstBvid)) fail('② 第一条没有合法的 bvid（' + firstBvid + '），接口结构变了')

// ③ 音轨 + 前 1KB
let cid = null
let audios = []
try {
  const resolved = await resolveAudio(firstBvid, boot.cookie)
  cid = resolved.cid
  audios = resolved.audios
} catch (err) {
  fail('③ 取音轨失败：' + String(err?.message ?? err))
}
if (audios.length === 0) fail('③ ' + firstBvid + ' 取不到音轨（可能已失效或需要大会员）')

let pulled = null
let lastErr = null
for (const candidate of [audios[0].baseUrl, ...(audios[0].backfills ?? [])]) {
  try {
    pulled = await fetchFirstKb(candidate)
    if (pulled.status === 200 || pulled.status === 206) break
    lastErr = 'status=' + pulled.status
    pulled = null
  } catch (err) {
    lastErr = String(err?.message ?? err)
    pulled = null
  }
}
if (!pulled) fail('③ 音轨地址拉不到字节（' + lastErr + '）')
console.log(
  '  ' + green('✓') + ' ③ 音轨 cid=' + cid + ' 共 ' + audios.length + ' 条（最高 ' + Math.round(audios[0].bandwidth / 1000) + 'kbps）' +
    '  Range 前 1KB → ' + pulled.status + ' ' + pulled.bytes + ' bytes' +
    dim('  首字节=' + pulled.head + '  content-range=' + pulled.contentRange),
)

console.log('')
console.log(green(bold('这台机器可以访问哔哩哔哩，在线曲库可用')))
process.exit(0)
