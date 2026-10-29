import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { createWhaleRoundObserver } from '../lib/whale-round-observer.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { verifiedQQSession } from '../lib/qq-session.mjs'
import { createProactiveSharing } from '../lib/proactive.mjs'

const root=path.resolve('待删除文件','生物钟集成测试');fs.mkdirSync(root,{recursive:true})
function setup() {
  const home=fs.mkdtempSync(path.join(root,'case-')),dshHome=path.join(home,'dsh'),reports=path.join(home,'reports'),frames=path.join(dshHome,'shots','video')
  fs.mkdirSync(frames,{recursive:true});fs.mkdirSync(reports)
  const store=Pond.open(path.join(home,'pond'));store.init()
  const binding={appId:'test-app',ownerOpenId:'owner-only'};fs.writeFileSync(path.join(store.home,'qq-owner.json'),JSON.stringify(binding))
  bindLearning(store,'session:'+verifiedQQSession(binding),'owner')
  const now=Date.now(),date=new Date(now).toLocaleDateString('en-CA')
  store.tx(db=>{db.whaleDocuments={reports};db.proactiveSharing={enabled:true,activatedAt:new Date(now-1000).toISOString(),attempts:[]}})
  const file=path.join(reports,date+'.md'), report=(id,title)=>`### ${id}\n- **标题**：${title}\n- **档位**：值得看（字幕）\n- **我自己的一句话**：我觉得反转有趣。\n`
  fs.writeFileSync(file,report('BV1Adno6REXP','之前的虚构视频'))
  const observer=createWhaleRoundObserver(store,{dshHome,now:()=>now})
  const send=(type,data={},seq=1,session='bili-whale')=>observer.observe({id:session},{type,data,seq})
  return {store,dshHome,frames,file,report,send,now}
}
test('生物钟成功且报告出现新条目后，仅对新视频向主人分享',async()=>{
  const f=setup(),frame=path.join(f.frames,'BV1vJnN64E8Q-2026-10-29T10-05-49-123Z-4x4.jpg'),subs=frame.replace('-4x4.jpg','-subs.jpg'),video=frame.replace('-4x4.jpg','.mp4'),unrelated=path.join(f.frames,'other.jpg')
  for(const p of [frame,subs,video,unrelated])fs.writeFileSync(p,'x')
  f.send('turn/start',{turn:1});f.send('user/message',{source:{kind:'user'},content:[{type:'text',text:'【生物钟】你醒了'}]})
  f.send('tool/call',{name:'read_image',callId:'c1',arguments:{file_path:frame}})
  f.send('tool/result',{message:{source:{callId:'c1'},content:[{type:'tool-result',isError:false}]}})
  fs.appendFileSync(f.file,f.report('BV1vJnN64E8Q','新的虚构视频'))
  f.send('turn/end',{turn:1,reason:{kind:'completed'}},22)
  assert.equal(fs.existsSync(frame),false);assert.equal(fs.existsSync(subs),false);assert.equal(fs.existsSync(video),false);assert.equal(fs.existsSync(unrelated),true)
  const calls=[];const bot={sendWakeup:async(target,text)=>{calls.push({target,text});return {id:'ok'}}}
  const worker=createProactiveSharing({store:f.store,bot,guard:{allowed:x=>x.targetId==='owner-only'},appId:'test-app',dshHome:f.dshHome,now:()=>f.now+1000})
  await worker.tick();await worker.tick();assert.equal(calls.length,1);assert.match(calls[0].text,/BV1vJnN64E8Q/);assert.doesNotMatch(calls[0].text,/BV1Adno6REXP/)
})
test('跳过、失败和没有新报告的轮次都不触发；开关可保留临时图片',()=>{
  const f=setup(),frame=path.join(f.frames,'BV1vJnN64E8Q-2026-10-29T10-05-49-123Z-4x4.jpg');fs.writeFileSync(frame,'x')
  const start=(marker,turn)=>{f.send('turn/start',{turn});f.send('user/message',{source:{kind:'user'},content:[{type:'text',text:marker}]});f.send('tool/call',{name:'read_image',callId:'x',arguments:{file_path:frame}});f.send('tool/result',{message:{source:{callId:'x'},content:[{type:'tool-result',isError:false}]}})}
  start('【生物钟】你醒了',1);f.send('turn/end',{turn:1,reason:{kind:'completed'}},2);assert.equal(f.store.read().proactiveSharing.whaleRound,undefined);assert.equal(fs.existsSync(frame),true)
  start('【今晚不看】',2);fs.appendFileSync(f.file,f.report('BV1vJnN64E8Q','新视频'));f.send('turn/end',{turn:2,reason:{kind:'completed'}},3);assert.equal(f.store.read().proactiveSharing.whaleRound,undefined)
  start('【生物钟】你醒了',3);fs.appendFileSync(f.file,f.report('BV1sZYDzHEU8','新视频二'));f.send('turn/end',{turn:3,reason:{kind:'failed'}},4);assert.equal(f.store.read().proactiveSharing.whaleRound,undefined)
  const video=frame.replace('-4x4.jpg','.mp4');fs.writeFileSync(video,'x')
  f.store.tx(db=>{db.whaleMedia={cleanFrames:false,cleanVideos:false}})
  start('【生物钟】你醒了',4);fs.appendFileSync(f.file,f.report('BV1u3Hy6FEYC','新视频三'));f.send('turn/end',{turn:4,reason:{kind:'completed'}},5);assert.equal(fs.existsSync(frame),true);assert.equal(fs.existsSync(video),true);assert.equal(f.store.read().proactiveSharing.whaleRound.items.length,1)
})
test('只观察设置中指定的生物钟会话，旧会话不触发',()=>{
  const f=setup()
  fs.writeFileSync(path.join(f.dshHome,'bili-whale.config.json'),JSON.stringify({night:{sessionId:'bili-whale-v2'}}))
  const marker={source:{kind:'user'},content:[{type:'text',text:'【生物钟】你醒了'}]}
  f.send('turn/start',{turn:1},1,'bili-whale'); f.send('user/message',marker,2,'bili-whale')
  fs.appendFileSync(f.file,f.report('BV1vJnN64E8Q','旧会话视频'))
  f.send('turn/end',{turn:1,reason:{kind:'completed'}},3,'bili-whale')
  assert.equal(f.store.read().proactiveSharing.whaleRound,undefined)
  f.send('turn/start',{turn:2},4,'bili-whale-v2'); f.send('user/message',marker,5,'bili-whale-v2')
  fs.appendFileSync(f.file,f.report('BV1sZYDzHEU8','新会话视频'))
  f.send('turn/end',{turn:2,reason:{kind:'completed'}},6,'bili-whale-v2')
  assert.deepEqual(f.store.read().proactiveSharing.whaleRound.items.map(x=>x.bvid),['BV1sZYDzHEU8'])
})
test('原版排版的真实报告格式可贯通生物钟和 QQ 分享',async()=>{
  const f=setup()
  f.send('turn/start',{turn:1}); f.send('user/message',{source:{kind:'user'},content:[{type:'text',text:'【生物钟】你醒了'}]})
  fs.appendFileSync(f.file,'### BV1vJnN64E8Q\n- 《虚构群聊故事》/ 作者 / **值得看（18/20）**\n- 我自己的一句话：这条的反转很有趣。\n')
  f.send('turn/end',{turn:1,reason:{kind:'completed'}},20)
  const calls=[],worker=createProactiveSharing({store:f.store,bot:{sendWakeup:async(target,text)=>{calls.push({target,text});return{id:'ok'}}},guard:{allowed:x=>x.targetId==='owner-only'},appId:'test-app',dshHome:f.dshHome,now:()=>f.now+1000})
  await worker.tick()
  assert.equal(calls.length,1); assert.match(calls[0].text,/虚构群聊故事/); assert.match(calls[0].text,/BV1vJnN64E8Q/)
})
