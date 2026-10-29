/** 本机 HTTP API：真实回环/同源栅栏、请求头令牌、按身份分区的访问层；管理接口仅 owner。 */
import { tokenFromRequest, allows } from './security.mjs'
import { scopedStore } from './access.mjs'
import { isLoopbackReq } from './host-compat.mjs'
import { isSensitive, PRIVACY_PROMPT } from './privacy.mjs'
import { readSharedProfile } from './profile.mjs'
import { configureProactive, proactiveStatus } from './proactive.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareOwnerPairing, ownerStatus } from '../vendor/tencent-dsh-qqbot-owner/dist/owner-guard.js'
import { bindLearning } from './memory.mjs'
import { verifiedQQSession } from './qq-session.mjs'
import { configureAutoMemory } from './auto-memory.mjs'
import { linkWhaleProfile } from './profile.mjs'
import { linkWhaleDocuments } from './documents.mjs'

const BODY_LIMIT = 512 * 1024
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 120

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(Object.assign(new Error('body 不是合法 JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * 构造一个 DSH webServer 的 prefix 路由处理器。
 * @param {{ store: import('./store.mjs').Pond, fence?: (req: import('node:http').IncomingMessage) => number|null|undefined }} opts
 */
export function createPondApi({ store, fence } = {}) {
  const rate = new Map() // channelId -> { windowStart, count }
  const PREFIX = '/dsh-pond/api'

  /** 每个请求的限流检查。返回 null 表示放行，否则返回 429。 */
  function rateLimited(auth, res) {
    if (!auth || auth.kind === 'owner') return false
    const id = auth.channel.id
    const now = Date.now()
    const slot = rate.get(id) ?? { windowStart: now, count: 0 }
    if (now - slot.windowStart >= RATE_WINDOW_MS) { slot.windowStart = now; slot.count = 0 }
    slot.count += 1
    rate.set(id, slot)
    if (slot.count > RATE_MAX) {
      json(res, 429, { ok: false, error: `限流：${RATE_MAX} 次/分钟。别让脚本无脑循环（这是对平台的保护，也是对你的钱包）` })
      return true
    }
    return false
  }

  // ── 路由表 ──────────────────────────────────────────────────────────────────
  // 每条：method / 正则 / 所需 scope（null=公开）/ handler({ auth, body, url, canSeePrivate })
  const routes = [
    {
      method: 'GET', re: /^\/dsh-pond\/api\/profile$/, scope: 'profile:read',
      handler: ({ auth, url }) => ({ ok: true, profile: readSharedProfile(store, { id: url.searchParams.get('id') || 'deepseek', principal: auth.kind === 'owner' ? 'owner' : 'channel:' + auth.channel.id }) }),
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/health$/, scope: null,
      handler: ({ client }) => ({ ok: true, app: 'dsh-pond', version: 2, pluginVersion: '0.6.0' }),
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/stats$/, scope: 'items:read',
      handler: ({ client }) => ({ ok: true, stats: client.stats() }),
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/items$/, scope: 'items:read',
      handler: ({ client, url, canSeePrivate }) => {
        const { items, total } = client.listItems({
          status: url.searchParams.get('status') || undefined,
          source: url.searchParams.get('source') || undefined,
          q: url.searchParams.get('q') || undefined,
          limit: Number(url.searchParams.get('limit') ?? 50),
          canSeePrivate,
        })
        return { ok: true, items, total }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/items$/, scope: 'items:write',
      handler: ({ client, auth, body }) => {
        const fromChannel = auth.kind === 'channel' ? auth.channel.name : 'http'
        const res = client.addItem({
          kind: body.kind,
          source: body.source,
          bvid: body.bvid,
          title: body.title,
          url: body.url,
          text: body.text,
          payload: body.payload,
          tags: body.tags,
          private: body.private,
          dedupe: body.dedupe,
          dedupeKey: body.dedupeKey,
          fromChannel,
          fromUser: body.fromUser,
        }, 'channel:' + fromChannel)
        return { ok: true, ...res }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/items\/([^/]+)$/, scope: 'items:read',
      handler: ({ client, url, canSeePrivate }) => {
        const id = decodeURIComponent(url.pathname.match(/\/items\/([^/]+)$/)[1])
        const item = client.getItem(id)
        if (!item || (item.private && !canSeePrivate)) throw Object.assign(new Error('item 不存在'), { status: 404 })
        return { ok: true, item }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/items\/([^/]+)\/(ack|archive)$/, scope: 'items:write',
      handler: ({ client, url }) => {
        const m = url.pathname.match(/\/items\/([^/]+)\/(ack|archive)$/)
        const id = decodeURIComponent(m[1])
        return { ok: true, ...client.setItemStatus(id, m[2] === 'ack' ? 'done' : 'archived') }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/commands$/, scope: 'commands:read',
      handler: ({ client, url }) => {
        const { commands, total } = client.listCommands({
          status: url.searchParams.get('status') || undefined,
          limit: Number(url.searchParams.get('limit') ?? 50),
        })
        return { ok: true, commands, total }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/commands$/, scope: 'commands:write',
      handler: ({ client, auth, body }) => {
        if (!body.action) throw Object.assign(new Error('commands 需要 action 字段'), { status: 400 })
        const command = client.addCommand({
          channel: auth.kind === 'channel' ? auth.channel.name : 'http',
          user: body.user ?? '',
          action: body.action,
          args: body.args ?? null,
          wake: body.wake !== false,
          private: body.private,
        })
        return command.discarded ? { ok: true, command: null, ...command } : { ok: true, command }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/commands\/([^/]+)\/start$/, scope: 'commands:write',
      handler: ({ client, url }) => {
        const id = decodeURIComponent(url.pathname.match(/\/commands\/([^/]+)\/start$/)[1])
        return { ok: true, ...client.startCommand(id) }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/commands\/([^/]+)\/done$/, scope: 'commands:write',
      handler: ({ client, url, body }) => {
        const id = decodeURIComponent(url.pathname.match(/\/commands\/([^/]+)\/done$/)[1])
        const status = body.status === 'failed' ? 'failed' : 'done'
        return { ok: true, ...client.finishCommand(id, { status, result: body.result ?? null, error: body.error ?? null }) }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/kv$/, scope: 'kv:read',
      handler: ({ client }) => ({ ok: true, kv: client.kvList() }),
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/kv\/([^/]+)$/, scope: 'kv:read',
      handler: ({ client, url }) => {
        const key = decodeURIComponent(url.pathname.match(/\/kv\/([^/]+)$/)[1])
        const v = client.kvGet(key)
        return v ? { ok: true, key, ...v } : { ok: false, error: '不存在：' + key }
      },
    },
    {
      method: 'PUT', re: /^\/dsh-pond\/api\/kv\/([^/]+)$/, scope: 'kv:write',
      handler: ({ client, auth, url, body }) => {
        const key = decodeURIComponent(url.pathname.match(/\/kv\/([^/]+)$/)[1])
        const by = auth.kind === 'channel' ? 'channel:' + auth.channel.name : 'http'
        return { ok: true, ...client.kvSet(key, body.value ?? null, by) }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/seen$/, scope: 'seen:write',
      handler: ({ client, body }) => {
        if (!body.key) throw Object.assign(new Error('seen 需要 key 字段'), { status: 400 })
        return { ok: true, ...client.seenAdd(body.key, body.meta ?? null) }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/seen\/([^/]+)$/, scope: 'seen:read',
      handler: ({ client, url }) => {
        const key = decodeURIComponent(url.pathname.match(/\/seen\/([^/]+)$/)[1])
        return { ok: true, key, ...client.seenCheck(key) }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/forget$/, scope: 'items:write',
      handler: ({ client, body }) => ({ ok: true, ...client.forget({ id: body.id }) }),
    },
    // ── 管理面（只认 owner / admin scope）──────────────────────────────────────
    {
      method: 'GET', re: /^\/dsh-pond\/api\/channels$/, scope: 'admin',
      handler: () => ({ ok: true, channels: store.channelList() }),
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/channels$/, scope: 'admin',
      handler: ({ body }) => {
        const { channel, token } = store.channelAdd({ name: body.name, kind: body.kind, scopes: body.scopes })
        return { ok: true, channel, token, warn: '令牌只显示这一次，请存到对应应用里；丢了就 rotate' }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/channels\/([^/]+)\/rotate$/, scope: 'admin',
      handler: ({ url }) => {
        const id = decodeURIComponent(url.pathname.match(/\/channels\/([^/]+)\/rotate$/)[1])
        return { ok: true, ...store.channelRotate(id) }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/channels\/([^/]+)\/revoke$/, scope: 'admin',
      handler: ({ url }) => {
        const id = decodeURIComponent(url.pathname.match(/\/channels\/([^/]+)\/revoke$/)[1])
        return { ok: true, ...store.channelRevoke(id) }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/audit$/, scope: 'admin',
      handler: ({ url }) => {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return { ok: true, audit: store.auditTail(limit) }
      },
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/purge$/, scope: 'admin',
      handler: ({ body }) => ({ ok: true, ...store.purge({ olderThanDays: Number(body.olderThanDays ?? body.days ?? 30) }) }),
    },
    {
      method: 'POST', re: /^\/dsh-pond\/api\/wipe$/, scope: 'admin',
      handler: ({ body }) => {
        if (body.confirm !== 'WIPE') throw Object.assign(new Error('清空需要 body.confirm="WIPE"（防手滑）'), { status: 400 })
        return { ok: true, ...store.wipe(), wiped: true }
      },
    },
    {
      method: 'GET', re: /^\/dsh-pond\/api\/export$/, scope: 'admin',
      handler: () => ({ ok: true, db: store.exportAll() }),
    },
  ]

  return {
    prefix: PREFIX,
    routes,
    async handle(req, res) {
      try {
        // ① 回环栅栏（宿主提供；缺省即拒绝 —— 安全组件默认关）
        if (typeof fence !== 'function' || !isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受配置了栅栏的本机回环请求' }); return }
        if (typeof fence === 'function') {
          const code = fence(req)
          if (code !== undefined && code !== null && code !== false) {
            json(res, typeof code === 'number' ? code : 403, { ok: false, error: '拒绝访问：只接受本机回环' })
            return
          }
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (!url.pathname.startsWith(PREFIX)) { json(res, 404, { ok: false, error: 'not found' }); return }

        // UI-only switch endpoint: same-origin browser fetch, no owner token exposed.
        // The existing token-protected API remains unchanged for other callers.
        if (url.pathname === PREFIX + '/settings-ui') {
          const expectedOrigin = `http://${req.headers.host}`
          if (req.headers['sec-fetch-site'] !== 'same-origin' || (req.method !== 'GET' && req.headers.origin !== expectedOrigin)) { json(res, 403, {ok:false,error:'只允许 DSH 同源设置界面'}); return }
          if (req.method === 'GET') {
            const db=store.read()
            const proactive=proactiveStatus(store)
            json(res,200,{ok:true,cleanFrames:db.whaleMedia?.cleanFrames!==false,cleanVideos:db.whaleMedia?.cleanVideos!==false,proactive:proactive.enabled,autoMemory:db.autoMemory?.enabled===true,qqOwner:ownerStatus(store.home),shareNotice:proactive.lastAttempt?.status==='failed' ? proactive.lastAttempt.reason : null})
            return
          }
          if (req.method !== 'POST') { json(res,405,{ok:false,error:'请求方式无效'}); return }
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { json(res,415,{ok:false,error:'需要 JSON 请求'}); return }
          const body=await readBody(req,4096)
          if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'enabled,setting' || typeof body.enabled!=='boolean' || !['cleanFrames','cleanVideos','proactive','autoMemory'].includes(body.setting)) { json(res,400,{ok:false,error:'设置无效'}); return }
          if (body.setting==='proactive') {
            configureProactive(store,{enabled:body.enabled})
            if (body.enabled) store.tx(db=>{db.proactiveSharing.transport ??= 'active'})
          }
          else if (body.setting==='autoMemory') configureAutoMemory(store,body.enabled)
          else store.tx(db=>{db.whaleMedia={...(db.whaleMedia??{}),[body.setting]:body.enabled};store._auditInto(db,{actor:'owner:settings',action:'whale-media:'+body.setting,detail:String(body.enabled)})})
          json(res,200,{ok:true,setting:body.setting,enabled:body.enabled})
          return
        }

        if (url.pathname === PREFIX + '/settings-setup') {
          if (req.method!=='POST' || req.headers['sec-fetch-site']!=='same-origin' || req.headers.origin!==`http://${req.headers.host}`) { json(res,403,{ok:false,error:'只允许 DSH 同源设置界面'}); return }
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { json(res,415,{ok:false,error:'需要 JSON 请求'}); return }
          const body=await readBody(req,1024)
          if (!body || Object.keys(body).join(',')!=='action' || !['pair','activate','profile','documents'].includes(body.action)) { json(res,400,{ok:false,error:'设置无效'}); return }
          if (body.action==='pair') {
            const result=prepareOwnerPairing(store.home)
            const code=fs.readFileSync(result.codeFile,'utf8').match(/FISH-[A-F0-9]{16}/)?.[0]
            if (!code) throw new Error('无法生成配对码')
            json(res,200,{ok:true,code,expiresAt:result.expiresAt});return
          }
          if (body.action==='activate') {
            const state=JSON.parse(fs.readFileSync(path.join(store.home,'qq-owner.json'),'utf8'))
            const prefsFile=path.join(os.homedir(),'.dsh-qqbot','model-prefs.json')
            let prefs={};try{prefs=JSON.parse(fs.readFileSync(prefsFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
            bindLearning(store,'session:'+verifiedQQSession(state,prefs),'owner')
            json(res,200,{ok:true});return
          }
          if (body.action==='profile') linkWhaleProfile(store)
          else linkWhaleDocuments(store)
          json(res,200,{ok:true});return
        }

        const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname))
        if (!route) { json(res, 404, { ok: false, error: '接口不存在：' + req.method + ' ' + url.pathname }); return }

        // ② 认证（health 公开，但也只在本机回环）
        let auth = null
        if (route.scope !== null) {
          const token = tokenFromRequest(req, url)
          auth = store.authenticate(token)
          if (!auth) {
            store.audit({ actor: 'http', action: 'auth:deny', target: url.pathname, detail: token ? 'token 无效' : '未带令牌' })
            json(res, 401, { ok: false, error: '需要有效令牌：使用 x-pond-key 或 Authorization 请求头' })
            return
          }
          // ③ 限流
          if (rateLimited(auth, res)) return
          // ④ scope
          if ((route.scope === 'admin' && auth.kind !== 'owner') || !allows(auth.scopes, route.scope)) {
            store.audit({ actor: 'http', channel: auth.channel?.name ?? '', action: 'auth:scope-deny', target: url.pathname, detail: `需要 ${route.scope}` })
            json(res, 403, { ok: false, error: `渠道「${auth.channel?.name}」没有 ${route.scope} 权限（当前：${(auth.scopes ?? []).join(',') || '无'}）` })
            return
          }
          if (auth.kind === 'channel') store.channelTouch(auth.channel.id)
        }

        const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {}
        const client = auth?.kind === 'channel' ? scopedStore(store, { principal: 'channel:' + auth.channel.id, scopes: auth.scopes }) : store
        const result = await route.handler({ auth, body, url, client, canSeePrivate: auth?.kind === 'owner' })
        if (auth?.kind === 'owner' && req.method === 'GET') store.audit({ actor: 'owner:http', action: 'http:read', target: url.pathname.split('/').slice(0, 4).join('/') })
        json(res, 200, result)
      } catch (e) {
        const status = e?.status ?? 500
        try { json(res, status, { ok: false, error: status >= 500 || isSensitive(e?.message) ? '操作失败，未返回内部信息' : String(e?.message ?? e).slice(0, 200) }) } catch {}
      }
    },
  }
}
