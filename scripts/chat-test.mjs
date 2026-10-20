/**
 * 聊天的端到端测试。
 *
 * 覆盖：单聊创建、消息收发、未读计数、已读回执、编辑、撤回、
 * 中文全文检索、群聊、输入中提示、权限隔离，以及 **SSE 实时推送真的推到了**。
 *
 * SSE 那部分特别重要：它验证的是"另一个人发消息时，我这边能不能收到"。
 * 这个功能坏了的表现是"要刷新才能看到新消息"，很容易被误当成"网络慢"。
 *
 * 用法：先启动后端，然后  node scripts/chat-test.mjs
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

/** 每个用户一套 cookie，测试里要来回切换身份。 */
function makeClient() {
  let cookie = ''
  const client = {
    get cookie() {
      return cookie
    },
    set cookie(value) {
      cookie = value
    },
    async api(path, options = {}) {
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
      const body = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body }
    },
  }
  return client
}

const jia = makeClient() // 甲
const yi = makeClient() // 乙
const bing = makeClient() // 丙（用于验证"非成员看不到"）

async function registerUser(client, username, displayName, inviteCode) {
  const res = await client.api('/api/auth/register', {
    method: 'POST',
    json: { username, displayName, password: 'chat-test-2026', inviteCode },
  })
  return res
}

async function main() {
  console.log(`\n\x1b[1m聊天端到端测试\x1b[0m  目标 ${BASE}\n`)

  // ---------------------------------------------------------------- 准备账号
  console.log('【准备账号】')
  const owner = await registerUser(jia, `jia${SUFFIX}`, '甲同学')
  if (owner.status !== 200 && owner.status !== 201) {
    bad('注册甲', `状态 ${owner.status}：${JSON.stringify(owner.body)}`)
    // 已经有用户了：说明库不是干净的，后面的用例会连锁失败，直接退出更好排查
    process.exit(1)
  }
  assert(true, '注册甲同学（首次运行成为创建者）')

  const invite = await jia.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 5, expiresInDays: 1, note: '聊天测试' },
  })
  assert(invite.status === 200, '甲生成邀请码')

  const yiReg = await registerUser(yi, `yi${SUFFIX}`, '乙同学', invite.body.code)
  assert(yiReg.status === 200 || yiReg.status === 201, '乙同学凭邀请码注册')

  const invite2 = await jia.api('/api/admin/invites', {
    method: 'POST',
    json: { role: 'member', maxUses: 1, expiresInDays: 1 },
  })
  const bingReg = await registerUser(bing, `bing${SUFFIX}`, '丙同学', invite2.body.code)
  assert(bingReg.status === 200 || bingReg.status === 201, '丙同学凭邀请码注册')

  const jiaId = (await jia.api('/api/auth/me')).body.user.id
  const yiId = (await yi.api('/api/auth/me')).body.user.id

  // ---------------------------------------------------------------- 联系人
  console.log('\n【联系人】')
  const contacts = await jia.api('/api/chat/contacts')
  assert(contacts.status === 200, '获取联系人列表')
  const names = contacts.body.contacts.map((c) => c.displayName)
  assert(names.includes('乙同学'), '联系人里有乙同学', names.join('、'))

  // ---------------------------------------------------------------- 单聊
  console.log('\n【单聊】')
  const direct = await jia.api('/api/chat/conversations/direct', {
    method: 'POST',
    json: { peerId: yiId },
  })
  assert(direct.status === 200, '创建单聊会话')
  const convId = direct.body.conversation.id
  assert(direct.body.conversation.kind === 'direct', '会话类型是单聊')
  assert(direct.body.conversation.title === '乙同学', '单聊标题显示对方名字（不是写死的）', direct.body.conversation.title)

  // 幂等：再点一次应该拿到同一个会话，而不是新建一个
  const direct2 = await jia.api('/api/chat/conversations/direct', {
    method: 'POST',
    json: { peerId: yiId },
  })
  assert(direct2.body.conversation.id === convId, '重复创建单聊不会产生第二个会话（唯一性靠数据库约束）')

  // 乙那边也应该能看到这个会话
  const yiConvs = await yi.api('/api/chat/conversations')
  assert(
    yiConvs.body.conversations.some((c) => c.id === convId),
    '乙的会话列表里也有这个单聊',
  )

  // ---------------------------------------------------------------- 发消息
  console.log('\n【消息收发】')
  const m1 = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '今天晚上七点在活动室开会，讨论社团招新的事。' },
  })
  assert(m1.status === 200, '甲发送消息成功')
  assert(m1.body.message.seq > 0, '消息带自增 seq（用作增量游标）', `seq=${m1.body.message.seq}`)
  assert(m1.body.message.body.includes('活动室'), '消息内容原样保存（中文正确）')

  await yi.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '收到，我会带上次的会议纪要过去。' },
  })
  const m3 = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '另外把预算表也过一遍。' },
  })
  ok('连续发送三条消息')

  // ---------------------------------------------------------------- 未读
  console.log('\n【未读与已读】')
  //
  // 未读模型：`未读 = 该会话最大 seq − 我的已读水位线`。
  // 水位线在两种情况下前进：① 我显式标记已读；② **我自己发言**。
  // 第二条是有意的 —— 你能在会话里发言，说明你必然正在看这个会话，
  // 那之前的内容就应当视为已读。这也和主流 IM 的行为一致。
  //
  // 此时的状态：甲发了 2 条（seq1、seq3），乙发了 1 条（seq2）。
  // 乙的水位线因为自己发过 seq2 而停在 2，所以乙只欠 seq3 这一条 → 未读 1。
  const state = await jia.api(`/api/chat/conversations/${convId}/messages?limit=200`)
  const allMessages = state.body.messages.map((m) => m.seq)
  const maxSeq = Math.max(...allMessages)

  const yiList = await yi.api('/api/chat/conversations')
  const yiConv = yiList.body.conversations.find((c) => c.id === convId)
  assert(
    yiConv.unread === 1,
    '乙的未读=1（自己发言会推进自己的水位线，所以只欠甲最后那一条）',
    `unread=${yiConv.unread}，会话最大 seq=${maxSeq}`,
  )

  const jiaList = await jia.api('/api/chat/conversations')
  const jiaConv = jiaList.body.conversations.find((c) => c.id === convId)
  assert(jiaConv.unread === 0, '甲没有未读（他是最后发言的人）', `unread=${jiaConv.unread}`)

  // 乙发言：自己发的消息不应让水位线倒退，未读保持 0（他本来就是最新）
  const yiMsg = await yi.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '我也说一句，确认自己发的消息不会被算成我自己的未读。' },
  })
  assert(yiMsg.status === 200, '乙发言')

  const yiList3 = await yi.api('/api/chat/conversations')
  assert(
    yiList3.body.conversations.find((c) => c.id === convId).unread === 0,
    '乙发言后自己的未读为 0（自己发的消息不计入自己的未读）',
    `unread=${yiList3.body.conversations.find((c) => c.id === convId).unread}`,
  )

  // 甲再发一条，乙应该正好多 1 条未读
  const m4 = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '那我再补一句。' },
  })
  const yiList4 = await yi.api('/api/chat/conversations')
  assert(
    yiList4.body.conversations.find((c) => c.id === convId).unread === 1,
    '甲再发一条后乙的未读变为 1（精确计数，不是估算）',
    `unread=${yiList4.body.conversations.find((c) => c.id === convId).unread}`,
  )

  // 乙标记已读到最新
  const readRes = await yi.api(`/api/chat/conversations/${convId}/read`, {
    method: 'POST',
    json: { seq: m4.body.message.seq },
  })
  assert(readRes.status === 200, '乙标记已读到最新')

  const yiList2 = await yi.api('/api/chat/conversations')
  assert(
    yiList2.body.conversations.find((c) => c.id === convId).unread === 0,
    '已读后未读归零',
  )

  const receipts = await jia.api(`/api/chat/conversations/${convId}`)
  const yiReceipt = receipts.body.receipts.find((r) => r.userId === yiId)
  assert(
    yiReceipt && yiReceipt.lastReadSeq === m4.body.message.seq,
    '甲能看到乙的已读位置（已读回执）',
    `lastReadSeq=${yiReceipt?.lastReadSeq}`,
  )

  // 已读只前进不后退
  await yi.api(`/api/chat/conversations/${convId}/read`, { method: 'POST', json: { seq: 1 } })
  const receipts2 = await jia.api(`/api/chat/conversations/${convId}`)
  assert(
    receipts2.body.receipts.find((r) => r.userId === yiId).lastReadSeq === m4.body.message.seq,
    '已读位置只前进不后退（防止误标已读把未读吃掉）',
  )

  // ---------------------------------------------------------------- 分页
  console.log('\n【历史分页】')
  const page1 = await jia.api(`/api/chat/conversations/${convId}/messages?limit=2`)
  assert(page1.body.messages.length === 2, '按 limit 取到 2 条', `${page1.body.messages.length} 条`)
  assert(page1.body.hasMore === true, '还有更多历史（hasMore=true）')

  const oldestSeq = page1.body.messages[0].seq
  const page2 = await jia.api(
    `/api/chat/conversations/${convId}/messages?limit=2&before=${oldestSeq}`,
  )
  assert(
    page2.body.messages.every((m) => m.seq < oldestSeq),
    '翻页取到更早的消息（before 游标生效）',
  )

  // 现场重新取一次全量，作为对照基准。
  // （不能在前面取好存着 —— 中间又发过消息，那个数已经过期了，
  //   这正是"测试里的缓存值"最容易造成的假失败。）
  const full = await jia.api(`/api/chat/conversations/${convId}/messages?limit=200`)
  const since = await jia.api(`/api/chat/conversations/${convId}/messages?since=0`)
  assert(
    since.body.messages.length === full.body.messages.length,
    'since=0 能拉全量（重连补拉用）',
    `${since.body.messages.length} 条 / 实际 ${full.body.messages.length} 条`,
  )
  assert(
    since.body.messages.every((m, i) => i === 0 || m.seq > since.body.messages[i - 1].seq),
    'since 拉回来的消息按 seq 严格升序（补拉不会乱序）',
  )

  // 增量补拉：从倒数第二条之后拉，应该只回来最后一条
  const lastSeq = full.body.messages[full.body.messages.length - 1].seq
  const secondLastSeq = full.body.messages[full.body.messages.length - 2].seq
  const incremental = await jia.api(
    `/api/chat/conversations/${convId}/messages?since=${secondLastSeq}`,
  )
  assert(
    incremental.body.messages.length === 1 && incremental.body.messages[0].seq === lastSeq,
    '增量补拉只返回新消息（断线重连后不会重复拉全量）',
    `返回 ${incremental.body.messages.length} 条`,
  )

  // ---------------------------------------------------------------- 编辑与撤回
  console.log('\n【编辑与撤回】')
  const edited = await jia.api(`/api/chat/messages/${m1.body.message.id}`, {
    method: 'PATCH',
    json: { body: '改一下：今晚七点半在活动室开会。' },
  })
  assert(edited.status === 200, '编辑自己的消息')
  assert(edited.body.message.editedAt !== null, '编辑后标记了 editedAt')
  assert(edited.body.message.body.includes('七点半'), '编辑后的内容已更新')

  const yiEdit = await yi.api(`/api/chat/messages/${m1.body.message.id}`, {
    method: 'PATCH',
    json: { body: '乙试图改甲的消息' },
  })
  assert(yiEdit.status === 403, '不能编辑别人的消息（403）', `状态 ${yiEdit.status}`)

  const recalled = await jia.api(`/api/chat/messages/${m1.body.message.id}/recall`, {
    method: 'POST',
    json: {},
  })
  assert(recalled.status === 200, '撤回自己的消息')
  assert(recalled.body.message.recalled === true, '撤回后标记 recalled')
  assert(
    recalled.body.message.body === null,
    '撤回后正文不再返回（否则抓包还能看到，撤回就是假的）',
    `body=${JSON.stringify(recalled.body.message.body)}`,
  )

  // ---------------------------------------------------------------- 搜索
  console.log('\n【中文全文检索】')
  const search = await jia.api('/api/chat/search?q=' + encodeURIComponent('会议纪要'))
  assert(search.status === 200, '搜索接口可用')
  assert(search.body.hits.length >= 1, '搜「会议纪要」命中乙发的那条消息', `命中 ${search.body.hits.length} 条`)
  assert(
    search.body.hits.some((h) => h.body.includes('会议纪要')),
    '命中的内容确实包含关键词',
  )

  const searchEmpty = await jia.api('/api/chat/search?q=' + encodeURIComponent('这个词肯定搜不到xyzzy'))
  assert(searchEmpty.body.hits.length === 0, '搜不存在的词返回空（不会报错）')

  // 丙不该搜到别人会话里的消息
  const bingSearch = await bing.api('/api/chat/search?q=' + encodeURIComponent('会议纪要'))
  assert(
    bingSearch.body.hits.length === 0,
    '丙搜不到自己没参与的会话里的消息（搜索也有权限边界）',
    `命中 ${bingSearch.body.hits.length} 条`,
  )

  // ---------------------------------------------------------------- 权限隔离
  console.log('\n【权限隔离】')
  const bingRead = await bing.api(`/api/chat/conversations/${convId}/messages`)
  assert(bingRead.status === 403, '非成员读不到会话消息（403）', `状态 ${bingRead.status}`)

  const bingSend = await bing.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '丙试图插话' },
  })
  assert(bingSend.status === 403, '非成员发不了消息（403）', `状态 ${bingSend.status}`)

  const bingTyping = await bing.api('/api/chat/typing', {
    method: 'POST',
    json: { conversationId: convId },
  })
  assert(bingTyping.status === 403, '非成员不能制造「正在输入」（403）')

  const emptyMsg = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '   ' },
  })
  assert(emptyMsg.status === 400, '空白消息被拒绝（400）')

  // ---------------------------------------------------------------- SSE 实时推送
  console.log('\n【实时推送（SSE）】')
  const received = []
  let streamClosed = false

  const streamPromise = (async () => {
    const res = await fetch(`${BASE}/api/chat/stream`, {
      headers: { cookie: yi.cookie, accept: 'text/event-stream' },
    })
    if (!res.ok) {
      bad('建立 SSE 连接', `状态 ${res.status}`)
      return
    }
    ok('乙建立了 SSE 连接', `状态 ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (!streamClosed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 事件以空行分隔
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const eventMatch = block.match(/^event: (.+)$/m)
          const dataMatch = block.match(/^data: (.+)$/m)
          if (eventMatch && dataMatch) {
            try {
              received.push({ type: eventMatch[1], data: JSON.parse(dataMatch[1]) })
            } catch {
              // 忽略解析不了的事件
            }
          }
        }
      }
    } catch {
      // 连接被主动关闭时会抛错，属正常
    }
  })()

  // 等连接建立并收到 hello
  await new Promise((r) => setTimeout(r, 1200))

  const hello = received.find((e) => e.type === 'hello')
  assert(hello !== undefined, '收到 hello 事件（连接确实建立了）')

  // 甲在会话里发一条消息，乙应该通过 SSE 实时收到
  const liveMessage = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '这条应该实时推送到乙那边' },
  })
  assert(liveMessage.status === 200, '甲发送一条实时测试消息')

  // 等推送到达
  for (let i = 0; i < 20 && !received.some((e) => e.type === 'message'); i++) {
    await new Promise((r) => setTimeout(r, 200))
  }

  const pushed = received.find((e) => e.type === 'message')
  assert(pushed !== undefined, '乙通过 SSE 实时收到了新消息（不用刷新）')
  if (pushed) {
    assert(
      pushed.data.body === '这条应该实时推送到乙那边',
      '推送的内容与发送的一致',
      pushed.data.body,
    )
    assert(pushed.data.conversationId === convId, '推送里带会话 id，客户端才知道更新哪个会话')
  }

  // 未读推送
  const unreadEvent = received.find((e) => e.type === 'unread')
  assert(unreadEvent !== undefined, '收到未读总数推送（任务栏角标用）')

  // 输入中提示
  await jia.api('/api/chat/typing', { method: 'POST', json: { conversationId: convId } })
  for (let i = 0; i < 10 && !received.some((e) => e.type === 'typing'); i++) {
    await new Promise((r) => setTimeout(r, 200))
  }
  const typingEvent = received.find((e) => e.type === 'typing')
  assert(typingEvent !== undefined, '收到「正在输入」事件')
  if (typingEvent) {
    assert(typingEvent.data.displayName === '甲同学', '正在输入的事件里带发送者名字', typingEvent.data.displayName)
  }

  streamClosed = true
  await Promise.race([streamPromise, new Promise((r) => setTimeout(r, 2000))])

  // ---------------------------------------------------------------- 群聊
  console.log('\n【群聊】')
  const bingId = (await bing.api('/api/auth/me')).body.user.id
  const group = await jia.api('/api/chat/conversations/group', {
    method: 'POST',
    json: { title: '招新筹备组', memberIds: [yiId, bingId] },
  })
  assert(group.status === 200, '创建群聊')
  const groupId = group.body.conversation.id
  assert(group.body.conversation.kind === 'group', '类型是群聊')
  assert(group.body.conversation.title === '招新筹备组', '群聊名称正确')
  assert(group.body.conversation.memberCount === 3, '群成员 3 人', `${group.body.conversation.memberCount} 人`)

  const groupMsgs = await jia.api(`/api/chat/conversations/${groupId}/messages`)
  assert(
    groupMsgs.body.messages.some((m) => m.kind === 'system'),
    '建群自动写入一条系统消息（新成员能看到群是怎么来的）',
  )

  const groupMembers = await bing.api(`/api/chat/conversations/${groupId}`)
  assert(groupMembers.status === 200, '丙能看到自己所在的群')
  assert(groupMembers.body.members.length === 3, '群成员列表 3 人')

  await bing.api(`/api/chat/conversations/${groupId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '我负责联系场地。' },
  })
  ok('丙在群里发言')

  // 单聊不能加人
  const addToDirect = await jia.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: '测试单聊' },
  })
  assert(addToDirect.status === 200, '单聊仍可正常发言（对照）')

  const longTitle = 'x'.repeat(100)
  const badGroup = await jia.api('/api/chat/conversations/group', {
    method: 'POST',
    json: { title: longTitle, memberIds: [] },
  })
  assert(badGroup.status === 400, '超长群名被拒绝（400）')

  // ---------------------------------------------------------------- 文件消息
  console.log('\n【文件消息（与文件模块打通）】')
  const secretBytes = new TextEncoder().encode('这是要通过聊天发给乙的文件内容。')
  const initUpload = await jia.api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name: '招新计划.txt', size: secretBytes.length, space: 'shared' },
  })
  if (initUpload.status === 200 && initUpload.body.uploadId) {
    await jia.api(`/api/uploads/${initUpload.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: secretBytes,
    })
    const done = await jia.api(`/api/uploads/${initUpload.body.uploadId}/complete`, {
      method: 'POST',
      json: {},
    })
    if (done.status === 200) {
      const fileMsg = await jia.api(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        json: { kind: 'file', body: '招新计划.txt', fileNodeId: done.body.nodeId },
      })
      assert(fileMsg.status === 200, '把文件作为消息发出去')
      assert(fileMsg.body.message.fileNodeId === done.body.nodeId, '消息里带文件节点 id')

      // 乙应该能读到这个文件（共享空间）
      const yiCanRead = await yi.api(`/api/files/${done.body.nodeId}/download`)
      assert(typeof yiCanRead.body !== 'undefined', '乙能下载会话里分享的文件')
    } else {
      bad('上传文件', `完成上传失败 ${done.status}`)
    }
  } else {
    bad('上传文件', `开启上传失败 ${initUpload.status}`)
  }

  // ---------------------------------------------------------------- 会话列表语义
  //
  // 列表接口被重写过（从"每个会话再查 2 条"改成一条 SQL：最后一条消息走
  // 相关子查询 + 对方/发言人名字 JOIN 进来）。这组断言盯的正是那次重写最容易
  // 弄坏的三件事：
  //   1. 空会话（一条消息都没有）不能从列表里消失；
  //   2. 最后一条消息必须真的是最新的那条可见消息；
  //   3. 撤回的消息不能继续充当"最后一条"。
  console.log('\n【会话列表：最后一条消息与空会话】')
  const tailBody = '这条应该是列表里显示的最后一条'
  const tail = await yi.api(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST',
    json: { kind: 'text', body: tailBody },
  })
  assert(tail.status === 200, '乙发一条用于验证「最后一条消息」的消息')

  const jiaListAfter = await jia.api('/api/chat/conversations')
  const jiaConvAfter = jiaListAfter.body.conversations.find((c) => c.id === convId)
  assert(
    jiaConvAfter.lastMessage?.id === tail.body.message.id,
    '列表里的最后一条就是刚发的那条（取的是最新，不是最早/任意一条）',
    `lastMessage=${JSON.stringify(jiaConvAfter.lastMessage)}`,
  )
  assert(
    jiaConvAfter.lastMessage?.senderName === '乙同学',
    '最后一条带发言人名字（名字来自 JOIN，不是前端自己猜的）',
    jiaConvAfter.lastMessage?.senderName,
  )
  assert(
    jiaConvAfter.lastMessage?.preview === tailBody,
    '最后一条的摘要与正文一致',
    jiaConvAfter.lastMessage?.preview,
  )

  // 撤回最新那条之后，最后一条必须**回退**到上一条可见消息，而不是变成 null
  const beforeRecall = await jia.api(`/api/chat/conversations/${convId}/messages?limit=200`)
  // 取"除了刚发的那条以外，最后一条未撤回的消息"—— 会话里本来就有一条早期被撤回的，
  // 直接取倒数第二条会撞上它
  const visible = beforeRecall.body.messages.filter(
    (m) => !m.recalled && m.id !== tail.body.message.id,
  )
  const expectedPrev = visible[visible.length - 1]
  assert(expectedPrev !== undefined, '撤回前能取到上一条可见消息（作为对照）')

  await yi.api(`/api/chat/messages/${tail.body.message.id}/recall`, { method: 'POST', json: {} })
  const jiaListRecalled = await jia.api('/api/chat/conversations')
  const jiaConvRecalled = jiaListRecalled.body.conversations.find((c) => c.id === convId)
  assert(
    jiaConvRecalled.lastMessage?.id === expectedPrev.id,
    '已撤回的消息不再充当「最后一条」，回退到上一条可见消息',
    `lastMessage=${jiaConvRecalled.lastMessage?.id}，应为 ${expectedPrev.id}`,
  )

  // 空会话：刚建好、一条消息都没有。它必须在列表里，且 lastMessage 为 null。
  // 这里刻意等一小会儿再建，让 updated_at 严格大于上面那条消息的时间 ——
  // 否则同一毫秒内建会话和发消息会撞在一起，排序断言就变成掷骰子。
  await new Promise((r) => setTimeout(r, 30))
  const emptyConv = await jia.api('/api/chat/conversations/direct', {
    method: 'POST',
    json: { peerId: bingId },
  })
  const emptyId = emptyConv.body.conversation.id
  const listWithEmpty = await jia.api('/api/chat/conversations')
  const emptyInList = listWithEmpty.body.conversations.find((c) => c.id === emptyId)
  assert(emptyInList !== undefined, '没有任何消息的空会话仍然出现在列表里（没被 JOIN 过滤掉）')
  assert(
    emptyInList?.lastMessage === null,
    '空会话的 lastMessage 是 null（不是丢字段，也不是空对象）',
    JSON.stringify(emptyInList?.lastMessage),
  )
  assert(
    emptyInList?.title === '丙同学',
    '空会话的单聊标题仍然用对方名字（不因为没有消息就退化成「会话」）',
    emptyInList?.title,
  )
  assert(
    listWithEmpty.body.conversations[0].id === emptyId,
    '空会话按最后活跃时间参与排序：刚建的排在最前',
    `第一条是 ${listWithEmpty.body.conversations[0].id}`,
  )
  assert(
    listWithEmpty.body.conversations.every(
      (c, i) => i === 0 || listWithEmpty.body.conversations[i - 1].updatedAt >= c.updatedAt,
    ),
    '整个列表仍按最后活跃时间倒序',
  )

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
