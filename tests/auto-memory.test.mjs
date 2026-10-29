import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { observeSemanticEvent, semanticAction } from '../lib/semantic-memory.mjs'
import { observeInterestEvent } from '../lib/interests.mjs'
import { configureAutoMemory, createAutoMemoryObserver, autoMemoryHints, autoMemoryList, extractOwnerMemory } from '../lib/auto-memory.mjs'
import { maintainPond } from '../lib/maintenance.mjs'

function setup() {
  const store=Pond.open(fs.mkdtempSync(path.join(os.tmpdir(),'pond-auto-')));store.init();bindLearning(store,'session:owner','owner');bindLearning(store,'session:watcher','watcher');configureAutoMemory(store,true)
  const event=(text,seq)=>({type:'user/message',seq,data:{source:{kind:'user'},content:[{type:'text',text}]}})
  return {store,event,owner:{id:'owner'}}
}
function fake(row,calls=[]) { return {async *stream(opts){calls.push(opts);yield {type:'text-delta',text:JSON.stringify({memory:row})};yield {type:'finish',reason:{kind:'stop'}}}} }
const turn=(seq=2)=>({type:'turn/end',seq,data:{reason:{kind:'completed'}}})
test('回复完成后后台提取真实原话片段，跨会话相关时召回；不向刷站会话提供',async()=>{
  const {store,event,owner}=setup(),calls=[]
  const worker=createAutoMemoryObserver(store,()=>fake({topic:'仙人掌',evidence:'我最近在养仙人掌',kind:'activity'},calls))
  await worker.observe(owner,event('我最近在养仙人掌',1));assert.equal(calls.length,0)
  await worker.observe(owner,turn());assert.equal(calls.length,1);assert.equal(calls[0].tools,undefined)
  assert.equal(store.read().autoMemory.entries[0].topic,'仙人掌')
  assert.equal(autoMemoryHints(store,'session:owner','仙人掌怎么养')[0].evidence,'我最近在养仙人掌')
  assert.equal(autoMemoryHints(store,'session:owner','给我讲讲怎么给植物浇水')[0].topic,'仙人掌')
  assert.deepEqual(autoMemoryHints(store,'session:watcher','仙人掌怎么养'),[])
  assert.deepEqual(autoMemoryHints(store,'session:owner','今天打什么游戏'),[])
  assert.throws(()=>autoMemoryList(store,{principal:'session:watcher',scopes:['learning:access']}),/主人/)
  await worker.observe(owner,turn(3));assert.equal(calls.length,1)
})
test('不提取敏感、猜测、伪造原话、无关消息或未完成回合',async()=>{
  const {store,event,owner}=setup(),calls=[]
  const worker=createAutoMemoryObserver(store,()=>fake({topic:'仙人掌',evidence:'我最近在养仙人掌',kind:'activity'},calls))
  for(const [i,text] of ['我家密码是123456','我想吃番茄炒蛋，那个密码是123456','我朋友想养仙人掌','我最近在养仙人掌吗？','好'].entries()){await worker.observe(owner,event(text,i+1));await worker.observe(owner,turn(i+20))}
  assert.equal(calls.length,0)
  assert.equal(await extractOwnerMemory(fake({topic:'仙人掌',evidence:'我喜欢养仙人掌',kind:'like'}),'我最近在养仙人掌'),null)
  await worker.observe(owner,event('我最近在养仙人掌',30));await worker.observe(owner,{type:'turn/end',seq:31,data:{reason:{kind:'failed'}}})
  assert.equal(calls.length,0);assert.equal(store.read().autoMemory.entries.length,0)
})
test('同主题纠正、重复事件、主人遗忘和到期清理',async()=>{
  const {store,event,owner}=setup();let clock=Date.now();let value={topic:'仙人掌',evidence:'我最近在养仙人掌',kind:'activity'}
  const worker=createAutoMemoryObserver(store,()=>fake(value),{now:()=>clock})
  await worker.observe(owner,event('我最近在养仙人掌',1));await worker.observe(owner,turn(2))
  await worker.observe(owner,event('我最近在养仙人掌',1));await worker.observe(owner,turn(3));assert.equal(store.read().autoMemory.entries.length,1)
  clock+=1000;value={topic:'仙人掌',evidence:'我不喜欢仙人掌',kind:'avoid'}
  await worker.observe(owner,event('我不喜欢仙人掌',4));await worker.observe(owner,turn(5))
  assert.equal(store.read().autoMemory.entries[0].kind,'avoid')
  observeSemanticEvent(store,owner,event('忘记仙人掌',6),clock)
  assert.equal(semanticAction(store,{principal:'session:owner',scopes:['learning:access']},{action:'semantic_forget',observationSubject:'仙人掌'},clock).forgotten,true)
  assert.equal(store.read().autoMemory.entries.length,0)
  clock+=1000;value={topic:'仙人掌',evidence:'我最近在养仙人掌',kind:'activity'}
  await worker.observe(owner,event('我最近在养仙人掌',7));await worker.observe(owner,turn(8))
  maintainPond(store,clock+181*86400000);assert.equal(store.read().autoMemory.entries.length,0)
})
test('现有做饭规则已经记下时，不额外调用模型以节省 token',async()=>{
  const {store,event,owner}=setup(),calls=[],e=event('我想吃番茄炒蛋',1)
  const worker=createAutoMemoryObserver(store,()=>fake(null,calls))
  observeInterestEvent(store,owner,e);await worker.observe(owner,e);await worker.observe(owner,turn());assert.equal(calls.length,0)
})
test('提取过程中主人发了新消息，旧结果不会在之后偷偷写入',async()=>{
  const {store,event,owner}=setup();let release
  const barrier=new Promise(resolve=>{release=resolve})
  const worker=createAutoMemoryObserver(store,()=>({async *stream(){await barrier;yield {type:'text-delta',text:JSON.stringify({memory:{topic:'仙人掌',evidence:'我最近在养仙人掌',kind:'activity'}})};yield {type:'finish',reason:{kind:'stop'}}}}))
  await worker.observe(owner,event('我最近在养仙人掌',1));const pending=worker.observe(owner,turn(2))
  await worker.observe(owner,event('忘记仙人掌',3));release();await pending
  assert.equal(store.read().autoMemory.entries.length,0)
})
test('允许常见 3D 建模兴趣，但数字密钥仍不能入模型或记忆',async()=>{
  const calls=[],llm=fake({topic:'3d建模',evidence:'我最近想学3d建模',kind:'want'},calls)
  assert.equal((await extractOwnerMemory(llm,'我最近想学3d建模')).topic,'3d建模')
  assert.equal(await extractOwnerMemory(llm,'我想学3d建模，我的数字是123456'),null)
  assert.equal(calls.length,1)
})
test('省略主语的自然接话也能提炼，不当成做饭',async()=>{
  const calls=[],llm=fake({topic:'游戏人物角色',evidence:'想做游戏人物角色',kind:'want'},calls)
  assert.equal((await extractOwnerMemory(llm,'想做游戏人物角色，mod这类的')).topic,'游戏人物角色')
  assert.equal(calls.length,1)
})
test('用有限近期上下文理解省略，证据必须来自当前消息且不落盘上下文',async()=>{
  const {store,event,owner}=setup(),calls=[]
  const worker=createAutoMemoryObserver(store,()=>fake({topic:'3d建模',evidence:'想做游戏人物角色',kind:'want'},calls))
  await worker.observe(owner,event('我最近想学3d建模',1))
  await worker.observe(owner,event('想做游戏人物角色，mod这类的',2))
  await worker.observe(owner,turn(3))
  const body=JSON.parse(calls[0].messages[0].content[0].text)
  assert.deepEqual(body.context,['我最近想学3d建模'])
  assert.equal(store.read().autoMemory.entries[0].topic,'3d建模')
  assert.equal(store.read().autoMemory.entries[0].evidence,'想做游戏人物角色')
  assert.ok(!fs.readFileSync(store.file,'utf8').includes('我最近想学3d建模'))
  assert.equal(await extractOwnerMemory(fake({topic:'三维人物',evidence:'想做游戏人物角色',kind:'want'}),'想做游戏人物角色，mod这类的',['我最近想学3d建模']),null)
})
test('主人能要求忘记包含 3D 的兴趣',async()=>{
  const {store,event,owner}=setup()
  const worker=createAutoMemoryObserver(store,()=>fake({topic:'3d建模',evidence:'我最近想学3d建模',kind:'want'}))
  await worker.observe(owner,event('我最近想学3d建模',1));await worker.observe(owner,turn(2))
  observeSemanticEvent(store,owner,event('忘记3d建模',3))
  assert.equal(semanticAction(store,{principal:'session:owner',scopes:['learning:access']},{action:'semantic_forget',observationSubject:'3d建模'}).forgotten,true)
})

test('跨天重复的明确偏好长期保留，临时意愿暂停召回，纠正和遗忘生效',async()=>{
  const {store,event,owner}=setup(); let clock=Date.now(), value={topic:'仙人掌',evidence:'我喜欢仙人掌',kind:'like'}
  const worker=createAutoMemoryObserver(store,()=>fake(value),{now:()=>clock})
  await worker.observe(owner,event('我喜欢仙人掌',1));await worker.observe(owner,turn(2))
  clock+=1000;await worker.observe(owner,event('我喜欢仙人掌',3));await worker.observe(owner,turn(4))
  assert.equal(store.read().autoMemory.entries[0].stable,false)
  clock+=86400000;await worker.observe(owner,event('我喜欢仙人掌',5));await worker.observe(owner,turn(6))
  let row=store.read().autoMemory.entries[0];assert.equal(row.stable,true);assert.equal(row.expiresAt,null)
  maintainPond(store,clock+500*86400000)
  assert.equal(autoMemoryHints(store,'session:owner','仙人掌怎么样',clock+500*86400000)[0].topic,'仙人掌')
  clock+=1000;value={topic:'仙人掌',evidence:'我现在不想养仙人掌',kind:'avoid'}
  await worker.observe(owner,event('我现在不想养仙人掌',7));await worker.observe(owner,turn(8))
  row=store.read().autoMemory.entries[0];assert.equal(row.kind,'like');assert.equal(row.stable,true)
  assert.deepEqual(autoMemoryHints(store,'session:owner','仙人掌怎么样',clock),[])
  clock+=1000;value={topic:'仙人掌',evidence:'我不喜欢仙人掌',kind:'avoid'}
  await worker.observe(owner,event('我不喜欢仙人掌',9));await worker.observe(owner,turn(10))
  row=store.read().autoMemory.entries[0];assert.equal(row.kind,'avoid');assert.equal(row.stable,false)
  observeSemanticEvent(store,owner,event('忘记仙人掌',11),clock)
  assert.equal(semanticAction(store,{principal:'session:owner',scopes:['learning:access']},{action:'semantic_forget',observationSubject:'仙人掌'},clock).forgotten,true)
})

test('不同记忆入口的明确纠正不会让旧的相反偏好复活',async()=>{
  const {store,event,owner}=setup(); const now=Date.now(), identity={principal:'session:owner',scopes:['learning:access']}
  observeSemanticEvent(store,owner,event('我喜欢听古典音乐',1),now)
  semanticAction(store,identity,{action:'semantic_observe',observationSubject:'古典音乐',observationDomain:'music',observationSignal:'like'},now)
  const worker=createAutoMemoryObserver(store,()=>fake({topic:'古典音乐',evidence:'我不喜欢古典音乐',kind:'avoid'}),{now:()=>now+1000})
  await worker.observe(owner,event('我不喜欢古典音乐',2));await worker.observe(owner,turn(3))
  assert.equal(store.read().semanticMemory.entries.length,0)
  assert.equal(store.read().autoMemory.entries[0].kind,'avoid')
  observeSemanticEvent(store,owner,event('我喜欢古典音乐',4),now+2000)
  semanticAction(store,identity,{action:'semantic_observe',observationSubject:'古典音乐',observationDomain:'music',observationSignal:'like'},now+2000)
  assert.equal(store.read().autoMemory.entries.length,0)
  assert.equal(store.read().semanticMemory.entries[0].signal,'like')
})
