import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {reviewDigest} from '../tools/lib/comment-review.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
function sandbox(t,cfg={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-test-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'portable/profile')
  fs.mkdirSync(dsh,{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({owner:{mid:'222',name:'Owner'},listen:{comment:false,dm:false,live:false},...cfg}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'test-cookie-not-a-real-account',bili_jct:'a'.repeat(32)}))
  return {...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),TEST_REQUESTS:path.join(home,'requests.jsonl'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/mock-fetch.mjs')).href}
}
function run(env,file,args=[]) { const r=spawnSync(process.execPath,[path.join(root,file),...args],{env,encoding:'utf8',timeout:15000});assert.ifError(r.error);return r }
const requests=env=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8'):''
const args=['--msg','BV1234567890','--share','--go','--reason','这是值得分享的视频','--score','15','--rank','1']
test('public comments require a review bound to the exact text and target',t=>{
  const env=sandbox(t)
  const base=['--oid','123','--bvid','BV1234567890','--root','456','--parent','456','--message','只讨论视频','--go']
  let r=run(env,'tools/commands/comment.mjs',base)
  assert.notEqual(r.status,0);assert.match(r.stderr,/待审核/);assert.equal(requests(env),'')
  env.BILI_COMMENT_REVIEWED='incorrect'
  r=run(env,'tools/commands/comment.mjs',base)
  assert.notEqual(r.status,0);assert.equal(requests(env),'')
  env.BILI_COMMENT_REVIEWED=reviewDigest({oid:'123',bvid:'BV1234567890',root:'456',parent:'456',message:'只讨论视频'})
  const changed=base.slice();changed[changed.indexOf('--message')+1]='changed'
  r=run(env,'tools/commands/comment.mjs',changed)
  assert.notEqual(r.status,0);assert.equal(requests(env),'')
  r=run(env,'tools/commands/comment.mjs',base)
  assert.equal(r.status,0,r.stderr);assert.equal((requests(env).match(/"method":"POST"/g)??[]).length,1)
})
test('public reply scheduler uses an isolated model and mock sender',t=>{const r=run(sandbox(t),'tests/helpers/public-scheduler.mjs');assert.equal(r.status,0,r.stderr)})
test('notify dry never sends a DM',t=>{const env=sandbox(t,{notify:{type:'dm'}});const r=run(env,'tools/commands/notify.mjs',['preview','--dry']);assert.equal(r.status,0,r.stderr);assert.equal(requests(env),'')})
test('disabled DM share is rejected before network access',t=>{const env=sandbox(t,{share:{enabled:false}});const r=run(env,'tools/commands/dm.mjs',args);assert.notEqual(r.status,0);assert.equal(requests(env),'')})
test('unscored DM share is rejected before network access',t=>{const env=sandbox(t);const r=run(env,'tools/commands/dm.mjs',['--msg','BV1234567890','--share','--go']);assert.notEqual(r.status,0);assert.equal(requests(env),'')})
test('valid DM share works and repeated video is blocked',t=>{const env=sandbox(t,{share:{enabled:true},quota:{shareDaily:3}});const r=run(env,'tools/commands/dm.mjs',args);assert.equal(r.status,0,r.stderr);assert.equal((requests(env).match(/POST/g)??[]).length,1);const again=run(env,'tools/commands/dm.mjs',args);assert.notEqual(again.status,0);assert.equal((requests(env).match(/POST/g)??[]).length,1)})
test('ordinary owner DM does not require sharing score',t=>{const env=sandbox(t,{share:{enabled:false}});const r=run(env,'tools/commands/dm.mjs',['--msg','hello','--go']);assert.equal(r.status,0,r.stderr)})
test('comment uses the same score rule',t=>{const env=sandbox(t);const r=run(env,'tools/commands/comment.mjs',['--oid','1','--bvid','BV1234567890','--message','hello','--share','--auto','--go']);assert.notEqual(r.status,0);assert.equal(requests(env),'')})
test('custom home, persona, diary and failed approval recovery',t=>{const r=run(sandbox(t),'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stderr)})
test('successful approval removes draft',t=>{const env=sandbox(t);env.TEST_SEND_SUCCESS='1';const r=run(env,'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stderr)})
test('missing runtime reports scheduler failure',t=>{const env=sandbox(t);for(const key of Object.keys(env))if(['PATH','PROGRAMFILES','DSH_NODE','DSH_DESKTOP_NODE_EXECUTABLE'].includes(key.toUpperCase()))delete env[key];env.PATH=env.HOME;env.ProgramFiles=env.HOME;env.TEST_NO_NODE='1';const r=run(env,'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stdout+r.stderr)})
test('real scheduler: midnight, retries, history, persona and disposal',t=>{const r=run(sandbox(t),'tests/helpers/scheduler.mjs');assert.equal(r.status,0,r.stderr)})
test('DM delivery retries persisted message and acknowledges only after success',t=>{const r=run(sandbox(t),'tests/helpers/dm-delivery.mjs');assert.equal(r.status,0,r.stderr)})
test('dynamic root comment check uses type 11 and normalizes root zero',t=>{
 const env=sandbox(t)
 const r=run(env,'tools/commands/comment.mjs',['--oid','1','--root','0','--parent','9','--type','11','--check'])
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/是主人/);assert.doesNotMatch(requests(env),/POST/)
})
test('CLI plan is stable between processes',t=>{const env=sandbox(t);const a=run(env,'tools/commands/whale-night.mjs',['plan']);const b=run(env,'tools/commands/whale-night.mjs',['plan']);assert.equal(a.status,0,a.stderr);assert.deepEqual(JSON.parse(a.stdout),JSON.parse(b.stdout))})

test('digest uses custom config, exact identity and clean JSON on partial failure',t=>{
  const env=sandbox(t), now=Math.floor(Date.now()/1000)
  env.TEST_FEEDS=path.join(env.HOME,'feeds.json')
  const item=(id,mid,nickname)=>({id,user:{mid,nickname},reply_time:now,item:{source_content:'Owner 222 mentioned in text',source_id:id}})
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[item('1',999,'Owner'),item('2',222,'Renamed')],at:[]}))
  let r=run(env,'tools/commands/comment-digest.mjs',['--json']);assert.equal(r.status,0,r.stderr)
  let j=JSON.parse(r.stdout);assert.equal(j.ownerReplies,1);assert.equal(j.ownerReplyItems[0].id,'2')
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:{error:true},at:[]}))
  r=run(env,'tools/commands/comment-digest.mjs',['--json']);j=JSON.parse(r.stdout);assert.equal(j.ok,false);assert.equal(j.ownerReplies,0)
})
test('quota react does not refresh silence when an old result disappears',t=>{
  const env=sandbox(t), now=Math.floor(Date.now()/1000)-3600
  env.TEST_FEEDS=path.join(env.HOME,'feeds.json')
  const a={id:'1',user:{mid:222,nickname:'Owner'},reply_time:now,item:{source_content:'reply A',source_id:'1'}}
  const b={...a,id:'2',reply_time:now+10,item:{source_content:'reply B',source_id:'2'}}
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[a,b],at:[],like:[]}))
  let r=run(env,'tools/commands/quota.mjs',['react','--auto']);assert.equal(r.status,0,r.stderr)
  const file=path.join(env.HOME,'.bili-ai/feedback.json'),before=JSON.parse(fs.readFileSync(file))
  assert.equal(before.events.length,1);assert.equal(Date.parse(before.last),(now+10)*1000)
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[b],at:[],like:[]}))
  r=run(env,'tools/commands/quota.mjs',['react','--auto']);assert.equal(r.status,0,r.stderr)
  const after=JSON.parse(fs.readFileSync(file));assert.equal(after.last,before.last);assert.equal(after.events.length,1)
})
test('stable device ID reused across sends and persistence failure stops send',t=>{
  const env=sandbox(t), id=path.join(env.HOME,'.bili-ai/dev_id')
  assert.equal(run(env,'tools/commands/dm.mjs',['--msg','one','--go']).status,0)
  const first=fs.readFileSync(id,'utf8')
  assert.equal(run(env,'tools/commands/dm.mjs',['--msg','two','--go']).status,0)
  assert.equal(fs.readFileSync(id,'utf8'),first)
  fs.unlinkSync(id);fs.mkdirSync(id)
  assert.notEqual(run(env,'tools/commands/dm.mjs',['--msg','three','--go']).status,0)
  assert.equal((requests(env).match(/POST/g)??[]).length,2)
})

test('notify returns failure when DM delivery fails',t=>{
  const env=sandbox(t,{notify:{type:'dm'},owner:{mid:'',name:''}})
  const r=run(env,'tools/commands/notify.mjs',['summary'])
  assert.notEqual(r.status,0);assert.equal((requests(env).match(/POST/g)??[]).length,0)
})
