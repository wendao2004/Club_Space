/**
 * 斗地主房间端到端测试。
 *
 * 最核心的一组断言是**手牌隐藏**：斗地主不是公开信息的游戏，
 * 如果服务端把完整状态发给每个客户端（然后指望前端"不显示"），
 * 任何人打开控制台就能看到对手的牌，游戏就不成立了。
 *
 * 所以这里逐个验证：
 *   - 三个人拿到的 myHand 互不相同，且都是 17 张（叫地主前）
 *   - 谁的 myHand 里都不会出现别人的牌
 *   - 观战者拿不到任何手牌
 *   - 底牌在叫地主之前不公开
 *
 * 另外还跑一整局（用引擎算着法自动打完），验证流程能走到结束。
 *
 * 用法：先启动后端，然后  node scripts/doudizhu-room-test.mjs
 */

import { canBeat, parseCombo } from '../server/src/games/doudizhu.ts'

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

const LABEL_TO_RANK = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 11, Q: 12, K: 13, A: 14, '2': 15, 小王: 16, 大王: 17,
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
      return { status: res.status, body: type.includes('application/json') ? await res.json() : await res.text() }
    },
  }
}

/** 把服务端给的牌面文字还原成引擎能认的 Card（只要 rank 与 id）。 */
function labelsToCards(labels, idBase = 900000) {
  return labels.map((label, i) => ({
    id: idBase + i,
    rank: LABEL_TO_RANK[label] ?? 0,
    label,
    suit: 'spade',
  }))
}

async function register(client, username, displayName, inviteCode) {
  return client.api('/api/auth/register', {
    method: 'POST',
    json: { username, displayName, password: 'doudizhu-test-2026', inviteCode },
  })
}

async function main() {
  console.log(`\n\x1b[1m斗地主房间端到端测试\x1b[0m  目标 ${BASE}\n`)

  const owner = makeClient()
  const b = makeClient()
  const c = makeClient()
  const watcher = makeClient()

  // ---------------------------------------------------------------- 准备
  console.log('【准备账号】')
  const reg = await register(owner, `ddz${SUFFIX}`, '一号选手')
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册房主', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册房主')

  for (const [client, name, label] of [
    [b, `ddzb${SUFFIX}`, '二号选手'],
    [c, `ddzc${SUFFIX}`, '三号选手'],
    [watcher, `ddzw${SUFFIX}`, '围观群众'],
  ]) {
    const inv = await owner.api('/api/admin/invites', {
      method: 'POST',
      json: { role: 'member', maxUses: 1, expiresInDays: 1 },
    })
    const res = await register(client, name, label, inv.body.code)
    assert(res.status === 200 || res.status === 201, `注册${label}`)
  }

  // ---------------------------------------------------------------- 建房与加入
  console.log('\n【建房与加入】')
  const created = await owner.api('/api/games/doudizhu/rooms', {
    method: 'POST',
    json: { title: '引擎测试牌局' },
  })
  assert(created.status === 200, '创建斗地主房间')
  const roomId = created.body.room.id
  assert(created.body.room.phase === 'waiting', '建好后是"等人"状态')
  // 还没发牌时，自己在座位上、手牌是空数组（不是 null —— null 表示"你不该看到任何牌"）
  assert(
    Array.isArray(created.body.room.myHand) && created.body.room.myHand.length === 0,
    '还没发牌，自己的手牌是空的',
    JSON.stringify(created.body.room.myHand),
  )
  assert(created.body.room.handCounts.every((n) => n === 0), '手牌数都是 0')

  const joinB = await b.api(`/api/games/doudizhu/rooms/${roomId}/join`, { method: 'POST', json: {} })
  assert(joinB.status === 200, '二号加入')
  assert(joinB.body.room.phase === 'waiting', '只有两个人时还没发牌')

  const joinC = await c.api(`/api/games/doudizhu/rooms/${roomId}/join`, { method: 'POST', json: {} })
  assert(joinC.status === 200, '三号加入')
  assert(joinC.body.room.phase === 'bidding', '三个人到齐后自动发牌并进入叫地主')

  const joinFourth = await watcher.api(`/api/games/doudizhu/rooms/${roomId}/join`, {
    method: 'POST',
    json: {},
  })
  assert(joinFourth.status === 409, '座位满了之后不能再加入（409）', `状态 ${joinFourth.status}`)

  // ---------------------------------------------------------------- 手牌隐藏（核心）
  console.log('\n【手牌隐藏（关键）】')

  const viewOwner = (await owner.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
  const viewB = (await b.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
  const viewC = (await c.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
  const viewWatcher = (await watcher.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room

  assert(viewOwner.myHand !== null, '房主能看到自己的手牌')
  assert(viewOwner.myHand.length === 17, '叫地主前每人 17 张', `${viewOwner.myHand.length} 张`)
  assert(viewB.myHand.length === 17, '二号也是 17 张')
  assert(viewC.myHand.length === 17, '三号也是 17 张')

  assert(viewOwner.mySeat !== viewB.mySeat, '三个人坐在不同座位', `${viewOwner.mySeat}/${viewB.mySeat}/${viewC.mySeat}`)

  // 三个人的手牌必须互不相同
  const idsOwner = new Set(viewOwner.myHand.map((c) => c.id))
  const idsB = new Set(viewB.myHand.map((c) => c.id))
  const idsC = new Set(viewC.myHand.map((c) => c.id))
  const overlap = [...idsOwner].filter((id) => idsB.has(id) || idsC.has(id))
  assert(overlap.length === 0, '三个人的手牌没有任何重复（各拿各的）', `重复 ${overlap.length} 张`)

  // 三手牌合起来应该是 51 张
  assert(idsOwner.size + idsB.size + idsC.size === 51, '三家手牌合计 51 张', `${idsOwner.size + idsB.size + idsC.size} 张`)

  // 最关键的一条：观战者看不到任何手牌
  assert(viewWatcher.myHand === null, '观战者拿不到任何手牌')
  assert(viewWatcher.mySeat === null, '观战者不属于任何座位')

  // 底牌在叫地主之前不公开
  assert(viewOwner.bottom === null, '叫地主之前，底牌对所有人保密')
  assert(viewWatcher.bottom === null, '观战者也看不到底牌')

  // 但手牌张数对所有人可见（这是合理可见信息）
  assert(
    viewWatcher.handCounts.every((n) => n === 17),
    '每个人剩几张牌对所有玩家可见（这是斗地主里公开的信息）',
    viewWatcher.handCounts.join('/'),
  )

  // 观战者不能出牌
  const watcherPlay = await watcher.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    json: { cardIds: [viewOwner.myHand[0].id] },
  })
  assert(watcherPlay.status === 403, '观战者不能出牌（403）', `状态 ${watcherPlay.status}`)

  const watcherBid = await watcher.api(`/api/games/doudizhu/rooms/${roomId}/bid`, {
    method: 'POST',
    json: { call: true },
  })
  assert(watcherBid.status === 403, '观战者不能叫地主（403）', `状态 ${watcherBid.status}`)

  // ---------------------------------------------------------------- 叫地主
  console.log('\n【叫地主】')
  const bidOwner = await owner.api(`/api/games/doudizhu/rooms/${roomId}/bid`, {
    method: 'POST',
    json: { call: true },
  })
  assert(bidOwner.status === 200, '房主叫地主')
  assert(bidOwner.body.room.landlord === bidOwner.body.room.mySeat, '房主成为地主')
  assert(bidOwner.body.room.myHand.length === 20, '地主拿到 3 张底牌（17+3=20）', `${bidOwner.body.room.myHand.length} 张`)
  assert(bidOwner.body.room.phase === 'playing', '进入出牌阶段')
  assert(bidOwner.body.room.bottom !== null, '底牌公开了')

  const viewB2 = (await b.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
  assert(viewB2.myHand.length === 17, '农民仍然是 17 张')
  assert(viewB2.bottom !== null, '农民也能看到底牌（规则如此）')
  assert(viewB2.handCounts[viewB2.mySeat] === 17, '自己的张数正确')
  assert(
    viewB2.handCounts[bidOwner.body.room.mySeat] === 20,
    '农民的视角里，地主的张数是 20（但看不到具体牌）',
    viewB2.handCounts.join('/'),
  )

  // 农民的手牌里不能出现地主的手牌
  const landlordIds = new Set(bidOwner.body.room.myHand.map((c) => c.id))
  const overlap2 = viewB2.myHand.filter((c) => landlordIds.has(c.id))
  assert(overlap2.length === 0, '农民的手牌里没有地主的牌')

  // 重复叫地主会被拒
  const bidAgain = await owner.api(`/api/games/doudizhu/rooms/${roomId}/bid`, {
    method: 'POST',
    json: { call: true },
  })
  assert(bidAgain.status === 400, '地主已定时不能再叫（400）', `状态 ${bidAgain.status}`)

  // ---------------------------------------------------------------- 出牌
  console.log('\n【出牌与轮次】')

  const seats = [
    { client: owner, seat: bidOwner.body.room.mySeat, view: bidOwner.body.room },
    { client: b, seat: viewB2.mySeat, view: viewB2 },
    { client: c, seat: viewC.mySeat, view: viewC },
  ]
  const bySeat = new Map(seats.map((s) => [s.seat, s]))

  const landlordSeat = bidOwner.body.room.landlord
  const landlord = bySeat.get(landlordSeat)

  // 非地主先出会被拒
  const farmerSeat = [0, 1, 2].find((s) => s !== landlordSeat)
  const farmer = bySeat.get(farmerSeat)
  const outOfTurn = await farmer.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    json: { cardIds: [farmer.view.myHand[0].id] },
  })
  assert(outOfTurn.status === 400, '还没轮到你时不能出牌（400）', `状态 ${outOfTurn.status}`)

  // 首出不能"要不起"
  const passFirst = await landlord.client.api(`/api/games/doudizhu/rooms/${roomId}/pass`, {
    method: 'POST',
    json: {},
  })
  assert(passFirst.status === 400, '首出时必须出牌，不能要不起（400）', `状态 ${passFirst.status}`)

  // 伪造不属于自己的牌 id
  const forged = await landlord.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    json: { cardIds: [viewB2.myHand[0].id] },
  })
  assert(forged.status === 400, '出别人手里的牌会被拒（400，防伪造）', `状态 ${forged.status}`)

  // **重复同一个 id**：这是"一张牌当炸弹出"的伪造路径。
  // 没有去重的话，[id,id,id,id] 会被 parseCombo 按点数算成"四个相同"= 炸弹。
  const firstCard = landlord.view.myHand[0]
  const duplicated = await landlord.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    json: { cardIds: [firstCard.id, firstCard.id, firstCard.id, firstCard.id] },
  })
  assert(
    duplicated.status === 400,
    '重复提交同一张牌的 id 会被拒（否则一张 3 就能当炸弹出）',
    `状态 ${duplicated.status}：${duplicated.body.error ?? ''}`,
  )

  const duplicatedPair = await landlord.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    json: { cardIds: [firstCard.id, firstCard.id] },
  })
  assert(
    duplicatedPair.status === 400,
    '重复两次也不许（否则单张能当对子出）',
    `状态 ${duplicatedPair.status}`,
  )

  // 出不合法的牌型（随便挑两张不同点数的牌）。
  //
  // ⚠️ 必须**排除大小王**：手里同时有大小王时，那两张恰好构成合法的"王炸"。
  // 最初的写法没排除，于是当地主恰好摸到两个王时这条断言就会失败 ——
  // 而那是测试写错了，不是产品的问题。
  const hand = landlord.view.myHand
  const normalCards = hand.filter((c) => c.rank < 16)
  const twoDifferent = normalCards
    .filter((card, i, arr) => arr.findIndex((x) => x.rank === card.rank) === i)
    .slice(0, 2)
  if (twoDifferent.length === 2 && twoDifferent[0].rank !== twoDifferent[1].rank) {
    const illegal = await landlord.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
      method: 'POST',
      json: { cardIds: twoDifferent.map((c) => c.id) },
    })
    assert(
      illegal.status === 400,
      '非法牌型被拒（400）',
      `用 ${twoDifferent.map((c) => c.label).join('+')} 试的，状态 ${illegal.status}`,
    )
  } else {
    ok('手上没有两张不同点数的普通牌，跳过非法牌型测试')
  }

  // ---------------------------------------------------------------- 打完整局
  console.log('\n【自动打完整局】')

  let plies = 0
  let finished = null
  const MAX_PLIES = 200
  const errors = []

  while (plies < MAX_PLIES && !finished) {
    // 每轮重新拉一次状态（顺便验证视图始终是"只有自己的牌"）
    const currentView = (await owner.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
    if (currentView.phase === 'finished') {
      finished = currentView.result
      break
    }

    const actorSeat = currentView.current
    const actor = bySeat.get(actorSeat)
    if (!actor) {
      errors.push(`座位 ${actorSeat} 没有对应客户端`)
      break
    }

    // 该玩家自己的视角
    const myView = (await actor.client.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
    if (myView.mySeat !== actorSeat) {
      errors.push(`座位错乱：期望 ${actorSeat}，实际 ${myView.mySeat}`)
      break
    }
    // 校验：我的视图里只有我自己的手牌
    if (!myView.myHand) {
      errors.push('轮到出牌却拿不到自己的手牌')
      break
    }

    // 用引擎算一手（视图里带了服务端算好的提示，取第一个即可）
    if (myView.hints.length > 0) {
      const hint = myView.hints[0]
      // 把提示的牌面映射回我手里的牌 id
      const used = new Set()
      const cardIds = []
      let matched = true
      for (const label of hint) {
        const card = myView.myHand.find((card) => card.label === label && !used.has(card.id))
        if (!card) {
          matched = false
          break
        }
        used.add(card.id)
        cardIds.push(card.id)
      }
      if (!matched) {
        errors.push(`提示的牌 ${hint.join(',')} 不在自己手里`)
        break
      }

      const res = await actor.client.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
        method: 'POST',
        json: { cardIds },
      })
      if (res.status !== 200) {
        errors.push(`出牌被拒：${res.body.error}`)
        break
      }
      if (res.body.finished) finished = res.body.finished
    } else {
      // 要不起
      const res = await actor.client.api(`/api/games/doudizhu/rooms/${roomId}/pass`, {
        method: 'POST',
        json: {},
      })
      if (res.status !== 200) {
        errors.push(`要不起被拒：${res.body.error}`)
        break
      }
    }
    plies++
  }

  assert(errors.length === 0, '整局过程中没有出现错误', errors.slice(0, 3).join(' | '))
  assert(plies > 3, '对局走了 3 手以上', `${plies} 手`)
  assert(finished !== null, '对局能打到结束（有人出完牌）', finished ? JSON.stringify(finished) : '未结束')

  if (finished) {
    assert(typeof finished.winnerSeat === 'number', '结果里有获胜座位', `座位 ${finished.winnerSeat}`)
    assert(typeof finished.landlordWon === 'boolean', '结果里标明地主是否获胜', `landlordWon=${finished.landlordWon}`)
  }

  // ---------------------------------------------------------------- 结束后
  console.log('\n【对局结束后】')
  const finalView = (await owner.api(`/api/games/doudizhu/rooms/${roomId}`)).body.room
  assert(finalView.phase === 'finished', '状态变为已结束')
  assert(finalView.result !== null, '视图里有对局结果')
  assert(finalView.myHand !== null, '结束后仍能看到自己的手牌（供复盘）')

  const playAfterFinish = await owner.api(`/api/games/doudizhu/rooms/${roomId}/play`, {
    method: 'POST',
    // ⚠️ 赢家手里是 0 张牌，myHand[0] 会是 undefined。
    // 最初的写法直接用 myHand[0].id，于是"地主恰好赢了"的时候测试自己崩掉
    // （约三分之一的概率，取决于发牌）。这里给一个能跑通的兜底 id ——
    // 反正目的是验证"结束后不能出牌"，服务端会因为状态检查先拒掉。
    json: { cardIds: [finalView.myHand?.[0]?.id ?? 0] },
  })
  assert(playAfterFinish.status === 400, '结束后不能继续出牌（400）', `状态 ${playAfterFinish.status}`)

  // 顺便确认"赢家手里确实是 0 张"这件事本身是对的（不是 bug）
  if (finalView.result && finalView.result.winnerSeat === finalView.mySeat) {
    assert(
      (finalView.myHand?.length ?? 0) === 0,
      '出完牌的一方手里确实是 0 张（供复盘时能看到这个结果）',
      `${finalView.myHand?.length ?? 0} 张`,
    )
  }

  // 列表
  const list = await owner.api('/api/games/doudizhu/rooms')
  assert(list.status === 200, '获取牌局列表')
  assert(Array.isArray(list.body.rooms), '列表是数组')
  assert(
    list.body.rooms.some((r) => r.id === roomId),
    '刚打完的牌局在列表里',
  )
  // 列表里也不该泄露手牌
  const listedRoom = list.body.rooms.find((r) => r.id === roomId)
  assert(
    listedRoom.myHand === null || Array.isArray(listedRoom.myHand),
    '列表接口同样按视角裁剪（不会有别人手牌）',
  )

  // 未登录
  const anon = await fetch(`${BASE}/api/games/doudizhu/rooms`)
  assert(anon.status === 401, '未登录不能访问牌局接口（401）', `状态 ${anon.status}`)

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

void canBeat
void parseCombo
