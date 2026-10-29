import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initialize } from '../tools/initialize.mjs'

const run=promisify(execFile)
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
let installing=false

export async function installCompanions(options={}) {
  if (installing) throw Object.assign(new Error('正在安装，请稍候'),{status:409})
  installing=true
  try {
    const env=options.env ?? process.env
    const dshHome=env.DSH_HOME || path.join(os.homedir(),'.dsh')
    const manifest=path.join(dshHome,'profiles','web','package.json')
    const profile=JSON.parse(fs.readFileSync(manifest,'utf8'))
    const components=[['dsh-bili-whale',path.join(root,'vendor','dsh-bili-whale')],['@tencent-connect/dsh-qqbot',path.join(root,'vendor','tencent-dsh-qqbot-owner')]]
    const pending=[]
    for(const [name,dir] of components) {
      if(!fs.existsSync(path.join(dir,'package.json'))) throw new Error('鲸伴安装包缺少配套组件')
      const existing=profile.dependencies?.[name]
      if(existing) {
        const normalize=s=>s.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()
        if(normalize(existing)!==normalize('file:'+dir)) throw Object.assign(new Error(`已安装不同来源的 ${name}，请先备份并处理版本冲突`),{status:409})
      } else pending.push(dir)
    }
    const cli=options.cli ?? process.argv[1]
    if(!cli || !fs.existsSync(cli) || !/[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/i.test(cli)) throw Object.assign(new Error('此 DSH 运行方式暂不支持界面安装配套组件；请使用 DSH Web'),{status:409})
    for(const dir of pending) {
      try { await (options.run ?? run)(process.execPath,[cli,'plugin','--profile','web','add','file:'+dir,'--ignore-scripts'],{env,timeout:180000,maxBuffer:1024*1024,windowsHide:true}) }
      catch { throw Object.assign(new Error('配套组件安装失败，请检查网络和 DSH 插件管理环境后重试'),{status:409}) }
    }
    initialize(env)
    return {ok:true,installed:pending.length,restartRequired:pending.length>0}
  } finally {installing=false}
}
