/**
 * 白板 HTTP 层测试。
 *
 * 命脉：**全员可读、作者/管理员可写** 的权限模型，以及场景 JSON 的
 * 形状校验（不合法的数据存进去，客户端整个画布都会挂）。
 *
 * 用法：先启动后端（干净库），然后  node scripts/whiteboard-test.mjs
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
  const request = async function request(path, method = 'GET', body) {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie) headers.cookie = cookie
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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

// ---------------------------------------------------------------- 准备

console.log('【准备】')

const creator = makeClient()
{
  let res = await creator('/api/auth/register', 'POST', {
    username: `wbown${SUFFIX}`,
    displayName: '画师',
    password: 'wb-pass-2026',
  })
  if (res.status !== 200) {
    res = await creator('/api/auth/login', 'POST', { username: `wbown${SUFFIX}`, password: 'wb-pass-2026' })
  }
  assert(res.status === 200, '账号就绪：画师', `status=${res.status}`)
}

async function makeMember(username, display) {
  const client = makeClient()
  const inv = await creator('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'whiteboard 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName: display,
    password: 'wb-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'wb-pass-2026' })
  }
  assert(res.status === 200, `账号就绪：${display}`, `status=${res.status}`)
  return client
}

const alice = await makeMember(`wbalice${SUFFIX}`, '观众')

const SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  elements: [{ id: 'e1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
})

// ---------------------------------------------------------------- 创建与读取

console.log('\n【创建与读取】')

let res = await creator('/api/whiteboards', 'POST', { name: '' })
assert(res.status === 400, '空名字被拒', `status=${res.status}`)

res = await creator('/api/whiteboards', 'POST', { name: 'x'.repeat(61) })
assert(res.status === 400, '超长名字被拒', `status=${res.status}`)

res = await creator('/api/whiteboards', 'POST', { name: '架构草图' })
eq(res.status, 200, '创建白板（默认空场景）')
eq(res.body.board?.data, '{"elements":[]}', '新白板是空场景')
const boardId = res.body.board?.id

res = await alice(`/api/whiteboards/${boardId}`)
eq(res.status, 200, '全员可读白板')
eq(res.body.board?.data, '{"elements":[]}', '内容一致')
eq(res.body.board?.canEdit, false, '非作者不可编辑')

res = await alice('/api/whiteboards')
eq(res.body.boards?.length, 1, '列表可见')

// ---------------------------------------------------------------- 保存

console.log('\n【保存】')

res = await alice(`/api/whiteboards/${boardId}`, 'PUT', { data: SCENE })
assert(res.status === 403, '非作者保存被拒（403）', `status=${res.status}`)

res = await creator(`/api/whiteboards/${boardId}`, 'PUT', { data: 'not-json' })
assert(res.status === 400, '非 JSON 场景被拒', `status=${res.status}`)

res = await creator(`/api/whiteboards/${boardId}`, 'PUT', { data: '{"no":"elements"}' })
assert(res.status === 400, '缺 elements 的场景被拒', `status=${res.status}`)

res = await creator(`/api/whiteboards/${boardId}`, 'PUT', { data: `{"elements":[${'"x".repeat?'}]}` })
assert(res.status === 400, '伪 JSON 被拒', `status=${res.status}`)

res = await creator(`/api/whiteboards/${boardId}`, 'PUT', { data: SCENE })
eq(res.status, 200, '作者保存合法场景')
const detail = (await alice(`/api/whiteboards/${boardId}`)).body.board
eq(detail.data, SCENE, '保存后内容可读回')
assert(detail.updatedAt >= detail.createdAt, '更新时间被刷新')

// 超限场景
const bigScene = JSON.stringify({ elements: [], padding: 'x'.repeat(2 * 1024 * 1024 + 1) })
res = await creator(`/api/whiteboards/${boardId}`, 'PUT', { data: bigScene })
assert(res.status === 400, '超过 2MB 的场景被拒', `status=${res.status}`)

// ---------------------------------------------------------------- 删除

console.log('\n【删除】')

res = await alice(`/api/whiteboards/${boardId}`, 'DELETE')
assert(res.status === 403, '非作者删除被拒（403）', `status=${res.status}`)

res = await creator(`/api/whiteboards/${boardId}`, 'DELETE')
eq(res.status, 200, '作者删除白板')
res = await alice(`/api/whiteboards/${boardId}`)
assert(res.status === 404, '删除后 404', `status=${res.status}`)

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
