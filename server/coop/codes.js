import { randomBytes } from 'node:crypto'

// 去歧义字符集（不含 0/O/1/I/L），邀请码/农场码人工输入更友好
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// 随机码：邀请码默认 8 位，永久农场码 6 位
export function randomCode(len = 8, rng = randomBytes) {
  const bytes = rng(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

// 用户登录令牌（hex，足够长不可猜）
export function newToken() {
  return randomBytes(24).toString('hex')
}
