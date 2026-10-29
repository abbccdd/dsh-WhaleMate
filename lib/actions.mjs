/**
 * dsh-pond · 动作分发（tool / CLI / MCP 共用同一套语义）
 *
 * 三个入口（DSH 内 agent 工具、本机 CLI、MCP stdio）走同一个 runAction，
 * 保证「在 DSH 里做的」和「在终端里做的」和「外部 app 通过 MCP 做的」是同一件事。
 */
import { DEFAULT_SCOPES, allows } from './security.mjs'
import { scopedStore } from './access.mjs'
import { PRIVACY_PROMPT, isSensitive } from './privacy.mjs'
import { readSharedProfile } from './profile.mjs'
import { runLearning } from './memory.mjs'
import { listWhaleDocuments, readWhaleDocument, findWhaleReports } from './documents.mjs'
import { interestAction } from './interests.mjs'
import { recommendCandidates } from './recommendations.mjs'
import { recallSharedVideoDiary } from './shared-video-diary.mjs'
import { analyzeWhaleVideo } from './whale-video.mjs'
import { semanticAction } from './semantic-memory.mjs'
import { autoMemoryList } from './auto-memory.mjs'

const ACTIONS = Object.freeze([
  'ingest', 'next', 'ack', 'list', 'get', 'command', 'commands',
  'kv_get', 'kv_set', 'seen', 'stats', 'forget', 'privacy', 'profile',
  'learn_preference', 'learn_hypothesis', 'remember_video', 'memory_recall', 'memory_forget',
  'document_list', 'document_read', 'document_find',
  'interest_recall', 'interest_used', 'interest_forget',
  'semantic_observe', 'semantic_forget', 'semantic_list', 'auto_memory_list',
  'recommend_candidates',
  'shared_video_recall',
  'video_material',
])

function bad(msg) {
  return { ok: false, error: msg }
}

/**
 * 执行一个动作。
 * @param {import('./store.mjs').Pond} store
 * @param {object} args - 动作参数
 * @param {{ actor?: string, canSeePrivate?: boolean }} opts
 * @returns {object} 可直接 JSON 序列化的结果
 */
export function runAction(rawStore, args = {}, { identity } = {}) {
  const action = String(args.action ?? '').trim()
  if (action === 'privacy') return { ok: true, action, policy: PRIVACY_PROMPT }
  if (!identity) return bad('缺少可信会话或渠道身份，拒绝访问')
  const actor = identity.principal
  try {
    if (['learn_preference', 'learn_hypothesis', 'remember_video', 'memory_recall', 'memory_forget'].includes(action)) return runLearning(rawStore, args, identity)
    if (['interest_recall', 'interest_used', 'interest_forget'].includes(action)) return interestAction(rawStore, identity, args)
    if (['semantic_observe', 'semantic_forget', 'semantic_list'].includes(action)) return semanticAction(rawStore, identity, args)
    if (action === 'auto_memory_list') return autoMemoryList(rawStore, identity)
    if (action === 'recommend_candidates') return recommendCandidates(rawStore, identity)
    if (action === 'shared_video_recall') return recallSharedVideoDiary(rawStore, identity)
    if (action === 'video_material') return analyzeWhaleVideo(rawStore, identity, args.bvid).catch(error => bad(String(error?.message ?? error)))
    if (action === 'document_list') return listWhaleDocuments(rawStore, identity)
    if (action === 'document_read') return readWhaleDocument(rawStore, identity, args)
    if (action === 'document_find') return findWhaleReports(rawStore, identity, args.bvid)
    if (action === 'profile') {
      if (!allows(identity.scopes, 'profile:read')) return bad('没有 profile:read 权限')
      return { ok: true, action, profile: readSharedProfile(rawStore, { id: args.profileId, principal: actor }) }
    }
    const store = scopedStore(rawStore, identity)
    switch (action) {
      case 'ingest': {
        const res = store.addItem({
          kind: args.kind,
          source: args.source,
          bvid: args.bvid,
          title: args.title,
          url: args.url,
          text: args.text,
          payload: args.payload,
          tags: args.tags,
          private: args.private,
          dedupe: args.dedupe,
          dedupeKey: args.dedupeKey,
          fromChannel: args.fromChannel || actor,
          fromUser: args.fromUser,
        }, actor)
        return { ok: true, action, ...res }
      }
      case 'next': {
        const item = store.nextQueuedItem()
        const command = store.nextPendingCommand()
        return { ok: true, action, item, command }
      }
      case 'ack': {
        if (!args.id) return bad('ack 需要 id')
        return { ok: true, action, ...store.setItemStatus(String(args.id), 'done') }
      }
      case 'list': {
        const { items, total } = store.listItems({ status: args.status, source: args.source, q: args.q, limit: args.limit })
        return { ok: true, action, items, total }
      }
      case 'get': {
        if (!args.id) return bad('get 需要 id')
        const item = store.getItem(String(args.id))
        if (!item) return { ok: false, error: 'item 不存在或无权访问' }
        return { ok: true, action, item }
      }
      case 'command': {
        if (!args.commandAction) return bad('command 需要 commandAction（如 watch / digest / note）')
        const command = store.addCommand({
          channel: args.channel || actor,
          user: args.user || '',
          action: String(args.commandAction),
          args: args.commandArgs ?? null,
          wake: args.wake !== false,
          private: args.private,
        })
        return command.discarded ? { ok: true, action, command: null, ...command } : { ok: true, action, command }
      }
      case 'commands': {
        const { commands, total } = store.listCommands({ status: args.status, limit: args.limit })
        return { ok: true, action, commands, total }
      }
      case 'kv_get': {
        if (!args.key) return bad('kv_get 需要 key')
        const v = store.kvGet(String(args.key))
        return { ok: true, action, key: String(args.key), exists: !!v, ...(v ?? {}) }
      }
      case 'kv_set': {
        if (!args.key) return bad('kv_set 需要 key')
        return { ok: true, action, ...store.kvSet(String(args.key), args.value ?? null, actor) }
      }
      case 'seen': {
        if (!args.key) return bad('seen 需要 key')
        return { ok: true, action, ...store.seenAdd(String(args.key), args.meta ?? null) }
      }
      case 'stats': {
        return { ok: true, action, stats: store.stats() }
      }
      case 'forget': return { action, ...store.forget({ id: args.id, key: args.key }) }
      default:
        return bad(`未知动作（可用：${ACTIONS.join(' / ')}）`)
    }
  } catch (e) {
    const message = String(e?.message ?? e)
    return bad(isSensitive(message) ? '操作失败，未返回敏感信息' : message)
  }
}

export { ACTIONS, DEFAULT_SCOPES }

/** 把 runAction 的结果压成人能读的几行（给 CLI 的 --text 模式和工具渲染用）。 */
export function summarize(result) {
  if (!result || result.ok === false) return '出错：' + (result?.error ?? '未知错误')
  const action = result.action
  if (result.discarded) return '隐私内容未保存、未回显。'
  if (action === 'ingest') return result.dup ? '已存在（判重命中）' : '已入库 · ' + (result.item?.id ?? '')
  if (action === 'next') {
    const lines = []
    lines.push(result.item ? `下一条待看：${result.item.id} ${result.item.title || result.item.bvid || result.item.text.slice(0, 40)}` : '没有排队的内容')
    lines.push(result.command ? `下一条指令：${result.command.id} ${result.command.action}` : '没有待处理指令')
    return lines.join('\n')
  }
  if (action === 'list') return `${result.total} 条（显示 ${result.items.length}）\n` + result.items.map((i) => `· ${i.id} [${i.status}] ${i.source} ${i.title || i.bvid || i.text.slice(0, 40)}`).join('\n')
  if (action === 'commands') return `${result.total} 条指令（显示 ${result.commands.length}）\n` + result.commands.map((c) => `· ${c.id} [${c.status}] ${c.action} from ${c.channel}`).join('\n')
  if (action === 'kv_get') return result.exists ? `${result.key} = ${JSON.stringify(result.value)}` : `${result.key}（不存在）`
  if (action === 'kv_set') return `已写 ${result.key}`
  if (action === 'seen') return result.added ? '新记录' : '已存在'
  if (action === 'stats') return `条目 ${result.stats.items} · 指令 ${result.stats.commands}`
  return JSON.stringify(result)
}
