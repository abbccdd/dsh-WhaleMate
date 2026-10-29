/** Local privacy extension for Tencent dsh-qqbot. The transport remains Tencent's official SDK. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const ownerHome = () => process.env.POND_HOME || path.join(os.homedir(), '.dsh', 'pond')
const statePath = home => path.join(home, 'qq-owner.json')
const digest = s => crypto.createHash('sha256').update(s).digest('hex')
// Only lifecycle and pairing outcomes are recorded, never message text or IDs.
export function recordQQDiagnostic(kind, outcome, home = ownerHome()) {
  fs.writeFileSync(path.join(home, `qq-${kind}-status.json`), JSON.stringify({ outcome, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
}
function read(home) {
  try { return JSON.parse(fs.readFileSync(statePath(home), 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw new Error('QQ 主人身份状态无法读取')
  }
}
function write(home, value) {
  const file = statePath(home)
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Local owner begins a one-time pairing; no code is written to application logs. */
export function prepareOwnerPairing(home = ownerHome()) {
  const old = read(home)
  if (old?.ownerOpenId) throw new Error('已经绑定主人，不能覆盖；请先显式解除绑定')
  const code = 'FISH-' + crypto.randomBytes(8).toString('hex').toUpperCase()
  const expiresAt = Date.now() + 30 * 60 * 1000
  write(home, { codeHash: digest(code), expiresAt, ownerOpenId: null, appId: null })
  fs.writeFileSync(path.join(home, 'qq-pairing-code.txt'), `请在 QQ 里给机器人发送这条一次性绑定消息（30分钟有效）：\n\n${code}\n`, { mode: 0o600 })
  return { ok: true, codeFile: path.join(home, 'qq-pairing-code.txt'), expiresAt: new Date(expiresAt).toISOString() }
}

export function ownerStatus(home = ownerHome()) {
  const state = read(home)
  return { bound: !!state?.ownerOpenId, pairingPending: !!state?.codeHash && state.expiresAt > Date.now(), pairingExpired: !!state?.codeHash && state.expiresAt <= Date.now() }
}

export function createOwnerGuard({ home = ownerHome(), appId }) {
  if (typeof appId !== 'string' || !appId) throw new Error('QQ Bot 缺少 AppID')
  function allowed(target) {
    const state = read(home)
    return !!state?.ownerOpenId && state.appId === appId && target?.scope === 'c2c' && target.targetId === state.ownerOpenId
  }
  async function inbound(ctx, next) {
    const msg = ctx.message
    if (msg?.kind !== 'c2c' || typeof msg.senderId !== 'string' || !msg.senderId) return
    recordQQDiagnostic('inbound', 'c2c_received', home)
    const state = read(home)
    if (state?.ownerOpenId) {
      if (state.appId === appId && state.ownerOpenId === msg.senderId) return next()
      return
    }
    if (!state?.codeHash || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now() || typeof msg.content !== 'string') return
    const value = msg.content.trim()
    if (!/^FISH-[A-F0-9]{16}$/.test(value)) { recordQQDiagnostic('pairing', 'format_mismatch', home); return }
    const lockFile = path.join(home, 'qq-pairing.lock')
    let lock
    try { lock = fs.openSync(lockFile, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') return; throw e }
    try {
      // Another process may have completed pairing while this message was in flight.
      const current = read(home)
      if (current?.ownerOpenId || !current?.codeHash || current.expiresAt <= Date.now()) return
      const supplied = Buffer.from(digest(value), 'hex')
      const expected = Buffer.from(current.codeHash, 'hex')
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(supplied, expected)) { recordQQDiagnostic('pairing', 'code_mismatch', home); return }
      write(home, { ownerOpenId: msg.senderId, appId, pairedAt: new Date().toISOString() })
      recordQQDiagnostic('pairing', 'paired', home)
    } finally {
      fs.closeSync(lock)
      fs.unlinkSync(lockFile)
    }
    // Pairing message is consumed locally, never passed to the model or replied to.
  }
  return { allowed, inbound }
}

/** Intercept every message-capable SDK method used by the pinned plugin. */
export function installOwnerSendGuard(bot, guard) {
  const direct = ['sendText', 'sendTextWithKeyboard', 'sendMarkdown', 'sendWakeup', 'sendTyping', 'sendImage', 'sendVideo', 'sendVoice', 'sendFile']
  const options = ['send', 'openStream', 'sendMedia', 'uploadMedia']
  for (const method of [...direct, ...options]) {
    if (typeof bot[method] !== 'function') continue
    const original = bot[method].bind(bot)
    bot[method] = (...args) => {
      const target = options.includes(method) ? args[0]?.target : args[0]
      if (!guard.allowed(target)) throw new Error('QQ 发送被拒绝：只允许已核实主人的私聊')
      return original(...args)
    }
  }
  for (const method of ['sendChannelMessage', 'sendDmMessage']) {
    if (typeof bot[method] === 'function') bot[method] = () => { throw new Error('QQ 频道发送已禁用') }
  }
}
