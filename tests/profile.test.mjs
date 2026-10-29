import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { linkWhaleProfile, readSharedProfile, sharedProfileStatus, unlinkSharedProfile } from '../lib/profile.mjs'
import { createPondTool } from '../lib/tool.mjs'
import { createPondApi } from '../lib/api.mjs'
import { makeFence } from '../lib/host-compat.mjs'
import { buildWakeText } from '../lib/bridge.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { assembleOwnerContext } from '../lib/owner-context.mjs'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-profile-'))
  const p = Pond.open(home)
  p.init()
  const sources = Object.fromEntries(['config', 'persona', 'prefs'].map(key => [key, path.join(home, key + (key === 'persona' ? '.md' : '.json'))]))
  fs.writeFileSync(sources.config, JSON.stringify({ persona: { name: '鲸鱼测试', selfClaim: '我', ownerTitle: '私人姓名' }, preferences: { like: ['沙雕短剧'], dislike: ['带货'] }, owner: { mid: '123456', name: '私人姓名' }, notify: { url: 'https://example.invalid/private-hook' }, quota: { shareDaily: 999 } }))
  fs.writeFileSync(sources.persona, '# 鲸鱼测试\n\n一条好奇的小鲸鱼。\n\n## 性格和说话\n自然、简洁，有自己的判断。\n\n## 我刷 B 站时\n喜欢有反转的剧情。\n\n## 日记和给主人说的话\n家庭密码是 998877。\n\n## 边界\n本地账号关联和私人收信人。')
  fs.writeFileSync(sources.prefs, JSON.stringify({ keywords: ['反转 剧情'], cookie: 'private-cookie', minPlay: 10 }))
  return { p, home, sources }
}

test('仅已绑定主人会话自动加载批准的人设，不注入私人资料或未授权更改', async () => {
  const { p, sources } = fixture()
  linkWhaleProfile(p, sources)
  bindLearning(p, 'session:qq-owner', 'owner')
  bindLearning(p, 'session:whale', 'watcher')
  const original = { sections: [{ name: 'base', text: 'base' }] }
  const next = async () => original
  const context = id => ({ agent: { session: { id } } })
  const injected = await assembleOwnerContext(p, context('qq-owner'), next)
  assert.equal(injected.sections.length, 3)
  assert.match(injected.sections[1].text, /鲸鱼测试|自然、简洁/)
  assert.doesNotMatch(injected.sections[1].text, /沙雕短剧|反转 剧情|喜欢有反转的剧情/)
  assert.match(injected.sections[1].text, /虚构的语气示例/)
  assert.match(injected.sections[2].text, /角色性格、刷站选题和主人私聊偏好分开/)
  p.tx(db => { db.sharedVideoDiary = { pending: { 'session:qq-owner': 'event1' }, entries: [{ eventHash: 'event1', bvid: 'BV1vJnN64E8Q' }] } })
  const videoContext = await assembleOwnerContext(p, context('qq-owner'), next)
  assert.match(videoContext.sections.at(-1).text, /video_material.*BV1vJnN64E8Q/)
  assert.doesNotMatch(injected.sections[1].text, /998877|私人姓名|private-cookie/)
  assert.deepEqual(await assembleOwnerContext(p, context('whale'), next), original)
  assert.deepEqual(await assembleOwnerContext(p, context('other'), next), original)
  fs.appendFileSync(sources.persona, '\n## 性格和说话\n未批准的新性格')
  assert.deepEqual(await assembleOwnerContext(p, context('qq-owner'), next), original)
})

test('独立读取原始文件的白名单字段，不复制私人配置、人设日记或凭据', () => {
  const { p, sources } = fixture()
  const before = Object.values(sources).map(file => fs.readFileSync(file, 'utf8'))
  linkWhaleProfile(p, sources)
  const result = readSharedProfile(p)
  assert.equal(result.data.persona.name, '鲸鱼测试')
  assert.equal(result.data.persona.voice, '自然、简洁，有自己的判断。')
  assert.deepEqual(result.data.preferences.like, ['沙雕短剧'])
  assert.deepEqual(result.data.bilibili.keywords, ['反转 剧情'])
  assert.doesNotMatch(JSON.stringify(result), /998877|私人姓名|private-cookie|private-hook|123456|shareDaily|ownerTitle/)
  assert.doesNotMatch(JSON.stringify(result), /[A-Za-z]:\\|sources|approvedHash/)
  assert.doesNotMatch(JSON.stringify(p.read()), /一条好奇的小鲸鱼|沙雕短剧|998877|private-cookie/)
  assert.deepEqual(Object.values(sources).map(file => fs.readFileSync(file, 'utf8')), before)
})

test('公共字段变化需要重新授权；不使用旧副本；原文件仍是唯一资料来源', () => {
  const { p, sources } = fixture()
  linkWhaleProfile(p, sources)
  const cfg = JSON.parse(fs.readFileSync(sources.config, 'utf8'))
  cfg.preferences.like = ['新的公共兴趣']
  fs.writeFileSync(sources.config, JSON.stringify(cfg))
  assert.equal(sharedProfileStatus(p).state, 'approval-required')
  assert.throws(() => readSharedProfile(p), /重新授权/)
  linkWhaleProfile(p, sources)
  assert.deepEqual(readSharedProfile(p).data.preferences.like, ['新的公共兴趣'])
})

test('修改未共享的账号/通知配置不影响公共资料，也不扩展共享范围', () => {
  const { p, sources } = fixture()
  linkWhaleProfile(p, sources)
  const revision = readSharedProfile(p).revision
  const cfg = JSON.parse(fs.readFileSync(sources.config, 'utf8'))
  cfg.owner.name = '另一个私人名字'
  cfg.notify.url = 'https://example.invalid/another-hook'
  cfg.persona.password = '998877'
  fs.writeFileSync(sources.config, JSON.stringify(cfg))
  const result = readSharedProfile(p)
  assert.equal(result.revision, revision)
  assert.doesNotMatch(JSON.stringify(result), /另一个私人名字|another-hook|998877/)
})

test('被选公共字段出现密码或本机路径时停止共享，不能通过重新授权绕过', () => {
  const { p, sources } = fixture()
  linkWhaleProfile(p, sources)
  const original = fs.readFileSync(sources.persona, 'utf8')
  for (const added of ['家庭密码 998877', '本机目录 C:\\Users\\example']) {
    fs.writeFileSync(sources.persona, original.replace('自然、简洁，有自己的判断。', added))
    assert.throws(() => readSharedProfile(p), /敏感内容或本机路径/)
    assert.throws(() => linkWhaleProfile(p, sources), /敏感内容或本机路径/)
  }
})

test('缺失/损坏的来源停止共享；显式撤销后没有隐式回退', () => {
  const { p, sources } = fixture()
  assert.equal(readSharedProfile(p, { optional: true }), null)
  linkWhaleProfile(p, sources)
  fs.writeFileSync(sources.prefs, '{broken')
  assert.throws(() => readSharedProfile(p), /格式无效/)
  assert.equal(sharedProfileStatus(p).state, 'blocked')
  unlinkSharedProfile(p)
  assert.equal(sharedProfileStatus(p).configured, false)
  assert.throws(() => readSharedProfile(p), /尚未授权/)
})

test('DSH/MCP/HTTP 共用同一公共角色，独立 profile:read scope 不授予私聊读取', async () => {
  const { p, home, sources } = fixture()
  linkWhaleProfile(p, sources)
  const channel = p.channelAdd({ name: 'profile-reader', scopes: ['profile:read'] })
  const noAccess = p.channelAdd({ name: 'item-reader', scopes: ['items:read'] })
  const native = await createPondTool(p).execute({ action: 'profile' }, { agent: { session: { id: 'qq' } } })
  assert.equal(native.ok, true)
  const api = createPondApi({ store: p, fence: makeFence({ connection: { rpc: { handle() {} } } }) })
  async function get(route, token) {
    const request = new PassThrough()
    Object.assign(request, { method: 'GET', url: '/dsh-pond/api' + route, headers: { host: 'localhost:3080', 'x-pond-key': token }, socket: { remoteAddress: '127.0.0.1' } })
    let status, result
    await api.handle(request, { writeHead(code) { status = code }, end(raw) { result = JSON.parse(raw) } })
    return { status, result }
  }
  assert.equal((await get('/profile', noAccess.token)).status, 403)
  const http = await get('/profile', channel.token)
  assert.equal(http.status, 200)
  assert.deepEqual(http.result.profile.data, native.profile.data)
  assert.equal((await get('/items', channel.token)).status, 403)
  assert.equal((await get('/profile?id=../../credentials.json', channel.token)).status, 404)
  const output = execFileSync(process.execPath, [path.resolve('tools/pond-mcp.mjs')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, POND_HOME: home, POND_TOKEN: channel.token }, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pond', arguments: { action: 'profile' } } }) + '\n' })
  const mcp = JSON.parse(JSON.parse(output).result.content[0].text)
  assert.deepEqual(mcp.profile.data, native.profile.data)
  assert.match(native.profile.usage, /保留本会话明确指定的角色卡/)
})

test('CLI 可独立连接/检查/读取/撤销，不导入或启动 whale 包', () => {
  const { p, home, sources } = fixture()
  const cli = args => JSON.parse(execFileSync(process.execPath, [path.resolve('tools/pond.mjs'), ...args], { windowsHide: true, encoding: 'utf8', env: { ...process.env, POND_HOME: home } }))
  const result = cli(['profile', 'link-whale', '--config', sources.config, '--persona', sources.persona, '--prefs', sources.prefs])
  assert.equal(result.id, 'deepseek')
  assert.equal(cli(['profile', 'status']).state, 'ready')
  assert.equal(cli(['profile', 'show']).profile.data.persona.name, '鲸鱼测试')
  assert.equal(cli(['profile', 'unlink']).revoked, true)
  assert.equal(sharedProfileStatus(p).configured, false)
})

test('桥携带批准的公共资料，平台任务不能通过人设获得发送授权', () => {
  const { p, sources } = fixture()
  linkWhaleProfile(p, sources)
  const profile = readSharedProfile(p)
  const wake = buildWakeText({ id: 'cmd_1', action: 'watch', args: { bvid: 'BV1x' } }, profile)
  assert.match(wake, /鲸鱼测试/)
  assert.match(wake, /不得自行调用/)
  assert.doesNotMatch(wake, /998877|private-cookie|私人姓名/)
})
