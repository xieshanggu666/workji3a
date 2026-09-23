import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, capabilityView, ROLES, assignableRoles } from './permissions.js'
import { withLock, isLocked } from './lock.js'
import { randomCode } from './codes.js'

// ===== 权限矩阵 =====
test('owner 拥有全部权限', () => {
  for (const d of ['plant', 'trade', 'husbandry', 'production', 'breeding', 'irrigation', 'disaster', 'time', 'buildings']) {
    assert.equal(can('owner', d), true)
  }
  assert.equal(can('owner', 'coop', 'manage'), true)
  assert.equal(can('owner', 'coop', 'owner'), true)
})

test('member 只能日常劳作，不能推进时间/防灾/灌溉/升级', () => {
  for (const d of ['plant', 'trade', 'husbandry', 'production', 'breeding']) assert.equal(can('member', d), true)
  for (const d of ['irrigation', 'disaster', 'time', 'buildings']) assert.equal(can('member', d), false)
  assert.equal(can('member', 'coop', 'invite'), false)
})

test('admin 拥有管理域但不能任免/转让/解散', () => {
  for (const d of ['irrigation', 'disaster', 'time', 'buildings']) assert.equal(can('admin', d), true)
  assert.equal(can('admin', 'coop', 'invite'), true)
  assert.equal(can('admin', 'coop', 'review'), true)
  assert.equal(can('admin', 'coop', 'manage'), false)
  assert.equal(can('admin', 'coop', 'owner'), false)
})

test('未知角色一律拒绝', () => {
  assert.equal(can('ghost', 'plant'), false)
  assert.equal(capabilityView('member').time, false)
  assert.equal(capabilityView('member').plant, true)
})

test('仅 owner 可任免目标角色', () => {
  assert.deepEqual(assignableRoles('owner'), ['admin', 'member'])
  assert.deepEqual(assignableRoles('admin'), [])
})

// ===== 互斥锁：串行化 + 结果透传 + 异常不堵链 =====
test('withLock 让同 key 任务严格串行', async () => {
  const log = []
  const task = (name, ms) => withLock('k1', async () => {
    log.push(name + ':start')
    await new Promise((r) => setTimeout(r, ms))
    log.push(name + ':end')
    return name
  })
  const [a, b] = await Promise.all([task('A', 20), task('B', 5)])
  assert.equal(a, 'A')
  assert.equal(b, 'B')
  assert.deepEqual(log, ['A:start', 'A:end', 'B:start', 'B:end'])
  assert.equal(isLocked('k1'), false)
})

test('withLock 任务抛错不影响后续任务', async () => {
  const p1 = withLock('k2', () => { throw new Error('boom') })
  await assert.rejects(p1, /boom/)
  assert.equal(await withLock('k2', () => 42), 42)
})

test('不同 key 的锁互不阻塞', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const task = (key, ms) => withLock(key, async () => {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise((r) => setTimeout(r, ms))
    concurrent--
  })
  await Promise.all([task('a', 15), task('b', 15)])
  assert.equal(maxConcurrent, 2)
})

// ===== 邀请码 =====
test('随机码长度/字符集合规且不可猜字符被排除', () => {
  const code = randomCode(8)
  assert.equal(code.length, 8)
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/)
  assert.ok(!/[0O1LI]/.test(code))
})
