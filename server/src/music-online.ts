/**
 * 在线曲库（哔哩哔哩搜索 + 服务端代理拉流）。
 *
 * 为什么是"服务端聚合搜索 + 服务端代理"而不是前端直连：
 *   ① 前端直连外网 CDN 会拿到 http:// 的播放地址，嵌在 https 页面里被浏览器
 *      的混合内容策略拦掉；走本服务就是同源 https，不用为一个玩具功能去配证书链。
 *   ② 外网播放地址是"谁都能用的裸链接"，把它透给浏览器等于把外网的 CDN 当成
 *      鉴权边界 —— 任何拿到链接的人都能绕过登录直接刷。
 *   ③ 只有服务端能统一加超时、UA、referer，并且把"这个视频取不到音轨"这种事实
 *      翻译成一句人话，而不是让播放器停在"正在加载"。
 *
 * 为什么这一版换成了哔哩哔哩：上一版接的是网易云，而网易云的免费额度早就是
 * 薛定谔的 —— 大量曲目 fee=1，外链直接 302 到 /404，搜索列表里一半的歌点了
 * 只会看到"需要会员"。B 站这边整条链实测跑得通：
 *   首页拿 buvid3/b_nut → search/type 搜索 → pagelist 取 cid
 *   → playurl(fnval=16) 取 dash.audio（64k/128k/192k 三档）→ CDN 拉 fMP4
 * CDN 支持 Range（回 206 + content-range），Chrome 的 <audio> 能直接播；而且
 * **没有付费墙** —— playurl 取不到音轨只发生在稿件失效/番剧这类边界情况，
 * 不会退化成"一半的歌都不能放"。
 *
 * 为什么只接一家：酷我 /api/www/search 已 403，酷狗 play getdata 返回 err_code
 * 30020（拿不到播放地址）。接不上的平台硬接只会变成一堆必然失败的分支，所以
 * 就一个 provider，诚实地面向"一个能用的源"。
 *
 * 为什么在线曲目**不进队列**：听歌房是"所有人同一时刻听同一首"的同步模型，
 * 时钟锚点由服务端算出。如果把在线流塞进队列，其他人的播放进度会依赖"某个人
 * 能不能连上外网 CDN"，整房会一起卡住。所以在线流只做单人试听。
 */
import { appendFile } from 'node:fs'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

/** 唯一的 provider。写成常量而不是字面量散落各处，前端/接口契约只有一个来源。 */
export const MUSIC_ONLINE_PROVIDER = 'bilibili' as const

/**
 * 外网不可用时的固定文案。
 *
 * 「搜不到歌」不是本服务的故障 —— 所以这里既不出 500，也不出空 200 不带解释：
 * 前端要能原样把这句话显示出去，用户才知道"不是坏了，是这台机器现在出不了网"。
 */
export const MUSIC_ONLINE_DEGRADED_MESSAGE = '曲库暂时连不上（这台机器可能出不了网），可以继续听文件区里的歌'

/**
 * 稿件取不到可用音轨时的文案（路由用它出 404）。
 *
 * B 站没有网易云那种"付费墙"，所以这里不是"要会员才能听"，而是"这条稿件本身
 * 没有能放的音频"：番剧/收费课程、已失效或被删的稿件、纯直播回放都会走到这里。
 * 文案必须提一句大会员 —— 用户看到的那 1% 情况基本就是这个原因。
 */
export const MUSIC_ONLINE_NO_AUDIO_MESSAGE = '这个视频取不到音轨（可能已失效或需要大会员）'

/**
 * 上游地址。允许用环境变量覆盖**只为了测试能确定性地模拟"外网连不上"** ——
 * 真断网没法在 CI 里复现，指向一个必然连不上的地址才能验证降级分支。
 * 与 WL_CONVERT_SERVICE_URL 是同一个理由。
 */
const HOME_ENDPOINT = process.env.WL_MUSIC_ONLINE_HOME_URL ?? 'https://www.bilibili.com/'
const SEARCH_ENDPOINT =
  process.env.WL_MUSIC_ONLINE_SEARCH_URL ?? 'https://api.bilibili.com/x/web-interface/search/type'
const PAGELIST_ENDPOINT =
  process.env.WL_MUSIC_ONLINE_PAGELIST_URL ?? 'https://api.bilibili.com/x/player/pagelist'
const PLAYURL_ENDPOINT =
  process.env.WL_MUSIC_ONLINE_PLAYURL_URL ?? 'https://api.bilibili.com/x/player/playurl'

/**
 * 上游身份：UA 候选列表 + referer。
 *
 * ⚠️ 绝不转发客户端带来的 cookie / authorization：那是本服务用户的凭据，
 * 拿到第三方站点上去请求，等于把内网会话泄漏出去。B 站要 cookie 也只要它
 * 自己首页下发的那份（见 bootstrapCookie）。
 *
 * ⚠️ referer 不是可选的：B 站 CDN **认 referer**，不带就是 403。而 UA 必须
 * 与搜索接口用的是同一个，否则风控会把两边当成两个人。
 *
 * ⚠️ UA **不能钉死单个版本**：UA 版本是会被上游淘汰的外部常量，钉死等于给这个
 * 功能装一颗定时炸弹，而且引信握在别人手里。实测（同一台机器、连续请求）：
 *   首页 200 + Chrome/124 → set-cookie **0 条**（buvid3 拿不到）；
 *   首页 200 + Chrome/131 → set-cookie 2 条。
 * 也就是说"UA 过期"不会表现为报错，而是表现为**静默地什么都拿到**。所以这里是
 * 候选列表 + 谁先拿到 cookie 谁生效（记在进程内，后续请求沿用同一个身份），
 * 首个拿不到就换下一个。WL_MUSIC_ONLINE_USER_AGENT 可显式覆盖（排查时不必改代码）。
 */
const USER_AGENT_OVERRIDE = (process.env.WL_MUSIC_ONLINE_USER_AGENT ?? '').trim()
const USER_AGENT_CANDIDATES: readonly string[] = USER_AGENT_OVERRIDE
  ? [USER_AGENT_OVERRIDE]
  : [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ]

/** 这个进程里已经证明能拿到 cookie 的那个 UA；还没试出来就是 null。 */
let activeUserAgent: string | null = null

/**
 * 候选尝试顺序：已生效的那个排最前。
 *
 * 之所以不是"生效了就锁死一个"：生效的那个也可能在进程活着的期间被上游淘汰，
 * 那时强制重新 bootstrap 应该自动退到下一个候选，而不是原地反复撞同一堵墙。
 */
function userAgentOrder(): readonly string[] {
  const active = activeUserAgent
  if (!active) return USER_AGENT_CANDIDATES
  return [active, ...USER_AGENT_CANDIDATES.filter((ua) => ua !== active)]
}

/** 上游请求头。UA 取"当前身份"，所以每次请求现算，不能做成模块级常量。 */
function upstreamHeaders(): Record<string, string> {
  return {
    'user-agent': activeUserAgent ?? USER_AGENT_CANDIDATES[0] ?? '',
    referer: HOME_ENDPOINT,
  }
}

/**
 * 搜索 / 取 cid / 取音轨的超时。
 *
 * 8 秒：搜索是"人正在等结果"，而取 cid + 取音轨是串行的两次调用，各自都要留足。
 * 拉流是另一回事，它有自己那个只管响应头的 STREAM_TIMEOUT_MS。
 */
const API_TIMEOUT_MS = 8_000
/**
 * 拉流超时。
 *
 * ⚠️ 它只约束"拿到响应头"这一段，**不约束之后的音频流**。
 * 定时器在拿到响应就清掉：否则一首 4 分钟的歌听到第 15 秒就会被自己掐断，
 * 而症状是"播放器随机停住"，极难联想到超时。
 */
const STREAM_TIMEOUT_MS = 15_000

/** 搜索缓存：同一关键词 5 分钟内直接复用。 */
const CACHE_TTL_MS = 5 * 60_000
/**
 * 缓存上限。
 *
 * 必须有上限：关键词来自用户输入，没有上限的 Map 就是一个慢慢长到 OOM 的
 * 内存泄漏 —— 而 NAS 上这个进程只有 512MB 预算。
 */
const CACHE_MAX = 100

/**
 * 音轨解析缓存（bvid → cid + 音轨地址列表），10 分钟。
 *
 * ⚠️ 这个缓存不是优化，是**正确性要求**：<audio> 一次播放会打出几十上百个
 * Range 请求，每个都会进 /online/stream。没有它，每个 Range 都要串行打两次
 * B 站接口 —— 播放会卡成幻灯片，而且几百个请求足够触发风控把人踢掉。
 *
 * 10 分钟是有依据的上限：音轨地址（baseUrl）带签名，约 2 小时过期。宁可让
 * 10 分钟后重新解析一次，也不要拿着一个已经过期的签名地址去反复试。
 */
const RESOLVE_TTL_MS = 10 * 60_000
/** 解析缓存上限：一首歌一条；200 条对应约 200 首播过的歌。 */
const RESOLVE_MAX = 200
/** cookie 自己的新鲜度上限。B 站按 IP+UA 发凭据，过期很频繁，这里主动换新的。 */
const COOKIE_TTL_MS = 30 * 60_000

/**
 * 测试用的上游调用落盘开关。
 *
 * 为什么要有它：验收"连续两次 Range 请求只打了一次 playurl"必须能**跨进程**
 * 观察 —— 测试脚本在另一个进程里，只能通过 HTTP 摸到服务端。与其为了观测去
 * 加一条调试路由（那会污染 WL_DUMP_ROUTES 的路由快照，还多暴露一个面），
 * 不如让服务端在设置了 WL_MUSIC_ONLINE_TRACE 时把每一次真实上游调用追加一行。
 * 生产环境不设这个变量，这段代码整个不执行。
 */
const TRACE_FILE = process.env.WL_MUSIC_ONLINE_TRACE ?? ''

function trace(line: string): void {
  if (!TRACE_FILE) return
  // 落盘失败绝不能影响播放：观测是旁路，不是主链路。
  appendFile(TRACE_FILE, line + '\n', () => {})
}

export interface OnlineTrack {
  /** 对外唯一标识：bi:<bvid>。前端只会把它原样回传，不解析。 */
  id: string
  name: string
  artist: string
  album: string
  durationMs: number
  /** B 站没有付费墙，搜索结果一律 true；真的取不到发生在 playurl 那一步（404）。 */
  playable: boolean
}

export interface OnlineSearchPayload {
  query: string
  provider: typeof MUSIC_ONLINE_PROVIDER
  results: OnlineTrack[]
  degraded: boolean
  /** 只有 degraded 时出现。 */
  message?: string
}

interface CacheEntry {
  at: number
  payload: OnlineSearchPayload
}

const searchCache = new Map<string, CacheEntry>()

/** BV 号的**唯一**合法形态。B 站与前端都按这个形状走。 */
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/

/** 曲目 ID 的**唯一**合法形态。这个正则就是 SSRF 防线，见 parseOnlineTrackId。 */
const ONLINE_TRACK_ID = /^bi:(BV[0-9A-Za-z]{10})$/

/**
 * 解析 bi:BV...，返回其中的 bvid；不合法返回 null。
 *
 * ⚠️ 这个函数是整条代理链的安全边界：/online/stream 会带着**服务端的网络出口**
 * 去 fetch 上游地址。只要放开成"接受任意字符串"，它就立刻变成一台内网 SSRF
 * 代理（id=bi:http://169.254.169.254/... 之类）。所以只认 bi: + 严格 12 字符的
 * BV 号，且返回给调用方的只有 bvid 本身 —— 用户输入永远拼不进 URL 的主机/路径
 * 部分，只会进查询参数。
 */
export function parseOnlineTrackId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const matched = ONLINE_TRACK_ID.exec(raw.trim())
  // noUncheckedIndexedAccess 下捕获组是 string | undefined，空串不可能（BV + 10 位），兜一下
  return matched?.[1] ?? null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 剥掉标题里的 HTML 标签并还原最常见的实体。
 *
 * B 站的搜索结果是**高亮过的 HTML**，命中词被包在 <em class="keyword"></em> 里：
 *   【无损音质】｜<em class="keyword">晴天</em> - 周杰伦
 * 原样丢给界面，用户看到的就是一坨标签源码。这不是"偶尔出现"，是每条命中都这样。
 */
function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; 必须最后还原：否则 "&amp;lt;" 会被先剥成标签
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * 解析 B 站的 duration。
 *
 * ⚠️ 它是**字符串** "4:30"，超过一小时是 "1:02:33"，不是毫秒 —— 上一版接网易云
 * 时那个字段是毫秒，照抄过来会让每首歌都显示 0:00。这是换 provider 最容易踩的坑之一。
 */
export function parseDurationMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? raw * 1000 : 0
  if (typeof raw !== 'string') return 0
  const parts = raw.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return 0
  let total = 0
  for (const part of parts) {
    const n = Number.parseInt(part, 10)
    if (!Number.isSafeInteger(n) || n < 0) return 0
    total = total * 60 + n
  }
  return total * 1000
}

/** 把上游的一条 video 记录翻译成对外的曲目；字段不像样就丢掉。 */
function toTrack(raw: unknown): OnlineTrack | null {
  if (!raw || typeof raw !== 'object') return null
  const video = raw as Record<string, unknown>
  const bvid = str(video.bvid).trim()
  // bvid 会进 bi:<bvid> 再撞上面的正则。不像样的直接丢弃，
  // 免得"搜出一条 bvid 奇怪的视频"变成 stream 接口的 400 噪声。
  if (!BVID_PATTERN.test(bvid)) return null
  const name = stripHtml(str(video.title))
  if (!name) return null

  return {
    id: 'bi:' + bvid,
    name,
    // B 站没有"歌手"这个概念，最接近的是 UP 主。字段名保持 artist 是为了
    // 前端契约不变（界面上那一行写"歌手 / UP 主"就够了）。
    artist: stripHtml(str(video.author)),
    // 视频没有专辑。字段留着、填空串，前端不用为换源改一行代码。
    album: '',
    durationMs: parseDurationMs(video.duration),
    // B 站没有付费墙：搜索阶段没有"这条放不了"的信息（取音轨是后面的事），
    // 所以恒为 true。真正取不到会走 playurl 那一步的 404。
    playable: true,
  }
}

function remember(key: string, payload: OnlineSearchPayload): void {
  searchCache.set(key, { at: Date.now(), payload })
  // Map 保留插入顺序：超上限就淘汰最早插入的那条。
  while (searchCache.size > CACHE_MAX) {
    const oldest = searchCache.keys().next()
    if (oldest.done) break
    searchCache.delete(oldest.value)
  }
}

/**
 * B 站的风控拒绝码。
 *
 * 它们的意思不是"你要的东西没有"，而是"你现在这个身份我不搭理"：
 *   -352 风控校验失败 / -412 请求被拦截 / -509 请求过于频繁 / -799 请求过于频繁
 * 这几种靠"换一份刚下发的 cookie 再试一次"基本能自愈，所以第一次命中时重试。
 * ⚠️ 重试**不以"手上有 cookie"为前提**：cookie 为空时同样重试 —— 强制重新
 * bootstrap 会重新走候选 UA（可能顺手换掉被淘汰的那个），再拿不到就带空 cookie
 * 再打一次。风控是否触发不完全取决于 cookie，把重试挂在 cookie 存在与否上，
 * 就等于放弃了对"没有 cookie 也能通"这条已知路径的利用。
 */
const RISK_CODES: ReadonlySet<number> = new Set([-352, -412, -509, -799])

interface BiliEnvelope<T> {
  code?: number
  message?: string
  data?: T
}

type ApiResult<T> = { ok: true; data: T | undefined } | { ok: false; code: number }

let cookieCache: { value: string; at: number } | null = null

/**
 * 先访问首页，**尽量**拿它下发的 cookie（buvid3 / b_nut 等）。
 *
 * ⚠️ 拿不到 cookie 不是故障，返回空串继续走。理由是两个实测事实：
 *   ① 首页回 200 但一条 set-cookie 都不下发，最常见的成因是"这个 UA 版本被上游
 *      判成过期/可疑"，而不是网络或接口变了；
 *   ② search/type 在这种状态下**不带 cookie 也回 code=0 + 20 条**。
 * 把"手里有 cookie"当成上游调用的前置硬条件，等于让整个曲库因为一个与它无关的
 * 原因一起变不可用 —— 那正是上一版的事故形态（首页 200、buvid3 缺席、链路全灭）。
 *
 * 真正的网络故障仍然照样抛：连接失败/超时是 fetch 自己抛的，不在这里吞掉，
 * 上层才能把"这台机器出不了网"和"上游说这个视频没有"分开（见 callUpstreamApi）。
 *
 * 候选 UA 逐个试，首个下发 cookie 的胜出并被记住。网络错误**不**换 UA 重试：
 * 那是出口的问题，换 UA 只是白等一个超时。
 */
async function bootstrapCookie(): Promise<string> {
  for (const userAgent of userAgentOrder()) {
    trace('home')
    const res = await fetch(HOME_ENDPOINT, {
      headers: { 'user-agent': userAgent, referer: HOME_ENDPOINT, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    // 首页 HTML 有几百 KB，我们只要 set-cookie，body 立刻丢掉（不 cancel 要等 GC）
    await res.body?.cancel().catch(() => {})
    const pairs: string[] = []
    for (const raw of res.headers.getSetCookie()) {
      const first = raw.split(';')[0]?.trim() ?? ''
      // 只收 name=value；没有等号的（属性残片）丢掉
      if (first.includes('=')) pairs.push(first)
    }
    const value = pairs.join('; ')
    // 200 但零 cookie → 这个 UA 已被上游淘汰，换下一个
    if (!value) continue
    activeUserAgent = userAgent
    cookieCache = { value, at: Date.now() }
    return value
  }

  // 一个候选都没下发 cookie：空手继续走，但仍要把身份固定下来 ——
  // 每次请求换一个 UA 会让风控把这一串请求当成扫描。
  activeUserAgent ??= USER_AGENT_CANDIDATES[0] ?? ''
  trace('home empty-cookie')
  // 空 cookie 也缓存 30 分钟：否则每次上游调用都要先白打一遍首页。
  cookieCache = { value: '', at: Date.now() }
  return ''
}

async function currentCookie(force: boolean): Promise<string> {
  if (!force && cookieCache && Date.now() - cookieCache.at < COOKIE_TTL_MS) return cookieCache.value
  return await bootstrapCookie()
}

/**
 * 打一次 B 站 API，返回它的 data。
 *
 * 两种失败必须分开：
 *   · **网络层**失败（超时 / DNS / 连不上 / 不是 JSON）→ throw。上层翻译成
 *     "这台机器出不了网"（搜索 degraded，拉流 502）。
 *   · 上游答了但 code≠0 → 返回 ok:false。这是"这个视频没有"，属于业务结果
 *     （拉流 404），跟网络无关。
 * 混成一个分支的代价是：断网时用户会看到"这个视频已失效"，而真相是整个机器没网。
 */
async function callUpstreamApi<T>(url: URL, traceTag: string): Promise<ApiResult<T>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // attempt > 0 = 风控重试：强制重新 bootstrap（并可能连带换 UA），拿不到就空手再打。
    const cookie = await currentCookie(attempt > 0)
    trace(traceTag)
    const headers: Record<string, string> = {
      ...upstreamHeaders(),
      accept: 'application/json, text/plain, */*',
    }
    // cookie 为空就不发这个头：空的 Cookie 头没有任何语义，只是噪声。
    if (cookie) headers.cookie = cookie
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, code: res.status }
    const body = (await res.json()) as BiliEnvelope<T>
    const code = typeof body.code === 'number' ? body.code : 0
    if (code === 0) return { ok: true, data: body.data }
    // 风控拒绝：换一份新 cookie 再试一次；第二次还是失败就如实回报。
    if (!RISK_CODES.has(code) || attempt === 1) return { ok: false, code }
  }
  return { ok: false, code: 0 }
}

interface BiliSearchData {
  result?: unknown
}

/**
 * 搜索视频。
 *
 * 一页固定 20 条（pagesize 不归我们管），limit 只做截取 —— 不做翻页：
 * 这是个"试听用"的曲库，为了第 21 条再串行打一次接口，收益远小于代价。
 */
async function fetchBilibiliSearch(query: string, limit: number): Promise<OnlineTrack[]> {
  const url = new URL(SEARCH_ENDPOINT)
  url.searchParams.set('search_type', 'video')
  url.searchParams.set('keyword', query)
  url.searchParams.set('page', '1')

  const res = await callUpstreamApi<BiliSearchData>(url, 'search ' + query)
  if (!res.ok) throw new Error('哔哩哔哩搜索失败 code=' + res.code)
  const raw = res.data?.result
  if (!Array.isArray(raw)) return []

  const out: OnlineTrack[] = []
  for (const video of raw) {
    const track = toTrack(video)
    if (track) out.push(track)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 关键词搜索。
 *
 * **永远不抛异常**：上游挂了就返回 degraded 的 200。理由见 MUSIC_ONLINE_DEGRADED_MESSAGE。
 */
export async function searchOnlineTracks(query: string, limit: number): Promise<OnlineSearchPayload> {
  const key = limit + '|' + query
  const cached = searchCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload

  try {
    const results = await fetchBilibiliSearch(query, limit)
    const payload: OnlineSearchPayload = {
      query,
      provider: MUSIC_ONLINE_PROVIDER,
      results,
      degraded: false,
    }
    remember(key, payload)
    return payload
  } catch {
    // 失败**不进缓存**：外网刚恢复时，谁也不愿意还要再看 5 分钟"连不上"。
    return {
      query,
      provider: MUSIC_ONLINE_PROVIDER,
      results: [],
      degraded: true,
      message: MUSIC_ONLINE_DEGRADED_MESSAGE,
    }
  }
}

/**
 * 私网/本机地址判定。
 *
 * 上游是哔哩哔哩，正常只会跳到自己的 CDN；但"上游返回什么就 fetch 什么"这件事
 * 本身不该无条件相信。这一步是**纵深防御**：万一外链被劫持，
 * 也打不到 169.254.169.254 / 127.0.0.1 / 内网 192.168.x 这些地方去。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

/** 把上游给的音频地址变成可 fetch 的绝对地址；不像样（或指向内网）就返回 null。 */
function toSafeMediaUrl(raw: string): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (isPrivateHost(url.hostname)) return null
  return url.toString()
}

export type OnlineStreamSource =
  /** 拿到音轨：urls 已按带宽降序排好，第一条最好，后面是它的备份与降档。 */
  | { kind: 'direct'; urls: string[] }
  /** 这个稿件没有能放的音轨（失效/番剧/大会员）。这是"设计如此"，不是故障 → 404。 */
  | { kind: 'no-audio' }
  /** 上游连不上 / 超时 / 风控拒绝重试后仍失败 → 502。 */
  | { kind: 'unavailable' }

type DirectSource = Extract<OnlineStreamSource, { kind: 'direct' }>

interface ResolveCacheEntry {
  at: number
  source: DirectSource
}

const resolveCache = new Map<string, ResolveCacheEntry>()

function rememberResolve(bvid: string, source: DirectSource): void {
  resolveCache.set(bvid, { at: Date.now(), source })
  while (resolveCache.size > RESOLVE_MAX) {
    const oldest = resolveCache.keys().next()
    if (oldest.done) break
    resolveCache.delete(oldest.value)
  }
}

type BiliPageListData = Array<{ cid?: unknown }>

/** bvid → 第一 P 的 cid。上游答了但没有 cid（稿件被删/不可见）返回 null。 */
async function fetchCid(bvid: string): Promise<number | null> {
  const url = new URL(PAGELIST_ENDPOINT)
  url.searchParams.set('bvid', bvid)

  const res = await callUpstreamApi<BiliPageListData>(url, 'pagelist ' + bvid)
  if (!res.ok) return null
  const first = Array.isArray(res.data) ? res.data[0] : undefined
  const cid = first?.cid
  return typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0 ? cid : null
}

interface BiliPlayUrlData {
  dash?: { audio?: unknown }
}

interface AudioCandidate {
  url: string
  backups: string[]
  bandwidth: number
}

function toAudioCandidate(raw: unknown): AudioCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const audio = raw as Record<string, unknown>
  const url = toSafeMediaUrl(str(audio.baseUrl))
  if (!url) return null
  const backups: string[] = []
  if (Array.isArray(audio.backupUrl)) {
    for (const item of audio.backupUrl) {
      const safe = toSafeMediaUrl(str(item))
      if (safe) backups.push(safe)
    }
  }
  return { url, backups, bandwidth: num(audio.bandwidth) }
}

/**
 * bvid + cid → 可 fetch 的音频地址列表。
 *
 * fnval=16 是"我要 DASH"：只有 DASH 响应里才有独立的 dash.audio（纯音轨）。
 * 不带它拿到的是 durl（整段视频的 flv/mp4），白白多下几百兆画面。
 *
 * 排序按 bandwidth 降序 —— 实测三档 30216(64k)/30232(128k)/30280(192k)，取第一条。
 * 列表里每条后面跟着它自己的 backupUrl，最后再接下一档：这样"最清晰的那条挂了"
 * 会先试它的备用地址，再退化到次一档，而不是直接判定失败。
 */
async function fetchAudioUrls(bvid: string, cid: number): Promise<string[]> {
  const url = new URL(PLAYURL_ENDPOINT)
  url.searchParams.set('bvid', bvid)
  url.searchParams.set('cid', String(cid))
  url.searchParams.set('fnval', '16')
  url.searchParams.set('fourk', '1')

  const res = await callUpstreamApi<BiliPlayUrlData>(url, 'playurl ' + bvid)
  if (!res.ok) return []
  const raw = res.data?.dash?.audio
  if (!Array.isArray(raw)) return []

  const candidates = raw
    .map(toAudioCandidate)
    .filter((item): item is AudioCandidate => item !== null)
    .sort((a, b) => b.bandwidth - a.bandwidth)

  const urls: string[] = []
  for (const candidate of candidates) {
    urls.push(candidate.url, ...candidate.backups)
  }
  return urls
}

async function resolveUpstream(bvid: string): Promise<OnlineStreamSource> {
  try {
    const cid = await fetchCid(bvid)
    if (cid === null) return { kind: 'no-audio' }
    const urls = await fetchAudioUrls(bvid, cid)
    if (urls.length === 0) return { kind: 'no-audio' }
    return { kind: 'direct', urls }
  } catch {
    // 网络层失败（超时 / DNS / 非 JSON）—— 与"这个稿件没有音轨"是两件事：
    // 前者是这台机器出不了网（502），后者是这个视频真没有（404）。
    return { kind: 'unavailable' }
  }
}

/**
 * 把曲目 bvid 解析成真正的音频地址（走缓存）。
 *
 * 缓存命中时**一次上游都不打** —— 这就是 <audio> 那几十个 Range 请求不会
 * 变成几十轮 pagelist+playurl 的原因。失败结果不进缓存：理由与搜索缓存一致。
 */
export async function resolveOnlineStreamSource(bvid: string): Promise<OnlineStreamSource> {
  const cached = resolveCache.get(bvid)
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.source

  const source = await resolveUpstream(bvid)
  if (source.kind === 'direct') rememberResolve(bvid, source)
  return source
}

export interface OnlineUpstream {
  /** 200 或 206。 */
  status: number
  contentType: string
  contentLength: string | null
  contentRange: string | null
  body: NodeReadableStream<Uint8Array>
}

/** 单条候选地址的一次尝试。失败返回 null，让调用方去试下一个。 */
async function openOneStream(
  url: string,
  range: string | undefined,
  signal: AbortSignal,
): Promise<OnlineUpstream | null> {
  const headers: Record<string, string> = { ...upstreamHeaders(), accept: '*/*' }
  if (range && range.length <= 200) headers.range = range

  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  // 成功时要把 abort 监听**留在** signal 上（客户端关页面就要靠它断上游），
  // 失败才摘掉 —— 否则连续试几个备用地址会在同一个 signal 上堆一堆监听。
  let keep = false

  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const upstreamType = (res.headers.get('content-type') ?? '').toLowerCase()
    // 上游用 200 + text/html 表示"这个地址没有音频"（风控页/错误页）。
    // 别把网页当音频喂给 <audio>，那只会让播放器报一个看不懂的解码错误。
    if (upstreamType.includes('text/html')) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.body) return null
    keep = true
    return {
      status: res.status,
      // ⚠️ 上游给的是 video/mp4 或 application/octet-stream。原样转给 <audio>，
      // 部分浏览器会按"视频"去挑解码器、然后因为没画面而报错，所以这里自己盖章成
      // audio/mp4 —— 内容确实是标准 fMP4（首字节 ftyp isom），只是标签写错了。
      contentType: upstreamType.startsWith('audio/') ? upstreamType : 'audio/mp4',
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      body: res.body,
    }
  } catch {
    return null
  } finally {
    // ⚠️ 只给"拿到响应头"限时。清掉定时器之后，音频流才能一路走完。
    clearTimeout(timer)
    if (!keep) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 打开上游音频流。
 *
 * urls 是 resolveOnlineStreamSource 给的降序候选列表，逐个试到第一个能用的：
 * B 站 CDN 的签名地址偶尔会 403，而备用地址通常立刻就能用。
 *
 * range 原样转给上游：CDN 自己会算 206 与 content-range，我们只做透传。
 * 自己算 Range 是没必要的重复实现，而重复实现最容易在上游换 CDN 时出错。
 *
 * signal 由调用方（路由）在客户端断开时 abort —— 用户拖进度条会立刻放弃
 * 上一条请求，不 abort 上游就会在 NAS 上堆一堆走不完的连接。
 *
 * 返回 null 表示"全都拿不到"。调用方翻译成 502。
 */
export async function openOnlineStream(
  urls: readonly string[],
  range: string | undefined,
  signal: AbortSignal,
): Promise<OnlineUpstream | null> {
  for (const url of urls) {
    const opened = await openOneStream(url, range, signal)
    if (opened) return opened
    // 客户端已经走了就别再试剩下的：答案没人收，只是白打上游。
    if (signal.aborted) return null
  }
  return null
}
