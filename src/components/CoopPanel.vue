<template>
  <div class="page coop-page">
    <!-- 左：成员与角色 -->
    <div class="pcol card">
      <h4>👥 农场成员 <span class="lvl">{{ coop.activeMembers.length }} 人在线 {{ onlineCount }}</span></h4>
      <div v-for="m in coop.activeMembers" :key="m.userId" class="member">
        <span class="avatar">{{ m.role==='owner' ? '👑' : (m.online ? '🧑‍🌾' : '💤') }}</span>
        <div class="m-info">
          <b :class="{me: m.userId===coop.me?.userId}">
            {{ m.name }}<span v-if="m.userId===coop.me?.userId" class="tag me-tag">我</span>
            <span class="tag" :class="'role-'+m.role">{{ m.roleLabel }}</span>
            <span v-if="m.online" class="tag online">在线</span>
          </b>
          <span class="tag">第 {{ m.joinedAbs }} 天加入</span>
        </div>
        <div class="ctl" v-if="coop.caps?.coopManage && m.userId!==coop.me?.userId">
          <button class="mini" v-if="m.role==='member'" @click="coop.setRole(m.userId,'admin')">设管理员</button>
          <button class="mini" v-if="m.role==='admin'" @click="coop.setRole(m.userId,'member')">取消管理</button>
          <button class="mini" @click="doTransfer(m)">转让</button>
          <button class="mini red" @click="doKick(m)">移出</button>
        </div>
      </div>

      <!-- 退出 / 解散 -->
      <div class="owner-zone">
        <button v-if="coop.me?.role !== 'owner'" class="wide warn" @click="doLeave">🚪 退出农场</button>
        <template v-if="coop.caps?.coopOwner">
          <div class="farm-name">
            农场名：<input :value="coop.farm?.name" @change="onRename" maxlength="20" />
          </div>
          <button class="wide danger" @click="doDissolve">🧨 解散共营（回归单机）</button>
          <p class="hint">解散后其他成员退出，邀请与申请全部作废，农场数据完整保留。</p>
        </template>
      </div>
    </div>

    <!-- 右：邀请码 / 加入申请 / 审计 -->
    <div class="pcol">
      <!-- 邀请管理（管理员以上） -->
      <div class="card" v-if="coop.caps?.coopInvite">
        <h4>✉️ 邀请</h4>
        <div class="invite-create">
          <label>直接邀请码：限
            <select v-model.number="coop.inviteUses"><option :value="1">1</option><option :value="3">3</option><option :value="5">5</option></select>
            人 ·
            <select v-model.number="coop.inviteDays"><option :value="3">3</option><option :value="7">7</option><option :value="14">14</option></select>
            天内有效
          </label>
          <button class="mini" @click="makeInvite('direct')">生成邀请码</button>
        </div>
        <div class="invite-create">
          <label>农场码：长期有效，他人凭码<strong>申请</strong>，需你审批</label>
          <button class="mini" @click="makeInvite('share')">生成/查看农场码</button>
        </div>
        <div class="code-list">
          <div v-for="inv in coop.invites" :key="inv.id" class="code-item" :class="{dead: inv.revoked||inv.expired||inv.exhausted}">
            <span class="code-val">{{ inv.code }}</span>
            <span class="tag">{{ inv.kind==='share' ? '农场码·申请制' : '邀请码·直入' }}</span>
            <span class="tag" v-if="inv.kind==='direct'">已用 {{ inv.uses }}/{{ inv.usesMax }}</span>
            <span class="tag" v-if="inv.expireAbs">第{{ inv.expireAbs }}天到期</span>
            <span class="tag" v-if="inv.revoked">已撤销</span>
            <span class="tag" v-else-if="inv.expired">已过期</span>
            <span class="tag" v-else-if="inv.exhausted">已用尽</span>
            <span class="tag">{{ inv.creatorName }} 创建</span>
            <button v-if="!inv.revoked" class="mini red sm" @click="coop.revokeInvite(inv.id)">撤销</button>
          </div>
          <div v-if="!coop.invites.length" class="none">还没有邀请码</div>
        </div>
      </div>
      <div class="card warn-card" v-else>
        <h4>✉️ 加入方式</h4>
        <p class="hint">联系农场管理员或农场主索取邀请码 / 农场码。</p>
      </div>

      <!-- 加入申请（管理员以上） -->
      <div class="card" v-if="coop.caps?.coopReview">
        <h4>📨 加入申请 <span v-if="coop.pendingRequests.length" class="badge">{{ coop.pendingRequests.length }}</span></h4>
        <div v-if="!coop.requests.filter(r=>r.status==='pending').length" class="none">暂无待处理申请</div>
        <div v-for="r in coop.requests" :key="r.id" class="req-item">
          <span class="i">🧑‍🌾</span>
          <div class="m-info">
            <b>{{ r.name }}</b>
            <span class="tag" v-if="r.message">「{{ r.message }}」</span>
            <span class="tag" :class="'st-'+r.status">{{ statusText(r.status) }}</span>
          </div>
          <template v-if="r.status==='pending'">
            <button class="mini green" @click="coop.decideRequest(r.id,true)">通过</button>
            <button class="mini red" @click="coop.decideRequest(r.id,false)">拒绝</button>
          </template>
        </div>
      </div>

      <!-- 审计流水 -->
      <div class="card">
        <h4>📜 共营记录</h4>
        <div class="audit-list">
          <div v-for="a in coop.audit" :key="a.id" class="audit-item">
            <span class="a-day">D{{ a.abs_day }}</span>
            <span class="a-actor">{{ a.actor_name || '系统' }}</span>
            <span class="a-detail">{{ actionText(a) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCoopStore } from '@/store/coop'
const coop = useCoopStore()
const onlineCount = computed(() => coop.activeMembers.filter((m) => m.online).length)

function statusText(s) { return { pending: '待审批', approved: '已通过', rejected: '已拒绝' }[s] || s }
function actionText(a) {
  if (a.action === 'time') return `⏩ ${a.detail}`
  return a.detail || a.action
}

async function makeInvite(kind) {
  const d = await coop.createInvite(kind)
  const word = kind === 'share' ? '农场码' : '邀请码'
  if (d.reused) console.info('复用已有农场码')
  // 复制到剪贴板方便转发给好友
  try { await navigator.clipboard.writeText(d.code) } catch { /* 无剪贴板权限时忽略 */ }
}
function doKick(m) { if (confirm(`确定将 ${m.name} 移出农场吗？`)) coop.kick(m.userId) }
function doTransfer(m) {
  if (confirm(`将农场转让给 ${m.name}？\n你将变为管理员，此操作可由新农场主再转回。`)) coop.transfer(m.userId)
}
function doLeave() {
  if (confirm('确定退出当前农场吗？农场数据不会保留在你的设备上，但可再次被邀请加入。')) coop.leave()
}
function doDissolve() {
  if (confirm('确定解散共营？\n所有成员将退出、邀请与申请作废，农场世界数据保留并回归单机模式。')) coop.dissolve()
}
function onRename(e) {
  const name = e.target.value.trim()
  if (name && name !== coop.farm.name) coop.renameFarm(name)
}
</script>

<style scoped>
.coop-page{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;}
.pcol{display:flex;flex-direction:column;gap:14px;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 10px;color:#fff;display:flex;gap:8px;align-items:center;font-size:14px;}
.lvl{font-size:11px;color:#ffd54f;font-weight:400;}
.member{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.avatar{font-size:22px;width:30px;text-align:center;}
.m-info{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
.m-info b{color:#e8eefb;font-size:13px;width:100%;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.m-info b.me{color:#ffd54f;}
.tag{font-size:10px;color:#8ba2c8;background:#16263f;padding:2px 6px;border-radius:4px;}
.tag.me-tag{color:#ffd54f;}
.tag.role-owner{color:#ffd54f;background:#3a2f10;}
.tag.role-admin{color:#90caf9;background:#122a47;}
.tag.online{color:#a5d6a7;background:#1b3a21;}
.ctl{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;}
.mini{background:#2962ff;border:none;color:#fff;border-radius:6px;padding:5px 8px;font-size:11px;cursor:pointer;}
.mini.red{background:#c62828;}
.mini.green{background:#43a047;}
.mini.sm{padding:3px 7px;}
.owner-zone{margin-top:12px;display:flex;flex-direction:column;gap:8px;}
.farm-name{font-size:12px;color:#aebadd;display:flex;align-items:center;gap:8px;}
.farm-name input{flex:1;background:#0c1730;border:1px solid rgba(120,160,220,0.25);border-radius:8px;color:#dbe4f3;padding:7px 10px;font-size:12px;}
.wide{width:100%;border-radius:9px;padding:10px;font-size:13px;cursor:pointer;border:1px solid;}
.wide.warn{background:#16263f;border-color:rgba(255,213,79,0.3);color:#ffd54f;}
.wide.danger{background:#3a1515;border-color:rgba(239,83,80,0.4);color:#ef9a9a;}
.hint{font-size:11px;color:#6f84ab;margin:4px 0 0;line-height:1.6;}
.invite-create{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.invite-create label{font-size:12px;color:#aebadd;line-height:1.6;}
.invite-create select{background:#0c1730;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:6px;padding:3px 5px;font-size:11px;margin:0 2px;}
.code-list{margin-top:8px;display:flex;flex-direction:column;gap:6px;}
.code-item{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#0c1730;border-radius:8px;padding:8px 10px;}
.code-item.dead{opacity:.55;}
.code-val{font-weight:700;letter-spacing:2px;color:#a5d6a7;font-size:14px;}
.req-item{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.req-item .i{font-size:18px;}
.req-item .m-info b{width:auto;margin-right:4px;}
.st-pending{color:#ffd54f;} .st-approved{color:#a5d6a7;} .st-rejected{color:#ef9a9a;}
.badge{background:#e53935;color:#fff;font-size:10px;min-width:16px;height:16px;line-height:16px;border-radius:8px;padding:0 4px;font-weight:700;text-align:center;}
.none{color:#5b6f94;font-size:12px;padding:10px 0;text-align:center;}
.audit-list{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:5px;}
.audit-item{display:flex;gap:8px;font-size:11px;line-height:1.5;}
.a-day{color:#90caf9;flex-shrink:0;}
.a-actor{color:#ffd54f;flex-shrink:0;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.a-detail{color:#aebadd;}
.warn-card .hint{padding:4px 0;}
</style>
