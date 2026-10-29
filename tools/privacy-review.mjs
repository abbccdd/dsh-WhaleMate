import { Pond } from '../lib/store.mjs'
import { configurePrivacyReview } from '../lib/privacy-review.mjs'
try {
  const store=Pond.open(), command=process.argv[2] ?? 'status'
  if (command === 'enable' || command === 'disable') console.log(JSON.stringify(configurePrivacyReview(store,command === 'enable',process.argv[3] ?? 'deepseek')))
  else if (command === 'status') { const p=store.read().privacyReview; console.log(JSON.stringify({enabled:p?.enabled === true, backend:p?.backend ?? null, reviewed:Object.keys(p?.verdicts ?? {}).length})) }
  else throw new Error('未知命令')
} catch { console.error('隐私分类配置失败'); process.exitCode=1 }
