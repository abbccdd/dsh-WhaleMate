import { Pond } from '../lib/store.mjs'
import { whaleInterestProjection, configureWhaleInterestSharing, claimWhaleInterests } from '../lib/whale-interest.mjs'

try {
  const store = Pond.open(), action = process.argv[2] ?? 'project'
  if (action === 'enable' || action === 'disable') process.stdout.write(JSON.stringify(configureWhaleInterestSharing(store, action === 'enable')))
  else if (action === 'claim') process.stdout.write(JSON.stringify(claimWhaleInterests(store)))
  else if (action === 'project') process.stdout.write(JSON.stringify(whaleInterestProjection(store.read())))
  else if (action === 'status') process.stdout.write(JSON.stringify({ enabled: store.read().whaleInterestSharing?.enabled === true, candidates: whaleInterestProjection(store.read()).keywords.length }))
  else throw new Error('未知命令')
} catch {
  // Do not serialize file contents or exception text into a headless agent or log.
  process.stderr.write('无法读取已批准的选题线索\n')
  process.exitCode = 1
}
