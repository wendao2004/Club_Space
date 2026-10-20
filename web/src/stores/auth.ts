/**
 * 登录态与站点信息。
 */
import { defineStore } from 'pinia'
import { api, ApiError, type Bootstrap, type CurrentUser } from '@/api'
import { useRealtime } from '@/stores/realtime'

interface State {
  ready: boolean
  siteName: string
  firstRun: boolean
  maxUploadBytes: number
  user: CurrentUser | null
  /** 已通过口令校验、等待动态口令的登录（两步登录的中间态）。 */
  pendingTotp: { challenge: string; displayName: string } | null
  error: string | null
}

export const useAuth = defineStore('auth', {
  state: (): State => ({
    ready: false,
    siteName: '社团空间',
    firstRun: false,
    // 0 = 不限（服务端默认）。真正保护机器的是磁盘余量守卫，不是单文件上限。
    maxUploadBytes: 0,
    user: null,
    pendingTotp: null,
    error: null,
  }),

  getters: {
    loggedIn: (state): boolean => state.user !== null,
    isAdmin: (state): boolean =>
      state.user?.role === 'admin' || state.user?.role === 'owner',
  },

  actions: {
    applyBootstrap(data: Bootstrap): void {
      this.siteName = data.siteName
      this.firstRun = data.firstRun
      this.maxUploadBytes = data.maxUploadBytes
      this.user = data.user
      document.title = data.siteName
    },

    async load(): Promise<void> {
      try {
        this.applyBootstrap(await api.bootstrap())
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
      } finally {
        this.ready = true
      }
    },

    async register(input: {
      username: string
      displayName: string
      password: string
      inviteCode?: string
    }): Promise<void> {
      const result = await api.register(input)
      this.user = result.user
      this.firstRun = false
    },

    /**
     * 登录。
     *
     * 可能是两步：账号绑定了两步验证时，第一次调用只会拿到一个挑战令牌
     * （服务端**不会**给会话），此时进入 pendingTotp 状态，由界面收集动态口令
     * 再调 submitTotp。返回 true 表示已经登录完成，false 表示还需要第二步。
     */
    async login(username: string, password: string): Promise<boolean> {
      const result = await api.login({ username, password })
      if ('needTotp' in result) {
        this.pendingTotp = { challenge: result.challenge, displayName: result.displayName }
        return false
      }
      this.user = result.user
      this.pendingTotp = null
      return true
    },

    /** 两步登录的第二步：用动态口令换会话。 */
    async submitTotp(code: string): Promise<void> {
      if (!this.pendingTotp) throw new Error('没有待完成的两步验证')
      const result = await api.loginTotp(this.pendingTotp.challenge, code)
      this.user = result.user
      this.pendingTotp = null
    },

    /** 放弃第二步（返回登录页）。 */
    cancelTotp(): void {
      this.pendingTotp = null
    },

    async logout(): Promise<void> {
      // 先断开实时流，再请求后端。
      //
      // 服务端现在也会在登出时主动关闭这条 SSE（见 server/src/auth.ts 的
      // destroySession），但客户端不该等它：
      //   1. 断开是即时的，用户点了"注销"就不该再多收哪怕一条消息；
      //   2. EventSource 在 cookie 被清掉之后会自动重连 → 401 → 再重连，
      //      在控制台和网络面板留下一串无意义的请求。
      // 主动 close 是确定性的，不依赖服务端行为的时序。
      useRealtime().disconnect()
      try {
        await api.logout()
      } catch (err) {
        // 后端已经失效（比如会话过期）时也要把本地状态清掉，否则界面会卡在"已登录"
        if (!(err instanceof ApiError)) throw err
      }
      this.user = null
    },

    /** 某个请求返回 401 时调用：把界面切回登录页。 */
    handleUnauthorized(): void {
      // 会话已经不可用了，那条 SSE 继续挂着只会不断收到 401 重连失败。
      useRealtime().disconnect()
      this.user = null
    },
  },
})
