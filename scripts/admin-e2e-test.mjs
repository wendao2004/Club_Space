/**
 * 管理员两步验证与 Docker 管控的端到端测试。
 *
 * 覆盖两条实际会走的路径：
 *   A) 绑定两步验证的完整流程（获取二维码 → 验证器出码 → 启用 → 关闭）
 *   B) 管控未启用时接口的行为（本机没有 Docker，所以这正是真实状态）
 *
 * 关于"秘密"的检查也是重点：绑定后任何接口都不应再把秘密原文吐出来。
 *
 * 用法：先启动后端，然后  node scripts/admin-e2e-test.mjs
 */

import { totpAt } from '../server/src/admin/totp.ts'

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
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        options.body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const body = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body }
    },
  }
}

async function main() {
  console.log(`\n\x1b[1m管理员两步验证与管控 · 端到端测试\x1b[0m  目标 ${BASE}\n`)

  const admin = makeClient()
  const member = makeClient()

  // ---------------------------------------------------------------- 准备
  console.log('【准备账号】')
  const reg = await admin.api('/api/auth/register', {
    method: 'POST',
    json: { username: `adm${SUFFIX}`, displayName: '管理员', password: 'admin-e2e-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册管理员', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册管理员（首次运行成为创建者）')

  const inv = await admin.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const memberReg = await member.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `mbr${SUFFIX}`,
      displayName: '普通成员',
      password: 'member-e2e-2026',
      inviteCode: inv.body.code,
    },
  })
  assert(memberReg.status === 200 || memberReg.status === 201, '注册普通成员')

  // ---------------------------------------------------------------- 权限
  console.log('\n【权限边界】')
  const memberStatus = await member.api('/api/admin/totp/status')
  assert(memberStatus.status === 401, '普通成员看不到两步验证状态（401）', `状态 ${memberStatus.status}`)

  const memberSetup = await member.api('/api/admin/totp/setup', { method: 'POST', json: {} })
  assert(memberSetup.status === 401, '普通成员不能发起绑定（401）', `状态 ${memberSetup.status}`)

  const memberOps = await member.api('/api/admin/docker/operations')
  assert(memberOps.status === 401, '普通成员看不到运维操作清单（401）', `状态 ${memberOps.status}`)

  const anon = await fetch(`${BASE}/api/admin/totp/status`)
  assert(anon.status === 401, '未登录不能访问（401）', `状态 ${anon.status}`)

  // ---------------------------------------------------------------- 初始状态
  console.log('\n【初始状态】')
  const initial = await admin.api('/api/admin/totp/status')
  assert(initial.status === 200, '管理员可以查看自己的两步验证状态')
  assert(initial.body.bound === false, '初始时未绑定两步验证')
  assert(initial.body.hasPending === false, '初始时没有待确认的绑定')
  assert(initial.body.broken === false, '初始时不是"绑定已损坏"状态')
  assert(
    typeof initial.body.dockerEnabled === 'boolean',
    '状态里包含管控是否启用',
    `dockerEnabled=${initial.body.dockerEnabled}`,
  )

  // ---------------------------------------------------------------- 绑定流程
  console.log('\n【绑定两步验证】')

  const enableWithoutSetup = await admin.api('/api/admin/totp/enable', {
    method: 'POST',
    json: { code: '123456' },
  })
  assert(
    enableWithoutSetup.status === 400,
    '没获取二维码就直接启用会被拒（400）',
    `状态 ${enableWithoutSetup.status}`,
  )

  const setup = await admin.api('/api/admin/totp/setup', { method: 'POST', json: {} })
  assert(setup.status === 200, '获取绑定二维码')
  assert(typeof setup.body.secret === 'string' && setup.body.secret.length >= 16, '返回了秘密', `${setup.body.secret?.length} 字符`)
  assert(
    setup.body.otpauthUrl?.startsWith('otpauth://totp/'),
    '返回了验证器可识别的 otpauth 链接',
  )
  assert(
    setup.body.otpauthUrl.includes(`secret=${setup.body.secret}`),
    '链接里的秘密与返回值一致',
  )
  assert(
    /^[A-Z2-7 ]+$/.test(setup.body.formatted),
    '展示格式是分组后的 Base32（方便手抄）',
    setup.body.formatted,
  )

  const afterSetup = await admin.api('/api/admin/totp/status')
  assert(afterSetup.body.hasPending === true, '状态里标记出"有待确认的绑定"')
  assert(afterSetup.body.bound === false, '但还没生效（防止绑一半把自己锁在外面）')

  // 用错误的码确认
  const wrongEnable = await admin.api('/api/admin/totp/enable', {
    method: 'POST',
    json: { code: '000000' },
  })
  assert(wrongEnable.status === 400, '用错误的动态口令确认会被拒（400）', `状态 ${wrongEnable.status}`)
  assert(
    typeof wrongEnable.body.error === 'string' && wrongEnable.body.error.includes('口令'),
    '错误信息说明了是口令不对',
    wrongEnable.body.error,
  )

  const afterWrong = await admin.api('/api/admin/totp/status')
  assert(afterWrong.body.bound === false, '确认失败后仍然未绑定')
  assert(afterWrong.body.hasPending === true, '待确认的绑定还在（可以重试，不用重新扫码）')

  // 用正确的码确认
  const code = totpAt(setup.body.secret, Math.floor(Date.now() / 1000))
  const enable = await admin.api('/api/admin/totp/enable', { method: 'POST', json: { code } })
  assert(enable.status === 200, '用正确的动态口令确认成功')

  const afterEnable = await admin.api('/api/admin/totp/status')
  assert(afterEnable.body.bound === true, '两步验证已启用')
  assert(afterEnable.body.hasPending === false, '待确认状态已清空')
  assert(typeof afterEnable.body.enabledAt === 'number', '记录了启用时间')

  // ---------------------------------------------------------------- 秘密不外泄
  console.log('\n【秘密不外泄】')
  const statusJson = JSON.stringify(afterEnable.body)
  assert(!statusJson.includes(setup.body.secret), '状态接口不再返回秘密原文')
  const overview = await admin.api('/api/admin/overview')
  assert(
    !JSON.stringify(overview.body).includes(setup.body.secret),
    '管理概览里也没有秘密原文',
  )

  // ---------------------------------------------------------------- 管控未启用时的行为
  console.log('\n【Docker 管控（本机未启用，这正是真实状态）】')

  const ops = await admin.api('/api/admin/docker/operations')
  assert(ops.status === 200, '管理员可以查看运维操作清单')
  assert(Array.isArray(ops.body.operations), '返回了操作列表')
  assert(ops.body.operations.length >= 8, '操作清单完整', `${ops.body.operations.length} 个`)
  assert(
    ops.body.operations.every((o) => typeof o.mutating === 'boolean'),
    '每个操作都标明了是否为变更类（前端据此决定要不要弹动态口令输入）',
  )
  assert(
    !ops.body.operations.some((o) => /exec|shell|terminal/i.test(o.id)),
    '清单里没有任何"执行任意命令"的入口',
    ops.body.operations.map((o) => o.id).join(','),
  )
  assert(
    Array.isArray(ops.body.allowedServices),
    '返回了服务白名单（前端可以据此把选项直接列出来）',
    ops.body.allowedServices.join(','),
  )

  const execute = await admin.api('/api/admin/docker/execute', {
    method: 'POST',
    json: { operationId: 'ps', params: {}, totpCode: code },
  })
  assert(
    execute.status === 503,
    '管控未启用时执行被拒（503）——不留默认可用的后门',
    `状态 ${execute.status}：${execute.body.error ?? ''}`,
  )
  assert(
    typeof execute.body.error === 'string' && execute.body.error.includes('未启用'),
    '错误信息说明了原因',
    execute.body.error,
  )

  const unknownOp = await admin.api('/api/admin/docker/execute', {
    method: 'POST',
    json: { operationId: 'rm-rf', params: {}, totpCode: code },
  })
  assert(
    unknownOp.status >= 400,
    '未知操作被拒',
    `状态 ${unknownOp.status}`,
  )

  const memberExecute = await member.api('/api/admin/docker/execute', {
    method: 'POST',
    json: { operationId: 'ps', params: {} },
  })
  assert(memberExecute.status === 401, '普通成员不能执行运维操作（401）', `状态 ${memberExecute.status}`)

  // ---------------------------------------------------------------- 审计
  console.log('\n【审计留痕】')
  const auditRes = await admin.api('/api/admin/audit?limit=200')
  assert(auditRes.status === 200, '可以读取审计日志')
  const actions = auditRes.body.records.map((r) => r.action)
  assert(actions.includes('totp-setup-started'), '记录了"开始绑定两步验证"')
  assert(actions.includes('totp-enabled'), '记录了"两步验证已启用"')
  assert(actions.includes('totp-enable-failed'), '记录了失败的绑定尝试（这是重要信号）')
  assert(
    actions.includes('docker-execute-denied') || actions.includes('docker-execute-rejected'),
    '记录了被拒绝的运维操作尝试',
    actions.filter((a) => a.startsWith('docker-')).join(','),
  )

  const chain = await admin.api('/api/admin/audit/verify')
  assert(chain.body.ok === true, '加了这么多记录后审计链仍然自洽', `${chain.body.checked} 条`)

  /** 跟踪当前生效的 TOTP 秘密（重绑定后会换成新的）。 */
  let activeSecret = setup.body.secret

  // ---------------------------------------------------------------- 重新绑定必须再认证
  console.log('\n【重新绑定两步验证（防会话劫持回归）】')

  // 背景：最初 setup/enable 只要求"当前是管理员"，于是任何拿到管理员会话的人
  // 都能把自己的验证器绑成第二因子 —— 2FA 完全失效（而这正是威胁模型里
  // "管理员账号被盗"想挡的事）。现在重新绑定必须先证明对现有因子的占有。

  const rebindNoAuth = await admin.api('/api/admin/totp/setup', { method: 'POST', json: {} })
  assert(
    rebindNoAuth.status === 403,
    '已绑定时，不带再认证的重新绑定被拒（403）',
    `状态 ${rebindNoAuth.status}：${rebindNoAuth.body.error ?? ''}`,
  )
  assert(
    typeof rebindNoAuth.body.error === 'string' && rebindNoAuth.body.error.includes('证明身份'),
    '错误信息说明了需要证明身份',
    rebindNoAuth.body.error,
  )

  const rebindWrongCode = await admin.api('/api/admin/totp/setup', {
    method: 'POST',
    json: { currentCode: '000000' },
  })
  assert(rebindWrongCode.status === 403, '用错误的现有口令重新绑定被拒（403）')

  // **关键断言**：只给登录口令**不能**通过重绑定门禁。
  // 理由：登录接口本身不校验 TOTP，所以"知道口令"就能拿到会话；
  // 如果口令还能换掉第二因子，那 2FA 想挡的"口令泄漏"就等于没挡。
  const rebindWithPasswordOnly = await admin.api('/api/admin/totp/setup', {
    method: 'POST',
    json: { password: 'admin-e2e-2026' },
  })
  assert(
    rebindWithPasswordOnly.status === 403,
    '账号正常绑定时，登录口令不能替代动态口令（403）',
    `状态 ${rebindWithPasswordOnly.status}：${rebindWithPasswordOnly.body.error ?? ''}`,
  )
  assert(
    typeof rebindWithPasswordOnly.body.error === 'string' &&
      rebindWithPasswordOnly.body.error.includes('动态口令'),
    '错误信息说明了需要动态口令',
  )

  // enable 侧同样要有门禁（之前只测了 setup，若 enable 的门禁被删掉测试仍会全绿）
  const enableWithoutReauth = await admin.api('/api/admin/totp/enable', {
    method: 'POST',
    json: { code: totpAt(setup.body.secret, Math.floor(Date.now() / 1000)) },
  })
  assert(
    enableWithoutReauth.status === 403,
    '已绑定时，不带再认证的 enable 也被拒（403）',
    `状态 ${enableWithoutReauth.status}`,
  )

  // 用当前验证器上的码就允许重新绑定
  const currentRebindCode = totpAt(setup.body.secret, Math.floor(Date.now() / 1000))
  const rebindWithCode = await admin.api('/api/admin/totp/setup', {
    method: 'POST',
    json: { currentCode: currentRebindCode },
  })
  assert(
    rebindWithCode.status === 200 || rebindWithCode.status === 429,
    '带上当前动态口令后允许重新绑定（或触发限流）',
    `状态 ${rebindWithCode.status}${rebindWithCode.status === 429 ? '（限流）' : ''}`,
  )

  // 重新绑定后，**新秘密生效、旧秘密失效** —— 这是重绑定真正完成的证据
  if (rebindWithCode.status === 200 && rebindWithCode.body.secret) {
    const newSecret = rebindWithCode.body.secret
    const newCode = totpAt(newSecret, Math.floor(Date.now() / 1000))
    const enabled = await admin.api('/api/admin/totp/enable', {
      method: 'POST',
      json: { code: newCode, currentCode: currentRebindCode },
    })
    assert(
      enabled.status === 200 || enabled.status === 429,
      '用新秘密的码完成重绑定（或触发限流）',
      `状态 ${enabled.status}`,
    )

    if (enabled.status === 200) {
      // 重绑定成功 → 现在生效的是**新**秘密。用变量记下来，
      // 后面的用例（关闭两步验证）要用当前有效的那个。
      // 最初这里用 setup.body.secret（旧秘密）去关，于是关不掉 ——
      // 那不是产品的问题，是测试没跟上状态变化。
      activeSecret = newSecret

      // 旧秘密现在应该已经不能用了。
      // 注意用"下一个窗口"的码来验证，避开 ±1 窗口把它算作仍然有效的可能。
      const oldFutureCode = totpAt(setup.body.secret, Math.floor(Date.now() / 1000) + 300)
      const oldStillWorks = await admin.api('/api/admin/totp/disable', {
        method: 'POST',
        json: { code: oldFutureCode },
      })
      assert(
        oldStillWorks.status !== 200,
        '重绑定之后，旧验证器的码不再能通过（旧秘密确实失效了）',
        `状态 ${oldStillWorks.status}${oldStillWorks.body.error ? '：' + oldStillWorks.body.error : ''}`,
      )
    }
  }

  // ---------------------------------------------------------------- 两步登录
  console.log('\n【两步登录（第二因子必须保护"进入账号"本身）】')

  // 背景：最初 TOTP 只保护运维操作，而**登录只要口令** ——
  // 于是"口令泄漏"仍然等于账号沦陷。现在已绑定的账号登录必须走第二步。
  const freshLogin = makeClient()
  const step1 = await freshLogin.api('/api/auth/login', {
    method: 'POST',
    json: { username: `adm${SUFFIX}`, password: 'admin-e2e-2026' },
  })
  assert(step1.status === 200, '第一步：口令正确')
  assert(
    step1.body.needTotp === true,
    '口令正确但账号绑定了两步验证时，**不发会话**，而是要求第二步',
    JSON.stringify(step1.body).slice(0, 120),
  )
  assert(typeof step1.body.challenge === 'string', '返回了挑战令牌')
  assert(step1.body.user === undefined, '这一步没有返回用户信息（还没登录）')

  const meBefore = await freshLogin.api('/api/auth/me')
  assert(meBefore.status === 401, '此时还没有会话，访问需要登录的接口被拒（401）')

  const wrongStep2 = await freshLogin.api('/api/auth/login/totp', {
    method: 'POST',
    json: { challenge: step1.body.challenge, code: '000000' },
  })
  assert(wrongStep2.status === 401, '第二步用错误的动态口令不能换取会话（401）')

  const meStill = await freshLogin.api('/api/auth/me')
  assert(meStill.status === 401, '第二步失败后仍然没有会话')

  // 打错一次之后，挑战令牌**不应该**作废（否则手滑一位就要重输口令）
  const goodCode = totpAt(activeSecret, Math.floor(Date.now() / 1000))
  const step2 = await freshLogin.api('/api/auth/login/totp', {
    method: 'POST',
    json: { challenge: step1.body.challenge, code: goodCode },
  })
  assert(
    step2.status === 200,
    '用正确的动态口令完成第二步（打错一次之后挑战仍然有效）',
    `状态 ${step2.status}${step2.body.error ? '：' + step2.body.error : ''}`,
  )
  assert(step2.body.user?.username === `adm${SUFFIX}`, '第二步返回了用户信息')

  const meAfter = await freshLogin.api('/api/auth/me')
  assert(meAfter.status === 200, '第二步成功后拿到会话')

  // 挑战令牌是一次性的
  const replay = await freshLogin.api('/api/auth/login/totp', {
    method: 'POST',
    json: { challenge: step1.body.challenge, code: goodCode },
  })
  assert(
    replay.status === 401,
    '同一个挑战令牌不能重复使用（一次性）',
    `状态 ${replay.status}`,
  )

  // 伪造的挑战令牌
  const forgedChallenge = await freshLogin.api('/api/auth/login/totp', {
    method: 'POST',
    json: { challenge: 'fake.user.9999.deadbeef', code: goodCode },
  })
  assert(forgedChallenge.status === 401, '伪造的挑战令牌被拒（401）')

  // ---------------------------------------------------------------- 关闭两步验证
  console.log('\n【关闭两步验证】')

  const disableWrong = await admin.api('/api/admin/totp/disable', {
    method: 'POST',
    json: { code: '000000' },
  })
  assert(disableWrong.status === 401, '用错误口令关不掉（401）', `状态 ${disableWrong.status}`)

  const stillBound = await admin.api('/api/admin/totp/status')
  assert(stillBound.body.bound === true, '关闭失败后仍然保持绑定')

  const freshCode = totpAt(activeSecret, Math.floor(Date.now() / 1000))
  const disable = await admin.api('/api/admin/totp/disable', {
    method: 'POST',
    json: { code: freshCode },
  })
  assert(disable.status === 200, '用正确口令关闭两步验证')

  const afterDisable = await admin.api('/api/admin/totp/status')
  assert(afterDisable.body.bound === false, '已关闭')
  assert(afterDisable.body.enabledAt === null, '启用时间被清空')

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
