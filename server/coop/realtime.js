// ===== 实时协作服务（SSE 长连接 + 在线状态） =====
// 每个在线客户端保持一条 EventSource：
//   event:state    共享世界被修改（多端自动拉取最新状态，带去重序号）
//   event:presence 成员上/下线变化
//   event:coop     成员/邀请/申请/角色变化（面板即时刷新）
// 不依赖任何第三方库，断线由浏览器原生 EventSource 自动重连。

// farmId -> Map<clientId, { userId, send }>
const rooms = new Map()

function room(farmId) {
  if (!rooms.has(farmId)) rooms.set(farmId, new Map())
  return rooms.get(farmId)
}

// 广播给农场内的在线客户端；skipUserId 用于跳过操作者自己的所有连接
function emit(farmId, event, payload, skipUserId = null) {
  const r = rooms.get(farmId)
  if (!r) return
  for (const [cid, c] of r) {
    if (skipUserId != null && c.userId === skipUserId) continue
    try {
      c.send(event, payload)
    } catch {
      // 单个连接写入失败不影响其他人，等其断开后清理
    }
  }
}

function onlineUserIds(farmId) {
  const r = rooms.get(farmId)
  if (!r) return []
  return [...new Set([...r.values()].map((c) => c.userId))]
}

export function createHub() {
  // 订阅者注册，返回注销函数；在线人数变化时广播 presence。
  // send/end 由 SSE 路由提供：end 用于被踢出时服务端主动断开。
  function subscribe(farmId, userId, send, end) {
    const clientId = farmId + ':' + userId + ':' + Math.random().toString(36).slice(2)
    const r = room(farmId)
    r.set(clientId, { userId, send, end })
    emit(farmId, 'presence', { online: onlineUserIds(farmId), reason: 'join', userId }, userId)
    return () => {
      const cur = rooms.get(farmId)
      if (cur?.delete(clientId)) {
        emit(farmId, 'presence', { online: onlineUserIds(farmId), reason: 'leave', userId }, userId)
        if (cur.size === 0) rooms.delete(farmId)
      }
    }
  }

  return {
    subscribe,
    // 世界数据变更（rev：单调序号，客户端丢弃过期事件；byUserId：跳过操作者自己的连接）
    state(farmId, rev, byUserId) {
      emit(farmId, 'state', { rev, byUserId, at: Date.now() }, byUserId)
    },
    coop(farmId, byUserId, kind) {
      emit(farmId, 'coop', { kind, byUserId, at: Date.now() }, byUserId)
    },
    // 强制下线某用户的全部连接（被踢出/解散共营时，避免其继续看到实时推送）
    closeUser(farmId, userId) {
      const r = rooms.get(farmId)
      if (!r) return
      for (const [cid, c] of r) {
        if (c.userId !== userId) continue
        c.send('kicked', { at: Date.now() })
        c.end?.()
        r.delete(cid)
      }
      emit(farmId, 'presence', { online: onlineUserIds(farmId), reason: 'leave', userId })
    },
    onlineUserIds(farmId) {
      return onlineUserIds(farmId)
    }
  }
}
