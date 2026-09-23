// ===== 共营角色与权限矩阵 =====
// 角色三级：
//   owner  农场主（旧单人存档的本机玩家）：全部权限 + 解散/转让/任免
//   admin  管理员：可灌溉建造、灾害防护投入、推进时间、升级建筑、发邀请/批申请
//   member 成员：种植养护、交易、畜牧、加工、育种等日常劳作
//
// 权限以「域:动作」表达，'*' 为通配。服务端在每个写接口上强制校验，
// 前端只做按钮禁用等展示控制（一切以后端校验为准）。

export const ROLES = ['owner', 'admin', 'member']

export const ROLE_LABELS = { owner: '农场主', admin: '管理员', member: '成员' }

// 权限域的中文名（审计/前端展示用）
export const DOMAIN_LABELS = {
  plant: '种植',
  trade: '交易',
  husbandry: '畜牧',
  production: '加工生产',
  breeding: '育种',
  irrigation: '灌溉设施',
  disaster: '灾害防护',
  time: '时间推进',
  buildings: '建筑升级',
  coop: '共营管理'
}

const ALL = ['*']

// member 日常劳作域
const MEMBER_CAPS = {
  plant: ALL,
  trade: ALL,
  husbandry: ALL,
  production: ALL,
  breeding: ALL
}

export const CAPABILITIES = {
  member: { ...MEMBER_CAPS },
  admin: {
    ...MEMBER_CAPS,
    irrigation: ALL,
    disaster: ALL,
    time: ALL,
    buildings: ALL,
    coop: ['invite', 'review'] // 发/撤邀请、审批加入申请
  },
  owner: {
    '*': ALL // 农场主拥有一切（含 coop:manage 任免/踢人、coop:owner 转让/解散）
  }
}

// 判断角色是否拥有 域:动作 权限
export function can(role, domain, action = '*') {
  const caps = CAPABILITIES[role]
  if (!caps) return false
  if (caps['*']) return true
  const acts = caps[domain]
  if (!acts) return false
  return acts.includes('*') || acts.includes(action)
}

// 给前端的扁平化权限表（域级开关 + coop 细项），前端据此禁用按钮
export function capabilityView(role) {
  const domains = ['plant', 'trade', 'husbandry', 'production', 'breeding',
    'irrigation', 'disaster', 'time', 'buildings']
  const view = {}
  for (const d of domains) view[d] = can(role, d)
  view.coopInvite = can(role, 'coop', 'invite')
  view.coopReview = can(role, 'coop', 'review')
  view.coopManage = role === 'owner'
  view.coopOwner = role === 'owner'
  return view
}

// 可任免的目标角色（owner 不能被此接口改角色；转让走专门接口）
export function assignableRoles(currentRole) {
  if (currentRole !== 'owner') return []
  return ['admin', 'member']
}
