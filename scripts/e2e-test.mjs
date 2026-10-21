/**
 * 端到端冒烟测试。
 *
 * 用 Node 原生 fetch 而不是 curl：Windows 的 Git Bash 会以 CP936 把中文交给
 * curl，导致中文在到达服务端之前就已经损坏（表现为 U+FFFD 替换字符）。
 * 用 Node 发请求可以保证 UTF-8 一路正确，测出来的才是服务端的真实行为。
 *
 * 用法：先启动后端（pnpm dev），然后  node scripts/e2e-test.mjs
 * 环境变量 WL_TEST_BASE 可改目标地址，默认 http://127.0.0.1:3000
 */

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const SUFFIX = String(process.pid).slice(-5) // 让用户名可重复跑而互不冲突

let cookie = ''
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

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (cookie) headers.cookie = cookie
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(options.json)
  }
  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]

  const type = res.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await res.json() : await res.arrayBuffer()
  return { status: res.status, body, headers: res.headers }
}

// ---------------------------------------------------------------- 测试数据

const CHINESE_NAME = '社团资料·2026'
const FOLDER_NAME = '会议纪要'
const TEXT_CONTENT = '社团内网平台的端到端测试。\n第二行：包含中文、English、数字 12345 与符号 —— · ！\n'
const SECOND_UPLOAD_NAME = '二次上传的同名文件.txt'

function bytesOf(text) {
  return new TextEncoder().encode(text)
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n\x1b[1m端到端测试\x1b[0m  目标 ${BASE}\n`)

  // ---- 健康检查 ----
  console.log('【健康检查】')
  const health = await api('/api/health')
  assert(health.status === 200 && health.body.ok === true, '后端存活')
  assert(health.body.audit.chainOk === true, '审计链自洽')
  assert(health.body.audit.healthy === true, '审计写入正常')

  // ---- 注册 ----
  console.log('\n【注册与登录】')
  const boot = await api('/api/bootstrap')
  const username = `tester${SUFFIX}`
  const password = 'test-password-2026'

  const reg = await api('/api/auth/register', {
    method: 'POST',
    json: {
      username,
      displayName: '测试成员·中文名',
      password,
    },
  })

  if (reg.status === 200 || reg.status === 201) {
    assert(reg.body.user.displayName === '测试成员·中文名', '中文昵称原样存取（UTF-8 往返正确）', reg.body.user.displayName)
    assert(['owner', 'admin', 'member'].includes(reg.body.user.role), '注册后拿到合法角色', reg.body.user.role)
  } else if (reg.status === 403) {
    // 已经有用户了，必须持邀请码；退化成登录测试
    ok('注册需要邀请码（符合预期：非首次运行）')
  } else {
    bad('注册', `状态 ${reg.status} ${JSON.stringify(reg.body)}`)
  }

  // 若注册未成功（需要邀请码），改用已存在的账号登录
  if (reg.status !== 200 && reg.status !== 201) {
    const login = await api('/api/auth/login', {
      method: 'POST',
      json: { username: 'admin', password: 'club-pass-2026' },
    })
    assert(login.status === 200, '用已有账号登录', `状态 ${login.status}`)
  }

  const me = await api('/api/auth/me')
  assert(me.status === 200 && me.body.user, '会话有效（cookie 生效）')

  // ---- 目录 ----
  console.log('\n【目录操作】')
  const folder = await api('/api/files/folder', {
    method: 'POST',
    json: { name: FOLDER_NAME, space: 'shared' },
  })
  assert(folder.status === 200, '创建中文名目录')
  assert(folder.body.node.name === FOLDER_NAME, '中文目录名原样保存', folder.body.node.name)
  const folderId = folder.body.node.id

  const dup = await api('/api/files/folder', {
    method: 'POST',
    json: { name: FOLDER_NAME, space: 'shared' },
  })
  assert(dup.status === 409, '同名目录被拒绝（409）')

  const evil = await api('/api/files/folder', {
    method: 'POST',
    json: { name: '../逃逸目录', space: 'shared' },
  })
  assert(evil.status === 400, '拒绝含路径穿越字符的名称')

  // ---- 分片上传 ----
  console.log('\n【分片上传 · 断点续传 · 秒传】')
  const payload = bytesOf(TEXT_CONTENT)
  const sha = await sha256Hex(payload)

  const init = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: folderId,
      name: '会议记录.txt',
      size: payload.byteLength,
      sha256: sha,
      space: 'shared',
    },
  })
  assert(init.status === 200, '开启上传会话')
  assert(init.body.instant === false, '首次上传未命中秒传')

  const uploadId = init.body.uploadId
  const chunkSize = 16
  let offset = 0
  while (offset < payload.byteLength) {
    const slice = payload.subarray(offset, Math.min(offset + chunkSize, payload.byteLength))
    const res = await api(`/api/uploads/${uploadId}/chunk?offset=${offset}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: slice,
    })
    if (res.status !== 200) {
      bad('上传分片', `偏移 ${offset} 返回 ${res.status} ${JSON.stringify(res.body)}`)
      break
    }
    offset = res.body.received
  }
  assert(offset === payload.byteLength, '全部字节已落盘', `${offset}/${payload.byteLength}`)

  // 乱序分片必须被拒 —— 这是"已收字节数可信"的前提
  const outOfOrder = await api(`/api/uploads/${uploadId}/chunk?offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytesOf('x'),
  })
  assert(outOfOrder.status === 409, '拒绝乱序/重复分片（409）')

  const done = await api(`/api/uploads/${uploadId}/complete`, { method: 'POST' })
  assert(done.status === 200, '完成上传')
  assert(done.body.mime === 'text/plain', '按文件头识别出 text/plain', done.body.mime)
  const fileId = done.body.nodeId

  // 秒传：同样的内容再传一次，应该立刻完成且不传字节
  const instant = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: folderId,
      name: SECOND_UPLOAD_NAME,
      size: payload.byteLength,
      sha256: sha,
      space: 'shared',
    },
  })
  assert(instant.status === 200 && instant.body.instant === true, '相同内容命中秒传（未传字节）')

  // ---- 任何格式都能上传（内容定类型，名字不作数）----
  //
  // 旧策略是一份类型白名单 + 扩展名交叉校验，不符就 415。用户后来明确要求
  // "能上传任何格式的文件"，于是改成：**任何内容都收，类型按文件头判定**。
  //
  // 这个测试验证新契约的两半，缺一不可：
  //   1. 名字与内容不符的文件**不再被拒**（旧代码这里 415）；
  //   2. 但它的类型必须按**内容**定 —— 叫 .pdf 的文本存成 text/plain，
  //      否则"改个名字就能骗过响应头"，那是存储型 XSS 的入口（见 mime.ts）。
  const fakeBytes = bytesOf('这其实不是 PDF 文件，只是普通文本。')
  const fakeInit = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: folderId,
      name: '伪装文件.pdf',
      size: fakeBytes.byteLength,
      space: 'shared',
    },
  })
  if (fakeInit.status === 200) {
    await api(`/api/uploads/${fakeInit.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: fakeBytes,
    })
    const fakeDone = await api(`/api/uploads/${fakeInit.body.uploadId}/complete`, { method: 'POST' })
    assert(
      fakeDone.status === 200,
      '「伪装成 .pdf 的文本」不再被类型拒绝（旧代码是 415）',
      `状态 ${fakeDone.status}`,
    )
    assert(
      fakeDone.body.mime === 'text/plain',
      '类型按内容判定：.pdf 的壳不作数，存成 text/plain',
      fakeDone.body.mime,
    )
    if (fakeDone.status === 200) {
      const fakePreview = await fetch(`${BASE}/api/files/${fakeDone.body.nodeId}/preview`, {
        headers: { cookie },
      })
      const fakeType = fakePreview.headers.get('content-type') ?? ''
      assert(!fakeType.includes('pdf'), '预览响应头的类型也不采信文件名（不是 PDF）', fakeType)
    }
  } else {
    bad('伪装文件测试准备', `未能开启上传：状态 ${fakeInit.status}`)
  }

  // 无扩展名 + 认不出来的二进制：一样能传。
  // 但类型必须落到最保守的 application/octet-stream（浏览器只会下载它，
  // 不会把它当文档渲染），而不是凭空猜一个。
  const blobBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x99])
  const blobInit = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: folderId,
      name: '无扩展名的程序固件',
      size: blobBytes.byteLength,
      space: 'shared',
    },
  })
  if (blobInit.status === 200) {
    await api(`/api/uploads/${blobInit.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: blobBytes,
    })
    const blobDone = await api(`/api/uploads/${blobInit.body.uploadId}/complete`, { method: 'POST' })
    assert(blobDone.status === 200, '无扩展名、内容无法识别的文件也能上传')
    assert(
      blobDone.body.mime === 'application/octet-stream',
      '认不出来的内容标成 application/octet-stream',
      blobDone.body.mime,
    )
  } else {
    bad('无扩展名文件测试准备', `未能开启上传：状态 ${blobInit.status}`)
  }

  // ---- 单文件大小上限已经取消 ----
  //
  // 原来是一道写死的 4GiB 上限。用户问"上传文件为什么有限制，我不希望有限制" ——
  // 那个数字挡不住真正该挡的事（传 4 个大文件照样能写满盘），
  // 却会把正常的大文件拒掉。现在默认不限，改由磁盘余量守卫保护机器。
  //
  // 声明 5GiB（超过旧的 4GiB 上限）来验证这一点。**不断言"必然成功"** ——
  // 磁盘不够时会被余量守卫拒掉（507），那是正确行为。关键是**不再是 413**。
  const bigInit = await api('/api/uploads', {
    method: 'POST',
    json: { parentId: folderId, name: '大文件测试.bin', size: 5 * 1024 ** 3, space: 'shared' },
  })
  assert(
    bigInit.status !== 413,
    '5GiB 的声明不再被「单文件上限」拒绝（旧代码这里是 413）',
    `状态 ${bigInit.status}${bigInit.body?.error ? '：' + bigInit.body.error.slice(0, 80) : ''}`,
  )
  assert(
    bigInit.status === 200 || bigInit.status === 507,
    '要么放行、要么因磁盘余量不足被拒（而不是被一个拍脑袋的数字拒）',
    `状态 ${bigInit.status}`,
  )
  if (bigInit.status === 200) {
    // 别真的传 5GB 上去，清掉这个会话
    await api(`/api/uploads/${bigInit.body.uploadId}`, { method: 'DELETE' })
  }

  // ---- 列表与下载 ----
  console.log('\n【列表 · 下载 · 内容一致性】')
  const list = await api(`/api/files?parent=${folderId}&space=shared`)
  assert(list.status === 200, '列出目录内容')
  const names = list.body.entries.map((e) => e.name)
  assert(names.includes('会议记录.txt'), '列表里有刚上传的文件', names.join(', '))
  assert(names.includes(SECOND_UPLOAD_NAME), '列表里有秒传的文件')

  const download = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { cookie } })
  const downloaded = new Uint8Array(await download.arrayBuffer())
  assert(download.status === 200, '下载成功')
  assert(
    downloaded.byteLength === payload.byteLength &&
      Buffer.from(downloaded).equals(Buffer.from(payload)),
    '下载内容与上传内容逐字节一致',
    `${downloaded.byteLength} 字节`,
  )
  const cd = download.headers.get('content-disposition') ?? ''
  assert(cd.includes("filename*=UTF-8''"), '下载头使用了 RFC 5987 中文文件名', cd)

  // ---- 工具 ----
  console.log('\n【工具集】')
  const tools = await api('/api/tools')
  assert(tools.status === 200 && tools.body.tools.length > 0, '工具清单可获取', `${tools.body.tools.length} 个`)
  const available = tools.body.tools.filter((t) => t.available).map((t) => t.id)
  assert(available.includes('pdf.merge'), 'PDF 合并可用（纯 JS，无需外部服务）', available.join(', '))
  const unavailable = tools.body.tools.filter((t) => !t.available)
  assert(
    unavailable.every((t) => typeof t.unavailableReason === 'string' && t.unavailableReason.length > 0),
    '不可用的工具都带了明确原因（不静默失败）',
    unavailable.map((t) => t.id).join(', ') || '无',
  )

  // 二维码（含中文）
  const qr = await api('/api/tools/qr.generate/run', {
    method: 'POST',
    json: { nodeIds: [], params: { text: '社团内网平台 · 中文二维码测试', size: 256 } },
  })
  assert(qr.status === 200, '提交二维码生成任务')

  let qrJob = null
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const job = await api(`/api/jobs/${qr.body.jobId}`)
    if (job.body.job.state === 'done') {
      qrJob = job.body.job
      break
    }
    if (job.body.job.state === 'failed') {
      bad('二维码任务', job.body.job.error ?? '未知错误')
      break
    }
  }
  assert(qrJob !== null, '二维码任务执行完成')
  if (qrJob) {
    assert(qrJob.outputNodeIds.length === 1, '二维码产出了 1 个文件')
    const qrFile = await fetch(`${BASE}/api/files/${qrJob.outputNodeIds[0]}/download`, {
      headers: { cookie },
    })
    const qrBytes = new Uint8Array(await qrFile.arrayBuffer())
    const isPng =
      qrBytes[0] === 0x89 && qrBytes[1] === 0x50 && qrBytes[2] === 0x4e && qrBytes[3] === 0x47
    assert(isPng, '二维码产物是合法 PNG（文件头校验）', `${qrBytes.byteLength} 字节`)
  }

  // ---- 审计 ----
  console.log('\n【审计链】')
  const verify = await api('/api/admin/audit/verify')
  if (verify.status === 200) {
    assert(verify.body.ok === true, '审计链校验通过', `${verify.body.checked} 条记录`)
    assert(verify.body.checked > 5, '确实记录了操作（不是空链）', `${verify.body.checked} 条`)
  } else {
    // 普通成员看不到管理接口是正确行为
    assert(verify.status === 401, '非管理员访问管理接口被拒（401）', `状态 ${verify.status}`)
  }

  const anon = await fetch(`${BASE}/api/files`)
  assert(anon.status === 401, '未登录访问文件接口被拒（401）', `状态 ${anon.status}`)

  await testInstantUploadPrivacy()
  await testInstantUploadRefCount()

  // ---- 结果 ----
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * 秒传的引用计数回归测试。
 *
 * 背景：秒传会为同一个 blob 建出多个节点（磁盘上只存一份内容）。
 * 最初秒传分支忘了给引用计数 +1，后果是**静默的数据丢失**：
 * 删掉其中任何一个节点时计数就归零，blob 被真正删盘，而另一个节点还在引用它 ——
 * 表现是"删掉一个副本，另一份文件也打不开了"。
 *
 * 这个测试就是那条路径：传一份 → 秒传一份 → 删掉秒传出来的那份 →
 * **原始那份必须仍然能正常下载**。
 */
async function testInstantUploadRefCount() {
  console.log('\n【秒传的引用计数（防误删回归）】')

  const content = bytesOf(`这份内容会被秒传两次，引用计数必须记对。${SUFFIX}`)
  const hash = await sha256Hex(content)

  // 第一次：正常上传
  const first = await api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name: '引用计数-原始.txt', size: content.byteLength, sha256: hash, space: 'shared' },
  })
  if (first.status !== 200 || first.body.instant) {
    bad('引用计数测试准备', `第一次上传不应命中秒传：${JSON.stringify(first.body)}`)
    return
  }
  await api(`/api/uploads/${first.body.uploadId}/chunk?offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: content,
  })
  const original = await api(`/api/uploads/${first.body.uploadId}/complete`, { method: 'POST', json: {} })
  assert(original.status === 200, '第一份正常上传完成')
  const originalId = original.body.nodeId

  // 第二次：同内容 → 秒传
  const second = await api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name: '引用计数-副本.txt', size: content.byteLength, sha256: hash, space: 'shared' },
  })
  assert(second.body?.instant === true, '第二份命中秒传（没传字节）')
  const copyId = second.body?.nodeId

  // 删掉副本 —— 这一步在 bug 存在时会把磁盘上的 blob 一起删掉
  const deleted = await api(`/api/files/${copyId}`, { method: 'DELETE' })
  assert(deleted.status === 200, '删掉了秒传出来的那份副本')

  // **关键断言**：原始那份必须还能下载，且内容完整
  const download = await fetch(`${BASE}/api/files/${originalId}/download`, { headers: { cookie } })
  assert(download.status === 200, '删掉副本之后，原始文件仍然可以下载', `状态 ${download.status}`)
  if (download.status === 200) {
    const bytes = new Uint8Array(await download.arrayBuffer())
    assert(
      bytes.byteLength === content.byteLength &&
        Buffer.from(bytes).equals(Buffer.from(content)),
      '下载到的内容与上传时逐字节一致（blob 没有被误删）',
      `${bytes.byteLength} 字节`,
    )
  }

  // 顺手验一下引用计数自检接口：删完之后不应该有对不上的 blob
  const overview = await api('/api/admin/overview')
  if (overview.status === 200) {
    ok('管理概览可访问（用于后续自检）')

    // 存储明细：单文件不设上限是刻意的，那"谁用得最多、最大的几个文件是谁的"
    // 就必须有接口能回答（界面上在「管理 → 概览 → 存储明细」）。
    const storage = overview.body?.storage
    assert(!!storage, '概览里带存储明细')
    assert(Array.isArray(storage.topFiles), '存储明细带"最大的文件"列表')
    assert(Array.isArray(storage.byOwner), '存储明细带按人汇总')
    assert(typeof storage.freeBytes === 'number' && storage.freeBytes >= 0, '带磁盘剩余空间')
    const sizes = (storage.topFiles ?? []).map((f) => f.size)
    assert(sizes.every((s, i) => i === 0 || sizes[i - 1] >= s), '最大的文件按大小倒序')
    const me = (storage.byOwner ?? []).find((r) => r.name && r.files > 0)
    assert(!!me, '按人汇总里有传过文件的人')
  }

  // 清理
  await api(`/api/files/${originalId}`, { method: 'DELETE' })
}

/**
 * 秒传的跨空间信息泄漏回归测试。
 *
 * 背景：最初的实现是"blobs 表里有这个 sha256 就返回秒传"。这形成一个探测通道——
 * 攻击者只要知道某个文件的哈希，提交一次上传、看是否返回 instant，就能判断
 * "这份内容在不在这个平台里"，包括在别人的个人空间里的文件。
 *
 * 正确行为：秒传只在"该用户在该空间里本来就能看到同内容"时才生效。
 * 别人的个人空间内容仍会被去重（存储层复用），但用户必须真的把字节传上来。
 */
async function testInstantUploadPrivacy() {
  console.log('\n【秒传的跨空间隔离（信息泄漏回归）】')

  const secret = bytesOf(`这是甲的私人文件，乙不应该能通过哈希探测到它。${SUFFIX}`)
  const secretHash = await sha256Hex(secret)

  // --- 甲：注册第二个账号（需要邀请码，用已登录的 owner 发一张）---
  const inviteRes = await api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1, note: '跨空间测试' },
  })
  if (inviteRes.status !== 200) {
    // 当前登录的账号可能不是管理员（例如测试跑在已注册的普通成员上）
    ok('跳过跨空间测试（当前账号无发码权限）')
    return
  }
  const inviteCode = inviteRes.body.code

  // --- 乙：用另一套 cookie 注册并登录 ---
  const ownerCookie = cookie
  cookie = ''
  const otherName = `other${SUFFIX}`
  const regOther = await api('/api/auth/register', {
    method: 'POST',
    json: { username: otherName, displayName: '另一名成员', password: 'other-pass-2026', inviteCode },
  })
  assert(regOther.status === 200 || regOther.status === 201, '第二个账号注册成功（用邀请码）')
  const otherCookie = cookie

  // --- 乙把自己的文件传到**个人空间** ---
  //
  // ⚠️ 完成上传刻意**不带 ?space=** —— 这正是前端 api.ts uploadFile 的真实调用形态。
  // 曾经服务端在 complete 时从 query 取 space（缺省 shared），于是个人空间的上传
  // 被错建到共享空间：传进私人子目录的，两个空间里都列不出来（用户报的"看不到"）。
  // 当年这条回归漏掉它，就是因为测试自作主张带了 ?space=private —— 测试写成了
  // "迁就实现"，而不是"模仿用户"。
  const initPrivate = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: null,
      name: '乙的私密文件.txt',
      size: secret.byteLength,
      sha256: secretHash,
      space: 'private',
    },
  })
  assert(initPrivate.status === 200, '乙在个人空间开启上传')

  if (initPrivate.status === 200 && !initPrivate.body.instant) {
    await api(`/api/uploads/${initPrivate.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: secret,
    })
    const donePrivate = await api(`/api/uploads/${initPrivate.body.uploadId}/complete`, { method: 'POST' })
    assert(donePrivate.status === 200, '乙的私密文件上传完成（完成请求不带 ?space=）')

    // 落在**个人空间**根目录，而不是共享空间
    const privateList = await api('/api/files?space=private')
    const privateNames = (privateList.body.entries ?? []).map((e) => e.name)
    assert(
      privateNames.includes('乙的私密文件.txt'),
      '上传的文件出现在乙的个人空间里',
      privateNames.join('、') || '（空）',
    )
    const sharedListAfter = await api('/api/files?space=shared')
    const sharedNamesAfter = (sharedListAfter.body.entries ?? []).map((e) => e.name)
    assert(!sharedNamesAfter.includes('乙的私密文件.txt'), '它没有跑到共享空间去')

    // ---- 再传进**个人空间里的子目录**（最狠的一条：错位后两个空间都列不出来）----
    const pf = await api('/api/files/folder', {
      method: 'POST',
      json: { parentId: null, name: '乙的私人目录', space: 'private' },
    })
    assert(pf.status === 200, '乙在个人空间建了一个子目录')
    const pfId = pf.body.node.id

    const initInFolder = await api('/api/uploads', {
      method: 'POST',
      json: { parentId: pfId, name: '乙的目录内文件.txt', size: secret.byteLength, space: 'private' },
    })
    assert(initInFolder.status === 200, '往私人子目录开启上传')
    await api(`/api/uploads/${initInFolder.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: secret,
    })
    const doneInFolder = await api(`/api/uploads/${initInFolder.body.uploadId}/complete`, { method: 'POST' })
    assert(doneInFolder.status === 200, '目录内的文件上传完成')

    const insideList = await api(`/api/files?parent=${pfId}&space=private`)
    const insideNames = (insideList.body.entries ?? []).map((e) => e.name)
    assert(
      insideNames.includes('乙的目录内文件.txt'),
      '私人子目录里能看到刚传的文件（防"两个空间都列不出来"）',
      insideNames.join('、') || '（空）',
    )
  } else {
    bad('乙的私密文件上传', `instant=${JSON.stringify(initPrivate.body)}`)
  }

  // --- 甲：拿同一个哈希去探测 ---
  cookie = ownerCookie
  const probe = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: null,
      name: '探测.txt',
      size: secret.byteLength,
      sha256: secretHash,
      space: 'shared',
    },
  })

  assert(probe.status === 200, '甲的探测请求本身是合法请求')
  assert(
    probe.body.instant === false,
    '甲无法通过哈希秒传探测到乙个人空间里的文件（信息不泄漏）',
    `instant=${probe.body.instant}`,
  )

  // 收尾：甲放弃这次探测上传
  if (probe.status === 200 && probe.body.uploadId) {
    await api(`/api/uploads/${probe.body.uploadId}`, { method: 'DELETE' })
  }

  // --- 反向对照：甲在同空间内确实能秒传 ---
  // 甲自己先在共享空间传一份同样内容，然后再传一次应当命中秒传。
  const initOwn = await api('/api/uploads', {
    method: 'POST',
    json: {
      parentId: null,
      name: '甲自己的副本.txt',
      size: secret.byteLength,
      sha256: secretHash,
      space: 'shared',
    },
  })
  if (initOwn.status === 200 && !initOwn.body.instant) {
    await api(`/api/uploads/${initOwn.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: secret,
    })
    await api(`/api/uploads/${initOwn.body.uploadId}/complete`, { method: 'POST' })

    const again = await api('/api/uploads', {
      method: 'POST',
      json: {
        parentId: null,
        name: '甲自己的副本-2.txt',
        size: secret.byteLength,
        sha256: secretHash,
        space: 'shared',
      },
    })
    assert(
      again.body.instant === true,
      '反向对照：同一用户在同一空间内仍能正常秒传（功能没被误伤）',
      `instant=${again.body.instant}`,
    )
    if (again.body.uploadId) await api(`/api/uploads/${again.body.uploadId}`, { method: 'DELETE' })
  } else {
    bad('反向对照准备', `无法开启上传：${JSON.stringify(initOwn.body)}`)
  }

  cookie = ownerCookie
  void otherCookie
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
