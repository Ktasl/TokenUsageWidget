import { shiftDay, taipeiDay, validatedDays, validDayKey, type TokenDay, type TokenUsageReport } from "@/lib/token-report"

export const USAGE_HISTORY_KEY = "tokenusagewidget.usage-history.v1"
export const HISTORY_DAYS = 180
export type UsageHistoryScope = {
  providerId: string
  sourceId: string
  timezone: "Asia/Taipei"
  sourceVersion?: string
  observedAt: string
  days: TokenDay[]
}
export type UsageHistory = { version: 1; scopes: UsageHistoryScope[] }
export type ReportSnapshot = { providerId: string; report?: TokenUsageReport }
export type HistoryStorage = Pick<Storage, "getItem" | "setItem">
export const emptyUsageHistory = (): UsageHistory => ({ version: 1, scopes: [] })
const providerPattern = /^[a-z][a-z0-9_-]{0,63}$/
const opaquePattern = /^[A-Za-z0-9_-]{8,128}$/
const versionPattern = /^[A-Za-z0-9._-]{1,64}$/
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/

/** Model identifiers may enter exports; reject paths, emails and arbitrary text. */
function safeDays(report?: TokenUsageReport): TokenDay[] | null {
  const days = validatedDays(report)
  if (!days || days.some((day) => day.models?.some((model) => !modelPattern.test(model.name)))) return null
  return days
}

export function reportScope(snapshot: ReportSnapshot): string | null {
  const { providerId, report } = snapshot
  return providerPattern.test(providerId) && report && opaquePattern.test(report.sourceId ?? "") &&
    report.timezone === "Asia/Taipei" && report.source === "local-logs" && report.accountScope === "local-directory"
    ? `${providerId}:${report.sourceId}:Asia/Taipei` : null
}
const scopeKey = (scope: UsageHistoryScope) => `${scope.providerId}:${scope.sourceId}:${scope.timezone}`

/** Rebuild from a strict whitelist, including when loading a modified localStorage value. */
export function validateUsageHistory(value: unknown): UsageHistory {
  if (!value || typeof value !== "object") throw new Error("歷史資料格式無效，未讀取或覆寫原資料。")
  const raw = value as UsageHistory
  if (raw.version !== 1 || !Array.isArray(raw.scopes) || raw.scopes.length > 100) throw new Error("歷史資料版本或格式無效，未覆寫原資料。")
  const keys = new Set<string>()
  const scopes = raw.scopes.map((scope) => {
    if (!scope || !providerPattern.test(scope.providerId) || !opaquePattern.test(scope.sourceId) ||
      scope.timezone !== "Asia/Taipei" || !validDayKey(scope.observedAt) ||
      (scope.sourceVersion !== undefined && !versionPattern.test(scope.sourceVersion))) throw new Error("歷史資料來源識別無效，未覆寫原資料。")
    const days = safeDays({ status: "ok", timezone: scope.timezone, source: "local-logs", accountScope: "local-directory", days: scope.days })
    if (!days || days.length > HISTORY_DAYS) throw new Error("歷史每日統計無效，未覆寫原資料。")
    const result: UsageHistoryScope = { providerId: scope.providerId, sourceId: scope.sourceId,
      timezone: "Asia/Taipei", observedAt: scope.observedAt, days }
    if (scope.sourceVersion) result.sourceVersion = scope.sourceVersion
    const key = scopeKey(result)
    if (keys.has(key)) throw new Error("歷史來源重複，未覆寫原資料。")
    keys.add(key)
    return result
  })
  return { version: 1, scopes }
}

export function loadUsageHistory(storage: HistoryStorage): UsageHistory {
  let raw: string | null
  try { raw = storage.getItem(USAGE_HISTORY_KEY) } catch { throw new Error("無法讀取本機歷史，請檢查儲存空間或存取權限。") }
  if (raw === null) return emptyUsageHistory()
  try { return validateUsageHistory(JSON.parse(raw)) } catch { throw new Error("本機歷史格式無效，已保留原資料；暫停歷史儲存。") }
}

export function saveUsageHistory(storage: HistoryStorage, history: UsageHistory) {
  const safe = validateUsageHistory(history)
  try { storage.setItem(USAGE_HISTORY_KEY, JSON.stringify(safe)) } catch { throw new Error("無法儲存本機歷史，請檢查儲存空間或存取權限。") }
}

/** Each day is a complete source snapshot. Never increment a stored daily total. */
export function captureUsageHistory(history: UsageHistory, reports: ReportSnapshot[], today = taipeiDay()): UsageHistory {
  const cutoff = shiftDay(today, 1 - HISTORY_DAYS)
  const scopes = new Map<string, UsageHistoryScope>()
  for (const scope of validateUsageHistory(history).scopes) {
    const days = scope.days.filter((day) => day.date >= cutoff && day.date <= today)
    if (days.length) scopes.set(scopeKey(scope), { ...scope, days })
  }
  for (const snapshot of reports) {
    const key = reportScope(snapshot)
    const days = safeDays(snapshot.report)
    if (!key || !days) continue
    const retained = days.filter((day) => day.date >= cutoff && day.date <= today)
    if (!retained.length) continue
    const existing = scopes.get(key)
    const merged = new Map(existing?.days.map((day) => [day.date, day]))
    for (const day of retained) merged.set(day.date, day)
    const scope: UsageHistoryScope = { providerId: snapshot.providerId, sourceId: snapshot.report!.sourceId!,
      timezone: "Asia/Taipei", observedAt: today, days: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)) }
    const version = snapshot.report?.sourceVersion
    if (version && versionPattern.test(version)) scope.sourceVersion = version
    scopes.set(key, scope)
  }
  return { version: 1, scopes: [...scopes.values()].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b))) }
}

export function currentUsageHistory(history: UsageHistory, reports: ReportSnapshot[]): UsageHistory {
  const active = new Set(reports.map(reportScope).filter(Boolean))
  return { version: 1, scopes: validateUsageHistory(history).scopes.filter((scope) => active.has(scopeKey(scope))) }
}

export function monthlyUsage(scope: UsageHistoryScope | undefined, today = taipeiDay()) {
  const currentStart = `${today.slice(0, 7)}-01`
  const previousEnd = shiftDay(currentStart, -1)
  const previousStart = `${previousEnd.slice(0, 7)}-01`
  const summarize = (start: string, end: string) => {
    const known = scope?.days.filter((day) => day.date >= start && day.date <= end) ?? []
    const expectedDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
    const sum = known.reduce((total, day) => total + day.totalTokens, 0)
    return { start, end, totalTokens: known.length && Number.isSafeInteger(sum) ? sum : null,
      knownDays: known.length, expectedDays, complete: known.length === expectedDays }
  }
  return { current: summarize(currentStart, today), previous: summarize(previousStart, previousEnd) }
}

/** Do not include raw reports, errors, reason strings, private paths or account metadata. */
export function usageStatusJson(history: UsageHistory, reports: ReportSnapshot[], today = taipeiDay()) {
  return JSON.stringify({ version: 1, timezone: "Asia/Taipei", generatedOn: today, accountScope: "local-directory",
    providers: reports.filter((item) => providerPattern.test(item.providerId)).map((item) => {
      const report = item.report
      const days = safeDays(report)
      return { providerId: item.providerId, status: days ? "ok" : ["unavailable", "invalid", "unverified"].includes(report?.status ?? "") ? report!.status : "unavailable",
        source: "local-logs", days: days?.filter((day) => day.date <= today) ?? [] }
    }), history: currentUsageHistory(history, reports) }, null, 2)
}

const csvCell = (value: string | number | undefined) => {
  const raw = String(value ?? "")
  return `"${(/^[\s]*[=+@-]/.test(raw) ? "'" : "") + raw.replace(/"/g, '""')}"`
}
export function usageHistoryCsv(history: UsageHistory): string {
  const rows: (string | number | undefined)[][] = [["provider", "source_id", "source_version", "timezone", "observed_on", "date", "total_tokens", "input_tokens", "output_tokens", "cached_tokens", "models_json"]]
  for (const scope of validateUsageHistory(history).scopes) for (const day of scope.days) rows.push([
    scope.providerId, scope.sourceId, scope.sourceVersion, scope.timezone, scope.observedAt, day.date, day.totalTokens, day.inputTokens, day.outputTokens,
    day.cachedTokens, day.models?.length ? JSON.stringify(day.models) : undefined,
  ])
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"
}
