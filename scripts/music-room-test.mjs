/**
 * 听歌房 HTTP 层测试。
 *
 * 命脉：**权限**（只能排播自己读得到的音频、只能撤自己的歌）与
 * **切歌状态机**（token 防旧上报、队列空则停播、文件删除不断声）。
 *
 * 用法：先启动后端（干净库），然后  node scripts/music-room-test.mjs
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5)

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}` : ''}`)
}

function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(name)
  else bad(name, `期望 ${b}，实际 ${a}`)
}

function makeClient() {
  let cookie = ''
  const request = async function request(path, method = 'GET', body, rawBody) {
    const headers = {}
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json'
    if (rawBody !== undefined) headers['content-type'] = 'application/octet-stream'
    if (cookie) headers.cookie = cookie
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: res.status, body: json }
  }
  return request
}

/** 最小合法 WAV（RIFF/WAVE 头 + fmt + data），mime 按文件头识别为 audio/wav。 */
function wavBytes() {
  const sampleCount = 8
  const dataSize = sampleCount * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const w = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true)
  v.setUint32(28, 16000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, dataSize, true)
  return new Uint8Array(buf)
}

async function uploadFile(client, name, bytes, space = 'shared') {
  const sha = await crypto.subtle.digest('SHA-256', bytes).then((h) =>
    [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  )
  const init = await client('/api/uploads', 'POST', {
    name,
    size: bytes.byteLength,
    sha256: sha,
    space,
  })
  if (init.status !== 200) throw new Error(`上传会话失败：${init.status} ${JSON.stringify(init.body)}`)
  if (init.body.instant === true) return init.body.nodeId
  const res = await client(`/api/uploads/${init.body.uploadId}/chunk?offset=0`, 'PUT', undefined, bytes)
  if (res.status !== 200) throw new Error(`上传分片失败：${res.status}`)
  const done = await client(`/api/uploads/${init.body.uploadId}/complete`, 'POST')
  if (done.status !== 200) throw new Error(`完成上传失败：${done.status}`)
  return done.body.nodeId
}

// ---------------------------------------------------------------- 准备

console.log('【准备】')

const creator = makeClient()
{
  let res = await creator('/api/auth/register', 'POST', {
    username: `musicown${SUFFIX}`,
    displayName: '房主',
    password: 'music-pass-2026',
  })
  if (res.status !== 200) {
    res = await creator('/api/auth/login', 'POST', { username: `musicown${SUFFIX}`, password: 'music-pass-2026' })
  }
  assert(res.status === 200, '账号就绪：房主', `status=${res.status}`)
}

async function makeMember(username, display) {
  const client = makeClient()
  const inv = await creator('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'music 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName: display,
    password: 'music-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'music-pass-2026' })
  }
  assert(res.status === 200, `账号就绪：${display}`, `status=${res.status}`)
  return client
}

const alice = await makeMember(`musicalice${SUFFIX}`, '小爱')
const bob = await makeMember(`musicbob${SUFFIX}`, '小波')

// 共享区两首歌 + 一个非音频 + 小爱私有区一首
const songA = await uploadFile(creator, '晴天.wav', wavBytes())
const songB = await uploadFile(creator, '夜曲.wav', wavBytes())
const notAudio = await uploadFile(creator, '不是歌.txt', new TextEncoder().encode('hello'))
const privateSong = await uploadFile(alice, '小爱的私藏.wav', wavBytes(), 'private')

const tracksOf = async (client) => (await client('/api/music/tracks')).body.tracks.map((t) => t.name)

// ---------------------------------------------------------------- 曲目列表

console.log('\n【可排播曲目】')

eq(
  (await tracksOf(creator)).sort(),
  ['夜曲.wav', '小爱的私藏.wav', '晴天.wav'],
  '管理员看得见全部音频（含他人私有）',
)
eq(await tracksOf(bob), ['夜曲.wav', '晴天.wav'], '普通成员看不到他人私有音频')

let res = await bob('/api/music/queue', 'POST', { nodeId: privateSong })
assert(res.status === 403, '排播他人私有音频被拒（403）', `status=${res.status}`)

res = await bob('/api/music/queue', 'POST', { nodeId: notAudio })
assert(res.status === 400, '非音频文件被拒（400）', `status=${res.status}`)

// ---------------------------------------------------------------- 队列与开播

console.log('\n【队列与开播】')

let view = (await alice('/api/music/queue', 'POST', { nodeId: songA })).body
assert(view.nowPlaying !== null, '首首歌立刻开播（不用等人按播放）')
eq(view.nowPlaying.name, '晴天.wav', '正在播 = 队头')
eq(view.nowPlaying.startedByName, '小爱', '排歌人被记录')
eq(view.queue.length, 0, '开播后队头出队')

view = (await bob('/api/music/queue', 'POST', { nodeId: songB })).body
eq(view.queue.length, 1, '第二首排在队列里')
eq(view.queue[0].name, '夜曲.wav', '队列项正确')

const queuedId = view.queue[0].id
res = await bob(`/api/music/queue/${queuedId}`, 'DELETE')
eq(res.status, 200, '排歌人能撤下自己的歌')
view = res.body
eq(view.queue.length, 0, '撤下后队列清空')

// 再排一首用于后面的切歌流程
await bob('/api/music/queue', 'POST', { nodeId: songB })

// ---------------------------------------------------------------- 切歌状态机

console.log('\n【切歌状态机】')

res = await alice('/api/music/skip', 'POST')
eq(res.status, 200, '任何成员都能切歌（听歌厅的社交契约）')
eq(res.body.nowPlaying.name, '夜曲.wav', '切歌后播放队头')
const token1 = res.body.nowPlaying.playedToken

// 用旧 token 上报 ended：必须被忽略
res = await alice('/api/music/ended', 'POST', { playedToken: token1 - 1 })
eq(res.body.advanced, false, '旧 token 的播完上报被忽略')

res = await bob('/api/music/ended', 'POST', { playedToken: token1 })
eq(res.body.advanced, true, '当前 token 的播完上报生效')
const roomAfter = (await alice('/api/music/room')).body
eq(roomAfter.nowPlaying, null, '队列空了就停播（不自动循环）')

res = await bob('/api/music/skip', 'POST')
assert(res.status === 400, '没在放歌时切歌被拒（400）', `status=${res.status}`)

res = await bob('/api/music/ended', 'POST', { playedToken: token1 })
eq(res.body.advanced, false, '停播后的上报同样无效')

// ---------------------------------------------------------------- 文件删除

console.log('\n【文件删除不断声】')

// 此时无歌在播：排一首、再排一首 —— 首首自动开播，第二首进队列
await bob('/api/music/queue', 'POST', { nodeId: songA })
await bob('/api/music/queue', 'POST', { nodeId: songB })
view = (await alice('/api/music/room')).body
eq(view.nowPlaying?.name, '晴天.wav', '首首排播自动开播')
eq(view.queue.length, 1, '第二首在队列里')

// 删“正在播”的文件：只有能写该文件的人能删（shared 区 = 上传者/管理员）
res = await creator(`/api/files/${songA}`, 'DELETE')
eq(res.status, 200, '删除正在播的文件（上传者）')
view = (await alice('/api/music/room')).body
eq(view.nowPlaying?.name, '夜曲.wav', '自动跳到下一首（厅里不断声）')
eq(view.queue.length, 0, '队列引用同步清理')

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
