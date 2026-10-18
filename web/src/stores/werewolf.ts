/**
 * 狼人杀的状态管理。
 *
 * 一条贯穿全文件的原则：**前端不做任何规则判断**。
 *
 * "我现在能不能行动、能对谁行动"完全由服务端的 view 给出
 * （canAct / actionKind / legalTargets / canHeal / canPoison / canAbstain）。
 * 本地只是把这些字段渲染成按钮 —— 不自己推一遍"现在是不是该我"。
 *
 * 理由是狼人杀的规则比象棋复杂得多（夜晚分三个角色步骤、白天投票、
 * 猎人开枪挂起），在客户端重推一遍必然和服务端漂移；而漂移的表现是
 * "按钮亮着但点了报错"或者"该我动了但按钮是灰的"，两种都很难查。
 * 更要紧的是：任何本地推断都可能反过来变成"能算出别人身份"的漏洞。
 *
 * 另一个原则：**绝不猜测别人的身份**。服务端发来的 view 里压根没有这个信息，
 * 界面也就不该去"根据谁投了谁推测谁是狼"—— 那是玩家自己的事，不是代码的事。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type WerewolfRoom } from '@/api'
import { useUi } from '@/stores/ui'
import { useRealtime } from '@/stores/realtime'

/** 实时事件的取消函数，重复订阅时先解绑旧的。 */
let offRealtime: Array<() => void> = []

/** 大厅刷新防抖计时器（多个信号短时间到来时只拉一次）。 */
let lobbyTimer: number | null = null

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

interface State {
  rooms: WerewolfRoom[]
  /** 当前打开的房间；为 null 时显示大厅。 */
  room: WerewolfRoom | null
  loading: boolean
  submitting: boolean
  error: string | null
  /** 我在行动界面里选中的座位（提交前的高亮）。 */
  selectedTarget: number | null
  connected: boolean
}

export const useWerewolf = defineStore('werewolf', {
  state: (): State => ({
    rooms: [],
    room: null,
    loading: false,
    submitting: false,
    error: null,
    selectedTarget: null,
    connected: false,
  }),

  getters: {
    /** 在大厅里等人加入的房间。 */
    waitingRooms: (state): WerewolfRoom[] => state.rooms.filter((r) => r.phase === 'waiting'),
    playingRooms: (state): WerewolfRoom[] => state.rooms.filter((r) => r.phase !== 'waiting' && r.phase !== 'finished'),
    finishedRooms: (state): WerewolfRoom[] => state.rooms.filter((r) => r.phase === 'finished'),

    /** 我坐在座位上（不是观战）。 */
    seated: (state): boolean => state.room?.mySeat !== null && state.room?.mySeat !== undefined,

    /** 我是否已经出局。 */
    dead: (state): boolean => {
      const me = state.room?.players.find((p) => p.isMe)
      return !!me && !me.alive
    },

    /** 现在是夜晚。 */
    isNight: (state): boolean => state.room?.phase === 'night',

    /** 按座位号取人（界面里到处要用）。 */
    seatAt: (state) => (seat: number) => state.room?.players.find((p) => p.seat === seat) ?? null,

    /** 我的狼队友的座位（不是狼时为空）。 */
    myWolfPack: (state): number[] => {
      const t = state.room?.teammates
      if (!t || state.room?.mySeat === null || state.room?.mySeat === undefined) return t ?? []
      // 加上自己，界面里画"我们几个是狼"
      return [...t, state.room.mySeat].sort((a, b) => a - b)
    },
  },

  actions: {
    // ------------------------------------------------------------ 实时

    subscribe(): void {
      const rt = useRealtime()
      if (offRealtime.length > 0) return
      rt.connect()
      offRealtime = [
        rt.onStatus((connected) => {
          this.connected = connected
        }),
        // 重连后补拉：断线期间可能正好过了一个阶段
        rt.onResync(() => {
          void this.loadRooms()
          if (this.room) void this.openRoom(this.room.id, { silent: true })
        }),
        // 服务端只把房间推给**坐在里面的人**（观战者拉取即可），
        // 所以这里收到就意味着"我是玩家之一，房间状态变了"。
        // room 为 null 是一个特例：房间被解散了（房主退房），要把我请回大厅。
        rt.on('game-werewolf', (data) => {
          const payload = data as { roomId: string; room: WerewolfRoom | null; reason?: string }
          if (!payload?.room) {
            if (this.room && payload.roomId === this.room.id) {
              this.closeRoom()
              useUi().notify(
                'info',
                '房间已解散',
                payload.reason === 'creator-left'
                  ? '房主离开了房间，房间随之关闭'
                  : '房间已不存在',
              )
            }
            this.rooms = this.rooms.filter((r) => r.id !== payload.roomId)
            return
          }
          if (this.room && payload.roomId === this.room.id) {
            this.room = payload.room
            // 阶段或"该谁行动"变了，之前选中的目标就失效了
            this.selectedTarget = null
          }
          const index = this.rooms.findIndex((r) => r.id === payload.roomId)
          if (index >= 0) this.rooms[index] = payload.room
          else this.rooms.unshift(payload.room)
        }),
        // 大厅信号：有人建了/退了房间。载荷里没有房间内容（那不是给外人看的），
        // 只是"该刷新了"的敲门声 —— 找人开局不用再靠手动刷新或吼一嗓子。
        rt.on('game-werewolf-lobby', () => {
          if (lobbyTimer !== null) window.clearTimeout(lobbyTimer)
          lobbyTimer = window.setTimeout(() => {
            lobbyTimer = null
            void this.loadRooms()
          }, 300)
        }),
        // 房内新发言。单独一个事件名 —— 这里只更新房间、**不清空选中目标**：
        // 别人说句话不该让我的操作选择被抹掉（那正是 game-werewolf 与它分开的理由）。
        rt.on('game-werewolf-chat', (data) => {
          const payload = data as { roomId: string; room: WerewolfRoom }
          if (!payload?.room) return
          if (this.room && payload.roomId === this.room.id) this.room = payload.room
          const index = this.rooms.findIndex((r) => r.id === payload.roomId)
          if (index >= 0) this.rooms[index] = payload.room
        }),
      ]
    },

    unsubscribe(): void {
      for (const off of offRealtime) off()
      offRealtime = []
      if (lobbyTimer !== null) {
        window.clearTimeout(lobbyTimer)
        lobbyTimer = null
      }
    },

    // ------------------------------------------------------------ 数据

    async loadRooms(): Promise<void> {
      this.loading = true
      try {
        const res = await api.werewolf.rooms()
        this.rooms = res.rooms
        this.error = null
      } catch (err) {
        this.error = messageOf(err, '加载房间列表失败')
      } finally {
        this.loading = false
      }
    },

    async openRoom(id: string, options: { silent?: boolean } = {}): Promise<void> {
      try {
        const res = await api.werewolf.room(id)
        this.room = res.room
        this.selectedTarget = null
      } catch (err) {
        if (!options.silent) useUi().notify('error', '打开房间失败', messageOf(err, '未知错误'))
        this.room = null
      }
    },

    closeRoom(): void {
      this.room = null
      this.selectedTarget = null
    },

    // ------------------------------------------------------------ 房间

    async create(title: string, playerCount = 9): Promise<boolean> {
      return this.guard(async () => {
        const res = await api.werewolf.create(title, playerCount)
        // 建完直接把自己放进去，省一步"再点一次加入"
        await api.werewolf.join(res.room.id)
        await this.loadRooms()
        await this.openRoom(res.room.id, { silent: true })
        useUi().notify('success', '房间已创建', `等人坐满 ${playerCount} 个位子就会自动开局`)
        return true
      }, '创建房间失败')
    },

    async join(id: string): Promise<boolean> {
      return this.guard(async () => {
        const res = await api.werewolf.join(id)
        this.room = res.room
        await this.loadRooms()
        // 人凑齐（该房间设定的人数）时服务端会直接开局，这时要明确告诉玩家
        if (res.room.phase !== 'waiting' && this.room?.myRole) {
          useUi().notify('info', '人齐了，开局', `你的身份是「${res.room.myRoleLabel}」`)
        }
        return true
      }, '加入失败')
    },

    async leave(id: string): Promise<void> {
      try {
        await api.werewolf.leave(id)
        this.closeRoom()
        await this.loadRooms()
      } catch (err) {
        useUi().notify('error', '离开失败', messageOf(err, '未知错误'))
      }
    },

    // ------------------------------------------------------------ 行动

    select(seat: number | null): void {
      this.selectedTarget = seat
    },

    /**
     * 提交当前该做的动作。
     *
     * 统一走一个入口，是因为"现在能做什么"由服务端的 actionKind 决定；
     * 分成五个按钮各写一遍判断，迟早会出现"两个按钮都能点"的状态。
     */
    async act(): Promise<boolean> {
      const room = this.room
      if (!room || !room.canAct || room.actionKind === null) return false
      const target = this.selectedTarget

      return this.guard(async () => {
        switch (room.actionKind) {
          case 'kill':
            if (target === null) throw new Error('请选择要袭击的座位')
            await api.werewolf.kill(room.id, target)
            break
          case 'check':
            if (target === null) throw new Error('请选择要查验的座位')
            await api.werewolf.check(room.id, target)
            break
          case 'witch': {
            // 女巫有两个可选动作，按当前选择决定用哪一个：
            // 选中"今晚被刀的人"= 用解药；选中别人 = 用毒药。
            const victim = room.witchNightVictim
            if (target === victim && room.canHeal) {
              await api.werewolf.witch(room.id, { heal: true })
            } else if (target !== null && room.canPoison) {
              await api.werewolf.witch(room.id, { poisonTarget: target })
            } else {
              throw new Error('请选择要救的人或要毒的人；也可以选择不使用药水')
            }
            break
          }
          case 'vote':
            // 投票允许弃票（target 为 null）
            await api.werewolf.vote(room.id, target)
            break
          case 'shoot':
            if (target === null) throw new Error('请选择要带走的座位')
            await api.werewolf.shoot(room.id, target)
            break
        }
        this.selectedTarget = null
        await this.openRoom(room.id, { silent: true })
        return true
      }, '操作失败')
    },

    /** 本阶段弃权 / 不使用药水。 */
    async abstain(): Promise<boolean> {
      const room = this.room
      if (!room || !room.canAct || !room.canAbstain) return false
      return this.guard(async () => {
        if (room.actionKind === 'witch') await api.werewolf.witch(room.id, { heal: false, poisonTarget: null })
        else await api.werewolf.vote(room.id, null)
        this.selectedTarget = null
        await this.openRoom(room.id, { silent: true })
        return true
      }, '操作失败')
    },

    /**
     * 房内文字发言。
     *
     * 不做本地规则判断 —— 能不能发言由服务端的 canChat 决定，真正的拦截也在
     * 服务端（夜晚的非狼、出局者、观战者都会拿到 400）。发完用返回的 view
     * 立即更新，这样自己那条消息马上出现在列表里（不必等 SSE 推回来）。
     */
    async sendChat(text: string): Promise<boolean> {
      const room = this.room
      const content = text.trim()
      if (!room || !room.canChat || !content) return false
      return this.guard(async () => {
        const res = await api.werewolf.chat(room.id, content)
        this.room = res.room
        return true
      }, '发送失败')
    },

    /** 统一的提交包装：防连点 + 统一错误提示。 */
    async guard(fn: () => Promise<boolean>, failTitle: string): Promise<boolean> {
      if (this.submitting) return false
      this.submitting = true
      try {
        return await fn()
      } catch (err) {
        // 规则的拒绝理由（"现在不是你的回合""这个目标不合法"）都很有信息量，
        // 原样透出，不要替换成笼统的"操作失败"
        useUi().notify('error', failTitle, messageOf(err, '未知错误'))
        return false
      } finally {
        this.submitting = false
      }
    },
  },
})
