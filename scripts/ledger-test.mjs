/**
 * 记账的端到端测试。
 *
 * 记账和别的模块不同：它的错误是"数字错了"，而不是"页面打不开"。
 * 数字错了往往要过很久才被发现，而且很难回溯是哪一笔开始错的。
 * 所以这里的断言集中在金额与状态机上：
 *
 *   - 金额解析的边界（三位小数、千分位、负数、空值）
 *   - 汇总只统计已通过/已支付（草稿和待审批不能进报表）
 *   - 状态机不能跳步（没审批不能支付，已审批不能直接改）
 *   - 不能审批自己提交的账目
 *   - 分摊合计必须等于总额（差一分都不行）
 *   - CSV 导出带 BOM，且对公式注入做了转义
 *
 * 用法：先启动后端，然后  node scripts/ledger-test.mjs
 */

import { createHash } from 'node:crypto'

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
    get cookie() {
      return cookie
    },
    set cookie(v) {
      cookie = v
    },
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        options.body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        // 与前端 api.ts 一致：带了 body 就默认 POST，否则 GET。
        // 少了这个默认值，`{ json: {} }` 会变成"GET 带 body"直接抛错。
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        ...options,
        headers,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const body = type.includes('application/json')
        ? await res.json()
        : await res.text()
      return { status: res.status, body, headers: res.headers }
    },
  }
}

const admin = makeClient() // 管理员（第一个注册的用户）
const member = makeClient() // 普通成员
const other = makeClient() // 另一个成员（用于分摊与交叉审批）

/**
 * 走一遍真实的分片上传，把一段文本作为凭证文件传上去，返回 nodeId。
 * 刻意用真实上传而不是塞一个假 id —— 记账的凭证是"复用文件模块的 node_id"，
 * 只测假 id 只能证明接口会拒绝，证明不了"能一次把凭证带上"。
 */
async function uploadProof(client, name, text) {
  const bytes = new TextEncoder().encode(text)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const init = await client.api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name, size: bytes.byteLength, sha256: sha, space: 'shared' },
  })
  if (init.status !== 200) return { status: init.status }
  if (init.body.instant) return { status: 200, nodeId: init.body.nodeId }
  const up = await client.api(`/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  if (up.status !== 200) return { status: up.status }
  const done = await client.api(`/api/uploads/${init.body.uploadId}/complete`, { method: 'POST' })
  return { status: done.status, nodeId: done.body.nodeId }
}

/** 今天往前推 n 天的 YYYY-MM-DD。 */
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

async function main() {
  console.log(`\n\x1b[1m记账端到端测试\x1b[0m  目标 ${BASE}\n`)

  // ---------------------------------------------------------------- 准备账号
  console.log('【准备账号】')
  const reg = await admin.api('/api/auth/register', {
    method: 'POST',
    json: { username: `led${SUFFIX}`, displayName: '财务管理员', password: 'ledger-test-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册管理员', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册管理员（首次运行成为创建者）')

  const inv1 = await admin.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 3, expiresInDays: 1 },
  })

  const memberReg = await member.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `mem${SUFFIX}`,
      displayName: '普通成员',
      password: 'member-pass-2026',
      inviteCode: inv1.body.code,
    },
  })
  assert(memberReg.status === 200 || memberReg.status === 201, '注册普通成员')

  const inv3 = await admin.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const otherReg = await other.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `oth${SUFFIX}`,
      displayName: '另一成员',
      password: 'other-pass-2026',
      inviteCode: inv3.body.code,
    },
  })
  assert(otherReg.status === 200 || otherReg.status === 201, '注册第三个成员')

  const memberId = (await member.api('/api/auth/me')).body.user.id
  const otherId = (await other.api('/api/auth/me')).body.user.id
  const adminId = (await admin.api('/api/auth/me')).body.user.id

  // ---------------------------------------------------------------- 分类
  console.log('\n【分类】')
  const cats = await member.api('/api/ledger/categories')
  assert(cats.status === 200, '成员能看到分类列表')
  assert(cats.body.categories.length >= 5, '首次访问自动灌入默认分类', `${cats.body.categories.length} 个`)

  const expenseCat = cats.body.categories.find((c) => c.kind === 'expense')
  const incomeCat = cats.body.categories.find((c) => c.kind === 'income')
  assert(expenseCat && incomeCat, '默认分类里同时有收入和支出')

  const memberCreateCat = await member.api('/api/ledger/categories', {
    method: 'POST',
    json: { name: '成员不该能建', kind: 'expense' },
  })
  assert(memberCreateCat.status === 403, '普通成员不能建分类（403）', `状态 ${memberCreateCat.status}`)

  const adminCreateCat = await admin.api('/api/ledger/categories', {
    method: 'POST',
    json: { name: '团建', kind: 'expense', icon: 'star' },
  })
  assert(adminCreateCat.status === 200, '管理员可以建分类')
  const teamCat = adminCreateCat.body.category

  const dupCat = await admin.api('/api/ledger/categories', {
    method: 'POST',
    json: { name: '团建', kind: 'expense' },
  })
  assert(dupCat.status === 409, '同名同类型分类被拒绝（409）')

  // ---------------------------------------------------------------- 金额解析
  console.log('\n【金额解析边界】')
  const amountCases = [
    { amount: '12.50', shouldPass: true, label: '两位小数' },
    { amount: '12.5', shouldPass: true, label: '一位小数（应补零）' },
    { amount: '12', shouldPass: true, label: '整数' },
    { amount: '1,234.56', shouldPass: true, label: '带千分位' },
    { amount: '￥30.00', shouldPass: true, label: '带货币符号' },
    { amount: '12.345', shouldPass: false, label: '三位小数（必须拒绝，不能静默四舍五入）' },
    { amount: 'abc', shouldPass: false, label: '非数字' },
    { amount: '-5', shouldPass: false, label: '负数（方向由收支类型决定，金额本身不能为负）' },
    { amount: '0', shouldPass: false, label: '零（没有金额为 0 的账目）' },
    { amount: '', shouldPass: false, label: '空值' },
  ]

  for (const c of amountCases) {
    const res = await member.api('/api/ledger/entries', {
      method: 'POST',
      json: {
        kind: 'expense',
        amount: c.amount,
        categoryId: teamCat.id,
        title: `金额测试 ${c.label}`,
        occurredOn: daysAgo(1),
      },
    })
    if (c.shouldPass) {
      assert(res.status === 200, `接受：${c.label}（${c.amount}）`, `状态 ${res.status}`)
      if (res.status === 200) {
        // 清理掉，免得干扰后面的统计断言
        await member.api(`/api/ledger/entries/${res.body.entry.id}`, { method: 'DELETE' })
      }
    } else {
      assert(res.status === 400, `拒绝：${c.label}（${c.amount || '空'}）`, `状态 ${res.status}`)
    }
  }

  // 精度验证：12.5 应该存成 1250 分
  const precisionCheck = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '0.10',
      categoryId: teamCat.id,
      title: '精度测试 一角',
      occurredOn: daysAgo(1),
    },
  })
  assert(
    precisionCheck.body.entry.amountCents === 10 && precisionCheck.body.entry.amount === '0.10',
    '0.10 精确存成 10 分（没有浮点误差）',
    `${precisionCheck.body.entry.amountCents} 分 / 显示 ${precisionCheck.body.entry.amount}`,
  )
  await member.api(`/api/ledger/entries/${precisionCheck.body.entry.id}`, { method: 'DELETE' })

  // ---------------------------------------------------------------- 日期校验
  console.log('\n【日期校验】')
  const badDate = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '10.00',
      title: '不存在的日期',
      occurredOn: '2026-02-30',
    },
  })
  assert(badDate.status === 400, '拒绝不存在的日期（2026-02-30）', `状态 ${badDate.status}`)

  const badFormat = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '10.00', title: '格式错', occurredOn: '2026/02/28' },
  })
  assert(badFormat.status === 400, '拒绝非 ISO 格式的日期（2026/02/28）')

  // ---------------------------------------------------------------- 状态机
  console.log('\n【状态机】')
  const created = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '268.00',
      categoryId: expenseCat.id,
      title: '招新宣传物料印刷',
      note: '海报 200 张、传单 500 张',
      occurredOn: daysAgo(3),
    },
  })
  assert(created.status === 200, '成员创建账目')
  const entryId = created.body.entry.id
  assert(created.body.entry.status === 'draft', '新建的账目是草稿状态')
  assert(created.body.entry.amount === '268.00', '金额按分存储并正确格式化', created.body.entry.amount)

  const payTooEarly = await admin.api(`/api/ledger/entries/${entryId}/pay`, { json: {} })
  assert(payTooEarly.status === 400, '草稿状态不能直接标记支付（跳步被拒）', `状态 ${payTooEarly.status}`)

  const decideTooEarly = await admin.api(`/api/ledger/entries/${entryId}/decide`, {
    json: { decision: 'approve' },
  })
  assert(decideTooEarly.status === 400, '草稿状态不能审批')

  const submitted = await member.api(`/api/ledger/entries/${entryId}/submit`, { json: {} })
  assert(submitted.status === 200, '成员提交账目')
  assert(submitted.body.entry.status === 'submitted', '状态变为待审批')

  const editAfterSubmit = await member.api(`/api/ledger/entries/${entryId}`, {
    method: 'PATCH',
    json: { title: '提交后偷改事由' },
  })
  assert(editAfterSubmit.status === 400, '提交后不能直接修改（必须先撤回）', `状态 ${editAfterSubmit.status}`)

  // ⚠️ 这里原来有一条断言：「管理员不能审批自己提交的账目」。
  //
  // 它现在已经**失效**，而且失效得很隐蔽：管理员建的账目直接落成 approved
  // （见下面「管理员直接入账」那一节），于是 submit 会以"状态不对"返回 400、
  // decide 也会以"只有待审批的可以审批"返回 400 —— 断言照样是绿的，
  // 但绿的原因是**状态不对**，不是那条自审规则生效。
  // 等于一条永远为真的假测试，给的是虚假的安全感。
  //
  // 那套流程现在对管理员已经不可达（他建不出"自己提交且待审批"的账目），
  // 所以这条规则本身也没必要再测。真正要保证的行为由下面
  // 「管理员直接入账」与「成员这一侧完全不变」两节覆盖。
  const adminEntry = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '50.00',
      categoryId: expenseCat.id,
      title: '管理员自己记的账目（用于清理流程）',
      occurredOn: daysAgo(2),
    },
  })
  // 清理这笔（管理员可以删自己的）
  await admin.api(`/api/ledger/entries/${adminEntry.body.entry.id}`, { method: 'DELETE' })

  // 成员撤回再改再提交
  const withdrawn = await member.api(`/api/ledger/entries/${entryId}/withdraw`, { json: {} })
  assert(withdrawn.body.entry.status === 'draft', '提交后可以撤回成草稿')

  const edited = await member.api(`/api/ledger/entries/${entryId}`, {
    method: 'PATCH',
    json: { amount: '288.00' },
  })
  assert(edited.status === 200 && edited.body.entry.amount === '288.00', '撤回后可以修改金额')

  await member.api(`/api/ledger/entries/${entryId}/submit`, { json: {} })

  const memberApprove = await member.api(`/api/ledger/entries/${entryId}/decide`, {
    json: { decision: 'approve' },
  })
  assert(memberApprove.status === 403, '普通成员不能审批（403）', `状态 ${memberApprove.status}`)

  // 驳回流程
  const rejected = await admin.api(`/api/ledger/entries/${entryId}/decide`, {
    json: { decision: 'reject', note: '缺少发票，请补充凭证' },
  })
  assert(rejected.status === 200 && rejected.body.entry.status === 'rejected', '管理员驳回账目')
  assert(
    rejected.body.entry.decisionNote === '缺少发票，请补充凭证',
    '驳回理由被记录',
    rejected.body.entry.decisionNote,
  )

  const editRejected = await member.api(`/api/ledger/entries/${entryId}`, {
    method: 'PATCH',
    json: { note: '已补充发票照片' },
  })
  assert(editRejected.status === 200, '被驳回的账目可以修改（这是驳回的意义）')

  await member.api(`/api/ledger/entries/${entryId}/submit`, { json: {} })
  const approved = await admin.api(`/api/ledger/entries/${entryId}/decide`, {
    json: { decision: 'approve' },
  })
  assert(approved.status === 200 && approved.body.entry.status === 'approved', '重新提交后通过')

  const memberDeleteApproved = await member.api(`/api/ledger/entries/${entryId}`, { method: 'DELETE' })
  assert(memberDeleteApproved.status === 400, '已审批的账目成员不能删除', `状态 ${memberDeleteApproved.status}`)

  // ---------------------------------------------------------------- 汇总
  console.log('\n【汇总统计】')
  // 记一笔收入并通过
  const income = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'income',
      amount: '1200.00',
      categoryId: incomeCat.id,
      title: '本学期会费收入',
      occurredOn: daysAgo(5),
    },
  })
  await member.api(`/api/ledger/entries/${income.body.entry.id}/submit`, { json: {} })
  await admin.api(`/api/ledger/entries/${income.body.entry.id}/decide`, {
    json: { decision: 'approve' },
  })

  // 再记一笔"待审批"的支出，它**不应该**进汇总
  const pendingEntry = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '9999.00',
      categoryId: expenseCat.id,
      title: '这笔还没审批，不该出现在报表里',
      occurredOn: daysAgo(1),
    },
  })
  await member.api(`/api/ledger/entries/${pendingEntry.body.entry.id}/submit`, { json: {} })

  // 还有一笔草稿，也不应该进汇总
  await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '8888.00',
      categoryId: expenseCat.id,
      title: '这是草稿，也不该出现',
      occurredOn: daysAgo(1),
    },
  })

  const summaryRes = await admin.api('/api/ledger/summary')
  assert(summaryRes.status === 200, '获取汇总')
  const s = summaryRes.body.summary

  assert(s.expense === '288.00', '支出汇总只算已通过的账目（排除待审批与草稿）', `支出 ${s.expense}`)
  assert(s.income === '1200.00', '收入汇总正确', `收入 ${s.income}`)
  assert(s.balance === '912.00', '结余 = 收入 − 支出', `结余 ${s.balance}`)
  assert(
    s.expense !== '10175.00',
    '待审批与草稿没有混进报表（这是记账里最容易做错的地方）',
  )

  // 时间范围筛选
  const ranged = await admin.api(`/api/ledger/summary?from=${daysAgo(2)}`)
  assert(ranged.status === 200, '按时间范围筛选汇总')
  assert(
    ranged.body.summary.income === '0.00',
    '范围外的收入被排除（会费是 5 天前收的，只看最近 2 天应为 0）',
    `收入 ${ranged.body.summary.income}`,
  )

  // 分类分布
  const hasCategory = s.byCategory.some((c) => c.name === expenseCat.name && c.total === '288.00')
  assert(hasCategory, '分类分布里能按分类汇总', s.byCategory.map((c) => `${c.name}:${c.total}`).join(', '))

  // 月度趋势
  assert(Array.isArray(s.byMonth) && s.byMonth.length >= 1, '月度趋势有数据', `${s.byMonth.length} 个月`)
  assert(
    s.byMonth.every((m) => /^\d{4}-\d{2}$/.test(m.month)),
    '月份格式是 YYYY-MM',
    s.byMonth.map((m) => m.month).join(', '),
  )

  // 关键词搜索（匹配标题 / 备注）
  const searched = await admin.api(`/api/ledger/entries?search=${encodeURIComponent('会费')}&limit=200`)
  assert(searched.status === 200, '按关键词搜索账目', `状态 ${searched.status}`)
  assert(
    searched.body.entries.some((e) => e.id === income.body.entry.id),
    '搜索命中标题里的「会费」',
    JSON.stringify(searched.body.entries.map((e) => e.title)),
  )
  assert(
    searched.body.entries.every((e) => `${e.title}${e.note ?? ''}`.includes('会费')),
    '返回的每一条都真的匹配关键词',
  )

  // LIKE 通配符必须转义：搜一个 "%" 不能把整本账都捞出来
  const wildcard = await admin.api(`/api/ledger/entries?search=${encodeURIComponent('%')}&limit=200`)
  assert(
    wildcard.body.entries.length === 0,
    '搜索 % 不会匹配全部（通配符已转义）',
    `${wildcard.body.entries.length} 条`,
  )

  // ---------------------------------------------------------------- 分摊
  console.log('\n【分摊与欠款】')
  const splitEntry = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '100.00',
      categoryId: expenseCat.id,
      title: '三人聚餐 AA',
      occurredOn: daysAgo(2),
      splits: [
        { userId: memberId, amount: '34.00' },
        { userId: otherId, amount: '33.00' },
        { userId: (await admin.api('/api/auth/me')).body.user.id, amount: '33.00' },
      ],
    },
  })
  assert(splitEntry.status === 200, '创建带分摊的账目')
  assert(splitEntry.body.entry.splits.length === 3, '分摊记录 3 条')

  const splitSum = splitEntry.body.entry.splits.reduce((acc, s) => acc + s.amountCents, 0)
  assert(splitSum === 10000, '分摊合计精确等于总额（整数分相加）', `${splitSum} 分`)

  const badSplits = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '100.00',
      title: '分摊对不上的账',
      occurredOn: daysAgo(1),
      splits: [
        { userId: memberId, amount: '30.00' },
        { userId: otherId, amount: '20.00' },
      ],
    },
  })
  assert(
    badSplits.status === 400,
    '分摊合计与总额不等时拒绝创建（差一分都不行）',
    `状态 ${badSplits.status}`,
  )
  assert(
    typeof badSplits.body.error === 'string' && badSplits.body.error.includes('50.00'),
    '错误信息里说清了差额是多少',
    badSplits.body.error,
  )

  // 把聚餐这笔走完流程，才能出现在欠款里
  await member.api(`/api/ledger/entries/${splitEntry.body.entry.id}/submit`, { json: {} })
  await admin.api(`/api/ledger/entries/${splitEntry.body.entry.id}/decide`, {
    json: { decision: 'approve' },
  })

  const debts = await admin.api('/api/ledger/debts')
  assert(debts.status === 200, '获取待结清欠款')
  const dinnerDebt = debts.body.debts.filter((d) => d.entryTitle === '三人聚餐 AA')
  assert(dinnerDebt.length === 3, '聚餐的分摊都出现在欠款列表里', `${dinnerDebt.length} 条`)
  assert(
    dinnerDebt.every((d) => d.payerName === '普通成员'),
    '欠款里记的是"应给垫付人"',
    dinnerDebt.map((d) => `${d.userName}→${d.payerName}`).join(', '),
  )

  // 结清一条
  const settle = await other.api(
    `/api/ledger/entries/${splitEntry.body.entry.id}/splits/${otherId}/settle`,
    { json: { settled: true } },
  )
  assert(settle.status === 200, '成员可以标记自己的分摊已结清')

  const settleOthers = await other.api(
    `/api/ledger/entries/${splitEntry.body.entry.id}/splits/${memberId}/settle`,
    { json: { settled: true } },
  )
  assert(settleOthers.status === 403, '不能标记别人的分摊（403）', `状态 ${settleOthers.status}`)

  const debts2 = await admin.api('/api/ledger/debts')
  const afterSettle = debts2.body.debts.filter((d) => d.entryTitle === '三人聚餐 AA')
  assert(afterSettle.length === 2, '结清后不再出现在欠款列表', `${afterSettle.length} 条`)

  // ---------------------------------------------------------------- 权限
  console.log('\n【权限边界】')
  const draftByMember = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '1.00',
      title: '成员自己的草稿',
      occurredOn: daysAgo(1),
    },
  })
  const draftId = draftByMember.body.entry.id

  const otherReadDraft = await other.api(`/api/ledger/entries/${draftId}`)
  assert(otherReadDraft.status === 403, '别人读不到你的草稿（草稿是私密的）', `状态 ${otherReadDraft.status}`)

  const otherList = await other.api('/api/ledger/entries?limit=200')
  const seesDraft = otherList.body.entries.some((e) => e.id === draftId)
  assert(!seesDraft, '别人的列表里也不会出现你的草稿')

  const seesApproved = otherList.body.entries.some((e) => e.id === entryId)
  assert(seesApproved, '但已通过的账目对所有成员可见（社团账目应当透明）')

  const otherEditMine = await other.api(`/api/ledger/entries/${entryId}`, {
    method: 'PATCH',
    json: { title: '别人试图改我的账' },
  })
  assert(otherEditMine.status === 403, '不能修改别人的账目（403）', `状态 ${otherEditMine.status}`)

  const anonLedger = await fetch(`${BASE}/api/ledger/entries`)
  assert(anonLedger.status === 401, '未登录不能访问记账接口（401）', `状态 ${anonLedger.status}`)

  // ---------------------------------------------------------------- 导出
  console.log('\n【CSV 导出】')

  // 注意：这里必须看**原始字节**，不能用 res.text()。
  // Response.text() 按规范会剥掉开头的 BOM，所以字符串里看不到 ﻿，
  // 但字节流里是有的 —— 用 text() 去断言 BOM 会得到一个假的失败。
  const csvRes = await fetch(`${BASE}/api/ledger/export.csv`, {
    headers: { cookie: admin.cookie },
  })
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer())
  const csv = new TextDecoder('utf-8').decode(csvBytes)

  assert(csvRes.status === 200, '导出 CSV')
  assert(csv.length > 10, 'CSV 有内容')
  assert(
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    'CSV 字节流以 UTF-8 BOM 开头（不加的话 Excel 打开中文是乱码）',
    `前 3 字节：${[...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`,
  )
  assert(csv.includes('日期') && csv.includes('金额') && csv.includes('状态'), 'CSV 有中文表头（含状态列）')
  assert(csv.includes('288.00'), 'CSV 里包含已通过的账目金额')

  // 导出与汇总的语义差异：导出是"你能看到的全部"，所以待审批的也应该在，
  // 但要带状态列让人能区分。静默过滤掉会造成"记了却导不出来"的困惑。
  assert(csv.includes('9999.00'), 'CSV 包含待审批的账目（导出是完整 dump，不是报表）')
  assert(csv.includes('待审批'), 'CSV 里有「待审批」状态，能据此区分')
  assert(csv.includes('已通过'), 'CSV 里有「已通过」状态')

  // 可见范围检查要用**普通成员**的身份来做：
  // 管理员本来就能看到所有人的草稿（这是他的职责），用管理员测不出隔离效果。
  const csvOtherRes = await fetch(`${BASE}/api/ledger/export.csv`, {
    headers: { cookie: other.cookie },
  })
  const csvOther = new TextDecoder('utf-8').decode(
    new Uint8Array(await csvOtherRes.arrayBuffer()),
  )
  assert(
    !csvOther.includes('成员自己的草稿'),
    '别人的草稿不会出现在导出里（可见范围受权限约束）',
  )
  assert(
    csvOther.includes('288.00'),
    '但已通过的账目在普通成员的导出里也在（社团账目透明）',
  )

  // CSV 注入防护：建一笔事由以 = 开头的账
  const injectEntry = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '1.00',
      title: '=cmd|"/c calc"!A1',
      occurredOn: daysAgo(1),
    },
  })
  if (injectEntry.status === 200) {
    await member.api(`/api/ledger/entries/${injectEntry.body.entry.id}/submit`, { json: {} })
    await admin.api(`/api/ledger/entries/${injectEntry.body.entry.id}/decide`, {
      json: { decision: 'approve' },
    })
    const csvRes2 = await fetch(`${BASE}/api/ledger/export.csv`, {
      headers: { cookie: admin.cookie },
    })
    const csv2 = new TextDecoder('utf-8').decode(new Uint8Array(await csvRes2.arrayBuffer()))
    assert(
      !/(^|,)"=cmd/.test(csv2),
      'CSV 里以 = 开头的内容被转义（防公式注入）',
      '事由以 = 开头时不加防护会在 Excel 里被当公式执行',
    )
    assert(
      csv2.includes("'=cmd"),
      '确实做了前缀转义而不是丢掉了这条记录',
    )
  }

  // ---------------------------------------------------------------- 导出跟随筛选
  //
  // 这一块是针对一个真实事故的回归：导出的 URL 从前只带日期区间，
  // 搜索词 / 分类 / 状态 / 只看我的 / 待我审批 在导出时被**静默丢掉** ——
  // 界面上筛选摘要写着「搜索「招新」· 仅支出」，筛出三行，
  // 点「导出 CSV」下载到的却是全部账目。它不报错、不告警，
  // 只会在对账那天被人肉发现，所以必须钉死。
  //
  // 断言的主体是**不变量**：同一个筛选条件，"导出的数据行数"必须等于
  // "列表接口的 total"。以后再加筛选条件时，只要两边没对齐就立刻红。
  console.log('\n【导出跟随筛选】')

  /** 数 CSV 的数据行数：去掉表头，也去掉末尾的截断提示行（它不属于数据）。 */
  function csvRowCount(text) {
    return text
      .split('\r\n')
      .filter((line) => line.trim() !== '')
      .slice(1)
      .filter((line) => !line.startsWith('"# ')).length
  }

  /** 按同样的查询串分别取列表和导出，配对比较。 */
  async function compareListAndExport(client, query, label) {
    const list = await client.api(`/api/ledger/entries?${query}`)
    const csv = await client.api(`/api/ledger/export.csv?${query}`)
    const rows = csvRowCount(csv.body)
    assert(
      list.status === 200 && csv.status === 200,
      `${label}：列表与导出都返回 200`,
      `列表 ${list.status} / 导出 ${csv.status}`,
    )
    assert(
      rows === list.body.total,
      `${label}：导出的数据行数 == 列表 total（筛选条件没有被导出丢掉）`,
      `列表 ${list.body.total} 行 / 导出 ${rows} 行`,
    )
    return csv.body
  }

  const searchTerm = '招新宣传'
  const searchCsv = await compareListAndExport(
    admin,
    `search=${encodeURIComponent(searchTerm)}`,
    'search=招新宣传',
  )
  // 光比条数是不够的：万一"搜索"在列表和导出里**同时**被忽略，条数照样相等。
  // 所以再验一次内容 —— 匹配的那条在，明显不匹配的那条不在。
  assert(
    searchCsv.includes('招新宣传物料印刷'),
    '导出带 search：命中的账目在表里',
  )
  assert(
    !searchCsv.includes('本学期会费收入'),
    '导出带 search：没命中的账目不会出现（不是"两个入口一起无视筛选"）',
  )

  await compareListAndExport(admin, 'kind=expense', 'kind=expense')
  await compareListAndExport(admin, 'kind=income', 'kind=income')
  await compareListAndExport(admin, 'status=submitted', 'status=submitted')
  await compareListAndExport(admin, 'status=approved', 'status=approved')
  await compareListAndExport(admin, `categoryId=${encodeURIComponent(expenseCat.id)}`, 'categoryId=支出分类')
  await compareListAndExport(admin, 'mine=1', 'mine=1')
  await compareListAndExport(admin, 'pending=1', 'pending=1（待我审批）')
  await compareListAndExport(
    member,
    `search=${encodeURIComponent('会费')}&kind=income`,
    '多条件叠加（search + kind，且用普通成员身份）',
  )
  // 组合条件里最容易出错的一种：区间 + 状态 + 分类
  await compareListAndExport(
    admin,
    `from=${daysAgo(10)}&to=${daysAgo(0)}&status=approved&categoryId=${encodeURIComponent(expenseCat.id)}`,
    'from+to+status+categoryId 四条件叠加',
  )

  // 两列的 Excel 取舍必须一起钉住 —— 它们看起来矛盾，其实是两个方向：
  //   日期 → 制表符前缀（强制当文本，否则 Excel 显示成 46292 / ######）
  //   金额 → 纯数字（能直接求和，加了制表符就变成不能求和的文本）
  const fullCsv = await admin.api('/api/ledger/export.csv')
  const dataLines = fullCsv.body
    .split('\r\n')
    .filter((line) => line.trim() !== '')
    .slice(1)
    .filter((line) => !line.startsWith('"# '))
  assert(dataLines.length > 0, '导出里有数据行', `${dataLines.length} 行`)
  assert(
    dataLines.every((line) => /^"\t\d{4}-\d{2}-\d{2}"/.test(line)),
    '日期列是「制表符 + YYYY-MM-DD」——Excel 才不会把它转成日期序列号 / ######',
    dataLines[0]?.slice(0, 32) ?? '(没有数据行)',
  )
  assert(
    dataLines.every((line) => /,"\d+\.\d{2}","/.test(line)),
    '金额列是纯数字（形如 "288.00"），可以直接在 Excel 里求和',
    dataLines[0]?.slice(0, 60) ?? '(没有数据行)',
  )
  assert(
    !dataLines.some((line) => /,"\t/.test(line)),
    '除日期列以外没有别的列带不可见制表符',
  )

  // ---------------------------------------------------------------- 管理员直接入账
  console.log('\n【管理员直接入账（无需审批）】')
  const adminDirect = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '66.00',
      categoryId: expenseCat.id,
      title: '管理员直接入账测试',
      occurredOn: daysAgo(1),
    },
  })
  assert(adminDirect.status === 200, '管理员建账目')
  assert(
    adminDirect.body.entry.status === 'approved',
    '管理员建的账目直接是「已通过」，不用再走 submit→decide',
    adminDirect.body.entry.status,
  )
  assert(
    adminDirect.body.entry.decidedBy === adminId,
    '直接入账也如实记录审批人是管理员自己（decided_by 不偷偷跳过）',
    adminDirect.body.entry.decidedBy ?? '(null)',
  )
  assert(adminDirect.body.entry.decidedAt !== null, '直接入账记录了 decided_at')
  assert(
    typeof adminDirect.body.entry.decisionNote === 'string' &&
      adminDirect.body.entry.decisionNote.includes('管理员直接入账'),
    '直接入账写明理由（审计里看得出是管理员自己直接入的）',
    adminDirect.body.entry.decisionNote ?? '(null)',
  )
  // 成员这一侧完全不变
  const memberStillDraft = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '7.00',
      title: '成员建账仍是草稿',
      occurredOn: daysAgo(1),
    },
  })
  assert(
    memberStillDraft.body.entry.status === 'draft',
    '普通成员建的账目仍然是草稿（审批流对成员一点没变）',
    memberStillDraft.body.entry.status,
  )
  await admin.api(`/api/ledger/entries/${adminDirect.body.entry.id}`, { method: 'DELETE' })
  await member.api(`/api/ledger/entries/${memberStillDraft.body.entry.id}`, { method: 'DELETE' })

  // ---------------------------------------------------------------- 活动 CRUD
  console.log('\n【活动 CRUD】')
  const evCreate = await admin.api('/api/ledger/events', {
    method: 'POST',
    json: {
      name: '春季棋类比赛',
      kind: 'competition',
      startOn: daysAgo(5),
      endOn: daysAgo(1),
      note: '社团内部比赛',
    },
  })
  assert(evCreate.status === 200, '管理员创建活动')
  const ev = evCreate.body.event
  assert(ev.kind === 'competition' && ev.status === 'open', '活动类型与初始状态正确', `${ev.kind}/${ev.status}`)
  assert(ev.startOn === daysAgo(5) && ev.endOn === daysAgo(1), '活动起止日期被记录')

  const memberEv = await member.api('/api/ledger/events', {
    method: 'POST',
    json: { name: '成员自建活动', kind: 'activity' },
  })
  assert(memberEv.status === 200, '普通成员也能建活动（谁张罗谁建）')
  const memEventId = memberEv.body.event.id

  const otherEditEv = await other.api(`/api/ledger/events/${memEventId}`, {
    method: 'PATCH',
    json: { name: '别人想改名' },
  })
  assert(otherEditEv.status === 403, '不能改别人创建的活动（403）', `状态 ${otherEditEv.status}`)

  const memberEditOwnEv = await member.api(`/api/ledger/events/${memEventId}`, {
    method: 'PATCH',
    json: { name: '成员自建活动（已改名）' },
  })
  assert(
    memberEditOwnEv.status === 200 && memberEditOwnEv.body.event.name.includes('已改名'),
    '创建者能改自己的活动',
  )

  const adminEditEv = await admin.api(`/api/ledger/events/${memEventId}`, {
    method: 'PATCH',
    json: { note: '管理员也能改' },
  })
  assert(adminEditEv.status === 200, '管理员能改任何活动')

  const badEvDate = await admin.api('/api/ledger/events', {
    method: 'POST',
    json: { name: '日期颠倒的活动', startOn: daysAgo(1), endOn: daysAgo(5) },
  })
  assert(badEvDate.status === 400, '结束早于开始的活动被拒绝（400）', `状态 ${badEvDate.status}`)

  const getEv = await admin.api(`/api/ledger/events/${ev.id}`)
  assert(getEv.status === 200 && getEv.body.event.id === ev.id, '按 id 取活动')
  const missingEv = await admin.api('/api/ledger/events/ev_does_not_exist')
  assert(missingEv.status === 404, '不存在的活动返回 404')

  // ---------------------------------------------------------------- 活动下的账目
  console.log('\n【活动下的账目】')
  const evIncome = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'income',
      amount: '500.00',
      categoryId: incomeCat.id,
      title: '比赛报名费收入',
      occurredOn: daysAgo(3),
      eventId: ev.id,
    },
  })
  assert(evIncome.status === 200 && evIncome.body.entry.eventId === ev.id, '账目能带上 eventId')
  assert(evIncome.body.entry.status === 'approved', '管理员记的活动收入直接入账')

  const evExpense = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '200.00',
      categoryId: expenseCat.id,
      title: '比赛物料（棋盘、奖品）',
      occurredOn: daysAgo(2),
      eventId: ev.id,
      splits: [
        { userId: memberId, amount: '120.00' },
        { userId: otherId, amount: '80.00' },
      ],
    },
  })
  assert(
    evExpense.status === 200 && evExpense.body.entry.status === 'approved',
    '管理员记的活动支出直接入账（带分摊）',
  )

  // 这笔用于验证活动 CSV 同样做了公式注入转义
  const evInject = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '1.00',
      categoryId: expenseCat.id,
      title: '=cmd|"/c calc"!A1',
      occurredOn: daysAgo(1),
      eventId: ev.id,
    },
  })
  assert(evInject.status === 200, '记一笔事由以 = 开头的活动支出（用于 CSV 注入测试）')

  const evDraft = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '50.00',
      categoryId: expenseCat.id,
      title: '成员临时记一笔（草稿）',
      occurredOn: daysAgo(1),
      eventId: ev.id,
    },
  })
  assert(
    evDraft.status === 200 && evDraft.body.entry.status === 'draft',
    '成员能给活动记一笔草稿（快速记账）',
  )

  // 成员一次把「活动 + 支出 + 凭证」一起提交（凭证复用文件模块的 node_id）
  const proof = await uploadProof(member, '比赛凭证.txt', '报名费收据占位内容')
  assert(proof.status === 200 && !!proof.nodeId, '成员上传一张凭证文件')
  const evWithProof = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: {
      kind: 'expense',
      amount: '12.00',
      categoryId: expenseCat.id,
      title: '带凭证的活动支出',
      occurredOn: daysAgo(1),
      eventId: ev.id,
      attachmentNodeIds: [proof.nodeId],
    },
  })
  assert(evWithProof.status === 200, '成员一次把「活动 + 支出 + 凭证」一起提交')
  assert(
    evWithProof.body.entry.attachments.length === 1 &&
      evWithProof.body.entry.attachments[0].nodeId === proof.nodeId,
    '凭证附件被记在这笔账上（复用 ledger_attachments）',
  )
  // 这是一笔草稿，删掉免得干扰后面的统计
  await member.api(`/api/ledger/entries/${evWithProof.body.entry.id}`, { method: 'DELETE' })

  const byEvent = await admin.api(`/api/ledger/entries?eventId=${ev.id}&limit=200`)
  assert(byEvent.status === 200, '按活动过滤账目')
  const evEntryIds = [evIncome.body.entry.id, evExpense.body.entry.id, evInject.body.entry.id, evDraft.body.entry.id]
  assert(
    byEvent.body.entries.length === 4 &&
      evEntryIds.every((id) => byEvent.body.entries.some((e) => e.id === id)),
    '按活动过滤只返回这个活动的 4 笔账（草稿对管理员可见）',
    `返回 ${byEvent.body.entries.length} 笔`,
  )

  const evList = await admin.api('/api/ledger/events')
  assert(evList.status === 200, '列出活动')
  const evRow = evList.body.events.find((e) => e.id === ev.id)
  assert(!!evRow, '列表里能找到刚建的活动')
  assert(evRow.income === '500.00', '活动收入合计', evRow.income)
  assert(evRow.expense === '201.00', '活动支出合计（200 + 1，草稿 50 不计入）', evRow.expense)
  assert(evRow.balance === '299.00', '活动结余 = 收入 − 支出', evRow.balance)
  assert(evRow.entryCount === 3, '活动笔数只算已通过/已支付', `${evRow.entryCount}`)

  // ---------------------------------------------------------------- 活动收支汇总
  console.log('\n【活动收支汇总】')
  const evSum = await admin.api(`/api/ledger/events/${ev.id}/summary`)
  assert(evSum.status === 200, '获取活动汇总')
  const es = evSum.body
  assert(
    es.income === '500.00' && es.expense === '201.00' && es.balance === '299.00',
    '活动汇总的收支/结余与活动列表一致',
  )

  // 关键：合计必须和逐笔明细对得上，而不是只断言"返回了 200"
  const sumOf = (kind) =>
    es.entries
      .filter((e) => e.status === 'approved' || e.status === 'paid')
      .filter((e) => e.kind === kind)
      .reduce((acc, e) => acc + e.amountCents, 0)
  assert(sumOf('income') === es.incomeCents, '明细里的收入相加 = 汇总收入', `${sumOf('income')} vs ${es.incomeCents}`)
  assert(
    sumOf('expense') === es.expenseCents,
    '明细里的支出相加 = 汇总支出',
    `${sumOf('expense')} vs ${es.expenseCents}`,
  )
  assert(
    es.entries.some((e) => e.id === evDraft.body.entry.id && e.status === 'draft'),
    '成员的草稿出现在逐笔明细里（带状态列）',
  )
  assert(
    es.entries.filter((e) => e.status === 'draft').reduce((acc, e) => acc + e.amountCents, 0) === 5000,
    '但草稿的 50.00 没有计入合计（与总报表口径一致）',
  )
  assert(
    es.entries.every((e) => e.eventId === ev.id),
    '逐笔明细每一条都属于这个活动',
  )

  const catExpense = es.byCategory.find((c) => c.kind === 'expense')
  assert(
    catExpense && catExpense.totalCents === 20100 && catExpense.count === 2,
    '按分类：支出分类合计 201.00 / 2 笔',
    catExpense ? `${catExpense.total} / ${catExpense.count}` : '无',
  )
  const catIncome = es.byCategory.find((c) => c.kind === 'income')
  assert(catIncome && catIncome.totalCents === 50000, '按分类：收入分类合计 500.00')

  const pAdmin = es.byPerson.find((p) => p.userId === adminId)
  assert(pAdmin && pAdmin.paidCents === 20100, '按人：管理员垫付了 201.00', pAdmin ? pAdmin.paid : '无')
  const pMember = es.byPerson.find((p) => p.userId === memberId)
  assert(
    pMember && pMember.shareCents === 12000 && pMember.owedCents === 12000,
    '按人：成员应分摊 120.00、还欠 120.00',
    pMember ? `${pMember.share} / ${pMember.owed}` : '无',
  )
  const pOther = es.byPerson.find((p) => p.userId === otherId)
  assert(
    pOther && pOther.shareCents === 8000 && pOther.owedCents === 8000,
    '按人：另一成员应分摊 80.00、还欠 80.00',
  )
  assert(
    es.byPerson.reduce((acc, p) => acc + p.paidCents, 0) === es.expenseCents,
    '所有人垫付之和 = 活动支出合计（按人能对上总额）',
  )

  const evDebts = await admin.api(`/api/ledger/debts?eventId=${ev.id}`)
  assert(evDebts.status === 200 && evDebts.body.debts.length === 2, '按活动查欠款只有这 2 笔', `${evDebts.body.debts.length}`)
  assert(
    evDebts.body.debts.reduce((acc, d) => acc + d.amountCents, 0) === 20000,
    '活动欠款合计 200.00（成员 120 + 另一成员 80）',
  )

  // 可见范围：别人的草稿不该出现在活动明细里
  const otherEvSum = await other.api(`/api/ledger/events/${ev.id}/summary`)
  assert(
    !otherEvSum.body.entries.some((e) => e.id === evDraft.body.entry.id),
    '别人的草稿不出现在活动汇总的明细里',
  )
  assert(
    otherEvSum.body.entries.some((e) => e.id === evIncome.body.entry.id),
    '已通过的账目在活动明细里对所有成员可见',
  )

  // ---------------------------------------------------------------- 按活动导出 CSV
  console.log('\n【按活动导出 CSV】')
  const evCsvRes = await fetch(`${BASE}/api/ledger/events/${ev.id}/export.csv`, {
    headers: { cookie: admin.cookie },
  })
  const evCsvBytes = new Uint8Array(await evCsvRes.arrayBuffer())
  const evCsv = new TextDecoder('utf-8').decode(evCsvBytes)
  assert(evCsvRes.status === 200, '按活动导出 CSV')
  assert(
    evCsvBytes[0] === 0xef && evCsvBytes[1] === 0xbb && evCsvBytes[2] === 0xbf,
    '活动 CSV 也以 UTF-8 BOM 开头',
    `前 3 字节：${[...evCsvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`,
  )
  assert(evCsv.includes('比赛报名费收入') && evCsv.includes('500.00'), '活动 CSV 含该活动的收入明细')
  assert(evCsv.includes('比赛物料'), '活动 CSV 含该活动的支出明细')
  assert(
    !/(^|,)"=cmd/.test(evCsv) && evCsv.includes("'=cmd"),
    '活动 CSV 同样做了以 = 开头的公式注入转义（没漏）',
  )
  // eventId 也是筛选条件之一，走的是同一个导出入口 —— 必须和按活动导出给出同一张表。
  // （两个入口各写一套条件正是"导出丢筛选"那次事故的成因。）
  const evCsvByQuery = await admin.api(`/api/ledger/export.csv?eventId=${encodeURIComponent(ev.id)}`)
  assert(
    evCsvByQuery.body === evCsv,
    '用 eventId 走通用导出，结果与 /events/:id/export.csv 逐字节一致',
  )

  // ---------------------------------------------------------------- 封账
  console.log('\n【封账】')
  const closeRes = await admin.api(`/api/ledger/events/${ev.id}/close`, { json: { closed: true } })
  assert(closeRes.status === 200 && closeRes.body.event.status === 'closed', '管理员封账')
  assert(
    closeRes.body.event.closedByName === '财务管理员',
    '封账记录了是谁封的',
    closeRes.body.event.closedByName ?? '(null)',
  )

  const addToClosed = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '9.00', title: '封账后还想加账', occurredOn: daysAgo(1), eventId: ev.id },
  })
  assert(addToClosed.status === 400, '封账后不能往活动里加账目（400）', `状态 ${addToClosed.status}`)

  const editClosed = await admin.api(`/api/ledger/entries/${evExpense.body.entry.id}`, {
    method: 'PATCH',
    json: { title: '封账后偷改事由' },
  })
  assert(editClosed.status === 400, '封账后不能改活动里已有的账目（400）', `状态 ${editClosed.status}`)

  const delClosed = await admin.api(`/api/ledger/entries/${evDraft.body.entry.id}`, { method: 'DELETE' })
  assert(delClosed.status === 400, '封账后不能删除活动里的账目（历史一条都不能少）', `状态 ${delClosed.status}`)

  // 但还款不受封账影响：成员仍能标记自己的分摊已还清
  const settleClosed = await member.api(
    `/api/ledger/entries/${evExpense.body.entry.id}/splits/${memberId}/settle`,
    { json: { settled: true } },
  )
  assert(settleClosed.status === 200, '封账后成员仍能标记自己分摊已还清（还款不受封账影响）')

  // 封账只是冻结写，历史一条都不能少
  const evSumClosed = await admin.api(`/api/ledger/events/${ev.id}/summary`)
  assert(
    evSumClosed.body.income === '500.00' && evSumClosed.body.expense === '201.00',
    '封账后历史汇总分文未变',
  )
  assert(
    evSumClosed.body.entries.length === es.entries.length,
    '封账后逐笔明细一条不少',
    `${evSumClosed.body.entries.length} vs ${es.entries.length}`,
  )

  // 解封后又能写 —— 证明封账不等于删除
  const reopenRes = await admin.api(`/api/ledger/events/${ev.id}/close`, { json: { closed: false } })
  assert(reopenRes.status === 200 && reopenRes.body.event.status === 'open', '可以解封（封账不是删除）')
  const addAfterReopen = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '9.00', title: '解封后可以继续记', occurredOn: daysAgo(1), eventId: ev.id },
  })
  assert(addAfterReopen.status === 200, '解封后又能往活动里加账目')
  await admin.api(`/api/ledger/entries/${addAfterReopen.body.entry.id}`, { method: 'DELETE' })

  // ---------------------------------------------------------------- 封账闸门的覆盖面
  //
  // ⚠️ 这一节补的是一个**闸门漏堵**：封账原来只挡了 create/update/delete/decide，
  // 而 submit / withdraw 没挡 —— 于是封账后成员照样能把自己的草稿推进到"待审批"，
  // 与"封账后这个活动的账目只读"的说法不符。
  //
  // 同时**钉住刻意放行的那一条**：标记已支付不受封账影响（收付款是执行动作，
  // 不是记账动作 —— 比赛结束封账之后，钱还是得付完）。
  console.log('\n【封账闸门的覆盖面】')
  const draftInEvent = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '11.00', title: '封账闸门·草稿', occurredOn: daysAgo(1), eventId: ev.id },
  })
  const submittedInEvent = await member.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '12.00', title: '封账闸门·待审批', occurredOn: daysAgo(1), eventId: ev.id },
  })
  await member.api(`/api/ledger/entries/${submittedInEvent.body.entry.id}/submit`, { json: {} })
  // 管理员建的直接就是已通过，用来测"标记支付"
  const approvedInEvent = await admin.api('/api/ledger/entries', {
    method: 'POST',
    json: { kind: 'expense', amount: '13.00', title: '封账闸门·已通过', occurredOn: daysAgo(1), eventId: ev.id },
  })
  assert(
    draftInEvent.status === 200 && submittedInEvent.status === 200 && approvedInEvent.status === 200,
    '先在这个活动里造出三种状态的账目',
  )

  await admin.api(`/api/ledger/events/${ev.id}/close`, { json: { closed: true } })

  const submitClosed = await member.api(`/api/ledger/entries/${draftInEvent.body.entry.id}/submit`, { json: {} })
  assert(
    submitClosed.status === 400,
    '封账后不能提交该活动下的草稿（这个口子原来漏了）',
    `状态 ${submitClosed.status}`,
  )
  const withdrawClosed = await member.api(`/api/ledger/entries/${submittedInEvent.body.entry.id}/withdraw`, { json: {} })
  assert(
    withdrawClosed.status === 400,
    '封账后不能撤回该活动下的账目（同上）',
    `状态 ${withdrawClosed.status}`,
  )
  const payClosed = await admin.api(`/api/ledger/entries/${approvedInEvent.body.entry.id}/pay`, { json: {} })
  assert(
    payClosed.status === 200,
    '但「标记已支付」**不受**封账影响（封账冻结的是账目内容，不是收付款动作）',
    `状态 ${payClosed.status}`,
  )

  // 收尾：解封并清掉这一节造的账目，别影响后面的用例
  await admin.api(`/api/ledger/events/${ev.id}/close`, { json: { closed: false } })
  for (const created of [draftInEvent, submittedInEvent, approvedInEvent]) {
    await admin.api(`/api/ledger/entries/${created.body.entry.id}`, { method: 'DELETE' })
  }
  assert(true, '封账闸门测试已收尾（解封并清理）')

  // ---------------------------------------------------------------- 待办接口
  //
  // 产品侧的结论：提交/审批过去是**沉默的** —— 状态变了只写一条审计，
  // 没人知道"有一笔等我审批"。这一节钉住两件最容易出错的事：
  //   1. 角标的数字必须和列表按同样条件筛出来的条数**一模一样**；
  //   2. 普通成员看不到"待我审批"（他点进去也审不了），也看不到别人的驳回。
  console.log('\n【待办接口：口径一致 + 权限隔离】')

  /** 造一笔账并提交，返回 id。 */
  async function makeSubmitted(client, title) {
    const created = await client.api('/api/ledger/entries', {
      method: 'POST',
      json: { kind: 'expense', amount: '3.00', title, occurredOn: daysAgo(1) },
    })
    await client.api(`/api/ledger/entries/${created.body.entry.id}/submit`, { json: {} })
    return created.body.entry.id
  }

  const todoA = await makeSubmitted(member, '待办测试·会被驳回')
  const todoB = await makeSubmitted(member, '待办测试·继续待审批')
  const todoC = await makeSubmitted(other, '待办测试·别人的待审批')

  // 驳回 A：它应立刻从"待我审批"移到提交者自己的"待修改"
  const rejectA = await admin.api(`/api/ledger/entries/${todoA}/decide`, {
    json: { decision: 'reject', note: '待办测试：请补充说明' },
  })
  assert(rejectA.status === 200, '驳回一笔用于待办测试的账目')

  const adminTodos = await admin.api('/api/todos')
  assert(adminTodos.status === 200, '管理员能读待办接口')
  const adminReview = adminTodos.body.todos.ledger.review

  const adminPendingList = await admin.api('/api/ledger/entries?pending=1&limit=200')
  assert(
    adminReview.count === adminPendingList.body.total,
    '待我审批的角标 == 列表 pending=1 的 total（没有另定一套口径）',
    `待办 ${adminReview.count} / 列表 ${adminPendingList.body.total}`,
  )
  assert(
    adminReview.ids.every((id) => adminPendingList.body.entries.some((e) => e.id === id)),
    '待办返回的 id 全部能在 pending=1 的列表里找到',
  )
  assert(
    adminReview.ids.length === Math.min(adminReview.count, 20),
    'ids 数量 = min(条数, 20)（角标只要数字，id 是为了直达）',
    `${adminReview.ids.length} 条 / 共 ${adminReview.count} 条`,
  )
  assert(
    adminReview.ids.includes(todoB) && adminReview.ids.includes(todoC),
    '两笔「待审批」都在管理员的待办里',
  )

  const memberTodos = await member.api('/api/todos')
  assert(
    memberTodos.body.todos.ledger.review.count === 0 &&
      memberTodos.body.todos.ledger.review.ids.length === 0,
    '普通成员的「待我审批」恒为 0（审批权在路由层就是 admin 专属，不给他点不动的角标）',
    `count=${memberTodos.body.todos.ledger.review.count}`,
  )
  assert(
    !memberTodos.body.todos.ledger.review.ids.includes(todoC),
    '普通成员的待办里不会出现别人的待审批账目',
  )

  const memberRejectedList = await member.api('/api/ledger/entries?mine=1&status=rejected&limit=200')
  assert(
    memberTodos.body.todos.ledger.rejected.count === memberRejectedList.body.total,
    '「被驳回待修改」的角标 == 列表 mine=1&status=rejected 的 total',
    `待办 ${memberTodos.body.todos.ledger.rejected.count} / 列表 ${memberRejectedList.body.total}`,
  )
  assert(
    memberTodos.body.todos.ledger.rejected.ids.includes(todoA),
    '刚被驳回的那笔在提交者的待修改待办里',
  )

  const otherTodos = await other.api('/api/todos')
  assert(
    otherTodos.body.todos.ledger.rejected.count === 0,
    '别人的驳回待办看不到（只算自己提交的）',
    `count=${otherTodos.body.todos.ledger.rejected.count}`,
  )
  assert(
    adminTodos.body.todos.ledger.rejected.count === 0,
    '管理员自己没有被驳回的账目，待修改数为 0（不是"把所有人的都算给他"）',
    `count=${adminTodos.body.todos.ledger.rejected.count}`,
  )

  const anonTodos = await fetch(`${BASE}/api/todos`)
  assert(anonTodos.status === 401, '未登录不能读待办（401）', `状态 ${anonTodos.status}`)

  // 收尾：清掉这一节造的账目，别把后面的断言带歪
  await admin.api(`/api/ledger/entries/${todoB}/decide`, { json: { decision: 'approve' } })
  await admin.api(`/api/ledger/entries/${todoC}/decide`, { json: { decision: 'approve' } })
  await member.api(`/api/ledger/entries/${todoA}`, { method: 'DELETE' })
  assert(true, '待办测试已收尾（审批/删除临时账目）')

  // ---------------------------------------------------------------- 删除活动
  //
  // 用户报"记账功能不能删除活动"。删除权限只给管理员（活动是账目的归属维度，
  // 建活动的人可以改，但不该有权抹掉别人已经记过账的活动），而**账目一条
  // 都不能删**：归属它的账目退回"日常零散账目"。
  console.log('\n【删除活动（仅管理员）】')
  {
    const delEv = await admin.api('/api/ledger/events', {
      method: 'POST',
      json: { name: '待删除的活动', kind: 'activity' },
    })
    const delId = delEv.body.event.id
    const d1 = await admin.api('/api/ledger/entries', {
      method: 'POST',
      json: {
        kind: 'expense',
        amount: '30.00',
        categoryId: expenseCat.id,
        title: '待删活动支出',
        occurredOn: daysAgo(1),
        eventId: delId,
      },
    })
    const d2 = await admin.api('/api/ledger/entries', {
      method: 'POST',
      json: {
        kind: 'income',
        amount: '10.00',
        categoryId: incomeCat.id,
        title: '待删活动收入',
        occurredOn: daysAgo(1),
        eventId: delId,
      },
    })
    assert(d1.status === 200 && d2.status === 200, '准备了归属该活动的两笔账')

    const byMember = await member.api(`/api/ledger/events/${delId}`, { method: 'DELETE' })
    assert(byMember.status === 403, '普通成员不能删活动（403）', `状态 ${byMember.status}`)
    // 连活动的创建者也不行 —— 权限是"管理员"，不是"创建者或管理员"
    const memberOwnEv = await member.api('/api/ledger/events', {
      method: 'POST',
      json: { name: '成员自建待删活动', kind: 'activity' },
    })
    const ownDel = await member.api(`/api/ledger/events/${memberOwnEv.body.event.id}`, { method: 'DELETE' })
    assert(ownDel.status === 403, '创建者自己也不能删（403）', `状态 ${ownDel.status}`)
    await admin.api(`/api/ledger/events/${memberOwnEv.body.event.id}`, { method: 'DELETE' })

    const del = await admin.api(`/api/ledger/events/${delId}`, { method: 'DELETE' })
    assert(del.status === 200, '管理员能删活动')
    assert(del.body.detachedEntries === 2, '返回解绑笔数', `${del.body.detachedEntries}`)

    const gone = await admin.api(`/api/ledger/events/${delId}`)
    assert(gone.status === 404, '活动真的没了')

    // 账目一条都没少，只是不再归属活动
    const kept = await admin.api('/api/ledger/entries?limit=200')
    const keptIds = (kept.body.entries ?? []).map((e) => e.id)
    assert(
      keptIds.includes(d1.body.entry.id) && keptIds.includes(d2.body.entry.id),
      '两笔账目都还在（删除活动不删账）',
    )
    const keptExpense = kept.body.entries.find((e) => e.id === d1.body.entry.id)
    assert(keptExpense?.eventId === null, '账目不再归属活动（eventId 置空）', String(keptExpense?.eventId))
    assert(keptExpense?.amount === '30.00', '金额原样保留', String(keptExpense?.amount))
    assert(keptExpense?.status === 'approved', '状态原样保留', String(keptExpense?.status))

    const again = await admin.api(`/api/ledger/events/${delId}`, { method: 'DELETE' })
    assert(again.status === 404, '重复删除返回 404')
  }

  // ---------------------------------------------------------------- 结果
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
