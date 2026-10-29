/** Compact only fishpond-owned expired metadata; do not touch user files or DSH history. */
const DAY = 86400000
export function maintainPond(store, now = Date.now()) {
  return store.tx(db => {
    const counts = {expiredInterests:0,expiredSemantic:0,expiredContexts:0,expiredVerdicts:0,trimmedHashes:0,expiredCooldowns:0}
    const expired = row => typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) <= now
    if (db.interestMemory) {
      const m=db.interestMemory, before=m.entries.length
      m.entries=m.entries.filter(row => !expired(row)); counts.expiredInterests=before-m.entries.length
      if (m.eventHashes.length>1000) { counts.trimmedHashes += m.eventHashes.length-1000; m.eventHashes=m.eventHashes.slice(-1000) }
      for (const [key, value] of Object.entries(m.tutorialRequests ?? {})) if (Number.isSafeInteger(value) && value <= now) {delete m.tutorialRequests[key]; counts.expiredContexts++}
    }
    if (db.semanticMemory) {
      const m=db.semanticMemory, before=m.entries.length
      m.entries=m.entries.filter(row => !expired(row)); counts.expiredSemantic=before-m.entries.length
      if (m.eventHashes.length>1000) { counts.trimmedHashes += m.eventHashes.length-1000; m.eventHashes=m.eventHashes.slice(-1000) }
    }
    if (db.autoMemory) {
      const m=db.autoMemory, before=m.entries.length
      m.entries=m.entries.filter(row => !expired(row)); counts.expiredSemantic+=before-m.entries.length
      if (m.seenEvents.length>1000) { counts.trimmedHashes+=m.seenEvents.length-1000; m.seenEvents=m.seenEvents.slice(-1000) }
    }
    for (const [key, value] of Object.entries(db.learning?.hypothesisContexts ?? {})) if (Number.isSafeInteger(value.expiresAt) && value.expiresAt <= now) {delete db.learning.hypothesisContexts[key]; counts.expiredContexts++}
    for (const [key, value] of Object.entries(db.whaleInterestSharing?.recent ?? {})) if (Number.isFinite(value) && value + 7*DAY <= now) {delete db.whaleInterestSharing.recent[key]; counts.expiredCooldowns++}
    if (db.privacyReview?.verdicts) {
      const refs = new Set([...(db.interestMemory?.entries ?? []), ...(db.semanticMemory?.entries ?? []), ...(db.autoMemory?.entries ?? []), ...Object.values(db.learning?.preferences ?? {})].map(row=>row.sourceHash).filter(Boolean))
      for (const [hash, row] of Object.entries(db.privacyReview.verdicts)) if (!refs.has(hash) && Number.isFinite(row.at) && row.at + 10*60*1000 <= now) {delete db.privacyReview.verdicts[hash]; counts.expiredVerdicts++}
    }
    db.maintenance = {lastRunAt:new Date(now).toISOString()}
    store._auditInto(db,{actor:'system',action:'maintenance:completed',detail:JSON.stringify(counts)})
    return counts
  })
}
