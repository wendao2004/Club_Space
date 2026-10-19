/**
 * 中国象棋房间（服务端）端到端测试。
 *
 * 核心思路是**差分测试**：规则引擎已经用 perft 验证过（深度 4 = 329 万着法精确匹配），
 * 所以把它当作"正确答案的来源"，让房间层去执行同样的着法，然后逐步比对
 * 每一步之后的棋盘是否与引擎算出来的一致。
 *
 * 这样能验到房间层最容易出错的地方：坐标转换（"e0" ↔ 字符串下标）、
 * 行的翻转、吃子记录、轮次切换、以及"服务端权威"是否真的拦住了非法着法。
 *
 * 用法：先启动后端，然后  node scripts/games-test.mjs
 */

import {
  deserializeBoard,
  evaluateResult,
  initialBoard,
  legalMoves,
  serializeBoard,
  squareName,
} from '../server/src/games/xiangqi.ts'

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
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        ...options,
        headers,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const body = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body, headers: res.headers }
    },
  }
}

async function main() {
  console.log(`\n\x1b[1m象棋房间端到端测试\x1b[0m  目标 ${BASE}\n`)

  const red = makeClient() // 执红
  const black = makeClient() // 执黑
  const spectator = makeClient() // 观战

  // ---------------------------------------------------------------- 准备
  console.log('【准备账号】')
  const reg = await red.api('/api/auth/register', {
    method: 'POST',
    json: { username: `xq${SUFFIX}`, displayName: '红方选手', password: 'chess-test-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册红方', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册红方')

  const makeInvite = () =>
    red.api('/api/admin/invites', {
      method: 'POST',
      json: { role: 'member', maxUses: 1, expiresInDays: 1 },
    })

  const inv1 = await makeInvite()
  const blackReg = await black.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `xqb${SUFFIX}`,
      displayName: '黑方选手',
      password: 'chess-test-2026',
      inviteCode: inv1.body.code,
    },
  })
  assert(blackReg.status === 200 || blackReg.status === 201, '注册黑方')

  const inv2 = await makeInvite()
  const specReg = await spectator.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `xqs${SUFFIX}`,
      displayName: '围观群众',
      password: 'chess-test-2026',
      inviteCode: inv2.body.code,
    },
  })
  assert(specReg.status === 200 || specReg.status === 201, '注册观战者')

  // ---------------------------------------------------------------- 建房与加入
  console.log('\n【建房与加入】')
  const created = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '测试对局', side: 'red' },
  })
  assert(created.status === 200, '创建房间')
  const roomId = created.body.room.id
  assert(created.body.room.status === 'waiting', '建好后状态是"等待加入"')
  assert(created.body.room.mySide === 'red', '创建者坐红方')
  assert(
    created.body.room.board === serializeBoard(initialBoard()),
    '初始棋盘与引擎的开局一致',
  )

  const earlyMove = await red.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'b2', to: 'e2' },
  })
  assert(earlyMove.status === 400, '还在等人时不能走棋', `状态 ${earlyMove.status}`)

  // 观战者先加入（不占座）
  const specView = await spectator.api(`/api/games/rooms/${roomId}`)
  assert(specView.status === 200, '观战者能看到房间')
  assert(specView.body.room.mySide === null, '观战者不属于任何一方')

  const joinBlack = await black.api(`/api/games/rooms/${roomId}/join`, {
    method: 'POST',
    json: { side: 'black' },
  })
  assert(joinBlack.status === 200, '黑方加入')
  assert(joinBlack.body.room.status === 'playing', '两人到齐后自动开始')
  assert(joinBlack.body.room.mySide === 'black', '加入者坐黑方')

  const joinThird = await spectator.api(`/api/games/rooms/${roomId}/join`, { method: 'POST', json: {} })
  assert(joinThird.status === 409, '两个座位满了之后不能再加入（409）', `状态 ${joinThird.status}`)

  // ---------------------------------------------------------------- 权限
  console.log('\n【权限与轮次】')
  const blackFirst = await black.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'b7', to: 'e7' },
  })
  assert(blackFirst.status === 400, '红先走，黑方抢先走被拒（400）', `状态 ${blackFirst.status}`)

  const spectatorMove = await spectator.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'b2', to: 'e2' },
  })
  assert(spectatorMove.status === 403, '观战者不能走棋（403）', `状态 ${spectatorMove.status}`)

  const illegal = await red.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'e0', to: 'e5' },
  })
  assert(illegal.status === 400, '非法着法被拒（帅不能一步飞到河对岸）', `状态 ${illegal.status}`)

  const wrongPiece = await red.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'b9', to: 'b8' },
  })
  assert(wrongPiece.status === 400, '不能动对方的子', `状态 ${wrongPiece.status}`)

  const badCoord = await red.api(`/api/games/rooms/${roomId}/move`, {
    method: 'POST',
    json: { from: 'z9', to: 'e2' },
  })
  assert(badCoord.status === 400, '坐标越界被拒（400）', `状态 ${badCoord.status}`)

  // ---------------------------------------------------------------- 差分测试主体
  console.log('\n【差分测试：房间执行 vs 引擎计算】')

  // 从当前局面开始（此时还没走过任何一步）
  let engineBoard = initialBoard()
  let engineTurn = 'red'
  let plies = 0
  let mismatches = 0
  let captures = 0
  let checkedMoves = 0
  let finished = null

  const MAX_PLIES = 80

  while (plies < MAX_PLIES && !finished) {
    const mover = engineTurn === 'red' ? red : black
    const moves = legalMoves(engineBoard, engineTurn)
    if (moves.length === 0) break

    // 确定性地选一步：取排序后的第一个。
    // 不用随机是为了让失败可复现 —— 差分测试最怕"偶尔失败"。
    const sorted = [...moves].sort((a, b) => {
      const ka = `${squareName(a.from)}${squareName(a.to)}`
      const kb = `${squareName(b.from)}${squareName(b.to)}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    const chosen = sorted[0]
    const from = squareName(chosen.from)
    const to = squareName(chosen.to)

    // 引擎算出的预期结果
    const expectedBoard = engineBoard.map((p) => (p ? { ...p } : null))
    const piece = expectedBoard[chosen.from]
    const captured = expectedBoard[chosen.to]
    expectedBoard[chosen.to] = piece
    expectedBoard[chosen.from] = null
    const expectedSerialized = serializeBoard(expectedBoard)

    const res = await mover.api(`/api/games/rooms/${roomId}/move`, {
      method: 'POST',
      json: { from, to },
    })

    if (res.status !== 200) {
      bad(`第 ${plies + 1} 手（${engineTurn} ${from}→${to}）`, `服务端拒绝：${JSON.stringify(res.body)}`)
      mismatches++
      break
    }

    plies++

    if (res.body.room.board !== expectedSerialized) {
      mismatches++
      if (mismatches <= 2) {
        bad(
          `第 ${plies} 手后棋盘不一致`,
          `期望 ${expectedSerialized}\n      实际 ${res.body.room.board}`,
        )
      }
    }

    // 吃子记录
    if (captured && res.body.move.captured !== captured.type) {
      mismatches++
    }
    if (captured) captures++
    if (res.body.move.check) checkedMoves++

    // 轮次切换
    if (res.body.room.turn === engineTurn) {
      mismatches++
      if (mismatches <= 2) bad(`第 ${plies} 手后没有换边`, `仍然是 ${res.body.room.turn}`)
    }

    engineBoard = expectedBoard
    engineTurn = engineTurn === 'red' ? 'black' : 'red'
    finished = res.body.finished
  }

  assert(plies > 10, '顺利走了 10 手以上', `共 ${plies} 手`)
  assert(mismatches === 0, `全部 ${plies} 手的棋盘都与引擎计算一致`, `${mismatches} 处不一致`)
  console.log(`      \x1b[90m（其中吃子 ${captures} 次，形成将军 ${checkedMoves} 次）\x1b[0m`)

  // 着法历史长度应与手数一致
  const finalView = await red.api(`/api/games/rooms/${roomId}`)
  assert(
    finalView.body.room.moves.length === plies,
    '着法历史条数与实际手数一致',
    `${finalView.body.room.moves.length} vs ${plies}`,
  )
  assert(
    finalView.body.room.moves.every((m, i) => m.color === (i % 2 === 0 ? 'red' : 'black')),
    '着法历史里红黑交替正确',
  )

  // 终局：要么引擎判定结束，要么还没结束
  //
  // ⚠️ 这里有一条**故意留的例外**：服务端还多一条规则引擎不管的判和 ——
  // "同一局面出现三次"（见 rooms.ts 的 positionOccurrences）。规则引擎只认
  // 将死/困毙，重复局面它不判，所以服务端"提前"结束是**对的**，
  // 不能拿它当"服务端自己乱判终局"的证据。
  const engineVerdict = evaluateResult({ board: engineBoard, turn: engineTurn, history: [] })
  if (engineVerdict.over) {
    assert(finished !== null, '引擎判定终局时服务端也判定了终局')
  } else {
    assert(
      finished === null || finished.reason === 'repetition',
      '引擎判定未终局时服务端也没提前结束（三次重复判和除外）',
      finished ? `服务端判了 ${finished.reason}` : '',
    )
  }

  // ---------------------------------------------------------------- 合法着法查询
  console.log('\n【合法着法查询（前端高亮用）】')
  const legalRes = await red.api(`/api/games/rooms/${roomId}/legal?from=e0`)
  assert(legalRes.status === 200, '查询某格子的合法着法')
  const engineTargets = legalMoves(
    deserializeBoard(finalView.body.room.board),
    finalView.body.room.turn,
  )
    .filter((m) => squareName(m.from) === 'e0')
    .map((m) => squareName(m.to))
    .sort()
  assert(
    JSON.stringify([...legalRes.body.targets].sort()) === JSON.stringify(engineTargets),
    '接口返回的合法着法与引擎一致',
    `接口 ${legalRes.body.targets.join(',')} / 引擎 ${engineTargets.join(',')}`,
  )

  // ---------------------------------------------------------------- SSE 实时推送
  console.log('\n【实时推送】')
  const received = []
  let streamClosed = false

  const streamPromise = (async () => {
    const res = await fetch(`${BASE}/api/chat/stream`, {
      headers: { cookie: spectator.cookie, accept: 'text/event-stream' },
    })
    if (!res.ok) {
      bad('观战者建立 SSE', `状态 ${res.status}`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!streamClosed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
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
              // 忽略
            }
          }
        }
      }
    } catch {
      // 主动关闭时会抛错，正常
    }
  })()

  await new Promise((r) => setTimeout(r, 1200))
  assert(received.some((e) => e.type === 'hello'), '观战者收到 hello（连接建立）')

  // 找当前该走的一方走一步，观战者应该能看到
  const beforeCount = received.filter((e) => e.type === 'game-move').length
  if (!finished) {
    const currentTurn = finalView.body.room.turn
    const client = currentTurn === 'red' ? red : black
    const engineMoves = legalMoves(deserializeBoard(finalView.body.room.board), currentTurn)
    if (engineMoves.length > 0) {
      const m = engineMoves.sort((a, b) => (squareName(a.to) < squareName(b.to) ? -1 : 1))[0]
      await client.api(`/api/games/rooms/${roomId}/move`, {
        method: 'POST',
        json: { from: squareName(m.from), to: squareName(m.to) },
      })
      for (let i = 0; i < 15 && received.filter((e) => e.type === 'game-move').length === beforeCount; i++) {
        await new Promise((r) => setTimeout(r, 200))
      }
      const moves = received.filter((e) => e.type === 'game-move')
      assert(moves.length > beforeCount, '观战者通过 SSE 实时收到了落子事件')
      if (moves.length > 0) {
        const last = moves[moves.length - 1]
        assert(last.data.roomId === roomId, '推送里带房间 id')
        assert(last.data.move && last.data.room, '推送里带着法与最新局面')
      }
    }
  } else {
    ok('对局已在差分测试中结束，跳过落子推送检查')
  }

  streamClosed = true
  await Promise.race([streamPromise, new Promise((r) => setTimeout(r, 2000))])

  // ---------------------------------------------------------------- 认输与退出
  console.log('\n【认输与退出】')

  // 新开一局来测认输（上面那局可能已经结束了）
  const room2 = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '认输测试', side: 'red' },
  })
  const room2Id = room2.body.room.id
  await black.api(`/api/games/rooms/${room2Id}/join`, { method: 'POST', json: { side: 'black' } })

  const spectatorResign = await spectator.api(`/api/games/rooms/${room2Id}/resign`, { method: 'POST', json: {} })
  assert(spectatorResign.status === 403, '观战者不能认输（403）', `状态 ${spectatorResign.status}`)

  const resignRes = await red.api(`/api/games/rooms/${room2Id}/resign`, { method: 'POST', json: {} })
  assert(resignRes.status === 200, '红方认输')
  assert(resignRes.body.room.status === 'finished', '对局结束')
  assert(resignRes.body.room.result.winner === 'black', '黑方获胜')
  assert(resignRes.body.room.result.reason === 'resign', '原因是认输', resignRes.body.room.result.reason)

  const moveAfterFinish = await black.api(`/api/games/rooms/${room2Id}/move`, {
    method: 'POST',
    json: { from: 'b7', to: 'e7' },
  })
  assert(moveAfterFinish.status === 400, '结束后不能继续走棋', `状态 ${moveAfterFinish.status}`)

  // 对局中离开 = 判负
  const room3 = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '中途离开测试', side: 'red' },
  })
  const room3Id = room3.body.room.id
  await black.api(`/api/games/rooms/${room3Id}/join`, { method: 'POST', json: { side: 'black' } })
  const leaveRes = await black.api(`/api/games/rooms/${room3Id}/leave`, { method: 'POST', json: {} })
  assert(leaveRes.status === 200, '对局中退出')
  assert(leaveRes.body.room.status === 'finished', '对局中退出后局面标记为结束')
  assert(leaveRes.body.room.result.winner === 'red', '离开的一方判负，红方胜')
  assert(leaveRes.body.room.result.reason === 'abandon', '原因是"对手离开"', leaveRes.body.room.result.reason)

  // 等人阶段离开 = 房间消失，不判负
  const room4 = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '空房间清理测试', side: 'red' },
  })
  const room4Id = room4.body.room.id
  const leaveWaiting = await red.api(`/api/games/rooms/${room4Id}/leave`, { method: 'POST', json: {} })
  assert(leaveWaiting.status === 200, '等人阶段可以离开')
  const gone = await red.api(`/api/games/rooms/${room4Id}`)
  assert(gone.status === 404, '空房间被清理掉（不留垃圾房间）', `状态 ${gone.status}`)

  // ---------------------------------------------------------------- 列表与战绩
  console.log('\n【列表与战绩】')
  const list = await red.api('/api/games/rooms')
  assert(list.status === 200, '获取对局列表')
  assert(Array.isArray(list.body.rooms), '列表是数组')
  assert(typeof list.body.stats === 'object', '带战绩信息')
  assert(list.body.stats.played >= 2, '战绩里统计了已结束的对局', `已下 ${list.body.stats.played} 局`)
  assert(
    list.body.stats.won + list.body.stats.lost <= list.body.stats.played,
    '胜+负不超过总局数',
    `胜 ${list.body.stats.won} 负 ${list.body.stats.lost} 总 ${list.body.stats.played}`,
  )

  // ---------------------------------------------------------------- 人机对战
  console.log('\n【人机对战】')

  const botRoom = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { bot: { level: 'hard', side: 'black' } },
  })
  assert(botRoom.status === 200, '创建人机对战', `状态 ${botRoom.status}`)
  const botRoomId = botRoom.body.room.id
  assert(botRoom.body.room.status === 'playing', '人机对战坐下即开局（不用等人）', botRoom.body.room.status)
  assert(botRoom.body.room.botSide === 'black', '电脑坐黑方')
  assert(botRoom.body.room.botLevel === 'hard', '难度记在房间里（用于显示与"再来一局"沿用）')
  assert(
    typeof botRoom.body.room.blackName === 'string' && botRoom.body.room.blackName.includes('电脑'),
    '黑方显示成「电脑（困难）」这类名字，而不是「虚位以待」',
    botRoom.body.room.blackName ?? '(null)',
  )
  assert(botRoom.body.room.mySide === 'red', '我坐红方')
  assert(botRoom.body.room.myTurn === true, '开局轮到我走（红先）')
  assert(botRoom.body.room.botThinking === false, '还没到电脑思考的时候')

  const redMove = await red.api(`/api/games/rooms/${botRoomId}/move`, {
    method: 'POST',
    json: { from: 'c3', to: 'c4' },
  })
  assert(redMove.status === 200, '我走一步', `状态 ${redMove.status}`)
  assert(redMove.body.room.myTurn === false, '走完之后轮不到我')
  assert(redMove.body.room.botThinking === true, '界面据此显示「电脑正在思考…」')

  /** 等电脑落子（它有思考延迟 + 搜索时间，最长约 2 秒）。 */
  async function waitForBot(roomId, minPlies, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      const got = await red.api(`/api/games/rooms/${roomId}`)
      if (got.status === 200 && got.body.room.moves.length >= minPlies) return got.body.room
    }
    return null
  }

  const afterBot = await waitForBot(botRoomId, 2)
  assert(afterBot !== null, '电脑应手了（等到了第二手）')
  if (afterBot) {
    const botMove = afterBot.moves[1]
    assert(botMove.by === 'bot', '第二手记的是机器人下的', `by=${botMove.by} / ${botMove.byName}`)
    assert(botMove.color === 'black', '机器人下的是它那一边（黑）', botMove.color)
    assert(afterBot.turn === 'red' && afterBot.myTurn === true, '电脑走完又轮到我')
    assert(afterBot.botThinking === false, '不在"思考中"状态了')
    // 机器人走出来的局面必须还是合法的：拿引擎复核一遍红方还有没有棋走
    const board = deserializeBoard(afterBot.board)
    const legal = legalMoves(board, 'red')
    assert(legal.length > 0, '电脑走完之后的局面，红方仍有合法着法', `${legal.length} 步`)
  }

  // 我执黑时电脑执红先走 —— 我一步没走，它就该自己动起来
  const botFirst = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { bot: { level: 'easy', side: 'red' } },
  })
  const botFirstId = botFirst.body.room.id
  assert(botFirst.body.room.mySide === 'black', '（电脑执红）我坐黑方')
  assert(botFirst.body.room.myTurn === false, '开局轮不到我')
  assert(botFirst.body.room.botThinking === true, '开局就处于"电脑思考中"')
  const firstHand = await waitForBot(botFirstId, 1, 8000)
  assert(firstHand !== null, '电脑自己走了第一步（我一步都没走）')
  if (firstHand) {
    assert(firstHand.moves[0].by === 'bot' && firstHand.moves[0].color === 'red', '第一手是电脑替红方下的')
    assert(firstHand.myTurn === true, '电脑走完轮到我')
  }

  // 别人不能插进人机对战
  const intrude = await black.api(`/api/games/rooms/${botRoomId}/join`, { method: 'POST', json: {} })
  assert(intrude.status === 409, '别人不能加入人机对战（409）', `状态 ${intrude.status}`)

  // 人机对战也进战绩：认输之后应该计一局
  const statsBefore = (await red.api('/api/games/rooms')).body.stats.played
  const resignBot = await red.api(`/api/games/rooms/${botRoomId}/resign`, { method: 'POST', json: {} })
  assert(resignBot.status === 200, '人机对战里可以认输')
  assert(
    resignBot.body.room.result.winner === 'black',
    '认输之后判电脑那一边获胜',
    JSON.stringify(resignBot.body.room.result),
  )
  const statsAfter = (await red.api('/api/games/rooms')).body.stats.played
  assert(statsAfter === statsBefore + 1, '这一局计入了我的战绩', `${statsBefore} → ${statsAfter}`)

  // ---------------------------------------------------------------- 三次重复判和
  //
  // 没有这条规则的话，双方都不肯变着时这盘棋会永远挂在"对局中"，
  // 谁也不知道该干什么。这里让两只车来回平移，正好把局面走回原始形态三次。
  console.log('\n【三次重复判和】')
  const drawRoom = await red.api('/api/games/rooms', {
    method: 'POST',
    json: { kind: 'xiangqi', title: '重复局面测试', side: 'red' },
  })
  const drawRoomId = drawRoom.body.room.id
  await black.api(`/api/games/rooms/${drawRoomId}/join`, { method: 'POST', json: { side: 'black' } })

  // 红车 a0↔a1、黑车 a9↔a8：每四手回到同一个局面
  const shuffle = [
    { client: red, from: 'a0', to: 'a1' },
    { client: black, from: 'a9', to: 'a8' },
    { client: red, from: 'a1', to: 'a0' },
    { client: black, from: 'a8', to: 'a9' },
    { client: red, from: 'a0', to: 'a1' },
    { client: black, from: 'a9', to: 'a8' },
    { client: red, from: 'a1', to: 'a0' },
    { client: black, from: 'a8', to: 'a9' },
  ]
  let drawState = null
  for (const step of shuffle) {
    const res = await step.client.api(`/api/games/rooms/${drawRoomId}/move`, {
      method: 'POST',
      json: { from: step.from, to: step.to },
    })
    assert(res.status === 200, `重复局面：${step.from}->${step.to} 走得通`, `状态 ${res.status}`)
    if (res.status !== 200) break
    drawState = res.body.room
    if (drawState.status === 'finished') break
  }
  assert(drawState !== null && drawState.status === 'finished', '走回同一个局面三次之后对局结束')
  assert(drawState?.result?.reason === 'repetition', '结束原因是"三次重复局面"', drawState?.result?.reason ?? '')
  assert(drawState?.result?.winner === null, '判和（没有胜者）', JSON.stringify(drawState?.result ?? {}))

  const anon = await fetch(`${BASE}/api/games/rooms`)
  assert(anon.status === 401, '未登录不能访问游戏接口（401）', `状态 ${anon.status}`)

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
