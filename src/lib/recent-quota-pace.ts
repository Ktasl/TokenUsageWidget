import { formatCompactDuration } from "@/lib/pace-tooltip"

export const RECENT_QUOTA_MAX_GAP_MS = 10 * 60_000
export const RECENT_QUOTA_MIN_GAP_MS = 30_000
export type QuotaObservation = { providerId: string; metric: string; used: number; limit: number;
  resetsAt: number; periodDurationMs: number; observedAt: number; sourceId?: string }
export type RecentQuotaState = { current: QuotaObservation; ratePerMs?: number }
export type RecentQuotaForecast = { runsOutText: string | null; detailText: string }

function valid(value: QuotaObservation, now: number) {
  return value.providerId.length > 0 && [value.used, value.limit, value.resetsAt, value.periodDurationMs, value.observedAt, now].every(Number.isFinite) &&
    value.used >= 0 && value.limit > value.used && value.periodDurationMs > 0 && value.resetsAt > now &&
    value.observedAt <= now && now - value.observedAt <= RECENT_QUOTA_MAX_GAP_MS &&
    value.observedAt > value.resetsAt - value.periodDurationMs
}

/** Per-process observations only. Repeated renders of one source timestamp are not samples. */
export function observeQuota(previous: RecentQuotaState | undefined, current: QuotaObservation, now: number): RecentQuotaState {
  if (!valid(current, now)) return { current }
  if (previous && previous.current.observedAt === current.observedAt && JSON.stringify(previous.current) === JSON.stringify(current)) return previous
  const before = previous?.current
  const interval = before ? current.observedAt - before.observedAt : 0
  const comparable = before && before.providerId === current.providerId && before.metric === current.metric &&
    before.sourceId === current.sourceId &&
    before.limit === current.limit && before.resetsAt === current.resetsAt && before.periodDurationMs === current.periodDurationMs &&
    valid(before, current.observedAt) && interval >= RECENT_QUOTA_MIN_GAP_MS && interval <= RECENT_QUOTA_MAX_GAP_MS && current.used > before.used
  return comparable ? { current, ratePerMs: (current.used - before.used) / interval } : { current }
}

export function recentQuotaForecast(state: RecentQuotaState, now: number, mode: "left" | "used"): RecentQuotaForecast | null {
  const current = state.current
  if (!valid(current, now) || !state.ratePerMs || !Number.isFinite(state.ratePerMs) || state.ratePerMs <= 0) return null
  const untilReset = current.resetsAt - now
  const eta = (current.limit - current.used) / state.ratePerMs
  if (eta > 0 && eta < untilReset) {
    const duration = formatCompactDuration(eta)
    if (duration) return { runsOutText: `近期速度估計 ${duration}後用盡`, detailText: `依最近兩次更新增量估計，約 ${duration}後達上限` }
  }
  const projectedPercent = Math.min(100, Math.round((current.used + state.ratePerMs * untilReset) / current.limit * 100))
  return { runsOutText: null, detailText: `依近期增量估計，重設時${mode === "left" ? "剩餘" : "已用"} ${mode === "left" ? 100 - projectedPercent : projectedPercent}%` }
}
