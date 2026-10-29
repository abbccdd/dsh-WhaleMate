/** Short, owner-only observations grounded in a live message. No transcript is persisted. */
import crypto from 'node:crypto'
import { isSensitive } from './privacy.mjs'
import { allows } from './security.mjs'
import { rankMemoryHints } from './memory-retrieval.mjs'
import { forgetWhaleInterestHistory } from './whale-interest.mjs'
import { forgetAutoMemory } from './auto-memory.mjs'
import { memoryIsCurrent, updateMemoryLifecycle } from './memory-lifecycle.mjs'

const DAY = 86400000
const contexts = new WeakMap()
const domains = Object.freeze({ food: /吃|做饭|做菜|食谱|菜谱|烹饪|料理/u, video: /视频|电影|剧|动画|看什么/u, music: /音乐|歌曲|听歌|唱歌/u, game: /游戏|玩什么/u, activity: /活动|出门|旅行|散步|运动/u })
export const SEMANTIC_DOMAINS = Object.freeze(Object.keys(domains))
const invalid = message => { throw new Error(message) }
function contextMap(store) { let map = contexts.get(store); if (!map) contexts.set(store, map = new Map()); return map }
function authorized(store, identity) {
  if (!allows(identity.scopes, 'learning:access') || store.read().learning?.bindings?.[identity.principal] !== 'owner') invalid('仅授权主人私聊可以使用私人兴趣记忆')
}
function textOf(event) {
  const content = event.data.content
  return typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null
}
export function observeSemanticEvent(store, session, event, now = Date.now()) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Number.isSafeInteger(event.seq) || event.seq < 0) return
  const sid = session?.id ?? session?.header?.id
  if (typeof sid !== 'string' || !sid) return
  const principal = 'session:' + sid
  if (store.read().learning?.bindings?.[principal] !== 'owner') return
  const text = textOf(event)
  // Replace previous context even for a rejected message: stale messages must never authorize a write.
  const map = contextMap(store); map.delete(principal)
  if (typeof text !== 'string' || text.length > 500 || isSensitive(text) || /[\[\]【】“”"「」『』\r\n]|https?:\/\//u.test(text)) return
  const hash = crypto.createHash('sha256').update(JSON.stringify([principal, event.seq])).digest('hex')
  const row = { text: text.normalize('NFKC'), hash, expiresAt: now + 10 * 60 * 1000, used: false }
  map.set(principal, row)
  setTimeout(() => { if (map.get(principal) === row) map.delete(principal) }, 10 * 60 * 1000).unref()
}
function current(store, principal, now) {
  const map = contextMap(store), row = map.get(principal)
  if (row && row.expiresAt <= now) { map.delete(principal); return null }
  return row
}
export function currentOwnerText(store, principal, now = Date.now()) { return current(store,principal,now)?.text ?? '' }
function validSubject(subject) {
  return typeof subject === 'string' && /^(?:3d)?[\p{Script=Han}]{2,12}$/iu.test(subject) && !isSensitive(subject) && !/家人|家里|地址|姓名|账号|账户|电话|住址|学校|公司|身份证|银行卡/u.test(subject)
}
export function semanticAction(store, identity, args, now = Date.now()) {
  authorized(store, identity)
  const context = current(store, identity.principal, now)
  if (!context) invalid('没有可用的当前主人消息')
  if (args.action === 'semantic_list') {
    if (!/记得|记忆|记住|知道我|了解我|偏好|喜好/u.test(context.text)) invalid('只在主人询问私人记忆时列出')
    const db = store.read(), offset = args.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset 必须是非负整数')
    const rows = (db.semanticMemory?.entries ?? []).filter(row => memoryIsCurrent(row, now)).map(row => ({ ...row, source: 'semantic' }))
    for (const row of db.interestMemory?.entries ?? []) {
      if (row.expiresAt && Date.parse(row.expiresAt) <= now) continue
      if (rows.some(x => x.subject === row.subject && x.domain === 'food')) continue
      rows.push({ subject: row.subject, domain: 'food', signal: row.intent, observations: 1, updatedAt: row.updatedAt, expiresAt: row.expiresAt, source: 'cooking' })
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    store.audit({ actor: identity.principal, action: 'semantic:list' })
    return { ok: true, action: args.action, entries: rows.slice(offset, offset + 20).map(({ subject, domain, signal, observations, updatedAt, expiresAt, stable, source }) => ({ subject, domain, signal, observations, updatedAt, expiresAt, stable: stable === true, source })), total: rows.length, nextOffset: offset + 20 < rows.length ? offset + 20 : null, usage: '这些是私人兴趣线索，可能过时或有误；想要不等于喜欢。' }
  }
  const subject = args.observationSubject
  if (!validSubject(subject) || !context.text.includes(subject)) invalid('主题必须是主人当前消息中的非敏感短词')
  if (args.action === 'semantic_forget') {
    if (!/忘记|忘掉|删掉|删除|不要记/u.test(context.text)) invalid('需要主人当前明确要求遗忘')
    return store.tx(db => {
      if (db.learning?.bindings?.[identity.principal] !== 'owner') invalid('主人授权已撤销')
      const entries = db.semanticMemory?.entries ?? []
      const kept = entries.filter(x => x.subject !== subject)
      for (const row of entries) if (row.subject === subject) forgetWhaleInterestHistory(db, { subject, domain: row.domain })
      forgetWhaleInterestHistory(db, { subject, domain: 'food' })
      if (db.semanticMemory) db.semanticMemory.entries = kept
      const interests = db.interestMemory?.entries ?? []
      if (db.interestMemory) db.interestMemory.entries = interests.filter(x => x.subject !== subject)
      const beforeAuto = db.autoMemory?.entries.length ?? 0
      forgetAutoMemory(db,subject)
      context.used = true
      store._auditInto(db, { actor: identity.principal, action: 'semantic:forget' })
      return { ok: true, action: args.action, forgotten: entries.length !== kept.length || interests.length !== (db.interestMemory?.entries.length ?? 0) || beforeAuto !== (db.autoMemory?.entries.length ?? 0) }
    })
  }
  const domain = args.observationDomain, signal = args.observationSignal
  if (context.used || !SEMANTIC_DOMAINS.includes(domain) || !['want', 'like', 'avoid'].includes(signal)) invalid('当前消息或兴趣分类无效')
  // Require explicit first-person language and verify polarity; interpretation cannot fabricate a preference.
  const source = context.text
  if (!/^(?:(?:最近|现在|今天|这几天|这段时间)\s*)?我/u.test(source) || /[?？]|朋友|别人|她|他|你|假如|如果|不是我/u.test(source)) invalid('仅接受主人直接表达')
  const hasAvoid = /不喜欢|不爱|讨厌|不想/u.test(source)
  if ((signal === 'avoid' && !hasAvoid) || (signal !== 'avoid' && hasAvoid) || (signal === 'want' && !/想|打算|准备/u.test(source)) || (signal === 'like' && !/喜欢|偏爱|爱吃|爱看|爱听|爱玩/u.test(source))) invalid('兴趣方向与当前消息不符')
  const result = store.tx(db => {
    if (db.learning?.bindings?.[identity.principal] !== 'owner') invalid('主人授权已撤销')
    if (db.privacyReview?.enabled && db.privacyReview.verdicts?.[context.hash]?.classification === 'sensitive') invalid('敏感内容不保存')
    db.semanticMemory ??= { version: 1, entries: [], eventHashes: [] }
    const m = db.semanticMemory
    if (m.version !== 1 || !Array.isArray(m.entries) || !Array.isArray(m.eventHashes)) invalid('私人兴趣记忆格式无效')
    if (m.eventHashes.includes(context.hash)) return { ok: true, action: args.action, duplicate: true }
    let entry = m.entries.find(x => x.subject === subject && x.domain === domain)
    if (!entry) { if (m.entries.length >= 500) invalid('私人兴趣记忆已满'); entry = { subject, domain }; m.entries.push(entry) }
    const temporary = signal === 'want' || (signal === 'avoid' && /不想/u.test(source) && !/不喜欢|不爱|讨厌/u.test(source))
    if (entry.stable && temporary) entry.pauseUntil = new Date(now + 14 * DAY).toISOString()
    else Object.assign(entry, { signal, sourceHash: context.hash, pauseUntil: null, ...updateMemoryLifecycle(entry, signal, source, now, temporary) })
    if (db.autoMemory) {
      if (temporary) {
        for (const row of db.autoMemory.entries) if (row.topic === subject) row.pauseUntil = new Date(now + 14 * DAY).toISOString()
      } else db.autoMemory.entries = db.autoMemory.entries.filter(row => row.topic !== subject || row.kind === signal)
    }
    m.eventHashes.push(context.hash); m.eventHashes = m.eventHashes.slice(-1000)
    store._auditInto(db, { actor: identity.principal, action: 'semantic:observe', detail: domain })
    return { ok: true, action: args.action, recorded: true }
  })
  context.used = true
  return result
}
/** Only inject relevant weak hints into an authorized owner's current conversation. */
export function semanticHints(store, principal, now = Date.now()) {
  const db = store.read()
  if (db.learning?.bindings?.[principal] !== 'owner') return []
  const context = current(store, principal, now)
  if (!context) return []
  const candidates = (db.semanticMemory?.entries ?? []).filter(x => {
    if (!memoryIsCurrent(x, now) || Date.parse(x.pauseUntil) > now) return false
    // The cooking mechanism owns its own expiration and recommendation cooldown.
    const cooking = x.domain === 'food' && db.interestMemory?.entries?.find(row => row.subject === x.subject)
    if (cooking && ((cooking.expiresAt && Date.parse(cooking.expiresAt) <= now) || (cooking.suppressedUntil && Date.parse(cooking.suppressedUntil) > now) || (cooking.lastUsedAt && Date.parse(cooking.lastUsedAt) + 7 * DAY > now))) return false
    return true
  })
  return rankMemoryHints(context.text, candidates, (domain, text) => !!domains[domain]?.test(text), now)
}
