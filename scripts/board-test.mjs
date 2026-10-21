/**
 * 留言板 HTTP 层测试。
 *
 * 这个模块的"命脉"是**权限边界**：谁能发、谁能标记已处理、谁能删。
 * 留言板的用途是收集 bug，"已处理"这个标记必须只有管理员能给 —— 否则
 * 提问题的人自己标一下，列表就失去了可信度。所以权限用例占了大半。
 *
 * 用法：先启动后端，然后  node scripts/board-test.mjs
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

function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(name)
  else bad(name, `期望 ${b}，实际 ${a}`)
}

function makeClient() {
  let cookie = ''
  const request = async function request(path, method = 'GET', body) {
    // 只有真的带 body 时才声明 JSON —— 否则 DELETE 这类空 body 请求会被
    // Fastify 拒掉（"Body cannot be empty when content-type is set to
    // 'application/json'"），而报错是 500，看起来像服务端崩了。
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
  request.currentCookie = () => cookie
  return request
}

// ---------------------------------------------------------------- 准备

const admin = makeClient()
{
  let res = await admin('/api/auth/register', 'POST', {
    username: `boardadmin${SUFFIX}`,
    displayName: '板主',
    password: 'board-pass-2026',
  })
  if (res.status !== 200) {
    res = await admin('/api/auth/login', 'POST', {
      username: `boardadmin${SUFFIX}`,
      password: 'board-pass-2026',
    })
  }
  if (res.status !== 200) throw new Error('管理员账号准备失败')
}

async function makeMember(username, displayName) {
  const client = makeClient()
  const inv = await admin('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'board 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName,
    password: 'board-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'board-pass-2026' })
  }
  if (res.status !== 200) throw new Error(`账号 ${username} 准备失败：${res.status}`)
  return client
}

const member = await makeMember(`boardm${SUFFIX}`, '提问题的人')
const other = await makeMember(`boardo${SUFFIX}`, '另一个成员')
console.log(`\n\x1b[1m留言板\x1b[0m  账号 boardadmin${SUFFIX} / boardm${SUFFIX} / boardo${SUFFIX}\n`)

// ---------------------------------------------------------------- 用例

console.log('\n【发留言】')

const anon = makeClient()
{
  const anonList = await anon('/api/board/posts', 'GET')
  assert(anonList.status === 401, '未登录不能看留言板')

  const empty = await member('/api/board/posts', 'POST', { kind: 'bug', body: '   ' })
  assert(empty.status === 400, '空内容被拒（400）')

  const tooLong = await member('/api/board/posts', 'POST', { kind: 'bug', body: 'x'.repeat(801) })
  assert(tooLong.status === 400, '超长内容被拒（400）')

  const badKind = await member('/api/board/posts', 'POST', { kind: 'question', body: '这算哪类' })
  assert(badKind.status === 400, '未知类型被拒（400）')

  const created = await member('/api/board/posts', 'POST', {
    kind: 'bug',
    body: '你画我猜的画笔画不了，只有左上角能动',
  })
  assert(created.status === 200, '成员能发留言')
  const post = created.body?.post
  assert(post?.kind === 'bug', '类型记下来了')
  assert(post?.authorName === '提问题的人', '带作者名', String(post?.authorName))
  assert(post?.mine === true, '对自己的留言标 mine')
  assert(post?.resolvedAt === null, '新留言是未处理')

  // 另一个成员也能看见（留言板是全站一份）
  const otherList = await other('/api/board/posts', 'GET')
  const seen = (otherList.body?.posts ?? []).find((p) => p.id === post.id)
  assert(!!seen, '别的成员能看到这条留言')
  assert(seen?.mine === false, '别人看 mine 是 false')

  // 另外两类也能发
  const idea = await other('/api/board/posts', 'POST', { kind: 'idea', body: '希望加一个深色主题' })
  const complain = await other('/api/board/posts', 'POST', { kind: 'complaint', body: '上传 15G 太慢了' })
  assert(idea.status === 200 && idea.body?.post?.kind === 'idea', '能发「建议」')
  assert(complain.status === 200 && complain.body?.post?.kind === 'complaint', '能发「吐槽」')

  const all = await member('/api/board/posts', 'GET')
  assert(
    (all.body?.posts?.length ?? 0) >= 3,
    '列表里有多条留言',
    `${all.body?.posts?.length ?? 0} 条`,
  )
  // 倒序：最新的在最前
  const ids = (all.body?.posts ?? []).map((p) => p.id)
  assert(ids.indexOf(complain.body.post.id) < ids.indexOf(post.id), '列表按时间倒序')

  // 类型筛选
  const onlyBug = await member('/api/board/posts?kind=bug', 'GET')
  assert(
    (onlyBug.body?.posts ?? []).every((p) => p.kind === 'bug'),
    '按类型筛选只回该类',
    `${onlyBug.body?.posts?.length ?? 0} 条`,
  )
}

console.log('\n【处理状态（仅管理员）】')

let target = null
{
  const list = await member('/api/board/posts', 'GET')
  target = (list.body?.posts ?? []).find((p) => p.body.includes('只有左上角'))

  const byMember = await member(`/api/board/posts/${target.id}/resolve`, 'POST', { resolved: true })
  assert(byMember.status === 403, '普通成员不能标记已处理（403）', `状态 ${byMember.status}`)

  const byAdmin = await admin(`/api/board/posts/${target.id}/resolve`, 'POST', {
    resolved: true,
    resolution: '已修复：画布尺寸按容器取',
  })
  assert(byAdmin.status === 200, '管理员能标记已处理')
  assert(byAdmin.body?.post?.resolvedAt !== null, '处理时间落位')
  assert(byAdmin.body?.post?.resolvedByName === '板主', '记录处理人', String(byAdmin.body?.post?.resolvedByName))
  eq(byAdmin.body?.post?.resolution, '已修复：画布尺寸按容器取', '处理说明存下来了')

  // open=1 不应包含它
  const openOnly = await member('/api/board/posts?open=1', 'GET')
  assert(
    !(openOnly.body?.posts ?? []).some((p) => p.id === target.id),
    '「未处理」筛选里没有已处理的',
  )

  const undo = await admin(`/api/board/posts/${target.id}/resolve`, 'POST', { resolved: false })
  assert(undo.status === 200 && undo.body?.post?.resolvedAt === null, '管理员能撤销处理标记')
  eq(undo.body?.post?.resolution, null, '撤销时处理说明一并清掉')

  // 再标一次，留给后面的删除用例
  await admin(`/api/board/posts/${target.id}/resolve`, 'POST', { resolved: true, resolution: '已修复' })
}

console.log('\n【撤回与删除】')

{
  // 作者能撤回自己「未处理」的
  const mineOpen = await other('/api/board/posts', 'POST', { kind: 'idea', body: '这条待会儿撤回' })
  const target2 = mineOpen.body.post
  const del1 = await other(`/api/board/posts/${target2.id}`, 'DELETE')
  assert(del1.status === 200, '作者能撤回自己未处理的留言', `状态 ${del1.status} ${JSON.stringify(del1.body)} id=${target2?.id}`)

  // 已处理的，作者撤不回
  const delByAuthor = await member(`/api/board/posts/${target.id}`, 'DELETE')
  assert(delByAuthor.status === 400, '已处理的留言作者不能撤回（400）', `状态 ${delByAuthor.status} ${JSON.stringify(delByAuthor.body)}`)

  // 别人的不能删
  const someoneElse = await other('/api/board/posts', 'POST', { kind: 'bug', body: '别人发的' })
  const delByOther = await member(`/api/board/posts/${someoneElse.body.post.id}`, 'DELETE')
  assert(delByOther.status === 403, '不能删别人的留言（403）', `状态 ${delByOther.status}`)

  // 管理员能删任何人的
  const delByAdmin = await admin(`/api/board/posts/${someoneElse.body.post.id}`, 'DELETE')
  assert(delByAdmin.status === 200, '管理员能删任何留言')

  const after = await member('/api/board/posts', 'GET')
  assert(
    !(after.body?.posts ?? []).some((p) => p.id === someoneElse.body.post.id),
    '删掉之后列表里没有了',
  )

  // 用管理员身份测 404：非管理员会先撞 403（权限判定在存在性之前），
  // 那是另一条断言的事
  const missing = await admin('/api/board/posts/post_does_not_exist/resolve', 'POST', { resolved: true })
  assert(missing.status === 404, '不存在的留言返回 404', `状态 ${missing.status}`)
  const missingDel = await admin('/api/board/posts/post_does_not_exist', 'DELETE')
  assert(missingDel.status === 404, '删除不存在的留言也是 404', `状态 ${missingDel.status}`)
}

console.log(
  `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
)
process.exit(failed === 0 ? 0 : 1)
