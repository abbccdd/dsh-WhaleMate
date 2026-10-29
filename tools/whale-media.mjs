#!/usr/bin/env node
import { Pond } from '../lib/store.mjs'
const action=process.argv[2] ?? 'status',store=Pond.open()
if (!['status','clean','keep','clean-video','keep-video'].includes(action)) { process.stderr.write('用法：whale-media.mjs status|clean|keep|clean-video|keep-video\n');process.exitCode=1 }
else if (action==='status') process.stdout.write(JSON.stringify({cleanFrames:store.read().whaleMedia?.cleanFrames!==false,cleanVideos:store.read().whaleMedia?.cleanVideos!==false})+'\n')
else {
  const field=action.endsWith('-video')?'cleanVideos':'cleanFrames',enabled=action.startsWith('clean')
  store.tx(db=>{db.whaleMedia={...(db.whaleMedia??{}),[field]:enabled};store._auditInto(db,{actor:'owner',action:'whale-media:'+action})})
  process.stdout.write(JSON.stringify({[field]:enabled})+'\n')
}
