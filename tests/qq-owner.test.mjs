import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOwnerGuard, prepareOwnerPairing, ownerStatus, installOwnerSendGuard } from '../vendor/tencent-dsh-qqbot-owner/dist/owner-guard.js'
import { verifiedQQSession } from '../lib/qq-session.mjs'
import crypto from 'node:crypto'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-guard-'))
  prepareOwnerPairing(home)
  const code = fs.readFileSync(path.join(home, 'qq-pairing-code.txt'), 'utf8').match(/FISH-[A-F0-9]{16}/)[0]
  return { home, code, guard: createOwnerGuard({ home, appId: 'test-app' }) }
}

test('唯一有效配对码绑定私聊发送者；错误代码与群消息不绑定', async () => {
  const { home, code, guard } = fixture()
  let accepted = 0
  const next = () => { accepted++ }
  const send = (kind, senderId, content) => guard.inbound({ message: { kind, senderId, content } }, next)
  await send('c2c', 'stranger', 'FISH-0000000000000000')
  await send('group', 'stranger', code)
  assert.equal(ownerStatus(home).bound, false)
  await send('c2c', 'owner', code)
  assert.equal(ownerStatus(home).bound, true)
  assert.equal(accepted, 0)
  await send('c2c', 'stranger', 'hello')
  await send('group', 'owner', 'hello')
  await send('c2c', 'owner', 'hello')
  assert.equal(accepted, 1)
  assert.equal(guard.allowed({ scope: 'c2c', targetId: 'owner' }), true)
  assert.equal(guard.allowed({ scope: 'c2c', targetId: 'stranger' }), false)
  assert.equal(guard.allowed({ scope: 'group', targetId: 'owner' }), false)
  assert.equal(createOwnerGuard({ home, appId: 'another-bot' }).allowed({ scope: 'c2c', targetId: 'owner' }), false)
  assert.throws(() => prepareOwnerPairing(home), /已经绑定/)
})

test('所有文字、流式与附件发送入口只接受已绑定主人', async () => {
  const { code, guard } = fixture()
  const seen = []
  const methods = ['sendText', 'sendTextWithKeyboard', 'sendMarkdown', 'sendWakeup', 'sendTyping', 'sendImage', 'sendVideo', 'sendVoice', 'sendFile', 'send', 'openStream', 'sendMedia', 'uploadMedia', 'sendChannelMessage', 'sendDmMessage']
  const bot = Object.fromEntries(methods.map(method => [method, (...args) => { seen.push({ method, args }); return true }]))
  installOwnerSendGuard(bot, guard)
  const target = { scope: 'c2c', targetId: 'owner' }
  assert.throws(() => bot.sendMarkdown(target, 'no owner yet'), /拒绝/)
  await guard.inbound({ message: { kind: 'c2c', senderId: 'owner', content: code } }, () => {})
  for (const method of methods) {
    if (['sendChannelMessage', 'sendDmMessage'].includes(method)) { assert.throws(() => bot[method]('any'), /禁用/); continue }
    const option = ['send', 'openStream', 'sendMedia', 'uploadMedia'].includes(method)
    assert.equal(bot[method](option ? { target } : target), true)
    assert.throws(() => bot[method](option ? { target: { scope: 'c2c', targetId: 'stranger' } } : { scope: 'c2c', targetId: 'stranger' }), /拒绝/)
    assert.throws(() => bot[method](option ? { target: { scope: 'group', targetId: 'owner' } } : { scope: 'group', targetId: 'owner' }), /拒绝/)
  }
  assert.equal(seen.length, 13)
})

test('失效配对码不能绑定，破损状态默认拒绝', async () => {
  const { home, code, guard } = fixture()
  const stateFile = path.join(home, 'qq-owner.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.expiresAt = Date.now() - 1
  fs.writeFileSync(stateFile, JSON.stringify(state))
  await guard.inbound({ message: { kind: 'c2c', senderId: 'owner', content: code } }, () => { throw new Error('must not run') })
  assert.equal(ownerStatus(home).bound, false)
  fs.writeFileSync(stateFile, '{')
  assert.throws(() => guard.allowed({ scope: 'c2c', targetId: 'owner' }), /无法读取/)
})

test('只将已验证私聊映射到官方适配器实际使用的会话 ID', () => {
  const state = { ownerOpenId: 'owner-openid', appId: 'bot-app' }
  const hash = crypto.createHash('sha256').update('qqbot:bot-app:c2c:owner-openid').digest('hex')
  const expected = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  assert.equal(verifiedQQSession(state), expected)
  const key = 'qqbot:bot-app:c2c:owner-openid'
  const current = 'aabbccdd-1122-3344-5566-77889900aabb'
  assert.equal(verifiedQQSession(state, { sessionIds: { [key]: current } }), current)
  assert.throws(() => verifiedQQSession({ appId: 'bot-app' }), /验证/)
  assert.throws(() => verifiedQQSession(state, { sessionIds: { [key]: 'invalid' } }), /无效/)
})
