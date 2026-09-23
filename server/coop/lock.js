// ===== 农场级互斥锁 =====
// 同一农场（本作为单一世界 farm #1）的所有写操作串行化，
// 与 SQLite 的 BEGIN IMMEDIATE 事务配合：多端并发操作不会交错，
// 保证播种扣种、收获入库、跳日灾害结算等复合操作的并发一致性。
const chains = new Map() // key -> Promise 链尾（本段任务完成的门闩）

// 在锁保护下执行 fn（fn 可为 async），返回其结果/异常
export async function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  // 链节点永远只 resolve 不 reject：上一段失败不会让整条链断裂
  const node = prev.then(() => gate, () => gate)
  chains.set(key, node)
  // 必须先等前一段任务结束，才开始本段临界区
  await prev
  try {
    return await fn()
  } finally {
    release()
    // 链尾仍是自己说明没有后继，清理避免无界增长
    if (chains.get(key) === node) chains.delete(key)
  }
}

// 测试辅助：查看当前是否有持锁任务
export function isLocked(key) {
  return chains.has(key)
}
