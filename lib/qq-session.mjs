/** Map the verified QQ private peer to the session ID used by Tencent's pinned adapter. */
import crypto from 'node:crypto'

export function verifiedQQSession(state, prefs = {}) {
  if (typeof state?.ownerOpenId !== 'string' || !state.ownerOpenId || typeof state.appId !== 'string' || !state.appId) throw new Error('QQ 主人尚未完成验证')
  const key = `qqbot:${state.appId}:c2c:${state.ownerOpenId}`
  const current = prefs.sessionIds?.[key]
  if (current !== undefined) {
    if (typeof current !== 'string' || !/^[0-9a-f-]{36}$/i.test(current)) throw new Error('QQ 会话身份记录无效')
    return current
  }
  const hash = crypto.createHash('sha256').update(key).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}
