import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning, runLearning } from '../lib/memory.mjs'
import { linkWhaleDocuments } from '../lib/documents.mjs'
import { recommendCandidates, observeRecommendationEvent, feedbackScores, reportCandidates } from '../lib/recommendations.mjs'

function fixture() {
  const base = path.resolve('待删除文件', '推荐功能测试')
  fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, 'case-'))
  const reports = path.join(home, 'reports')
  fs.mkdirSync(reports)
  fs.writeFileSync(path.join(home, 'diary.md'), '# 日记')
  fs.writeFileSync(path.join(reports, '2026-10-28.md'), `# 报告

### BV1xx411c7mD
- **标题**：搞笑故事
- **档位**：值得看（依据：字幕和弹幕）
- **我自己的一句话**：这个结尾真好玩。

### BV1yy411c7mD
- **标题**：一个动画故事
- **档位**：值得看（依据：字幕）
- **我自己的一句话**：画风很有意思。

### BV1zz411c7mD
- **标题**：只有标题，没有真实感受
`)
  const store = Pond.open(home); store.init()
  linkWhaleDocuments(store, { reports, diary: path.join(home, 'diary.md') })
  bindLearning(store, 'session:owner', 'owner'); bindLearning(store, 'session:whale', 'watcher')
  return { store, owner: { principal: 'session:owner', scopes: ['documents:read', 'learning:access'] } }
}
const user = (seq, text) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } })

test('识别原版报告的一行标题档位和未加粗个人感受，缺失字段不列入', () => {
  const {store}=fixture(), dir=store.read().whaleDocuments.reports
  fs.writeFileSync(path.join(dir,'2026-10-29.md'), `# 原版报告\n\n### BV1vJnN64E8Q\n- 《虚构的群聊故事》/ 某作者 / https://www.bilibili.com/video/BV1vJnN64E8Q/ / **值得看（18/20）**\n- **为什么值得**：有字幕和画面。\n- 我自己的一句话：这个反转让我笑了。\n\n### BV1sZYDzHEU8\n- 《没有评级的视频》/ 作者\n- 我自己的一句话：这条缺少评级。\n`)
  const result=reportCandidates(dir).filter(x=>x.date==='2026-10-29')
  assert.equal(result.length,1); assert.equal(result[0].title,'虚构的群聊故事'); assert.equal(result[0].impression,'这个反转让我笑了。'); assert.match(result[0].evidence,/值得看/)
})

test('报告候选、可信会话分享和明确反馈形成闭环，去重、隔离并可遗忘', () => {
  const { store, owner } = fixture(); const now = Date.now(); const session = { id: 'owner' }
  let candidates = recommendCandidates(store, owner, now).candidates
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].impression, '这个结尾真好玩。')
  assert.throws(() => recommendCandidates(store, { principal: 'session:whale', scopes: owner.scopes }, now), /主人/)
  const actualFormat = assistant(1, '这一条很有意思 https://www.bilibili.com/video/BV1xx411c7mD/')
  actualFormat.data.message.content.unshift({ type: 'reasoning', text: '不可保存的内部内容' })
  observeRecommendationEvent(store, session, actualFormat, now)
  observeRecommendationEvent(store, session, assistant(1, '这一条很有意思 https://www.bilibili.com/video/BV1xx411c7mD/'), now)
  assert.equal(recommendCandidates(store, owner, now + 1).candidates[0].bvid, 'BV1yy411c7mD')
  observeRecommendationEvent(store, session, user(2, '这条不错'), now + 2)
  observeRecommendationEvent(store, session, user(2, '这条不错'), now + 2)
  assert.equal(store.read().recommendations.feedback.length, 1)
  assert.equal(store.read().recommendations.feedback[0].signal, 'like')
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /这条不错|这个结尾真好玩|不可保存的内部内容/)
  runLearning(store, { action: 'memory_forget', bvid: 'BV1xx411c7mD' }, owner)
  assert.equal(store.read().recommendations.feedback.length, 0)
  assert.ok(!recommendCandidates(store, owner, now + 8 * 86400000).candidates.some(x => x.bvid === 'BV1xx411c7mD'))
})

test('无关消息、模糊反馈、引用和其他身份不构成视频偏好', () => {
  const { store } = fixture(); const now = Date.now(); const session = { id: 'owner' }
  observeRecommendationEvent(store, { id: 'whale' }, assistant(1, 'https://www.bilibili.com/video/BV1xx411c7mD/'), now)
  assert.equal(store.read().recommendations, undefined)
  observeRecommendationEvent(store, session, assistant(2, 'https://www.bilibili.com/video/BV1xx411c7mD/'), now)
  observeRecommendationEvent(store, session, user(3, '今天吃什么'), now + 1)
  observeRecommendationEvent(store, session, user(4, '喜欢'), now + 2)
  assert.equal(store.read().recommendations.feedback.length, 0)
  observeRecommendationEvent(store, session, assistant(5, '我想分享一个动画故事，很有意思。'), now + 3)
  assert.equal(store.read().recommendations.suggestions.length, 2)
  observeRecommendationEvent(store, session, user(6, '你说“这条不错”'), now + 4)
  assert.equal(store.read().recommendations.feedback.length, 0)
})

test('单次反馈不改变类别排序；重复同一视频不增加信心；多次反馈随时间衰减', () => {
  const now = Date.now(); const f = (bvid, at, topic = 'comedy') => ({ bvid, topic, signal: 'like', at: new Date(at).toISOString() })
  assert.equal(feedbackScores([f('a', now)], now).get('comedy'), 0)
  assert.equal(feedbackScores([f('a', now), f('a', now + 1)], now + 1).get('comedy'), 0)
  const feedback = [f('a', now), f('b', now)]
  const initial = feedbackScores(feedback, now).get('comedy')
  assert.ok(initial > 0 && initial < 0.75)
  assert.ok(feedbackScores(feedback, now + 30 * 86400000).get('comedy') < initial)
  assert.ok(!feedbackScores([f('a', now, 'other'), f('b', now, 'other')], now).has('other'))
})
