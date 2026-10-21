/**
 * 文件的 HTTP Range 支持。
 *
 * 这条测试是为用户的一句话写的：「视频无法正常预览了，并且无法快进进度条」。
 *
 * 两个症状是同一个根因：服务端以前完全不看 `Range` 请求头，一律回
 * `200` + 整份文件。而浏览器播音视频**从来不是**一次普通 GET：
 *   - 起播前先发 `Range: bytes=0-` 读容器头；
 *   - mp4 的 moov 在文件尾时再发 `Range: bytes=-65536` 扫尾部；
 *   - 拖动进度条又是一次 Range 请求。
 * 服务器忽略 Range 的后果就是"大文件等到天荒地老才出画面"和"拖一下从 0 重来"。
 *
 * 所以这里逐条钉死 206 / 416 / 头的形状与**字节内容**：
 * 只看状态码会漏掉"回了 206 但发的是整份"这种最常见的假实现。
 *
 * 用法：由 scripts/run-all-tests.mjs 起好服务端后运行。
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)

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

function makeClient() {
  let cookie = ''
  return {
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      let body = options.body
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const text = await res.text()
      let parsed = text
      try {
        parsed = JSON.parse(text)
      } catch {
        /* 非 JSON 就原样返回 */
      }
      return { status: res.status, body: parsed, headers: res.headers }
    },
    /** 拿原始字节，不当文本解析。 */
    async raw(path, headers = {}) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie, ...headers } })
      const buf = Buffer.from(await res.arrayBuffer())
      return { status: res.status, buf, headers: res.headers }
    },
    /** 只要头，不要 body（播放器起播前会先 HEAD 探一次）。 */
    async head(path) {
      const res = await fetch(`${BASE}${path}`, { method: 'HEAD', headers: cookie ? { cookie } : {} })
      await res.arrayBuffer()
      return { status: res.status, headers: res.headers }
    },
  }
}

const client = makeClient()
const { createHash } = await import('node:crypto')

// ---------------------------------------------------------------- 造一个"视频"
//
// 内容不需要真能解码 —— 这条测试验的是**字节搬运**，不是解码器。
// 但 mime 必须被识别成 video/mp4，否则走不到音视频那条路径，
// 所以前 16 字节写成 ftyp 盒子（服务端按文件头定类型，不看扩展名）。
const SIZE = 2 * 1024 * 1024 + 137 // 故意不是整 MiB，末段长度才不会被巧合掩盖
const payload = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i++) payload[i] = i % 251
Buffer.from([0x00, 0x00, 0x00, 0x18]).copy(payload, 0)
payload.write('ftypisom', 4, 'latin1')

const sha = createHash('sha256').update(payload).digest('hex')

console.log('【准备】')
const RANGE_USER = `range${SUFFIX}`
const RANGE_PASS = 'range-password-2026'

let reg = await client.api('/api/auth/register', {
  method: 'POST',
  json: {
    username: RANGE_USER,
    displayName: `Range 测试${SUFFIX}`,
    password: RANGE_PASS,
  },
})
if (reg.status !== 200 && reg.status !== 201) {
  // 库里已有其他用户（手动重复跑）：用同名账号登录
  reg = await client.api('/api/auth/login', {
    method: 'POST',
    json: { username: RANGE_USER, password: RANGE_PASS },
  })
  assert(reg.status === 200, '使用上次运行注册的账号登录', `状态 ${reg.status}`)
} else {
  assert(true, '注册测试账号', `状态 ${reg.status}`)
}

const folder = await client.api('/api/files/folder', {
  method: 'POST',
  json: { name: `视频-${SUFFIX}`, space: 'shared' },
})
assert(folder.status === 200, '建目录', `状态 ${folder.status}`)
const parentId = folder.body.node?.id ?? folder.body.id

const init = await client.api('/api/uploads', {
  method: 'POST',
  json: { parentId, name: `录像-${SUFFIX}.mp4`, size: SIZE, sha256: sha, space: 'shared' },
})
assert(init.status === 200, '开启上传会话')

const uploadId = init.body.uploadId
const CHUNK = 512 * 1024
let offset = 0
while (offset < SIZE) {
  const slice = payload.subarray(offset, Math.min(offset + CHUNK, SIZE))
  const res = await client.api(`/api/uploads/${uploadId}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: slice,
  })
  if (res.status !== 200) {
    bad('上传分片', `偏移 ${offset} 返回 ${res.status}`)
    break
  }
  offset = res.body.received
}
const done = await client.api(`/api/uploads/${uploadId}/complete`, { method: 'POST' })
assert(done.status === 200 && done.body.mime === 'video/mp4', '上传完成且被识别为 video/mp4', String(done.body.mime))
const fileId = done.body.nodeId
const PREVIEW = `/api/files/${fileId}/preview`

/** 断言返回的这段字节与整份里的对应切片一致。 */
function assertSlice(name, got, start, endInclusive) {
  const expect = payload.subarray(start, endInclusive + 1)
  if (got.length !== expect.length) {
    bad(name, `长度 ${got.length}，期望 ${expect.length}`)
    return
  }
  const same = got.equals(expect)
  assert(same, name, same ? `${start}-${endInclusive}（${got.length} 字节）` : '字节内容与整份文件不符')
}

// ---------------------------------------------------------------- 整份
console.log('\n【不带 Range】')

let full = await client.raw(PREVIEW)
assert(full.status === 200, '整份预览返回 200')
assert(full.buf.length === SIZE, '整份长度正确', `${full.buf.length}/${SIZE}`)
assert(full.headers.get('accept-ranges') === 'bytes', '声明 accept-ranges: bytes', String(full.headers.get('accept-ranges')))
assert(
  full.headers.get('content-length') === String(SIZE),
  'content-length 为文件大小',
  String(full.headers.get('content-length')),
)
assert(full.headers.get('content-range') === null, '整份响应不带 content-range')

// ---------------------------------------------------------------- 单段
console.log('\n【单段 Range】')

let r = await client.raw(PREVIEW, { range: 'bytes=0-99' })
assert(r.status === 206, 'bytes=0-99 返回 206', String(r.status))
assert(r.headers.get('content-range') === `bytes 0-99/${SIZE}`, 'content-range 形状正确', String(r.headers.get('content-range')))
assert(r.headers.get('content-length') === '100', 'content-length 是段长而不是文件大小', String(r.headers.get('content-length')))
assertSlice('bytes=0-99 的内容正确', r.buf, 0, 99)

// 视频拖动进度条打的就是这种"从中间某一字节开始"的请求
r = await client.raw(PREVIEW, { range: 'bytes=1048576-1048675' })
assert(r.status === 206, '中段 bytes=1048576-1048675 返回 206')
assert(r.headers.get('content-range') === `bytes 1048576-1048675/${SIZE}`, '中段 content-range 正确')
assertSlice('中段内容正确（拖进度条拿到的就是这一段）', r.buf, 1048576, 1048675)

// 开放结尾：播放器起播最常见的一条
r = await client.raw(PREVIEW, { range: 'bytes=1000-' })
assert(r.status === 206, 'bytes=1000- 返回 206')
assert(r.buf.length === SIZE - 1000, '开放结尾一直发到文件末尾', `${r.buf.length}/${SIZE - 1000}`)
assertSlice('开放结尾内容正确', r.buf, 1000, SIZE - 1)

// end 越界必须钳到末尾，而不是 416 —— 播放器会发一个"比文件大"的 end
r = await client.raw(PREVIEW, { range: `bytes=100-${SIZE + 9999}` })
assert(r.status === 206, 'end 越界仍返回 206（钳到末尾）', String(r.status))
assert(r.buf.length === SIZE - 100, 'end 越界时长度钳到文件末尾', String(r.buf.length))
assertSlice('end 越界的内容正确', r.buf, 100, SIZE - 1)

// 后缀式：mp4 的 moov 在文件尾时，浏览器就这么拿
r = await client.raw(PREVIEW, { range: 'bytes=-100' })
assert(r.status === 206, 'bytes=-100 返回 206')
assert(r.buf.length === 100, '后缀式长度为 100', String(r.buf.length))
assertSlice('bytes=-100 取的是最后 100 字节', r.buf, SIZE - 100, SIZE - 1)

// 后缀大于文件：整份
r = await client.raw(PREVIEW, { range: `bytes=-${SIZE + 5000}` })
assert(r.status === 206, '后缀大于文件仍 206')
assert(r.buf.length === SIZE, '后缀大于文件时返回整份', String(r.buf.length))

// ---------------------------------------------------------------- 416
console.log('\n【越界与非法】')

r = await client.raw(PREVIEW, { range: `bytes=${SIZE}-` })
assert(r.status === 416, '起点在末尾之外返回 416', String(r.status))
assert(
  r.headers.get('content-range') === `bytes */${SIZE}`,
  '416 带 content-range: bytes */size（播放器据此判断文件变短）',
  String(r.headers.get('content-range')),
)

r = await client.raw(PREVIEW, { range: 'bytes=-0' })
assert(r.status === 416, 'bytes=-0（后缀为 0）返回 416', String(r.status))

// ---------------------------------------------------------------- 忽略 Range 的两种
console.log('\n【语法不支持时退回整份】')

r = await client.raw(PREVIEW, { range: 'bytes=0-99,200-299' })
assert(r.status === 200, '多段 Range 退回 200（规范允许忽略）', String(r.status))
assert(r.buf.length === SIZE, '多段 Range 时发整份', String(r.buf.length))

r = await client.raw(PREVIEW, { range: 'bytes=500-400' })
assert(r.status === 200, 'end < start 退回 200', String(r.status))
assert(r.buf.length === SIZE, 'end < start 时发整份', String(r.buf.length))

r = await client.raw(PREVIEW, { range: 'items=0-99' })
assert(r.status === 200, '单位不是 bytes 时退回 200', String(r.status))

r = await client.raw(PREVIEW, { range: 'bytes=abc' })
assert(r.status === 200, '语法错误时退回 200（不 500）', String(r.status))

// ---------------------------------------------------------------- HEAD
console.log('\n【HEAD 探测】')

const head = await client.head(PREVIEW)
assert(head.status === 200, 'HEAD 返回 200', String(head.status))
assert(head.headers.get('content-length') === String(SIZE), 'HEAD 带 content-length（播放器起播前要知道总长）')
assert(head.headers.get('accept-ranges') === 'bytes', 'HEAD 带 accept-ranges')

// ---------------------------------------------------------------- 下载也支持
console.log('\n【下载的断点续传】')

r = await client.raw(`/api/files/${fileId}/download`, { range: 'bytes=0-9' })
assert(r.status === 206, '下载接口同样支持 Range（断点续传）', String(r.status))
assert(r.headers.get('content-disposition')?.includes('attachment') ?? false, '下载仍是 attachment')

// ---------------------------------------------------------------- 权限没有因为 Range 放宽
console.log('\n【Range 不放宽权限】')

{
  const anon = await fetch(`${BASE}${PREVIEW}`, { headers: { range: 'bytes=0-9' } })
  assert(anon.status === 401, '未登录即使带 Range 也是 401', String(anon.status))
  await anon.arrayBuffer()
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
