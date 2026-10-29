import { canRead, owns, isSensitive, discardPrivate, DISCARDED, notFound } from './privacy.mjs'
import { allows } from './security.mjs'

const limitRows = (rows, limit = 50) => rows.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 500))

/** All model and HTTP channel operations use this facade, never raw owner methods. */
export function scopedStore(store, { principal, scopes }) {
  if (typeof principal !== 'string' || !principal || principal.length > 240) throw new Error('无效调用身份')
  const requireScope = scope => {
    if (!allows(scopes, scope)) throw Object.assign(new Error('没有 ' + scope + ' 权限'), { status: 403 })
  }
  const auditRead = (action, target = '') => store.audit({ actor: principal, action, target })
  const visible = (rows) => rows.filter(row => canRead(row, principal))
  const entryKey = key => JSON.stringify([principal, String(key)])
  function mutation(collection, id, apply) {
    return store.tx(db => {
      const row = db[collection].find(row => row.id === id)
      if (!row || !owns(row, principal)) throw notFound()
      apply(row)
      store._auditInto(db, { actor: principal, action: collection + ':update', target: id })
      return { ok: true, id, status: row.status }
    })
  }
  return {
    principal,
    addItem(input) {
      requireScope('items:write')
      if (discardPrivate(input)) { store.audit({ actor: principal, action: 'privacy:discard' }); return { dup: false, item: null, ...DISCARDED } }
      // Identity and disclosure grants come only from this facade, not caller-supplied fields.
      return store.addItem({ ...input, principal, sharedWith: [], fromChannel: principal }, principal)
    },
    listItems({ status, source, q, limit } = {}) {
      requireScope('items:read')
      const needle = String(q ?? '').toLowerCase()
      const rows = visible(store.read().items).filter(row => (!status || (Array.isArray(status) ? status : [status]).includes(row.status)) && (!source || row.source === source) && (!needle || [row.title, row.text, row.bvid, row.url, ...row.tags].join(' ').toLowerCase().includes(needle)))
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      auditRead('items:read')
      return { items: limitRows(rows, limit), total: rows.length }
    },
    getItem(id) {
      requireScope('items:read')
      const item = store.read().items.find(row => row.id === id)
      if (!item || !canRead(item, principal)) return null
      auditRead('item:read', id)
      return item
    },
    nextQueuedItem() {
      requireScope('items:read')
      const rows = visible(store.read().items).filter(row => row.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      auditRead('items:next')
      return rows[0] ?? null
    },
    setItemStatus(id, status) {
      requireScope('items:write')
      if (!['seen', 'done', 'archived'].includes(status)) throw new Error('非法 item status')
      return mutation('items', id, row => { row.status = status; row.updatedAt = new Date().toISOString() })
    },
    addCommand(input) {
      requireScope('commands:write')
      if (discardPrivate(input)) { store.audit({ actor: principal, action: 'privacy:discard' }); return { ...DISCARDED } }
      return store.addCommand({ ...input, principal, channel: principal, sharedWith: [] })
    },
    listCommands({ status, limit } = {}) {
      requireScope('commands:read')
      const rows = visible(store.read().commands).filter(row => !status || (Array.isArray(status) ? status : [status]).includes(row.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      auditRead('commands:read')
      return { commands: limitRows(rows, limit), total: rows.length }
    },
    nextPendingCommand() { return this.listCommands({ status: 'pending', limit: 500 }).commands.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null },
    startCommand(id) {
      requireScope('commands:write')
      return mutation('commands', id, row => {
        if (row.status !== 'pending') throw Object.assign(new Error('指令不在 pending 状态'), { status: 409 })
        row.status = 'started'; row.startedAt = new Date().toISOString()
      })
    },
    finishCommand(id, { status = 'done', result = null, error = null } = {}) {
      requireScope('commands:write')
      if (!['done', 'failed'].includes(status)) throw new Error('非法 command status')
      return mutation('commands', id, row => {
        if (!['pending', 'started'].includes(row.status)) throw Object.assign(new Error('指令已结束'), { status: 409 })
        row.status = status; row.result = isSensitive(result) ? null : result; row.error = isSensitive(error) ? null : error; row.finishedAt = new Date().toISOString()
      })
    },
    kvGet(key) {
      requireScope('kv:read')
      const value = store.kvGet(entryKey(key))
      auditRead('kv:read')
      return value && !isSensitive(value) ? value : null
    },
    kvSet(key, value) {
      requireScope('kv:write')
      if (isSensitive({ key, value })) { store.audit({ actor: principal, action: 'privacy:discard' }); return { ...DISCARDED } }
      const result = store.kvSet(entryKey(key), value, principal)
      return { ...result, key: String(key) }
    },
    kvList() {
      requireScope('kv:read')
      auditRead('kv:read')
      return store.kvList().filter(row => {
        try { return JSON.parse(row.key)[0] === principal && !isSensitive(row) } catch { return false }
      }).map(row => ({ ...row, key: JSON.parse(row.key)[1] }))
    },
    seenAdd(key, meta) {
      requireScope('seen:write')
      if (isSensitive({ key, meta })) { store.audit({ actor: principal, action: 'privacy:discard' }); return { ...DISCARDED } }
      const result = store.seenAdd(entryKey(key), meta)
      // A write-only client receives no pre-existing metadata.
      return { added: result.added }
    },
    seenCheck(key) {
      requireScope('seen:read')
      const result = store.seenCheck(entryKey(key))
      auditRead('seen:read')
      return isSensitive(result) ? { seen: false } : result
    },
    stats() {
      requireScope('items:read')
      auditRead('stats:read')
      return { items: visible(store.read().items).length, commands: allows(scopes, 'commands:read') ? visible(store.read().commands).length : 0 }
    },
    forget({ id, key } = {}) {
      if (id) {
        return store.tx(db => {
          const collection = db.items.some(row => row.id === id) ? 'items' : 'commands'
          requireScope(collection + ':write')
          const item = db[collection].find(row => row.id === id)
          // Private legacy records can be forgotten by their recorded creator too.
          if (!item || item.principal !== principal) throw notFound()
          db[collection] = db[collection].filter(row => row.id !== id)
          store._auditInto(db, { actor: principal, action: 'privacy:forget', target: id })
          return { ok: true, forgotten: true }
        })
      }
      requireScope('kv:write')
      if (!key) throw new Error('forget 需要 id 或 key')
      return store.tx(db => {
        const removed = Object.hasOwn(db.kv, entryKey(key))
        delete db.kv[entryKey(key)]
        store._auditInto(db, { actor: principal, action: 'privacy:forget' })
        return { ok: true, forgotten: removed }
      })
    },
  }
}
