import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionControllerFor, requestRejectionFor } from '../lib/host-compat.js'

test('new API wraps payload/rpcId, preserves queue semantics, and rejects business failures', async () => {
  const calls = []
  const sessions = Object.fromEntries(['create', 'prompt'].map(method => [method, async request => {
    calls.push({ method, request })
    return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
  }]))
  const controller = sessionControllerFor({ get: key => key === 'apiProxy' ? { sessions } : undefined })
  await controller.create({ sessionId: 'bili-whale', cwd: 'C:/work' })
  await controller.prompt({ sessionId: 'bili-whale', requestId: 'message-1', mode: 'queue', content: [{ type: 'text', text: 'test' }] })
  assert.equal(calls[1].request.rpcId, 'message-1')
  assert.equal(calls[1].request.payload.mode, 'queue')
  assert.equal(calls[1].request.payload.requestId, undefined)
  sessions.prompt = async () => ({ result: { ok: false, error: { code: 'model-unavailable', message: 'test failure' } } })
  await assert.rejects(controller.prompt({ requestId: 'message-2' }), /model-unavailable.*test failure/)
  const abort = new AbortController(); abort.abort()
  assert.throws(() => controller.prompt({}, abort.signal), /abort/i)
  assert.throws(() => sessionControllerFor({ get: () => undefined }), /会话 API/)
})

test('legacy controller and trust check remain usable', () => {
  const legacy = {}
  assert.equal(sessionControllerFor({ get: key => key === 'sessionController' ? legacy : undefined }), legacy)
  assert.equal(requestRejectionFor({ requestRejection: () => 403 }, { headers: {} }), 403)
})

test('modern HTTP routes accept local same-origin requests and refuse foreign origins', () => {
  const connection = { rpc: { handle() {} } }
  const check = headers => requestRejectionFor(connection, { headers })
  assert.equal(check({ host: '127.0.0.1:3080' }), undefined)
  assert.equal(check({ host: 'localhost:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' }), undefined)
  for (const headers of [
    { host: 'evil.example:3080' },
    { host: '127.0.0.1:3080', origin: 'https://evil.example' },
    { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3081' },
    { host: '127.0.0.1:3080', origin: 'null' },
    { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-site' },
  ]) assert.equal(check(headers), 403)
  assert.equal(requestRejectionFor(undefined, { headers: {} }), 503)
})
