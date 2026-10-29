/** Structured, bounded learning records. No free text, transcripts or credentials. */
import { allows } from './security.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isSensitive } from './privacy.mjs'
import { renderSharedVideoDiary } from './shared-video-diary.mjs'
import { forgetWhaleInterestHistory } from './whale-interest.mjs'

export const TOPICS = Object.freeze(['short-drama', 'comedy', 'melodrama', 'animation', 'dialogue', 'meme', 'ai-adaptation', 'technology', 'reviews', 'gaming', 'news', 'concise', 'detailed', 'casual', 'formal'])
export const SIGNALS = Object.freeze(['like', 'avoid', 'neutral'])
export const RATINGS = Object.freeze(['worthwhile', 'maybe', 'skip'])
const PRINCIPAL = /^(?:session|channel):[^\s]{1,200}$/u
const BVID = /^BV[0-9A-Za-z]{10}$/

function memory(db) {
  if (db.learning === undefined) db.learning = { bindings: {}, preferences: {}, videos: {}, forgottenVideos: {} }
  const data = db.learning
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.bindings || !data.preferences || !data.videos || [data.bindings, data.preferences, data.videos].some(x => typeof x !== 'object' || Array.isArray(x))) throw new Error('学习记忆结构无效，已停止操作')
  if (data.forgottenVideos === undefined) data.forgottenVideos = {}
  if (!data.forgottenVideos || typeof data.forgottenVideos !== 'object' || Array.isArray(data.forgottenVideos)) throw new Error('学习记忆结构无效，已停止操作')
  return data
}

const videoFingerprint = bvid => crypto.createHash('sha256').update('dsh-pond-forgotten-video:' + bvid).digest('hex')
function preferenceView(value, now = Date.now()) {
  const timestamp = Date.parse(value.updatedAt)
  const ageDays = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86400000) : Infinity
  return { ...value, confidence: Number.isFinite(ageDays) ? Number((2 ** (-ageDays / 180)).toFixed(3)) : 0, usage: value.provenance === 'owner-explicit' ? '主人曾明确表达，时间久了应重新确认；不代表每次都适用。' : '历史推断未验证，不能当作明确长期偏好。' }
}

// One short-lived opportunity per genuine owner message, with only a hash retained.
export function observeHypothesisContext(store, session, event, now = Date.now()) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Number.isSafeInteger(event.seq) || event.seq < 0) return
  const id = session?.id ?? session?.header?.id
  if (typeof id !== 'string' || !id) return
  const principal = 'session:' + id; const db = store.read()
  if (db.learning?.bindings?.[principal] !== 'owner') return
  const content = event.data.content
  const text = Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : typeof content === 'string' ? content : null
  const hash = crypto.createHash('sha256').update(JSON.stringify([principal, event.seq])).digest('hex')
  const safe = typeof text === 'string' && text.length <= 1000 && !isSensitive(text)
  const singleVideoFeedback = safe && (/^(?:这条|这个|这条视频|这个视频|这视频)?(?:不错|挺不错|很不错|好看|挺好看|很好看|喜欢|挺喜欢|很喜欢|不喜欢|不太喜欢|不好看|有意思|挺有意思)[。！!\s]*$/u.test(text.trim()) || /^(?:我)?(?:挺|很)?(?:喜欢|不喜欢|不太喜欢)(?:这条|这个|这条视频|这个视频)[。！!\s]*$/u.test(text.trim()))
  store.tx(d => {
    const data = memory(d)
    if (data.bindings[principal] !== 'owner') return
    data.hypothesisContexts ??= {}
    if (data.hypothesisContexts[principal]?.hash === hash) return
    data.hypothesisContexts[principal] = { hash, expiresAt: now + 10 * 60 * 1000, blocked: !safe || singleVideoFeedback || !!data.preferenceEvents?.includes(hash), used: false }
  })
}

function hypothesisView(value, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(value.updatedAt))
  return { ...value, confidence: Number((Math.min(0.6, value.observations * 0.2) * 2 ** (-age / (45 * 86400000))).toFixed(3)), usage: '模型推测，可能有误，仅作当前相关情境的弱线索；不可当成主人明确表达，不适用于刷站或公开发布。' }
}

const explicitTopics = new Map([['短剧', 'short-drama'], ['喜剧', 'comedy'], ['动画', 'animation'], ['游戏', 'gaming'], ['科技', 'technology'], ['新闻', 'news'], ['简洁回答', 'concise'], ['详细回答', 'detailed'], ['随意聊天', 'casual'], ['正式聊天', 'formal']])
// Only a direct host user event can establish a category preference; no chat text is stored.
export function observeExplicitPreferenceEvent(store, session, event, now = Date.now()) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Number.isSafeInteger(event.seq) || event.seq < 0) return
  const id = session?.id ?? session?.header?.id
  if (typeof id !== 'string' || !id) return
  const principal = 'session:' + id
  const c = event.data.content
  const text = Array.isArray(c) && c.length === 1 && c[0]?.type === 'text' ? c[0].text : typeof c === 'string' ? c : null
  if (typeof text !== 'string' || text.length > 200 || isSensitive(text) || /[?？“”"「」『』\[\]【】]/u.test(text)) return
  const m = text.trim().match(/^我(?:一直|长期|确实)?(不喜欢|喜欢)(?:看)?(短剧|喜剧|动画|游戏|科技|新闻|简洁回答|详细回答|随意聊天|正式聊天)[。！!\s]*$/u)
  if (!m) return
  const topic = explicitTopics.get(m[2]); const signal = m[1] === '喜欢' ? 'like' : 'avoid'
  const hash = crypto.createHash('sha256').update(JSON.stringify([principal, event.seq])).digest('hex')
  store.tx(db => {
    const data = memory(db)
    if (data.bindings[principal] !== 'owner') return
    data.preferenceEvents ??= []
    if (data.preferenceEvents.includes(hash)) return
    const old = data.preferences[topic]
    data.preferences[topic] = { topic, signal, observations: old?.signal === signal ? Math.min(old.observations + 1, 1000000) : 1, sourceHash: hash, updatedAt: new Date(now).toISOString(), provenance: 'owner-explicit' }
    const opposite = { concise: 'detailed', detailed: 'concise', casual: 'formal', formal: 'casual' }[topic]
    if (signal === 'like' && opposite && data.preferences[opposite]?.signal === 'like') delete data.preferences[opposite]
    data.preferenceEvents.push(hash); data.preferenceEvents = data.preferenceEvents.slice(-1000)
    store._auditInto(db, { actor: principal, action: 'learning:explicit-preference' })
  })
}

/** Only the local owner entry point calls this; models cannot grant their own access. */
export function bindLearning(store, principal, role) {
  if (typeof principal !== 'string' || !PRINCIPAL.test(principal)) throw new Error('身份必须是 session:<会话ID> 或 channel:<渠道ID>')
  if (!['owner', 'watcher', 'remove'].includes(role)) throw new Error('角色只能是 owner、watcher 或 remove')
  return store.tx(db => {
    const bindings = memory(db).bindings
    if (role === 'remove') delete bindings[principal]
    else Object.defineProperty(bindings, principal, { value: role, writable: true, enumerable: true, configurable: true })
    store._auditInto(db, { actor: 'owner', action: 'learning:binding', detail: role })
    return { ok: true, principal, role }
  })
}

export function listLearningBindings(store) {
  return { ok: true, bindings: { ...memory(store.read()).bindings } }
}

/** Owner-initiated synchronization reads only BV headings, never report text. */
export function importWhaleReports(store, directory) {
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
  const ids = new Set()
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file.name), 'utf8')
    for (const match of text.matchAll(/^###\s+(BV[0-9A-Za-z]{10})\s*$/gm)) ids.add(match[1])
  }
  return store.tx(db => {
    const data = memory(db)
    let added = 0
    for (const bvid of ids) {
      if (Object.hasOwn(data.videos, bvid) || Object.hasOwn(data.forgottenVideos, videoFingerprint(bvid))) continue
      const now = new Date().toISOString()
      data.videos[bvid] = { bvid, rating: 'unrated', provenance: 'whale-report-heading', firstRecordedAt: now, updatedAt: now }
      added++
    }
    store._auditInto(db, { actor: 'owner', action: 'learning:import-whale', detail: 'added=' + added })
    return { ok: true, reports: files.length, found: ids.size, added }
  })
}

export function runLearning(store, args, identity) {
  if (!allows(identity.scopes, 'learning:access')) throw new Error('没有 learning:access 权限')
  const { principal } = identity
  const action = args.action
  const outcome = store.tx(db => {
    const data = memory(db)
    const role = Object.hasOwn(data.bindings, principal) ? data.bindings[principal] : null
    if (!['owner', 'watcher'].includes(role)) throw new Error('当前身份未获学习记忆授权')
    let result
    if (action === 'learn_preference') {
      throw new Error('类别喜好只接受主人直接明确表达，不能由模型或渠道推断写入')
    } else if (action === 'learn_hypothesis') {
      if (role !== 'owner' || !TOPICS.includes(args.topic) || !['like', 'avoid'].includes(args.signal)) throw new Error('仅主人私聊可提出限定主题的偏好推测')
      const context = data.hypothesisContexts?.[principal]
      if (!context || context.used || context.blocked || context.expiresAt <= Date.now()) throw new Error('当前消息不能用于新增推测')
      context.used = true
      data.hypotheses ??= {}
      const old = data.hypotheses[args.topic]
      const observations = old?.signal === args.signal ? Math.min(3, old.observations + 1) : 1
      data.hypotheses[args.topic] = { topic: args.topic, signal: args.signal, observations, updatedAt: new Date().toISOString(), provenance: 'model-hypothesis' }
      result = { hypothesis: hypothesisView(data.hypotheses[args.topic]) }
    } else if (action === 'remember_video') {
      if (role !== 'watcher') throw new Error('仅已授权看视频会话可记录观看')
      if (typeof args.bvid !== 'string' || !BVID.test(args.bvid) || !RATINGS.includes(args.rating)) throw new Error('视频 BV 号或评价格式无效')
      if (Object.hasOwn(data.forgottenVideos, videoFingerprint(args.bvid))) throw new Error('该视频已被主人要求遗忘，不能自动重新记录')
      const old = data.videos[args.bvid]
      data.videos[args.bvid] = { bvid: args.bvid, rating: args.rating, firstRecordedAt: old?.firstRecordedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() }
      result = { video: data.videos[args.bvid] }
    } else if (action === 'memory_recall') {
      if (args.bvid !== undefined && (typeof args.bvid !== 'string' || !BVID.test(args.bvid))) throw new Error('视频 BV 号格式无效')
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数')
      const allVideos = Object.values(data.videos).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.bvid.localeCompare(b.bvid))
      result = { preferences: role === 'owner' ? Object.values(data.preferences).sort((a, b) => a.topic.localeCompare(b.topic)).map(x => preferenceView(x)) : [], hypotheses: role === 'owner' ? Object.values(data.hypotheses ?? {}).map(x => hypothesisView(x)).filter(x => x.confidence >= 0.05 && !data.preferences[x.topic]) : [], videos: args.bvid ? allVideos.filter(v => v.bvid === args.bvid) : allVideos.slice(offset, offset + 100), totalVideos: allVideos.length, nextOffset: !args.bvid && offset + 100 < allVideos.length ? offset + 100 : null }
    } else if (action === 'memory_forget') {
      if (role !== 'owner') throw new Error('仅主人私聊身份可删除学习记忆')
      if (TOPICS.includes(args.topic)) { delete data.preferences[args.topic]; if (data.hypotheses) delete data.hypotheses[args.topic]; if (data.hypothesisContexts?.[principal]) data.hypothesisContexts[principal].used = true; forgetWhaleInterestHistory(db, { topic: args.topic }); result = { forgotten: true } }
      else if (typeof args.bvid === 'string' && BVID.test(args.bvid)) {
        delete data.videos[args.bvid]; data.forgottenVideos[videoFingerprint(args.bvid)] = true
        if (db.recommendations) {
          db.recommendations.suggestions = db.recommendations.suggestions.filter(x => x.bvid !== args.bvid)
          db.recommendations.feedback = db.recommendations.feedback.filter(x => x.bvid !== args.bvid)
        }
        if (db.sharedVideoDiary) {
          const removed = new Set(db.sharedVideoDiary.entries.filter(x => x.bvid === args.bvid).map(x => x.eventHash))
          db.sharedVideoDiary.entries = db.sharedVideoDiary.entries.filter(x => x.bvid !== args.bvid)
          for (const [p, hash] of Object.entries(db.sharedVideoDiary.pending)) if (removed.has(hash)) delete db.sharedVideoDiary.pending[p]
        }
        result = { forgotten: true }
      }
      else throw new Error('需要允许列表中的主题或有效 BV 号')
    } else throw new Error('未知学习动作')
    store._auditInto(db, { actor: principal, action: 'learning:' + action })
    return { ok: true, action, ...result }
  })
  if (action === 'memory_forget' && args.bvid) renderSharedVideoDiary(store)
  return outcome
}
