import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'tools', 'pond.mjs')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pond-cli-'))
}

async function run(home, args) {
  const { stdout } = await execFileP(process.execPath, [CLI, ...args], {
    env: { ...process.env, POND_HOME: home },
    cwd: path.dirname(CLI),
    timeout: 30_000,
  })
  return JSON.parse(stdout)
}

test('CLI：init 不打印 owner 令牌', async () => {
  const home = tempHome()
  const r = await run(home, ['init'])
  assert.equal(r.ok, true)
  assert.equal(r.ownerToken, undefined)
  assert.doesNotMatch(JSON.stringify(r), /dp_[a-f0-9]{48}/)
  assert.ok(fs.existsSync(path.join(home, 'pond.json')))
})

test('CLI：条目 add / dedupe / list / next / ack', async () => {
  const home = tempHome()
  await run(home, ['init'])
  const a = await run(home, ['item', 'add', '--kind', 'video', '--source', 'bili', '--bvid', 'BV1cli', '--title', '测试视频', '--dedupe'])
  assert.equal(a.ok, true)
  assert.equal(a.dup, false)
  const dup = await run(home, ['item', 'add', '--source', 'bili', '--bvid', 'BV1cli', '--dedupe'])
  assert.equal(dup.dup, true)
  const list = await run(home, ['item', 'list', '--q', '测试'])
  assert.equal(list.total, 1)
  const next = await run(home, ['next'])
  assert.equal(next.ok, true)
  assert.ok(next.item)
  assert.ok(next.item.id)
  const ack = await run(home, ['item', 'ack', next.item.id])
  assert.equal(ack.item.status, 'done')
  const left = await run(home, ['item', 'list', '--status', 'queued'])
  assert.equal(left.total, 0)
})

test('CLI：指令 / kv / seen', async () => {
  const home = tempHome()
  await run(home, ['init'])
  const c = await run(home, ['cmd', 'add', '--action', 'watch', '--text', '去看 BV1xx'])
  assert.equal(c.command.status, 'pending')
  const list = await run(home, ['cmd', 'list', '--status', 'pending'])
  assert.equal(list.total, 1)
  await run(home, ['cmd', 'done', c.command.id, '--result', '看了'])
  const done = await run(home, ['cmd', 'list', '--status', 'done'])
  assert.equal(done.total, 1)

  await run(home, ['kv', 'set', 'last-report', '{"n":1}'])
  const kv = await run(home, ['kv', 'get', 'last-report'])
  assert.deepEqual(kv.value, { n: 1 })

  const s1 = await run(home, ['seen', 'add', 'BV1cli'])
  assert.equal(s1.added, true)
  const s2 = await run(home, ['seen', 'add', 'BV1cli'])
  assert.equal(s2.added, false)
})

test('CLI：渠道 add / list / rotate / revoke', async () => {
  const home = tempHome()
  await run(home, ['init'])
  const add = await run(home, ['channel', 'add', 'qq', '--kind', 'qq'])
  assert.equal(add.ok, true)
  assert.ok(add.token.startsWith('dp_'))
  assert.equal(add.channel.kind, 'qq')
  const list = await run(home, ['channel', 'list'])
  assert.equal(list.channels.length, 1)
  assert.equal(list.channels[0].tokenHash, undefined) // 不回显哈希
  const rot = await run(home, ['channel', 'rotate', 'qq'])
  assert.ok(rot.token !== add.token)
  const rev = await run(home, ['channel', 'revoke', 'qq'])
  assert.equal(rev.ok, true)
  const list2 = await run(home, ['channel', 'list'])
  assert.equal(list2.channels.length, 0)
})

test('CLI：export / audit / wipe', async () => {
  const home = tempHome()
  await run(home, ['init'])
  await run(home, ['item', 'add', '--text', 'x'])
  const outFile = path.join(home, 'export.json')
  const exp = await run(home, ['export', '--out', outFile])
  assert.equal(exp.ok, true)
  assert.ok(fs.existsSync(outFile))
  const audit = await run(home, ['audit', '--limit', '5'])
  assert.ok(Array.isArray(audit.audit))
  const noConfirm = await run(home, ['wipe']).catch((e) => ({ ok: false, err: e }))
  assert.equal(noConfirm.ok, false)
  const wiped = await run(home, ['wipe', '--yes'])
  assert.equal(wiped.ok, true)
})

test('CLI：import-whale 解析 seen.md 表格', async () => {
  const home = tempHome()
  await run(home, ['init'])
  const md = path.join(home, 'seen.md')
  fs.writeFileSync(md, [
    '# 判重账本',
    '| 日期 | BV | 标题 | UP | 档位 | 深读程度 |',
    '|------|----|------|----|------|----------|',
    '| 2026-10-23 | BV1YRG46eE1n | AI 是什么 | 某UP | 值得看 | 深读 |',
    '| 2026-10-23 | BV1VkgK6NEZS | Harness 实测 | 某UP | 可以看 | 扫读 |',
    '| 2026-10-23 | BV1RP4y1G7mP | 没意思 | 某UP | 不值得 | 仅元信息 |',
  ].join('\n') + '\n', 'utf8')
  const r = await run(home, ['import-whale', '--file', md])
  assert.equal(r.ok, true)
  assert.equal(r.added, 3)
  const list = await run(home, ['item', 'list'])
  assert.equal(list.total, 2) // 只有「值得看 / 可以看」生成条目
  const seen = await run(home, ['seen', 'check', 'BV1RP4y1G7mP'])
  assert.equal(seen.seen, true)
})
