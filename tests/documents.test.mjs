import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { createPondTool } from '../lib/tool.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { linkWhaleDocuments, unlinkWhaleDocuments } from '../lib/documents.mjs'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-documents-'))
  const store = Pond.open(home)
  store.init()
  const reports = path.join(home, 'reports')
  const diary = path.join(home, 'diary.md')
  fs.mkdirSync(reports)
  fs.writeFileSync(path.join(reports, '2026-10-28.md'), '# 今日报告\n\n### BV1xx411c7mD\n- 标题：小剧场\n- 剧本 beat：转折\n\n密码是虚构的 123456\n\n### BV0000000001\n- 另一个故事\n')
  fs.writeFileSync(diary, '# 日记\n\n今天看到了有趣的故事。\n\n家庭密码：虚构 876543\n\n她想继续了解主人喜欢什么。\n')
  linkWhaleDocuments(store, { reports, diary })
  bindLearning(store, 'session:qq-owner', 'owner')
  bindLearning(store, 'session:wechat-owner', 'owner')
  bindLearning(store, 'session:bili-whale', 'watcher')
  const tool = createPondTool(store)
  const call = (id, args) => tool.execute(args, { agent: { session: { id } } })
  return { store, reports, diary, call }
}

test('授权主人可查找和读取报告正文、日记；敏感段落遮挡，原文件不改变', async () => {
  const { store, reports, diary, call } = fixture()
  const beforeReport = fs.readFileSync(path.join(reports, '2026-10-28.md'), 'utf8')
  const beforeDiary = fs.readFileSync(diary, 'utf8')
  assert.deepEqual((await call('qq-owner', { action: 'document_list' })).reports, ['2026-10-28'])
  assert.deepEqual((await call('qq-owner', { action: 'document_find', bvid: 'BV1xx411c7mD' })).reports, ['2026-10-28'])
  const report = await call('qq-owner', { action: 'document_read', documentKind: 'report', date: '2026-10-28', bvid: 'BV1xx411c7mD' })
  assert.match(report.content, /标题：小剧场/)
  assert.match(report.content, /剧本 beat：转折/)
  assert.doesNotMatch(report.content, /123456|另一个故事/)
  assert.match(report.content, /疑似敏感/)
  const note = await call('wechat-owner', { action: 'document_read', documentKind: 'diary' })
  assert.match(note.content, /今天看到了有趣的故事/)
  assert.doesNotMatch(note.content, /876543/)
  assert.equal(fs.readFileSync(path.join(reports, '2026-10-28.md'), 'utf8'), beforeReport)
  assert.equal(fs.readFileSync(diary, 'utf8'), beforeDiary)
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /小剧场|876543|123456/)
})

test('watcher、公开会话及伪造身份不能读取私人文档；撤销立刻生效', async () => {
  const { store, call } = fixture()
  for (const id of ['bili-whale', 'bili-public', 'unknown']) {
    assert.equal((await call(id, { action: 'document_list', principal: 'session:qq-owner' })).ok, false)
    assert.equal((await call(id, { action: 'document_find', bvid: 'BV1xx411c7mD' })).ok, false)
    assert.equal((await call(id, { action: 'document_read', documentKind: 'diary' })).ok, false)
  }
  bindLearning(store, 'session:qq-owner', 'remove')
  assert.equal((await call('qq-owner', { action: 'document_read', documentKind: 'diary' })).ok, false)
  unlinkWhaleDocuments(store)
  assert.equal((await call('wechat-owner', { action: 'document_read', documentKind: 'diary' })).ok, false)
})

test('限制文档路径和分页，修改源文件后旧分页版本失效', async () => {
  const { diary, call } = fixture()
  for (const date of ['../diary', '2026-10-28/../../diary', '2026-10-28.md']) {
    assert.equal((await call('qq-owner', { action: 'document_read', documentKind: 'report', date })).ok, false)
  }
  fs.writeFileSync(diary, '# 日记\n\n' + '鲸🐟'.repeat(3000))
  const first = await call('qq-owner', { action: 'document_read', documentKind: 'diary' })
  assert.equal(first.nextOffset, 4000)
  assert.equal((await call('qq-owner', { action: 'document_read', documentKind: 'diary', offset: 4000 })).ok, false)
  const second = await call('qq-owner', { action: 'document_read', documentKind: 'diary', offset: 4000, documentRevision: first.revision })
  assert.equal(first.content + second.content, fs.readFileSync(diary, 'utf8'))
  fs.appendFileSync(diary, '\n更新')
  assert.equal((await call('qq-owner', { action: 'document_read', documentKind: 'diary', offset: 4000, documentRevision: first.revision })).ok, false)
})

test('MCP 既要独立 documents:read 权限也要主人身份授权', () => {
  const { store } = fixture()
  const noScope = store.channelAdd({ name: 'no-document-scope', scopes: ['learning:access'] })
  const yesScope = store.channelAdd({ name: 'document-owner', scopes: ['documents:read'] })
  const stranger = store.channelAdd({ name: 'document-stranger', scopes: ['documents:read'] })
  bindLearning(store, 'channel:' + noScope.channel.id, 'owner')
  bindLearning(store, 'channel:' + yesScope.channel.id, 'owner')
  const call = token => {
    const stdout = execFileSync(process.execPath, [path.resolve('tools/pond-mcp.mjs')], { windowsHide: true, encoding: 'utf8', env: { ...process.env, POND_HOME: store.home, POND_TOKEN: token }, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pond', arguments: { action: 'document_read', documentKind: 'diary' } } }) + '\n' })
    return JSON.parse(JSON.parse(stdout).result.content[0].text)
  }
  assert.equal(call(noScope.token).ok, false)
  assert.match(call(yesScope.token).content, /今天看到了有趣的故事/)
  assert.equal(call(stranger.token).ok, false)
})
