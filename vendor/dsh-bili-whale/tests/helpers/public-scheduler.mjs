import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const now = Math.floor(Date.now() / 1000)
const cfg = { listen: { comment: true, autoPublicReplies: true, allDay: true, scope: 'reply' }, night: { windows: [] } }
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
fs.writeFileSync(path.join(process.env.DSH_HOME, 'whale-listen.json'), JSON.stringify({ lastSeen: now - 10 }))
process.env.TEST_FEEDS = path.join(process.env.USERPROFILE, 'feeds.json')
fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({ reply: [{ id: '1', reply_time: now, user: { mid: '222', nickname: 'someone' }, item: { business_id: 1, subject_id: '123', root_id: '456', source_id: '456' } }] }))
const { startScheduler } = await import('../../lib/scheduler.js')
let calls = 0, sent = 0
const llm = { async *stream(request) { calls++; assert.equal(request.tools, undefined); assert.deepEqual(JSON.parse(request.messages[0].content[0].text), { public_comment: '这个反转太离谱了' }); yield { type: 'text-delta', text: '这反转确实够突然的' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
const controller = { create: async () => { throw Error('must not use private session') }, prompt: async () => { throw Error('must not use private session') } }
const scheduler = startScheduler({ llm, sessionController: controller }, { dshHome: process.env.DSH_HOME, biliMjs: 'unused', cwd: process.env.USERPROFILE,
  publicApiGet: async () => ({ code: 0, data: { root: { rpid: 456, mid: 222, content: { message: '这个反转太离谱了' } }, replies: [] } }),
  publicReplySend: async (args, env) => { sent++; assert.ok(env.BILI_COMMENT_REVIEWED); assert.equal(args[args.indexOf('--message') + 1], '这反转确实够突然的'); return { ok: true, out: 'code=0' } },
})
await scheduler.listenTick()
assert.equal(calls, 1); assert.equal(sent, 1)
assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'whale-public-replies.json'))).entries.length, 1)
scheduler.stop()
