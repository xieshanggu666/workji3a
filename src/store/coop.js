import { defineStore } from 'pinia'
import { api, getToken, setToken } from '@/api'
import { useGameStore, connectRealtime, disconnectRealtime } from './game.js'

// stage：
//   loading   启动检测中
//   needClaim 旧单机存档待认领（第一个玩家自动成为农场主）
//   needAuth  需要登录/注册
//   needJoin  已注册但尚未加入农场（可输邀请码直接加入 / 用农场码申请）
//   pending   已提交申请，等待管理员审批
//   in        已在农场中，进入游戏
export const useCoopStore = defineStore('coop', {
  state: () => ({
    stage: 'loading',
    token: getToken(),
    user: null,           // 未入农场时的注册信息
    coop: null,           // 共营面板状态（farm/me/members/invites/requests/audit/online）
    joinCode: '',
    requestCode: '',
    requestMsg: '',
    newName: '',
    inviteUses: 1,
    inviteDays: 7,
    error: ''
  }),
  getters: {
    me: (s) => s.coop?.me || null,
    caps: (s) => s.coop?.me?.caps || null,
    members: (s) => s.coop?.members || [],
    invites: (s) => s.coop?.invites || [],
    requests: (s) => s.coop?.requests || [],
    audit: (s) => s.coop?.audit || [],
    farm: (s) => s.coop?.farm || null,
    activeMembers: (s) => (s.coop?.members || []).filter((m) => m.status === 'active'),
    pendingRequests: (s) => (s.coop?.requests || []).filter((r) => r.status === 'pending')
  },
  actions: {
    setError(msg) { this.error = msg || '' },

    // 启动引导：token + 农场归属决定进入哪个界面（兼容旧单人存档自动认领）
    async bootstrap() {
      this.stage = 'loading'
      try {
        const d = await api('/coop/bootstrap')
        if (d.stage === 'in') {
          this.token = getToken()
          this.coop = d.state
          await this.enterGame()
        } else if (d.stage === 'needJoin') {
          this.user = d.user
          this.stage = 'needJoin'
        } else if (d.stage === 'needClaim') {
          // 旧单人存档：无需任何输入，直接认领为本机农场主
          await this.claim()
        } else {
          this.stage = 'needAuth'
        }
      } catch (e) {
        this.stage = 'needAuth'
        this.error = e.message
      }
    },

    async claim() {
      const d = await api('/coop/claim', 'POST')
      setToken(d.token)
      this.token = d.token
      this.coop = d.state
      await this.enterGame()
    },

    async register() {
      this.setError('')
      try {
        const d = await api('/coop/register', 'POST', { name: this.newName.trim() })
        setToken(d.token)
        this.token = d.token
        this.user = d.user
        this.stage = 'needJoin'
      } catch (e) { this.setError(e.message) }
    },

    async joinByCode() {
      this.setError('')
      try {
        const d = await api('/coop/join', 'POST', { code: this.joinCode.trim() })
        this.coop = d.state
        await this.enterGame()
      } catch (e) {
        // 农场码（申请制）不能直接加入时，引导用户改走申请流程
        if (e.status === 404) this.setError('邀请码无效；如拿到的是农场码请改用下方「申请加入」')
        else this.setError(e.message)
      }
    },

    async requestJoin() {
      this.setError('')
      try {
        await api('/coop/request', 'POST', { code: this.requestCode.trim(), message: this.requestMsg.trim() })
        this.stage = 'pending'
      } catch (e) {
        if (e.status === 409) this.stage = 'pending'
        else this.setError(e.message)
      }
    },

    // 等待审批期间轮询（SSE 只对农场成员开放），获批后自动进游戏
    async pollPending() {
      try {
        const d = await api('/coop/bootstrap')
        if (d.stage === 'in') {
          this.coop = d.state
          await this.enterGame()
        }
      } catch { /* 稍后重试 */ }
    },

    async enterGame() {
      const game = useGameStore()
      if (this.coop) {
        game.caps = this.coop.me.caps
        game.me = this.coop.me
        game.farm = this.coop.farm
      }
      await game.load()
      if (this.coop) {
        game.caps = this.coop.me.caps
        game.me = this.coop.me
        game.farm = this.coop.farm
      }
      this.stage = 'in'
      connectRealtime(game)
    },

    async refreshCoop() {
      try {
        const d = await api('/coop/state')
        this.coop = d
        const game = useGameStore()
        game.caps = d.me.caps
        game.me = d.me
        game.farm = d.farm
      } catch (e) {
        if (e.status === 401 || e.status === 403) this.handleExited()
      }
    },

    // ===== 邀请/申请管理 =====
    async createInvite(kind) {
      const body = kind === 'share' ? { kind } : { kind: 'direct', usesMax: this.inviteUses, days: this.inviteDays }
      const d = await api('/coop/invite', 'POST', body)
      await this.refreshCoop()
      return d
    },
    async revokeInvite(id) {
      await api('/coop/invite/revoke', 'POST', { id })
      await this.refreshCoop()
    },
    async decideRequest(id, approve) {
      await api('/coop/request/decide', 'POST', { id, approve })
      await this.refreshCoop()
    },

    // ===== 成员管理 =====
    async setRole(userId, role) {
      await api('/coop/member/role', 'POST', { userId, role })
      await this.refreshCoop()
    },
    async kick(userId) {
      await api('/coop/member/kick', 'POST', { userId })
      await this.refreshCoop()
    },
    async transfer(userId) {
      await api('/coop/transfer', 'POST', { userId })
      await this.refreshCoop()
    },
    async leave() {
      await api('/coop/leave', 'POST')
      this.handleExited()
    },
    async dissolve() {
      await api('/coop/dissolve', 'POST')
      // 农场主解散后仍留在场内（回归单机），刷新面板即可
      await this.refreshCoop()
    },
    async renameFarm(name) {
      await api('/coop/farm/rename', 'POST', { name })
      await this.refreshCoop()
    },

    // 退出/被踢后的本地清理：回到加入界面，保留登录身份（可重新申请）
    handleExited() {
      const lastMe = this.coop?.me
      disconnectRealtime()
      const game = useGameStore()
      game.loaded = false
      game.caps = null
      game.me = null
      this.coop = null
      this.user = lastMe ? { id: lastMe.userId, name: lastMe.name } : (this.user || null)
      this.stage = 'needJoin'
    }
  }
})
