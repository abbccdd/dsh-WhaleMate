import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pond } from '../lib/store.mjs'
import { maintainPond } from '../lib/maintenance.mjs'

test('只整理过期的鱼塘短期记录，保留长期记忆、未过期记录和其他文件',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pond-clean-')),store=Pond.open(home);store.init()
  const now=Date.now(), old=new Date(now-1000).toISOString(), future=new Date(now+1000).toISOString()
  fs.writeFileSync(path.join(home,'diary.md'),'keep original')
  store.tx(db=>{
    db.interestMemory={entries:[{subject:'过期',expiresAt:old},{subject:'长期',expiresAt:null}],eventHashes:Array.from({length:1005},(_,i)=>String(i)),tutorialRequests:{a:now-1,b:now+1}}
    db.semanticMemory={entries:[{subject:'临时',expiresAt:old},{subject:'有效',expiresAt:future,sourceHash:'keep'}],eventHashes:[]}
    db.learning={bindings:{owner:'owner'},preferences:{music:{sourceHash:'permanent'}},videos:{BV1234567890:{rating:'worthwhile'}},hypothesisContexts:{a:{expiresAt:now-1}}}
    db.privacyReview={enabled:true,verdicts:{keep:{at:now-1000000},permanent:{at:now-1000000},unlinked:{at:now-1000000}}}
  })
  const result=maintainPond(store,now), d=store.read()
  assert.equal(result.expiredInterests,1);assert.equal(result.expiredSemantic,1);assert.equal(result.expiredVerdicts,1)
  assert.deepEqual(d.interestMemory.entries.map(x=>x.subject),['长期']);assert.equal(d.interestMemory.eventHashes.length,1000)
  assert.deepEqual(Object.keys(d.privacyReview.verdicts).sort(),['keep','permanent'])
  assert.equal(d.learning.videos.BV1234567890.rating,'worthwhile');assert.equal(fs.readFileSync(path.join(home,'diary.md'),'utf8'),'keep original')
  assert.ok(!fs.readFileSync(store.file,'utf8').includes('\n  "'))
})
