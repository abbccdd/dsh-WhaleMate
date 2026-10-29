#!/usr/bin/env node
import { Pond } from '../lib/store.mjs'
import { prepareOwnerPairing, ownerStatus } from '../vendor/tencent-dsh-qqbot-owner/dist/owner-guard.js'
import { bindLearning } from '../lib/memory.mjs'
import { verifiedQQSession } from '../lib/qq-session.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

try {
  const store = Pond.open()
  store.init()
  const command = process.argv[2]
  let result
  if (command === 'prepare') result = prepareOwnerPairing(store.home)
  else if (command === 'status') result = { ok: true, ...ownerStatus(store.home) }
  else if (command === 'activate') {
    const state = JSON.parse(fs.readFileSync(path.join(store.home, 'qq-owner.json'), 'utf8'))
    const prefsFile = path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json')
    const prefs = fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : {}
    const sessionId = verifiedQQSession(state, prefs)
    bindLearning(store, 'session:' + sessionId, 'owner')
    const response = await fetch('http://127.0.0.1:3080/qqbot/im-qqbot/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: { c2cMode: 'allowlist', c2cAllow: [state.ownerOpenId], groupMode: 'disabled', groupAllow: [] }, debug: false }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('QQ 白名单配置失败')
    result = { ok: true, ownerBound: true, privateAllowlist: true, groupDisabled: true, memorySessionBound: true }
  } else result = { ok: false, error: '用法：qq-owner.mjs prepare | status | activate' }
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.ok) process.exitCode = 1
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: '主人配对初始化失败，请检查鱼塘目录或已有配对状态。' }) + '\n')
  process.exitCode = 1
}
