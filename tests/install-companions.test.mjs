import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {installCompanions} from '../lib/install-companions.mjs'

function fixture() {
  const base=path.resolve('待删除文件','界面安装测试');fs.mkdirSync(base,{recursive:true})
  const home=fs.mkdtempSync(path.join(base,'case-')), dsh=path.join(home,'.dsh'),profile=path.join(dsh,'profiles','web')
  fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dependencies:{}}))
  const cli=path.join(process.env.APPDATA,'npm','node_modules','@deepseek-ai','dsh','lib','bin.js')
  return {home,dsh,profile,cli,env:{...process.env,USERPROFILE:home,DSH_HOME:dsh}}
}
test('界面安装只调用两个附带组件并保留已有资料',async()=>{
  const f=fixture(),calls=[];fs.writeFileSync(path.join(f.dsh,'whale-diary.md'),'原有日记')
  const result=await installCompanions({env:f.env,cli:f.cli,run:async(_node,args)=>{calls.push(args)}})
  assert.equal(result.installed,2);assert.equal(calls.length,2);assert.ok(calls.every(x=>x.includes('--ignore-scripts')))
  assert.equal(fs.readFileSync(path.join(f.dsh,'whale-diary.md'),'utf8'),'原有日记')
})
test('已有其他来源的插件时不执行安装',async()=>{
  const f=fixture(),calls=[];fs.writeFileSync(path.join(f.profile,'package.json'),JSON.stringify({dependencies:{'dsh-bili-whale':'github:other/plugin'}}))
  await assert.rejects(()=>installCompanions({env:f.env,cli:f.cli,run:async()=>calls.push(1)}),/不同来源/)
  assert.equal(calls.length,0)
})
