import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { extractCookingInterest, observeInterestEvent, observeInterestReply, interestAction } from '../lib/interests.mjs'
import { createPondTool } from '../lib/tool.mjs'
import { apply } from '../lib/index.js'

const DAY = 86400000

test('主人请求教程后，实际生成有链接的推荐会自动进入冷却', () => {
  const { store, session, event, identity } = setup(), now = Date.now()
  observeInterestEvent(store, session, event('我想吃番茄炒蛋', 1), now)
  observeInterestEvent(store, session, event('找一个做饭教程', 2), now + 1)
  const reply = text => ({ type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text }] } } })
  observeInterestReply(store, session, reply('我记得你想吃番茄炒蛋'), now + 2)
  assert.equal(store.read().interestMemory.entries[0].lastUsedAt, null)
  observeInterestReply(store, session, reply('推荐番茄炒蛋做法：https://www.bilibili.com/video/BV1vJnN64E8Q'), now + 3)
  assert.ok(store.read().interestMemory.entries[0].lastUsedAt)
  assert.deepEqual(interestAction(store, identity, {action:'interest_recall',interestContext:'cooking'}, now + 4).candidates, [])
})
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-interest-'))
  const store = Pond.open(home)
  store.init()
  bindLearning(store, 'session:qq-owner', 'owner')
  bindLearning(store, 'session:wechat-owner', 'owner')
  bindLearning(store, 'session:bili-whale', 'watcher')
  const identity = { principal: 'session:wechat-owner', scopes: ['learning:access'] }
  const event = (text, seq) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const session = { id: 'qq-owner' }
  return { store, home, identity, event, session }
}

test('近期想吃在新私聊中仅在做饭场景召回；重复推荐冷却并可探索其他菜', () => {
  const { store, identity, event, session } = setup()
  const now = Date.now()
  const first = event('我想吃番茄炒蛋', 1)
  assert.equal(observeInterestEvent(store, session, first, now).recorded, true)
  assert.equal(observeInterestEvent(store, session, first, now).duplicate, true)
  assert.equal(store.read().interestMemory.entries.length, 1)
  const fresh = Pond.open(store.home)
  const recall = () => interestAction(fresh, identity, { action: 'interest_recall', interestContext: 'cooking' }, now + 1)
  assert.equal(recall().candidates[0].subject, '番茄炒蛋')
  assert.equal(recall().candidates[0].intent, 'want')
  assert.throws(() => interestAction(fresh, identity, { action: 'interest_recall', interestContext: 'games' }, now + 1), /做饭/)
  assert.throws(() => interestAction(fresh, identity, { action: 'interest_used', interestSubject: '番茄炒蛋' }, now + 2), /本轮请求/)
  observeInterestEvent(store, { id: 'wechat-owner' }, event('推荐一个做饭教程', 99), now + 2)
  observeInterestEvent(store, { id: 'wechat-owner' }, event('我们聊点别的', 100), now + 2)
  assert.throws(() => interestAction(fresh, identity, { action: 'interest_used', interestSubject: '番茄炒蛋' }, now + 2), /本轮请求/)
  observeInterestEvent(store, { id: 'wechat-owner' }, event('推荐一个做饭教程', 101), now + 2)
  interestAction(fresh, identity, { action: 'interest_used', interestSubject: '番茄炒蛋' }, now + 2)
  assert.throws(() => interestAction(fresh, identity, { action: 'interest_used', interestSubject: '番茄炒蛋' }, now + 2), /本轮请求/)
  assert.equal(recall().explore, true)
  assert.deepEqual(recall().avoidRepeat, ['番茄炒蛋'])
  observeInterestEvent(store, session, event('我想吃宫保鸡丁', 2), now + 3)
  const other = interestAction(fresh, identity, { action: 'interest_recall', interestContext: 'cooking' }, now + 4)
  assert.deepEqual(other.candidates.map(x => x.subject), ['宫保鸡丁'])
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('我想吃番茄炒蛋'))
})

test('临时兴趣过期；长期喜欢、讨厌、不要总推荐和遗忘分别生效', () => {
  const { store, identity, event, session } = setup()
  const now = Date.now()
  const recallAt = at => interestAction(store, identity, { action: 'interest_recall', interestContext: 'cooking' }, at)
  observeInterestEvent(store, session, event('我想吃番茄炒蛋', 1), now)
  assert.equal(recallAt(now + 15 * DAY).candidates.length, 0)
  observeInterestEvent(store, session, event('我喜欢吃番茄炒蛋', 2), now + 15 * DAY)
  observeInterestEvent(store, session, event('我不想吃番茄炒蛋', 9), now + 35 * DAY)
  assert.equal(recallAt(now + 36 * DAY).candidates.length, 0)
  assert.equal(recallAt(now + 45 * DAY).candidates[0].intent, 'like')
  observeInterestEvent(store, session, event('别总推荐番茄炒蛋', 3), now + 45 * DAY)
  assert.equal(recallAt(now + 46 * DAY).candidates.length, 0)
  assert.equal(recallAt(now + 76 * DAY).candidates[0].subject, '番茄炒蛋')
  observeInterestEvent(store, session, event('我不喜欢吃番茄炒蛋', 4), now + 77 * DAY)
  assert.equal(recallAt(now + 78 * DAY).candidates.length, 0)
  assert.deepEqual(recallAt(now + 78 * DAY).avoid, ['番茄炒蛋'])
  assert.equal(interestAction(store, identity, { action: 'interest_forget', interestSubject: '番茄炒蛋' }, now + 79 * DAY).forgotten, true)
  assert.equal(store.read().interestMemory.entries.length, 0)
  assert.equal(observeInterestEvent(store, session, event('我喜欢吃番茄炒蛋', 2), now + 80 * DAY).duplicate, true)
})

test('只接受可信主人直接消息；引用、其他人、私人信息和公开会话不触发', () => {
  const { store, identity, event, session } = setup()
  const now = Date.now()
  assert.equal(extractCookingInterest('我朋友想吃番茄炒蛋'), null)
  assert.equal(extractCookingInterest('想做游戏人物角色，mod这类的'), null)
  assert.equal(extractCookingInterest('我想做番茄炒蛋').subject, '番茄炒蛋')
  assert.equal(extractCookingInterest('你想吃番茄炒蛋吗？'), null)
  assert.equal(extractCookingInterest('[Quoted message begins]\n我想吃番茄炒蛋'), null)
  assert.equal(observeInterestEvent(store, session, event('我想吃番茄炒蛋，家庭密码是123456', 1), now).recorded, false)
  const pluginEvent = event('我想吃番茄炒蛋', 2)
  pluginEvent.data.source.kind = 'plugin'
  assert.equal(observeInterestEvent(store, session, pluginEvent, now).recorded, false)
  assert.equal(observeInterestEvent(store, { id: 'bili-whale' }, event('我想吃番茄炒蛋', 3), now).recorded, false)
  assert.throws(() => interestAction(store, { principal: 'session:bili-whale', scopes: ['learning:access'] }, { action: 'interest_recall', interestContext: 'cooking' }, now), /主人/)
  assert.throws(() => interestAction(store, { principal: identity.principal, scopes: [] }, { action: 'interest_recall', interestContext: 'cooking' }, now), /权限/)
  assert.equal(store.read().interestMemory, undefined)
})

test('DSH 插件实际注册用户事件监听，绑定会话触发记录；工具返回相关候选', async () => {
  const { home, event } = setup()
  const savedHome = process.env.POND_HOME
  const handlers = new Map()
  const tools = []
  try {
    process.env.POND_HOME = home
    apply({ get(name) { return name === 'tools' ? { register(tool) { tools.push(tool) } } : null }, on(name, fn) { handlers.set(name, fn) } })
    assert.equal(typeof handlers.get('session/event'), 'function')
    handlers.get('session/event')({ header: { id: 'qq-owner' } }, event('我想吃番茄炒蛋', 10))
    const r = await tools[0].execute({ action: 'interest_recall', interestContext: 'cooking' }, { agent: { session: { id: 'wechat-owner' } } })
    assert.equal(r.candidates[0].subject, '番茄炒蛋')
  } finally {
    if (savedHome === undefined) delete process.env.POND_HOME
    else process.env.POND_HOME = savedHome
  }
})
