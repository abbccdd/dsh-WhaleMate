#!/usr/bin/env node
/**
 * dsh-pond CLI —— 本机 owner 入口（终端 / 脚本 / agent bash 都能用）
 *
 * 与 HTTP API 的区别：本机 CLI 直接读 keys.json，天然是 owner 权限；
 * HTTP API 只认 x-pond-key，外部应用（QQ bot / 微信桥 / B站采集器）走那条路。
 *
 * 用法总览：node tools/pond.mjs <命令> [--参数 值 ...] [--human]（默认输出 JSON；--human 输出人读摘要）
 *
 * 常用：
 *   pond.mjs init                               初始化（打印 owner 令牌，只显示这一次）
 *   pond.mjs status                             总览
 *   pond.mjs item add --kind video --source bili --bvid BV1xx --title "..." --dedupe
 *   pond.mjs item list [--status queued] [--source bili] [--q 关键词] [--limit 20]
 *   pond.mjs next                               最老的待看内容 + 待处理指令
 *   pond.mjs item ack <id>
 *   pond.mjs cmd add --action watch --text "去看这个 BV1xx" [--wake false]
 *   pond.mjs cmd list [--status pending]
 *   pond.mjs kv set <key> <value> / pond.mjs kv get <key>
 *   pond.mjs channel add qq [--kind qq] [--scopes commands:write,items:read]
 *   pond.mjs channel list / rotate <id|name> / revoke <id|name>
 *   pond.mjs export [--out 文件]                导出全部数据（owner）
 *   pond.mjs audit [--limit 50]
 *   pond.mjs purge --older-than-days 30
 *   pond.mjs wipe --yes
 *   pond.mjs key show / key rotate
 *   pond.mjs import-whale                       把 ~/.bili-ai/seen.md 的判重行导进来
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pond, defaultPondHome } from '../lib/store.mjs'
import { runAction, summarize } from '../lib/actions.mjs'
import { DEFAULT_SCOPES } from '../lib/security.mjs'
import { PRIVACY_PROMPT } from '../lib/privacy.mjs'
import { linkWhaleProfile, readSharedProfile, sharedProfileStatus, unlinkSharedProfile, whaleProfileSources } from '../lib/profile.mjs'
import { bindLearning, listLearningBindings, importWhaleReports } from '../lib/memory.mjs'
import { linkWhaleDocuments, unlinkWhaleDocuments, whaleDocumentSources } from '../lib/documents.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)

function out(obj, asText = false) {
  if (asText) {
    const pretty = typeof obj === 'string' ? obj : summarize(obj)
    process.stdout.write(pretty + '\n')
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  }
}

function die(msg, extra = {}, asJson = true) {
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n')
  else process.stderr.write('错误：' + msg + '\n')
  process.exit(1)
}

// ── 极简参数解析 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') { out.flags.json = true; continue }
    if (a === '--human') { out.flags.human = true; continue }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++ }
      else out.flags[key] = true
      continue
    }
    out._.push(a)
  }
  return out
}

const F = (args, k) => args.flags[k]

function pondHome() { return defaultPondHome() }

function openPond() {
  const p = Pond.open(pondHome())
  return p
}

function asBool(v, def = false) {
  if (v === undefined) return def
  if (v === true || v === false) return v
  return !['false', '0', 'no', 'off', ''].includes(String(v).toLowerCase())
}

// ── 命令实现 ────────────────────────────────────────────────────────────────────
function cmdInit(asText) {
  const p = openPond()
  const r = p.init()
  out({
    ok: true,
    home: r.home,
    file: r.file,
    privacyCleanup: r.privacyCleanup,
    ownerKeyHint: 'init 不显示令牌；确需管理令牌时，由本人显式运行 key show',
    scopesHint: DEFAULT_SCOPES,
    pluginRoot: PLUGIN_ROOT,
  }, asText)
}

function cmdStatus(asText) {
  const p = openPond()
  const stats = p.stats()
  const pendingItems = p.listItems({ status: 'queued', limit: 3 })
  const pendingCmds = p.listCommands({ status: 'pending', limit: 3 })
  const res = {
    ok: true,
    stats,
    recentlyQueued: pendingItems.items.map((i) => ({ id: i.id, title: i.title || i.bvid || i.text.slice(0, 40), source: i.source, at: i.createdAt })),
    pendingCommands: pendingCmds.commands.map((c) => ({ id: c.id, action: c.action, channel: c.channel, at: c.createdAt })),
    channels: p.channelList(),
  }
  if (asText) {
    const lines = [
      `鱼塘：${stats.home}`,
      `条目 ${stats.items}（${JSON.stringify(stats.itemsByStatus)}）· 指令 ${stats.commands}（${JSON.stringify(stats.commandsByStatus)}）· 渠道 ${stats.channels} · 判重 ${stats.seen} · 文件 ${stats.bytes} 字节`,
      pendingItems.items.length ? '待看：\n' + pendingItems.items.map((i) => `  · ${i.id} ${i.title || i.bvid || i.text.slice(0, 40)}`).join('\n') : '待看：无',
      pendingCmds.commands.length ? '待办指令：\n' + pendingCmds.commands.map((c) => `  · ${c.id} ${c.action} from ${c.channel}`).join('\n') : '待办指令：无',
    ]
    out(lines.join('\n'), true)
  } else out(res)
}

function splitList(v) {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return v
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function cmdItem(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'add') {
    if (F(args, 'dedupe') && !F(args, 'bvid') && !F(args, 'url') && !F(args, 'text')) return die('--dedupe 需要 bvid / url / text 之一作为判重依据')
    const item = p.addItem({
      kind: F(args, 'kind') || 'note',
      source: F(args, 'source') || 'misc',
      bvid: F(args, 'bvid'),
      title: F(args, 'title'),
      url: F(args, 'url'),
      text: F(args, 'text'),
      tags: splitList(F(args, 'tags')),
      private: asBool(F(args, 'private')),
      dedupe: asBool(F(args, 'dedupe')),
      dedupeKey: F(args, 'dedupe-key'),
      fromChannel: 'cli',
      fromUser: F(args, 'user') || '',
    }, 'cli')
    out(item.dup ? { ok: true, dup: true, dedupeKey: item.dedupeKey } : { ok: true, dup: false, item: item.item }, asText)
    return
  }
  if (sub === 'list') {
    const r = p.listItems({ status: F(args, 'status'), source: F(args, 'source'), q: F(args, 'q'), limit: Number(F(args, 'limit') ?? 50), canSeePrivate: true })
    out({ ok: true, ...r }, asText)
    return
  }
  if (sub === 'get') {
    const it = p.getItem(args._[2])
    if (!it) return die('item 不存在：' + (args._[2] ?? ''))
    out({ ok: true, item: it }, asText)
    return
  }
  if (sub === 'ack' || sub === 'archive') {
    const r = p.setItemStatus(args._[2], sub === 'ack' ? 'done' : 'archived')
    out({ ok: r.ok, ...r }, asText)
    return
  }
  return die(`未知 item 子命令：${sub ?? '(空)'}（add / list / get / ack / archive）`)
}

function cmdNext(asText) {
  const p = openPond()
  const item = p.nextQueuedItem()
  const command = p.nextPendingCommand()
  out({ ok: true, item, command }, asText)
}

function cmdShare(args, asText) {
  const collection = args._[1] === 'item' ? 'items' : args._[1] === 'command' ? 'commands' : ''
  if (args._[0] === 'unshare') {
    if (!collection || !args._[2]) return die('用法：unshare item|command <id>')
    return out(openPond().share(collection, args._[2], []), asText)
  }
  if (!collection || !args._[2] || !F(args, 'to')) return die('用法：share item|command <id> --to session:<会话ID>,channel:<渠道ID>')
  out(openPond().share(collection, args._[2], splitList(F(args, 'to'))), asText)
}

function cmdPrivacy(args, asText) {
  if (args._[1] === 'clean') {
    if (F(args, 'yes') !== true) return die('清理旧的私密/敏感内容需要 privacy clean --yes；仅返回数量，不回显原文')
    return out({ ok: true, ...openPond().privacyClean() }, asText)
  }
  out({ ok: true, policy: PRIVACY_PROMPT, mode: 'discard', note: '不保存新敏感内容；不等于删除已发送到模型或其他应用的聊天记录' }, asText)
}

function cmdProfile(args, asText) {
  const store = openPond()
  switch (args._[1] ?? 'show') {
    case 'link-whale': {
      const sources = whaleProfileSources()
      for (const key of ['config', 'persona', 'prefs']) {
        if (F(args, key)) sources[key] = path.resolve(String(F(args, key)))
      }
      return out(linkWhaleProfile(store, sources), asText)
    }
    case 'show': return out({ ok: true, profile: readSharedProfile(store) }, asText)
    case 'status': return out({ ok: true, ...sharedProfileStatus(store) }, asText)
    case 'unlink': return out(unlinkSharedProfile(store), asText)
    default: return die('profile 子命令：link-whale / show / status / unlink')
  }
}

function cmdLearning(args, asText) {
  const sub = args._[1]
  if (sub === 'list') return out(listLearningBindings(openPond()), asText)
  if (sub === 'bind') return out(bindLearning(openPond(), args._[2], args._[3]), asText)
  if (sub === 'remove') return out(bindLearning(openPond(), args._[2], 'remove'), asText)
  if (sub === 'import-whale') return out(importWhaleReports(openPond(), path.join(os.homedir(), '.bili-ai', 'out')), asText)
  return die('用法：learning list | learning bind session:<ID> owner|watcher | learning remove session:<ID> | learning import-whale')
}

function cmdDocuments(args, asText) {
  if (args._[1] === 'link-whale') return out(linkWhaleDocuments(openPond(), whaleDocumentSources()), asText)
  if (args._[1] === 'unlink') return out(unlinkWhaleDocuments(openPond()), asText)
  return die('用法：documents link-whale | documents unlink')
}

function cmdCmd(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'add') {
    const action = F(args, 'action')
    if (!action) return die('cmd add 需要 --action（如 watch / digest / note）')
    const commandArgs = F(args, 'text') ? { text: String(F(args, 'text')) } : undefined
    const cmd = p.addCommand({ channel: 'cli', user: F(args, 'user') || '', action, args: commandArgs ?? null, wake: asBool(F(args, 'wake'), true) })
    out({ ok: true, command: cmd }, asText)
    return
  }
  if (sub === 'list') {
    const r = p.listCommands({ status: F(args, 'status'), limit: Number(F(args, 'limit') ?? 50) })
    out({ ok: true, ...r }, asText)
    return
  }
  if (sub === 'start') { out({ ok: true, ...p.startCommand(args._[2]) }, asText); return }
  if (sub === 'done') { out({ ok: true, ...p.finishCommand(args._[2], { status: 'done', result: F(args, 'result') ?? null }) }, asText); return }
  if (sub === 'fail') { out({ ok: true, ...p.finishCommand(args._[2], { status: 'failed', error: F(args, 'error') ?? '手动标记失败' }) }, asText); return }
  return die(`未知 cmd 子命令：${sub ?? '(空)'}（add / list / start / done / fail）`)
}

function cmdKv(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'get') {
    const v = p.kvGet(args._[2])
    out(v ? { ok: true, key: args._[2], ...v } : { ok: false, error: '不存在：' + (args._[2] ?? '') }, asText)
    return
  }
  if (sub === 'set') {
    if (!args._[2]) return die('kv set 需要 key')
    let value = args._.slice(3).join(' ')
    if (value === '') return die('kv set 需要 value（自动尝试 JSON 解析）')
    try { value = JSON.parse(value) } catch { /* 当字符串 */ }
    out({ ok: true, ...p.kvSet(args._[2], value, 'cli') }, asText)
    return
  }
  if (sub === 'list') { out({ ok: true, kv: p.kvList() }, asText); return }
  return die(`未知 kv 子命令：${sub ?? '(空)'}（get / set / list）`)
}

function cmdSeen(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'add') {
    if (!args._[2]) return die('seen add 需要 key')
    const r = p.seenAdd(args._[2], F(args, 'meta') ? { text: String(F(args, 'meta')) } : null)
    out({ ok: true, ...r }, asText)
    return
  }
  if (sub === 'check') { out({ ok: true, key: args._[2], ...p.seenCheck(args._[2]) }, asText); return }
  return die(`未知 seen 子命令：${sub ?? '(空)'}（add / check）`)
}

function cmdChannel(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'add') {
    const name = args._[2]
    if (!name) return die('channel add 需要 name（如 qq / wechat / bili）')
    const kind = F(args, 'kind') || 'custom'
    const scopes = splitList(F(args, 'scopes')) ?? DEFAULT_SCOPES[kind] ?? ['items:read']
    const r = p.channelAdd({ name, kind, scopes })
    out({ ok: true, ...r, warn: '渠道令牌只显示这一次，存到对应应用里；丢了就 rotate' }, asText)
    return
  }
  if (sub === 'list') { out({ ok: true, channels: p.channelList() }, asText); return }
  if (sub === 'rotate') { out({ ok: true, ...p.channelRotate(args._[2]) }, asText); return }
  if (sub === 'revoke') { out({ ok: true, ...p.channelRevoke(args._[2]) }, asText); return }
  return die(`未知 channel 子命令：${sub ?? '(空)'}（add / list / rotate / revoke）`)
}

function cmdKey(args, asText) {
  const sub = args._[1]
  const p = openPond()
  if (sub === 'show') {
    const token = p.ownerToken() || p.ensureOwnerToken()
    out({ ok: true, ownerToken: token, warn: '仅本机 owner 可见；任何应用只该拿渠道令牌' }, asText)
    return
  }
  if (sub === 'rotate') { out({ ok: true, ownerToken: p.rotateOwnerToken(), warn: '旧 owner 令牌作废' }, asText); return }
  return die(`未知 key 子命令：${sub ?? '(空)'}（show / rotate）`)
}

function cmdExport(args, asText) {
  const p = openPond()
  const db = p.exportAll()
  const outFile = F(args, 'out')
  if (outFile) {
    const resolved = path.isAbsolute(outFile) ? outFile : path.resolve(process.cwd(), outFile)
    fs.writeFileSync(resolved, JSON.stringify(db, null, 2) + '\n', 'utf8')
    out({ ok: true, file: resolved, bytes: db.items.length }, asText)
    return
  }
  out({ ok: true, db }, asText)
}

function cmdAudit(args, asText) {
  const p = openPond()
  out({ ok: true, audit: p.auditTail(Number(F(args, 'limit') ?? 50)) }, asText)
}

function cmdPurge(args, asText) {
  const p = openPond()
  const r = p.purge({ olderThanDays: Number(F(args, 'older-than-days') ?? F(args, 'days') ?? 30) })
  out({ ok: true, ...r }, asText)
}

function cmdWipe(args, asText) {
  const p = openPond()
  if (F(args, 'yes') !== true) return die('清空需要 --yes（会删除 items / commands / seen / kv / audit，渠道与 owner 令牌保留）')
  out({ ok: true, ...p.wipe() }, asText)
}

function cmdSearch(args, asText) {
  const p = openPond()
  if (!args._[1]) return die('search 需要关键词')
  const r = p.listItems({ q: args._[1], limit: Number(F(args, 'limit') ?? 50), canSeePrivate: true })
  out({ ok: true, ...r }, asText)
}

/** 把 whale 的 seen.md 判重表导入（每行一个 BV）。--file 可指定别的文件。 */
function cmdImportWhale(args, asText) {
  const p = openPond()
  const override = F(args, 'file')
  const file = override
    ? (path.isAbsolute(String(override)) ? String(override) : path.resolve(process.cwd(), String(override)))
    : path.join(os.homedir(), '.bili-ai', 'seen.md')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return die('找不到 ' + file + '（先让养鱼跑一轮，或用 --file 指定别的文件）') }
  let added = 0
  let skipped = 0
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(BV[0-9A-Za-z]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/)
    if (!m) continue
    const [, date, bvid, title, up, level, depth] = m
    const r = p.seenAdd(bvid, { source: 'bili', title: title || '', up: up || '', level: level || '', depth: depth || '', date })
    if (r.added) { added++; } else skipped++
    // 顺带把「值得看 / 可以看」的做成条目，让 agent 下次能 next 到
    if (!p.findItemByKey(bvid) && /值得看|可以看/.test(level || '')) {
      try {
        p.addItem({ kind: 'video', source: 'bili', bvid, title: title || '', status: 'queued', dedupe: false, dedupeKey: bvid, tags: [level].filter(Boolean), fromChannel: 'import-whale' }, 'cli')
      } catch { /* 单条失败不影响整体 */ }
    }
  }
  out({ ok: true, file, added, skipped, message: '已导入判重账本；条目只补「值得看 / 可以看」档。以后新数据请直接走 pond 渠道写入。' }, asText)
}

// ── 主入口 ──────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const asText = F(args, 'human') === true
  const cmd = args._[0]
  const known = ['init', 'status', 'item', 'next', 'cmd', 'command', 'kv', 'seen', 'channel', 'key', 'export', 'audit', 'purge', 'wipe', 'search', 'import-whale', 'share', 'unshare', 'forget', 'privacy', 'profile', 'learning', 'documents', 'help', '-h', '--help']
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { out({ ok: true, usage: '见文件头注释；常用：init / status / item add / item list / next / cmd add', pluginRoot: PLUGIN_ROOT }, asText); return }
  if (!known.includes(cmd)) return die('未知命令：' + cmd)

  switch (cmd) {
    case 'init': return cmdInit(asText)
    case 'status': return cmdStatus(asText)
    case 'item': return cmdItem(args, asText)
    case 'next': return cmdNext(asText)
    case 'cmd':
    case 'command': return cmdCmd(args, asText)
    case 'kv': return cmdKv(args, asText)
    case 'seen': return cmdSeen(args, asText)
    case 'channel': return cmdChannel(args, asText)
    case 'key': return cmdKey(asText)
    case 'export': return cmdExport(args, asText)
    case 'audit': return cmdAudit(args, asText)
    case 'purge': return cmdPurge(args, asText)
    case 'wipe': return cmdWipe(args, asText)
    case 'search': return cmdSearch(args, asText)
    case 'import-whale': return cmdImportWhale(args, asText)
    case 'share':
    case 'unshare': return cmdShare(args, asText)
    case 'forget': return out(openPond().forget({ id: args._[1], key: F(args, 'key') }), asText)
    case 'privacy': return cmdPrivacy(args, asText)
    case 'profile': return cmdProfile(args, asText)
    case 'learning': return cmdLearning(args, asText)
    case 'documents': return cmdDocuments(args, asText)
  }
}

try {
  main()
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2) + '\n')
  process.exit(1)
}
