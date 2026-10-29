import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { storageStats } from '../lib/storage-stats.mjs'

test('只统计字节和文件数，超出阈值告警，不读取或修改会话内容', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pond-usage-')), dshHome=path.join(home,'.dsh')
  fs.mkdirSync(path.join(dshHome,'sessions','one'),{recursive:true})
  fs.mkdirSync(path.join(dshHome,'pond'),{recursive:true})
  const history=path.join(dshHome,'sessions','one','session.v4.jsonl.zstd')
  fs.writeFileSync(history,'fake-compressed-history')
  fs.writeFileSync(path.join(dshHome,'pond','pond.json'),'{}')
  const stats=storageStats({home,dshHome,threshold:3})
  assert.equal(stats.sessions.files,1);assert.equal(stats.sessions.bytes,23);assert.equal(stats.sessionsAboveThreshold,true)
  assert.equal(stats.pond.bytes,2);assert.equal(stats.reports.files,0)
  assert.equal(fs.readFileSync(history,'utf8'),'fake-compressed-history')
})
