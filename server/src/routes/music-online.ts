/**
 * 在线曲库路由。真正的逻辑在 music-online.ts，这里只做鉴权、参数校验、限流与转发。
 *
 * 为什么流式接口要把音频转一手而不是把外链给前端：
 *   ① 外链是 http:// 的，https 页面里会被混合内容策略拦掉；
 *   ② 外链透给浏览器就等于"登录只保护了页面，没保护内容"——拿到链接谁都能刷。
 * 浏览器只认识 /api/music/online/stream?id=bi:BV... 这一个地址。
 */
import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import {
  MUSIC_ONLINE_NO_AUDIO_MESSAGE,
  attachOnlineCacheTee,
  openCachedOnlineTrack,
  openOnlineStream,
  parseOnlineTrackId,
  resolveOnlineStreamSource,
  searchOnlineTracks,
} from '../music-online.ts'
import { HttpError } from '../files.ts'
import { enforceRateLimit, requireUser } from './auth-guard.ts'

/** 搜索关键词长度上限。够长（能打一句歌词），又不至于拿一整本书当关键词。 */
const MAX_QUERY_LENGTH = 60
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30

export function registerMusicOnlineRoutes(app: FastifyInstance): void {
  /**
   * 关键词搜歌。
   *
   * ⚠️ 上游失败/超时/这台机器没网时**仍然是 200 + degraded:true**，不是 5xx：
   * 用户要的是"搜不到歌"，不是"这个服务坏了"。5xx 会让前端把它当成故障弹错误、
   * 甚至触发重试风暴，而真正该发生的是把 MUSIC_ONLINE_DEGRADED_MESSAGE 显示出来。
   */
  app.get('/api/music/online/search', async (req) => {
    const user = requireUser(req)
    const q = req.query as { q?: unknown; limit?: unknown }
    const keyword = typeof q.q === 'string' ? q.q.trim() : ''
    if (keyword.length < 1 || keyword.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, `搜索关键词长度必须是 1-${MAX_QUERY_LENGTH} 个字`)
    }

    // 先校验再限流：上面那些 400 一个请求都没打到上游，不该占用用户的配额。
    // 按账号计（键里不含 IP）：社团办公室走同一个 NAT，按 IP 计会互相误伤 ——
    // 与 RATE_RULES.musicOnlineSearch 里的说明同一条理由。
    enforceRateLimit(req, 'musicOnlineSearch', `:${user.id}`, true)

    // limit 超范围就夹到边界，而不是报 400：它只是"多一条少一条"，
    // 不值得让一个打字快的用户看到错误。
    const parsed = Number.parseInt(typeof q.limit === 'string' ? q.limit : '', 10)
    const limit = Number.isFinite(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : DEFAULT_LIMIT

    return await searchOnlineTracks(keyword, limit)
  })

  /**
   * 代理拉流（含 Range）。
   *
   * ⚠️ **这里刻意不叠限流**：拖动进度条会瞬间产生大量 Range 请求，
   * 限流会让音频直接断在半路（routes/board.ts 与 ratelimit.ts 里记着同一个坑）。
   * 这条接口的资源保护靠的是"只接受 bi:BV..."和上游本身的 Range 语义。
   */
  app.get('/api/music/online/stream', async (req, reply) => {
    requireUser(req)

    // SSRF 防线：只认 bi:BV...。这条接口带着服务端的网络出口去 fetch，
    // 一旦接受任意 URL/主机名，它就是一台内网代理。返回的 bvid 只会进查询参数，
    // 永远拼不进上游 URL 的主机/路径部分。
    // 参数名两个都认：trackId 是前后端契约里写的名字，id 是本文件早期的实现名。
    // 只认一个的代价不对称 —— 发错时 <audio> 只会静默无声（400 被播放器吞掉），
    // 排查成本远高于多读一个键。
    const query = req.query as { id?: unknown; trackId?: unknown }
    const bvid = parseOnlineTrackId(query.trackId ?? query.id)
    if (!bvid) throw new HttpError(400, '曲目 ID 不合法（只接受 bi:BV...）')

    // ① 磁盘缓存优先。
    //    命中时**完全不打上游**：省掉 pagelist+playurl 两次调用（那条签名地址约
    //    2 小时就过期，少解析一次就少一次踩空），而且让"房间切到在线曲目"的首字节
    //    变成一次本地磁盘读。在线曲目进队列之后这条路径是常态，不是优化。
    const cached = await openCachedOnlineTrack(bvid, req.headers.range)
    if (cached.kind === 'unsatisfiable') {
      // 416 必须带 `bytes */总长`：播放器据此才知道该把进度条拖到哪。
      reply.code(416).header('content-range', `bytes */${cached.size}`)
      return reply.send('')
    }
    if (cached.kind === 'hit') {
      reply.code(cached.status)
      // 与代理路径盖同一个章（audio/mp4）：CDN 给的 video/mp4 或裸
      // octet-stream 都在写入缓存前统一过，两个通道对 <audio> 表现一致。
      reply.header('content-type', 'audio/mp4')
      reply.header('accept-ranges', 'bytes')
      reply.header('x-content-type-options', 'nosniff')
      if (cached.contentRange) reply.header('content-range', cached.contentRange)
      reply.header('content-length', String(cached.end - cached.start + 1))
      return reply.send(cached.body)
    }

    const source = await resolveOnlineStreamSource(bvid)
    // B 站没有网易云那种付费墙，所以这里的 404 不是"要会员才能听这首歌"，
    // 而是"这条稿件本身没有能放的音轨"（番剧/失效/纯直播回放）。
    if (source.kind === 'no-audio') throw new HttpError(404, MUSIC_ONLINE_NO_AUDIO_MESSAGE)
    if (source.kind === 'unavailable') throw new HttpError(502, '在线曲库暂时取不到这首歌')

    // 客户端一断开就把上游也断掉：否则"拖进度条"会在 NAS 上堆一堆走不完的连接。
    const controller = new AbortController()
    reply.raw.on('close', () => controller.abort())

    // 传整个候选列表：最清晰那档的签名地址偶尔 403，备用地址通常立刻能用。
    const upstream = await openOnlineStream(source.urls, req.headers.range, controller.signal)
    if (!upstream) throw new HttpError(502, '在线曲库暂时取不到这首歌')

    // 上游给 206 就回 206：播放器据此确认"这个源支持拖进度条"。
    reply.code(upstream.status)
    reply.header('content-type', upstream.contentType)
    // 这两个自己补：CDN 不一定给 accept-ranges，而播放器靠它判断能不能拖；
    // nosniff 是因为内容是外网来的，别让浏览器按 HTML 去解析它。
    reply.header('accept-ranges', 'bytes')
    reply.header('x-content-type-options', 'nosniff')
    if (upstream.contentRange) reply.header('content-range', upstream.contentRange)
    if (upstream.contentLength) reply.header('content-length', upstream.contentLength)

    // ② 未命中：照常直连代理，同时把这份字节顺手 tee 进磁盘缓存（下满即
    //    rename 成正式文件，下次走 ① 的本地流）。tee 全程旁路：写盘失败只是
    //    "这次没缓存上"，客户端一个字节都不受影响。
    const body = await attachOnlineCacheTee(
      bvid,
      upstream.body,
      {
        status: upstream.status,
        contentRange: upstream.contentRange,
        contentLength: upstream.contentLength,
      },
      controller.signal,
    )

    // 交给 reply.send 直接流式转发：整段读进内存再发，一首 5MB 的歌乘以几路
    // 并发就够让这个 512MB 的容器被 OOM 杀掉。
    return reply.send(Readable.fromWeb(body))
  })
}
