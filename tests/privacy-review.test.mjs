import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { observeInterestEvent } from '../lib/interests.mjs'
import { observeSemanticEvent, semanticAction } from '../lib/semantic-memory.mjs'
import { classifyPrivacy, classifyPrivacyLocal, configurePrivacyReview, createPrivacyReviewer } from '../lib/privacy-review.mjs'
import { whaleInterestProjection } from '../lib/whale-interest.mjs'
import { configureAutoMemory, createAutoMemoryObserver } from '../lib/auto-memory.mjs'

function setup() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pond-review-')), store=Pond.open(home); store.init()
  bindLearning(store,'session:owner','owner'); bindLearning(store,'session:watcher','watcher')
  store.tx(db=>{db.whaleInterestSharing={enabled:true}}); configurePrivacyReview(store,true)
  const event=(text,seq)=>({type:'user/message',seq,data:{source:{kind:'user'},content:[{type:'text',text}]}})
  return {store,home,event,session:{id:'owner'}}
}
function fake(value, calls=[]) { return { async *stream(options) { calls.push(options); yield {type:'text-delta',text:value}; yield {type:'finish',reason:{kind:'stop'}} } } }
test('独立无工具请求只返回严格类别，密码本地拦截，异常默认不共享', async () => {
  const calls=[], llm=fake('{"classification":"public_interest"}',calls)
  assert.equal(await classifyPrivacy(llm,'我想吃番茄炒蛋'),'public_interest')
  assert.equal(calls.length,1); assert.equal(calls[0].messages.length,1); assert.equal(calls[0].tools,undefined)
  assert.equal(await classifyPrivacy(llm,'家庭密码是 123456'),'unknown'); assert.equal(calls.length,1)
  assert.equal(await classifyPrivacy(fake('好的'),'我想吃番茄炒蛋'),'unknown')
  assert.equal(await classifyPrivacy(fake('{"classification":"public_interest","content":"secret"}'),'我想吃番茄炒蛋'),'unknown')
  const tool={async *stream(){yield {type:'tool-call-delta',text:'x'}}}; assert.equal(await classifyPrivacy(tool,'我想吃番茄炒蛋'),'unknown')
})
test('本地模型仅连固定回环地址，不允许重定向，失败时无云端回退', async () => {
  const calls=[]
  const fetchImpl=async (url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({done:true,message:{content:'{"classification":"private"}'}})}}
  assert.equal(await classifyPrivacyLocal('我想吃番茄炒蛋',fetchImpl),'private')
  assert.equal(calls[0].url,'http://127.0.0.1:11434/api/chat');assert.equal(calls[0].options.redirect,'error')
  assert.equal(await classifyPrivacyLocal('家庭密码123456',fetchImpl),'unknown');assert.equal(calls.length,1)
  assert.equal(await classifyPrivacyLocal('我想吃番茄炒蛋',async()=>{throw Error('offline')}),'unknown')
})
test('仅主人候选经过审查才产生可共享线索；分类器无权放行未知私聊文本', async () => {
  const {store,event,session}=setup(), e=event('我想吃番茄炒蛋',1)
  observeInterestEvent(store,session,e)
  assert.deepEqual(whaleInterestProjection(store.read()).keywords,[])
  const reviewer=createPrivacyReviewer(store,()=>fake('{"classification":"public_interest"}'))
  await reviewer.observe(session,e)
  assert.deepEqual(whaleInterestProjection(store.read()).keywords,['番茄炒蛋做法'])
  const saved=fs.readFileSync(store.file,'utf8'); assert.ok(!saved.includes('我想吃番茄炒蛋'))
  const e2=event('我想吃番茄炒蛋，那个数字是六五四三二一',2)
  observeInterestEvent(store,session,e2)
  await createPrivacyReviewer(store,()=>fake('{"classification":"private"}')).observe(session,e2)
  assert.deepEqual(whaleInterestProjection(store.read()).keywords,[])
  await reviewer.observe({id:'watcher'},event('我想吃番茄炒蛋',3))
  assert.equal(Object.keys(store.read().privacyReview.verdicts).length,2)
})
test('分类早于模型写入时仍可关联，敏感结果不写入兴趣，旧数据不会绕过分类', async () => {
  const {store,event,session}=setup(), e=event('我喜欢听古典音乐',1)
  observeSemanticEvent(store,session,e)
  await createPrivacyReviewer(store,()=>fake('{"classification":"public_interest"}')).observe(session,e)
  semanticAction(store,{principal:'session:owner',scopes:['learning:access']},{action:'semantic_observe',observationSubject:'古典音乐',observationDomain:'music',observationSignal:'like'})
  assert.deepEqual(whaleInterestProjection(store.read()).keywords,['音乐'])
  const e2=event('我想吃番茄炒蛋',2); observeSemanticEvent(store,session,e2)
  await createPrivacyReviewer(store,()=>fake('{"classification":"sensitive"}')).observe(session,e2)
  assert.throws(()=>semanticAction(store,{principal:'session:owner',scopes:['learning:access']},{action:'semantic_observe',observationSubject:'番茄炒蛋',observationDomain:'food',observationSignal:'want'}),/敏感/)
  store.tx(db=>{db.interestMemory={entries:[{subject:'番茄炒蛋',intent:'want',updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}],eventHashes:[]}})
  assert.ok(!whaleInterestProjection(store.read()).keywords.includes('番茄炒蛋做法'))
})

test('后台自动记忆与隐私复核无论哪个先完成，都不保留敏感结论', async () => {
  for (const reviewFirst of [true,false]) {
    const {store,event,session}=setup(),e=event('我喜欢古典音乐',reviewFirst?10:20)
    configureAutoMemory(store,true)
    const llm=fake('{"memory":{"topic":"古典音乐","evidence":"我喜欢古典音乐","kind":"like"}}')
    const worker=createAutoMemoryObserver(store,()=>llm)
    const reviewer=createPrivacyReviewer(store,()=>fake('{"classification":"sensitive"}'))
    await worker.observe(session,e)
    if (reviewFirst) await reviewer.observe(session,e)
    await worker.observe(session,{type:'turn/end',seq:e.seq+1,data:{reason:{kind:'completed'}}})
    if (!reviewFirst) await reviewer.observe(session,e)
    assert.equal(store.read().autoMemory.entries.length,0)
  }
})
