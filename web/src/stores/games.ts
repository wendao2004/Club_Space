/**
 * 中国象棋的状态管理。
 *
 * 几条贯穿全文件的原则：
 *
 * 1. **服务端权威。** 本地从不"自己判断这一步合不合法"，只提交意图
 *    （api.games.move），由服务端用规则引擎裁定。前端算的合法性一概不采信。
 *
 * 2. **以服务端返回的 room 为准直接覆盖本地。** 自己走的那一步也会通过 SSE
 *    回到自己这里，如果去"判断这条事件是不是我自己发的"，就得处理重复与乱序。
 *    而整体覆盖是幂等的 —— 不需要去重，也天然容忍乱序。
 *
 * 3. **坐标与序列化字符串的行序是反的。** 坐标的 rank 从红方底线往上数（红帅 e0），
 *    而 board 字符串的第 0 行是黑方底线（rank 9）。换算：row = 9 - rank。
 *    这是最容易写反的地方，所以 pieceAt 与 squareToIndex 只在这一处做转换。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type GameColor, type GameMove, type GameRoom, type GameStats } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useRealtime } from '@/stores/realtime'

/** 实时事件的取消函数，组件卸载时统一解绑。 */
let offRealtime: Array<() => void> = []

interface State {
  rooms: GameRoom[]
  /** 当前打开的对局；为 null 时界面显示大厅。 */
  room: GameRoom | null
  stats: GameStats | null
  loading: boolean
  error: string | null
  /** 已选中的格子坐标（"e0" 形式）。 */
  selected: string | null
  /** 选中棋子的合法目标格。 */
  targets: string[]
  /** 正在提交落子，用于禁用棋盘防止连点。 */
  submitting: boolean
  /** 最后一手，用于棋盘高亮。 */
  lastMove: { from: string; to: string } | null
  /** 实时连接是否正常，界面据此提示"连接已断开"。 */
  connected: boolean
}

const EMPTY_STATS: GameStats = { played: 0, won: 0, lost: 0 }

/**
 * 按**当前登录用户**重算房间视角。
 *
 * 服务端返回的 room 里有两个字段是因人而异的：
 *   - mySide —— 我坐哪一边（观战为 null）
 *   - myTurn —— 是否轮到我走
 *
 * 单点接口（openRoom / joinRoom / makeMove 的响应）本来就是按请求者算的，
 * 不需要处理。但 **SSE 推送**曾经出过事：服务端用 broadcast 把同一份 payload
 * 发给所有人，于是对手收到的是"落子者视角"的那一份 —— mySide 变成对面、
 * myTurn 恒为 false，棋盘上下颠倒且一步也点不动。
 *
 * 服务端那边已经改成按人推送了（见 pushXiangqiRoom）。这里再按当前用户重算
 * 一次，是**防御性**的：视角字段算错的代价是"整盘棋玩不了"，
 * 而重算是纯函数、零成本，没有理由不兜这一层。
 */
function viewerRoom(room: GameRoom): GameRoom {
  const userId = useAuth().user?.id ?? null
  const mySide: GameColor | null =
    room.redPlayer && room.redPlayer === userId
      ? 'red'
      : room.blackPlayer && room.blackPlayer === userId
        ? 'black'
        : null
  return {
    ...room,
    mySide,
    myTurn: room.status === 'playing' && mySide !== null && mySide === room.turn,
  }
}

export const useGames = defineStore('games', {
  state: (): State => ({
    rooms: [],
    room: null,
    stats: null,
    loading: false,
    error: null,
    selected: null,
    targets: [],
    submitting: false,
    lastMove: null,
    connected: false,
  }),

  getters: {
    waitingRooms: (state): GameRoom[] => state.rooms.filter((r) => r.status === 'waiting'),
    playingRooms: (state): GameRoom[] => state.rooms.filter((r) => r.status === 'playing'),
    finishedRooms: (state): GameRoom[] => state.rooms.filter((r) => r.status === 'finished'),

    /** 我在等人加入（我坐了一边、另一边还空着）。 */
    waitingForOpponent: (state): boolean =>
      state.room !== null &&
      state.room.status === 'waiting' &&
      state.room.mySide !== null,

    myTurn: (state): boolean => state.room?.myTurn === true,

    /**
     * 被将军的那一方。
     *
     * 服务端只给一个 inCheck 布尔值，被将军的是"当前该走的那一方" ——
     * 因为只有走棋的一方才可能被将军（对方刚走完形成的）。
     */
    checkedSide: (state): GameColor | null => {
      if (!state.room || !state.room.inCheck) return null
      return state.room.turn
    },

    statsOrEmpty: (state): GameStats => state.stats ?? EMPTY_STATS,
  },

  actions: {
    // ------------------------------------------------------------ 实时

    /**
     * 订阅实时事件。
     *
     * 连接本身由 '@/stores/realtime' 持有（整个应用只有一条 SSE，
     * 聊天和游戏共用），这里只注册"收到事件后怎么改游戏状态"。
     * 重复调用是安全的：先把旧订阅解绑再重绑。
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
          if (this.room) void this.openRoom(this.room.id)
        }),
        rt.on('game-move', (data) => {
          const payload = data as {
            roomId: string
            move: GameMove
            room: GameRoom
            finished: { winner: GameColor | null; reason: string } | null
          }
          if (!payload?.room) return
          const view = viewerRoom(payload.room)

          // 整盘覆盖：自己走的那一步也会回到这里，覆盖是幂等的，不需要去重
          if (this.room && payload.roomId === this.room.id) {
            this.room = view
            this.lastMove = { from: payload.move.from, to: payload.move.to }
            this.clearSelection()
          }

          // 列表里那一项也同步更新，避免切回大厅时看到过期状态
          const index = this.rooms.findIndex((r) => r.id === payload.roomId)
          if (index >= 0) this.rooms[index] = view
          else this.rooms.unshift(view)

          if (payload.finished) {
            const winnerName = payload.finished.winner === 'red' ? '红方' : '黑方'
            const reasonText = REASON_LABELS[payload.finished.reason] ?? payload.finished.reason
            useUi().notify('info', `${winnerName}获胜`, reasonText)
            void this.loadRooms()
          }
        }),
        rt.on('game', (data) => {
          const payload = data as { action: string; roomId: string; room: GameRoom | null }
          if (this.room && payload?.roomId === this.room.id) {
            // room 为 null 表示这个房间已经不存在了（人都走光了）——
            // 退回大厅，而不是继续显示一个已经不存在的对局。
            this.room = payload.room ? viewerRoom(payload.room) : null
            if (!this.room) this.clearSelection()
          }
          // 房间的增删改都可能发生，直接重拉列表最省心
          void this.loadRooms()
        }),
      ]
    },

    // ------------------------------------------------------------ 数据

    async loadRooms(): Promise<void> {
      this.loading = true
      try {
        const result = await api.games.rooms()
        this.rooms = result.rooms
        this.stats = result.stats
        this.error = null
      } catch (err) {
        this.error = err instanceof Error ? err.message : '加载对局列表失败'
      } finally {
        this.loading = false
      }
    },

    async openRoom(id: string): Promise<void> {
      try {
        const result = await api.games.getRoom(id)
        this.room = result.room
        this.clearSelection()
        // 用最后一手初始化高亮，这样刷新/重进房间后仍能看到上一步落在哪
        const last = result.room.moves[result.room.moves.length - 1]
        this.lastMove = last ? { from: last.from, to: last.to } : null
        this.error = null
      } catch (err) {
        this.error = err instanceof Error ? err.message : '打开对局失败'
        throw err
      }
    },

    async createRoom(input: { title?: string; side?: GameColor } = {}): Promise<GameRoom> {
      try {
        const result = await api.games.createRoom({
          kind: 'xiangqi',
          title: input.title,
          side: input.side,
        })
        this.room = result.room
        this.clearSelection()
        this.lastMove = null
        await this.loadRooms()
        useUi().notify('success', '对局已创建', '把房间名发给对手，等对方加入')
        return result.room
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '创建对局失败'
        this.error = message
        useUi().notify('error', '创建对局失败', message)
        throw err
      }
    },

    async joinRoom(id: string, side?: GameColor): Promise<void> {
      try {
        const result = await api.games.joinRoom(id, side)
        this.room = result.room
        this.clearSelection()
        await this.loadRooms()
        useUi().notify('success', result.room.status === 'playing' ? '对局开始' : '已加入，等待对手')
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '加入对局失败'
        this.error = message
        useUi().notify('error', '加入失败', message)
        throw err
      }
    },

    /**
     * 退出房间。
     *
     * 对局中退出会被服务端判定为认输（残局无法继续），这一点在界面上要
     * 提前告知用户，所以这里在调用前先确认一次。
     */
    async leaveRoom(id: string): Promise<void> {
      const current = this.room
      if (current && current.status === 'playing' && current.mySide) {
        const confirmed = window.confirm('对局进行中，退出将被判负。确定要退出吗？')
        if (!confirmed) return
      }
      try {
        const result = await api.games.leave(id)
        this.room = result.room ?? null
        this.clearSelection()
        this.lastMove = null
        await this.loadRooms()
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '退出房间失败'
        this.error = message
        useUi().notify('error', '退出失败', message)
      }
    },

    // ------------------------------------------------------------ 走棋

    async makeMove(from: string, to: string): Promise<void> {
      if (!this.room) return
      if (this.submitting) return
      this.submitting = true
      const roomId = this.room.id
      try {
        const result = await api.games.move(roomId, from, to)
        // 以服务端返回的为准（本地不预先改盘，避免和服务端不一致）
        if (this.room && this.room.id === roomId) {
          this.room = result.room
          this.lastMove = { from: result.move.from, to: result.move.to }
        }
        this.clearSelection()
        const index = this.rooms.findIndex((r) => r.id === roomId)
        if (index >= 0) this.rooms[index] = result.room

        if (result.finished) {
          const winnerName = result.finished.winner === 'red' ? '红方' : '黑方'
          useUi().notify(
            'info',
            `${winnerName}获胜`,
            REASON_LABELS[result.finished.reason] ?? result.finished.reason,
          )
        }
      } catch (err) {
        // 服务端判定不合法：清掉目标高亮但保留选中，让用户可以改走别的
        this.targets = []
        const message = err instanceof ApiError ? err.message : '走棋失败'
        this.error = message
        useUi().notify('error', '这一步走不了', message)
      } finally {
        this.submitting = false
      }
    },

    async resign(): Promise<void> {
      if (!this.room) return
      const confirmed = window.confirm('确定认输吗？')
      if (!confirmed) return
      const roomId = this.room.id
      try {
        const result = await api.games.resign(roomId)
        if (this.room && this.room.id === roomId) this.room = result.room
        this.clearSelection()
        await this.loadRooms()
        useUi().notify('info', '已认输')
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '认输失败'
        this.error = message
        useUi().notify('error', '认输失败', message)
      }
    },

    // ------------------------------------------------------------ 选子

    /**
     * 点击棋盘上的一个格子。
     *
     * 所有"该落子还是该改选"的判断都收敛在这里，棋盘组件只负责 emit('select')。
     * 这样逻辑只有一份，不会出现棋盘与 store 各自判断、结果不一致的情况。
     */
    async clickSquare(square: string): Promise<void> {
      const room = this.room
      if (!room) return

      // 不是对局中、不是我走、或者我只是观战 —— 都不响应
      if (room.status !== 'playing' || !room.myTurn || !room.mySide) {
        this.clearSelection()
        return
      }

      const piece = this.pieceAt(room.board, square)
      const isMyPiece = isPieceOf(piece, room.mySide)
      const isTarget = this.targets.includes(square)

      // 已选中且点到合法目标 → 落子
      if (this.selected && isTarget) {
        const from = this.selected
        await this.makeMove(from, square)
        return
      }

      // 点到自己的另一个子 → 改选
      if (isMyPiece) {
        if (this.selected === square) {
          this.clearSelection()
          return
        }
        this.selected = square
        this.targets = []
        try {
          const result = await api.games.legal(room.id, square)
          // 拉取期间用户可能已经点了别的地方，确认仍是同一个选中才写入
          if (this.selected === square) this.targets = result.targets
        } catch {
          // 高亮只是辅助，拿不到就静默降级，不要弹错误打扰用户
        }
        return
      }

      // 点到空格或对方棋子但不在目标里 → 取消选中
      this.clearSelection()
    },

    clearSelection(): void {
      this.selected = null
      this.targets = []
    },

    // ------------------------------------------------------------ 坐标工具

    /**
     * 把坐标（"e0"）转成序列化字符串里的下标。
     *
     * board 字符串第 0 行是**黑方底线**（rank 9），而坐标的 rank 从红方底线往上数，
     * 所以 row = 9 - rank。这个翻转只在这里做一次，别处一律用本函数。
     */
    squareToIndex(square: string): { row: number; col: number } {
      const col = square.charCodeAt(0) - 97
      const rank = Number(square.slice(1))
      return { row: 9 - rank, col }
    },

    /** 取某格上的棋子字符；越界或空位返回 '.'。 */
    pieceAt(board: string, square: string): string {
      const { row, col } = this.squareToIndex(square)
      if (row < 0 || row > 9 || col < 0 || col > 8) return '.'
      const lines = board.split('/')
      const line = lines[row]
      if (!line) return '.'
      return line[col] ?? '.'
    },

    /** 该格是否是我的棋子（决定能不能选中）。 */
    canSelect(square: string): boolean {
      const room = this.room
      if (!room || !room.mySide || !room.myTurn) return false
      return isPieceOf(this.pieceAt(room.board, square), room.mySide)
    },
  },
})

// ---------------------------------------------------------------- 辅助

const REASON_LABELS: Record<string, string> = {
  checkmate: '将死',
  stalemate: '困毙（无棋可走判负）',
  resign: '对手认输',
  abandon: '对手离开',
  timeout: '超时',
  'no-legal-moves': '无棋可走',
}

/** 棋子字符是否属于某一方：大写是红方、小写是黑方。 */
function isPieceOf(piece: string, side: GameColor): boolean {
  if (!piece || piece === '.') return false
  const isRed = piece === piece.toUpperCase()
  return side === 'red' ? isRed : !isRed
}
