/**
 * 财物管理（物品台账 + 借还记录）的端到端测试。
 *
 * 重点不在"接口返回 200"，而在这几件**容易做错且错了很难发现**的事：
 *
 *   1. 可用量必须是**算出来**的（总数 − 未归还）。如果实现里存了一个冗余字段，
 *      它迟早会漂移，而"账面还有 3 件、柜子里只剩 1 件"这种不一致事后查不出来。
 *   2. 超借必须被挡住，而且要在**事务里**挡（先查后写中间有缝就会超借）。
 *   3. 逾期是派生的，不能存字段（它每天都在变）。
 *   4. 有东西在外面时，总数不能被改到比外面的还少 —— 否则可用量算出来是负数。
 *   5. 借还历史必须保留（退役而不是删除）。
 *
 * 用法：由 scripts/run-all-tests.mjs 启动服务端后运行。
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
    get cookie() {
      return cookie
    },
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
      const type = res.headers.get('content-type') ?? ''
      const parsed = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body: parsed }
    },
  }
}

async function main() {
  console.log(`\n\x1b[1m财物管理（物品台账与借还）\x1b[0m  目标 ${BASE}\n`)

  const admin = makeClient()
  const member = makeClient()

  // ---------------------------------------------------------------- 准备
  console.log('【准备账号】')
  const regA = await admin.api('/api/auth/register', {
    method: 'POST',
    json: { username: `asa${SUFFIX}`, displayName: '管理员', password: 'assets-test-2026' },
  })
  if (regA.status !== 200 && regA.status !== 201) {
    bad('注册管理员', `状态 ${regA.status}：${JSON.stringify(regA.body)}`)
    process.exit(1)
  }
  ok('注册管理员（首个账号成为 owner）')

  const inv = await admin.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const regM = await member.api('/api/auth/register', {
    method: 'POST',
    json: { username: `asm${SUFFIX}`, displayName: '普通成员', password: 'assets-test-2026', inviteCode: inv.body.code },
  })
  assert(regM.status === 200 || regM.status === 201, '注册普通成员')
  const memberId = regM.body.user?.id

  // ---------------------------------------------------------------- 分类
  console.log('\n【分类】')
  const cats = await admin.api('/api/assets/categories')
  assert(cats.status === 200, '读取分类列表')
  assert((cats.body.categories ?? []).length > 0, '首次运行自动播种了默认分类', `${cats.body.categories?.length} 个`)
  assert(
    (cats.body.categories ?? []).every((c) => typeof c.name === 'string' && c.name.length > 0),
    '分类都有名字',
  )

  const newCat = await admin.api('/api/assets/categories', {
    method: 'POST',
    json: { name: `测试分类${SUFFIX}` },
  })
  assert(newCat.status === 200, '管理员可以新建分类', `状态 ${newCat.status}`)
  const catId = newCat.body.category?.id

  const dupCat = await admin.api('/api/assets/categories', {
    method: 'POST',
    json: { name: `测试分类${SUFFIX}` },
  })
  assert(dupCat.status === 409, '重名分类被拒（409）', `状态 ${dupCat.status}`)

  const memberCat = await member.api('/api/assets/categories', {
    method: 'POST',
    json: { name: `成员建的${SUFFIX}` },
  })
  assert(memberCat.status === 403, '普通成员不能建分类（403）', `状态 ${memberCat.status}`)

  // ---------------------------------------------------------------- 物品
  console.log('\n【物品台账】')
  const created = await admin.api('/api/assets/items', {
    method: 'POST',
    json: {
      name: '露营帐篷',
      code: `TENT-${SUFFIX}`,
      categoryId: catId,
      totalQty: 3,
      value: '299.90',
      purchasedOn: '2026-03-01',
      location: '活动室 A 柜',
      note: '含地钉',
    },
  })
  assert(created.status === 200, '创建物品', `状态 ${created.status}`)
  const item = created.body.item
  assert(item?.totalQty === 3, '总数为 3')
  assert(item?.availableQty === 3, '初始可用量为 3')
  assert(item?.onLoanQty === 0, '初始借出为 0')
  assert(item?.valueCents === 29990, '金额被转成整数分（299.90 → 29990）', String(item?.valueCents))
  assert(item?.totalValueCents === 29990 * 3, '总价值 = 单价 × 数量', String(item?.totalValueCents))
  const itemId = item.id

  const dupCode = await admin.api('/api/assets/items', {
    method: 'POST',
    json: { name: '另一顶帐篷', code: `TENT-${SUFFIX}` },
  })
  assert(dupCode.status === 409, '重复的资产编号被拒（409）', `状态 ${dupCode.status}`)

  const memberCreate = await member.api('/api/assets/items', {
    method: 'POST',
    json: { name: '成员想加的', totalQty: 1 },
  })
  assert(memberCreate.status === 403 || memberCreate.status === 401, '普通成员不能新增物品', `状态 ${memberCreate.status}`)

  // 金额精度：浮点会在这里翻车
  const penny = await admin.api('/api/assets/items', {
    method: 'POST',
    json: { name: '回形针', totalQty: 100, value: '0.07' },
  })
  assert(penny.body.item?.valueCents === 7, '0.07 元被精确转成 7 分（没有浮点误差）', String(penny.body.item?.valueCents))
  assert(penny.body.item?.totalValueCents === 700, '100 × 0.07 = 7.00 元 = 700 分', String(penny.body.item?.totalValueCents))

  // ---------------------------------------------------------------- 借出
  console.log('\n【借出与可用量】')
  const lend1 = await member.api('/api/assets/loans', {
    method: 'POST',
    json: { itemId, qty: 2, dueOn: '2099-12-31', purpose: '周末露营' },
  })
  assert(lend1.status === 200, '成员可以借东西', `状态 ${lend1.status} ${JSON.stringify(lend1.body).slice(0, 120)}`)
  const loanId = lend1.body.loan?.id
  assert(lend1.body.loan?.borrowerId === memberId, '借用人是操作者本人')

  const afterLend = await admin.api(`/api/assets/items/${itemId}`)
  assert(afterLend.body.item?.availableQty === 1, '借出 2 件后可用量变成 1（算出来的，不是存在库里的）', String(afterLend.body.item?.availableQty))
  assert(afterLend.body.item?.onLoanQty === 2, '在外数量为 2')
  assert(afterLend.body.item?.totalQty === 3, '总数不受借出影响')

  // 超借：还剩 1 件，借 2 件必须被拒
  const over = await member.api('/api/assets/loans', { method: 'POST', json: { itemId, qty: 2 } })
  assert(over.status === 409, '超借被拒（409）', `状态 ${over.status}：${over.body.error ?? ''}`)
  assert(
    typeof over.body.error === 'string' && over.body.error.includes('只剩 1 件'),
    '错误信息说清了还剩几件',
    over.body.error,
  )

  // 借光最后一件，再借就该说"没有余量"
  const lend2 = await member.api('/api/assets/loans', { method: 'POST', json: { itemId, qty: 1 } })
  assert(lend2.status === 200, '把最后一件借走')
  const outOfStock = await member.api('/api/assets/loans', { method: 'POST', json: { itemId, qty: 1 } })
  assert(outOfStock.status === 409, '没有余量时再借被拒')
  assert(
    typeof outOfStock.body.error === 'string' && outOfStock.body.error.includes('全在外面'),
    '错误信息说明了是全部借出',
    outOfStock.body.error,
  )

  // 管理员来借同样受可用量限制（规则对所有人一致）
  const other = await admin.api('/api/assets/loans', { method: 'POST', json: { itemId } })
  assert(other.status === 409, '管理员来借也同样受可用量限制（规则对所有人一致）')

  // ---- 代别人借（需求：管理员有权限去填写哪些成员租借）----
  //
  // 后端借用接口一直就支持 borrowerId，缺的只是界面。这里把接口契约钉住，
  // 免得以后有人"顺手"把它改掉。
  const forOther = await admin.api('/api/assets/loans', {
    method: 'POST',
    json: { itemId: penny.body.item.id, qty: 1, borrowerId: memberId, purpose: '管理员代登记' },
  })
  assert(forOther.status === 200, '管理员可以代某个成员登记借出', `状态 ${forOther.status}`)
  assert(
    forOther.body.loan?.borrowerId === memberId,
    '借出记录挂在**被代的那个人**名下，而不是操作者自己',
    `borrowerId=${forOther.body.loan?.borrowerId}`,
  )
  assert(
    typeof forOther.body.loan?.borrowerName === 'string' &&
      forOther.body.loan.borrowerName === '普通成员',
    '借用人姓名也是被代的那个人',
    String(forOther.body.loan?.borrowerName),
  )
  // 「谁操作的」与「记在谁名下」是两件事，别混为一个字段
  const otherLoans = await admin.api(`/api/assets/loans?mine=0&itemId=${penny.body.item.id}`)
  assert(
    (otherLoans.body.loans ?? []).some((l) => l.id === forOther.body.loan.id && l.borrowerId === memberId),
    '在借还记录里能查到它挂在这个成员名下',
  )
  // 收尾：还掉，别影响后面的计数断言
  await admin.api(`/api/assets/loans/${forOther.body.loan.id}/return`, { method: 'POST', json: {} })

  // ---------------------------------------------------------------- 改总数
  console.log('\n【总数与在外量的约束】')
  const shrink = await admin.api(`/api/assets/items/${itemId}`, {
    method: 'PATCH',
    json: { totalQty: 2 },
  })
  assert(shrink.status === 400, '总数不能改到比在外面的还少（否则可用量算出来是负数）', `状态 ${shrink.status}`)
  assert(
    typeof shrink.body.error === 'string' && shrink.body.error.includes('在外面'),
    '错误信息说明了原因',
    shrink.body.error,
  )
  const grow = await admin.api(`/api/assets/items/${itemId}`, {
    method: 'PATCH',
    json: { totalQty: 5 },
  })
  assert(grow.status === 200 && grow.body.item?.totalQty === 5, '总数可以调大')
  assert(grow.body.item?.availableQty === 2, '调大后可用量随之变化（5 − 3 在外）', String(grow.body.item?.availableQty))

  // ---------------------------------------------------------------- 归还
  console.log('\n【归还】')
  const ret = await admin.api(`/api/assets/loans/${loanId}/return`, {
    method: 'POST',
    json: { condition: 'good' },
  })
  assert(ret.status === 200, '归还成功（可以由别人代还）', `状态 ${ret.status}`)
  assert(ret.body.loan?.returnedAt !== null, '记录了归还时间')

  const retAgain = await admin.api(`/api/assets/loans/${loanId}/return`, { method: 'POST', json: {} })
  assert(retAgain.status === 409, '同一条借出记录不能重复归还（409）', `状态 ${retAgain.status}`)

  const afterReturn = await admin.api(`/api/assets/items/${itemId}`)
  assert(afterReturn.body.item?.onLoanQty === 1, '归还 2 件后在外只剩 1 件', String(afterReturn.body.item?.onLoanQty))
  assert(afterReturn.body.item?.availableQty === 4, '可用量恢复到 4', String(afterReturn.body.item?.availableQty))

  // 归还时报告损坏 → 物品状态跟着改
  const brokenItem = await admin.api('/api/assets/items', {
    method: 'POST',
    json: { name: '借坏测试品', totalQty: 1 },
  })
  const brokenLoan = await member.api('/api/assets/loans', { method: 'POST', json: { itemId: brokenItem.body.item.id } })
  await member.api(`/api/assets/loans/${brokenLoan.body.loan.id}/return`, {
    method: 'POST',
    json: { condition: 'broken', note: '摔裂了' },
  })
  const brokenAfter = await admin.api(`/api/assets/items/${brokenItem.body.item.id}`)
  assert(
    brokenAfter.body.item?.condition === 'broken',
    '归还时报告损坏，物品状态同步改成「已损坏」',
    brokenAfter.body.item?.condition,
  )

  // ---------------------------------------------------------------- 逾期
  console.log('\n【逾期（派生，不存字段）】')
  const overdueItem = await admin.api('/api/assets/items', { method: 'POST', json: { name: '逾期测试品', totalQty: 1 } })
  const overdueLoan = await member.api('/api/assets/loans', {
    method: 'POST',
    json: { itemId: overdueItem.body.item.id, dueOn: '2020-01-01' },
  })
  assert(overdueLoan.status === 200, '建立一条应还日期在过去的借出')

  const overdueList = await admin.api('/api/assets/loans?overdue=1')
  const found = (overdueList.body.loans ?? []).find((l) => l.id === overdueLoan.body.loan.id)
  assert(!!found, '它出现在逾期列表里')
  assert(found?.overdue === true, '标记为逾期')
  assert((found?.overdueDays ?? 0) > 1000, '算出了逾期天数', `${found?.overdueDays} 天`)

  const summary = await admin.api('/api/assets/summary')
  assert(summary.status === 200, '读取汇总')
  assert((summary.body.summary?.overdueLoans ?? 0) >= 1, '汇总里逾期数为正', String(summary.body.summary?.overdueLoans))
  assert(
    (summary.body.summary?.onLoanQty ?? 0) >= 2,
    '汇总里的在外数量与实际一致',
    String(summary.body.summary?.onLoanQty),
  )
  assert(
    (summary.body.overdue ?? []).some((l) => l.id === overdueLoan.body.loan.id),
    '汇总接口顺带带回逾期清单（首页提醒用）',
  )

  // ---------------------------------------------------------------- 退役
  console.log('\n【退役而不是删除】')
  const retireBlocked = await admin.api(`/api/assets/items/${itemId}/retire`, {
    method: 'POST',
    json: { retired: true },
  })
  assert(retireBlocked.status === 400, '还有东西在外面时不能退役', `状态 ${retireBlocked.status}`)

  const retireOk = await admin.api(`/api/assets/items/${brokenItem.body.item.id}/retire`, {
    method: 'POST',
    json: { retired: true },
  })
  assert(retireOk.status === 200 && retireOk.body.item?.status === 'retired', '没有外借时可以退役')

  const lendRetired = await member.api('/api/assets/loans', { method: 'POST', json: { itemId: brokenItem.body.item.id } })
  assert(lendRetired.status === 400, '退役的物品不能再借出', `状态 ${lendRetired.status}`)

  // 历史记录必须还在（退役不是删除）
  const history = await admin.api(`/api/assets/items/${brokenItem.body.item.id}`)
  assert(
    (history.body.loans ?? []).length >= 1,
    '退役之后它的借还历史仍然查得到（这正是不能用硬删除的原因）',
    `${history.body.loans?.length} 条`,
  )

  const activeOnly = await admin.api('/api/assets/items?status=active')
  assert(
    !(activeOnly.body.items ?? []).some((i) => i.id === brokenItem.body.item.id),
    '默认列表里不再出现已退役的',
  )
  const allItems = await admin.api('/api/assets/items?status=retired')
  assert(
    (allItems.body.items ?? []).some((i) => i.id === brokenItem.body.item.id),
    '按 status=retired 能查到它',
  )

  // ---------------------------------------------------------------- 搜索与过滤
  console.log('\n【搜索与过滤】')
  const search = await admin.api(`/api/assets/items?q=${encodeURIComponent('露营')}`)
  assert(
    (search.body.items ?? []).some((i) => i.id === itemId),
    '按名称搜得到',
    `${search.body.items?.length} 条`,
  )
  const byCode = await admin.api(`/api/assets/items?q=TENT-${SUFFIX}`)
  assert((byCode.body.items ?? []).some((i) => i.id === itemId), '按编号也搜得到')
  const byLocation = await admin.api(`/api/assets/items?q=${encodeURIComponent('A 柜')}`)
  assert((byLocation.body.items ?? []).some((i) => i.id === itemId), '按存放位置也搜得到')

  const onLoanOnly = await admin.api('/api/assets/items?onLoan=1')
  assert(
    (onLoanOnly.body.items ?? []).every((i) => i.onLoanQty > 0),
    'onLoan=1 只返回有外借的',
    `${onLoanOnly.body.items?.length} 条`,
  )

  const mine = await member.api('/api/assets/loans?mine=1')
  assert(
    (mine.body.loans ?? []).every((l) => l.borrowerId === memberId),
    'mine=1 只返回我借的',
    `${mine.body.loans?.length} 条`,
  )

  // ---------------------------------------------------------------- 导出
  console.log('\n【CSV 导出】')
  const csvItems = await admin.api('/api/assets/export/items.csv')
  assert(csvItems.status === 200, '导出物品台账')
  assert(typeof csvItems.body === 'string' && csvItems.body.includes('露营帐篷'), 'CSV 里有物品数据')
  // ⚠️ BOM 必须用**原始字节**检查：fetch 的 .text() 按 WHATWG 规范会剥掉开头的 BOM，
  // 于是"检查文本首字符是不是 ﻿"永远为假，看着像功能坏了其实是断言写错了。
  const csvRaw = new Uint8Array(
    await (await fetch(`${BASE}/api/assets/export/items.csv`, { headers: { cookie: admin.cookie } })).arrayBuffer(),
  )
  assert(
    csvRaw[0] === 0xef && csvRaw[1] === 0xbb && csvRaw[2] === 0xbf,
    '带 UTF-8 BOM（否则 Excel 打开中文是乱码）',
    `前三个字节: ${csvRaw[0]?.toString(16)} ${csvRaw[1]?.toString(16)} ${csvRaw[2]?.toString(16)}`,
  )
  const csvLoans = await admin.api('/api/assets/export/loans.csv')
  assert(csvLoans.status === 200 && typeof csvLoans.body === 'string', '导出借还记录')

  // 公式注入：名字以 = 开头时必须被转义，否则 Excel 会当公式执行
  const inject = await admin.api('/api/assets/items', {
    method: 'POST',
    json: { name: '=1+1', totalQty: 1 },
  })
  assert(inject.status === 200, '创建一个名字以 = 开头的物品')
  const csv2 = await admin.api('/api/assets/export/items.csv')
  assert(
    !/(^|,)"?=1\+1/m.test(csv2.body),
    'CSV 里以 = 开头的单元格被转义（防公式注入）',
    '（Excel 会把未转义的 = 当公式执行）',
  )

  // ---------------------------------------------------------------- 权限边界
  console.log('\n【权限边界】')
  const anon = await fetch(`${BASE}/api/assets/items`)
  assert(anon.status === 401, '未登录不能看台账（401）', `状态 ${anon.status}`)
  const memberList = await member.api('/api/assets/items')
  assert(memberList.status === 200, '普通成员可以看台账（社团的家当是公共信息）')
  const memberRetire = await member.api(`/api/assets/items/${itemId}/retire`, {
    method: 'POST',
    json: { retired: true },
  })
  assert(memberRetire.status === 403 || memberRetire.status === 401, '普通成员不能退役物品', `状态 ${memberRetire.status}`)

  // ---------------------------------------------------------------- 待办接口
  //
  // 财物的待办是"我借的东西快到期 / 已经过期"。这里钉住三件事：
  //   1. 角标数字 == 列表按同样条件筛出来的条数；
  //   2. **当天到期不算逾期**（due_on < 今天 才是逾期），但它算"即将到期"；
  //   3. 别人的借出不进我的待办。
  console.log('\n【待办接口：我的逾期 / 即将到期】')

  /** 今天 + n 天的 YYYY-MM-DD（本地时区，与服务端 today() 同源）。 */
  function dateOffset(days) {
    const d = new Date()
    d.setDate(d.getDate() + days)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  const todoItem = await admin.api('/api/assets/items', {
    method: 'POST',
    json: { name: `待办边界测试品${SUFFIX}`, totalQty: 10 },
  })
  assert(todoItem.status === 200, '创建一件用于待办测试的物品')

  async function lendWithDue(dueOn) {
    const res = await member.api('/api/assets/loans', {
      method: 'POST',
      json: { itemId: todoItem.body.item.id, qty: 1, ...(dueOn ? { dueOn } : {}) },
    })
    assert(res.status === 200, `建立借出（dueOn=${dueOn ?? '空'}）`, `状态 ${res.status}`)
    return res.body.loan
  }

  const dueToday = await lendWithDue(dateOffset(0))
  const dueSoon2 = await lendWithDue(dateOffset(2))
  const dueFar = await lendWithDue(dateOffset(10))
  const duePast = await lendWithDue(dateOffset(-3))
  const duePastReturned = await lendWithDue(dateOffset(-5))
  await member.api(`/api/assets/loans/${duePastReturned.id}/return`, { method: 'POST', json: {} })

  const memberLoansOverdue = await member.api('/api/assets/loans?mine=1&overdue=1&limit=1000')
  const memberLoansSoon = await member.api('/api/assets/loans?mine=1&dueWithin=3&limit=1000')
  const memberAllTodos = await member.api('/api/todos')

  assert(memberAllTodos.status === 200, '成员能读待办接口')
  const assetsTodo = memberAllTodos.body.todos.assets

  assert(
    assetsTodo.overdue.count === (memberLoansOverdue.body.loans ?? []).length,
    '逾期的角标 == 列表 mine=1&overdue=1 的条数',
    `待办 ${assetsTodo.overdue.count} / 列表 ${(memberLoansOverdue.body.loans ?? []).length}`,
  )
  assert(
    assetsTodo.dueSoon.count === (memberLoansSoon.body.loans ?? []).length,
    '即将到期的角标 == 列表 mine=1&dueWithin=3 的条数',
    `待办 ${assetsTodo.dueSoon.count} / 列表 ${(memberLoansSoon.body.loans ?? []).length}`,
  )
  assert(assetsTodo.dueSoonDays === 3, '「即将到期」的窗口是 3 天，并由服务端告诉前端', String(assetsTodo.dueSoonDays))

  const overdueIds = (memberLoansOverdue.body.loans ?? []).map((l) => l.id)
  const soonIds = (memberLoansSoon.body.loans ?? []).map((l) => l.id)
  assert(
    !overdueIds.includes(dueToday.id),
    '**当天到期不算逾期**（逾期必须是应还日期 < 今天）',
    `dueToday=${dueToday.dueOn}`,
  )
  assert(
    soonIds.includes(dueToday.id),
    '但当天到期算「即将到期」——否则它两边都不提醒，就是漏掉了',
  )
  assert(overdueIds.includes(duePast.id), '过了应还日期的在逾期里')
  assert(!soonIds.includes(duePast.id), '已逾期的不重复算进「即将到期」（两段区间不重叠）')
  assert(soonIds.includes(dueSoon2.id), '2 天后到期在「即将到期」里')
  assert(!soonIds.includes(dueFar.id) && !overdueIds.includes(dueFar.id), '10 天后到期两边都不算')
  assert(
    !overdueIds.includes(duePastReturned.id),
    '已归还的不算逾期（哪怕应还日期早就过了）',
  )
  assert(soonIds.includes(dueSoon2.id) && assetsTodo.dueSoon.ids.includes(dueSoon2.id), '待办 id 里能直达这条记录')

  // 权限隔离：别人的借出不进我的待办
  const adminAllTodos = await admin.api('/api/todos')
  assert(
    adminAllTodos.body.todos.assets.overdue.count === 0 &&
      adminAllTodos.body.todos.assets.dueSoon.count === 0,
    '别人的借出不会出现在我的待办里（只算"我借的"）',
    `管理员 ${adminAllTodos.body.todos.assets.overdue.count} / ${adminAllTodos.body.todos.assets.dueSoon.count}`,
  )
  assert(
    adminAllTodos.body.todos.assets.total === 0,
    '上面这些借出都是成员借的，管理员的财物待办合计为 0',
  )

  // 参数非法时不能把筛选静默变成"全部"
  const badWindow = await member.api('/api/assets/loans?mine=1&dueWithin=abc&limit=1000')
  assert(
    (badWindow.body.loans ?? []).length === (await member.api('/api/assets/loans?mine=1&limit=1000')).body.loans.length,
    'dueWithin 非法值被忽略（不会变成 NaN 拼进 SQL、也不会把筛选弄丢）',
  )

  // 收尾：还掉这一节借出的东西，别影响以后
  for (const loan of [dueToday, dueSoon2, dueFar, duePast]) {
    await member.api(`/api/assets/loans/${loan.id}/return`, { method: 'POST', json: {} })
  }
  assert(true, '待办测试已收尾（归还临时借出）')

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
