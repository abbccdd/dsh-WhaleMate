/** Owner memory retrieval: adapted from Towzai/dsh-memory dynamic gate and
 * BayInl/dsh-memory CJK bigram fallback. See THIRD_PARTY_NOTICES.md. */
const SMALL_TALK = /^(好|行|嗯|好的|可以|继续|是的|对|收到|明白|了解|ok|okay|sure|yes|no)[。！!\s]*$/iu
const MEMORY_SIGNAL = /记住|记得|记忆|上次|之前|偏好|喜欢|想吃|忘记|remember|memory/iu

export function shouldRetrieveMemory(text, domainMatches = false) {
  const query = text.trim()
  if (!query || SMALL_TALK.test(query)) return false
  if (/^(我|俺|咱)?(已|已经|刚|刚刚)?(重启|完成|搞定|弄好|做好|结束|好了|启动了|装好|恢复)/u.test(query)) return false
  if (/测试|试试|试一下|看看效果/u.test(query) && /别管|不用管|只是|算了|忽略|无视/u.test(query)) return false
  return query.length >= 5 || domainMatches || MEMORY_SIGNAL.test(query)
}

function bigrams(text) {
  const out = new Set()
  for (const run of text.normalize('NFKC').match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/** Content relevance is mandatory; recency/confidence break ties only. */
export function rankMemoryHints(query, entries, domainMatches, now = Date.now(), limit = 3) {
  if (!shouldRetrieveMemory(query, entries.some(row => domainMatches(row.domain, query)))) return []
  const grams = bigrams(query)
  return entries.map(row => {
    let overlap = 0
    for (const gram of bigrams(row.subject)) if (grams.has(gram)) overlap++
    const exact = query.includes(row.subject) ? 1 : 0
    const domain = domainMatches(row.domain, query) ? 1 : 0
    const relevant = exact || overlap || domain
    if (!relevant) return null
    const age = Math.max(0, now - Date.parse(row.updatedAt))
    const base = Math.min(0.6, row.observations * 0.2)
    const confidence = Number((base * 2 ** (-age / ((row.stable ? 365 : 45) * 86400000))).toFixed(3))
    if (!(confidence >= 0.05)) return null
    return { row, confidence, rank: exact * 100 + overlap * 10 + domain * 2 + confidence }
  }).filter(Boolean).sort((a, b) => b.rank - a.rank || b.row.updatedAt.localeCompare(a.row.updatedAt)).slice(0, limit)
    .map(({ row, confidence }) => ({ subject: row.subject, domain: row.domain, signal: row.signal, confidence }))
}
