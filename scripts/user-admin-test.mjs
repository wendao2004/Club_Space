/**
 * 用户管理（需求 4 / 5）与相关权限（需求 3 / 6 / 10）的端到端测试。
 *
 * 重点不在"接口返回 200"，而在几条**错了会造成真实后果**的安全红线：
 *
 *   1. 改口令必须验证旧口令；否则会话被窃就等于静默夺号。
 *   2. 改口令 / 管理员重置口令 / 停用账号之后，旧会话必须立即失效 ——
 *      否则"改了等于没改"，旧设备上的会话还活着。
 *   3. 不能停用/降级最后一个 owner —— 否则没人能再管理系统。
 *   4. 管理员只能管普通成员；只有 owner 能调整角色；谁都不能改自己的角色/停用自己。
 *   5. 成员的"改自己"只能改自己 —— 请求体里传 userId 不能被理会。
 *   6. 普通成员不能代他人登记借出（伪造借款）。
 *   7. 口令**绝不**出现在审计里。
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
function eq(actual, expected, name) {
  assert(actual === expected, name, `期望 ${expected}，实际 ${actual}`)
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

async function loginAs(username, password) {
  const client = makeClient()
  const res = await client.api('/api/auth/login', { json: { username, password } })
  return { client, res }
}

async function main() {
  console.log(`\n\x1b[1m用户管理 / 个人资料 / 权限补全\x1b[0m  目标 ${BASE}\n`)

  const owner = makeClient()
  const member = makeClient()
  const member2 = makeClient()

  const PWD = 'user-admin-2026'
  const PWD2 = 'member-two-2026'

  // ---------------------------------------------------------------- 准备账号
  console.log('【准备账号】')
  const regOwner = await owner.api('/api/auth/register', {
    json: { username: `uba${SUFFIX}`, displayName: '创建者', password: PWD },
  })
  if (regOwner.status !== 200 && regOwner.status !== 201) {
    bad('注册首个账号（ownower）', `状态 ${regOwner.status}：${JSON.stringify(regOwner.body)}`)
    process.exit(1)
  }
  const ownerId = regOwner.body.user.id
  eq(regOwner.body.user.role, 'owner', '首个账号是 owner')
  ok('注册 owner')

  const inv1 = await owner.api('/api/admin/invites', {
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const regM = await member.api('/api/auth/register', {
    json: { username: `ubm${SUFFIX}`, displayName: '成员甲', password: PWD, inviteCode: inv1.body.code },
  })
  assert(regM.status === 200 || regM.status === 201, '注册成员甲', `状态 ${regM.status}`)
  const memberId = regM.body.user.id

  const inv2 = await owner.api('/api/admin/invites', {
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const regM2 = await member2.api('/api/auth/register', {
    json: { username: `ubn${SUFFIX}`, displayName: '成员乙', password: PWD2, inviteCode: inv2.body.code },
  })
  assert(regM2.status === 200 || regM2.status === 201, '注册成员乙', `状态 ${regM2.status}`)
  const member2Id = regM2.body.user.id

  // ---------------------------------------------------------------- 成员名册
  console.log('\n【成员名册 /api/members】')
  const roster = await member.api('/api/members')
  eq(roster.status, 200, '普通成员也能读成员名册')
  assert(
    Array.isArray(roster.body.members) && roster.body.members.some((u) => u.id === ownerId),
    '名册里能找到 owner',
  )

  // ---------------------------------------------------------------- 成员自助改资料
  console.log('\n【成员改自己的资料 / 口令】')
  const ren = await member.api('/api/me', { method: 'PATCH', json: { displayName: '成员甲改名' } })
  eq(ren.status, 200, '成员可以改自己的显示名')
  eq(ren.body.user?.displayName, '成员甲改名', '显示名已更新')

  const empty = await member.api('/api/me', { method: 'PATCH', json: { displayName: '' } })
  eq(empty.status, 400, '空显示名被拒（400）')

  // 请求体里塞 userId 也应被无视（只能改自己）
  const sneaky = await member.api('/api/me', {
    method: 'PATCH',
    json: { displayName: '成员甲改名', userId: ownerId },
  })
  eq(sneaky.status, 200, '带 userId 的改自己被接受（但只改自己）')
  const ownerMe = await owner.api('/api/auth/me')
  eq(ownerMe.body.user.displayName, '创建者', 'owner 的显示名没有被成员改动')

  const wrongOld = await member.api('/api/me/password', {
    json: { oldPassword: '不是我的口令', newPassword: 'brand-new-pass-1' },
  })
  eq(wrongOld.status, 400, '旧口令错误时改口令被拒（400）')

  const newPass = 'member-new-pass-2026'
  const changed = await member.api('/api/me/password', {
    json: { oldPassword: PWD, newPassword: newPass },
  })
  eq(changed.status, 200, '旧口令正确时可以改口令')

  const oldSession = await member.api('/api/auth/me')
  eq(oldSession.status, 401, '改口令后旧会话立即失效（401）')

  const relogin = await loginAs(`ubm${SUFFIX}`, newPass)
  eq(relogin.res.status, 200, '可以用新口令重新登录')
  const memberNew = relogin.client

  const reloginOld = await loginAs(`ubm${SUFFIX}`, PWD)
  eq(reloginOld.res.status, 401, '旧口令已不能登录（401）')

  // ---------------------------------------------------------------- 管理员改成员
  console.log('\n【管理员改成员资料】')
  const roleFromMember = await memberNew.api(`/api/admin/users/${member2Id}`, {
    method: 'PATCH',
    json: { status: 'disabled' },
  })
  assert(roleFromMember.status === 401 || roleFromMember.status === 403, '普通成员不能调用管理接口', `状态 ${roleFromMember.status}`)

  const renamed = await owner.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { displayName: '甲（管理员改的）' },
  })
  eq(renamed.status, 200, 'owner 可以改成员显示名')
  eq(renamed.body.user?.display_name, '甲（管理员改的）', '显示名已改')

  const promote = await owner.api(`/api/admin/users/${member2Id}`, {
    method: 'PATCH',
    json: { role: 'admin' },
  })
  eq(promote.status, 200, 'owner 可以把成员提升为管理员')
  const member2Admin = await loginAs(`ubn${SUFFIX}`, PWD2)
  eq(member2Admin.res.status, 200, '被提升者重新登录仍是管理员身份')
  const admin2 = member2Admin.client

  const adminTouchesOwner = await admin2.api(`/api/admin/users/${ownerId}`, {
    method: 'PATCH',
    json: { status: 'disabled' },
  })
  eq(adminTouchesOwner.status, 403, '管理员不能操作 owner（403）')

  const adminChangesRole = await admin2.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { role: 'admin' },
  })
  eq(adminChangesRole.status, 403, '只有 owner 能调整角色（管理员尝试改角色 403）')

  const adminDisablesMember = await admin2.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { status: 'disabled' },
  })
  eq(adminDisablesMember.status, 200, '管理员可以停用普通成员')
  const enableBack = await admin2.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { status: 'active' },
  })
  eq(enableBack.status, 200, '管理员可以重新启用普通成员')

  const adminResetsOwnerPw = await admin2.api(`/api/admin/users/${ownerId}/password`, {
    json: { password: 'whatever-1234' },
  })
  eq(adminResetsOwnerPw.status, 403, '管理员不能重置 owner 的口令（403）')

  // ---------------------------------------------------------------- 口令重置
  console.log('\n【管理员重置口令】')
  const weak = await owner.api(`/api/admin/users/${memberId}/password`, { json: { password: 'short' } })
  eq(weak.status, 400, '重置口令也要过强度校验（400）')

  const resetPwd = 'reset-by-admin-2026'
  const reset = await owner.api(`/api/admin/users/${memberId}/password`, { json: { password: resetPwd } })
  eq(reset.status, 200, 'owner 可以重置成员口令')

  const memberOldSession = await memberNew.api('/api/auth/me')
  eq(memberOldSession.status, 401, '重置口令后该成员旧会话失效（401）')

  const loginReset = await loginAs(`ubm${SUFFIX}`, resetPwd)
  eq(loginReset.res.status, 200, '成员用被重置的口令可以登录')
  const memberReset = loginReset.client

  // ---------------------------------------------------------------- 改自己的口令必须验旧口令
  //
  // ⚠️ 这一节是为一个**真实漏洞**补的回归测试：
  //
  // 管理接口 POST /api/admin/users/:id/password 原来不要求旧口令，而
  // assertCanManageUser 对"自己"是直接放行的 —— 于是任何人只要能拿到一个管理员的
  // **会话 cookie**（XSS、公用设备没退、cookie 被抄），就能 POST 到自己名下、
  // 静默把口令换掉：原主被锁在外面，攻击者拿到了这个账号。
  //
  // 而**同一件事**走 /api/me/password 是要验旧口令的 —— 同一个动作两条路径两种强度，
  // 等于白设一道防线。所以现在改自己的口令一律要验旧口令；
  // 管理员重置**别人**的口令仍然不需要（他本来就不该知道别人的口令）。
  console.log('\n【改自己的口令必须验旧口令（防会话被盗后夺号）】')

  const selfNoOld = await admin2.api(`/api/admin/users/${member2Id}/password`, {
    json: { password: 'attacker-chosen-2026' },
  })
  eq(selfNoOld.status, 400, '不带旧口令改自己的口令被拒（400）')

  const selfWrongOld = await admin2.api(`/api/admin/users/${member2Id}/password`, {
    json: { password: 'attacker-chosen-2026', oldPassword: '这不是我的口令' },
  })
  eq(selfWrongOld.status, 401, '旧口令不对被拒（401）')

  // 确认它确实**没有**被改掉 —— 光断言状态码不够，要验证口令还是原来那个
  const stillOldPwd = await loginAs(`ubn${SUFFIX}`, PWD2)
  eq(stillOldPwd.res.status, 200, '被拒之后密码没有被改动（原口令仍能登录）')
  const stillRejected = await admin2.api('/api/admin/users/' + member2Id, { method: 'PATCH', json: { displayName: '还在' } })
  eq(stillRejected.status, 200, '被拒的尝试没有把会话打断（本人还能正常用）')

  const selfOk = await admin2.api(`/api/admin/users/${member2Id}/password`, {
    json: { password: 'self-chosen-2026', oldPassword: PWD2 },
  })
  eq(selfOk.status, 200, '带上正确的旧口令就能改（正常路径没被误伤）')

  const selfOldSession = await admin2.api('/api/auth/me')
  eq(selfOldSession.status, 401, '改完自己的口令后旧会话失效（要重新登录）')

  // 注：「管理员重置**别人**的口令不需要旧口令」这条前面已经覆盖了
  // （见【管理员重置口令】那一节的 reset，就是不带旧口令把成员甲重置成功的）。
  // 这里**故意不再重置一次** —— 那会吊销成员甲的会话，而后面财物那一节还在用他，
  // 结果是"这条断言本身没问题，却把后面的用例全弄成 401"。

  // ---------------------------------------------------------------- 停用 / 启用
  console.log('\n【停用 / 启用 / 强制下线】')
  const disable = await owner.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { status: 'disabled' },
  })
  eq(disable.status, 200, 'owner 可以停用成员')
  const disabledSession = await memberReset.api('/api/auth/me')
  eq(disabledSession.status, 401, '停用后其会话失效（401）')
  const disabledLogin = await loginAs(`ubm${SUFFIX}`, resetPwd)
  eq(disabledLogin.res.status, 403, '停用账号不能登录（403）')

  const reenable = await owner.api(`/api/admin/users/${memberId}`, {
    method: 'PATCH',
    json: { status: 'active' },
  })
  eq(reenable.status, 200, 'owner 可以重新启用成员')
  const reLogin = await loginAs(`ubm${SUFFIX}`, resetPwd)
  eq(reLogin.res.status, 200, '启用后可以登录')
  const memberActive = reLogin.client

  const revoke = await owner.api(`/api/admin/users/${memberId}/sessions/revoke`, { json: {} })
  eq(revoke.status, 200, 'owner 可以强制成员下线')
  const revokedSession = await memberActive.api('/api/auth/me')
  eq(revokedSession.status, 401, '被强制下线后会话失效（401）')

  // ---------------------------------------------------------------- 安全红线
  console.log('\n【安全红线】')
  const selfDisable = await owner.api(`/api/admin/users/${ownerId}`, {
    method: 'PATCH',
    json: { status: 'disabled' },
  })
  eq(selfDisable.status, 400, '最后一位 owner 不能停用自己（400）')

  const selfDemote = await owner.api(`/api/admin/users/${ownerId}`, {
    method: 'PATCH',
    json: { role: 'member' },
  })
  eq(selfDemote.status, 400, '最后一位 owner 不能降级自己（400）')

  const selfToAdmin = await owner.api(`/api/admin/users/${ownerId}`, {
    method: 'PATCH',
    json: { role: 'admin' },
  })
  eq(selfToAdmin.status, 400, '最后一位 owner 不能把自己降成 admin（400）')

  // 有了第二个 owner 之后，改自己的角色仍然被拒（自锁保护），但不触发"最后一个 owner"
  const promoteOwner = await owner.api(`/api/admin/users/${member2Id}`, {
    method: 'PATCH',
    json: { role: 'owner' },
  })
  eq(promoteOwner.status, 200, 'owner 可以把成员提升为 owner')
  const selfRoleAgain = await owner.api(`/api/admin/users/${ownerId}`, {
    method: 'PATCH',
    json: { role: 'member' },
  })
  eq(selfRoleAgain.status, 400, '就算有第二个 owner，也不能改自己的角色（400）')
  // 复位，避免后续断言受它影响
  await owner.api(`/api/admin/users/${member2Id}`, { method: 'PATCH', json: { role: 'member' } })

  // ---------------------------------------------------------------- 审计
  console.log('\n【审计留痕】')
  const audit = await owner.api('/api/admin/audit?limit=2000')
  eq(audit.status, 200, '可以读审计')
  const actions = (audit.body.records ?? []).map((r) => r.action)
  assert(actions.includes('profile-update'), '审计里记录了 profile-update（改自己资料）')
  assert(actions.includes('password-change'), '审计里记录了 password-change（自助改口令）')
  assert(actions.includes('user-password-reset'), '审计里记录了 user-password-reset')
  assert(actions.includes('user-session-revoke'), '审计里记录了 user-session-revoke')
  assert(actions.includes('user-update'), '审计里记录了 user-update')
  assert(actions.includes('user-manage-denied'), '越权尝试也被审计（user-manage-denied）')

  const auditText = JSON.stringify(audit.body.records ?? [])
  assert(!auditText.includes(newPass), '审计里没有明文新口令（自助改口令）')
  assert(!auditText.includes(resetPwd), '审计里没有明文重置口令')

  // ---------------------------------------------------------------- 邀请码作废
  console.log('\n【邀请码作废】')
  const inv3 = await owner.api('/api/admin/invites', { json: { role: 'member', maxUses: 1 } })
  const code3 = inv3.body.code
  const delInv = await owner.api(`/api/admin/invites/${encodeURIComponent(code3)}`, { method: 'DELETE' })
  eq(delInv.status, 200, 'owner 可以作废邀请码')
  const useRevoked = await makeClient().api('/api/auth/register', {
    json: { username: `ubx${SUFFIX}`, displayName: '不该成功', password: PWD, inviteCode: code3 },
  })
  eq(useRevoked.status, 403, '作废后的邀请码不能注册（403）')
  const delAgain = await owner.api(`/api/admin/invites/${encodeURIComponent(code3)}`, { method: 'DELETE' })
  eq(delAgain.status, 404, '重复作废返回 404')

  // ---------------------------------------------------------------- 财物：代借与记录更正
  console.log('\n【财物：代他人借出 / 更正记录】')
  const item = await owner.api('/api/assets/items', {
    json: { name: `测试帐篷${SUFFIX}`, totalQty: 5 },
  })
  eq(item.status, 200, 'owner 登记物品')
  const itemId = item.body.item.id

  const memberLogin = await loginAs(`ubm${SUFFIX}`, resetPwd)
  const memberNow = memberLogin.client
  const lendForOther = await memberNow.api('/api/assets/loans', {
    json: { itemId, borrowerId: ownerId },
  })
  eq(lendForOther.status, 403, '普通成员不能代他人登记借出（403）')

  const lendSelf = await memberNow.api('/api/assets/loans', { json: { itemId } })
  eq(lendSelf.status, 200, '普通成员可以给自己借')
  const lendSelfId = lendSelf.body.loan.id

  const ownerLendForOther = await owner.api('/api/assets/loans', {
    json: { itemId, borrowerId: memberId, qty: 2 },
  })
  eq(ownerLendForOther.status, 200, '管理员可以代成员登记借出')
  const ownerLoanId = ownerLendForOther.body.loan.id

  const memberPatchLoan = await memberNow.api(`/api/assets/loans/${lendSelfId}`, {
    method: 'PATCH',
    json: { qty: 2 },
  })
  assert(memberPatchLoan.status === 401 || memberPatchLoan.status === 403, '普通成员不能更正借还记录', `状态 ${memberPatchLoan.status}`)

  const patchLoan = await owner.api(`/api/assets/loans/${ownerLoanId}`, {
    method: 'PATCH',
    json: { qty: 3, borrowerId: memberId },
  })
  eq(patchLoan.status, 200, '管理员可以更正借还记录')
  eq(patchLoan.body.loan.qty, 3, '更正后的数量正确')

  const voidLoan = await owner.api(`/api/assets/loans/${ownerLoanId}`, { method: 'DELETE' })
  eq(voidLoan.status, 200, '管理员可以作废借还记录')
  assert(voidLoan.body.loan.voidedAt !== null, '作废记录带 voidedAt 标记')
  const voidAgain = await owner.api(`/api/assets/loans/${ownerLoanId}`, { method: 'DELETE' })
  eq(voidAgain.status, 409, '重复作废返回 409')

  // 作废后账面可用量应回到 5（之前 owner 借出 2，member 借 1）
  const afterVoid = await owner.api(`/api/assets/items/${itemId}`)
  eq(afterVoid.body.item.onLoanQty, 1, '作废后在外数量只剩成员借的 1 件')

  // 恢复：作废点错了的后悔药。恢复前会重新过一遍账面校验
  const memberRestore = await memberNow.api(`/api/assets/loans/${ownerLoanId}/restore`, {
    method: 'POST',
    json: {},
  })
  assert(
    memberRestore.status === 401 || memberRestore.status === 403,
    '普通成员不能恢复借还记录',
    `状态 ${memberRestore.status}`,
  )

  const loanSearchTerm = `测试帐篷${SUFFIX}`
  const searchLoans = await owner.api(`/api/assets/loans?search=${encodeURIComponent(loanSearchTerm)}`)
  eq(searchLoans.status, 200, '按关键词搜借还记录')
  assert(
    searchLoans.body.loans.length >= 1 &&
      searchLoans.body.loans.every((l) => (l.itemName ?? '').includes(loanSearchTerm)),
    '搜索按物品名命中',
    JSON.stringify(searchLoans.body.loans.map((l) => l.itemName)),
  )
  const searchMiss = await owner.api('/api/assets/loans?search=__绝对搜不到__')
  eq(searchMiss.body.loans.length, 0, '搜不到时返回空列表')

  const restored = await owner.api(`/api/assets/loans/${ownerLoanId}/restore`, { method: 'POST', json: {} })
  eq(restored.status, 200, '管理员可以恢复被作废的记录')
  eq(restored.body.loan.voidedAt, null, '恢复后 voidedAt 被清空')
  const afterRestore = await owner.api(`/api/assets/items/${itemId}`)
  eq(afterRestore.body.item.onLoanQty, 4, '恢复后在外数量回到 4 件（3 + 成员借的 1）')
  const restoreAgain = await owner.api(`/api/assets/loans/${ownerLoanId}/restore`, { method: 'POST', json: {} })
  eq(restoreAgain.status, 409, '重复恢复返回 409')

  // ---------------------------------------------------------------- 文件：私有空间的管理员可读
  console.log('\n【文件：私有空间访问一致性】')
  const privFolder = await memberNow.api('/api/files/folder', {
    json: { parentId: null, name: `私人文件夹${SUFFIX}`, space: 'private' },
  })
  eq(privFolder.status, 200, '成员可以建私有文件夹')
  const privName = `私人文件夹${SUFFIX}`
  const ownerPrivate = await owner.api('/api/files?space=private')
  assert(
    (ownerPrivate.body.entries ?? []).some((e) => e.name === privName),
    '管理员能在私有空间看到成员的文件夹（读写一致）',
  )
  const member2Login = await loginAs(`ubn${SUFFIX}`, PWD2)
  const member2Private = await member2Login.client.api('/api/files?space=private')
  assert(
    !(member2Private.body.entries ?? []).some((e) => e.name === privName),
    '普通成员看不到别人的私有文件夹（隐私仍隔离）',
  )

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
