/** 受信任的本地数据层：原子 JSON 写入、跨进程锁、敏感内容丢弃；模型和渠道必须通过 access 层。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { newToken, hashToken, rid, safeEqual, DEFAULT_SCOPES, normalizeScopes } from './security.mjs'
import { discardPrivate, isSensitive, DISCARDED } from './privacy.mjs'
import { protectHome } from './permissions.mjs'
import { renderSharedVideoDiary } from './shared-video-diary.mjs'

const VERSION = 1
const AUDIT_CAP = 2000
const AUDIT_DETAIL_MAX = 400
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000
export const ITEM_STATUSES = Object.freeze(['queued', 'seen', 'done', 'archived'])
export const CMD_STATUSES = Object.freeze(['pending', 'started', 'done', 'failed'])

const iso = () => new Date().toISOString()

function sleepSync(ms) {
  const end = Date.now() + ms
  try {
    const arr = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(arr, 0, 0, ms)
  } catch {
    while (Date.now() < end) { /* 忙等兜底（理论上不会走到） */ }
  }
}

const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''))

function emptyDb() {
  return {
    version: VERSION,
    createdAt: iso(),
    channels: {},
    items: [],
    commands: [],
    seen: {},
    kv: {},
    audit: [],
  }
}

function migrate(db) {
  const base = emptyDb()
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('鱼塘数据必须是对象')
  for (const key of ['items', 'commands', 'audit']) {
    if (db[key] !== undefined && !Array.isArray(db[key])) throw new Error('鱼塘列表结构无效')
  }
  for (const key of ['channels', 'kv', 'seen']) {
    if (db[key] !== undefined && (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key]))) throw new Error('鱼塘索引结构无效')
  }
  const out = {
    ...base,
    ...db,
    version: VERSION,
    channels: db.channels && typeof db.channels === 'object' ? db.channels : {},
    items: Array.isArray(db.items) ? db.items : [],
    commands: Array.isArray(db.commands) ? db.commands : [],
    seen: db.seen && typeof db.seen === 'object' ? db.seen : {},
    kv: db.kv && typeof db.kv === 'object' ? db.kv : {},
    audit: Array.isArray(db.audit) ? db.audit : [],
  }
  return out
}

/** 默认鱼塘目录：POND_HOME 覆盖，否则 ~/.dsh/pond */
export function defaultPondHome() {
  return process.env.POND_HOME || path.join(os.homedir(), '.dsh', 'pond')
}

export class Pond {
  constructor(home = defaultPondHome()) {
    this.home = path.resolve(home)
    this.file = path.join(this.home, 'pond.json')
    this.keysFile = path.join(this.home, 'keys.json')
    this.lockFile = path.join(this.home, 'pond.lock')
    // Publishing a minimal local activity summary is explicitly enabled per installation.
    this.lifeWindowHome = this.home === path.resolve(defaultPondHome()) && fs.existsSync(path.join(this.home, 'life-window-summary.enabled'))
      ? path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) : null
  }

  /** 打开（必要时建目录）；不会自动建数据文件。 */
  static open(home = defaultPondHome()) {
    const p = new Pond(home)
    fs.mkdirSync(p.home, { recursive: true, mode: 0o700 })
    return p
  }

  // ── 基础设施 ────────────────────────────────────────────────────────────────

  _load() {
    try {
      return migrate(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch (error) {
      if (error.code === 'ENOENT') return emptyDb()
      throw new Error('鱼塘数据读取失败，已停止操作以保护原文件', { cause: error })
    }
  }

  _atomicWrite(db) {
    const tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(db) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try { fs.chmodSync(this.file, 0o600) } catch { /* Windows 上 chmod 是尽力而为 */ }
  }

  _withLock(fn) {
    const deadline = Date.now() + LOCK_WAIT_MS
    let fd = null
    for (;;) {
      try {
        fd = fs.openSync(this.lockFile, 'wx')
        try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })) } finally { fs.closeSync(fd) }
        break
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        try {
          const st = fs.statSync(this.lockFile)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(this.lockFile)
            continue
          }
        } catch { /* 锁刚被释放，重试 */ }
        if (Date.now() > deadline) throw new Error('pond 写锁等待超时：' + this.lockFile + '（若确认无进程在写，可删除该文件）')
        sleepSync(20)
      }
    }
    try {
      return fn()
    } finally {
      try { fs.unlinkSync(this.lockFile) } catch { /* 已被回收 */ }
    }
  }

  /** 写事务：读 → 改 → 原子落盘。mutator 的返回值会透传。 */
  tx(mutator) {
    return this._withLock(() => {
      const db = this._load()
      const result = mutator(db)
      this._atomicWrite(db)
      return result
    })
  }

  /** 只读快照（原子 rename 保证一致）。 */
  read() {
    return this._load()
  }

  /** 首次使用：建空库 + owner 令牌。幂等。 */
  init() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 })
    protectHome(this.home)
    if (!fs.existsSync(this.file)) this.tx(() => {})
    this.ensureOwnerToken()
    const privacyCleanup = this.privacyClean()
    return { ok: true, home: this.home, file: this.file, privacyCleanup }
  }

  // ── owner 令牌 ──────────────────────────────────────────────────────────────

  _readKeys() {
    try {
      const keys = JSON.parse(fs.readFileSync(this.keysFile, 'utf8'))
      if (!keys || typeof keys !== 'object' || !/^dp_[a-f0-9]{48}$/.test(keys.owner)) throw new Error('无效令牌结构')
      return keys
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw new Error('令牌文件读取失败，拒绝自动覆盖', { cause: error })
    }
  }

  ensureOwnerToken() {
    return this._withLock(() => {
      const keys = this._readKeys()
      if (keys.owner) return keys.owner
      const token = newToken()
      this._writeKeys(token)
      return token
    })
  }

  ownerToken() {
    const keys = this._readKeys()
    return typeof keys.owner === 'string' && keys.owner.startsWith('dp_') ? keys.owner : ''
  }

  rotateOwnerToken() {
    const token = newToken()
    this._withLock(() => this._writeKeys(token))
    return token
  }

  _writeKeys(token) {
    const tmp = this.keysFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ owner: token, createdAt: iso() }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.keysFile)
  }

  // ── 渠道 ────────────────────────────────────────────────────────────────────

  static publicChannel(c) {
    if (!c) return null
    return { id: c.id, name: c.name, kind: c.kind, scopes: c.scopes ?? [], enabled: !!c.enabled, createdAt: c.createdAt ?? null, lastSeenAt: c.lastSeenAt ?? null }
  }

  _findChannel(db, idOrName) {
    if (!idOrName) return null
    if (db.channels[idOrName]) return db.channels[idOrName]
    return Object.values(db.channels).find((c) => c.name === idOrName) ?? null
  }

  channelAdd({ name, kind = 'custom', scopes } = {}) {
    const cleanName = String(name ?? '').trim()
    if (!cleanName) throw new Error('渠道必须有 name（如 qq / wechat / bili / 随便一个标识）')
    if (/\s/.test(cleanName)) throw new Error('渠道 name 不能含空白')
    let scopesList
    try { scopesList = normalizeScopes(scopes ?? DEFAULT_SCOPES[kind] ?? ['items:read']) } catch (error) { error.status = 400; throw error }
    const token = newToken()
    return this.tx((db) => {
      if (Object.values(db.channels).some((c) => c.name === cleanName)) throw new Error(`渠道已存在：${cleanName}（先 revoke 或换名）`)
      const ch = {
        id: rid('ch'),
        name: cleanName,
        kind,
        scopes: scopesList,
        tokenHash: hashToken(token),
        enabled: true,
        createdAt: iso(),
        lastSeenAt: null,
      }
      db.channels[ch.id] = ch
      this._auditInto(db, { actor: 'owner', action: 'channel:add', target: ch.id, detail: `${ch.name}（${ch.kind}）scope=${ch.scopes.join(',')}` })
      return { channel: Pond.publicChannel(ch), token }
    })
  }

  channelList() {
    const db = this.read()
    return Object.values(db.channels).map(Pond.publicChannel)
  }

  channelRotate(idOrName) {
    const token = newToken()
    return this.tx((db) => {
      const ch = this._findChannel(db, idOrName)
      if (!ch) throw new Error('渠道不存在：' + idOrName)
      ch.tokenHash = hashToken(token)
      this._auditInto(db, { actor: 'owner', action: 'channel:rotate', target: ch.id, detail: ch.name })
      return { channel: Pond.publicChannel(ch), token }
    })
  }

  channelRevoke(idOrName) {
    return this.tx((db) => {
      const ch = this._findChannel(db, idOrName)
      if (!ch) return { ok: false, error: '渠道不存在：' + idOrName }
      delete db.channels[ch.id]
      this._auditInto(db, { actor: 'owner', action: 'channel:revoke', target: ch.id, detail: ch.name })
      return { ok: true, revoked: ch.id }
    })
  }

  /** 认证：返回 { kind:'owner', scopes:'*' } / { kind:'channel', scopes, channel } / null。 */
  authenticate(token) {
    if (!token) return null
    const owner = this.ownerToken()
    if (owner && safeEqual(token, owner)) return { kind: 'owner', scopes: '*' }
    const hash = hashToken(token)
    const db = this.read()
    for (const ch of Object.values(db.channels)) {
      if (ch.enabled && ch.tokenHash && safeEqual(hash, ch.tokenHash)) {
        if (!Array.isArray(ch.scopes) || ch.scopes.some(s => s === '*' || s === 'admin')) return null
        return { kind: 'channel', scopes: ch.scopes, channel: Pond.publicChannel(ch) }
      }
    }
    return null
  }

  /** 轻量记录渠道活跃时间（60 秒节流，避免每个请求一次写盘）。 */
  channelTouch(id) {
    try {
      this.tx((db) => {
        const ch = db.channels[id]
        if (!ch) return
        const last = ch.lastSeenAt ? new Date(ch.lastSeenAt).getTime() : 0
        if (Date.now() - last >= 60_000) ch.lastSeenAt = iso()
      })
    } catch { /* 只影响统计，忽略 */ }
  }

  // ── 内容条目（items）────────────────────────────────────────────────────────

  addItem(input = {}, actor = 'tool') {
    if (discardPrivate(input)) {
      this.audit({ actor, action: 'privacy:discard' })
      return { dup: false, item: null, ...DISCARDED }
    }
    const now = iso()
    const kind = String(input.kind ?? 'note')
    const source = String(input.source ?? 'misc')
    const bvid = input.bvid ? String(input.bvid) : ''
    const url = input.url ? String(input.url) : ''
    const title = input.title ? String(input.title) : ''
    const text = input.text ? String(input.text) : ''
    let payload = input.payload ?? null
    if (payload !== null && typeof payload !== 'object') throw new Error('payload 必须是对象或省略')
    const tags = Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean) : []
    const dedupeKey = input.dedupeKey ? String(input.dedupeKey) : (bvid || url || (text ? 'txt:' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) : ''))
    return this.tx((db) => {
      if (input.dedupe && dedupeKey) {
        const scopedKey = JSON.stringify([input.principal ?? 'owner', dedupeKey])
        if (db.seen[scopedKey]) return { dup: true, item: null, dedupeKey }
        db.seen[scopedKey] = { at: now, meta: { source, kind } }
      }
      const item = {
        id: rid('it'),
        kind, source, bvid, title, url, text,
        payload,
        principal: input.principal ?? 'owner',
        sharedWith: [],
        tags,
        fromChannel: input.fromChannel ? String(input.fromChannel) : '',
        fromUser: input.fromUser ? String(input.fromUser) : '',
        status: 'queued',
        private: !!input.private,
        dedupeKey: dedupeKey || '',
        createdAt: now,
        updatedAt: now,
      }
      db.items.push(item)
      this._auditInto(db, { actor, action: 'item:add', target: item.id })
      return { dup: false, item }
    })
  }

  listItems({ status, source, q, limit = 50, canSeePrivate = false } = {}) {
    const db = this.read()
    const want = status ? (Array.isArray(status) ? status : [status]) : null
    const needle = String(q ?? '').toLowerCase()
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500)
    const rows = db.items.filter((it) => {
      if (it.private && !canSeePrivate) return false
      if (want && !want.includes(it.status)) return false
      if (source && it.source !== source) return false
      if (needle) {
        const hay = [it.title, it.text, it.bvid, it.url, (it.tags ?? []).join(' ')].join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    rows.sort((a, b) => cmp(b.createdAt, a.createdAt))
    return { items: rows.slice(0, lim), total: rows.length }
  }

  getItem(id) {
    return this.read().items.find((it) => it.id === id) ?? null
  }

  /** 最老的排队条目（FIFO；不消费）。 */
  nextQueuedItem({ canSeePrivate = false } = {}) {
    const rows = this.read().items.filter((it) => it.status === 'queued' && (canSeePrivate || (!it.private && !isSensitive(it)))).sort((a, b) => cmp(a.createdAt, b.createdAt))
    return rows[0] ?? null
  }

  /** 按 dedupeKey 找（bvid/url/文本指纹）。 */
  findItemByKey(key) {
    if (!key) return null
    return this.read().items.find((it) => it.dedupeKey === key) ?? null
  }

  setItemStatus(id, status) {
    if (!ITEM_STATUSES.includes(status)) throw new Error('非法 item status：' + status)
    return this.tx((db) => {
      const it = db.items.find((x) => x.id === id)
      if (!it) return { ok: false, error: 'item 不存在：' + id }
      it.status = status
      it.updatedAt = iso()
      this._auditInto(db, { actor: 'tool', action: 'item:status', target: id, detail: status })
      return { ok: true, item: it }
    })
  }

  // ── 指令（commands）─────────────────────────────────────────────────────────

  addCommand({ channel = 'local', user = '', action = 'note', args = null, wake = true, principal = 'owner', private: privateFlag = false } = {}) {
    if (discardPrivate({ channel, user, action, args, private: privateFlag })) {
      this.audit({ actor: principal, action: 'privacy:discard' })
      return { ...DISCARDED }
    }
    const act = String(action)
    if (!act) throw new Error('command 需要 action')
    return this.tx((db) => {
      const cmd = {
        id: rid('cmd'),
        channel: String(channel),
        principal,
        sharedWith: [],
        user: String(user),
        action: act,
        args: args ?? null,
        wake: !!wake,
        status: 'pending',
        result: null,
        error: null,
        createdAt: iso(),
        startedAt: null,
        finishedAt: null,
      }
      db.commands.push(cmd)
      this._auditInto(db, { actor: 'channel:' + channel, action: 'command:add', target: cmd.id, detail: act })
      return cmd
    })
  }

  listCommands({ status, limit = 50 } = {}) {
    const db = this.read()
    const want = status ? (Array.isArray(status) ? status : [status]) : null
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500)
    const rows = db.commands.filter((c) => !want || want.includes(c.status))
    rows.sort((a, b) => cmp(b.createdAt, a.createdAt))
    return { commands: rows.slice(0, lim), total: rows.length }
  }

  /** 最老的 pending 指令（不消费）。 */
  nextPendingCommand() {
    const rows = this.read().commands.filter((c) => c.status === 'pending').sort((a, b) => cmp(a.createdAt, b.createdAt))
    return rows[0] ?? null
  }

  startCommand(id) {
    return this.tx((db) => {
      const c = db.commands.find((x) => x.id === id)
      if (!c) return { ok: false, error: '指令不存在：' + id }
      if (c.status !== 'pending') return { ok: false, error: '指令不在 pending 状态' }
      c.status = 'started'
      c.startedAt = iso()
      this._auditInto(db, { actor: 'bridge', action: 'command:start', target: id, detail: c.action })
      return { ok: true, command: c }
    })
  }

  finishCommand(id, { status = 'done', result = null, error = null } = {}) {
    if (!CMD_STATUSES.includes(status)) throw new Error('非法 command status：' + status)
    return this.tx((db) => {
      const c = db.commands.find((x) => x.id === id)
      if (!c) return { ok: false, error: '指令不存在：' + id }
      c.status = status
      c.result = isSensitive(result) ? null : result
      c.error = error && !isSensitive(error) ? String(error).slice(0, 800) : null
      c.finishedAt = iso()
      this._auditInto(db, { actor: 'bridge', action: 'command:finish', target: id, detail: status })
      return { ok: true, command: c }
    })
  }

  // ── 共享 KV / 判重账本 ──────────────────────────────────────────────────────

  kvGet(key) {
    const v = this.read().kv[String(key)]
    return v ? { value: v.value, at: v.at, by: v.by } : null
  }

  kvSet(key, value, by = 'owner') {
    if (isSensitive({ key, value })) { this.audit({ actor: by, action: 'privacy:discard' }); return { ...DISCARDED } }
    const k = String(key)
    if (!k) throw new Error('kv key 不能为空')
    return this.tx((db) => {
      db.kv[k] = { value, at: iso(), by: String(by) }
      this._auditInto(db, { actor: by, action: 'kv:set', target: k, detail: 'len=' + JSON.stringify(value ?? null).length })
      return { ok: true, key: k, value, at: db.kv[k].at }
    })
  }

  kvList() {
    const db = this.read()
    return Object.entries(db.kv).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => cmp(a.key, b.key))
  }

  seenAdd(key, meta = null) {
    if (isSensitive({ key, meta })) { this.audit({ action: 'privacy:discard' }); return { ...DISCARDED } }
    const k = String(key)
    if (!k) throw new Error('seen key 不能为空')
    return this.tx((db) => {
      if (db.seen[k]) return { added: false, at: db.seen[k].at, meta: db.seen[k].meta ?? null }
      db.seen[k] = { at: iso(), meta: meta ?? null }
      return { added: true, at: db.seen[k].at, meta: db.seen[k].meta ?? null }
    })
  }

  seenCheck(key) {
    const v = this.read().seen[String(key)]
    return v ? { seen: true, at: v.at, meta: v.meta ?? null } : { seen: false }
  }

  // ── 审计 ────────────────────────────────────────────────────────────────────

  _auditInto(db, { actor = 'tool', channel = '', action = '', target = '', detail = '' } = {}) {
    const clean = (value, max) => isSensitive(value) ? '[redacted]' : String(value ?? '').slice(0, max)
    db.audit.push({ at: iso(), actor: clean(actor, 80), channel: clean(channel, 80), action: clean(action, 80), target: clean(target, 120), detail: clean(detail, AUDIT_DETAIL_MAX) })
    if (db.audit.length > AUDIT_CAP) db.audit.splice(0, db.audit.length - AUDIT_CAP)
  }

  /** 外部调用（API/CLI）写审计的公开入口。 */
  audit(entry) {
    return this.tx((db) => { this._auditInto(db, entry); return { ok: true } })
  }

  auditTail(limit = 50) {
    const db = this.read()
    return db.audit.slice(-Math.min(Math.max(Number(limit) || 50, 1), 500))
  }

  // ── 统计 / 维护 ─────────────────────────────────────────────────────────────

  stats() {
    const db = this.read()
    const byStatus = {}
    const bySource = {}
    for (const it of db.items) {
      byStatus[it.status] = (byStatus[it.status] ?? 0) + 1
      bySource[it.source] = (bySource[it.source] ?? 0) + 1
    }
    const cmdByStatus = {}
    for (const c of db.commands) cmdByStatus[c.status] = (cmdByStatus[c.status] ?? 0) + 1
    let size = 0
    try { size = fs.statSync(this.file).size } catch {}
    return {
      home: this.home,
      file: this.file,
      bytes: size,
      items: db.items.length,
      itemsByStatus: byStatus,
      itemsBySource: bySource,
      commands: db.commands.length,
      commandsByStatus: cmdByStatus,
      channels: Object.keys(db.channels).length,
      seen: Object.keys(db.seen).length,
      kv: Object.keys(db.kv).length,
      audit: db.audit.length,
      lastAuditAt: db.audit.length ? db.audit[db.audit.length - 1].at : null,
    }
  }

  /** 清理旧数据。olderThanDays 必填（≥1）。 */
  purge({ olderThanDays = 30 } = {}) {
    const days = Number(olderThanDays)
    if (!Number.isFinite(days) || days < 1) throw new Error('olderThanDays 必须是 ≥1 的数字')
    const cutoff = Date.now() - days * 86_400_000
    return this.tx((db) => {
      const before = db.items.length + db.commands.length + db.audit.length
      db.items = db.items.filter((it) => new Date(it.createdAt).getTime() >= cutoff)
      db.commands = db.commands.filter((c) => new Date(c.createdAt).getTime() >= cutoff)
      db.audit = db.audit.filter((a) => new Date(a.at).getTime() >= cutoff)
      const removed = before - (db.items.length + db.commands.length + db.audit.length)
      this._auditInto(db, { actor: 'owner', action: 'purge', target: '', detail: `olderThanDays=${days} removed=${removed}` })
      return { ok: true, removed, days }
    })
  }

  /** 清空内容（保留渠道与 owner 令牌，否则会把自己锁在外面）。 */
  wipe() {
    const result = this.tx((db) => {
      db.items = []
      db.commands = []
      db.seen = {}
      db.kv = {}
      db.audit = []
      if (db.learning !== undefined) db.learning = { bindings: {}, preferences: {}, videos: {}, forgottenVideos: {} }
      delete db.interestMemory
      delete db.recommendations
      delete db.sharedVideoDiary
      this._auditInto(db, { actor: 'owner', action: 'wipe', target: '', detail: 'items/commands/seen/kv/audit cleared' })
      return { ok: true }
    })
    renderSharedVideoDiary(this)
    return result
  }

  exportAll() {
    return this.read()
  }

  /** Only exposed through the local owner CLI; AI/channel inputs cannot grant sharing. */
  share(collection, id, principals) {
    if (!['items', 'commands'].includes(collection)) throw new Error('只能分享内容或指令')
    if (!Array.isArray(principals) || principals.some(p => typeof p !== 'string' || !/^(session|channel):[^\s]{1,200}$/.test(p) || isSensitive(p))) throw new Error('分享目标须为 session:<会话ID> 或 channel:<渠道ID>')
    return this.tx(db => {
      const row = db[collection].find(row => row.id === id)
      if (!row || row.private || isSensitive(row)) throw new Error('内容不存在或包含隐私，不能分享')
      row.sharedWith = [...new Set(principals)]
      this._auditInto(db, { actor: 'owner', action: 'privacy:share', target: id })
      return { ok: true, id, sharedWith: row.sharedWith }
    })
  }

  forget({ id, key } = {}) {
    if (!id && !key) throw new Error('forget 需要 id 或 key')
    return this.tx(db => {
      const count = db.items.length + db.commands.length
      if (id) {
        db.items = db.items.filter(row => row.id !== id)
        db.commands = db.commands.filter(row => row.id !== id)
      }
      const removedKey = key ? Object.hasOwn(db.kv, key) : false
      if (key) delete db.kv[key]
      this._auditInto(db, { actor: 'owner', action: 'privacy:forget', target: id ?? '' })
      return { ok: true, forgotten: count !== db.items.length + db.commands.length || removedKey }
    })
  }

  /** Remove legacy private/sensitive content; never return or log the removed values. */
  privacyClean() {
    return this.tx(db => {
      let removed = 0
      for (const name of ['items', 'commands', 'audit']) {
        const before = db[name].length
        db[name] = db[name].filter(row => !discardPrivate(row))
        removed += before - db[name].length
      }
      for (const name of ['kv', 'seen']) {
        for (const [key, value] of Object.entries(db[name])) {
          if (isSensitive({ key, value })) { delete db[name][key]; removed++ }
        }
      }
      if (removed) this._auditInto(db, { actor: 'owner', action: 'privacy:cleanup', detail: 'removed=' + removed })
      return { removed }
    })
  }
}

export { DEFAULT_SCOPES }
