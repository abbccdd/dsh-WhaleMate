import { Pond } from '../lib/store.mjs'
import { configureProactive, proactiveStatus } from '../lib/proactive.mjs'

const store = Pond.open()
const action = process.argv[2] || 'status'
try {
  let result
  if (action === 'status') result = proactiveStatus(store)
  else if (action === 'enable') result = configureProactive(store, { enabled: true })
  else if (action === 'disable') result = configureProactive(store, { enabled: false })
  else if (action === 'test') result = configureProactive(store, { enabled: true, requestTest: true })
  else if (action === 'test-now') result = configureProactive(store, { enabled: true, requestTest: true, forceTest: true })
  else if (action === 'test-active') result = configureProactive(store, { enabled: true, requestTest: true, forceTest: true, testTransport: 'active' })
  else throw new Error('用法：proactive.mjs status | enable | disable | test | test-now | test-active')
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1 }
