<template>
  <CoopGate v-if="coop.stage!=='in'" />
  <div v-else class="layout">
    <!-- 顶部状态栏 -->
    <header class="hud">
      <div class="brand"><span class="logo">🚜</span><div><b>像素农场</b><span class="sub">{{ store.farm?.name || 'PixiFarm' }}</span></div></div>
      <div class="stats">
        <div class="chip gold">🪙 {{ store.player?.gold ?? 0 }}</div>
        <div class="chip lv">Lv.{{ store.player?.level ?? 1 }} ✨{{ store.player?.exp ?? 0 }}exp</div>
        <div class="chip season">{{ store.seasonLabel }}</div>
        <div class="chip day">第 {{ store.player?.day ?? 1 }} 天</div>
        <div class="chip weather" :class="{bad: store.weather?.bad}" v-if="store.weather">
          {{ store.weather.icon }} {{ store.weather.name }}<template v-if="store.weather.bad">·剩{{ store.weather.duration - store.weather.settled_days }}天</template>
        </div>
        <!-- 共营身份：角色 + 在线人数（点击直达共营页） -->
        <div class="chip coop-chip" :class="'role-'+store.me?.role" @click="goCoop" title="点击管理共营">
          {{ {owner:'👑',admin:'🛠️',member:'🧑‍🌾'}[store.me?.role] || '' }}
          {{ store.me?.name }} · {{ {owner:'农场主',admin:'管理员',member:'成员'}[store.me?.role] }}
          · 🟢{{ onlineCount }}
        </div>
      </div>
      <div class="time-ctl" v-if="store.can('time')">
        <button class="skip1" @click="store.nextDay(1)">⏩ +1天</button>
        <button class="skip1" @click="store.nextDay(3)">⏭️ +3天</button>
        <button class="skip2" @click="store.nextDay(7)">⏸ +1周</button>
      </div>
      <div class="time-ctl locked-tip" v-else title="时间推进仅管理员/农场主可操作">
        <span>🔒 仅管理员可推进时间</span>
      </div>
      <button class="reload" @click="store.refresh()">🔄</button>
    </header>

    <!-- 主区 -->
    <main class="main">
      <div class="map-col">
        <FarmMap />
      </div>
      <aside class="side">
        <PlotPanel />
        <IrrigationPanel />
        <WeatherPanel />
      </aside>
    </main>

    <!-- 管理页（市场/加工/畜棚/背包/建筑/共营） -->
    <Management ref="mgmt" />

    <!-- 新手提示 -->
    <div class="guide card-note" v-if="!store.player?.hasPlayed">
      🎮 点击耕地选择 → 选种子"播种" → 用「⏩ +1天」推进 → 记得浇水/施肥/除虫 → 成熟后收获去市场卖；攒两批同类或异种作物可去「🧬 育种」杂交出带遗传性状的新品种；去「👥 共营」邀请好友一起经营！
    </div>

    <!-- Toast -->
    <transition name="tg">
      <div v-if="store.toast" class="toast" :class="store.toast.type" @click="store.clearToast()">{{ store.toast.msg }}</div>
    </transition>
    <!-- 事件时间线 -->
    <div class="timeline" :class="{open:tlOpen}">
      <div class="tl-head" @click="tlOpen=!tlOpen">📜 事件记录 {{ tlOpen?'▾':'▸' }}</div>
      <div class="tl-body" v-if="tlOpen">
        <div v-for="(t,i) in store.timeline" :key="i" class="tl-item">{{ t.time }} · {{ t.msg }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useGameStore, onCoopEvent } from '@/store/game'
import { useCoopStore } from '@/store/coop'
import { onDenied } from '@/api'
import FarmMap from '@/components/FarmMap.vue'
import PlotPanel from '@/components/PlotPanel.vue'
import IrrigationPanel from '@/components/IrrigationPanel.vue'
import WeatherPanel from '@/components/WeatherPanel.vue'
import Management from '@/components/Management.vue'
import CoopGate from '@/components/CoopGate.vue'

const store = useGameStore()
const coop = useCoopStore()
const mgmt = ref(null)
const tlOpen = ref(false)
const onlineCount = computed(() => new Set(store.onlineUserIds).size)

function goCoop() {
  // Management 内部 tab 为局部状态，通过自定义事件总线较绕；这里直接派发 DOM 事件
  window.dispatchEvent(new CustomEvent('pixifarm:tab', { detail: 'coop' }))
}

onMounted(() => {
  // 被踢出/会话失效：任何请求收到 401/403 即自动回到加入界面
  offDenied = onDenied((msg) => {
    if (coop.stage !== 'in') return
    store.showToast(msg || '你已退出该农场', 'warn')
    coop.handleExited()
  })
  // SSE 共营事件：成员/邀请变化刷新面板；被服务端踢下线时回到加入界面
  offCoop = onCoopEvent(async ({ type, error }) => {
    if (type === 'denied') {
      if (coop.stage !== 'in') return
      store.showToast(error || '你已退出该农场', 'warn')
      coop.handleExited()
    } else if (type === 'coop') {
      await coop.refreshCoop()
    }
  })
})
let offDenied = null
let offCoop = null
onUnmounted(() => { offDenied?.(); offCoop?.() })
</script>

<style scoped>
.layout{min-height:100vh;background:#0a1224;color:#dbe4f3;padding-bottom:40px;}
.hud{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:14px;padding:10px 20px;background:#0c1730;border-bottom:1px solid rgba(120,160,220,0.18);flex-wrap:wrap;}
.brand{display:flex;align-items:center;gap:8px;}
.logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:22px;background:linear-gradient(135deg,#66bb6a,#2e7d32);}
.brand b{color:#fff;font-size:15px;display:block;}
.sub{font-size:10px;color:#6f84ab;letter-spacing:1px;}
.stats{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:5px 11px;border-radius:8px;font-size:12px;}
.chip.gold{color:#ffd54f;}
.chip.season{color:#90caf9;}
.chip.weather{color:#c5e1a5;}
.chip.weather.bad{color:#ef9a9a;border-color:rgba(239,83,80,0.4);}
.coop-chip{cursor:pointer;user-select:none;}
.coop-chip.role-owner{color:#ffd54f;border-color:rgba(255,213,79,0.4);}
.coop-chip.role-admin{color:#90caf9;border-color:rgba(144,202,249,0.4);}
.time-ctl{display:flex;gap:6px;margin-left:auto;}
.locked-tip{margin-left:auto;}
.locked-tip span{font-size:11px;color:#6f84ab;background:#13233f;border:1px solid rgba(120,160,220,0.15);padding:7px 12px;border-radius:8px;}
.time-ctl button{border:none;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;color:#fff;font-weight:600;}
.skip1{background:linear-gradient(135deg,#ffb300,#f57c00);}
.skip2{background:linear-gradient(135deg,#7e57c2,#5e35b1);}
.reload{background:#13233f;border:1px solid rgba(120,160,220,0.3);border-radius:8px;color:#8ba2c8;font-size:16px;cursor:pointer;padding:4px 10px;}
.main{display:grid;grid-template-columns:1fr 320px;gap:14px;padding:16px 20px;max-width:1460px;margin:0 auto;}
@media(max-width:980px){.main{grid-template-columns:1fr;}}
.map-col{min-width:0;}
.side{align-self:start;display:flex;flex-direction:column;gap:14px;}
.guide.card-note{max-width:1200px;margin:14px auto 0;background:#14273f;border:1px dashed #ffd54f;color:#ffd54f;border-radius:10px;padding:12px 16px;font-size:13px;}
.toast{position:fixed;right:20px;top:70px;z-index:50;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:pointer;max-width:320px;}
.toast.success{background:#1b5e20;color:#c8e6c9;border:1px solid #388e3c;}
.toast.warn{background:#e65100;color:#ffe0b2;border:1px solid #f57c00;}
.toast.info{background:#0d47a1;color:#bbdefb;border:1px solid #1976d2;}
.tg-enter-active,.tg-leave-active{transition:all .3s;}
.tg-enter-from,.tg-leave-to{opacity:0;transform:translateY(-10px);}
.timeline{position:fixed;left:20px;bottom:16px;z-index:40;width:300px;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);border-radius:12px;overflow:hidden;}
.tl-head{padding:10px 14px;cursor:pointer;color:#8ba2c8;font-size:13px;background:#13233f;}
.tl-body{max-height:200px;overflow-y:auto;padding:6px 12px;}
.tl-item{font-size:11px;color:#8ba2c8;padding:3px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
</style>
