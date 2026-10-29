import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { createPondApi } from '../lib/api.mjs'
import { makeFence } from '../lib/host-compat.mjs'
import { createOwnerGuard } from '../vendor/tencent-dsh-qqbot-owner/dist/owner-guard.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pond-api-'))
}

async function setup({ fence = makeFence({ connection: { rpc: { handle() {} } } }) } = {}) {
  const store = Pond.open(tempHome())
  store.init()
  const owner = store.ownerToken()
  const api = createPondApi({ store, fence })
  const srv = http.createServer((req, res) => api.handle(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const base = `http://127.0.0.1:${port}`
  return { store, owner, api, base, close: () => new Promise((r) => srv.close(r)) }
}

const j = (url, opts = {}, token) => fetch(url, {
  ...opts,
  headers: {
    'content-type': 'application/json',
    ...(token ? { 'x-pond-key': token } : {}),
    ...(opts.headers ?? {}),
  },
})

test('health 公开；数据接口无令牌 = 401', async () => {
  const t = await setup()
  try {
    const h = await j(t.base + '/dsh-pond/api/health')
    assert.equal(h.status, 200)
    assert.equal((await h.json()).app, 'dsh-pond')
    const items = await j(t.base + '/dsh-pond/api/items')
    assert.equal(items.status, 401)
    const bad = await j(t.base + '/dsh-pond/api/items', {}, 'dp_nope')
    assert.equal(bad.status, 401)
  } finally { await t.close() }
})

test('设置界面只接受同源浏览器请求，开关不授予令牌或一般管理权限', async () => {
  const t=await setup(), url=t.base+'/dsh-pond/api/settings-ui'
  try {
    assert.equal((await j(url)).status,403)
    assert.equal((await j(url,{headers:{'sec-fetch-site':'cross-site',origin:'https://evil.example'}})).status,403)
    const same={'sec-fetch-site':'same-origin',origin:t.base}
    const get=await j(url,{headers:same});assert.equal(get.status,200)
    const data=await get.json();assert.equal(data.cleanFrames,true);assert.equal(data.cleanVideos,true);assert.ok(!JSON.stringify(data).includes(t.owner))
    assert.equal((await j(url,{method:'POST',headers:{'sec-fetch-site':'same-origin',origin:'https://evil.example'},body:JSON.stringify({setting:'cleanVideos',enabled:false})})).status,403)
    assert.equal((await j(url,{method:'POST',headers:same,body:JSON.stringify({setting:'cleanVideos',enabled:false,other:true})})).status,400)
    const set=await j(url,{method:'POST',headers:same,body:JSON.stringify({setting:'cleanVideos',enabled:false})});assert.equal(set.status,200)
    assert.equal((await (await j(url,{headers:same})).json()).cleanVideos,false)
    for (const setting of ['cleanFrames','proactive']) {
      for (const enabled of [true,false]) {
        const response=await j(url,{method:'POST',headers:same,body:JSON.stringify({setting,enabled})})
        assert.equal(response.status,200);assert.equal((await (await j(url,{headers:same})).json())[setting],enabled)
      }
    }
    assert.equal((await j(t.base+'/dsh-pond/api/export',{headers:same})).status,401)
  } finally {await t.close()}
})

test('仅同源设置页能完成 QQ 主人配对，不接受其他会话冒充', async () => {
  const t=await setup(),url=t.base+'/dsh-pond/api/settings-setup',same={'sec-fetch-site':'same-origin',origin:t.base}
  try {
    assert.equal((await j(url,{method:'POST',body:JSON.stringify({action:'pair'})})).status,403)
    const pair=await (await j(url,{method:'POST',headers:same,body:JSON.stringify({action:'pair'})})).json()
    assert.match(pair.code,/^FISH-[A-F0-9]{16}$/)
    const guard=createOwnerGuard({home:t.store.home,appId:'test-app'})
    await guard.inbound({message:{kind:'c2c',senderId:'owner-only',content:pair.code}},()=>{})
    assert.equal((await j(url,{method:'POST',headers:same,body:JSON.stringify({action:'activate'})})).status,200)
    assert.equal(guard.allowed({scope:'c2c',targetId:'owner-only'}),true)
    assert.equal(guard.allowed({scope:'c2c',targetId:'other'}),false)
    assert.equal(Object.values(t.store.read().learning.bindings).filter(x=>x==='owner').length,1)
  } finally {await t.close()}
})

test('owner 令牌：写入 / 读取 / 判重', async () => {
  const t = await setup()
  try {
    const a = await j(t.base + '/dsh-pond/api/items', { method: 'POST', body: JSON.stringify({ kind: 'video', source: 'bili', bvid: 'BV1api', title: '来自微信的转发', dedupe: true }) }, t.owner)
    assert.equal(a.status, 200)
    const aJson = await a.json()
    assert.equal(aJson.dup, false)
    assert.equal(aJson.item.fromChannel, 'http')

    const b = await j(t.base + '/dsh-pond/api/items', { method: 'POST', body: JSON.stringify({ kind: 'video', source: 'bili', bvid: 'BV1api', dedupe: true }) }, t.owner)
    assert.equal((await b.json()).dup, true)

    const list = await j(t.base + '/dsh-pond/api/items?status=queued', {}, t.owner)
    const listJson = await list.json()
    assert.equal(listJson.total, 1)
    assert.equal(listJson.items[0].bvid, 'BV1api')
  } finally { await t.close() }
})

test('渠道令牌：scope 最小权限', async () => {
  const t = await setup()
  try {
    // qq 渠道：can write commands, cannot write items
    const qq = t.store.channelAdd({ name: 'qq', kind: 'qq' }) // commands:write, items:read, kv:read
    const denied = await j(t.base + '/dsh-pond/api/items', { method: 'POST', body: JSON.stringify({ text: 'x' }) }, qq.token)
    assert.equal(denied.status, 403)
    // 可以排队指令
    const cmd = await j(t.base + '/dsh-pond/api/commands', { method: 'POST', body: JSON.stringify({ action: 'watch', args: { bvid: 'BV1qq' } }) }, qq.token)
    assert.equal(cmd.status, 200)
    const cmdJson = await cmd.json()
    assert.equal(cmdJson.command.channel, 'channel:' + qq.channel.id)
    // 可以读条目
    const list = await j(t.base + '/dsh-pond/api/items', {}, qq.token)
    assert.equal(list.status, 200)
    // 不能管理渠道
    const admin = await j(t.base + '/dsh-pond/api/channels', {}, qq.token)
    assert.equal(admin.status, 403)

    // wechat 渠道：items:write
    const wx = t.store.channelAdd({ name: 'wechat', kind: 'wechat' })
    const ingest = await j(t.base + '/dsh-pond/api/items', { method: 'POST', body: JSON.stringify({ kind: 'video', source: 'bili', bvid: 'BV1wx', title: '微信转发' }) }, wx.token)
    assert.equal(ingest.status, 200)
    const ingestJson = await ingest.json()
    assert.equal(ingestJson.item.fromChannel, 'channel:' + wx.channel.id)
  } finally { await t.close() }
})

test('私密条目：渠道读不到，owner 读得到', async () => {
  const t = await setup()
  try {
    t.store.tx(db => db.items.push({ id: 'legacy-private', source: 'qq', text: '旧私密内容', private: true, status: 'queued', createdAt: new Date().toISOString() }))
    const qq = t.store.channelAdd({ name: 'qq2', kind: 'qq' })
    const chList = await (await j(t.base + '/dsh-pond/api/items', {}, qq.token)).json()
    assert.equal(chList.total, 0)
    const ownList = await (await j(t.base + '/dsh-pond/api/items', {}, t.owner)).json()
    assert.equal(ownList.total, 1)
  } finally { await t.close() }
})

test('KV / seen / 指令生命周期', async () => {
  const t = await setup()
  try {
    const put = await j(t.base + '/dsh-pond/api/kv/last-report', { method: 'PUT', body: JSON.stringify({ value: { n: 2 } }) }, t.owner)
    assert.equal(put.status, 200)
    const get = await (await j(t.base + '/dsh-pond/api/kv/last-report', {}, t.owner)).json()
    assert.deepEqual(get.value, { n: 2 })

    const seen1 = await (await j(t.base + '/dsh-pond/api/seen', { method: 'POST', body: JSON.stringify({ key: 'BV1seen' }) }, t.owner)).json()
    assert.equal(seen1.added, true)
    const seen2 = await (await j(t.base + '/dsh-pond/api/seen', { method: 'POST', body: JSON.stringify({ key: 'BV1seen' }) }, t.owner)).json()
    assert.equal(seen2.added, false)

    const c = await (await j(t.base + '/dsh-pond/api/commands', { method: 'POST', body: JSON.stringify({ action: 'watch', user: '主人' }) }, t.owner)).json()
    const id = c.command.id
    const started = await (await j(`${t.base}/dsh-pond/api/commands/${id}/start`, { method: 'POST' }, t.owner)).json()
    assert.equal(started.command.status, 'started')
    const done = await (await j(`${t.base}/dsh-pond/api/commands/${id}/done`, { method: 'POST', body: JSON.stringify({ result: 'ok' }) }, t.owner)).json()
    assert.equal(done.command.status, 'done')
  } finally { await t.close() }
})

test('管理面：清空需要确认；导出只给 owner', async () => {
  const t = await setup()
  try {
    const noConfirm = await j(t.base + '/dsh-pond/api/wipe', { method: 'POST', body: JSON.stringify({}) }, t.owner)
    assert.equal(noConfirm.status, 400)
    t.store.addItem({ text: 'x' })
    const wipe = await j(t.base + '/dsh-pond/api/wipe', { method: 'POST', body: JSON.stringify({ confirm: 'WIPE' }) }, t.owner)
    assert.equal(wipe.status, 200)
    assert.equal((await wipe.json()).wiped, true)
    assert.equal(t.store.stats().items, 0)
    const exp = await j(t.base + '/dsh-pond/api/export', {}, t.owner)
    assert.equal(exp.status, 200)
    assert.ok((await exp.json()).db.version === 1)
  } finally { await t.close() }
})

test('栅栏：fence 拒绝时全拒（fail-closed 语义）', async () => {
  const t = await setup({ fence: () => 403 })
  try {
    const h = await j(t.base + '/dsh-pond/api/health')
    assert.equal(h.status, 403)
    const items = await j(t.base + '/dsh-pond/api/items', {}, t.owner)
    assert.equal(items.status, 403)
  } finally { await t.close() }
})

test('未知路径 404；非法 JSON 400', async () => {
  const t = await setup()
  try {
    const nf = await j(t.base + '/dsh-pond/api/nope', {}, t.owner)
    assert.equal(nf.status, 404)
    const bad = await j(t.base + '/dsh-pond/api/items', { method: 'POST', body: '{bad json' }, t.owner)
    assert.equal(bad.status, 400)
  } finally { await t.close() }
})
