import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pond-store-'))
}

test('init：建库 + owner 令牌，幂等', () => {
  const home = tempHome()
  const p = Pond.open(home)
  const r1 = p.init()
  const token = p.ownerToken()
  assert.ok(token.startsWith('dp_'))
  assert.equal(r1.ownerToken, undefined)
  assert.ok(fs.existsSync(path.join(home, 'pond.json')))
  assert.ok(fs.existsSync(path.join(home, 'keys.json')))
  const r2 = p.init()
  assert.equal(r2.ownerToken, undefined)
  assert.equal(p.ownerToken(), token)
  // 文件权限（Windows 上 chmod 有限，仅确认没炸）
  const st = fs.statSync(path.join(home, 'pond.json'))
  assert.ok(st.isFile())
})

test('渠道：add / 认证 / rotate / revoke', () => {
  const p = Pond.open(tempHome())
  p.init()
  const { channel, token } = p.channelAdd({ name: 'qq', kind: 'qq' })
  assert.equal(channel.name, 'qq')
  assert.ok(token.startsWith('dp_'))
  assert.equal(p.authenticate(token).kind, 'channel')
  assert.equal(p.authenticate('dp_wrong'), null)
  // 重复名
  assert.throws(() => p.channelAdd({ name: 'qq', kind: 'qq' }), /渠道已存在/)
  // rotate 旧令牌失效
  const rotated = p.channelRotate('qq')
  assert.ok(rotated.token !== token)
  assert.equal(p.authenticate(token), null)
  assert.ok(p.authenticate(rotated.token))
  // revoke
  p.channelRevoke('qq')
  assert.equal(p.authenticate(rotated.token), null)
  assert.equal(p.channelList().length, 0)
})

test('条目：写入 / 判重 / 过滤 / 私密', () => {
  const p = Pond.open(tempHome())
  p.init()
  const a = p.addItem({ kind: 'video', source: 'bili', bvid: 'BV1abc', title: '沙雕短剧', dedupe: true }, 'cli')
  assert.equal(a.dup, false)
  assert.ok(a.item.id.startsWith('it_'))
  // 判重
  const b = p.addItem({ kind: 'video', source: 'bili', bvid: 'BV1abc', title: '重复', dedupe: true }, 'cli')
  assert.equal(b.dup, true)
  // 不同 key 不判重
  const c = p.addItem({ kind: 'note', source: 'qq', text: '去看这个', dedupe: true }, 'cli')
  assert.equal(c.dup, false)
  // 扫描
  assert.equal(p.listItems({ q: '沙雕' }).total, 1)
  assert.equal(p.listItems({ source: 'qq' }).total, 1)
  assert.equal(p.listItems({ status: 'queued' }).total, 2)
  // 私密
  const priv = p.addItem({ kind: 'note', source: 'wechat', text: '悄悄话', private: true }, 'cli')
  assert.equal(p.listItems({ canSeePrivate: false }).total, 2)
  assert.equal(p.listItems({ canSeePrivate: true }).total, 2)
  assert.equal(priv.discarded, true)
  assert.equal(priv.item, null)
  // ack
  const acked = p.setItemStatus(a.item.id, 'done')
  assert.equal(acked.item.status, 'done')
  assert.equal(p.listItems({ status: 'queued' }).total, 1)
})

test('指令：排队 / next / start / finish', () => {
  const p = Pond.open(tempHome())
  p.init()
  const cmd = p.addCommand({ channel: 'qq', user: '主人', action: 'watch', args: { bvid: 'BV1xx' } })
  assert.equal(cmd.status, 'pending')
  const next = p.nextPendingCommand()
  assert.equal(next.id, cmd.id)
  const started = p.startCommand(cmd.id)
  assert.equal(started.command.status, 'started')
  assert.equal(p.nextPendingCommand(), null)
  const done = p.finishCommand(cmd.id, { status: 'done', result: '看了' })
  assert.equal(done.command.status, 'done')
  assert.equal(p.listCommands({ status: 'done' }).total, 1)
})

test('KV / 判重账本 / 审计 / 统计', () => {
  const p = Pond.open(tempHome())
  p.init()
  assert.equal(p.kvGet('last-report'), null)
  p.kvSet('last-report', { n: 1 }, 'tool')
  assert.deepEqual(p.kvGet('last-report').value, { n: 1 })
  assert.deepEqual(p.kvSet('k2', 'v', 'cli').value, 'v')
  assert.equal(p.kvList().length, 2)

  assert.equal(p.seenAdd('BV1', { title: 'x' }).added, true)
  assert.equal(p.seenAdd('BV1').added, false)
  assert.equal(p.seenCheck('BV1').seen, true)
  assert.equal(p.seenCheck('BV2').seen, false)

  for (let i = 0; i < 5; i++) p.audit({ actor: 'test', action: 't', target: String(i) })
  assert.equal(p.auditTail(3).length, 3)

  const s = p.stats()
  assert.equal(s.items, 0)
  assert.equal(s.commands, 0)
  assert.equal(s.seen, 1)
  assert.ok(s.bytes >= 0)
})

test('next 是 FIFO：先写的先取', () => {
  const p = Pond.open(tempHome())
  p.init()
  const a = p.addItem({ text: '第一条', source: 'qq' }).item
  const b = p.addItem({ text: '第二条', source: 'qq' }).item
  assert.equal(p.nextQueuedItem().id, a.id)
  p.setItemStatus(a.id, 'done')
  assert.equal(p.nextQueuedItem().id, b.id)
  p.setItemStatus(b.id, 'done')
  assert.equal(p.nextQueuedItem(), null)
})

test('purge 参数校验 / wipe 保留渠道 / export', () => {
  const p = Pond.open(tempHome())
  p.init()
  p.channelAdd({ name: 'wechat', kind: 'wechat' })
  p.addItem({ text: 'x', source: 'qq' })
  assert.throws(() => p.purge({ olderThanDays: 0 }), /olderThanDays/)
  const w = p.wipe()
  assert.equal(w.ok, true)
  assert.equal(p.stats().items, 0)
  assert.equal(p.stats().channels, 1) // 渠道保留
  const db = p.exportAll()
  assert.equal(db.version, 1)
  assert.ok(db.channels && typeof db.channels === 'object')
})
