/**
 * 斗地主房间（服务端权威 + 按玩家视角裁剪状态）。
 *
 * ============================================================================
 * 这个文件和象棋房间最大的不同：**不能广播**
 * ============================================================================
 *
 * 象棋是公开信息的游戏，整盘状态可以广播给所有人（包括观战者）。
 * 斗地主不是 —— 手牌是隐藏信息。如果把完整状态广播出去，任何人打开
 * 浏览器控制台就能看到对手的牌，"游戏"这件事就不成立了。
 *
 * 所以这里做的是 **per-player view projection（按玩家视角裁剪）**：
 * 每个玩家拿到的状态里，只有自己的手牌是具体的，其他人只有"还剩几张"。
 * 推送也必须定向（pushTo 到具体的人），不能用 broadcast。
 *
 * 这是评审团在设计阶段就点名过的一条：狼人杀那类游戏必须有这个机制，
 * 否则"信息隐藏"是假的。这里先在斗地主上把它落地。
 *
 * ============================================================================
 * 座位编号
 * ============================================================================
 * 用 0/1/2 三个座位。seat_0 复用 game_rooms 的 red_player 列（迁移里没有
 * 单独加 seat_0）—— 这样棋类与牌类共用一张表，而"三缺一"的判断逻辑也能
 * 复用同一组列。这个复用有点隐晦，所以在这里写清楚。
 */
import { randomInt } from 'node:crypto'
import { getDb, newId, now, transaction } from '../db.ts'
import { HttpError } from '../files.ts'
import {
  COMBO_LABELS,
  canBeat,
  createDeck,
  deal,
  findPlays,
  handContains,
  parseCombo,
  shuffle,
  sortCards,
  type Card,
  type Combo,
} from './doudizhu.ts'

export type DoudizhuPhase = 'waiting' | 'bidding' | 'playing' | 'finished'

export interface DoudizhuPlay {
  /** 出牌者座位。 */
  seat: number
  /** 牌面文字，例如 ["3","3","4"]。 */
  cards: string[]
  type: string
  typeLabel: string
  at: number
}

/** 服务端保存的完整状态（**绝不直接发给客户端**）。 */
interface ServerState {
  /** 三个座位的手牌（牌 id 与 rank）。 */
  hands: Card[][]
  bottom: Card[]
  /**
   * 本次发牌用的随机种子。
   *
   * **只存在服务端**，绝不出现在给客户端的 payload 里 —— 它一旦泄露，
   * 拿到的人就能重现整副牌。留着它是为了将来做复盘，
   * 但"能不能复盘"远不如"手牌别泄露"重要。
   */
  dealSeed: number | null
  landlord: number | null
  /** 叫地主阶段：已经表过态的座位。 */
  bidDone: number[]
  /** 出牌阶段：当前该谁出。 */
  current: number
  /** 上一手有效的出牌（用于比大小）。null 表示当前是"首出"。 */
  lastPlay: { seat: number; type: string; rank: number; length: number; cards: Card[] } | null
  /** 连续"要不起"的次数 —— 两次之后主动权回到上一个出牌的人。 */
  passCount: number
  /** 出牌历史（给界面展示）。 */
  history: DoudizhuPlay[]
  /** 每个座位累计出的牌数（用于结算展示）。 */
  playedCount: number[]
}

/** 发给客户端的视图。 */
export interface DoudizhuView {
  id: string
  kind: 'doudizhu'
  title: string
  phase: DoudizhuPhase
  createdBy: string
  creatorName: string
  /** 三个座位的玩家信息。 */
  seats: Array<{ seat: number; userId: string | null; name: string | null; online: boolean }>
  /** 我坐第几号座；观战为 null。 */
  mySeat: number | null
  /** 三个座位各剩几张牌。**这是所有人都能看到的**。 */
  handCounts: number[]
  /** **只有我自己**的手牌；观战或不该看时为 null。 */
  myHand: Card[] | null
  /** 底牌：叫完地主之后公开。 */
  bottom: Card[] | null
  landlord: number | null
  current: number
  /** 上一手出牌（牌面文字，不含具体牌 id）。null 表示我是首出。 */
  lastPlay: { seat: number; cards: string[]; typeLabel: string } | null
  /** 轮到我时，给我的出牌提示（服务端算好，客户端不用自己实现规则）。 */
  hints: string[][]
  history: DoudizhuPlay[]
  result: { winnerSeat: number; landlordWon: boolean; reason: string } | null
  createdAt: number
  updatedAt: number
  /** 是否轮到我。 */
  myTurn: boolean
  /** 叫地主阶段：我是否可以叫。 */
  canBid: boolean
}

interface RawRoom {
  id: string
  title: string
  status: string
  created_by: string
  creator_name: string
  red_player: string | null
  red_name: string | null
  black_player: string | null
  black_name: string | null
  seat_1: string | null
  seat_2: string | null
  state: string | null
  result: string | null
  created_at: number
  updated_at: number
}

/**
 * 查询房间并带上三个座位的显示名。
 *
 * 注意要**三个座位都关联**，包括 0 号座（red_player 列）——
 * 只关联 seat_1/seat_2 的话，自己的名字会显示成"虚位以待"，
 * 而且这个 bug 很隐蔽：座位是满的、牌也发了，只有名字是空的。
 */
const DOUDIZHU_SELECT = `
  SELECT r.*, c.display_name AS creator_name,
         s0.display_name AS seat0_name,
         s1.display_name AS seat1_name,
         s2.display_name AS seat2_name
    FROM game_rooms r
    JOIN users c ON c.id = r.created_by
    LEFT JOIN users s0 ON s0.id = r.red_player
    LEFT JOIN users s1 ON s1.id = r.seat_1
    LEFT JOIN users s2 ON s2.id = r.seat_2
`

interface RawRow extends RawRoom {
  seat0_name: string | null
  seat1_name: string | null
  seat2_name: string | null
}

function readRow(id: string): RawRow | null {
  const row = getDb()
    .prepare(`${DOUDIZHU_SELECT} WHERE r.id = ? AND r.kind = 'doudizhu'`)
    .get(id) as RawRow | undefined
  return row ?? null
}

/** 座位 → 用户 id。 */
function seatUserId(row: RawRoom, seat: number): string | null {
  if (seat === 0) return row.red_player
  if (seat === 1) return row.seat_1
  return row.seat_2
}

function seatName(row: RawRow, seat: number): string | null {
  if (seat === 0) return row.seat0_name
  if (seat === 1) return row.seat1_name
  return row.seat2_name
}

function emptyState(): ServerState {
  return {
    hands: [[], [], []],
    bottom: [],
    dealSeed: null,
    landlord: null,
    bidDone: [],
    current: 0,
    lastPlay: null,
    passCount: 0,
    history: [],
    playedCount: [0, 0, 0],
  }
}

function parseState(raw: string | null): ServerState {
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<ServerState>
    return { ...emptyState(), ...parsed }
  } catch {
    // 状态坏了不该让整个房间不可用，退化成空状态并让上层重新开局
    return emptyState()
  }
}

/**
 * 裁剪出某个请求者能看到的视图。
 *
 * 这是这个模块的**安全核心**：手牌只给本人，别人只有张数。
 * 观战者什么都看不到（连底牌也要等叫完地主）。
 */
export function toDoudizhuView(row: RawRow, viewerId: string, onlineIds: Set<string>): DoudizhuView {
  const state = parseState(row.state)
  const seats = [0, 1, 2].map((seat) => {
    const userId = seatUserId(row, seat)
    return {
      seat,
      userId,
      name: seatName(row, seat),
      online: userId ? onlineIds.has(userId) : false,
    }
  })

  const mySeat = seats.find((s) => s.userId === viewerId)?.seat ?? null
  const phase = normalizePhase(row.status, state)

  // 手牌只给本人。观战者与其他人一律拿不到。
  const myHand = mySeat !== null ? sortCards(state.hands[mySeat] ?? []) : null

  // 底牌：叫完地主才公开（这是斗地主的规则，也是信息隐藏的一部分）
  const bottomRevealed = state.landlord !== null ? state.bottom : null

  // 提示：只在轮到我、且我没法看到别人手牌的前提下算
  let hints: string[][] = []
  if (mySeat !== null && phase === 'playing' && state.current === mySeat) {
    const prev: Combo | null = state.lastPlay
      ? { type: state.lastPlay.type as Combo['type'], rank: state.lastPlay.rank, length: state.lastPlay.length, cards: state.lastPlay.cards }
      : null
    hints = findPlays(state.hands[mySeat] ?? [], prev, 8).map((combo) => combo.cards.map((c) => c.label))
  }

  const result = row.result ? (JSON.parse(row.result) as DoudizhuView['result']) : null

  return {
    id: row.id,
    kind: 'doudizhu',
    title: row.title,
    phase,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    seats,
    mySeat,
    handCounts: state.hands.map((h) => h.length),
    myHand,
    bottom: bottomRevealed,
    landlord: state.landlord,
    current: state.current,
    lastPlay: state.lastPlay
      ? {
          seat: state.lastPlay.seat,
          cards: state.lastPlay.cards.map((c) => c.label),
          typeLabel: COMBO_LABELS[state.lastPlay.type as Combo['type']] ?? state.lastPlay.type,
        }
      : null,
    hints,
    history: state.history.slice(-40),
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    myTurn: phase === 'playing' && mySeat !== null && state.current === mySeat,
    canBid: phase === 'bidding' && mySeat !== null && !state.bidDone.includes(mySeat),
  }
}

function normalizePhase(status: string, state: ServerState): DoudizhuPhase {
  if (status === 'finished') return 'finished'
  if (status === 'waiting') return 'waiting'
  if (state.landlord === null) return 'bidding'
  return 'playing'
}

export function getDoudizhuView(roomId: string, viewerId: string, onlineIds: Set<string>): DoudizhuView {
  const row = readRow(roomId)
  if (!row) throw new HttpError(404, '房间不存在')
  return toDoudizhuView(row, viewerId, onlineIds)
}

/** 房间里需要收到推送的人（三个座位上的玩家）。观战者不推送（他们靠主动拉取）。 */
export function doudizhuMembers(roomId: string): string[] {
  const row = readRow(roomId)
  if (!row) return []
  return [row.red_player, row.seat_1, row.seat_2].filter((id): id is string => Boolean(id))
}

export function listDoudizhuRooms(viewerId: string, onlineIds: Set<string>, onlyOpen = false): DoudizhuView[] {
  const where = onlyOpen ? "AND r.status IN ('waiting','playing')" : ''
  const rows = getDb()
    .prepare(`${DOUDIZHU_SELECT} WHERE r.kind = 'doudizhu' ${where} ORDER BY r.updated_at DESC LIMIT 50`)
    .all() as unknown as RawRow[]
  return rows.map((row) => toDoudizhuView(row, viewerId, onlineIds))
}

export function createDoudizhuRoom(input: { title: string; creatorId: string }): DoudizhuView {
  const title = input.title.trim() || '一局斗地主'
  if (title.length > 40) throw new HttpError(400, '房间名过长')

  const id = newId('room')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO game_rooms
         (id, kind, title, status, created_by, red_player, board, turn, moves, state, created_at, updated_at)
       VALUES (?, 'doudizhu', ?, 'waiting', ?, ?, '', 'red', '[]', ?, ?, ?)`,
    )
    .run(id, title, input.creatorId, input.creatorId, JSON.stringify(emptyState()), ts, ts)

  const row = readRow(id)!
  return toDoudizhuView(row, input.creatorId, new Set())
}

export function joinDoudizhuRoom(roomId: string, userId: string, onlineIds: Set<string>): DoudizhuView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')
    if (row.status === 'finished') throw new HttpError(400, '这局已经结束了')

    const taken = [row.red_player, row.seat_1, row.seat_2]
    if (taken.includes(userId)) return toDoudizhuView(row, userId, onlineIds)

    const freeIndex = taken.findIndex((s) => !s)
    if (freeIndex === -1) throw new HttpError(409, '三个座位都满了，可以观战')

    const column = freeIndex === 0 ? 'red_player' : freeIndex === 1 ? 'seat_1' : 'seat_2'
    getDb()
      .prepare(`UPDATE game_rooms SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(userId, now(), roomId)

    // 三个人到齐 → 发牌并进入叫地主
    const after = readRow(roomId)!
    const allSeated = [after.red_player, after.seat_1, after.seat_2].every(Boolean)
    if (allSeated) {
      startDeal(roomId)
    }

    return toDoudizhuView(readRow(roomId)!, userId, onlineIds)
  })
}

/**
 * 发牌并进入叫地主阶段。
 *
 * ⚠️ 种子**必须**是密码学随机，而且不能从任何公开信息推导出来。
 *
 * 这里曾经用 `房间 id 里的数字` 派生种子 —— 那是一个严重的设计错误：
 * 房间 id 是公开发给每个参与者的（视图里就有，URL 里也有），而洗牌是纯函数，
 * 于是**任何在座玩家都能算出全部三家手牌**（包括底牌）。
 * 整个"手牌隐藏"的设计当场失效，而表面上一切正常。
 *
 * 现在：用 crypto 随机字节取种子，并且种子只存在服务端 state 里
 * （toDoudizhuView 不会把它发出去）。如果将来为了复盘要可复现，
 * 也只能把种子存在服务端，绝不能让它出现在给客户端的 payload 里。
 */
function startDeal(roomId: string): void {
  const seed = randomInt(0, 2 ** 31)
  const deck = shuffle(createDeck(), seed)
  const { hands, bottom } = deal(deck)

  const state: ServerState = {
    ...emptyState(),
    hands: hands.map((h) => sortCards(h)),
    bottom: sortCards(bottom),
    // 叫地主从 0 号座开始（房主，通常就是创建者）
    current: 0,
    // 种子只留在服务端，用于将来做复盘（如果能做的话）
    dealSeed: seed,
  }

  getDb()
    .prepare("UPDATE game_rooms SET status = 'playing', state = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(state), now(), roomId)
}

/** 叫地主。第一个叫的人拿到地主，简化版叫牌（不做加倍/抢地主）。 */
export function bidLandlord(roomId: string, userId: string, call: boolean, onlineIds: Set<string>): DoudizhuView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const state = parseState(row.state)
    if (state.landlord !== null) throw new HttpError(400, '地主已经定了')
    if (row.status !== 'playing') throw new HttpError(400, '还没开始')

    const seats = [row.red_player, row.seat_1, row.seat_2]
    const seat = seats.indexOf(userId)
    if (seat === -1) throw new HttpError(403, '你是观战者，不能叫地主')
    if (state.bidDone.includes(seat)) throw new HttpError(400, '你已经表过态了')

    state.bidDone.push(seat)

    if (call) {
      // 叫 → 成为地主，拿到底牌
      state.landlord = seat
      state.hands[seat] = sortCards([...(state.hands[seat] ?? []), ...state.bottom])
      state.current = seat
      state.lastPlay = null
      state.passCount = 0
    } else if (state.bidDone.length === 3) {
      // 三家都不叫 → 重新发牌（避免开局就死）。
      // 同样必须用密码学随机种子，理由见 startDeal 的注释。
      const newSeed = randomInt(0, 2 ** 31)
      const deck = shuffle(createDeck(), newSeed)
      const { hands, bottom } = deal(deck)
      const fresh = emptyState()
      fresh.hands = hands.map((h) => sortCards(h))
      fresh.bottom = sortCards(bottom)
      fresh.dealSeed = newSeed
      getDb()
        .prepare('UPDATE game_rooms SET state = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fresh), now(), roomId)
      return toDoudizhuView(readRow(roomId)!, userId, onlineIds)
    }

    getDb()
      .prepare('UPDATE game_rooms SET state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), now(), roomId)

    return toDoudizhuView(readRow(roomId)!, userId, onlineIds)
  })
}

export interface DoudizhuMoveResult {
  room: DoudizhuView
  /** 本次出牌的牌面文字（要不起时为空数组）。 */
  played: string[]
  typeLabel: string | null
  finished: { winnerSeat: number; landlordWon: boolean; reason: string } | null
}

/**
 * 出牌。
 *
 * 校验链条（任一环不过就拒绝）：
 *   1. 对局进行中、地主已定
 *   2. 你是玩家（不是观战者）
 *   3. 现在轮到你
 *   4. 你出的这些牌**确实在你手里**（防客户端伪造 id）
 *   5. 这手牌是合法牌型，且能压过上一手
 */
export function playCards(
  roomId: string,
  userId: string,
  cardIds: number[],
  onlineIds: Set<string>,
): DoudizhuMoveResult {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    // 先判身份再判状态：观战者无论如何都该得到 403，
    // 而不是因为"还没叫地主"得到 400 —— 后者等于告诉他对局进行到哪一步了。
    const seats = [row.red_player, row.seat_1, row.seat_2]
    const seat = seats.indexOf(userId)
    if (seat === -1) throw new HttpError(403, '你是观战者，不能出牌')

    const state = parseState(row.state)
    if (state.landlord === null) throw new HttpError(400, '还没叫地主')
    if (state.current !== seat) throw new HttpError(400, '还没轮到你')

    const hand = state.hands[seat] ?? []

    // **必须先去掉重复的 id。**
    // 否则提交 [id3, id3, id3, id3] 时，下面的 find 会对同一个 id 返回同一个对象四次，
    // chosen.length 仍等于 cardIds.length（绕过长度校验），而 parseCombo 只按点数计数，
    // 就会把"手里的一张 3"识别成"四个 3 的炸弹"。
    // 同理 [id9, id9] 会被当成一对 9。这是一条不需要真的持有牌就能作弊的路径。
    const uniqueIds = [...new Set(cardIds)]
    if (uniqueIds.length !== cardIds.length) {
      throw new HttpError(400, '出牌里有重复的牌')
    }

    const chosen = uniqueIds.map((id) => hand.find((c) => c.id === id)).filter((c): c is Card => Boolean(c))
    if (chosen.length !== uniqueIds.length) {
      throw new HttpError(400, '你选的牌不在手里')
    }
    if (chosen.length === 0) throw new HttpError(400, '请先选牌')

    // 再核一次数量：按实际持有的张数算，而不是按 id 集合判断。
    // handContains 用的是"id 是否在手里"的成员判断，对重复 id 是免疫的
    // （因为已经去重了），但把两处都做对才叫双保险。
    const ownedCounts = new Map<number, number>()
    for (const card of hand) ownedCounts.set(card.id, (ownedCounts.get(card.id) ?? 0) + 1)
    for (const card of chosen) {
      const left = (ownedCounts.get(card.id) ?? 0) - 1
      if (left < 0) throw new HttpError(400, '你选的牌不在手里')
      ownedCounts.set(card.id, left)
    }

    const combo = parseCombo(chosen)
    if (!combo) throw new HttpError(400, '这不是一手合法的牌型')

    const prev: Combo | null = state.lastPlay
      ? {
          type: state.lastPlay.type as Combo['type'],
          rank: state.lastPlay.rank,
          length: state.lastPlay.length,
          cards: state.lastPlay.cards,
        }
      : null
    if (!canBeat(combo, prev)) {
      throw new HttpError(400, `管不上：${COMBO_LABELS[combo.type]} 压不过对方的${prev ? COMBO_LABELS[prev.type] : '牌'}`)
    }
    // 双保险：牌确实在手里（前面的查找已经保证了，这里是显式断言）
    if (!handContains(hand, chosen)) throw new HttpError(400, '你选的牌不在手里')

    // 从手里移除
    const ids = new Set(chosen.map((c) => c.id))
    state.hands[seat] = hand.filter((c) => !ids.has(c.id))
    state.playedCount[seat] = (state.playedCount[seat] ?? 0) + chosen.length

    state.lastPlay = {
      seat,
      type: combo.type,
      rank: combo.rank,
      length: combo.length,
      cards: chosen,
    }
    state.passCount = 0
    state.history.push({
      seat,
      cards: chosen.map((c) => c.label),
      type: combo.type,
      typeLabel: COMBO_LABELS[combo.type],
      at: now(),
    })

    let finished: DoudizhuMoveResult['finished'] = null

    if (state.hands[seat]!.length === 0) {
      // 出完了 → 结算
      const landlordWon = seat === state.landlord
      finished = { winnerSeat: seat, landlordWon, reason: 'emptied' }
      getDb()
        .prepare(
          "UPDATE game_rooms SET status = 'finished', state = ?, result = ?, updated_at = ?, finished_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(state), JSON.stringify(finished), now(), now(), roomId)
    } else {
      state.current = (seat + 1) % 3
      getDb()
        .prepare('UPDATE game_rooms SET state = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(state), now(), roomId)
    }

    return {
      room: toDoudizhuView(readRow(roomId)!, userId, onlineIds),
      played: chosen.map((c) => c.label),
      typeLabel: COMBO_LABELS[combo.type],
      finished,
    }
  })
}

/** 要不起（过牌）。两家连续过之后主动权回到上一个出牌的人。 */
export function passTurn(roomId: string, userId: string, onlineIds: Set<string>): DoudizhuView {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    // 同样：先判身份再判状态
    const seats = [row.red_player, row.seat_1, row.seat_2]
    const seat = seats.indexOf(userId)
    if (seat === -1) throw new HttpError(403, '你是观战者')

    const state = parseState(row.state)
    if (state.landlord === null) throw new HttpError(400, '还没叫地主')
    if (state.current !== seat) throw new HttpError(400, '还没轮到你')
    if (!state.lastPlay) throw new HttpError(400, '你是首出，必须出牌')

    state.passCount += 1
    state.history.push({
      seat,
      cards: [],
      type: 'pass',
      typeLabel: '要不起',
      at: now(),
    })

    if (state.passCount >= 2) {
      // 另外两家都过了 → 回到上一手出牌的人重新首出
      state.current = state.lastPlay.seat
      state.lastPlay = null
      state.passCount = 0
    } else {
      state.current = (seat + 1) % 3
    }

    getDb()
      .prepare('UPDATE game_rooms SET state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), now(), roomId)

    return toDoudizhuView(readRow(roomId)!, userId, onlineIds)
  })
}

/** 退出房间。对局中退出 → 判负（残局无法继续）。 */
export function leaveDoudizhuRoom(
  roomId: string,
  userId: string,
  onlineIds: Set<string>,
): { view: DoudizhuView | null; abandoned: boolean } {
  return transaction(() => {
    const row = readRow(roomId)
    if (!row) throw new HttpError(404, '房间不存在')

    const seats = [row.red_player, row.seat_1, row.seat_2]
    const seat = seats.indexOf(userId)
    if (seat === -1) return { view: toDoudizhuView(row, userId, onlineIds), abandoned: false }

    const state = parseState(row.state)
    const playing = state.landlord !== null && row.status !== 'finished'

    if (playing) {
      const landlordWon = seat !== state.landlord
      const result = {
        winnerSeat: state.landlord!,
        landlordWon,
        reason: 'abandon',
      }
      getDb()
        .prepare(
          "UPDATE game_rooms SET status = 'finished', result = ?, updated_at = ?, finished_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(result), now(), now(), roomId)
    }

    const column = seat === 0 ? 'red_player' : seat === 1 ? 'seat_1' : 'seat_2'
    getDb()
      .prepare(`UPDATE game_rooms SET ${column} = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), roomId)

    // 空房间（没人、也没结束）直接删掉，别在列表里堆垃圾
    const after = readRow(roomId)
    if (after && !after.red_player && !after.seat_1 && !after.seat_2 && after.status !== 'finished') {
      getDb().prepare('DELETE FROM game_rooms WHERE id = ?').run(roomId)
      return { view: null, abandoned: playing }
    }

    return { view: after ? toDoudizhuView(after, userId, onlineIds) : null, abandoned: playing }
  })
}
