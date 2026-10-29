import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { isSensitive } from './privacy.mjs'

const ID = 'deepseek'
const KIND = 'whale-public-fields-v1'
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const PROFILE_USAGE = '这是经本人批准共享的 DeepSeek 公共资料：persona 是人物身份与说话方式，preferences 和 bilibili 是刷站内容喜好与选题资料，不能当成人物性格或推广到无关话题。仅在承担此角色时使用；保留本会话明确指定的角色卡、平台规则与发送权限。它不包含私人聊天记忆，不授权公开私人信息，也不授权调用其他平台的发送工具。'

/** Match whale's actual home/config resolution without importing or starting whale. */
export function whaleProfileSources(env = process.env) {
  const userHome = env.USERPROFILE || env.HOME || os.homedir()
  const dshHome = env.DSH_HOME || path.join(userHome, '.dsh')
  return {
    config: path.resolve(env.BILI_WHALE_CONFIG || path.join(dshHome, 'bili-whale.config.json')),
    persona: path.resolve(userHome, '.bili-ai', 'persona.md'),
    prefs: path.resolve(userHome, '.bili-ai', 'prefs.json'),
  }
}

function readSmall(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('共享来源路径无效')
  try {
    if (fs.statSync(file).size > 256 * 1024) throw fail('共享来源超过大小限制')
    const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw fail('共享来源超过大小限制')
    return content
  } catch { throw fail('共享来源无法读取；请在本机检查 profile status') }
}

function string(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('共享人设字段类型或长度无效')
  return value.trim()
}

function words(value) {
  if (!Array.isArray(value) || value.length > 100) throw fail('共享偏好须为最多 100 项的字符串数组')
  return value.map(v => string(v, 160))
}

function publicPersona(markdown) {
  const chunks = markdown.replace(/\r\n/g, '\n').split(/^##\s+/m)
  const introduction = string(chunks.shift(), 2000)
  const sections = new Map(chunks.map(chunk => {
    const newline = chunk.indexOf('\n')
    return [chunk.slice(0, newline).trim(), chunk.slice(newline + 1).trim()]
  }))
  // Only these reviewed sections are portable. Diary, recipient and platform permission sections stay local.
  const voice = string(sections.get('性格和说话'))
  const selectionStyle = sections.has('我刷 B 站时') ? string(sections.get('我刷 B 站时')) : ''
  return { introduction, voice, selectionStyle }
}

function project(sources) {
  let config, prefs
  try {
    config = JSON.parse(readSmall(sources.config))
    prefs = JSON.parse(readSmall(sources.prefs))
  } catch { throw fail('共享配置格式无效；已停止提供共享资料') }
  const persona = publicPersona(readSmall(sources.persona))
  const profile = {
    id: ID,
    schemaVersion: 1,
    persona: {
      name: string(config.persona?.name, 100),
      selfClaim: string(config.persona?.selfClaim, 40),
      introduction: persona.introduction,
      voice: persona.voice,
    },
    preferences: {
      like: words(config.preferences?.like),
      dislike: words(config.preferences?.dislike),
    },
    bilibili: { selectionStyle: persona.selectionStyle, keywords: words(prefs.keywords) },
  }
  // Detection supplements owner review. Reject credentials/PII/paths rather than silently redacting a persona.
  if (isSensitive(profile) || /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home)\/)/.test(JSON.stringify(profile))) throw fail('公共资料命中敏感内容或本机路径，已拒绝共享；请在源文件中分离隐私')
  return profile
}

function approved(store) {
  const entry = store.read().sharedProfiles?.[ID]
  if (entry && (entry.kind !== KIND || !/^[a-f0-9]{64}$/.test(entry.approvedHash))) throw fail('共享资料授权记录无效')
  return entry
}

/** Local owner action only. Store paths + projection digest, never duplicate private files or persona text. */
export function linkWhaleProfile(store, sources = whaleProfileSources()) {
  const profile = project(sources)
  const approvedHash = hash(profile)
  const approvedAt = new Date().toISOString()
  store.tx(db => {
    db.sharedProfiles ??= {}
    db.sharedProfiles[ID] = { kind: KIND, sources, approvedHash, approvedAt }
    store._auditInto(db, { actor: 'owner', action: 'profile:approve', target: ID })
  })
  return { ok: true, id: ID, revision: approvedHash.slice(0, 12), approvedAt, sources, fields: ['persona.name', 'persona.selfClaim', 'persona.introduction', 'persona.voice', 'preferences.like', 'preferences.dislike', 'bilibili.selectionStyle', 'bilibili.keywords'] }
}

export function readSharedProfile(store, { id = ID, principal = 'owner', optional = false } = {}) {
  if (id !== ID) throw fail('共享角色不存在', 404)
  const entry = approved(store)
  if (!entry) {
    if (optional) return null
    throw fail('尚未授权共享角色；请由本人在本机执行 profile link-whale', 404)
  }
  const data = project(entry.sources)
  if (hash(data) !== entry.approvedHash) throw fail('共享人设或偏好已修改，等待本人执行 profile link-whale 重新授权；未返回未审阅内容')
  store.audit({ actor: principal, action: 'profile:read', target: ID })
  return { id: ID, revision: entry.approvedHash.slice(0, 12), data, usage: PROFILE_USAGE }
}

/** Owner diagnostics include source paths; model/HTTP channel reads never receive them. */
export function sharedProfileStatus(store) {
  const entry = approved(store)
  if (!entry) return { configured: false, discoveredSources: whaleProfileSources() }
  let state = 'ready'
  try { if (hash(project(entry.sources)) !== entry.approvedHash) state = 'approval-required' } catch { state = 'blocked' }
  return { configured: true, id: ID, state, revision: entry.approvedHash.slice(0, 12), approvedAt: entry.approvedAt, sources: entry.sources }
}

export function unlinkSharedProfile(store) {
  return store.tx(db => {
    if (db.sharedProfiles) delete db.sharedProfiles[ID]
    store._auditInto(db, { actor: 'owner', action: 'profile:revoke', target: ID })
    return { ok: true, id: ID, revoked: true }
  })
}
