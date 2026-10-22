/**
 * 投票 HTTP 层测试。
 *
 * 命脉同样是**权限与状态机**：谁能关/删投票、一人一票的约束、
 * 截止/关闭两个"不能投"状态的区别、改票语义（全量替换）。
 * 投票是集体决策工具，结果可信的前提是这些边界守得住。
 *
 * 用法：先启动后端（干净库），然后  node scripts/poll-test.mjs
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
  request.currentCookie = () => cookie
  return request
}

// ---------------------------------------------------------------- 准备

console.log('【准备】')

/** 首个注册的用户就是创建者（admin）；后续成员要走邀请码。 */
const creator = makeClient()
{
  let res = await creator('/api/auth/register', 'POST', {
    username: `pollcreator${SUFFIX}`,
    displayName: '发起人',
    password: 'poll-pass-2026',
  })
  if (res.status !== 200) {
    res = await creator('/api/auth/login', 'POST', {
      username: `pollcreator${SUFFIX}`,
      password: 'poll-pass-2026',
    })
  }
  assert(res.status === 200, '账号就绪：发起人', `status=${res.status}`)
}

async function makeMember(username, display) {
  const client = makeClient()
  const inv = await creator('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'poll 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName: display,
    password: 'poll-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'poll-pass-2026' })
  }
  assert(res.status === 200, `账号就绪：${display}`, `status=${res.status}`)
  return client
}

const alice = await makeMember(`pollalice${SUFFIX}`, '小爱')
const bob = await makeMember(`pollbob${SUFFIX}`, '小波')

// ---------------------------------------------------------------- 创建

console.log('\n【创建】')

let res = await creator('/api/polls', 'POST', { title: '', options: ['a', 'b'] })
assert(res.status === 400, '空标题被拒', `status=${res.status}`)

res = await creator('/api/polls', 'POST', { title: 'x', options: ['只有一项'] })
assert(res.status === 400, '少于两个选项被拒', `status=${res.status}`)

res = await creator('/api/polls', 'POST', { title: 'x', options: ['a', 'a', 'b'] })
eq(res.body?.poll?.options?.length, 2, '重复选项被去重')

res = await creator('/api/polls', 'POST', { title: 'x', options: ['a', 'b', 42, null, 'c'] })
eq(res.body?.poll?.options?.map((o) => o.text), ['a', 'b', 'c'], '非字符串选项被过滤')

let poll = (await creator('/api/polls', 'POST', {
  title: '周六团建去哪儿',
  description: '选个 majority 开心的',
  multi: false,
  options: ['爬山', '看电影', '吃火锅'],
  deadlineInMs: 60 * 60_000,
})).body.poll
assert(!!poll?.id, '创建单选投票', poll?.id ?? '')
eq(poll.deadlineAt !== null, true, '截止时间已设置')
eq(poll.canManage, true, '创建者可管理')

// 未登录（无 cookie 的新 client）不能创建
{
  const anon = makeClient()
  res = await anon('/api/polls', 'POST', { title: 'x', options: ['a', 'b'] })
  assert(res.status === 401 || res.status === 403, '未登录不能创建投票', `status=${res.status}`)
}

// ---------------------------------------------------------------- 投票

console.log('\n【投票】')

res = await alice(`/api/polls/${poll.id}/vote`, 'POST', { options: [0] })
eq(res.status, 200, '小爱投了爬山')
eq(res.body.poll.options[0].voters.map((v) => v.name), ['小爱'], '结果里能看到谁投的（实名）')
eq(res.body.poll.totalVoters, 1, '投票人数为 1')

res = await alice(`/api/polls/${poll.id}/vote`, 'POST', { options: [0, 1] })
assert(res.status === 400, '单选投两项被拒', `status=${res.status}`)

res = await alice(`/api/polls/${poll.id}/vote`, 'POST', { options: [5] })
assert(res.status === 400, '越界选项被拒', `status=${res.status}`)

res = await alice(`/api/polls/${poll.id}/vote`, 'POST', { options: [1] })
eq(res.status, 200, '小爱改票到看电影')
eq(res.body.poll.options[0].count, 0, '旧票被替换（爬山归零）')
eq(res.body.poll.options[1].count, 1, '新票生效（看电影 1）')
eq(res.body.poll.totalVoters, 1, '改票不增加人数')

await bob(`/api/polls/${poll.id}/vote`, 'POST', { options: [1] })
const detail = (await creator(`/api/polls/${poll.id}`)).body.poll
eq(detail.options[1].count, 2, '第二人同选项票数累加')
eq(detail.myVotes, [], '非投票视角下 myVotes 为空（创建者没投）')

const mine = (await alice(`/api/polls/${poll.id}`)).body.poll
eq(mine.myVotes, [1], '投票人视角 myVotes 正确')

// ---------------------------------------------------------------- 关闭 / 截止

console.log('\n【关闭与截止】')

res = await alice(`/api/polls/${poll.id}/close`, 'POST', { closed: true })
assert(res.status === 403, '非创建者不能关闭投票', `status=${res.status}`)

res = await bob(`/api/polls/${poll.id}`, 'DELETE')
assert(res.status === 403, '非创建者不能删除投票', `status=${res.status}`)

res = await creator(`/api/polls/${poll.id}/close`, 'POST', { closed: true })
eq(res.status, 200, '创建者关闭投票')
eq(res.body.poll.closedAt !== null, true, 'closedAt 已写入')

res = await bob(`/api/polls/${poll.id}/vote`, 'POST', { options: [0] })
assert(res.status === 400, '关闭后不能投票', `status=${res.status}`)

res = await creator(`/api/polls/${poll.id}/close`, 'POST', { closed: true })
assert(res.status === 400, '重复关闭被拒', `status=${res.status}`)

res = await creator(`/api/polls/${poll.id}/close`, 'POST', { closed: false })
eq(res.status, 200, '创建者重开投票')

// 截止的投票不能重开（deadline 是 1 小时后，这里还没到 —— 用一个已过期的验证）
let expired = (await creator('/api/polls', 'POST', {
  title: '已过期的投票',
  options: ['a', 'b'],
  deadlineInMs: 61_000,
})).body.poll
// 把库里的截止时间直接改成过去（绕开"至少 1 分钟"的入参校验 —— 那是防手滑的，
// 不是防测试的）。通过 create 一个正常投票再让时间过去不可行，只能动库，
// 但 HTTP 层测试没有库访问权 —— 改用"关闭后重开"语义覆盖，过期场景由
// isVotingClosed 的单测思路覆盖：这里验证重开接口对过期投票的行为 ——
// 手动关闭再重开是允许的（还没到 deadline），所以过期场景通过关闭表达。
res = await creator(`/api/polls/${expired.id}/close`, 'POST', { closed: true })
eq(res.status, 200, '过期前手动关闭')
res = await creator(`/api/polls/${expired.id}/close`, 'POST', { closed: false })
eq(res.status, 200, '未过截止时可重开')
void expired

// ---------------------------------------------------------------- 过期（改库造数据）

console.log('\n【截止后的行为】')

// 截止时间靠"等"测不了，直接改库把 deadline 拨到过去（脚本与服务共用一个
// 数据目录，这是测试库，随便改）
let expireTarget = (await creator('/api/polls', 'POST', {
  title: '马上就要截止的投票',
  options: ['a', 'b'],
  deadlineInMs: 60_000,
})).body.poll
{
  const { DatabaseSync } = await import('node:sqlite')
  const path = process.env.WL_TEST_DB ?? '.test-data-3100/app.sqlite'
  const db = new DatabaseSync(path)
  db.prepare('UPDATE polls SET deadline_at = ? WHERE id = ?').run(Date.now() - 1000, expireTarget.id)
  db.close()
}
res = await bob(`/api/polls/${expireTarget.id}/vote`, 'POST', { options: [0] })
assert(res.status === 400, '截止后不能投票（400）', `status=${res.status}`)
res = await bob('/api/polls?open=1')
eq(res.body.polls.some((p) => p.id === expireTarget.id), false, '截止的不出现在"进行中"筛选里')

// ---------------------------------------------------------------- 多选

console.log('\n【多选】')

let multi = (await creator('/api/polls', 'POST', {
  title: '周末都有哪些时间段有空',
  multi: true,
  options: ['周六上午', '周六下午', '周日上午', '周日下午'],
})).body.poll

res = await alice(`/api/polls/${multi.id}/vote`, 'POST', { options: [0, 2] })
eq(res.body.poll.myVotes, [0, 2], '多选一票多选项')

res = await alice(`/api/polls/${multi.id}/vote`, 'POST', { options: [2] })
eq(res.body.poll.myVotes, [2], '多选改票 = 全量替换')
eq(res.body.poll.totalVoters, 1, '替换不改人数')

await bob(`/api/polls/${multi.id}/vote`, 'POST', { options: [0] })
const mdetail = (await alice(`/api/polls/${multi.id}`)).body.poll
eq(mdetail.options[0].count, 1, '多选各选项独立计数')
eq(mdetail.totalVoters, 2, '两人都算进投票人数')

// ---------------------------------------------------------------- 删除

console.log('\n【删除】')

let tmp = (await creator('/api/polls', 'POST', { title: '待删除', options: ['a', 'b'] })).body.poll
res = await creator(`/api/polls/${tmp.id}`, 'DELETE')
eq(res.status, 200, '创建者删除投票')
res = await alice(`/api/polls/${tmp.id}`)
assert(res.status === 404, '删除后详情 404', `status=${res.status}`)

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
