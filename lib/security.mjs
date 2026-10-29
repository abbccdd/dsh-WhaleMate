/** 认证原语：渠道只存令牌哈希；owner 管理令牌独立落盘；权限和隐私由 access/privacy 模块执行。 */
import crypto from 'node:crypto'

/** 全部合法的 scope 名。'*' 只给 owner。 */
export const ALL_SCOPES = Object.freeze([
  'items:read', 'items:write',
  'commands:read', 'commands:write',
  'kv:read', 'kv:write',
  'seen:read', 'seen:write',
  'profile:read',
  'learning:access',
  'documents:read',
  'admin',
])

/** 生成一个渠道令牌：dp_ + 48 位十六进制（24 字节随机）。 */
export function newToken() {
  return 'dp_' + crypto.randomBytes(24).toString('hex')
}

/** 令牌落盘哈希（sha256 十六进制）。 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/** 随机 id：it_xxx / cmd_xxx / ch_xxx。 */
export function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
}

/** 常量时间比较（防时序侧信道）。长度不同直接 false。 */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * 规范化一组 scope：去重、校验、保持顺序。
 * @param {string[]|string} scopes - 数组或逗号分隔字符串
 * @returns {string[]}
 */
export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes ?? '').split(',')
  const out = []
  for (const raw of list) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (s === '*' || s === 'admin') throw new Error('管理权限只属于 owner，渠道不能声明')
    if (!ALL_SCOPES.includes(s)) throw new Error(`未知 scope：${s}（可用：${ALL_SCOPES.join(' / ')}）`)
    if (!out.includes(s)) out.push(s)
  }
  if (!out.length) throw new Error('至少给一个 scope（不给 = 什么都不能做）')
  return out
}

/**
 * 判定一组已授予的 scope 能否满足某个需求。
 * @param {string[]} granted - 授予的 scope 列表（'*' 也接受，表示全部）
 * @param {string} need - 需要的 scope，如 'items:write'
 */
export function allows(granted, need) {
  if (granted === '*' || (Array.isArray(granted) && (granted.includes('*') || granted.includes(need)))) return true
  return false
}

/** 默认渠道 scope 建议（按应用类型）。 */
export const DEFAULT_SCOPES = Object.freeze({
  qq: ['commands:write', 'items:read', 'profile:read'],
  wechat: ['items:write', 'items:read', 'profile:read'],
  bili: ['items:write', 'seen:write', 'profile:read'],
  gui: ['items:read', 'commands:read', 'profile:read'],
  custom: ['items:read'],
})

/**
 * 解析 Authorization / x-pond-key 里的令牌。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} 空串表示没带
 */
export function tokenFromRequest(req, url) {
  const h = req.headers['x-pond-key']
  if (typeof h === 'string' && h.trim()) return h.trim()
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  return ''
}
