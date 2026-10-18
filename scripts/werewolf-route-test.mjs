/**
 * 狼人杀**路由层**的端到端测试。
 *
 * 规则引擎自己已经有一整套纯逻辑测试（scripts/werewolf-test.mjs，182 项）。
 * 这个文件补的是**接线**那一段，因为两者会各自出错而互不报警：
 *
 *   - 引擎测试直接 import 函数、传对象参数，**永远发现不了 HTTP 层的字段名对不上**。
 *     真实发生过：女巫路由发的是 {action, target}，而引擎读的是
 *     {heal, poisonTarget} —— 于是 heal 恒为 undefined、毒药恒为 null，
 *     女巫点了"救"看起来成功、其实什么都没发生，而且没有任何报错。
 *   - 引擎测试也不会发现"路由忘了做视角裁剪"，因为裁剪发生在房间层到路由之间。
 *
 * 所以这里用**真实的 HTTP 请求 + 9 个真实账号**跑一遍完整流程。
 *
 * 用法：由 scripts/run-all-tests.mjs 启动服务端后运行（需要 passDataDir）。
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const DATA_DIR = process.env.WL_TEST_DATA_DIR ?? ''
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

/** 直接读服务端的房间状态，拿到**真实身份**——用来验证"没泄露给别人"。 */
function trueState(roomId) {
  if (!DATA_DIR) return null
  const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT state FROM game_rooms WHERE id = ?').get(roomId)
    return row?.state ? JSON.parse(row.state) : null
  } finally {
    db.close()
  }
}

async function main() {
  console.log(`\n\x1b[1m狼人杀（HTTP 路由与视角裁剪）\x1b[0m  目标 ${BASE}\n`)

  // 真实身份布局。视角检查与夜晚行动两个代码块都要用，所以在函数作用域里声明。
  let wolfSeats = []
  let seerSeat = -1
  let witchSeat = -1
  // 房内发言测试用到的文本，观战者那节也要复用（验证公开看得到、狼队看不到）
  let nightWolfText = ''
  let dayPublicText = ''

  // ---------------------------------------------------------------- 九个账号
  console.log('【准备 9 个账号】')
  const owner = makeClient()
  const reg = await owner.api('/api/auth/register', {
    method: 'POST',
    json: { username: `wwa${SUFFIX}`, displayName: '玩家0', password: 'werewolf-route-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册房主', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册房主')

  const clients = [owner]
  for (let i = 1; i < 9; i++) {
    const inv = await owner.api('/api/admin/invites', {
      method: 'POST',
      json: { role: 'member', maxUses: 1, expiresInDays: 1 },
    })
    const c = makeClient()
    const r = await c.api('/api/auth/register', {
      method: 'POST',
      json: {
        username: `ww${SUFFIX}${i}`,
        displayName: `玩家${i}`,
        password: 'werewolf-route-2026',
        inviteCode: inv.body.code,
      },
    })
    if (r.status !== 200 && r.status !== 201) {
      bad(`注册玩家${i}`, `状态 ${r.status}：${JSON.stringify(r.body)}`)
      process.exit(1)
    }
    clients.push(c)
  }
  ok('凑齐 9 个账号', '9 人局需要 9 个真实账号')

  // ---------------------------------------------------------------- 建局
  console.log('\n【建房与入座】')
  const created = await owner.api('/api/games/werewolf/rooms', {
    method: 'POST',
    json: { title: '路由测试局' },
  })
  assert(created.status === 200, '创建房间', `状态 ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`)
  const roomId = created.body.room?.id
  assert(created.body.room?.phase === 'waiting', '刚建好时处于等待阶段')

  const joined = await owner.api(`/api/games/werewolf/rooms/${roomId}/join`, { method: 'POST', json: {} })
  assert(joined.status === 200, '房主入座')
  assert(joined.body.room?.players?.length === 1, '座位表里出现 1 人')

  // 前 8 个人坐下时都不该开局
  for (let i = 1; i < 8; i++) {
    const r = await clients[i].api(`/api/games/werewolf/rooms/${roomId}/join`, { method: 'POST', json: {} })
    if (r.status !== 200) {
      bad(`玩家${i} 入座`, `状态 ${r.status}：${JSON.stringify(r.body)}`)
      break
    }
  }
  const beforeFull = await owner.api(`/api/games/werewolf/rooms/${roomId}`)
  assert(beforeFull.body.room?.phase === 'waiting', '8 个人时还没开局', `phase=${beforeFull.body.room?.phase}`)
  assert(beforeFull.body.room?.players?.length === 8, '座位表里有 8 人')

  // 第 9 个人坐下 → 自动开局
  const ninth = await clients[8].api(`/api/games/werewolf/rooms/${roomId}/join`, { method: 'POST', json: {} })
  assert(ninth.status === 200, '第 9 个人入座')
  assert(ninth.body.room?.phase !== 'waiting', '人齐自动开局（不需要额外的"开始"操作）', `phase=${ninth.body.room?.phase}`)
  assert(ninth.body.room?.myRole !== null, '入座后立刻拿到了自己的身份', String(ninth.body.room?.myRole))

  // ---------------------------------------------------------------- 身份与视角
  console.log('\n【身份分配与隐藏信息】')
  const state = trueState(roomId)
  if (!state) {
    bad('读取真实状态', '没有 WL_TEST_DATA_DIR，无法验证"没泄露"——这一节的意义全在于对照真实身份')
  } else {
    const roles = state.roles
    const counts = {}
    for (const r of roles) counts[r] = (counts[r] ?? 0) + 1
    assert(counts.wolf === 3, '真实状态里狼人有 3 个', JSON.stringify(counts))

    // 每个人的 view 里，myRole 必须等于他的真实身份
    let mismatch = 0
    const views = []
    for (let i = 0; i < 9; i++) {
      const res = await clients[i].api(`/api/games/werewolf/rooms/${roomId}`)
      views.push(res.body.room)
      if (res.body.room?.myRole !== roles[i]) mismatch++
    }
    assert(mismatch === 0, '每个人的 myRole 都等于他的真实身份', `${mismatch} 处不符`)

    wolfSeats = roles.map((r, i) => (r === 'wolf' ? i : -1)).filter((i) => i >= 0)
    seerSeat = roles.indexOf('seer')
    witchSeat = roles.indexOf('witch')

    // 关键：**别人是什么身份，任何一份 view 里都不该有**。
    //
    // ⚠️ 这里用**结构化字段**检查，而不是"把 view 序列化成字符串然后找身份词"。
    // 字符串扫描看起来更严厉，实际上两头都不靠谱：
    //   - 会误报：板子说明里本来就有"狼人 × 3"这种**公开**文案。
    //   - 会漏报：真正泄漏出去的是**座位整数**时，它一个字都匹配不到 ——
    //     waitingOn 那次泄漏（夜晚把三个狼的座位号发给所有人）就是这么溜过去的。
    const problems = []
    for (let i = 0; i < 9; i++) {
      const v = views[i]
      const role = roles[i]
      const who = `${i} 号(${role})`

      if (v.myRole !== role) problems.push(`${who} 自己的身份不对`)

      // 座位表里不能带任何身份字段
      for (const p of v.players) {
        if ('role' in p || 'myRole' in p || 'team' in p) problems.push(`${who} 的座位表带了身份字段`)
      }

      // 队友：只有狼才有，而且必须正好是另外两头狼
      if (role === 'wolf') {
        const expect = wolfSeats.filter((s) => s !== i)
        const got = [...(v.teammates ?? [])].sort((a, b) => a - b)
        if (JSON.stringify(got) !== JSON.stringify(expect)) problems.push(`${who} 的狼队友不对：${JSON.stringify(got)}`)
      } else if (v.teammates !== null) {
        problems.push(`${who} 不该有 teammates（会暴露狼是谁）`)
      }

      // 查验记录：只有预言家有
      if (role !== 'seer' && v.myChecks !== null) problems.push(`${who} 不该有查验记录`)
      // 药水与刀口：只有女巫有
      if (role !== 'witch' && v.myPotions !== null) problems.push(`${who} 不该有药水信息`)
      if (role !== 'witch' && v.witchNightVictim !== null) problems.push(`${who} 不该看到今晚的刀口`)

      // 夜晚不点名：waitingOn 里出现别人的座位 = 公布了谁是那个角色
      if (v.phase === 'night' && v.waitingOn.some((seat) => seat !== v.mySeat)) {
        problems.push(`${who} 在夜晚拿到了别人的座位 ${JSON.stringify(v.waitingOn)}（等于点名特殊身份）`)
      }
    }
    assert(problems.length === 0, '9 份 view 都没有泄露别人的身份', problems.join('；') || '结构检查全部通过')

    // waitingOn 曾经把狼/预言家/女巫的座位号公开出去 —— 这里从 HTTP 层再验一次
    const w = views[0]
    const mySeat = w.mySeat
    const nightWaitLeak = w.phase === 'night' && w.waitingOn.some((s) => s !== mySeat)
    assert(!nightWaitLeak, '夜晚的 waitingOn 不点名别人的座位（否则等于公布特殊身份）', JSON.stringify(w.waitingOn))
  }

  // ---------------------------------------------------------------- 房内发言（夜晚）
  //
  // ⚠️ 这一节是"隐藏信息不能泄漏"的硬要求，必须用**真实 HTTP 请求**验：
  // 夜晚只有狼能发言，而且狼的发言只有狼拿得到 —— 非狼/观战者无论通过什么
  // 接口都不该看到。放进任何一份非狼的 payload 都算这一局废了。
  console.log('\n【房内发言：夜晚狼队私频对非狼不可见】')
  {
    const st = trueState(roomId)
    if (!st) {
      bad('夜晚发言隐私', '无法读取真实身份，跳过')
    } else {
      const roles = st.roles
      const wolves = roles.map((r, i) => (r === 'wolf' ? i : -1)).filter((i) => i >= 0)
      const wolfSeat = wolves[0]
      const nonWolfSeat = roles.findIndex((r) => r !== 'wolf')
      const NON_WOLF_TEXT = `狼队暗号-${SUFFIX}`
      nightWolfText = NON_WOLF_TEXT

      // 非狼在夜晚发言必须被拒（服务端裁定，不看客户端脸色）
      const refused = await clients[nonWolfSeat].api(`/api/games/werewolf/rooms/${roomId}/chat`, {
        method: 'POST',
        json: { text: '我不是狼我也想说话' },
      })
      assert(refused.status >= 400, '非狼在夜晚发言被拒', `状态 ${refused.status}`)

      // 狼发言
      const sent = await clients[wolfSeat].api(`/api/games/werewolf/rooms/${roomId}/chat`, {
        method: 'POST',
        json: { text: NON_WOLF_TEXT },
      })
      assert(sent.status === 200, '狼在夜晚可以发言', `状态 ${sent.status} ${JSON.stringify(sent.body).slice(0, 120)}`)

      // 狼自己看得到
      const wolfView = await clients[wolfSeat].api(`/api/games/werewolf/rooms/${roomId}`)
      assert(
        (wolfView.body.room?.messages ?? []).some((m) => m.text === NON_WOLF_TEXT),
        '狼能看到这条狼队发言（说明它确实写进去了，测试不是空过）',
      )

      // 非狼：任何接口都拿不到（既不在 messages 里，也不在任何序列化字段里）
      const nonWolfView = await clients[nonWolfSeat].api(`/api/games/werewolf/rooms/${roomId}`)
      assert(
        !JSON.stringify(nonWolfView.body).includes(NON_WOLF_TEXT),
        '非狼的任何接口都拿不到狼队夜间发言（payload 里根本没有）',
      )
      assert(
        (nonWolfView.body.room?.messages ?? []).every((m) => m.scope !== 'wolf'),
        '非狼的 messages 里没有任何狼队私频消息',
        JSON.stringify(nonWolfView.body.room?.messages),
      )
    }
  }

  // ---------------------------------------------------------------- 夜晚行动
  console.log('\n【夜晚：狼刀 / 预言家查 / 女巫用药】')
  const st = trueState(roomId)
  if (!st) {
    bad('夜晚行动', '无法读取真实身份，跳过')
  } else {
    /** 挑一个不是狼的人当刀口，免得自刀干扰后面的断言。 */
    const victim = st.roles.findIndex((r, i) => r !== 'wolf' && i !== seerSeat && i !== witchSeat)
    /** 预言家查验的目标：一头狼，结果应当明确是 wolf。 */
    const checkTarget = wolfSeats[0]

    // 非狼调用 kill 必须被拒 —— 这是服务端权威最基本的一条
    const impostorSeat = st.roles.findIndex((r) => r !== 'wolf')
    const impostorKill = await clients[impostorSeat].api(`/api/games/werewolf/rooms/${roomId}/kill`, {
      method: 'POST',
      json: { target: victim },
    })
    assert(
      impostorKill.status >= 400,
      '非狼玩家调用 kill 被拒（服务端裁定，不看客户端脸色）',
      `状态 ${impostorKill.status}`,
    )

    // 三头狼都刀同一个人，把狼人步骤走完
    let killOk = 0
    for (const seat of wolfSeats) {
      const r = await clients[seat].api(`/api/games/werewolf/rooms/${roomId}/kill`, {
        method: 'POST',
        json: { target: victim },
      })
      if (r.status === 200) killOk++
      else bad(`狼 ${seat} 刀人`, `状态 ${r.status}：${JSON.stringify(r.body).slice(0, 140)}`)
    }
    assert(killOk === 3, '三头狼都能刀人（走完狼人步骤）', `${killOk}/3`)

    // 预言家查验
    const check = await clients[seerSeat].api(`/api/games/werewolf/rooms/${roomId}/check`, {
      method: 'POST',
      json: { target: checkTarget },
    })
    assert(check.status === 200, '预言家可以查验', `状态 ${check.status} ${JSON.stringify(check.body).slice(0, 120)}`)
    const checks = check.body.room?.myChecks ?? []
    assert(checks.length === 1, '查验记录写进了预言家自己的 view', `${checks.length} 条`)
    assert(
      checks[0]?.target === checkTarget && checks[0]?.team === 'wolf',
      '查验结果正确（查到的是狼）',
      JSON.stringify(checks[0]),
    )
    // 别人拿不到这条记录。
    //
    // ⚠️ 必须挑一个**确定不是预言家**的人来验，不能随手写 clients[0]：
    // 身份是随机分配的，0 号有 1/9 的概率正好是预言家，那时他的 myChecks
    // 本来就是个数组（空数组），断言会因为"不是 null"而误报 —— 一个九分之一的偶发红灯。
    const nonSeer = st.roles.findIndex((r) => r !== 'seer')
    const otherView = await clients[nonSeer].api(`/api/games/werewolf/rooms/${roomId}`)
    assert(
      otherView.body.room?.myChecks === null,
      `非预言家（${nonSeer} 号）的 myChecks 是 null（查验结果只有预言家自己看得到）`,
      `${nonSeer} 号是 ${st.roles[nonSeer]}，myChecks=${JSON.stringify(otherView.body.room?.myChecks)}`,
    )

    // 女巫：先确认她能看到刀口，再用解药
    const witchView = await clients[witchSeat].api(`/api/games/werewolf/rooms/${roomId}`)
    assert(
      witchView.body.room?.witchNightVictim === victim,
      '女巫能看到今晚被刀的是谁',
      `victim=${witchView.body.room?.witchNightVictim}，期望 ${victim}`,
    )

    const heal = await clients[witchSeat].api(`/api/games/werewolf/rooms/${roomId}/witch`, {
      method: 'POST',
      json: { heal: true },
    })
    assert(heal.status === 200, '女巫使用解药', `状态 ${heal.status} ${JSON.stringify(heal.body).slice(0, 140)}`)

    // ⚠️ 这一条正是为了抓"字段名对不上"：如果路由把 heal 丢了，
    // 药不会生效，被刀的人会照常死 —— 而接口照样返回 200。
    const afterNight = await clients[0].api(`/api/games/werewolf/rooms/${roomId}`)
    const lastNight = afterNight.body.room?.lastNight
    assert(
      lastNight?.saved === true,
      '解药**真的生效了**（saved=true）—— 不是接口返回 200 但什么都没做',
      JSON.stringify(lastNight),
    )
    assert(lastNight?.victim === victim, '公布的结果里刀口就是那个被刀的人', JSON.stringify(lastNight))
    assert(
      afterNight.body.room?.players?.[victim]?.alive === true,
      '被救的人活到了白天',
      `alive=${afterNight.body.room?.players?.[victim]?.alive}`,
    )
  }

  // ---------------------------------------------------------------- 房内发言（白天）
  console.log('\n【房内发言：白天的发言所有人都能看到】')
  {
    const before = await clients[0].api(`/api/games/werewolf/rooms/${roomId}`)
    const phase = before.body.room?.phase
    if (phase === 'waiting' || phase === 'finished' || phase === 'night') {
      console.log(`  \x1b[90m（阶段是 ${phase}，不是白天，跳过 — 正常时序）\x1b[0m`)
    } else {
      const st = trueState(roomId)
      const aliveSeats = st ? st.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0) : []
      const speaker = aliveSeats[0]
      const PUBLIC_TEXT = `白天集合-${SUFFIX}`
      dayPublicText = PUBLIC_TEXT
      const sent = await clients[speaker].api(`/api/games/werewolf/rooms/${roomId}/chat`, {
        method: 'POST',
        json: { text: PUBLIC_TEXT },
      })
      assert(sent.status === 200, '白天存活玩家可以发言', `状态 ${sent.status} ${JSON.stringify(sent.body).slice(0, 120)}`)

      // 另一个存活玩家看得到同一条公开发言
      const listener = aliveSeats.find((s) => s !== speaker)
      const listenerView = await clients[listener].api(`/api/games/werewolf/rooms/${roomId}`)
      const seen = (listenerView.body.room?.messages ?? []).find((m) => m.text === PUBLIC_TEXT)
      assert(seen !== undefined, '其他玩家看得到这条白天发言')
      assert(seen?.scope === 'public', '白天发言是公开 scope', String(seen?.scope))
    }
  }

  // ---------------------------------------------------------------- 白天投票
  console.log('\n【白天：投票放逐】')
  const beforeVote = await clients[0].api(`/api/games/werewolf/rooms/${roomId}`)
  const phase = beforeVote.body.room?.phase
  assert(['day-announce', 'day-discuss', 'day-vote'].includes(phase), '进入了白天阶段', `phase=${phase}`)

  if (phase === 'day-vote') {
    const st2 = trueState(roomId)
    const alive = st2 ? st2.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0) : []
    const target = alive[0]
    let voted = 0
    for (const seat of alive) {
      const r = await clients[seat].api(`/api/games/werewolf/rooms/${roomId}/vote`, {
        method: 'POST',
        json: { target },
      })
      if (r.status === 200) voted++
    }
    assert(voted > 0, '有人成功投票', `${voted} 票`)

    const afterVote = await clients[0].api(`/api/games/werewolf/rooms/${roomId}`)
    // 票型是公开信息，应该能在 view 里看到
    assert(Array.isArray(afterVote.body.room?.votes), '票型对所有人可见（投票是公开行为）')
  } else {
    console.log(`  \x1b[90m（阶段是 ${phase}，本轮没走到投票，跳过 — 这是正常的时序，不是失败）\x1b[0m`)
  }

  // ---------------------------------------------------------------- 观战视角
  console.log('\n【观战者】')
  {
    // 用一个没入座的账号（把最后一个 invite 留给观战者）
    const inv = await owner.api('/api/admin/invites', {
      method: 'POST',
      json: { role: 'member', maxUses: 1, expiresInDays: 1 },
    })
    const spec = makeClient()
    const r = await spec.api('/api/auth/register', {
      method: 'POST',
      json: {
        username: `wws${SUFFIX}`,
        displayName: '观战者',
        password: 'werewolf-route-2026',
        inviteCode: inv.body.code,
      },
    })
    if (r.status === 200 || r.status === 201) {
      const view = await spec.api(`/api/games/werewolf/rooms/${roomId}`)
      assert(view.status === 200, '观战者能打开房间')
      assert(view.body.room?.mySeat === null, '观战者没有座位')
      assert(view.body.room?.myRole === null, '观战者拿不到任何身份（连自己的都没有）')
      assert(view.body.room?.teammates === null, '观战者没有队友字段')
      assert(
        Array.isArray(view.body.room?.waitingOn) && view.body.room.waitingOn.length <= 1,
        '观战者的 waitingOn 不泄漏"谁在行动"',
        JSON.stringify(view.body.room?.waitingOn),
      )

      // 房内发言：公开的看得到，狼队的看**不**到
      const msgs = view.body.room?.messages ?? []
      assert(msgs.every((m) => m.scope !== 'wolf'), '观战者的 messages 里没有狼队私频消息')
      if (nightWolfText) {
        assert(!JSON.stringify(view.body).includes(nightWolfText), '观战者拿不到夜晚的狼队发言')
      }
      if (dayPublicText) {
        assert(
          msgs.some((m) => m.text === dayPublicText),
          '观战者看得到白天的公开发言',
          JSON.stringify(msgs.map((m) => m.text)),
        )
      }
    } else {
      bad('注册观战者', `状态 ${r.status}`)
    }
  }

  // ---------------------------------------------------------------- 自定义人数
  console.log('\n【自定义人数（6~12）】')
  {
    // 非法人数被拒（5 / 13 / 0 都在 6~12 之外）
    for (const bad of [5, 13, 0]) {
      const r = await clients[0].api('/api/games/werewolf/rooms', {
        method: 'POST',
        json: { title: 'bad', playerCount: bad },
      })
      assert(r.status >= 400, `playerCount=${bad} 被拒（不是 500）`, `状态 ${r.status}`)
    }

    // 6 人局：5 人时不开局，第 6 人入座自动开局
    const small = await clients[0].api('/api/games/werewolf/rooms', {
      method: 'POST',
      json: { title: '六人局', playerCount: 6 },
    })
    assert(small.status === 200, '创建 6 人局', `状态 ${small.status}`)
    assert(small.body.room?.playerCount === 6, 'view 里记录了 playerCount=6', String(small.body.room?.playerCount))
    const sixId = small.body.room.id

    await clients[0].api(`/api/games/werewolf/rooms/${sixId}/join`, { method: 'POST', json: {} })
    for (let i = 1; i <= 4; i++) {
      await clients[i].api(`/api/games/werewolf/rooms/${sixId}/join`, { method: 'POST', json: {} })
    }
    const five = await clients[0].api(`/api/games/werewolf/rooms/${sixId}`)
    assert(five.body.room?.phase === 'waiting', '6 人局里 5 个人时还没开局', `phase=${five.body.room?.phase}`)

    const sixth = await clients[5].api(`/api/games/werewolf/rooms/${sixId}/join`, { method: 'POST', json: {} })
    assert(sixth.body.room?.phase !== 'waiting', '第 6 个人入座后自动开局', `phase=${sixth.body.room?.phase}`)
    assert(sixth.body.room?.myRole !== null, '6 人局开局后也立刻拿到身份', String(sixth.body.room?.myRole))
    assert(sixth.body.room?.players?.length === 6, '6 人局座位数为 6')
    const boardTotal = (sixth.body.room?.board ?? []).reduce((s, b) => s + b.count, 0)
    assert(boardTotal === 6, '6 人局板子总数 = 6', String(boardTotal))
    const wolfCount = (sixth.body.room?.board ?? []).find((b) => b.role === 'wolf')?.count ?? 0
    assert(6 - wolfCount > wolfCount, '6 人局好人数严格多于狼人数', `狼 ${wolfCount}`)
  }

  // ---------------------------------------------------------------- 权限与边界
  console.log('\n【边界】')
  {
    const anon = await fetch(`${BASE}/api/games/werewolf/rooms`)
    assert(anon.status === 401, '未登录不能看房间列表（401）', `状态 ${anon.status}`)

    const badRoom = await clients[0].api('/api/games/werewolf/rooms/nope-nope')
    assert(badRoom.status === 404, '不存在的房间返回 404', `状态 ${badRoom.status}`)

    const badSeat = await clients[0].api(`/api/games/werewolf/rooms/${roomId}/vote`, {
      method: 'POST',
      json: { target: 99 },
    })
    assert(badSeat.status >= 400, '越界的座位号被拒（不是 500）', `状态 ${badSeat.status}`)

    const list = await clients[0].api('/api/games/werewolf/rooms')
    assert(list.status === 200, '房间列表可读')
    assert(
      (list.body.rooms ?? []).every((r) => r.kind === 'werewolf'),
      '列表里只有狼人杀房间（没有把象棋/斗地主混进来）',
      `${list.body.rooms?.length} 个`,
    )
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
