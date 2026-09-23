<template>
  <div class="gate">
    <div class="gate-card">
      <div class="logo">🚜</div>
      <h1>像素农场 · 联机共营</h1>

      <!-- 旧单机存档：自动认领中 -->
      <div v-if="coop.stage==='loading'" class="loading">正在加载农场…</div>

      <!-- 注册/登录（同一服务器上昵称即账号，token 保存在本机） -->
      <template v-else-if="coop.stage==='needAuth'">
        <p class="tip">输入昵称进入（首次输入将自动创建玩家）</p>
        <input v-model="coop.newName" maxlength="16" placeholder="你的昵称" @keyup.enter="coop.register()" />
        <button class="primary" @click="coop.register()">进入</button>
        <p v-if="coop.error" class="err">{{ coop.error }}</p>
      </template>

      <!-- 已注册，待加入 -->
      <template v-else-if="coop.stage==='needJoin'">
        <p class="tip">👋 你好，<b>{{ coop.user?.name }}</b>，输入农场邀请码加入共营</p>
        <div class="code-row">
          <input v-model="coop.joinCode" maxlength="8" placeholder="邀请码（直接加入）"
                 class="code" @input="coop.joinCode=coop.joinCode.toUpperCase()" @keyup.enter="coop.joinByCode()" />
          <button class="primary" @click="coop.joinByCode()">加入农场</button>
        </div>
        <div class="divider"><span>或</span></div>
        <div class="code-row">
          <input v-model="coop.requestCode" maxlength="6" placeholder="农场码（申请加入）"
                 class="code" @input="coop.requestCode=coop.requestCode.toUpperCase()" />
        </div>
        <input v-model="coop.requestMsg" maxlength="80" placeholder="留言（可选）：打招呼说明来意" />
        <button @click="coop.requestJoin()">提交加入申请</button>
        <p v-if="coop.error" class="err">{{ coop.error }}</p>
      </template>

      <!-- 申请审批中 -->
      <template v-else-if="coop.stage==='pending'">
        <p class="tip">⏳ 加入申请已提交，等待农场管理员审批…</p>
        <div class="spin">🌱</div>
        <button @click="coop.pollPending()">立即刷新审批结果</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useCoopStore } from '@/store/coop'
const coop = useCoopStore()
let timer = null
onMounted(() => {
  coop.bootstrap()
  timer = setInterval(() => { if (coop.stage === 'pending') coop.pollPending() }, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.gate{min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,#16324f,#0a1224);padding:20px;}
.gate-card{width:380px;max-width:100%;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);border-radius:18px;padding:30px;text-align:center;color:#dbe4f3;}
.logo{font-size:52px;}
h1{font-size:18px;margin:10px 0 20px;color:#fff;}
.tip{font-size:13px;color:#aebadd;margin:0 0 16px;line-height:1.7;}
.loading{color:#8ba2c8;padding:30px 0;}
input{width:100%;box-sizing:border-box;background:#0c1730;border:1px solid rgba(120,160,220,0.25);border-radius:10px;color:#dbe4f3;padding:11px 14px;font-size:14px;margin-bottom:10px;outline:none;}
input:focus{border-color:#5c97ff;}
input.code{text-transform:uppercase;letter-spacing:3px;font-weight:700;text-align:center;}
.code-row{display:flex;gap:8px;}
.code-row input{margin-bottom:0;flex:1;}
button{width:100%;background:#13233f;border:1px solid rgba(120,160,220,0.3);color:#dbe4f3;border-radius:10px;padding:11px;font-size:14px;cursor:pointer;margin-top:10px;}
button.primary{background:linear-gradient(135deg,#66bb6a,#2e7d32);border-color:transparent;color:#fff;font-weight:700;white-space:nowrap;width:auto;padding:11px 18px;margin-top:0;}
.code-row button{margin-top:0;white-space:nowrap;}
.divider{display:flex;align-items:center;gap:10px;color:#5b6f94;font-size:11px;margin:16px 0;}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:rgba(120,160,220,0.18);}
.err{color:#ef9a9a;font-size:12px;margin:10px 0 0;}
.spin{font-size:40px;animation:pulse 1.6s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:.5;}50%{opacity:1;}}
</style>
