/** A bounded, code-owned projection for whale's read-only video discovery.
 * It never exposes transcripts, people, arbitrary model text, or private keys. */
import crypto from 'node:crypto'
const DAY = 86400000
const FOOD_TOPICS = new Map([
  ['番茄炒蛋', '番茄炒蛋做法'], ['西红柿炒鸡蛋', '西红柿炒鸡蛋做法'],
  ['宫保鸡丁', '宫保鸡丁做法'], ['鱼香肉丝', '鱼香肉丝做法'], ['麻婆豆腐', '麻婆豆腐做法'],
  ['红烧肉', '红烧肉做法'], ['可乐鸡翅', '可乐鸡翅做法'], ['蛋炒饭', '蛋炒饭做法'],
  ['饺子', '饺子做法'], ['面条', '面条做法'], ['炒面', '炒面做法'], ['炖汤', '家常炖汤做法'],
])
const VIDEO_TOPICS = new Map([
  ['short-drama', '短剧'], ['comedy', '喜剧'], ['melodrama', '剧情短片'], ['animation', '动画'],
  ['meme', '趣味整活'], ['ai-adaptation', 'AI创作'], ['technology', '科技'], ['reviews', '视频解说'],
  ['gaming', '游戏'], ['news', '资讯'],
])
const DOMAIN_TOPICS = Object.freeze({ food:'做饭教程', video:'视频创作', music:'音乐', game:'游戏', activity:'生活方式' })
const fingerprint = keyword => crypto.createHash('sha256').update('whale-interest:' + keyword).digest('hex')
function current(row, now) {
  const updated = Date.parse(row.updatedAt)
  return Number.isFinite(updated) && updated <= now && now - updated < 180 * DAY && (!row.expiresAt || Date.parse(row.expiresAt) > now) && !(Date.parse(row.pauseUntil) > now)
}
function privacyApproved(db, row) {
  if (db.privacyReview?.enabled !== true) return true
  return typeof row.sourceHash === 'string' && db.privacyReview.verdicts?.[row.sourceHash]?.classification === 'public_interest'
}

/** Select at most two weak, time-bounded ideas; no original message is read. */
export function whaleInterestProjection(db, now = Date.now(), blocked = () => false) {
  if (db.whaleInterestSharing?.enabled !== true || !Object.values(db.learning?.bindings ?? {}).includes('owner')) return { version: 1, keywords: [] }
  const ideas = []
  for (const row of db.interestMemory?.entries ?? []) {
    const keyword = FOOD_TOPICS.get(row.subject)
    if (!keyword || !['want', 'like'].includes(row.intent) || !current(row, now) || !privacyApproved(db, row)) continue
    if (row.suppressedUntil && Date.parse(row.suppressedUntil) > now) continue
    ideas.push({ keyword, at: Date.parse(row.updatedAt) })
  }
  for (const row of db.semanticMemory?.entries ?? []) {
    if (!['want', 'like'].includes(row.signal) || !current(row, now) || !privacyApproved(db, row)) continue
    const cooking = row.domain === 'food' && (db.interestMemory?.entries ?? []).find(x => x.subject === row.subject)
    if (cooking && (!['want', 'like'].includes(cooking.intent) || !current(cooking, now) || (cooking.suppressedUntil && Date.parse(cooking.suppressedUntil) > now))) continue
    const keyword = row.domain === 'food' ? (FOOD_TOPICS.get(row.subject) ?? DOMAIN_TOPICS.food) : Object.hasOwn(DOMAIN_TOPICS, row.domain) ? DOMAIN_TOPICS[row.domain] : null
    if (keyword) ideas.push({ keyword, at: Date.parse(row.updatedAt) })
  }
  for (const row of Object.values(db.learning?.preferences ?? {})) {
    const keyword = VIDEO_TOPICS.get(row.topic)
    if (keyword && row.signal === 'like' && row.provenance === 'owner-explicit' && current(row, now) && privacyApproved(db, row)) ideas.push({ keyword, at: Date.parse(row.updatedAt) })
  }
  ideas.sort((a, b) => b.at - a.at || a.keyword.localeCompare(b.keyword, 'zh'))
  const keywords = [...new Set(ideas.map(x => x.keyword))].filter(keyword => !blocked(keyword)).slice(0, 2)
  return { version: 1, keywords }
}

/** Called by a local owner, never by the model or a platform channel. */
export function configureWhaleInterestSharing(store, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('启用状态无效')
  return store.tx(db => {
    db.whaleInterestSharing ??= {}
    db.whaleInterestSharing.enabled = enabled
    store._auditInto(db, { actor: 'owner', action: enabled ? 'whale-interest:enabled' : 'whale-interest:disabled' })
    return { enabled }
  })
}

/** Reserve selected topics before a round: no more than one exposure per week. */
export function claimWhaleInterests(store, now = Date.now()) {
  return store.tx(db => {
    if (db.whaleInterestSharing?.enabled !== true) return { version: 1, keywords: [] }
    const sharing = db.whaleInterestSharing
    sharing.recent ??= {}
    for (const [hash, at] of Object.entries(sharing.recent)) if (!Number.isFinite(at) || now - at >= 7 * DAY) delete sharing.recent[hash]
    const result = whaleInterestProjection(db, now, keyword => Object.hasOwn(sharing.recent, fingerprint(keyword)))
    for (const keyword of result.keywords) sharing.recent[fingerprint(keyword)] = now
    if (result.keywords.length) store._auditInto(db, { actor: 'owner', action: 'whale-interest:claim', detail: String(result.keywords.length) })
    return result
  })
}

/** Remove the derived cooldown marker when its corresponding memory is forgotten. */
export function forgetWhaleInterestHistory(db, { subject, topic, domain } = {}) {
  const recent = db.whaleInterestSharing?.recent
  if (!recent) return
  const keyword = topic ? VIDEO_TOPICS.get(topic) : FOOD_TOPICS.get(subject) ?? (Object.hasOwn(DOMAIN_TOPICS, domain) ? DOMAIN_TOPICS[domain] : null)
  if (keyword) delete recent[fingerprint(keyword)]
}
