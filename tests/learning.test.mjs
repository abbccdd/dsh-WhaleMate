import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { createPondTool } from '../lib/tool.mjs'
import { bindLearning, importWhaleReports, observeExplicitPreferenceEvent, observeHypothesisContext } from '../lib/memory.mjs'
import { ALL_SCOPES } from '../lib/security.mjs'
import { runAction } from '../lib/actions.mjs'

function fixture() {
  const p = Pond.open(fs.mkdtempSync(path.join(os.tmpdir(), 'pond-learning-')))
  p.init()
  const t = createPondTool(p)
  const call = (id, args) => t.execute(args, { agent: { session: { id } } })
  return { p, call }
}
function say(p, id, seq, text) { return observeExplicitPreferenceEvent(p, { id }, { type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }) }

test('记忆默认拒绝，身份来自宿主，不能用参数冒充', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  const r = await call('public', { action: 'memory_recall', principal: 'session:owner', channel: 'owner' })
  assert.equal(r.ok, false)
  assert.match(r.error, /未获/)
  assert.equal((await createPondTool(p).execute({ action: 'memory_recall' }, {})).ok, false)
  assert.equal(runAction(p, { action: 'memory_recall' }, { identity: { principal: 'session:owner', scopes: [] } }).ok, false)
})

test('真实会话授权后学习、看视频、重启后读回和纠正；公开会话不能读取', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  bindLearning(p, 'session:bili-whale', 'watcher')
  assert.equal((await call('owner', { action: 'learn_preference', topic: 'short-drama', signal: 'like' })).ok, false)
  say(p, 'owner', 1, '我喜欢短剧')
  assert.equal((await call('bili-whale', { action: 'remember_video', bvid: 'BV1xx411c7mD', rating: 'worthwhile' })).ok, true)
  const reopened = createPondTool(Pond.open(p.home))
  const r = await reopened.execute({ action: 'memory_recall' }, { agent: { session: { id: 'owner' } } })
  assert.equal(r.preferences[0].signal, 'like')
  assert.equal(r.videos[0].bvid, 'BV1xx411c7mD')
  assert.equal((await call('public', { action: 'memory_recall' })).ok, false)
  assert.equal((await call('bili-whale', { action: 'learn_preference', topic: 'short-drama', signal: 'avoid' })).ok, false)
  assert.equal((await call('owner', { action: 'remember_video', bvid: 'BV1xx411c7mD', rating: 'skip' })).ok, false)
  say(p, 'owner', 2, '我不喜欢短剧')
  assert.equal((await call('owner', { action: 'memory_recall' })).preferences[0].signal, 'avoid')
  await call('owner', { action: 'memory_forget', topic: 'short-drama' })
  assert.equal((await call('owner', { action: 'memory_recall' })).preferences.length, 0)
  bindLearning(p, 'session:owner', 'remove')
  assert.equal((await call('owner', { action: 'memory_recall' })).ok, false)
})

test('最新的详细或简短、正式或随意偏好会替换相反的旧偏好', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  say(p, 'owner', 1, '我喜欢简洁回答')
  say(p, 'owner', 2, '我喜欢详细回答')
  say(p, 'owner', 3, '我喜欢正式聊天')
  say(p, 'owner', 4, '我喜欢随意聊天')
  const preferences = (await call('owner', { action: 'memory_recall' })).preferences
  assert.deepEqual(preferences.map(p => p.topic), ['casual', 'detailed'])
})

test('只有主人直接明确的类别偏好能记录，普通好评和非主人消息不会泛化', async () => {
  const { p, call } = fixture(); bindLearning(p, 'session:owner', 'owner'); bindLearning(p, 'session:bili-whale', 'watcher')
  say(p, 'owner', 1, '这条不错')
  say(p, 'bili-whale', 2, '我喜欢短剧')
  say(p, 'owner', 3, '你说“我喜欢短剧”')
  assert.equal((await call('owner', { action: 'memory_recall' })).preferences.length, 0)
  assert.equal((await call('owner', { action: 'learn_preference', topic: 'short-drama', signal: 'like' })).ok, false)
  say(p, 'owner', 4, '我喜欢短剧'); say(p, 'owner', 4, '我喜欢短剧')
  assert.equal((await call('owner', { action: 'memory_recall' })).preferences[0].observations, 1)
  assert.equal((await call('bili-whale', { action: 'memory_recall' })).preferences.length, 0)
})

test('语义推测只与当前可信主人消息关联，弱置信、可遗忘且不给刷站会话', async () => {
  const { p, call } = fixture(); bindLearning(p, 'session:owner', 'owner'); bindLearning(p, 'session:bili-whale', 'watcher')
  const event = (seq, text) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  assert.equal((await call('owner', { action: 'learn_hypothesis', topic: 'animation', signal: 'like' })).ok, false)
  observeHypothesisContext(p, { id: 'owner' }, event(1, '这条不错'))
  assert.equal((await call('owner', { action: 'learn_hypothesis', topic: 'animation', signal: 'like' })).ok, false)
  observeHypothesisContext(p, { id: 'owner' }, event(2, '最近睡前看动画感觉很放松'))
  const result = await call('owner', { action: 'learn_hypothesis', topic: 'animation', signal: 'like' })
  assert.equal(result.ok, true); assert.equal(result.hypothesis.confidence, 0.2)
  assert.equal((await call('owner', { action: 'learn_hypothesis', topic: 'animation', signal: 'like' })).ok, false)
  assert.equal((await call('bili-whale', { action: 'memory_recall' })).hypotheses.length, 0)
  assert.equal((await call('owner', { action: 'memory_recall' })).hypotheses[0].provenance, 'model-hypothesis')
  assert.ok(!fs.readFileSync(p.file, 'utf8').includes('睡前看动画'))
  await call('owner', { action: 'memory_forget', topic: 'animation' })
  assert.equal((await call('owner', { action: 'memory_recall' })).hypotheses.length, 0)
  observeHypothesisContext(p, { id: 'owner' }, event(3, '我家密码是123456'))
  assert.equal((await call('owner', { action: 'learn_hypothesis', topic: 'animation', signal: 'like' })).ok, false)
})

test('任意私聊文本、密码、伪造类别和 BV 不进入结构化记忆或回显', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  bindLearning(p, 'session:bili-whale', 'watcher')
  const secret = '家庭密码是蓝色河马1234'
  for (const input of [
    { action: 'learn_preference', topic: secret, signal: 'like' },
    { action: 'learn_preference', topic: 'comedy', signal: secret },
    { action: 'remember_video', bvid: secret, rating: 'skip' },
    { action: 'memory_recall', bvid: secret },
  ]) {
    const response = await call(input.action === 'remember_video' ? 'bili-whale' : 'owner', input)
    assert.equal(response.ok, false)
    assert.ok(!JSON.stringify(response).includes(secret))
  }
  const r = await call('owner', { action: 'learn_preference', topic: 'comedy', signal: 'like', text: secret })
  assert.equal(r.ok, false)
  assert.ok(!JSON.stringify(r).includes(secret))
  assert.ok(!fs.readFileSync(p.file, 'utf8').includes(secret))
  assert.ok(!JSON.stringify(await call('public', { action: 'memory_recall' })).includes(secret))
})

test('长期记录可分页、指定 BV 查询；清空不会留下记忆或授权', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  bindLearning(p, 'session:bili-whale', 'watcher')
  p.tx(db => {
    for (let i = 0; i < 101; i++) {
      const bvid = 'BV' + String(i).padStart(10, '0')
      db.learning.videos[bvid] = { bvid, rating: 'maybe', firstRecordedAt: '2026-01-01', updatedAt: '2026-01-01' }
    }
  })
  const first = await call('owner', { action: 'memory_recall' })
  assert.equal(first.totalVideos, 101)
  assert.equal(first.videos.length, 100)
  assert.equal(first.nextOffset, 100)
  assert.equal((await call('owner', { action: 'memory_recall', offset: 100 })).videos.length, 1)
  assert.equal((await call('owner', { action: 'memory_recall', bvid: 'BV0000000100' })).videos.length, 1)
  p.wipe()
  assert.equal((await call('owner', { action: 'memory_recall' })).ok, false)
  assert.deepEqual(p.read().learning, { bindings: {}, preferences: {}, videos: {}, forgottenVideos: {} })
})

test('导入 whale 报告只提取 BV 标题，不保存报告正文，重复导入幂等', async () => {
  const { p, call } = fixture()
  bindLearning(p, 'session:owner', 'owner')
  const reports = path.join(p.home, 'reports')
  fs.mkdirSync(reports)
  fs.writeFileSync(path.join(reports, '2026-10-28.md'), '# 报告\n### BV1xx411c7mD\n家庭密码是蓝色河马1234\n### BV1xx411c7mD\n')
  fs.writeFileSync(path.join(reports, 'other.md'), '### BV0000000001\n')
  assert.deepEqual(importWhaleReports(p, reports), { ok: true, reports: 1, found: 1, added: 1 })
  assert.equal(importWhaleReports(p, reports).added, 0)
  assert.equal((await call('owner', { action: 'memory_recall' })).videos[0].provenance, 'whale-report-heading')
  assert.ok(!fs.readFileSync(p.file, 'utf8').includes('蓝色河马'))
  await call('owner', { action: 'memory_forget', bvid: 'BV1xx411c7mD' })
  assert.equal(importWhaleReports(p, reports).added, 0)
  assert.equal((await call('owner', { action: 'memory_recall' })).videos.length, 0)
  bindLearning(p, 'session:bili-whale', 'watcher')
  assert.equal((await call('bili-whale', { action: 'remember_video', bvid: 'BV1xx411c7mD', rating: 'maybe' })).ok, false)
})

test('MCP 同时要求令牌 scope 与本机身份绑定，撤销授权立即生效', () => {
  const { p } = fixture()
  const qq = p.channelAdd({ name: 'qq-learning', scopes: ['learning:access'] })
  const other = p.channelAdd({ name: 'other-learning', scopes: ['learning:access'] })
  const principal = 'channel:' + qq.channel.id
  bindLearning(p, principal, 'owner')
  const call = (token, args) => {
    const output = execFileSync(process.execPath, [path.resolve('tools/pond-mcp.mjs')], { windowsHide: true, encoding: 'utf8', env: { ...process.env, POND_HOME: p.home, POND_TOKEN: token }, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pond', arguments: args } }) + '\n' })
    return JSON.parse(JSON.parse(output).result.content[0].text)
  }
  assert.equal(call(qq.token, { action: 'learn_preference', topic: 'comedy', signal: 'like' }).ok, false)
  assert.equal(call(qq.token, { action: 'memory_recall' }).preferences.length, 0)
  assert.equal(call(other.token, { action: 'memory_recall' }).ok, false)
  bindLearning(p, principal, 'remove')
  assert.equal(call(qq.token, { action: 'memory_recall' }).ok, false)
})
