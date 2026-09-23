// 统一 HTTP 请求层：共营登录令牌持久化在 localStorage，
// 所有 /api 请求自动带 Authorization；SSE 通道则走 query token。
const TOKEN_KEY = 'pixifarm_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data || {}
  }
}

// 401/403 全局广播：UI 层（App.vue）据此把被移出/会话失效的玩家送回加入界面
const deniedHandlers = []
export function onDenied(fn) { deniedHandlers.push(fn); return () => { const i = deniedHandlers.indexOf(fn); if (i >= 0) deniedHandlers.splice(i, 1) } }

export async function api(path, method = 'GET', body, { raw = false } = {}) {
  const opt = { method, headers: {} }
  const token = getToken()
  if (token) opt.headers.Authorization = 'Bearer ' + token
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json'
    opt.body = JSON.stringify(body)
  }
  const r = await fetch('/api' + path, opt)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) deniedHandlers.forEach((fn) => fn(data.error || '权限不足'))
    throw new ApiError(data.error || '请求失败', r.status, data)
  }
  return raw ? r : data
}
