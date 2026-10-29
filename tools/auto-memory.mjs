import { Pond } from '../lib/store.mjs'
import { configureAutoMemory } from '../lib/auto-memory.mjs'
try {
  const store=Pond.open(), action=process.argv[2]??'status'
  if (action==='enable'||action==='disable') console.log(JSON.stringify(configureAutoMemory(store,action==='enable')))
  else if(action==='status'){const state=store.read().autoMemory;console.log(JSON.stringify({enabled:state?.enabled===true,entries:state?.entries.length??0}))}
  else throw new Error('未知命令')
}catch{console.error('自动记忆配置失败');process.exitCode=1}
