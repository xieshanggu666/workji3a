import { defineStore } from 'pinia'
import { api, getToken } from '@/api'

// 多端实时同步：远端世界写事件合并刷新（防抖），并广播 SSE 事件给 UI（如被踢下线）
const listeners = { auth: [] }
export function onCoopEvent(fn) { listeners.auth.push(fn); return () => { listeners.auth = listeners.auth.filter((f) => f !== fn) } }
function emitAuth(payload) { listeners.auth.forEach((fn) => fn(payload)) }
let syncTimer = null
let inflight = null
function scheduleSync(store) {
  if (syncTimer) return
  syncTimer = setTimeout(async () => {
    syncTimer = null
    if (!getToken()) return
    inflight = (inflight || Promise.resolve()).then(() => store.load({ silent: true })).catch(() => {})
  }, 200)
}

// 由 coop store 在登录/加入成功后开启；断线 EventSource 原生自动重连
let es = null
export function connectRealtime(store) {
  disconnectRealtime()
  if (!getToken()) return
  es = new EventSource('/api/coop/events?token=' + encodeURIComponent(getToken()))
  es.addEventListener('state', () => scheduleSync(store))
  es.addEventListener('coop', () => {
    scheduleSync(store)
    emitAuth({ type: 'coop' })
  })
  es.addEventListener('presence', (e) => {
    try { store.onlineUserIds = JSON.parse(e.data).online || [] } catch { /* ignore */ }
  })
  // 服务端主动踢下线（被移出农场/共营解散）：停止重连并通知 UI 回到加入界面
  es.addEventListener('kicked', () => {
    disconnectRealtime()
    emitAuth({ type: 'denied', error: '你已退出该农场' })
  })
  // 普通断线由 EventSource 自动重连；若令牌失效，load() 的 401 会接管引导流程
  es.onerror = () => { /* keep auto-retry */ }
}
export function disconnectRealtime() {
  if (es) { es.close(); es = null }
}

export const useGameStore = defineStore('game', {
  state: () => ({
    loaded: false,
    player: null,
    crops: [],
    varieties: [],
    inventory: [],
    buildings: [],
    animals: [],
    plots: [],
    weather: null,
    weatherLog: [],
    recipes: [],
    productionJobs: [],
    queueCapacity: 0,
    queuedBatches: 0,
    breeding: null,
    irrigation: [],
    irrigationCosts: { reservoir: 60, canal: 8 },
    irrigationNetworks: [],  // 供水网络概览（多池连通统一分水）
    irrigationReport: null,  // 最近一次每日供水分配结果（缺水时展示明细）
    irrBuildMode: null,      // 'reservoir' | 'canal' | null：地图放置模式
    selectedPlot: null,
    seedMode: false,
    selectedCropId: null,
    toast: null,
    timeline: [],
    me: null,                 // 当前玩家共营身份 {userId,name,role,online}
    farm: null,               // 农场信息 {name,coopEnabled,rev}
    onlineUserIds: [],        // 当前在线成员 userId 列表（SSE presence）
    caps: null                // 当前角色权限表（由 /api/coop/state 填充）
  }),
  getters: {
    // 权限检查：单机老界面默认全部放行（未完成共营引导时），共营模式严格以服务端下发的 caps 为准
    can() {
      return (domain) => {
        if (!this.caps) return true
        return !!this.caps[domain]
      }
    },
    isOwner: (s) => s.me?.role === 'owner',
    isAdminOrOwner: (s) => s.me?.role === 'owner' || s.me?.role === 'admin',
    seasonLabel: (s) => {
      const map = ['🌸 春', '☀️ 夏', '🍂 秋', '❄️ 冬']
      return s.player ? map[s.player.season % 4] : '🌸 春'
    },
    currentSeason: (s) => s.player?.season ?? 0,
    // 统一作物表：基础作物 + 杂交品种（id 均唯一）
    allCrops: (s) => {
      const vars = (s.varieties || []).map((v) => ({
        id: v.id, name: v.name, days: v.days, season: v.season,
        price: v.price, seedPrice: v.seed_price, sprite: v.sprite,
        traits: v.traits || [], gen: v.gen, base_id: v.base_id, isVariety: true
      }))
      return [...s.crops.map((c) => ({ ...c, traits: [], gen: 0, base_id: c.id, isVariety: false })), ...vars]
    }
  },
  actions: {
    async load(opts = {}) {
      let d
      try {
        d = await api('/state')
      } catch (e) {
        if (!opts.silent && e.status !== 401) this.showToast(e.message, 'warn')
        throw e
      }
      this.player = d.player
      this.crops = d.crops
      this.varieties = d.varieties || []
      this.inventory = d.inventory
      this.buildings = d.buildings
      this.animals = d.animals
      this.plots = d.plots
      this.weather = d.weather
      this.weatherLog = d.weatherLog || []
      this.recipes = d.recipes || []
      this.productionJobs = d.productionJobs || []
      this.queueCapacity = d.queueCapacity || 0
      this.queuedBatches = d.queuedBatches || 0
      this.breeding = d.breeding || null
      this.irrigation = d.irrigation || []
      this.irrigationCosts = d.irrigationCosts || this.irrigationCosts
      this.irrigationNetworks = d.irrigationNetworks || []
      this.irrigationReport = d.irrigationReport || null
      this.me = d.me || null
      this.farm = d.farm || null
      this.loaded = true
      return d
    },
    pushLog(msg, type = 'info') {
      this.timeline.unshift({ msg, type, time: new Date().toLocaleTimeString('zh-CN') })
      if (this.timeline.length > 30) this.timeline.pop()
    },
    showToast(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
      this.pushLog(msg, type)
    },
    clearToast() { this.toast = null },

    // 前端权限隔离（服务端仍会强制校验）：无权限直接拦截并提示
    guard(domain) {
      if (this.caps && !this.caps[domain]) {
        const who = this.caps.coopManage ? '管理员或农场主' : '管理员'
        this.showToast(`权限不足：该操作需要${who}`, 'warn')
        return false
      }
      return true
    },
    // 401/403 处理：被移出农场或令牌失效时通知共营层回到加入界面
    handleAuthError(e) {
      if (e?.status === 401 || e?.status === 403) emitAuth({ type: 'denied', error: e.message })
    },

    async refresh() { await this.load() },

    async plant() {
      if (!this.selectedPlot || !this.selectedCropId) return
      if (!this.guard('plant')) return
      try {
        await api('/plant', 'POST', { plotId: this.selectedPlot.id, cropId: this.selectedCropId })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async water() {
      if (!this.selectedPlot || !this.guard('plant')) return
      await api('/water', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async fertilize() {
      if (!this.selectedPlot || !this.guard('plant')) return
      await api('/fertilize', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async clean() {
      if (!this.selectedPlot || !this.guard('plant')) return
      await api('/clean', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async harvest() {
      if (!this.selectedPlot || !this.guard('plant')) return
      const r = await api('/harvest', 'POST', { plotId: this.selectedPlot.id })
      if (r.ok) this.showToast(`收获 ${r.yield} ×${r.qty || 1} +${r.gold}金${r.variety ? '🧬' : ''}`, 'success')
      else this.showToast('作物还未成熟', 'warn')
      await this.load()
    },
    async nextDay(n = 1) {
      if (!this.guard('time')) return
      try {
        const r = await api('/skip', 'POST', { n })
        await this.load({ silent: true })
        const logs = r.logs || []
      // 天气/系统结算记录只进时间线，不弹 toast；加工完工与育种成功取第一条弹提示
      logs.forEach((m) => { if (!m.startsWith('✅') && !m.startsWith('🧬')) this.pushLog(m, 'warn') })
      const done = logs.filter((m) => m.startsWith('✅') || m.startsWith('🧬'))
      if (done.length) this.showToast(done[0], 'success')
      else this.showToast(`时间 +${n} 天`, 'info')
      } catch (e) {
        this.handleAuthError(e)
        this.showToast(e.message, 'warn')
      }
    },
    async protect(gold, matQty) {
      if (!this.guard('disaster')) return
      try {
        await api('/weather/protect', 'POST', { gold, matQty })
        await this.load()
        this.showToast('已投入防护资源', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buyMat(qty = 1) {
      if (!this.guard('trade')) return
      try {
        await api('/buymat', 'POST', { qty })
        await this.load()
        this.showToast('已购入防灾物资', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buySeed(cropId, qty = 1) {
      if (!this.guard('trade')) return
      try {
        await api('/buyseed', 'POST', { cropId, qty })
        await this.load()
        this.showToast('已购买种子', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async sellCrop(cropId, qty = 1) {
      if (!this.guard('trade')) return
      try {
        const r = await api('/sellcrop', 'POST', { cropId, qty })
        await this.load()
        this.showToast(`售出${r.sold}，+${r.gain}金`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buyAnimal(species) {
      if (!this.guard('husbandry')) return
      try {
        await api('/animal', 'POST', { species })
        await this.load()
        this.showToast('已领养', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async feedAnimal(id) {
      if (!this.guard('husbandry')) return
      await api('/feed', 'POST', { id })
      await this.load()
    },
    async collectAnimal(id) {
      if (!this.guard('husbandry')) return
      try {
        const r = await api('/collect', 'POST', { id })
        await this.load()
        this.showToast(`收集 ${r.item} +${r.gold}金`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    // 批量排产
    async enqueueProduction(recipeId, qty) {
      if (!this.guard('production')) return
      try {
        await api('/production/enqueue', 'POST', { recipeId, qty })
        await this.load()
        this.showToast(`已排产 ${qty} 批，开工后按天自动推进`, 'success')
      } catch (e) { this.showToast(e.message, 'warn'); throw e }
    },
    // 取消工单（退未开工批次的原料，按实际投料原样退回杂交品种）
    async cancelProduction(id) {
      if (!this.guard('production')) return
      try {
        const r = await api('/production/cancel', 'POST', { id })
        await this.load()
        if (r.refundBatches > 0) {
          const items = (r.refunds || []).map((it) => `${it.name}×${it.qty}`).join('、')
          this.showToast(`已取消，退回 ${r.refundBatches} 批原料：${items}`, 'info')
        } else this.showToast('已取消（无未开工批次可退料）', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    // 完工入库：传 id 领单个，不传一键全领
    async collectProduction(id = null) {
      if (!this.guard('production')) return
      try {
        const r = await api('/production/collect', 'POST', id == null ? {} : { id })
        await this.load()
        const text = r.picked.map((p) => `${p.name}×${p.qty}`).join('、')
        this.showToast(`完工入库：${text}`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async upgradeBuilding(id) {
      if (!this.guard('buildings')) return
      try {
        await api('/upgrade', 'POST', { id })
        await this.load()
        this.showToast('建筑升级成功', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    // ===== 灌溉 =====
    // 进入/退出放置模式（再次点击同类按钮取消）
    setIrrBuildMode(kind) {
      this.irrBuildMode = this.irrBuildMode === kind ? null : kind
    },
    async buildIrrigation(kind, x, y) {
      if (!this.guard('irrigation')) return
      try {
        await api('/irrigation/build', 'POST', { kind, x, y })
        await this.load()
        this.showToast(kind === 'reservoir' ? '蓄水池已建成，铺设水渠连接地块吧' : '水渠已铺设', 'success')
        // 蓄水池一次一座；水渠保持模式可连续铺设
        if (kind === 'reservoir') this.irrBuildMode = null
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async toggleIrrigation(id) {
      if (!this.guard('irrigation')) return
      try {
        const r = await api('/irrigation/toggle', 'POST', { id })
        await this.load()
        this.showToast(r.active ? '已启用，恢复供水' : '已停用，供水网络断流', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async demolishIrrigation(id) {
      if (!this.guard('irrigation')) return
      try {
        const r = await api('/irrigation/demolish', 'POST', { id })
        await this.load()
        this.showToast(`已拆除，返还 🪙${r.refund}`, 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async setIrrPriority(plotId, priority) {
      if (!this.guard('irrigation')) return
      try {
        await api('/irrigation/priority', 'POST', { plotId, priority })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async setIrrTarget(plotId, target) {
      if (!this.guard('irrigation')) return
      try {
        await api('/irrigation/target', 'POST', { plotId, target })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    // ===== 杂交育种 =====
    async startBreeding(parentA, parentB) {
      if (!this.guard('breeding')) return
      try {
        await api('/breeding/start', 'POST', { parentA, parentB })
        await this.load()
        this.showToast('🧬 杂交试验已开始，随游戏天推进，注意浇水施肥与防灾', 'success')
      } catch (e) { this.showToast(e.message, 'warn'); throw e }
    },
    async careBreeding(id, action) {
      if (!this.guard('breeding')) return
      try {
        await api('/breeding/care', 'POST', { id, action })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async cancelBreeding(id) {
      if (!this.guard('breeding')) return
      try {
        await api('/breeding/cancel', 'POST', { id })
        await this.load()
        this.showToast('试验已取消（亲本已消耗不退）', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    selectPlot(id) {
      this.selectedPlot = this.plots.find((p) => p.id === id) || null
    },
    setSeedMode(s) { this.seedMode = s }
  }
})