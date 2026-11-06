/** Daily source totals. Components overlap in some providers; never add them to totalTokens. */
export type TokenDay = {
  date: string
  totalTokens: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  models?: { name: string; totalTokens: number }[]
}

export type TokenUsageReport = {
  status: "ok" | "unavailable" | "invalid" | "unverified"
  timezone: "Asia/Taipei"
  source: "local-logs"
  accountScope: "local-directory"
  sourceId?: string
  sourceVersion?: string
  days: TokenDay[]
  reason?: string
}

export type TokenPeriod = "week" | "previous" | "recent"
const ZONE = "Asia/Taipei"
const safeCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export const validDayKey = (key: string) => /^\d{4}-\d{2}-\d{2}$/.test(key) &&
  Number.isFinite(Date.parse(`${key}T00:00:00Z`)) && new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) === key

export function taipeiDay(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value
  return `${get("year")}-${get("month")}-${get("day")}`
}

export function shiftDay(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function tokenPeriodRange(period: TokenPeriod, now = Date.now()) {
  const today = taipeiDay(now)
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  const monday = shiftDay(today, -((weekday + 6) % 7))
  return period === "previous" ? { start: shiftDay(monday, -7), end: shiftDay(monday, -1) }
    : period === "recent" ? { start: shiftDay(today, -6), end: today }
      : { start: monday, end: today }
}

/** Reject conflicting daily snapshots; summing an already aggregated day would double count. */
export function validatedDays(report?: TokenUsageReport): TokenDay[] | null {
  if (!report || report.status !== "ok" || report.timezone !== ZONE || report.source !== "local-logs" || report.accountScope !== "local-directory" || !Array.isArray(report.days)) return null
  const days = new Map<string, TokenDay>()
  for (const raw of report.days) {
    if (!raw || typeof raw.date !== "string" || !validDayKey(raw.date) || !safeCount(raw.totalTokens)) return null
    const day: TokenDay = { date: raw.date, totalTokens: raw.totalTokens }
    for (const key of ["inputTokens", "outputTokens", "cachedTokens"] as const) {
      if (raw[key] !== undefined) {
        if (!safeCount(raw[key])) return null
        day[key] = raw[key]
      }
    }
    if (raw.models !== undefined) {
      if (!Array.isArray(raw.models)) return null
      const names = new Set<string>()
      day.models = []
      for (const model of raw.models) {
        if (!model || typeof model.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/.test(model.name) || names.has(model.name) || !safeCount(model.totalTokens)) return null
        names.add(model.name)
        day.models.push({ name: model.name, totalTokens: model.totalTokens })
      }
      day.models.sort((a, b) => a.name.localeCompare(b.name))
      if (!safeCount(day.models.reduce((sum, model) => sum + model.totalTokens, 0)) || day.models.reduce((sum, model) => sum + model.totalTokens, 0) > day.totalTokens) return null
    }
    const existing = days.get(day.date)
    if (existing && JSON.stringify(existing) !== JSON.stringify(day)) return null
    days.set(day.date, day)
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function summarizeTokens(report: TokenUsageReport | undefined, period: TokenPeriod, now = Date.now()) {
  const range = tokenPeriodRange(period, now)
  const valid = validatedDays(report)
  const byDate = new Map(valid?.map((day) => [day.date, day]))
  const days: { date: string; data: TokenDay | null }[] = []
  for (let date = range.start; date <= range.end; date = shiftDay(date, 1)) days.push({ date, data: byDate.get(date) ?? null })
  const known = days.flatMap((day) => day.data ? [day.data] : [])
  const total = known.reduce((sum, day) => sum + day.totalTokens, 0)
  const totalTokens = valid && known.length > 0 && safeCount(total) ? total : null
  const models = new Map<string, number>()
  let classified = 0
  for (const day of known) for (const model of day.models ?? []) {
    models.set(model.name, (models.get(model.name) ?? 0) + model.totalTokens)
    classified += model.totalTokens
  }
  return { ...range, days, totalTokens, knownDays: known.length, missingDays: days.length - known.length,
    models: [...models].map(([name, tokens]) => ({ name, totalTokens: tokens })).sort((a, b) => b.totalTokens - a.totalTokens),
    unclassifiedTokens: totalTokens === null ? null : totalTokens - classified,
  }
}
