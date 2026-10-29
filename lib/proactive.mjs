import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { reportCandidates, feedbackScores } from './recommendations.mjs'
import { verifiedQQSession } from './qq-session.mjs'
import { isSensitive } from './privacy.mjs'

const DAY = 86400000
const bvidHash = id => crypto.createHash('sha256').update('dsh-pond-forgotten-video:' + id).digest('hex')
const defaultState = () => ({ enabled: false, lastRound: null, pendingTest: false, attempts: [] })
function state(db) { return db.proactiveSharing ??= defaultState() }

// Only completed rounds from the local whale runner count; model output is never used as a trigger.
export function lastSuccessfulRound(text) {
  const matches = [...text.matchAll(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s+=== 结束，exit=0 ===\s*$/gm)]
  const match = matches.at(-1)
  return match ? { id: `${match[1]} ${match[2]}`, date: match[1] } : null
}

function readRound(home) {
  const file = path.join(home, 'whale-round.log')
  try {
    const fd = fs.openSync(file, 'r')
    try { const size = fs.fstatSync(fd).size, length = Math.min(size, 256 * 1024), bytes = Buffer.alloc(length); fs.readSync(fd, bytes, 0, length, size - length); return lastSuccessfulRound(bytes.toString('utf8')) }
    finally { fs.closeSync(fd) }
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function newestRound(db,home) {
  const automatic=db.proactiveSharing?.whaleRound, manual=readRound(home)
  return automatic && (!manual || Date.parse(automatic.at)>Date.parse(manual.id.replace(' ','T'))) ? automatic : manual
}

function ownerIdentity(store, appId) {
  const file = path.join(store.home, 'qq-owner.json')
  const binding = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (binding.appId !== appId || typeof binding.ownerOpenId !== 'string' || !binding.ownerOpenId) throw new Error('QQ 主人身份未验证')
  const prefsFile = path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json')
  let prefs = {}; try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const principal = 'session:' + verifiedQQSession(binding, prefs)
  if (store.read().learning?.bindings?.[principal] !== 'owner') throw new Error('QQ 主人会话未授权')
  return { principal, target: { scope: 'c2c', targetId: binding.ownerOpenId } }
}

function candidates(db, principal, round, now) {
  const reports = db.whaleDocuments?.reports
  if (typeof reports !== 'string') throw new Error('原版视频报告尚未连接')
  const recommendations = db.recommendations ?? { suggestions: [], feedback: [] }
  const recentlyShared = new Set((recommendations.suggestions ?? []).filter(x => x.principal === principal && now - Date.parse(x.at) < 30 * DAY).map(x => x.bvid))
  const scores = feedbackScores(recommendations.feedback ?? [], now)
  return reportCandidates(reports)
    .filter(x => (round.items ? round.items.some(item=>item.bvid===x.bvid && item.date===x.date) : x.date===round.date) && !recentlyShared.has(x.bvid) && !Object.hasOwn(db.learning?.forgottenVideos ?? {}, bvidHash(x.bvid)))
    .map((x, index) => ({ ...x, score: (scores.get(x.topic) ?? 0) - index * 0.02 }))
    .sort((a, b) => b.score - a.score)
}

export function makeShareMessage(candidate) {
  // Only the whale's own report, not private chat or model instructions, is eligible for sharing.
  const title = candidate.title.replace(/\*\*/g, '').split(/\s*[／|]\s*(?:UP|链接|作者)/u)[0].trim()
  const thought = candidate.impression.replace(/\*\*/g, '').split(/(?<=[。！？])\s*/u)[0].trim()
  if (!title || title.length > 120 || !thought || thought.length > 180 || isSensitive(title + thought) || /https?:|[A-Za-z]:[\\/]|\b(?:token|secret|password)\b/iu.test(title + thought)) throw new Error('候选视频内容不适合分享')
  return `我最近看过一条《${title}》，想和你分享。\n${thought}\nhttps://www.bilibili.com/video/${candidate.bvid}/`
}

export function configureProactive(store, { enabled, requestTest = false, forceTest = false, testTransport = 'wakeup' }, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  if (typeof enabled !== 'boolean') throw new Error('主动分享开关无效')
  if (forceTest && (!requestTest || !enabled)) throw new Error('立即测试必须显式请求且主动分享已开启')
  if (!['wakeup','active'].includes(testTransport) || (testTransport === 'active' && !forceTest)) throw new Error('测试发送方式无效')
  const currentRound = newestRound(store.read(),dshHome)
  return store.tx(db => {
    const p = state(db); p.enabled = enabled
    if (enabled && !p.activatedAt) { p.activatedAt = new Date().toISOString(); p.lastRound = currentRound?.id ?? null }
    if (!enabled) { p.pendingTest = false; delete p.testOverrideUntil; delete p.testTransport; delete p.activatedAt }
    if (requestTest) {
      if (!enabled || !currentRound) throw new Error('没有可测试的已完成刷站轮次')
      p.pendingTest = true
      if (forceTest) p.testOverrideUntil = Date.now() + 120000
      else delete p.testOverrideUntil
      if (forceTest && testTransport === 'active') p.testTransport = 'active'
      else delete p.testTransport
    }
    store._auditInto(db, { actor: 'owner', action: enabled ? 'proactive:enabled' : 'proactive:disabled' })
    return { ok: true, enabled, testRequested: p.pendingTest }
  })
}

export function proactiveStatus(store) {
  const p = store.read().proactiveSharing ?? defaultState(), last = p.attempts.at(-1)
  const reason = last?.reason?.includes('40034122') ? 'QQ 互动召回达到平台当前周期上限（代码 40034122），未自动重试' : last?.reason
  return { enabled: p.enabled === true, testPending: p.pendingTest === true, lastAttempt: last ? { at: last.at, status: last.status, bvid: last.bvid, reason } : null }
}

// One reservation before sending; uncertain or failed sends are never retried automatically.
export function createProactiveSharing({ store, bot, guard, appId, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), now = () => Date.now(), intervalMs = 30000, log = () => {} }) {
  let busy = false, stopped = false, timer
  async function tick() {
    if (busy || stopped) return
    busy = true
    try {
      const db = store.read(), p = db.proactiveSharing ?? defaultState()
      if (!p.enabled) return
      const timestamp = now()
      if (p.testOverrideUntil && timestamp > p.testOverrideUntil) {
        store.tx(d => { const s=state(d); s.pendingTest=false; delete s.testOverrideUntil; delete s.testTransport })
        return
      }
      const forcedTest = p.pendingTest === true && Number.isFinite(p.testOverrideUntil) && timestamp <= p.testOverrideUntil
      const activeTest = forcedTest && p.testTransport === 'active'
      const activeSend = activeTest || (!forcedTest && p.transport === 'active')
      const round = newestRound(db,dshHome)
      if (!round || (!p.pendingTest && round.id === p.lastRound)) return
      const roundAt = Date.parse(round.at ?? round.id.replace(' ', 'T'))
      if (p.activatedAt && roundAt < Date.parse(p.activatedAt) && !p.pendingTest) return
      if (!Number.isFinite(roundAt) || timestamp - roundAt > 7 * DAY || roundAt > timestamp + 60000) return
      const { principal, target } = ownerIdentity(store, appId)
      if (!guard.allowed(target)) throw new Error('QQ 主人身份检查失败')
      const last = p.attempts.at(-1)
      if (!forcedTest && last && timestamp - Date.parse(last.at) < DAY) {
        if (p.pendingTest) store.tx(d => { state(d).pendingTest = false; state(d).lastDecision = 'cooldown' })
        return
      }
      let selected, text
      for (const item of candidates(db, principal, round, timestamp)) {
        try { text = makeShareMessage(item); selected = item; break } catch { /* skip unsafe or malformed candidate */ }
      }
      if (selected && forcedTest) text = '【分享链路测试】\n' + text
      if (!selected) {
        store.tx(d => { const s = state(d); s.lastRound = round.id; s.pendingTest = false; delete s.testOverrideUntil; delete s.testTransport; store._auditInto(d, { actor: 'owner', action: 'proactive:no-candidate' }) })
        return
      }
      const attemptId = crypto.randomUUID()
      const reserved = store.tx(d => {
        const s = state(d)
        const override = s.pendingTest === true && forcedTest && s.testOverrideUntil >= timestamp && (!activeTest || s.testTransport === 'active')
        if (activeTest && !override) return false
        if (!s.enabled || (!s.pendingTest && s.lastRound === round.id) || (!override && s.attempts.at(-1) && timestamp - Date.parse(s.attempts.at(-1).at) < DAY)) return false
        s.lastRound = round.id; s.pendingTest = false; delete s.testOverrideUntil; delete s.testTransport
        s.attempts.push({ id: attemptId, bvid: selected.bvid, at: new Date(timestamp).toISOString(), status: 'sending', ...(override ? {test:true} : {}), ...(activeSend ? {transport:'active'} : {}) }); s.attempts = s.attempts.slice(-200)
        return true
      })
      if (!reserved) return
      let receipt
      try {
        if (!state(store.read()).enabled || !guard.allowed(target) || ownerIdentity(store, appId).principal !== principal) throw new Error('授权已撤销')
        receipt = activeSend ? await bot.sendText(target, text) : await bot.sendWakeup(target, text)
      }
      catch (error) {
        const code = String(error?.bizCode ?? error?.code ?? error?.httpStatus ?? error?.status ?? '').match(/^\d{3,9}$/)?.[0]
        store.tx(d => { const a = state(d).attempts.find(x => x.id === attemptId); if (a) { a.status = 'failed'; a.reason = `平台拒绝或发送结果未知${code ? `（代码 ${code}）` : ''}，未自动重试` }; store._auditInto(d, { actor: 'owner', action: 'proactive:failed' }) })
        return
      }
      store.tx(d => {
        const a = state(d).attempts.find(x => x.id === attemptId)
        if (!a) return
        a.status = receipt?.id ? 'sent' : 'unknown'; if (!receipt?.id) a.reason = '未收到明确发送回执'
        if (a.status === 'sent' && a.test && a.transport === 'active') state(d).transport = 'active'
        if (a.status === 'sent' && d.learning?.bindings?.[principal] === 'owner') {
          d.recommendations ??= { suggestions: [], feedback: [], seenEvents: [] }
          for (const s of d.recommendations.suggestions) if (s.principal === principal && !s.feedback) s.closed = true
          d.recommendations.suggestions.push({ principal, bvid: selected.bvid, topic: selected.topic, at: new Date(timestamp).toISOString(), feedback: null, delivery: 'sent', ...(a.test ? {closed:true, test:true} : {}) })
          d.recommendations.suggestions = d.recommendations.suggestions.slice(-200)
        }
        store._auditInto(d, { actor: 'owner', action: a.status === 'sent' ? 'proactive:sent' : 'proactive:unknown' })
      })
    } catch { log('[dsh-pond] 主动分享未执行：检查主人绑定、报告或候选状态。') }
    finally { busy = false }
  }
  return { tick, start() { if (!timer && !stopped) { timer = setInterval(() => { void tick() }, intervalMs); void tick() } }, stop() { stopped = true; if (timer) clearInterval(timer) } }
}
