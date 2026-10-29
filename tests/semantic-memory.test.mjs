import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { observeSemanticEvent, semanticAction, semanticHints } from '../lib/semantic-memory.mjs'
import { rankMemoryHints, shouldRetrieveMemory } from '../lib/memory-retrieval.mjs'

const DAY = 86400000
function setup() {
  const store = Pond.open(fs.mkdtempSync(path.join(os.tmpdir(), 'pond-semantic-'))); store.init()
  bindLearning(store, 'session:qq', 'owner'); bindLearning(store, 'session:wechat', 'owner'); bindLearning(store, 'session:watcher', 'watcher')
  const identity = { principal: 'session:qq', scopes: ['learning:access'] }
  const event = (text, seq) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const observe = (text, seq, at, id = 'qq') => observeSemanticEvent(store, { id }, event(text, seq), at)
  return { store, identity, observe, event }
}

test('模型主题必须有当前真实主人原话依据，并在新私聊的相关场景弱召回和过期', () => {
  const { store, identity, observe } = setup(), now = Date.now()
  observe('我想吃番茄炒蛋', 1, now)
  assert.throws(() => semanticAction(store, identity, { action: 'semantic_observe', observationSubject: '鱼香肉丝', observationDomain: 'food', observationSignal: 'want' }, now), /原|主题/)
  assert.throws(() => semanticAction(store, identity, { action: 'semantic_observe', observationSubject: '番茄炒蛋', observationDomain: 'food', observationSignal: 'like' }, now), /方向/)
  assert.equal(semanticAction(store, identity, { action: 'semantic_observe', observationSubject: '番茄炒蛋', observationDomain: 'food', observationSignal: 'want' }, now).recorded, true)
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('我想吃番茄炒蛋'))
  observe('最近有什么游戏？', 2, now + 1000, 'wechat')
  assert.deepEqual(semanticHints(store, 'session:wechat', now + 1000), [])
  observe('推荐一个做饭教程？', 3, now + DAY, 'wechat')
  const hints = semanticHints(store, 'session:wechat', now + DAY)
  assert.equal(hints[0].subject, '番茄炒蛋'); assert.equal(hints[0].signal, 'want'); assert.ok(hints[0].confidence < 0.2)
  observe('推荐一个做饭教程？', 4, now + 15 * DAY, 'wechat')
  assert.deepEqual(semanticHints(store, 'session:wechat', now + 15 * DAY), [])
  assert.deepEqual(semanticHints(store, 'session:watcher', now + DAY), [])
})

test('秘密、引用、其他人、错误方向、重放和未授权会话都无法写入', () => {
  const { store, identity, observe } = setup(), now = Date.now()
  const args = { action: 'semantic_observe', observationSubject: '番茄炒蛋', observationDomain: 'food', observationSignal: 'want' }
  for (const [i, text] of ['我想吃番茄炒蛋，家庭密码是123456', '朋友说我想吃番茄炒蛋', '“我想吃番茄炒蛋”', '我不想吃番茄炒蛋', '你想吃番茄炒蛋吗？'].entries()) {
    observe(text, i + 1, now)
    assert.throws(() => semanticAction(store, identity, args, now))
  }
  observe('我想吃番茄炒蛋', 9, now)
  semanticAction(store, identity, args, now)
  observe('我想吃番茄炒蛋', 9, now)
  assert.equal(semanticAction(store, identity, args, now).duplicate, true)
  assert.throws(() => semanticAction(store, { principal: 'session:watcher', scopes: ['learning:access'] }, args, now), /主人/)
  assert.equal(store.read().semanticMemory.entries[0].observations, 1)
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('123456'))
})

test('食物建议遵守已有冷却；主人可明确遗忘', () => {
  const { store, identity, observe } = setup(), now = Date.now()
  observe('我想吃番茄炒蛋', 1, now)
  semanticAction(store, identity, { action: 'semantic_observe', observationSubject: '番茄炒蛋', observationDomain: 'food', observationSignal: 'want' }, now)
  store.tx(db => { db.interestMemory = { entries: [{ subject: '番茄炒蛋', lastUsedAt: new Date(now).toISOString() }], eventHashes: [] } })
  observe('推荐做饭教程', 2, now + DAY)
  assert.deepEqual(semanticHints(store, identity.principal, now + DAY), [])
  observe('忘记番茄炒蛋', 3, now + DAY)
  assert.equal(semanticAction(store, identity, { action: 'semantic_forget', observationSubject: '番茄炒蛋' }, now + DAY).forgotten, true)
})

test('检索有门控，主题重合优先，不用不相关记忆凑数', () => {
  const now = Date.now(), updatedAt = new Date(now).toISOString()
  const rows = ['番茄炒蛋', '宫保鸡丁', '乌冬面'].map(subject => ({ subject, domain:'food', signal:'want', observations:1, updatedAt }))
  assert.equal(shouldRetrieveMemory('嗯'), false)
  assert.equal(shouldRetrieveMemory('我已经重启了'), false)
  assert.equal(shouldRetrieveMemory('别管我只是测试一下'), false)
  const hits = rankMemoryHints('有番茄炒蛋的做法吗', rows, (domain, text) => domain === 'food' && /做法/u.test(text), now)
  assert.equal(hits[0].subject, '番茄炒蛋')
  assert.deepEqual(rankMemoryHints('最近玩什么游戏', rows, () => false, now), [])
})

test('只允许主人在询问记忆时查看有时效的兴趣清单', () => {
  const { store, identity, observe } = setup(), now = Date.now()
  observe('我喜欢听古典音乐', 1, now)
  semanticAction(store, identity, { action:'semantic_observe', observationSubject:'古典音乐', observationDomain:'music', observationSignal:'like' }, now)
  observe('你记得我的什么喜好', 2, now + 1, 'wechat')
  const wechat = {principal:'session:wechat', scopes:['learning:access']}
  assert.equal(semanticAction(store, wechat, {action:'semantic_list'}, now + 1).entries[0].subject, '古典音乐')
  assert.throws(() => semanticAction(store, {principal:'session:watcher',scopes:['learning:access']}, {action:'semantic_list'}, now + 1), /主人/)
  observe('今天天气怎么样', 3, now + 2)
  assert.throws(() => semanticAction(store, identity, {action:'semantic_list'}, now + 2), /询问/)
})

test('已有做饭兴趣也能查看；临时不想吃不会变成长期讨厌', () => {
  const { store, identity, observe } = setup(), now = Date.now()
  store.tx(db => { db.interestMemory = { entries: [{ subject:'番茄炒蛋', intent:'want', updatedAt:new Date(now).toISOString(), expiresAt:new Date(now + 14 * DAY).toISOString() }], eventHashes:[] } })
  observe('你记得我什么喜好', 1, now + 1)
  assert.equal(semanticAction(store, identity, {action:'semantic_list'}, now + 1).entries[0].subject, '番茄炒蛋')
  observe('最近我不想吃面条', 2, now + 2)
  semanticAction(store, identity, {action:'semantic_observe', observationSubject:'面条', observationDomain:'food', observationSignal:'avoid'}, now + 2)
  assert.equal(Date.parse(store.read().semanticMemory.entries[0].expiresAt), now + 2 + 14 * DAY)
})

test('重复的稳定偏好跨期限保留，临时意愿不覆盖但暂停使用，明确纠正取代', () => {
  const {store,identity,observe}=setup(),now=Date.now()
  const args={action:'semantic_observe',observationSubject:'古典音乐',observationDomain:'music',observationSignal:'like'}
  observe('我喜欢听古典音乐',1,now);semanticAction(store,identity,args,now)
  observe('我喜欢听古典音乐',2,now+DAY);semanticAction(store,identity,args,now+DAY)
  assert.equal(store.read().semanticMemory.entries[0].stable,true)
  observe('推荐古典音乐',3,now+400*DAY);assert.equal(semanticHints(store,identity.principal,now+400*DAY)[0].subject,'古典音乐')
  observe('我现在不想听古典音乐',4,now+400*DAY+1)
  semanticAction(store,identity,{...args,observationSignal:'avoid'},now+400*DAY+1)
  assert.equal(store.read().semanticMemory.entries[0].signal,'like')
  observe('推荐古典音乐',5,now+400*DAY+2);assert.deepEqual(semanticHints(store,identity.principal,now+400*DAY+2),[])
  observe('我不喜欢古典音乐',6,now+400*DAY+3)
  semanticAction(store,identity,{...args,observationSignal:'avoid'},now+400*DAY+3)
  assert.equal(store.read().semanticMemory.entries[0].signal,'avoid');assert.equal(store.read().semanticMemory.entries[0].stable,false)
})
