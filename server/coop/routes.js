import { Router } from 'express'
import { db } from '../db.js'
import { createHub } from './realtime.js'
import {
  HttpError, initCoop, farmRow, userByToken, activeMemberOf,
  claimBootstrap, registerUser, publicUser, addAudit, bumpRev, enableCoop,
  activateMembership, uniqueCode, fetchValidInvite, coopView
} from './service.js'
import { can, assignableRoles } from './permissions.js'
import { withLock } from './lock.js'

export const hub = createHub()
const FARM_ID = 1
export const router = Router()

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

initCoop()

// 共营路由自管鉴权：从 Authorization 头或 query（SSE 无法自定义头）解析登录用户
router.use((req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token
  req.user = userByToken(token)
  req.me = req.user ? activeMemberOf(req.user.id) : null
  next()
})

// 统一错误处理：业务错误转 HTTP 状态，其余 500
// lock=true 时整段处理在农场互斥锁内串行（与世界写接口同一把锁）
function wrap(fn, { lock = false } = {}) {
  // handler 多为同步函数且会直接 throw，必须用 async 包裹保证同步抛出也被捕获，
  // 否则异常会逃逸出 Promise.resolve(...) 的参数求值阶段导致进程崩溃
  const exec = (req, res, next) => (async () => fn(req, res, next))().catch((e) => {
    if (res.headersSent) return next(e)
    res.status(e instanceof HttpError ? e.status : 500).json({ error: e.message || '服务器错误' })
  })
  return (req, res, next) => (lock ? withLock(FARM_ID, () => exec(req, res, next)) : exec(req, res, next))
}
// 涉及成员/世界状态变更的共营写操作同样在农场锁内串行，避免与跳日结算等事务交错
const locked = (fn) => wrap(fn, { lock: true })

// 必须为农场有效成员；可选传入 域:动作 做权限隔离
function requireMember(domain, action) {
  return (req, res, next) => {
    const member = req.me
    if (!member) return res.status(401).json({ error: '请先登录' })
    if (member.status !== 'active') return res.status(403).json({ error: '你已退出该农场' })
    if (domain && !can(member.role, domain, action)) {
      return res.status(403).json({ error: '权限不足，需要管理员或农场主操作' })
    }
    next()
  }
}

function statePayload(member) {
  return { ...coopView(member, hub.onlineUserIds(FARM_ID)) }
}

// ===== 免登录：引导 / 注册 / 凭码加入 / 凭码申请 =====
// 首次进入：判断是旧单机存档（待认领）还是需要注册新账号
router.get('/bootstrap', wrap((req, res) => {
  const user = req.user
  if (user) {
    const m = activeMemberOf(user.id)
    if (m) return res.json({ stage: 'in', state: statePayload(m) })
    return res.json({ stage: 'needJoin', user: publicUser(user) })
  }
  const farm = farmRow()
  if (!farm.claimed) return res.json({ stage: 'needClaim' })
  res.json({ stage: 'needAuth' })
}))

// 旧单人存档：第一个打开页面的人自动领取为本机农场主
router.post('/claim', locked((req, res) => {
  const r = claimBootstrap()
  const user = userByToken(r.token)
  const member = activeMemberOf(user.id)
  hub.coop(FARM_ID, user.id, 'claim')
  res.json({ ok: true, token: r.token, state: statePayload(member) })
}))

// 注册新玩家（尚无农场归属，之后凭邀请码加入）
router.post('/register', wrap((req, res) => {
  const { token, user } = registerUser(req.body?.name)
  res.json({ ok: true, token, user })
}))

// 直接邀请码：校验通过即加入农场（权限隔离在发码环节，码本身即授权凭证）
router.post('/join', locked((req, res) => {
  const user = req.user
  if (!user) throw new HttpError(401, '请先登录')
  if (activeMemberOf(user.id)) throw new HttpError(409, '你已经在农场中')
  const code = String(req.body?.code || '').trim().toUpperCase()
  const inv = fetchValidInvite(code, 'direct')
  run('UPDATE farm_invites SET uses=uses+1 WHERE id=?', inv.id)
  activateMembership(user.id, 'member')
  enableCoop()
  addAudit({ actorId: user.id, actorName: user.name, action: 'join', detail: `凭邀请码加入农场` })
  const rev = bumpRev()
  hub.state(FARM_ID, rev, user.id)
  hub.coop(FARM_ID, user.id, 'join')
  const member = activeMemberOf(user.id)
  res.json({ ok: true, state: statePayload(member) })
}))

// 农场码：提交加入申请，等待管理员/农场主审批
router.post('/request', locked((req, res) => {
  const user = req.user
  if (!user) throw new HttpError(401, '请先登录')
  if (activeMemberOf(user.id)) throw new HttpError(409, '你已经在农场中')
  const code = String(req.body?.code || '').trim().toUpperCase()
  fetchValidInvite(code, 'share') // 仅校验农场码有效
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  const exist = q1('SELECT id,status FROM farm_requests WHERE farm_id=1 AND user_id=?', user.id)
  if (exist?.status === 'pending') throw new HttpError(409, '申请审批中，请等待管理员处理')
  if (exist) {
    run(`UPDATE farm_requests SET status='pending', message=?, created_abs=?, decided_by=NULL, decided_abs=NULL
        WHERE id=?`, String(req.body?.message || '').slice(0, 80), p.abs_day, exist.id)
  } else {
    run('INSERT INTO farm_requests (farm_id,user_id,message,created_abs) VALUES (1,?,?,?)',
      user.id, String(req.body?.message || '').slice(0, 80), p.abs_day)
  }
  addAudit({ actorId: user.id, actorName: user.name, action: 'request', detail: '申请加入农场' })
  hub.coop(FARM_ID, user.id, 'request')
  res.json({ ok: true, pending: true })
}))

// ===== 共营状态 =====
router.get('/state', requireMember(), wrap((req, res) => {
  res.json(statePayload(req.me))
}))

// ===== 邀请管理（管理员以上）=====
router.post('/invite', requireMember('coop', 'invite'), locked((req, res) => {
  const kind = req.body?.kind === 'share' ? 'share' : 'direct'
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  let usesMax = kind === 'share' ? 9999 : 1
  let expireAbs = null
  if (kind === 'share') {
    // 农场长期码同时只保留一个有效，重复创建直接返回旧码
    const old = q1('SELECT * FROM farm_invites WHERE farm_id=1 AND kind=\'share\' AND revoked=0')
    if (old && old.uses < old.uses_max) {
      return res.json({ ok: true, code: old.code, kind, reused: true })
    }
  } else {
    usesMax = Math.max(1, Math.min(99, Number(req.body?.usesMax) || 1))
    const days = Math.max(1, Math.min(30, Number(req.body?.days) || 7))
    expireAbs = p.abs_day + days
  }
  const code = uniqueCode(kind)
  run(`INSERT INTO farm_invites (farm_id,code,kind,created_by,uses_max,expire_abs)
      VALUES (1,?,?,?,?,?)`, code, kind, req.me.user_id, usesMax, expireAbs)
  enableCoop()
  addAudit({
    actorId: req.me.user_id, actorName: req.me.user_name, action: 'invite/create',
    detail: kind === 'share' ? '生成了农场码（申请加入）' : `生成了 ${usesMax} 人邀请码`
  })
  hub.coop(FARM_ID, req.me.user_id, 'invite')
  res.json({ ok: true, code, kind, usesMax, expireAbs })
}))

router.post('/invite/revoke', requireMember('coop', 'invite'), locked((req, res) => {
  const id = Number(req.body?.id)
  const inv = q1('SELECT * FROM farm_invites WHERE farm_id=1 AND id=?', id)
  if (!inv) throw new HttpError(404, '邀请不存在')
  run('UPDATE farm_invites SET revoked=1 WHERE id=?', id)
  addAudit({ actorId: req.me.user_id, actorName: req.me.user_name, action: 'invite/revoke', detail: `撤销邀请码 ${inv.code}` })
  hub.coop(FARM_ID, req.me.user_id, 'invite')
  res.json({ ok: true })
}))

// ===== 加入申请审批（管理员以上）=====
router.post('/request/decide', requireMember('coop', 'review'), locked((req, res) => {
  const id = Number(req.body?.id)
  const approve = !!req.body?.approve
  const rq = q1('SELECT * FROM farm_requests WHERE farm_id=1 AND id=?', id)
  if (!rq || rq.status !== 'pending') throw new HttpError(404, '申请不存在或已处理')
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  run('UPDATE farm_requests SET status=?, decided_by=?, decided_abs=? WHERE id=?',
    approve ? 'approved' : 'rejected', req.me.user_id, p.abs_day, id)
  if (approve) {
    activateMembership(rq.user_id, 'member')
    enableCoop()
  }
  const u = q1('SELECT name FROM users WHERE id=?', rq.user_id)
  addAudit({
    actorId: req.me.user_id, actorName: req.me.user_name,
    action: approve ? 'approve' : 'reject',
    detail: `${approve ? '通过' : '拒绝'}了 ${u?.name || '玩家'} 的加入申请`
  })
  const rev = approve ? bumpRev() : null
  if (approve) hub.state(FARM_ID, rev, req.me.user_id)
  hub.coop(FARM_ID, req.me.user_id, 'request')
  res.json({ ok: true, approve })
}))

// ===== 成员角色管理（仅农场主）=====
router.post('/member/role', requireMember('coop', 'manage'), locked((req, res) => {
  const userId = Number(req.body?.userId)
  const role = String(req.body?.role || '')
  if (!assignableRoles('owner').includes(role)) throw new HttpError(400, '目标角色不合法')
  const target = q1('SELECT * FROM farm_members WHERE farm_id=1 AND user_id=?', userId)
  if (!target || target.status !== 'active') throw new HttpError(404, '成员不存在')
  if (target.role === 'owner') throw new HttpError(400, '不能更改农场主角色')
  run('UPDATE farm_members SET role=? WHERE farm_id=1 AND user_id=?', role, userId)
  const u = q1('SELECT name FROM users WHERE id=?', userId)
  addAudit({
    actorId: req.me.user_id, actorName: req.me.user_name, action: 'role',
    detail: `将 ${u?.name || '成员'} 设置为${role === 'admin' ? '管理员' : '普通成员'}`
  })
  hub.coop(FARM_ID, req.me.user_id, 'role')
  res.json({ ok: true })
}))

// 踢人（仅农场主，不能踢自己——自己请用退出/转让）
router.post('/member/kick', requireMember('coop', 'manage'), locked((req, res) => {
  const userId = Number(req.body?.userId)
  if (userId === req.me.user_id) throw new HttpError(400, '请使用「退出农场」')
  const target = q1('SELECT m.*, u.name FROM farm_members m JOIN users u ON u.id=m.user_id WHERE m.farm_id=1 AND m.user_id=?', userId)
  if (!target || target.status !== 'active') throw new HttpError(404, '成员不存在')
  if (target.role === 'owner') throw new HttpError(400, '不能踢出农场主')
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  run("UPDATE farm_members SET status='left', role='member', left_abs=? WHERE farm_id=1 AND user_id=?", p.abs_day, userId)
  hub.closeUser(FARM_ID, userId) // 立即断开被踢成员的实时连接
  addAudit({ actorId: req.me.user_id, actorName: req.me.user_name, action: 'kick', detail: `将 ${target.name} 移出农场` })
  const rev = bumpRev()
  hub.state(FARM_ID, rev, req.me.user_id)
  hub.coop(FARM_ID, req.me.user_id, 'kick')
  res.json({ ok: true })
}))

// 退出农场：农场主必须先转让或解散
router.post('/leave', requireMember(), locked((req, res) => { 
  if (req.me.role === 'owner') throw new HttpError(400, '农场主请先转让农场或解散共营')
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  run("UPDATE farm_members SET status='left', left_abs=? WHERE farm_id=1 AND user_id=?", p.abs_day, req.me.user_id)
  hub.closeUser(FARM_ID, req.me.user_id) // 关闭该用户所有设备上的实时连接
  addAudit({ actorId: req.me.user_id, actorName: req.me.user_name, action: 'leave', detail: '退出了农场' })
  const rev = bumpRev()
  hub.state(FARM_ID, rev, req.me.user_id)
  hub.coop(FARM_ID, req.me.user_id, 'leave')
  res.json({ ok: true, left: true })
}))

// 转让农场（仅农场主）：新主人升 owner，旧主人降为 admin
router.post('/transfer', requireMember('coop', 'owner'), locked((req, res) => {
  const userId = Number(req.body?.userId)
  const target = q1('SELECT * FROM farm_members WHERE farm_id=1 AND user_id=? AND status=\'active\'', userId)
  if (!target) throw new HttpError(404, '成员不存在')
  if (userId === req.me.user_id) throw new HttpError(400, '不能转让给自己')
  db.exec('BEGIN IMMEDIATE')
  try {
    run("UPDATE farm_members SET role='owner' WHERE farm_id=1 AND user_id=?", userId)
    run("UPDATE farm_members SET role='admin' WHERE farm_id=1 AND user_id=?", req.me.user_id)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  const u = q1('SELECT name FROM users WHERE id=?', userId)
  addAudit({ actorId: req.me.user_id, actorName: req.me.user_name, action: 'transfer', detail: `将农场转让给 ${u?.name || '成员'}` })
  hub.coop(FARM_ID, req.me.user_id, 'transfer')
  res.json({ ok: true })
}))

// 解散共营：仅农场主；其他成员全部退出、邀请作废、申请拒绝，世界回归单机存档（数据不丢）
router.post('/dissolve', requireMember('coop', 'owner'), locked((req, res) => {
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE farms SET coop_enabled=0 WHERE id=1')
    // 世界原主人（users.id=1，旧单机存档本体）始终保留在场；
    // 注意不能用 role!='owner' 过滤——转让后旧主人角色已是 admin，
    // 但解散后他要回归单机继续经营自己的存档
    run("UPDATE farm_members SET status='left', role='member', left_abs=? WHERE farm_id=1 AND status='active' AND user_id!=1", p.abs_day)
    run('UPDATE farm_invites SET revoked=1 WHERE farm_id=1 AND revoked=0')
    run("UPDATE farm_requests SET status='rejected', decided_by=?, decided_abs=? WHERE farm_id=1 AND status='pending'",
      req.me.user_id, p.abs_day)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  // 所有非 active 成员立即断开实时连接；仍 active 的（世界原主人/解散者）保留在线
  for (const m of q("SELECT DISTINCT user_id FROM farm_members WHERE farm_id=1 AND status!='active'")) {
    hub.closeUser(FARM_ID, m.user_id)
  }
  addAudit({ actorId: req.me.user_id, actorName: req.me.user_name, action: 'dissolve', detail: '解散共营，农场回归单机模式' })
  const rev = bumpRev()
  hub.state(FARM_ID, rev, req.me.user_id)
  hub.coop(FARM_ID, req.me.user_id, 'dissolve')
  res.json({ ok: true, dissolved: true })
}))

// 农场改名（仅农场主）
router.post('/farm/rename', requireMember('coop', 'manage'), locked((req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 20)
  if (!name) throw new HttpError(400, '名称不能为空')
  run('UPDATE farms SET name=? WHERE id=1', name)
  hub.coop(FARM_ID, req.me.user_id, 'rename')
  res.json({ ok: true, name })
}))

// ===== 实时协作 SSE 通道 =====
router.get('/events', (req, res) => {
  const user = userByToken(req.query.token)
  const member = user && activeMemberOf(user.id)
  if (!member) return res.status(403).json({ error: '未登录或已退出农场' })
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('hello', { rev: farmRow().rev, online: hub.onlineUserIds(FARM_ID), userId: user.id })
  const unsubscribe = hub.subscribe(FARM_ID, user.id, send, () => res.end())
  const ping = setInterval(() => res.write(': ping\n\n'), 25000) // 保活心跳
  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
})
