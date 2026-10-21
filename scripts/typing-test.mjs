/**
 * 打字练习 HTTP 层测试。
 *
 * 纯个人数据，命脉是：**只能碰自己的行**（别人的进度/错题碰不到）、
 * 进度 upsert 语义、错题累加与清理。
 *
 * 用法：先启动后端（干净库），然后  node scripts/typing-test.mjs
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
    username: `typown${SUFFIX}`,
    displayName: '练习者甲',
    password: 'typing-pass-2026',
  })
  if (res.status !== 200) {
    res = await creator('/api/auth/login', 'POST', { username: `typown${SUFFIX}`, password: 'typing-pass-2026' })
  }
  assert(res.status === 200, '账号就绪：练习者甲', `status=${res.status}`)
}

async function makeMember(username, display) {
  const client = makeClient()
  const inv = await creator('/api/admin/invites', 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInDays: 1,
    note: 'typing 测试',
  })
  let res = await client('/api/auth/register', 'POST', {
    username,
    displayName: display,
    password: 'typing-pass-2026',
    inviteCode: inv.body?.code,
  })
  if (res.status !== 200) {
    res = await client('/api/auth/login', 'POST', { username, password: 'typing-pass-2026' })
  }
  assert(res.status === 200, `账号就绪：${display}`, `status=${res.status}`)
  return client
}

const bob = await makeMember(`typbob${SUFFIX}`, '练习者乙')

// ---------------------------------------------------------------- 词库数据

console.log('\n【词库数据完整性】')

const { TYPING_DICTS } = await import('../web/src/lib/dicts/index.ts')

{
  eq(TYPING_DICTS.length, 4, '四套词库')
  const seen = new Map()
  let words = 0
  for (const d of TYPING_DICTS) {
    assert(d.chapters.length >= 3, `${d.name}：至少 3 章`, `${d.chapters.length} 章`)
    for (const ch of d.chapters) {
      assert(ch.words.length >= 10, `${d.name} ${ch.title}：每章至少 10 词`, `${ch.words.length} 词`)
      for (const w of ch.words) {
        words++
        const key = `${d.id}:${w.w}`
        assert(!seen.has(key), `${d.id} 词库无重复：${w.w}`)
        seen.set(key, true)
        assert(w.w.length >= 2 && w.w.length <= 30 && /^[A-Za-z]+$/.test(w.w), `${w.w}：纯字母且长度合理`)
        assert(!!w.t?.trim(), `${w.w}：有释义`)
      }
    }
  }
  ok(`词库总量 ${words} 词`)
}

// ---------------------------------------------------------------- 进度

console.log('\n【进度】')

let res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: 0, position: 5 })
eq(res.body.progress?.position, 5, '记录进度')

res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: 0, position: 9 })
eq(res.body.progress?.position, 9, '同章再记 = 覆盖（upsert）')

res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: 1, position: 0 })
eq(res.status, 200, '另一章独立记录')

const list = (await creator('/api/typing/progress')).body.progress
eq(list.length, 2, '进度按 (dict, chapter) 分行')

const bobList = (await bob('/api/typing/progress')).body.progress
eq(bobList.length, 0, '乙看不到甲的进度（个人数据）')

res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: -1, position: 0 })
assert(res.status === 400, '负数章节被拒', `status=${res.status}`)

res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: 0, position: -3 })
assert(res.status === 400, '负数位置被拒', `status=${res.status}`)

res = await creator('/api/typing/progress', 'PUT', { dict: '', chapter: 0, position: 0 })
assert(res.status === 400, '空 dict 被拒', `status=${res.status}`)

// 回退重练：position 允许变小
res = await creator('/api/typing/progress', 'PUT', { dict: 'cet4', chapter: 0, position: 2 })
eq(res.body.progress?.position, 2, '允许回退重练')

// ---------------------------------------------------------------- 错题本

console.log('\n【错题本】')

res = await creator('/api/typing/wrong', 'POST', { dict: 'cet4', word: 'umbrella' })
eq(res.status, 200, '记录错词')

await creator('/api/typing/wrong', 'POST', { dict: 'cet4', word: 'umbrella' })
await creator('/api/typing/wrong', 'POST', { dict: 'cet4', word: 'mirror' })
await bob('/api/typing/wrong', 'POST', { dict: 'cet6', word: 'paradox' })

let wrongList = (await creator('/api/typing/wrong')).body.wrong
eq(wrongList.length, 2, '同词累加不重复建行')
eq(wrongList.find((x) => x.word === 'umbrella')?.wrongCount, 2, '错两次计数为 2')
eq(wrongList.find((x) => x.word === 'mirror')?.word, 'mirror', '另一词独立一行')

const bobWrong = (await bob('/api/typing/wrong')).body.wrong
eq(bobWrong.length, 1, '乙的错题本只有自己的')
eq(bobWrong[0].word, 'paradox', '内容正确')

res = await creator('/api/typing/wrong', 'POST', { dict: 'cet4', word: '' })
assert(res.status === 400, '空词被拒', `status=${res.status}`)

res = await creator('/api/typing/wrong', 'POST', { dict: 'cet4', word: 'x'.repeat(61) })
assert(res.status === 400, '超长词被拒', `status=${res.status}`)

// ---------------------------------------------------------------- 清理

console.log('\n【清理】')

res = await creator('/api/typing/wrong/clear', 'POST', { word: 'umbrella' })
eq(res.body.removed, 1, '按词清除')
wrongList = (await creator('/api/typing/wrong')).body.wrong
eq(wrongList.length, 1, '只剩一个')

res = await creator('/api/typing/wrong/clear', 'POST', {})
eq(res.body.removed, 1, '全清返回删除数')
eq((await creator('/api/typing/wrong')).body.wrong.length, 0, '清空后列表为空')

// 乙的不受影响（个人数据边界最后一道）
eq((await bob('/api/typing/wrong')).body.wrong.length, 1, '甲全清不影响乙')

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
if (failed > 0) process.exit(1)
