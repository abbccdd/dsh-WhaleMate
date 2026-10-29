import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { createPondTool } from '../lib/tool.mjs'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pond-tool-'))
}

function makeTool() {
  const p = Pond.open(tempHome())
  p.init()
  const tool = createPondTool(p)
  const execute = tool.execute
  tool.execute = args => execute(args, { agent: { session: { id: 'test-session' } } })
  return { p, tool }
}

test('工具定义形状符合 DSH 注册表子集', () => {
  const { tool } = makeTool()
  assert.equal(tool.name, 'pond')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.ok(Array.isArray(tool.parameters.properties.action.enum))
  assert.ok(tool.parameters.properties.action.enum.includes('ingest'))
  assert.deepEqual(tool.output.schema, { type: 'object' })
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('ingest → next → ack 主链路', async () => {
  const { tool } = makeTool()
  const ing = await tool.execute({ action: 'ingest', kind: 'video', source: 'bili', bvid: 'BV1tool', title: '工具写入', dedupe: true })
  assert.equal(ing.ok, true)
  assert.equal(ing.dup, false)
  const dup = await tool.execute({ action: 'ingest', source: 'bili', bvid: 'BV1tool', dedupe: true })
  assert.equal(dup.dup, true)

  const next = await tool.execute({ action: 'next' })
  assert.equal(next.ok, true)
  assert.equal(next.item.bvid, 'BV1tool')
  assert.equal(next.command, null)

  const ack = await tool.execute({ action: 'ack', id: next.item.id })
  assert.equal(ack.status, 'done')
  assert.equal(ack.item, undefined)
  const after = await tool.execute({ action: 'list', status: 'queued' })
  assert.equal(after.total, 0)
})

test('command / commands / kv / seen / stats', async () => {
  const { tool } = makeTool()
  const c = await tool.execute({ action: 'command', commandAction: 'watch', commandArgs: { bvid: 'BV1x' }, user: '主人' })
  assert.equal(c.command.status, 'pending')
  const cmds = await tool.execute({ action: 'commands', status: 'pending' })
  assert.equal(cmds.total, 1)

  const kvSet = await tool.execute({ action: 'kv_set', key: 'k', value: { a: 1 } })
  assert.equal(kvSet.ok, true)
  const kvGet = await tool.execute({ action: 'kv_get', key: 'k' })
  assert.deepEqual(kvGet.value, { a: 1 })

  const seen1 = await tool.execute({ action: 'seen', key: 'BV1t' })
  assert.equal(seen1.added, true)

  const stats = await tool.execute({ action: 'stats' })
  assert.equal(stats.stats.items, 0)

  const bad = await tool.execute({ action: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /未知动作/)
})

test('渲染：错误与正常结果都能读', async () => {
  const { tool } = makeTool()
  const ok = await tool.execute({ action: 'stats' })
  const blocks = tool.output.render({}, ok)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /条目/)
  const errBlocks = tool.output.render({}, { ok: false, error: 'boom' })
  assert.match(errBlocks[0].text, /出错/)
})

test('bridge：配置解析与唤醒文案', async () => {
  const { default: _ } = {} // noop
  const { readBridgeConfig, buildWakeText } = await import('../lib/bridge.mjs')
  const home = tempHome()
  fs.writeFileSync(path.join(home, 'pond.config.json'), JSON.stringify({ bridge: { enabled: true, sessionId: 'bili-whale', actions: ['watch'], cooldownMs: 1000 } }))
  const cfg = readBridgeConfig(home)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.sessionId, 'bili-whale')
  assert.deepEqual(cfg.actions, ['watch'])
  const text = buildWakeText({ id: 'cmd_1', channel: 'qq', user: '主人', action: 'watch', args: { text: '去看 BV1xx' }, createdAt: new Date().toISOString() })
  assert.match(text, /隐私规则/)
  assert.match(text, /BV1xx/)
  assert.match(text, /cmd_1/)
})
