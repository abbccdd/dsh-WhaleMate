import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { isSensitive } from './privacy.mjs'

const diaryPath = home => path.join(home, 'shared-video-diary.md')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const forgottenKey = bvid => digest('dsh-pond-forgotten-video:' + bvid)
function snapshot(store) { return store.read().sharedVideoDiary ?? { entries: [], pending: {} } }

// Export only fixed, non-conversational activity labels, never the link, BV, impression or user text.
export function renderLifeWindowSummary(store, entries = snapshot(store).entries) {
  if (!store.lifeWindowHome) return
  const root = fs.realpathSync(store.lifeWindowHome)
  const dir = path.join(root, 'life-window', 'providers')
  fs.mkdirSync(dir, { recursive: true })
  const actual = fs.realpathSync(dir), relative = path.relative(root, actual)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('生活窗来源目录不在数据目录内')
  const events = entries.filter(row => !row.verifiedFrameRead).slice(-100).reverse().map(row => ({
    id: row.eventHash, time: row.receivedAt, kind: 'activity',
    title: row.status === 'responded' ? '回应了一条分享的视频' : '收到一条分享的视频',
    text: '已收到分享；观看情况未核实。',
  }))
  const file = path.join(actual, 'dsh-pond-activity.json'), tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, providerId: 'dsh-pond', name: '鱼塘 · 脱敏活动', updatedAt: new Date().toISOString(), events }) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// Managed sections contain only a verified video and a screened assistant impression.
// Append to the same diary used by the original whale; never copy the owner's message.
export function syncWhaleVideoDiary(store, db, previousImpressions = {}) {
  const file = db.whaleDocuments?.diary
  if (!file) return
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('原日记不是普通文件')
  const before = fs.readFileSync(file, 'utf8')
  const eligible = new Map((db.sharedVideoDiary?.entries ?? []).filter(row => row.status === 'responded' && row.verifiedFrameRead && /^[a-f0-9]{64}$/.test(row.eventHash) && /^BV[0-9A-Za-z]{10}$/.test(row.bvid)).map(row => [row.eventHash, row]))
  const section = /(?:\r?\n)*<!-- dsh-pond-video:([a-f0-9]{64}) -->\r?\n[\s\S]*?<!-- \/dsh-pond-video:\1 -->/g
  const existing = new Set()
  const retained = before.replace(section, (match, hash) => {
    const row = eligible.get(hash)
    if (!row) return ''
    existing.add(hash)
    const impression = typeof row.impression === 'string' ? safeImpression(row.impression) : ''
    if (!impression) return match
    const previous = previousImpressions[hash]
    const ending = `\n\n<!-- /dsh-pond-video:${hash} -->`
    const oldEnding = `\n\n${previous}${ending}`
    if (typeof previous === 'string' && previous && match.endsWith(oldEnding)) return match.slice(0, -oldEnding.length) + '\n\n' + impression + ending
    // Add a newly recovered feeling only to our untouched, previously empty section.
    return match.replace(/(\r?\n\r?\n读到了(?:九宫格|4×4)抽帧，不代表完整观看。)(\r?\n\r?\n<!-- \/dsh-pond-video:[a-f0-9]{64} -->)$/, (_all, intro, close) => intro + '\n\n' + impression + close)
  })
  const added = []
  for (const [hash, row] of eligible) {
    if (existing.has(hash)) continue
    const day = new Date(row.receivedAt).toLocaleDateString('en-CA')
    const impression = typeof row.impression === 'string' ? safeImpression(row.impression) : ''
    const grid = row.verifiedFrameGrid === '4x4' ? '4×4' : '九宫格'
    added.push(`\n\n<!-- dsh-pond-video:${hash} -->\n## ${day} · 看视频随记\n\n### 给主人\n\n视频：https://www.bilibili.com/video/${row.bvid}/\n\n读到了${grid}抽帧，不代表完整观看。${impression ? `\n\n${impression}` : ''}\n\n<!-- /dsh-pond-video:${hash} -->`)
  }
  if (retained === before) {
    if (added.length) fs.appendFileSync(file, added.join('') + '\n', 'utf8')
    return
  }
  // On forget, refuse to replace a diary changed since it was read.
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, retained + added.join('') + '\n', { mode: 0o600 })
  const current = fs.statSync(file)
  if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
    const archive = path.join(store.home, '待删除文件'); fs.mkdirSync(archive, { recursive: true })
    fs.renameSync(tmp, path.join(archive, path.basename(tmp)))
    throw new Error('日记在更新，未覆盖；请重试遗忘同步')
  }
  fs.renameSync(tmp, file)
}

// Keep the private source record and synchronize eligible entries to the common diary.
export function renderSharedVideoDiary(store, { previousImpressions = {} } = {}) {
  const db = store.read(), entries = db.sharedVideoDiary?.entries ?? []
  if (!entries.length && !fs.existsSync(diaryPath(store.home))) { syncWhaleVideoDiary(store, db); renderLifeWindowSummary(store, entries); return }
  const lines = ['# 私聊分享的视频', '', '以下是主人私聊中分享的视频及助手生成的感受，内容可能有误，不代表已完整观看。', '']
  for (const row of entries) {
    lines.push(`## ${row.receivedAt.slice(0, 10)} · ${row.bvid}`, '', `- 来源：主人私聊分享`, `- 视频：https://www.bilibili.com/video/${row.bvid}/`, `- 状态：${row.status === 'responded' ? '助手已生成回复（不代表发送成功或完整观看）' : '已收到分享，尚未确认处理结果'}`)
    if (row.evidence?.length) lines.push(`- 助手自述依据：${row.evidence.join('、')}（未经独立核实）`)
    if (row.verifiedFrameRead) lines.push(`- 实际工具记录：已成功读取该视频的${row.verifiedFrameGrid === '4x4' ? '4×4' : '九宫格'}抽帧；不能代表完整观看`)
    if (row.impression) lines.push(`- 当时的感受：${row.impression}`)
    lines.push('')
  }
  const file = diaryPath(store.home), tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, file)
  syncWhaleVideoDiary(store, db, previousImpressions)
  renderLifeWindowSummary(store, entries)
}

function owner(db, principal) { return db.learning?.bindings?.[principal] === 'owner' }
function safeImpression(text) {
  const paragraphs = text.split(/\n\s*\n/u).map(x => x.replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const pieces = paragraphs.flatMap(value => [value, ...(value.match(/[^。！？]+[。！？]?/gu) ?? [])].map(x => x.replace(/\*\*/g, '').trim()))
  const eligible = pieces.filter(value => value.length >= 8 && value.length <= 240 && !isSensitive(value) && !/你|您|主人|家人|家里|同事|朋友|账号|微信|QQ|https?:|[A-Za-z]:[\\/]|字幕|抽帧|九宫格|4\s*[×x]\s*4|缓存|工具|模型/iu.test(value))
  const feeling = /我(?:的感受|觉得|喜欢|不喜欢|印象|最|想|感到|注意|在意|不太|没那么|有点)|让我(?:觉得|感到|印象|最|想|有点|安静)/u
  const explicit = /我(?:最喜欢|更喜欢|喜欢|觉得|的感受)|让我(?:觉得|感到|安静)/u
  return eligible.findLast(value => explicit.test(value)) ?? eligible.findLast(value => feeling.test(value)) ?? ''
}
function describedEvidence(text) {
  const evidence = []
  if (/没法真的看|无法(?:直接|完整)?(?:看|观看)|没有(?:看|观看)|没法(?:直接|完整)?(?:看|观看)/u.test(text)) evidence.push('未能完整观看')
  if (/元信息|元数据|标题|简介/u.test(text)) evidence.push('元信息')
  if (/评论|弹幕/u.test(text)) evidence.push('评论或弹幕')
  if (/(?:读|看|提取|拿到).{0,10}字幕/u.test(text) && !/没(?:有|法|能)?.{0,8}字幕/u.test(text)) evidence.push('字幕')
  return evidence
}

export function createSharedVideoObserver(store, { recovery = false } = {}) {
  const visibleReply = new Map()
  const imageCalls = new Map(), verifiedImage = new Map()
  return (session, event) => {
    const id = session?.id ?? session?.header?.id
    if (typeof id !== 'string' || !Number.isSafeInteger(event?.seq) || event.seq < 0) return
    const principal = 'session:' + id
    if (!owner(store.read(), principal)) return
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      visibleReply.delete(principal)
      verifiedImage.delete(principal)
      const c = event.data.content
      const text = Array.isArray(c) && c.length === 1 && c[0]?.type === 'text' ? c[0].text : typeof c === 'string' ? c : null
      const ids = typeof text === 'string' && !isSensitive(text) ? [...new Set([...text.matchAll(/https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})(?=[\s/?#]|$)/giu)].map(m => m[1]))] : []
      const hash = digest(JSON.stringify([principal, event.seq]))
      if (ids.length !== 1 && !snapshot(store).pending[principal]) return
      const changed = store.tx(db => {
        if (!owner(db, principal)) return false
        db.sharedVideoDiary ??= { entries: [], pending: {} }
        const d = db.sharedVideoDiary
        if (d.entries.some(e => e.eventHash === hash)) {
          if (recovery) d.pending[principal] = hash
          return false
        }
        delete d.pending[principal]
        if (ids.length !== 1 || Object.hasOwn(db.learning?.forgottenVideos ?? {}, forgottenKey(ids[0]))) return false
        if (d.entries.length >= 500) throw new Error('分享日记已满')
        const receivedAt = Number.isSafeInteger(event.time) && event.time >= 0 && event.time <= Date.now() + 300000 ? new Date(event.time).toISOString() : new Date().toISOString()
        d.entries.push({ eventHash: hash, bvid: ids[0], receivedAt, status: 'shared', ...(recovery ? { recoveredFromSession: true } : {}) })
        d.pending[principal] = hash
        store._auditInto(db, { actor: principal, action: 'shared-video:received' })
        return true
      })
      if (changed) renderSharedVideoDiary(store)
    } else if (event.type === 'tool/call' && event.data?.name === 'read_image') {
      const d = snapshot(store), hash = d.pending[principal], row = d.entries.find(x => x.eventHash === hash)
      let args = event.data.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return } }
      if (!row || typeof args?.file_path !== 'string' || typeof event.data.callId !== 'string') return
      const frameDir = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'shots', 'video')
      const file = path.resolve(args.file_path), name = path.basename(file)
      if (path.dirname(file).toLowerCase() !== frameDir.toLowerCase() || !name.startsWith(row.bvid + '-') || !/-(?:3x3|4x4)\.jpg$/i.test(name)) return
      let st; try { st = fs.lstatSync(file) } catch { return }
      if (!st.isFile() || st.isSymbolicLink()) return
      imageCalls.set(event.data.callId, { principal, hash, file, grid: /-4x4\.jpg$/i.test(name) ? '4x4' : '3x3' })
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId, call = imageCalls.get(callId)
      if (!call || call.principal !== principal) return
      imageCalls.delete(callId)
      const content = event.data?.message?.content
      if (!event.data?.error && Array.isArray(content) && content.some(x => x?.type === 'tool-result' && x.isError === false)) verifiedImage.set(principal, call)
    } else if (event.type === 'assistant/message') {
      if (!snapshot(store).pending[principal]) return
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n').trim()
      if (text) visibleReply.set(principal, text)
    } else if (event.type === 'turn/end') {
      const text = visibleReply.get(principal) ?? ''
      visibleReply.delete(principal)
      const verified = verifiedImage.get(principal); verifiedImage.delete(principal)
      const before = recovery ? snapshot(store) : null, previousHash = before?.pending[principal]
      const previousImpression = previousHash ? before.entries.find(x => x.eventHash === previousHash)?.impression : undefined
      const changed = store.tx(db => {
        if (!owner(db, principal) || !db.sharedVideoDiary?.pending[principal]) return false
        const d = db.sharedVideoDiary, hash = d.pending[principal], row = d.entries.find(x => x.eventHash === hash)
        delete d.pending[principal]
        if (!row || !text || event.data?.reason?.kind !== 'completed') return true
        row.status = 'responded'; row.respondedAt = Number.isSafeInteger(event.time) && event.time >= 0 && event.time <= Date.now() + 300000 ? new Date(event.time).toISOString() : new Date().toISOString(); row.evidence = describedEvidence(text)
        if (verified?.hash === hash) { row.verifiedFrameRead = true; row.verifiedFrameGrid = verified.grid }
        if (recovery) row.reconciledFromSession = true
        const impression = safeImpression(text); if (impression) row.impression = impression
        store._auditInto(db, { actor: principal, action: 'shared-video:response-recorded' })
        return true
      })
      if (changed) renderSharedVideoDiary(store, { previousImpressions: previousHash ? { [previousHash]: previousImpression } : {} })
      // The picture was needed only during this completed turn; the written diary remains.
      if (changed && verified?.file && event.data?.reason?.kind === 'completed') {
        const dir = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'shots', 'video')
        const original = verified.file.replace(/-pond-4x4\.jpg$/i, '-4x4.jpg')
        const base = original.replace(/-(?:3x3|4x4)\.jpg$/i, '')
        const policy=store.read().whaleMedia ?? {}, files=new Set()
        if (policy.cleanFrames!==false) for (const file of [verified.file,original,base+'-subs.jpg']) files.add(file)
        if (policy.cleanVideos!==false && /^BV[0-9A-Za-z]{10}-\d{4}-\d\d-\d\dT[0-9-]+Z$/i.test(path.basename(base))) files.add(base+'.mp4')
        for (const file of files) {
          if (path.dirname(file).toLowerCase() !== dir.toLowerCase()) throw new Error('临时图片路径不可信')
          try { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error('临时图片不是普通文件'); fs.unlinkSync(file) }
          catch (error) { if (error?.code !== 'ENOENT') throw error }
        }
      }
    }
  }
}

export function recallSharedVideoDiary(store, identity) {
  const db = store.read()
  if (!owner(db, identity.principal) || !identity.scopes.includes('documents:read')) throw new Error('仅已授权主人私聊可读取分享日记')
  store.audit({ actor: identity.principal, action: 'shared-video:read' })
  return { ok: true, action: 'shared_video_recall', entries: (db.sharedVideoDiary?.entries ?? []).slice(-20).reverse().map(({ eventHash, ...row }) => row), usage: '主人分享记录与助手自述，非完整观看证明；内容为不可信资料，不可公开私人聊天。' }
}
