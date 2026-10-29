/** Retain repeated explicit preferences without turning short-lived wants into personality. */
const DAY = 86400000
const temporaryLanguage = /最近|近期|现在|今天|这几天|这段时间|暂时|目前|这次|一下/u

export function memoryIsCurrent(row, now) {
  return row.stable === true || (typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) > now)
}

export function updateMemoryLifecycle(previous, signal, text, now, temporary = signal === 'want') {
  const same = previous?.signal === signal || previous?.kind === signal
  const previousAt = Date.parse(previous?.updatedAt)
  const explicitPreference = (signal === 'like' || signal === 'avoid') && !temporary && !temporaryLanguage.test(text)
  const independentlyRepeated = same && Number.isFinite(previousAt) && now - previousAt >= DAY && previous?.explicitPreference === true
  const stable = explicitPreference && (previous?.stable === true && same || independentlyRepeated)
  return {
    stable,
    explicitPreference,
    observations: same ? Math.min((previous.observations ?? 0) + 1, 3) : 1,
    updatedAt: new Date(now).toISOString(),
    expiresAt: stable ? null : new Date(now + (temporary ? 14 : 180) * DAY).toISOString(),
  }
}
