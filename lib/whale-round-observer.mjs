/** Observe the existing whale session; only completed, changed report entries form a round. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reportCandidates } from './recommendations.mjs'

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function snapshot(store) {
  const directory = store.read().whaleDocuments?.reports
  if (!directory) return new Map()
  return new Map(reportCandidates(directory).map(row => [row.bvid, {hash:digest(row), date:row.date}]))
}
function content(event) {
  const blocks=event.data?.content
  return typeof blocks==='string' ? blocks : Array.isArray(blocks) ? blocks.filter(x=>x?.type==='text').map(x=>x.text).join('\n') : ''
}
export function createWhaleRoundObserver(store,{dshHome=process.env.DSH_HOME || path.join(os.homedir(),'.dsh'),now=()=>Date.now()}={}) {
  let active=null
  const videoDir=path.resolve(dshHome,'shots','video')
  const configFile=process.env.BILI_WHALE_CONFIG || path.join(dshHome,'bili-whale.config.json')
  function whaleSessionId() {
    try { return JSON.parse(fs.readFileSync(configFile,'utf8')).night?.sessionId || 'bili-whale' }
    catch (error) { if (error.code==='ENOENT') return 'bili-whale'; throw error }
  }
  function observe(session,event) {
    if (!['turn/start','user/message','tool/call','tool/result','turn/end'].includes(event?.type)) return
    if ((session?.id ?? session?.header?.id)!==whaleSessionId()) return
    if (event?.type==='turn/start') { active={turn:event.data?.turn,before:snapshot(store),woken:false,calls:new Map(),read:new Set()}; return }
    if (!active) return
    if (event.type==='user/message' && ['user','plugin'].includes(event.data?.source?.kind) && content(event).includes('【生物钟】')) active.woken=true
    if (event.type==='tool/call' && event.data?.name==='read_image') {
      let args=event.data.arguments
      if (typeof args==='string') { try {args=JSON.parse(args)} catch{return} }
      if (typeof args?.file_path!=='string' || typeof event.data.callId!=='string') return
      const file=path.resolve(args.file_path),name=path.basename(file)
      if (path.dirname(file).toLowerCase()===videoDir.toLowerCase() && /^BV[0-9A-Za-z]{10}-\d{4}-\d\d-\d\dT[0-9-]+Z-(?:3x3|4x4|subs)\.jpg$/i.test(name)) active.calls.set(event.data.callId,file)
    }
    if (event.type==='tool/result') {
      const id=event.data?.message?.source?.callId,file=active.calls.get(id)
      if (file && !event.data?.error && event.data?.message?.content?.some(x=>x?.type==='tool-result' && x.isError===false)) active.read.add(file)
      active.calls.delete(id)
    }
    if (event.type!=='turn/end') return
    const round=active;active=null
    if (!round.woken || event.data?.reason?.kind!=='completed' || (event.data.turn!==undefined && event.data.turn!==round.turn)) return
    const after=snapshot(store)
    const changed=[...after].filter(([id,row])=>row.hash!==round.before.get(id)?.hash)
    if (!changed.length) return
    const at=new Date(now()).toISOString(), id=`whale:${round.turn}:${event.seq}`
    store.tx(db=>{
      if (db.proactiveSharing?.enabled!==true) return
      db.proactiveSharing.whaleRound={id,at,items:changed.map(([bvid,row])=>({bvid,date:row.date}))}
      store._auditInto(db,{actor:'system',action:'whale:completed',detail:String(changed.length)})
    })
    const policy=store.read().whaleMedia ?? {},files=new Set()
    for (const file of round.read) {
      if (policy.cleanFrames!==false) {files.add(file);if (/-(?:3x3|4x4)\.jpg$/i.test(file)) files.add(file.replace(/-(?:3x3|4x4)\.jpg$/i,'-subs.jpg'))}
      if (policy.cleanVideos!==false && /-(?:3x3|4x4)\.jpg$/i.test(file)) files.add(file.replace(/-(?:3x3|4x4)\.jpg$/i,'.mp4'))
    }
    for (const file of files) {
      try {const stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink())fs.unlinkSync(file)} catch(error) {if(error.code!=='ENOENT')throw error}
    }
  }
  return {observe,stop(){active=null}}
}
