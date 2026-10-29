import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { createPondTool } from '../lib/tool.mjs'
import { createPondApi } from '../lib/api.mjs'
import { scopedStore } from '../lib/access.mjs'
import { ALL_SCOPES } from '../lib/security.mjs'
import { isSensitive, PRIVACY_PROMPT } from '../lib/privacy.mjs'
import { makeFence, isLoopbackReq, requestRejectionFor } from '../lib/host-compat.mjs'
import { startBridge } from '../lib/bridge.mjs'

const scopes = ALL_SCOPES.filter(s => s !== 'admin')
const fence = makeFence({ connection: { rpc: { handle() {} } } })
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-privacy-'))
  const p = Pond.open(home)
  p.init()
  const tool = createPondTool(p)
  return { p, home, run: (session, args) => tool.execute(args, { agent: { session: { id: session } } }) }
}
async function req(api, method, route, token, body, headers = {}) {
  const input = new PassThrough()
  Object.assign(input, { method, url: '/dsh-pond/api' + route, headers: { host: '127.0.0.1:3080', ...(token ? { 'x-pond-key': token } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } })
  let status, output
  const response = { writeHead(code) { status = code }, end(raw) { output = JSON.parse(raw) } }
  const task = api.handle(input, response)
  input.end(body === undefined ? '' : JSON.stringify(body))
  await task
  return { status, body: output }
}

test('内置提示词覆盖密码、跨平台、编码转写和忘记操作', () => {
  assert.match(PRIVACY_PROMPT, /密码/)
  assert.match(PRIVACY_PROMPT, /B站\/X/)
  assert.match(PRIVACY_PROMPT, /forget/)
  assert.match(PRIVACY_PROMPT, /编码/)
  for (const value of ['家庭密码是 891234', '门锁码 123456', { payload: { accessToken: 'example' } }, '手机号13800138000', 'sk-abcdefghijklmnopqrst', 'ＳＥＳＳＤＡＴＡ=example']) assert.equal(isSensitive(value), true)
  assert.equal(isSensitive({ bvid: 'BV1example', text: '今天看这个视频', private: false }), false)
})

test('QQ 密码与 private 内容不入库、不进入回显或审计', async () => {
  const { p, run } = fixture()
  for (const args of [
    { action: 'ingest', text: '家庭密码是 891234' },
    { action: 'ingest', text: 'sensitive-value', private: true },
    { action: 'command', commandAction: 'watch', commandArgs: { text: '门锁码 891234' } },
    { action: 'kv_set', key: 'setting', value: { password: '891234' } },
    { action: 'seen', key: 'BV1test', meta: { text: '密码 891234' } },
  ]) {
    const result = await run('qq', args)
    assert.equal(result.discarded, true)
    assert.doesNotMatch(JSON.stringify(result), /891234|sensitive-value/)
  }
  assert.equal(p.read().items.length, 0)
  assert.equal(p.read().commands.length, 0)
  assert.doesNotMatch(fs.readFileSync(p.file, 'utf8'), /891234|sensitive-value/)
  assert.equal((await run('bili', { action: 'next' })).item, null)
})

test('真实会话隔离；模型伪造 channel/principal/sharedWith 不扩大权限', async () => {
  const { p, run } = fixture()
  const own = await run('qq', { action: 'ingest', text: '普通私聊笔记', channel: 'bili', principal: 'session:bili', sharedWith: ['session:bili'] })
  assert.equal(own.item.principal, 'session:qq')
  assert.deepEqual(own.item.sharedWith, [])
  assert.equal((await run('qq', { action: 'get', id: own.item.id })).ok, true)
  assert.equal((await run('bili', { action: 'get', id: own.item.id })).ok, false)
  assert.equal((await run('bili', { action: 'list' })).total, 0)
  assert.equal((await run('bili', { action: 'next' })).item, null)
  assert.equal((await createPondTool(p).execute({ action: 'list', channel: 'qq' })).ok, false)
})

test('本机批准分享后才可跨会话读取；接收方不能改动原条目', async () => {
  const { p, run } = fixture()
  const { item } = await run('qq', { action: 'ingest', text: '可以分享的视频介绍' })
  p.share('items', item.id, ['session:bili'])
  assert.equal((await run('bili', { action: 'get', id: item.id })).item.text, item.text)
  assert.equal((await run('bili', { action: 'ack', id: item.id })).ok, false)
  p.share('items', item.id, ['session:wechat'])
  assert.equal((await run('bili', { action: 'get', id: item.id })).ok, false)
  p.share('items', item.id, [])
  assert.equal((await run('wechat', { action: 'get', id: item.id })).ok, false)
})

test('旧 private/敏感记录在 list/get/next/ack 均不可见，启动时清理', async () => {
  const { p, run } = fixture()
  p.tx(db => db.items.push({ id: 'legacy', principal: 'session:qq', sharedWith: ['session:bili'], private: true, text: 'old-sensitive-value', status: 'queued', createdAt: new Date().toISOString() }))
  for (const session of ['qq', 'bili']) {
    assert.equal((await run(session, { action: 'list' })).total, 0)
    assert.equal((await run(session, { action: 'get', id: 'legacy' })).ok, false)
    assert.equal((await run(session, { action: 'next' })).item, null)
    assert.equal((await run(session, { action: 'ack', id: 'legacy' })).ok, false)
  }
  assert.throws(() => p.share('items', 'legacy', ['session:bili']))
  const cleaned = p.init()
  assert.ok(cleaned.privacyCleanup.removed > 0)
  assert.doesNotMatch(fs.readFileSync(p.file, 'utf8'), /old-sensitive-value/)
})

test('渠道 HTTP 全路径隔离；已知 ID 和仅写权限也不能读取其他渠道', async () => {
  const { p } = fixture()
  const a = p.channelAdd({ name: 'a', scopes })
  const b = p.channelAdd({ name: 'b', scopes })
  const writer = p.channelAdd({ name: 'writer', scopes: ['items:write', 'commands:write'] })
  const api = createPondApi({ store: p, fence })
  const added = await req(api, 'POST', '/items', a.token, { text: '渠道 A 内容' })
  const id = added.body.item.id
  assert.equal((await req(api, 'GET', '/items/' + id, b.token)).status, 404)
  assert.equal((await req(api, 'GET', '/items', b.token)).body.total, 0)
  assert.equal((await req(api, 'POST', `/items/${id}/ack`, writer.token, {})).status, 404)
  const acked = await req(api, 'POST', `/items/${id}/ack`, a.token, {})
  assert.equal(acked.body.status, 'done')
  assert.equal(acked.body.item, undefined)
  const c = await req(api, 'POST', '/commands', a.token, { action: 'watch', args: { text: 'A 的任务' } })
  for (const method of ['start', 'done']) assert.equal((await req(api, 'POST', `/commands/${c.body.command.id}/${method}`, writer.token, {})).status, 404)
  assert.equal((await req(api, 'GET', '/commands', b.token)).body.total, 0)
})

test('KV/seen 按身份分区；只写 seen 不返回旧元数据', () => {
  const { p } = fixture()
  const qq = scopedStore(p, { principal: 'session:qq', scopes })
  const bili = scopedStore(p, { principal: 'session:bili', scopes })
  qq.kvSet('preferences', { theme: 'blue' })
  qq.seenAdd('BV1x', { note: 'QQ 独立记录' })
  assert.equal(bili.kvGet('preferences'), null)
  assert.deepEqual(bili.kvList(), [])
  assert.deepEqual(bili.seenCheck('BV1x'), { seen: false })
  const writer = scopedStore(p, { principal: 'session:qq', scopes: ['seen:write'] })
  assert.deepEqual(writer.seenAdd('BV1x'), { added: false })
})

test('成功读取有元数据审计，forget 不回显内容且不能删除别人的记录', async () => {
  const { p, run } = fixture()
  const { item } = await run('qq', { action: 'ingest', text: '不要写进审计的普通长正文' })
  const before = p.read().audit.length
  await run('qq', { action: 'get', id: item.id })
  assert.equal(p.read().audit.length, before + 1)
  assert.doesNotMatch(JSON.stringify(p.read().audit), /不要写进审计/)
  assert.equal((await run('bili', { action: 'forget', id: item.id })).ok, false)
  const forgotten = await run('qq', { action: 'forget', id: item.id })
  assert.equal(forgotten.forgotten, true)
  assert.doesNotMatch(JSON.stringify(forgotten), /不要写进审计/)
  assert.equal((await run('qq', { action: 'get', id: item.id })).ok, false)
  await run('qq', { action: 'kv_set', key: 'preferences', value: 'blue' })
  assert.equal((await run('qq', { action: 'forget', key: 'preferences' })).forgotten, true)
  const { command } = await run('qq', { action: 'command', commandAction: 'watch', commandArgs: { bvid: 'BV1x' } })
  assert.equal((await run('qq', { action: 'forget', id: command.id })).forgotten, true)
  assert.equal((await run('qq', { action: 'commands' })).total, 0)
})

test('所有存储入口同样拒绝敏感数据，私密字符串标记也不能绕过', () => {
  const { p } = fixture()
  assert.equal(p.addItem({ text: '家庭密码 891234' }).discarded, true)
  assert.equal(p.addItem({ text: 'opaque-value', private: 'true' }).discarded, true)
  assert.equal(p.addCommand({ args: { password: '891234' } }).discarded, true)
  assert.equal(p.kvSet('password', '891234').discarded, true)
  assert.equal(p.seenAdd('BV1x', { password: '891234' }).discarded, true)
  assert.doesNotMatch(fs.readFileSync(p.file, 'utf8'), /891234|opaque-value/)
})

test('回环栅栏检查真实 socket、IPv6、Origin、Host 和默认拒绝', async () => {
  const { p } = fixture()
  const request = { headers: { host: '[::1]:3080' }, socket: { remoteAddress: '::1' } }
  assert.equal(isLoopbackReq(request), true)
  assert.equal(requestRejectionFor({ rpc: { handle() {} } }, request), undefined)
  assert.equal(isLoopbackReq({ ...request, socket: { remoteAddress: '198.51.100.10' } }), false)
  assert.equal(requestRejectionFor({ requestRejection() {} }, { ...request, headers: { ...request.headers, origin: 'https://example.com' } }), 403)
  assert.equal(requestRejectionFor({ rpc: { handle() {} } }, { ...request, headers: { host: 'evil.example' } }), 403)
  assert.equal((await req(createPondApi({ store: p }), 'GET', '/health')).status, 403)
  const health = await req(createPondApi({ store: p, fence }), 'GET', '/health')
  assert.deepEqual(health.body, { ok: true, app: 'dsh-pond', version: 2, pluginVersion: '0.6.0' })
})

test('令牌不接受 URL 查询，不允许渠道通配/管理权限', async () => {
  const { p } = fixture()
  assert.throws(() => p.channelAdd({ name: 'star', scopes: ['*'] }))
  assert.throws(() => p.channelAdd({ name: 'admin', scopes: ['admin'] }))
  assert.throws(() => p.channelAdd({ name: 'unknown', scopes: ['unknown'] }))
  const api = createPondApi({ store: p, fence })
  assert.equal((await req(api, 'GET', '/items?key=' + p.ownerToken())).status, 401)
  assert.equal((await req(api, 'GET', '/items', null, undefined, { authorization: 'Bearer ' + p.ownerToken() })).status, 200)
})

test('MCP 无令牌、owner令牌、他渠道令牌均不能读 QQ 条目；轮换立即失效', async () => {
  const { p, home } = fixture()
  const qq = p.channelAdd({ name: 'qq-mcp', scopes })
  const bili = p.channelAdd({ name: 'bili-mcp', scopes })
  const id = scopedStore(p, { principal: 'channel:' + qq.channel.id, scopes }).addItem({ text: 'QQ 的普通笔记' }).item.id
  const call = token => {
    const stdout = execFileSync(process.execPath, [path.resolve('tools/pond-mcp.mjs')], { windowsHide: true, encoding: 'utf8', env: { ...process.env, POND_HOME: home, POND_TOKEN: token }, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pond', arguments: { action: 'get', id } } }) + '\n' })
    return JSON.parse(JSON.parse(stdout).result.content[0].text)
  }
  for (const token of ['', p.ownerToken(), bili.token]) assert.equal(call(token).ok, false)
  assert.equal(call(qq.token).item.id, id)
  p.channelRotate(qq.channel.id)
  assert.equal(call(qq.token).ok, false)
})

test('唤醒桥只能投递明确批准给目标会话的非私密任务', async () => {
  const { p, home } = fixture()
  fs.writeFileSync(path.join(home, 'pond.config.json'), JSON.stringify({ bridge: { enabled: true, sessionId: 'bili', actions: ['watch'] } }))
  const command = scopedStore(p, { principal: 'session:qq', scopes }).addCommand({ action: 'watch', args: { text: '分析 BV1x 的公开内容' } })
  const calls = []
  const bridge = startBridge({ store: p, home, controller: { async prompt(payload) { calls.push(payload) } } })
  try {
    await bridge.tick()
    assert.equal(calls.length, 0)
    p.share('commands', command.id, ['session:bili'])
    await bridge.tick()
    assert.equal(calls.length, 1)
    assert.match(calls[0].content[0].text, /不得自行调用/)
    assert.match(calls[0].content[0].text, /隐私规则/)
    assert.equal(p.read().commands[0].status, 'done')
  } finally { bridge.stop() }
})

test('唤醒桥遇到宿主错误时不把错误里的私聊正文写入日志或数据库', async () => {
  const { p, home } = fixture()
  fs.writeFileSync(path.join(home, 'pond.config.json'), JSON.stringify({ bridge: { enabled: true, sessionId: 'bili', actions: ['watch'] } }))
  const command = scopedStore(p, { principal: 'session:qq', scopes }).addCommand({ action: 'watch', args: { bvid: 'BV1xx411c7mD' } })
  p.share('commands', command.id, ['session:bili'])
  const secret = '蓝色河马是我的隐私内容'
  const logs = []
  const bridge = startBridge({ store: p, home, log: message => logs.push(message), controller: { async prompt() { throw new Error(secret) } } })
  try {
    await bridge.tick()
    assert.equal(p.read().commands[0].status, 'failed')
    assert.ok(!JSON.stringify(logs).includes(secret))
    assert.ok(!fs.readFileSync(p.file, 'utf8').includes(secret))
  } finally { bridge.stop() }
})

test('损坏数据或令牌文件报错并保留原文，不静默重建', () => {
  const { p } = fixture()
  for (const invalid of ['{broken', '42', '{"items":{}}']) {
    fs.writeFileSync(p.file, invalid)
    assert.throws(() => p.addItem({ text: 'new item' }), /读取失败/)
    assert.equal(fs.readFileSync(p.file, 'utf8'), invalid)
  }
  for (const invalid of ['{broken', '{}', '{"owner":"dp_short"}']) {
    fs.writeFileSync(p.keysFile, invalid)
    assert.throws(() => p.ensureOwnerToken(), /读取失败/)
    assert.equal(fs.readFileSync(p.keysFile, 'utf8'), invalid)
  }
})
