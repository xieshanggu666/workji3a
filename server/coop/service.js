import { db } from '../db.js'
import { newToken, randomCode } from './codes.js'
import { CAPABILITIES, ROLE_LABELS, capabilityView, can } from './permissions.js'

const FARM_ID = 1
const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ===== 旧存档迁移：首次启动生成「待认领」的本机农场主 =====
// 旧单机玩家第一次打开页面时自动领取（POST /api/coop/claim），
// 之后其它设备访问需要注册并凭邀请加入，实现单机→共营的无缝升级。
export function initCoop() {
  run('INSERT OR IGNORE INTO farms (id) VALUES (1)')
  const cols = db.prepare('PRAGMA table_info(farms)').all().map((c) => c.name)
  if (!cols.includes('claimed')) {
    db.exec('ALTER TABLE farms ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0')
  }
  const userCount = q1('SELECT COUNT(*) c FROM users').c
  if (userCount === 0) {
    const token = newToken()
    const r = run('INSERT INTO users (name, token) VALUES (?,?)', '本机农场主', token)
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    run('INSERT INTO farm_members (farm_id,user_id,role,status,joined_abs) VALUES (1,?,?,?,?)',
      r.lastInsertRowid, 'owner', 'active', p?.abs_day || 1)
  }
}

export function farmRow() {
  return q1('SELECT * FROM farms WHERE id=1')
}

export function userByToken(token) {
  if (!token) return null
  return q1('SELECT * FROM users WHERE token=?', String(token).slice(0, 128)) || null
}

export function activeMemberOf(userId) {
  return q1(`SELECT m.*, u.name AS user_name FROM farm_members m
            JOIN users u ON u.id=m.user_id
            WHERE m.farm_id=1 AND m.user_id=? AND m.status='active'`, userId) || null
}

export function claimBootstrap() {
  const farm = farmRow()
  if (farm.claimed) throw new HttpError(409, '本机农场主已被领取')
  const owner = q1(`SELECT u.* FROM farm_members m JOIN users u ON u.id=m.user_id
                    WHERE m.farm_id=1 AND m.role='owner' AND m.status='active'`)
  if (!owner) throw new HttpError(404, '无可领取的本机农场')
  run('UPDATE farms SET claimed=1 WHERE id=1')
  return { token: owner.token, user: publicUser(owner), claimed: true }
}

export function registerUser(name) {
  const nick = String(name || '').trim().slice(0, 16)
  if (!nick) throw new HttpError(400, '请输入昵称')
  if (q1('SELECT id FROM users WHERE name=?', nick)) throw new HttpError(400, '昵称已存在')
  const token = newToken()
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  const r = run('INSERT INTO users (name,token,created_abs) VALUES (?,?,?)', nick, token, p?.abs_day || 1)
  return { token, user: { id: r.lastInsertRowid, name: nick } }
}

export function publicUser(u) {
  return { id: u.id, name: u.name }
}

// ===== 审计流水 =====
export function addAudit({ actorId = null, actorName = '', action, detail = '' }) {
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  run(`INSERT INTO farm_audit (farm_id,actor_id,actor_name,action,detail,abs_day,created_at)
      VALUES (1,?,?,?,?,?,?)`, actorId, actorName, action, detail, p?.abs_day || 1, Date.now())
}

export function listAudits(limit = 30) {
  return q('SELECT * FROM farm_audit WHERE farm_id=1 ORDER BY id DESC LIMIT ?', Math.min(limit, 100))
}

// 世界版本号 +1（每次世界写操作后调用，SSE 广播给其它端做并发一致刷新）
export function bumpRev() {
  run('UPDATE farms SET rev=rev+1 WHERE id=1')
  return farmRow().rev
}

export function enableCoop() {
  run('UPDATE farms SET coop_enabled=1 WHERE id=1')
}

// ===== 成员增删（加入/审批复用同一 upsert 逻辑）=====
export function activateMembership(userId, role = 'member') {
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  const exist = q1('SELECT id FROM farm_members WHERE farm_id=1 AND user_id=?', userId)
  if (exist) {
    run(`UPDATE farm_members SET status='active', role=?, left_abs=NULL, joined_abs=?
        WHERE farm_id=1 AND user_id=?`, role, p?.abs_day || 1, userId)
  } else {
    run('INSERT INTO farm_members (farm_id,user_id,role,status,joined_abs) VALUES (1,?,?,?,?)',
      userId, role, 'active', p?.abs_day || 1)
  }
}

// ===== 邀请码 =====
export function uniqueCode(kind) {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(kind === 'share' ? 6 : 8)
    if (!q1('SELECT id FROM farm_invites WHERE code=?', code)) return code
  }
  throw new HttpError(500, '邀请码生成失败，请重试')
}

// 校验邀请码（未撤销 / 未用尽 / 未过期）
export function fetchValidInvite(code, kind) {
  const inv = q1('SELECT * FROM farm_invites WHERE farm_id=1 AND code=? AND kind=?', code, kind)
  if (!inv || inv.revoked) throw new HttpError(404, '邀请码无效')
  if (inv.uses >= inv.uses_max) throw new HttpError(410, '邀请码已被使用完')
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  if (inv.expire_abs != null && inv.expire_abs < p.abs_day) throw new HttpError(410, '邀请码已过期')
  return inv
}

// ===== 共营面板状态 =====
function listMembers() {
  return q(`SELECT m.id, m.user_id, m.role, m.status, m.joined_abs, m.left_abs, u.name
           FROM farm_members m JOIN users u ON u.id=m.user_id
           WHERE m.farm_id=1 ORDER BY (m.role='owner') DESC, m.id`).map((m) => ({
    id: m.id, userId: m.user_id, name: m.name, role: m.role,
    roleLabel: ROLE_LABELS[m.role], status: m.status,
    joinedAbs: m.joined_abs, leftAbs: m.left_abs
  }))
}

function listInvites() {
  const p = q1('SELECT abs_day FROM player WHERE id=1')
  return q(`SELECT i.*, u.name AS creator_name FROM farm_invites i
           JOIN users u ON u.id=i.created_by WHERE i.farm_id=1 ORDER BY i.id DESC`).map((i) => ({
    id: i.id, code: i.code, kind: i.kind, uses: i.uses, usesMax: i.uses_max,
    expireAbs: i.expire_abs, revoked: !!i.revoked,
    expired: i.expire_abs != null && i.expire_abs < p.abs_day,
    exhausted: i.uses >= i.uses_max, creatorName: i.creator_name
  }))
}

function listRequests() {
  return q(`SELECT r.*, u.name AS user_name FROM farm_requests r
           JOIN users u ON u.id=r.user_id WHERE r.farm_id=1 ORDER BY r.id DESC`).map((r) => ({
    id: r.id, userId: r.user_id, name: r.user_name, message: r.message,
    status: r.status, createdAbs: r.created_abs, decidedAbs: r.decided_abs,
    decidedBy: r.decided_by
  }))
}

// me：当前成员（含在线状态稍后由路由填充）
export function coopView(member, onlineUserIds = []) {
  const farm = farmRow()
  const members = listMembers().map((m) => ({ ...m, online: onlineUserIds.includes(m.userId) }))
  const isAdminish = member.role === 'owner' || member.role === 'admin'
  return {
    farm: { id: farm.id, name: farm.name, coopEnabled: !!farm.coop_enabled, rev: farm.rev, claimed: !!farm.claimed },
    me: {
      userId: member.user_id, name: member.user_name, role: member.role,
      roleLabel: ROLE_LABELS[member.role], caps: capabilityView(member.role)
    },
    members,
    // 只有管理员以上能看到邀请码与申请列表（权限隔离，成员不暴露管理数据）
    invites: can(member.role, 'coop', 'invite') ? listInvites() : [],
    requests: can(member.role, 'coop', 'review') ? listRequests() : [],
    audit: listAudistsSafe(member),
    online: onlineUserIds
  }
}

// 审计：所有成员可看（谁推进了时间、谁加入了等），但普通成员不看被拒申请等管理细节
function listAudistsSafe(member) {
  const HIDDEN_FOR_MEMBER = new Set(['reject'])
  const rows = listAudits(40)
  if (member.role === 'member') return rows.filter((r) => !HIDDEN_FOR_MEMBER.has(r.action))
  return rows
}

export { CAPABILITIES }
