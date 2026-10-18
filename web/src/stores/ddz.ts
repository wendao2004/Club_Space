/**
 * 斗地主的状态管理。
 *
 * 几条贯穿全文件的原则：
 *
 * 1. **服务端权威，前端不做牌型判断。** 是否能管上、这手牌算不算炸弹，全部由服务端
 *    裁定（room.hints 就是它算好的提示）。前端只负责选牌、提交牌 id。前端若自己判，
 *    很容易出现"前端说合法、服务端说非法"的矛盾，所以这里一处牌型逻辑都没有。
 *
 * 2. **手牌是隐藏信息。** 服务端只给本人 myHand，别人的只有 handCounts（张数）。
 *    界面上不可能也不应该显示别人的牌，这是设计使然。所有覆盖本地状态的地方都以
 *    服务端裁剪过的视图为准，绝不去拼凑别人的手牌。
 *
 * 3. **以服务端返回的 room 为准直接覆盖本地。** 自己出的牌也会通过 SSE 回到自己这里，
 *    如果去"判断这条事件是不是我自己发的"，就得处理重复与乱序。整体覆盖是幂等的 ——
 *    不需要去重，也天然容忍乱序。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type DdzCard, type DdzPhase, type DdzRoom, type DdzSeat } from '@/api'
import { useUi } from '@/stores/ui'
import { useRealtime, type RealtimeEventName } from '@/stores/realtime'

/** 实时事件的取消函数，重复订阅时先解绑旧的，避免处理器越挂越多。 */
let offRealtime: Array<() => void> = []

/**
 * 出牌事件名。
 *
 * ⚠️ 这里曾经写着 `'game-play' as RealtimeEventName`，注释还解释说
 * "断言只影响编译期类型，运行期传的就是这个字符串" —— **那个说法是错的**，
 * 而且它掩盖了一个真实的故障。
 *
 * 原因：共享的 realtime store 是遍历 `KNOWN_EVENTS` 数组去
 * `source.addEventListener(...)` 的。事件名不在那个数组里，
 * **根本就不会注册监听**，挂上来的处理器永远等不到调用。
 * 于是斗地主的"出牌"推送一次都没送达过前端 —— 对手出牌后你的界面不会更新，
 * 而类型断言把这个错误在编译期盖住了。
 *
 * 现在 'game-play' 已经在 KNOWN_EVENTS 里，直接用字面量即可。
 * scripts/realtime-test.mjs 里有一条断言专门盯着这件事：
 * 服务端能发的事件名必须都能在前端的事件表里找到。
 */
const GAME_PLAY = 'game-play' satisfies RealtimeEventName

/** 各座位的展示信息（供 getters.seatInfo 返回）。 */
export interface DdzSeatInfo {
  seat: number
  name: string
  count: number
  isLandlord: boolean
  isMe: boolean
  online: boolean
  isCurrent: boolean
}

interface State {
  rooms: DdzRoom[]
  /** 当前打开的牌局；为 null 时界面显示大厅。 */
  room: DdzRoom | null
  loading: boolean
  /** 正在提交操作（出牌/叫地主等），用于禁用按钮防止连点。 */
  submitting: boolean
  error: string | null
  /** 我当前选中的牌 id。 */
  selectedIds: number[]
  /** 当前正在展示的提示序号（点"提示"时递增，取模循环）。 */
  hintIndex: number
  /** 实时连接是否正常，界面据此提示"连接已断开"。 */
  connected: boolean
}

interface RealtimeRoomPayload {
  roomId?: string
  room?: DdzRoom
}

export const useDdz = defineStore('ddz', {
  state: (): State => ({
    rooms: [],
    room: null,
    loading: false,
    submitting: false,
    error: null,
    selectedIds: [],
    hintIndex: 0,
    connected: false,
  }),

  getters: {
    /** 我的手牌；观战或未发牌时为空数组。 */
    myHand: (state): DdzCard[] => state.room?.myHand ?? [],

    /** 按手牌顺序取出选中的牌，便于出牌时保持稳定顺序。 */
    selectedCards: (state): DdzCard[] => {
      const hand = state.room?.myHand ?? []
      const selected = new Set(state.selectedIds)
      return hand.filter((card) => selected.has(card.id))
    },

    isMyTurn: (state): boolean => state.room?.myTurn === true,

    /** 可以出牌且已经选了牌。 */
    canPlay: (state): boolean => state.room?.myTurn === true && state.selectedIds.length > 0,

    mySeat: (state): number | null => state.room?.mySeat ?? null,

    landlordSeat: (state): number | null => state.room?.landlord ?? null,

    amLandlord: (state): boolean =>
      state.room !== null &&
      state.room.landlord !== null &&
      state.room.landlord === state.room.mySeat,

    phase: (state): DdzPhase | null => state.room?.phase ?? null,

    /** 三个座位各自的显示信息。 */
    seatInfo: (state): DdzSeatInfo[] => {
      const room = state.room
      if (!room) return []
      return room.seats.map((seat: DdzSeat) => ({
        seat: seat.seat,
        name: seat.name ?? `座位 ${seat.seat + 1}`,
        count: room.handCounts[seat.seat] ?? 0,
        isLandlord: room.landlord === seat.seat,
        isMe: room.mySeat === seat.seat,
        online: seat.online,
        isCurrent: room.current === seat.seat,
      }))
    },

    /** 用于界面顶部的一句话状态。 */
    statusText: (state): string => {
      const room = state.room
      if (!room) return ''

      // 未入座即观战，没有操作权
      if (room.mySeat === null) return '观战中'

      if (room.phase === 'waiting') {
        const taken = room.seats.filter((s) => s.userId !== null).length
        const missing = Math.max(0, 3 - taken)
        return `等待其他玩家加入（还差 ${missing} 人）`
      }

      if (room.phase === 'bidding') {
        return room.canBid ? '轮到你叫地主' : '等待其他人叫地主'
      }

      if (room.phase === 'playing') {
        if (room.myTurn) return room.lastPlay ? '轮到你出牌' : '轮到你出牌（你是首出）'
        return '等待其他玩家出牌'
      }

      if (room.phase === 'finished') {
        if (!room.result) return '对局结束'
        return room.result.landlordWon ? '地主获胜' : '农民获胜'
      }

      return ''
    },
  },

  actions: {
    // ------------------------------------------------------------ 实时

    /**
     * 订阅实时事件。
     *
     * 连接本身由 '@/stores/realtime' 持有（整个应用只有一条 SSE，聊天和游戏共用），
     * 这里只注册"收到事件后怎么改斗地主状态"。重复调用是安全的：先解绑旧订阅再重绑。
     */
    connectRealtime(): void {
      if (offRealtime.length > 0) {
        for (const off of offRealtime) off()
        offRealtime = []
      }

      const rt = useRealtime()
      rt.connect()
      this.connected = rt.connected

      offRealtime = [
        rt.onStatus((connected) => {
          this.connected = connected
        }),
        // 重连成功后补拉一次，因为断线期间的事件已经丢了
        rt.onResync(() => {
          void this.loadRooms()
          if (this.room) void this.reload()
        }),
        // 有人出牌 / 要不起：payload.room 是按我的视角裁剪过的，直接覆盖即可
        rt.on(GAME_PLAY, (data) => {
          const payload = data as RealtimeRoomPayload | null
          const room = payload?.room
          if (!room) return

          // 覆盖前先记下是否已经结束，避免同一次结束重复弹提示
          const wasFinished = this.room?.id === room.id && this.room.result !== null
          if (this.room && room.id === this.room.id) {
            this.applyRoom(room)
          }
          this.upsertRoom(room)
          if (room.result && !wasFinished) notifyResult(room)
        }),
        // 房间状态变化（加入、离开、叫地主、创建等）
        rt.on('game', (data) => {
          const payload = data as RealtimeRoomPayload | null
          const room = payload?.room
          if (room && this.room && room.id === this.room.id) {
            const wasFinished = this.room.result !== null
            this.applyRoom(room)
            if (room.result && !wasFinished) notifyResult(room)
          }
          // 房间的增删改都可能发生，直接重拉列表最省心
          void this.loadRooms()
        }),
      ]
    },

    /**
     * 用服务端视图覆盖当前房间，并清掉已经失效的选中牌。
     *
     * 别人的出牌不会动我的牌，但我自己出牌后手里那几张就没了 —— 这时选中的 id
     * 已经不在手牌里，必须移除，否则会残留一个看不见的选中项。
     */
    applyRoom(room: DdzRoom): void {
      this.room = room
      const handIds = new Set((room.myHand ?? []).map((card) => card.id))
      if (this.selectedIds.some((id) => !handIds.has(id))) {
        this.selectedIds = this.selectedIds.filter((id) => handIds.has(id))
      }
    },

    /** 把房间写回列表（有则替换、无则插入到最前）。 */
    upsertRoom(room: DdzRoom): void {
      const index = this.rooms.findIndex((r) => r.id === room.id)
      if (index >= 0) this.rooms[index] = room
      else this.rooms.unshift(room)
    },

    // ------------------------------------------------------------ 数据

    async loadRooms(): Promise<void> {
      this.loading = true
      try {
        const result = await api.ddz.rooms()
        this.rooms = result.rooms
        this.error = null
      } catch (err) {
        const message = messageOf(err, '加载牌局列表失败')
        this.error = message
        useUi().notify('error', '加载牌局列表失败', message)
      } finally {
        this.loading = false
      }
    },

    async createRoom(title?: string): Promise<DdzRoom> {
      try {
        const result = await api.ddz.createRoom(title)
        this.room = result.room
        this.clearSelection()
        this.hintIndex = 0
        await this.loadRooms()
        useUi().notify('success', '牌局已创建', '把房间名发给好友，凑齐三人即可开局')
        return result.room
      } catch (err) {
        const message = messageOf(err, '创建牌局失败')
        this.error = message
        useUi().notify('error', '创建牌局失败', message)
        throw err
      }
    },

    async openRoom(id: string): Promise<void> {
      try {
        const result = await api.ddz.getRoom(id)
        this.room = result.room
        this.clearSelection()
        this.hintIndex = 0
        this.error = null
      } catch (err) {
        const message = messageOf(err, '打开牌局失败')
        this.error = message
        useUi().notify('error', '打开牌局失败', message)
      }
    },

    async joinRoom(id: string): Promise<void> {
      try {
        const result = await api.ddz.join(id)
        this.room = result.room
        this.clearSelection()
        this.hintIndex = 0
        await this.loadRooms()
        useUi().notify('success', '已加入牌局')
      } catch (err) {
        const message = messageOf(err, '加入牌局失败')
        this.error = message
        useUi().notify('error', '加入失败', message)
      }
    },

    // ------------------------------------------------------------ 叫地主

    async bid(call: boolean): Promise<void> {
      const room = this.room
      if (!room) return
      if (this.submitting) return
      this.submitting = true
      const roomId = room.id
      try {
        const result = await api.ddz.bid(roomId, call)
        if (this.room && this.room.id === roomId) this.room = result.room
        this.hintIndex = 0
        this.error = null
        useUi().notify('info', call ? '已叫地主' : '不叫地主')
      } catch (err) {
        const message = messageOf(err, '叫地主失败')
        this.error = message
        useUi().notify('error', '叫地主失败', message)
      } finally {
        this.submitting = false
      }
    },

    // ------------------------------------------------------------ 出牌

    async playSelected(): Promise<void> {
      const room = this.room
      if (!room) return
      if (this.submitting) return
      if (this.selectedIds.length === 0) return

      this.submitting = true
      const roomId = room.id
      const cardIds = [...this.selectedIds]
      try {
        const result = await api.ddz.play(roomId, cardIds)
        if (this.room && this.room.id === roomId) this.room = result.room
        this.clearSelection()
        this.hintIndex = 0
        this.upsertRoom(result.room)
        this.error = null
        // 出牌成功只提示出了什么牌；胜负结果由 SSE 事件统一提示，避免重复
        useUi().notify('success', '已出牌', result.typeLabel)
      } catch (err) {
        // 服务端判定不合法：保留选中，让用户可以改选重试
        const message = messageOf(err, '出牌失败')
        this.error = message
        useUi().notify('error', '出牌失败', message)
      } finally {
        this.submitting = false
      }
    },

    async passTurn(): Promise<void> {
      const room = this.room
      if (!room) return
      if (this.submitting) return
      this.submitting = true
      const roomId = room.id
      try {
        const result = await api.ddz.pass(roomId)
        if (this.room && this.room.id === roomId) this.room = result.room
        this.clearSelection()
        this.hintIndex = 0
        this.error = null
        useUi().notify('info', '要不起')
      } catch (err) {
        const message = messageOf(err, '要不起失败')
        this.error = message
        useUi().notify('error', '操作失败', message)
      } finally {
        this.submitting = false
      }
    },

    async leaveRoom(id: string): Promise<void> {
      try {
        const result = await api.ddz.leave(id)
        // 房间可能因无人而解散（返回 null），那时回到大厅
        if (this.room && this.room.id === id) this.room = result.room ?? null
        this.clearSelection()
        this.hintIndex = 0
        await this.loadRooms()
      } catch (err) {
        const message = messageOf(err, '退出牌局失败')
        this.error = message
        useUi().notify('error', '退出失败', message)
      }
    },

    /** 重新拉取当前房间（断线重连或手动刷新时用）。 */
    async reload(): Promise<void> {
      const room = this.room
      if (!room) return
      try {
        const result = await api.ddz.getRoom(room.id)
        // 用 applyRoom 而非直接覆盖：保留仍然有效的选中牌
        if (this.room && this.room.id === room.id) this.applyRoom(result.room)
        this.error = null
      } catch (err) {
        const message = messageOf(err, '刷新牌局失败')
        this.error = message
        useUi().notify('error', '刷新失败', message)
      }
    },

    // ------------------------------------------------------------ 选牌

    /**
     * 选中 / 取消一张牌。
     *
     * 这里刻意**不判断牌型是否合法** —— 服务端会判，前端判反而容易与服务端不一致。
     */
    toggleCard(cardId: number): void {
      const index = this.selectedIds.indexOf(cardId)
      if (index >= 0) this.selectedIds.splice(index, 1)
      else this.selectedIds.push(cardId)
    },

    clearSelection(): void {
      this.selectedIds = []
    },

    /**
     * 用服务端给的提示自动选中一组牌；连续调用会依次切到下一个提示。
     */
    applyHint(): void {
      const room = this.room
      if (!room) return

      const hints = room.hints
      if (hints.length === 0) {
        useUi().notify('info', '没有能管上的牌', '当前这手牌压不过对方，只能选择不出')
        return
      }

      const hint = hints[this.hintIndex % hints.length] ?? []
      this.hintIndex += 1

      // 把提示里的牌面文字映射回手牌 id。同名牌最多四张，按手牌顺序取尚未被本次
      // 选中的那一张，避免同一张牌被选两次。
      const myHand = room.myHand ?? []
      const used = new Set<number>()
      const picked: number[] = []
      for (const label of hint) {
        const card = myHand.find((c) => c.label === label && !used.has(c.id))
        if (card) {
          used.add(card.id)
          picked.push(card.id)
        }
      }
      this.selectedIds = picked
    },

    /**
     * 手牌排序：按点数从大到小（大牌在左，符合习惯），同点数按花色聚在一起。
     * 只返回本地排序后的副本，不改动服务端数据。
     */
    sortedHand(): DdzCard[] {
      const hand = this.room?.myHand ?? []
      return [...hand].sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank
        return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]
      })
    },
  },
})

// ---------------------------------------------------------------- 辅助

/** 同点数时的花色顺序（仅用于把花色聚在一起，不代表大小）。 */
const SUIT_ORDER: Record<DdzCard['suit'], number> = {
  spade: 0,
  heart: 1,
  club: 2,
  diamond: 3,
  joker: 4,
}

/** 统一取出错误信息：优先用后端返回的真实 message。 */
function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

/**
 * 结算原因码的中文映射。
 *
 * ⚠️ 这份表和 DoudizhuApp.vue「反馈纯函数区」里的 reasonLabel 是**同一份内容**，
 * 之所以存在两处：结果条由组件渲染、Toast 由 store 在收到 SSE 时直接弹，
 * 两条路径不经过同一个函数。改动时两边都要改。
 *
 * 这里曾经直接把服务端的英文码当副标题递给通知，用户看到的是
 * 「地主获胜 · emptied」—— 该说人话的地方说了代码。
 */
const DDZ_REASON_LABELS: Record<string, string> = {
  emptied: '手牌出完',
  abandon: '对手离场',
}

/** 对局结束时提示地主 / 农民获胜。 */
function notifyResult(room: DdzRoom): void {
  const result = room.result
  if (!result) return
  // 认不出的原因码就**原样透出**，不要吞掉 —— 将来服务端加了新原因，
  // 至少还能看见它是什么，而不是变成一句空话
  const detail = DDZ_REASON_LABELS[result.reason] ?? result.reason
  useUi().notify('info', result.landlordWon ? '地主获胜' : '农民获胜', detail)
}
