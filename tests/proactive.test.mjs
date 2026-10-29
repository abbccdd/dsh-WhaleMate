import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { verifiedQQSession } from '../lib/qq-session.mjs'
import { configureProactive, proactiveStatus, createProactiveSharing, lastSuccessfulRound, makeShareMessage } from '../lib/proactive.mjs'
import { observeRecommendationEvent, feedbackScores } from '../lib/recommendations.mjs'

const base = path.resolve('待删除文件', '主动分享测试'); fs.mkdirSync(base, { recursive: true })
function fixture() {
  const home = fs.mkdtempSync(path.join(base, 'case-')), dshHome = path.join(home, 'dsh'), reports = path.join(home, 'reports')
  fs.mkdirSync(dshHome); fs.mkdirSync(reports)
  const store = Pond.open(path.join(home, 'pond')); store.init()
  const owner = { appId: 'test-app', ownerOpenId: 'owner-only' }; fs.writeFileSync(path.join(store.home, 'qq-owner.json'), JSON.stringify(owner))
  const principal = 'session:' + verifiedQQSession(owner); bindLearning(store, principal, 'owner')
  const current = Date.now(), d = new Date(current), pad = n => String(n).padStart(2,'0')
  const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const line = `${date} ${clock}  === 结束，exit=0 ===\n`
  fs.writeFileSync(path.join(dshHome, 'whale-round.log'), line)
  const report = '### BV1vJnN64E8Q\n- **标题**：一条虚构的趣味视频\n- **档位**：值得看（字幕）\n- **我自己的一句话**：我觉得这个反转很有趣。\n'
  fs.writeFileSync(path.join(reports, date + '.md'), report)
  store.tx(db => { db.whaleDocuments = { reports, diary: path.join(home,'diary.md') } })
  const calls = [], bot = { sendWakeup: async (target, text) => { calls.push({target,text}); return {id:'receipt'} } }
  const guard = { allowed: target => target.scope === 'c2c' && target.targetId === 'owner-only' }
  const worker = () => createProactiveSharing({store,bot,guard,appId:'test-app',dshHome,now:()=>current})
  return {home,dshHome,store,bot,calls,guard,principal,worker,date,current}
}

test('只认已完成成功的刷站轮次', () => {
  assert.equal(lastSuccessfulRound('2026-10-28 20:00:00  === 结束，exit=1 ==='), null)
  assert.equal(lastSuccessfulRound('2026-10-28 20:00:00  === 结束，exit=0 ===').date, '2026-10-28')
})

test('启用后的新成功轮次自动触发，失败轮次不触发', async () => {
  const f = fixture()
  configureProactive(f.store, {enabled:true}, f.dshHome)
  const d = new Date(f.current + 1000), pad = n => String(n).padStart(2,'0')
  const next = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  fs.appendFileSync(path.join(f.dshHome, 'whale-round.log'), `${next}  === 结束，exit=1 ===\n`)
  await f.worker().tick(); assert.equal(f.calls.length, 0)
  fs.appendFileSync(path.join(f.dshHome, 'whale-round.log'), `${next}  === 结束，exit=0 ===\n`)
  const worker = createProactiveSharing({store:f.store,bot:f.bot,guard:f.guard,appId:'test-app',dshHome:f.dshHome,now:()=>f.current + 2000})
  await worker.tick(); await worker.tick()
  assert.equal(f.calls.length, 1)
})

test('明确开启后只向唯一主人发送一次，送达后建立反馈关联', async () => {
  const f = fixture()
  configureProactive(f.store, {enabled:true}, f.dshHome)
  await f.worker().tick(); assert.equal(f.calls.length, 0)
  configureProactive(f.store, {enabled:true,requestTest:true}, f.dshHome)
  await f.worker().tick(); await f.worker().tick()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].target.targetId, 'owner-only')
  assert.match(f.calls[0].text, /BV1vJnN64E8Q/); assert.match(f.calls[0].text, /我觉得这个反转很有趣/)
  assert.equal(proactiveStatus(f.store).lastAttempt.status, 'sent')
  assert.equal(f.store.read().recommendations.suggestions.at(-1).delivery, 'sent')
  assert.equal(f.store.read().recommendations.suggestions.at(-1).principal, f.principal)
  observeRecommendationEvent(f.store, {id:f.principal.slice('session:'.length)}, {type:'user/message',seq:100,data:{source:{kind:'user'},content:[{type:'text',text:'这条不错'}]}}, f.current + 1000)
  const feedback = f.store.read().recommendations.feedback
  assert.equal(feedback.length, 1); assert.equal(feedback[0].bvid, 'BV1vJnN64E8Q'); assert.equal(feedback[0].signal, 'like')
  assert.equal(feedbackScores(feedback, f.current + 1000).get(feedback[0].topic) ?? 0, 0)
})

test('发送失败或回执不确定时不自动重试、不虚报成功', async () => {
  const f = fixture(); let calls = 0
  f.bot.sendWakeup = async () => { calls++; throw Object.assign(new Error('test'), {code:40034102}) }
  configureProactive(f.store, {enabled:true,requestTest:true}, f.dshHome)
  await f.worker().tick(); await f.worker().tick()
  assert.equal(calls, 1); assert.equal(proactiveStatus(f.store).lastAttempt.status, 'failed')
  assert.equal(f.store.read().recommendations?.suggestions?.length ?? 0, 0)
})

test('记录腾讯 SDK 的业务码而不保存可能包含隐私的错误文本', async () => {
  const f=fixture()
  f.bot.sendWakeup=async()=>{throw Object.assign(new Error('包含隐私的错误内容'),{httpStatus:400,bizCode:40034102})}
  configureProactive(f.store,{enabled:true,requestTest:true},f.dshHome)
  await f.worker().tick()
  assert.match(proactiveStatus(f.store).lastAttempt.reason,/40034102/)
  assert.doesNotMatch(fs.readFileSync(f.store.file,'utf8'),/包含隐私的错误内容/)
})

test('QQ 召回周期达到上限时展示明确原因', async () => {
  const f=fixture()
  f.bot.sendWakeup=async()=>{throw Object.assign(new Error('不可保存的内容'),{httpStatus:400,bizCode:40034122})}
  configureProactive(f.store,{enabled:true,requestTest:true},f.dshHome)
  await f.worker().tick()
  assert.match(proactiveStatus(f.store).lastAttempt.reason,/平台当前周期上限/)
  assert.match(proactiveStatus(f.store).lastAttempt.reason,/40034122/)
})

test('冷却期间保留真实新轮次，到期后最多发送一次', async () => {
  const f=fixture(), day=86400000
  f.store.tx(db=>{db.proactiveSharing={enabled:true,activatedAt:new Date(f.current-2*day).toISOString(),lastRound:'old',attempts:[{id:'previous',at:new Date(f.current-23*3600000).toISOString(),status:'sent',bvid:'BV1Adno6REXP'}],whaleRound:{id:'whale:1:20',at:new Date(f.current-1000).toISOString(),items:[{bvid:'BV1vJnN64E8Q',date:f.date}]}}})
  let now=f.current
  const worker=createProactiveSharing({store:f.store,bot:f.bot,guard:f.guard,appId:'test-app',dshHome:f.dshHome,now:()=>now})
  await worker.tick(); assert.equal(f.calls.length,0); assert.equal(f.store.read().proactiveSharing.lastRound,'old')
  now+=3600000; await worker.tick(); await worker.tick()
  assert.equal(f.calls.length,1); assert.match(f.calls[0].text,/BV1vJnN64E8Q/)
})

test('主人明确发起的立即测试仅发送一次并标记测试，不产生反馈关联', async () => {
  const f=fixture()
  f.store.tx(db=>{db.proactiveSharing={enabled:true,activatedAt:new Date(f.current-1000).toISOString(),lastRound:'old',attempts:[{id:'previous',at:new Date(f.current).toISOString(),status:'sent',bvid:'BV1Adno6REXP'}],whaleRound:{id:'whale:1:20',at:new Date(f.current).toISOString(),items:[{bvid:'BV1vJnN64E8Q',date:f.date}]}}})
  configureProactive(f.store,{enabled:true,requestTest:true,forceTest:true},f.dshHome)
  await f.worker().tick();await f.worker().tick()
  assert.equal(f.calls.length,1);assert.match(f.calls[0].text,/^【分享链路测试】/);assert.equal(f.store.read().proactiveSharing.attempts.at(-1).test,true)
  assert.equal(f.store.read().recommendations.suggestions.at(-1).closed,true)
  observeRecommendationEvent(f.store,{id:f.principal.slice(8)}, {type:'user/message',seq:5,data:{source:{kind:'user'},content:[{type:'text',text:'这条不错'}]}}, f.current+1000)
  assert.equal(f.store.read().recommendations.feedback.length,0)
})

test('立即测试过期后不发送，也不覆盖待分享轮次', async () => {
  const f=fixture();configureProactive(f.store,{enabled:true,requestTest:true,forceTest:true},f.dshHome)
  const worker=createProactiveSharing({store:f.store,bot:f.bot,guard:f.guard,appId:'test-app',dshHome:f.dshHome,now:()=>Date.now()+121000})
  const previous=f.store.read().proactiveSharing.lastRound
  await worker.tick();assert.equal(f.calls.length,0);assert.equal(f.store.read().proactiveSharing.lastRound,previous);assert.equal(f.store.read().proactiveSharing.pendingTest,false)
})

test('主动接口测试仅发给已绑定主人，并不会降级使用召回接口', async () => {
  const f=fixture(), active=[]
  f.bot.sendText=async(target,text)=>{active.push({target,text});return {id:'receipt'}}
  configureProactive(f.store,{enabled:true,requestTest:true,forceTest:true,testTransport:'active'},f.dshHome)
  await f.worker().tick();await f.worker().tick()
  assert.equal(active.length,1);assert.equal(f.calls.length,0);assert.equal(active[0].target.targetId,'owner-only')
  assert.match(active[0].text,/^【分享链路测试】/);assert.equal(f.store.read().proactiveSharing.attempts.at(-1).transport,'active')
  assert.equal(f.store.read().proactiveSharing.transport,'active')
})

test('主动接口验证成功后，新的自动轮次使用该接口且维持主人绑定', async () => {
  const f=fixture(), active=[]
  f.bot.sendText=async(target,text)=>{active.push({target,text});return {id:'receipt'}}
  f.store.tx(db=>{db.proactiveSharing={enabled:true,transport:'active',activatedAt:new Date(f.current-1000).toISOString(),lastRound:'old',attempts:[],whaleRound:{id:'whale:1:20',at:new Date(f.current).toISOString(),items:[{bvid:'BV1vJnN64E8Q',date:f.date}]}}})
  await f.worker().tick();await f.worker().tick()
  assert.equal(active.length,1);assert.equal(f.calls.length,0);assert.equal(active[0].target.targetId,'owner-only');assert.doesNotMatch(active[0].text,/分享链路测试/)
})

test('未经授权或主人身份不匹配不会发送；敏感内容不能成为分享文案', async () => {
  const f = fixture(); configureProactive(f.store, {enabled:true,requestTest:true}, f.dshHome)
  const worker = createProactiveSharing({store:f.store,bot:f.bot,guard:{allowed:()=>false},appId:'test-app',dshHome:f.dshHome,now:()=>f.current})
  await worker.tick(); assert.equal(f.calls.length, 0)
  assert.throws(() => makeShareMessage({title:'虚构视频',impression:'家庭密码是123456',bvid:'BV1vJnN64E8Q'}), /不适合/)
})
