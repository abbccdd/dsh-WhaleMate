import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning, runLearning } from '../lib/memory.mjs'
import { linkWhaleDocuments, readWhaleDocument } from '../lib/documents.mjs'
import { createSharedVideoObserver, recallSharedVideoDiary, renderSharedVideoDiary } from '../lib/shared-video-diary.mjs'

function fixture() {
  const base = path.resolve('待删除文件', '分享日记测试'); fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, 'case-')), reports = path.join(home, 'reports')
  fs.mkdirSync(reports); fs.writeFileSync(path.join(home, 'diary.md'), '# 原版日记\n\n原有内容。')
  const store = Pond.open(home); store.init(); linkWhaleDocuments(store, { reports, diary: path.join(home, 'diary.md') })
  bindLearning(store, 'session:owner', 'owner'); bindLearning(store, 'session:whale', 'watcher')
  const owner = { principal: 'session:owner', scopes: ['documents:read', 'learning:access'] }
  return { store, owner, observe: createSharedVideoObserver(store), original: path.join(home, 'diary.md') }
}
const user = (seq, text) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'reasoning', text: '虚构内部内容不能保存' }, { type: 'text', text }] } } })
const end = seq => ({ type: 'turn/end', seq, data: { reason: { kind: 'completed' } } })

test('未验证观看的分享只留私密记录，可遗忘，不冒充原日记', () => {
  const { store, owner, observe, original } = fixture(), session = { id: 'owner' }, link = 'https://www.bilibili.com/video/BV1Adno6REXP/'
  observe(session, user(1, `给你看看 ${link}`)); observe(session, user(1, `给你看看 ${link}`))
  assert.equal(store.read().sharedVideoDiary.entries.length, 1)
  assert.equal(store.read().sharedVideoDiary.entries[0].status, 'shared')
  observe(session, assistant(2, '我这次没法真的看，只读了元信息和评论。\n\n这种反差很好笑，但也让我安静了一下。'))
  observe(session, end(3))
  const row = recallSharedVideoDiary(store, owner).entries[0]
  assert.equal(row.status, 'responded'); assert.deepEqual(row.evidence, ['未能完整观看', '元信息', '评论或弹幕'])
  assert.match(row.impression, /反差很好笑/)
  const view = readWhaleDocument(store, owner, { documentKind: 'diary' })
  assert.match(view.content, /原有内容/); assert.doesNotMatch(view.content, /BV1Adno6REXP/)
  assert.equal(fs.readFileSync(original, 'utf8'), '# 原版日记\n\n原有内容。')
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /给你看看|虚构内部内容不能保存/)
  assert.throws(() => recallSharedVideoDiary(store, { principal: 'session:whale', scopes: owner.scopes }), /主人/)
  runLearning(store, { action: 'memory_forget', bvid: 'BV1Adno6REXP' }, owner)
  assert.doesNotMatch(readWhaleDocument(store, owner, { documentKind: 'diary' }).content, /BV1Adno6REXP/)
  observe(session, user(4, `给你看看 ${link}`)); assert.equal(recallSharedVideoDiary(store, owner).entries.length, 0)
})

test('敏感消息、非主人及非链接不入日记；不能误认已看或从他人回复学习', () => {
  const { store, owner, observe } = fixture(), link = 'https://www.bilibili.com/video/BV1Adno6REXP/'
  observe({ id: 'whale' }, user(1, link)); observe({ id: 'owner' }, user(2, `家庭密码是123456 ${link}`))
  observe({ id: 'owner' }, user(3, 'BV1Adno6REXP'))
  assert.equal(recallSharedVideoDiary(store, owner).entries.length, 0)
  observe({ id: 'owner' }, user(4, link)); observe({ id: 'owner' }, assistant(5, '你家住在哪里？')); observe({ id: 'owner' }, end(6))
  const row = recallSharedVideoDiary(store, owner).entries[0]
  assert.equal(row.status, 'responded'); assert.equal(row.impression, undefined); assert.deepEqual(row.evidence, [])
})

test('结尾提到主人时，记录前面安全的感受而不是忽略整条回复', () => {
  const { owner, observe, store } = fixture(), session = { id: 'owner' }
  observe(session, user(1, 'https://www.bilibili.com/video/BV1Adno6REXP/'))
  observe(session, assistant(2, '所以我的感受是：这条片子把善意定了两次价。\n\n你觉得那个人是不是太好心？'))
  observe(session, end(3))
  const row = recallSharedVideoDiary(store, owner).entries[0]
  assert.equal(row.impression, '所以我的感受是：这条片子把善意定了两次价。')
  assert.doesNotMatch(row.impression, /你/)
})

test('从长段落提取简短感受，不把读取字幕的过程当作感受', () => {
  const { owner, observe, store } = fixture(), session = { id: 'owner' }
  observe(session, user(1, 'https://www.bilibili.com/video/BV1Adno6REXP/'))
  observe(session, assistant(2, '这条素材很完整：字幕全在，十六帧抽帧我都看了。\n\n我最喜欢的是那个反转。' + '后面的故事发生了转折。'.repeat(30) + '你觉得呢？\n\n**有一处我没那么买账，但看完会觉得有意思。**'))
  observe(session, end(3))
  assert.equal(recallSharedVideoDiary(store, owner).entries[0].impression, '我最喜欢的是那个反转。')
})

test('真实抽帧成功后并入原日记；遗忘只移除对应的看视频记录', () => {
  const { store, owner, observe, original } = fixture(), session = { id: 'owner' }, saved = process.env.DSH_HOME
  const root = path.join(store.home, 'mock-dsh'), dir = path.join(root, 'shots', 'video')
  fs.mkdirSync(dir, { recursive: true }); const frame = path.join(dir, 'BV1Adno6REXP-2026-01-01-pond-4x4.jpg'); fs.writeFileSync(frame, 'test')
  const originalFrame = path.join(dir, 'BV1Adno6REXP-2026-01-01-4x4.jpg'), subtitleFrame = path.join(dir, 'BV1Adno6REXP-2026-01-01-subs.jpg'), otherFrame = path.join(dir, 'BV1Adno6REXP-elsewhere-4x4.jpg')
  for (const item of [originalFrame, subtitleFrame, otherFrame]) fs.writeFileSync(item, 'test')
  process.env.DSH_HOME = root
  try {
    observe(session, user(1, 'https://www.bilibili.com/video/BV1Adno6REXP/'))
    observe(session, { type: 'tool/call', seq: 2, data: { name: 'read_image', callId: 'image1', arguments: { file_path: frame } } })
    observe(session, { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'image1' }, content: [{ type: 'tool-result', isError: false }] } } })
    observe(session, assistant(4, '你看到了这次四乘四的画面吗？')); observe(session, end(5))
    assert.equal(recallSharedVideoDiary(store, owner).entries[0].verifiedFrameRead, true)
    assert.equal(recallSharedVideoDiary(store, owner).entries[0].verifiedFrameGrid, '4x4')
    assert.match(fs.readFileSync(path.join(store.home, 'shared-video-diary.md'), 'utf8'), /实际工具记录/)
    const combined = fs.readFileSync(original, 'utf8')
    assert.match(combined, /原有内容/); assert.match(combined, /BV1Adno6REXP/)
    assert.match(combined, /4×4/); assert.doesNotMatch(combined, /虚构内部内容不能保存/)
    assert.equal(fs.existsSync(frame), false)
    assert.equal(fs.existsSync(originalFrame), false); assert.equal(fs.existsSync(subtitleFrame), false); assert.equal(fs.existsSync(otherFrame), true)
    // Recover a feeling into an untouched managed section without replacing other diary text.
    store.tx(db => { db.sharedVideoDiary.entries[0].impression = '我觉得这个细节很有趣。' }); renderSharedVideoDiary(store)
    assert.match(fs.readFileSync(original, 'utf8'), /我觉得这个细节很有趣/)
    const hash = store.read().sharedVideoDiary.entries[0].eventHash
    store.tx(db => { db.sharedVideoDiary.entries[0].impression = '我最喜欢那个反转。' })
    renderSharedVideoDiary(store, { previousImpressions: { [hash]: '我觉得这个细节很有趣。' } })
    assert.match(fs.readFileSync(original, 'utf8'), /我最喜欢那个反转/)
    assert.doesNotMatch(fs.readFileSync(original, 'utf8'), /我觉得这个细节很有趣/)
    runLearning(store, { action: 'memory_forget', bvid: 'BV1Adno6REXP' }, owner)
    const forgotten = fs.readFileSync(original, 'utf8')
    assert.match(forgotten, /原有内容/); assert.doesNotMatch(forgotten, /BV1Adno6REXP/)
  } finally { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved }
})

test('生活窗只接收固定活动摘要，遗忘后同步撤回，不包含聊天、视频和感受', () => {
  const { store, owner, observe } = fixture(), session = { id: 'owner' }
  store.lifeWindowHome = path.join(store.home, 'life-home'); fs.mkdirSync(store.lifeWindowHome)
  const provider = path.join(store.lifeWindowHome, 'life-window', 'providers', 'dsh-pond-activity.json')
  observe(session, user(1, '私密谈话标记 https://www.bilibili.com/video/BV1Adno6REXP/'))
  observe(session, assistant(2, '这是我对视频独特的个人感受。')); observe(session, end(3))
  const exported = fs.readFileSync(provider, 'utf8'), data = JSON.parse(exported)
  assert.equal(data.events.length, 1); assert.equal(data.events[0].title, '回应了一条分享的视频')
  assert.doesNotMatch(exported, /私密谈话标记|BV1Adno6REXP|个人感受|bilibili/)
  runLearning(store, { action: 'memory_forget', bvid: 'BV1Adno6REXP' }, owner)
  assert.deepEqual(JSON.parse(fs.readFileSync(provider, 'utf8')).events, [])
})
