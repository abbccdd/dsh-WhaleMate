import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { observeInterestEvent } from '../lib/interests.mjs'
import { whaleInterestProjection, claimWhaleInterests, configureWhaleInterestSharing, forgetWhaleInterestHistory } from '../lib/whale-interest.mjs'

const DAY = 86400000, now = Date.now(), updatedAt = new Date(now - DAY).toISOString()
function db() {
  return { whaleInterestSharing:{enabled:true}, learning:{bindings:{'session:qq':'owner','session:whale':'watcher'},preferences:{}}, interestMemory:{entries:[]}, semanticMemory:{entries:[]} }
}
test('从真实结构化兴趣投影固定选题，不带私人文本，默认关闭并可撤销', () => {
  const d = db()
  d.interestMemory.entries.push({subject:'番茄炒蛋',intent:'want',updatedAt,expiresAt:new Date(now+DAY).toISOString()})
  d.semanticMemory.entries.push({subject:'爸爸家的秘密',domain:'activity',signal:'like',updatedAt,expiresAt:new Date(now+DAY).toISOString()})
  const result = whaleInterestProjection(d,now)
  assert.ok(result.keywords.includes('番茄炒蛋做法'))
  assert.ok(!JSON.stringify(result).includes('爸爸家的秘密'))
  d.whaleInterestSharing.enabled=false
  assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
  d.whaleInterestSharing.enabled=true; d.learning.bindings['session:qq']='remove'
  assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
})
test('自动过期、冷却、纠正和遗忘后不会继续共享；不从单视频反馈推类别', () => {
  const d=db(), entry={subject:'番茄炒蛋',intent:'want',updatedAt,expiresAt:new Date(now+DAY).toISOString()}
  d.interestMemory.entries.push(entry)
  assert.deepEqual(whaleInterestProjection(d,now).keywords,['番茄炒蛋做法'])
  entry.lastUsedAt=new Date(now-DAY).toISOString(); assert.deepEqual(whaleInterestProjection(d,now).keywords,['番茄炒蛋做法'])
  entry.lastUsedAt=null; entry.suppressedUntil=new Date(now+DAY).toISOString(); assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
  entry.suppressedUntil=null; entry.intent='avoid'; assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
  entry.intent='want'; entry.expiresAt=new Date(now-DAY).toISOString(); assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
  d.interestMemory.entries=[]; d.recommendations={feedback:[{bvid:'BV1vJnN64E8Q',topic:'comedy',signal:'like'}]}
  assert.deepEqual(whaleInterestProjection(d,now).keywords,[])
})
test('刷站线索独立于私聊推荐冷却，同一词七天内最多进入一轮', () => {
  const d=db(); d.interestMemory.entries.push({subject:'番茄炒蛋',intent:'want',updatedAt,expiresAt:new Date(now+14*DAY).toISOString(),lastUsedAt:new Date(now).toISOString()})
  const store={tx:fn=>fn(d),_auditInto:()=>{}}
  assert.deepEqual(claimWhaleInterests(store,now).keywords,['番茄炒蛋做法'])
  assert.deepEqual(claimWhaleInterests(store,now+DAY).keywords,[])
  assert.deepEqual(claimWhaleInterests(store,now+8*DAY).keywords,['番茄炒蛋做法'])
  assert.ok(!JSON.stringify(d.whaleInterestSharing.recent).includes('番茄炒蛋'))
  forgetWhaleInterestHistory(d,{subject:'番茄炒蛋',domain:'food'})
  assert.deepEqual(d.whaleInterestSharing.recent,{})
})
test('只输出固定领域或经批准的分类，最多两个、不包含任意主题和敏感信息', () => {
  const d=db()
  d.semanticMemory.entries=[{subject:'住院私人细节',domain:'activity',signal:'like',updatedAt,expiresAt:new Date(now+DAY).toISOString()}, {subject:'神秘字符串',domain:'food',signal:'want',updatedAt,expiresAt:new Date(now+DAY).toISOString()}]
  d.learning.preferences.comedy={topic:'comedy',signal:'like',provenance:'owner-explicit',updatedAt}
  const r=whaleInterestProjection(d,now)
  assert.equal(r.keywords.length,2)
  assert.ok(r.keywords.every(x=>['生活方式','做饭教程','喜剧'].includes(x)))
  assert.ok(!JSON.stringify(r).includes('住院私人细节'))
  assert.ok(!JSON.stringify(r).includes('神秘字符串'))
})

