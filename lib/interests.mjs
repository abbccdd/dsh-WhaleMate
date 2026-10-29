/** Contextual, owner-only recent interests. No raw messages or global prompt injection. */
import crypto from 'node:crypto'
import { isSensitive } from './privacy.mjs'
import { allows } from './security.mjs'
import { forgetWhaleInterestHistory } from './whale-interest.mjs'
import { forgetAutoMemory } from './auto-memory.mjs'

const DAY = 86400000
const WANT_TTL = 14 * DAY
const REPEAT_COOLDOWN = 7 * DAY
const SKIP_TTL = 30 * DAY
const TUTORIAL_REQUEST_TTL = 10 * 60 * 1000
const NAME = /^[\p{Script=Han}]{2,12}$/u
const error = text => Object.assign(new Error(text), { status: 403 })

function authorized(store, principal, scopes) {
  if (!allows(scopes, 'learning:access')) throw error('没有 learning:access 权限')
  const bindings = store.read().learning?.bindings ?? {}
  if (!Object.hasOwn(bindings, principal) || bindings[principal] !== 'owner') throw error('仅已授权主人私人会话可访问兴趣')
}

function interests(db) {
  if (db.interestMemory === undefined) db.interestMemory = { version: 1, entries: [], eventHashes: [] }
  const m = db.interestMemory
  if (!m || m.version !== 1 || !Array.isArray(m.entries) || !Array.isArray(m.eventHashes)) throw new Error('兴趣记忆格式无效')
  return m
}

/** Deliberately narrow parser: direct first-person statements only, no quoted or raw chat retained. */
export function extractCookingInterest(text) {
  if (typeof text !== 'string' || text.length > 1000 || isSensitive(text) || /[?？\[\]【】“”"「」『』]/u.test(text)) return null
  const match = text.normalize('NFKC').trim().match(/^(?:(?:我|我现在|我今天|我最近|今天我|最近我|现在我)\s*)?(想吃|想做|喜欢吃|爱吃|不喜欢吃|不爱吃|不想吃|别总推荐|不要老推荐)\s*([\p{Script=Han}]{2,12})(?:[，,。！!\s]|$)/u)
  if (!match) return null
  const subject = match[2].replace(/[了呢吧]$/u, '')
  if (!NAME.test(subject) || isSensitive(subject)) return null
  // “想做角色/模型/游戏” is not a cooking request. Bare 想做 needs an edible cue.
  if (match[1] === '想做' && !/蛋|肉|饭|菜|汤|糕|面|饼|粥|鸡|鱼|豆腐|饺|馄饨|三明治|面包|甜点|布丁|寿司|披萨|火锅|麻辣烫/u.test(subject)) return null
  const intent = ['想吃', '想做'].includes(match[1]) ? 'want' : ['喜欢吃', '爱吃'].includes(match[1]) ? 'like' : ['别总推荐', '不要老推荐'].includes(match[1]) ? 'suppress' : match[1] === '不想吃' ? 'pause' : 'avoid'
  return { subject, intent }
}

/** Receives host-supplied live events, not model-supplied source labels or chat history. */
export function observeInterestEvent(store, session, event, now = Date.now()) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Number.isSafeInteger(event.seq) || event.seq < 0) return { recorded: false }
  const sid = session?.id ?? session?.header?.id
  if (typeof sid !== 'string' || !sid || sid.length > 200) return { recorded: false }
  const principal = 'session:' + sid
  const bindings = store.read().learning?.bindings ?? {}
  if (!Object.hasOwn(bindings, principal) || bindings[principal] !== 'owner') return { recorded: false }
  const c = event.data.content
  // Do not inspect quoted messages, attachments or multiple text blocks as if they were direct speech.
  const text = typeof c === 'string' ? c : Array.isArray(c) && c.length === 1 && c[0]?.type === 'text' ? c[0].text : null
  const observation = extractCookingInterest(text)
  const tutorialRequest = typeof text === 'string' && text.length <= 1000 && !isSensitive(text) && !/[\[\]【】“”"「」『』]/u.test(text) && /做饭|做菜|烹饪|菜谱|食谱|做法/u.test(text) && /推荐|找|来|给|教|学|教程|怎么|做法|菜谱|食谱/u.test(text)
  if (!observation && !tutorialRequest) {
    if (store.read().interestMemory?.tutorialRequests?.[principal]) store.tx(db => { delete db.interestMemory.tutorialRequests[principal] })
    return { recorded: false }
  }
  const eventHash = crypto.createHash('sha256').update(JSON.stringify([principal, event.seq])).digest('hex')
  return store.tx(db => {
    // Recheck binding inside the same transaction as the write.
    if (db.learning?.bindings?.[principal] !== 'owner') return { recorded: false }
    const m = interests(db)
    if (m.eventHashes.includes(eventHash)) return { recorded: false, duplicate: true }
    if (tutorialRequest) {
      m.tutorialRequests ??= {}
      m.tutorialRequests[principal] = now + TUTORIAL_REQUEST_TTL
    } else if (m.tutorialRequests) {
      delete m.tutorialRequests[principal]
    }
    if (!observation) {
      m.eventHashes.push(eventHash); m.eventHashes = m.eventHashes.slice(-1000)
      return { recorded: false, tutorialRequest: true }
    }
    let entry = m.entries.find(row => row.subject === observation.subject)
    if (!entry) {
      if (m.entries.length >= 500) throw error('兴趣记忆已满，请先整理')
      entry = { subject: observation.subject, domain: 'cooking', lastUsedAt: null }
      m.entries.push(entry)
    }
    const previousIntent = entry.intent
    const pause = ['suppress', 'pause'].includes(observation.intent)
    entry.intent = pause ? (['want', 'like'].includes(previousIntent) ? previousIntent : 'suppress') : observation.intent
    entry.updatedAt = new Date(now).toISOString()
    entry.sourceHash = eventHash
    if (!pause) entry.expiresAt = observation.intent === 'want' ? new Date(now + WANT_TTL).toISOString() : null
    entry.suppressedUntil = pause ? new Date(now + (observation.intent === 'suppress' ? SKIP_TTL : REPEAT_COOLDOWN)).toISOString() : null
    m.eventHashes.push(eventHash); m.eventHashes = m.eventHashes.slice(-1000)
    store._auditInto(db, { actor: principal, action: 'interest:observe', detail: 'cooking' })
    return { recorded: true }
  })
}

// A visible assistant answer to an outstanding tutorial request closes the recommendation cooldown.
// The event proves generation, not delivery; no message content is persisted.
export function observeInterestReply(store, session, event, now = Date.now()) {
  if (event?.type !== 'assistant/message' || !Number.isSafeInteger(event.seq) || event.seq < 0) return
  const sid = session?.id ?? session?.header?.id
  if (typeof sid !== 'string' || !sid) return
  const principal = 'session:' + sid, db = store.read()
  if (db.learning?.bindings?.[principal] !== 'owner' || !(db.interestMemory?.tutorialRequests?.[principal] > now)) return
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return
  const text = blocks.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n')
  if (!text || isSensitive(text) || !/(?:https?:\/\/|BV[0-9A-Za-z]{10})/u.test(text) || !/推荐|教程|做法|菜谱|食谱/u.test(text)) return
  const candidates = db.interestMemory.entries.filter(x => ['want', 'like'].includes(x.intent) && text.includes(x.subject))
  if (candidates.length !== 1) return
  store.tx(data => {
    if (data.learning?.bindings?.[principal] !== 'owner' || !(data.interestMemory?.tutorialRequests?.[principal] > now)) return
    const row = data.interestMemory.entries.find(x => x.subject === candidates[0].subject)
    if (!row) return
    row.lastUsedAt = new Date(now).toISOString()
    delete data.interestMemory.tutorialRequests[principal]
    store._auditInto(data, { actor: principal, action: 'interest:used', detail: 'assistant-reply' })
  })
}

export function interestAction(store, identity, args, now = Date.now()) {
  authorized(store, identity.principal, identity.scopes)
  if (args.action === 'interest_recall') {
    if (args.interestContext !== 'cooking') throw error('只在用户要求找做饭教程时使用 cooking 上下文')
    const m = store.read().interestMemory ?? { entries: [] }
    const candidates = m.entries.filter(row => row.domain === 'cooking' && ['want', 'like'].includes(row.intent) && (!row.expiresAt || Date.parse(row.expiresAt) > now) && (!row.suppressedUntil || Date.parse(row.suppressedUntil) <= now) && (!row.lastUsedAt || Date.parse(row.lastUsedAt) + REPEAT_COOLDOWN <= now))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.subject.localeCompare(b.subject))
    const avoid = m.entries.filter(row => row.domain === 'cooking' && row.intent === 'avoid').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20).map(row => row.subject)
    const avoidRepeat = m.entries.filter(row => row.domain === 'cooking' && (row.intent === 'suppress' || (row.suppressedUntil && Date.parse(row.suppressedUntil) > now) || (row.lastUsedAt && Date.parse(row.lastUsedAt) + REPEAT_COOLDOWN > now))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20).map(row => row.subject)
    store.audit({ actor: identity.principal, action: 'interest:recall', detail: 'cooking' })
    return { ok: true, action: args.action, candidates: candidates.slice(0, 3).map(({ subject, intent, updatedAt, expiresAt }) => ({ subject, intent, updatedAt, expiresAt })), avoid, avoidRepeat, explore: candidates.length === 0, usage: '仅为当前做饭请求提供候选，近期想吃不代表长期喜欢。用户没有明确点名时避免 avoid 和 avoidRepeat 的菜；没有候选时探索其他菜或询问，不要编造教程链接。' }
  }
  if (typeof args.interestSubject !== 'string' || !NAME.test(args.interestSubject) || isSensitive(args.interestSubject)) throw error('菜名格式无效')
  return store.tx(db => {
    if (db.learning?.bindings?.[identity.principal] !== 'owner') throw error('主人私人会话授权已撤销')
    const m = interests(db)
    const index = m.entries.findIndex(row => row.subject === args.interestSubject)
    if (args.action === 'interest_forget') {
      if (index >= 0) m.entries.splice(index, 1)
      if (db.semanticMemory) db.semanticMemory.entries = db.semanticMemory.entries.filter(row => row.subject !== args.interestSubject)
      forgetWhaleInterestHistory(db, { subject: args.interestSubject, domain: 'food' })
      forgetAutoMemory(db, args.interestSubject)
      store._auditInto(db, { actor: identity.principal, action: 'interest:forget' })
      return { ok: true, action: args.action, forgotten: index >= 0 }
    }
    if (args.action === 'interest_used') {
      if (index < 0) throw error('兴趣记录不存在')
      const requestExpiresAt = m.tutorialRequests?.[identity.principal]
      if (!Number.isSafeInteger(requestExpiresAt) || requestExpiresAt <= now) throw error('只有主人本轮请求做饭教程后才能标记推荐')
      delete m.tutorialRequests[identity.principal]
      m.entries[index].lastUsedAt = new Date(now).toISOString()
      store._auditInto(db, { actor: identity.principal, action: 'interest:used', detail: 'cooking' })
      return { ok: true, action: args.action }
    }
    throw error('未知兴趣动作')
  })
}
