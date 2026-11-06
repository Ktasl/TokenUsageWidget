import { useEffect, useMemo, useRef } from "react"
import type { MetricLine } from "@/lib/plugin-types"
import { observeQuota, recentQuotaForecast, type RecentQuotaState } from "@/lib/recent-quota-pace"

export const quotaMetricKey = (line: Extract<MetricLine, { type: "progress" }>) =>
  `${line.label}:${line.format.kind}:${line.format.kind === "count" ? line.format.suffix : ""}`

export function useRecentQuotaPace({ providerId, sourceId, lines, observedAt, now, stale, displayMode }: {
  providerId?: string; sourceId?: string; lines: MetricLine[]; observedAt?: number | null; now: number; stale: boolean; displayMode: "left" | "used"
}) {
  const observations = useRef(new Map<string, RecentQuotaState>())
  const derived = useMemo(() => {
    const next = new Map<string, RecentQuotaState>()
    const forecasts = new Map<string, ReturnType<typeof recentQuotaForecast>>()
    if (!providerId || observedAt == null || stale) return { next, forecasts }
    const progress = lines.filter((line): line is Extract<MetricLine, { type: "progress" }> => line.type === "progress")
    const counts = new Map<string, number>()
    for (const line of progress) counts.set(quotaMetricKey(line), (counts.get(quotaMetricKey(line)) ?? 0) + 1)
    for (const line of progress) {
      const key = quotaMetricKey(line)
      if (counts.get(key) !== 1) continue
      const observationKey = JSON.stringify([providerId, sourceId ?? null, key, line.limit, line.resetsAt, line.periodDurationMs])
      const state = observeQuota(observations.current.get(observationKey), { providerId, sourceId, metric: key, used: line.used, limit: line.limit,
        observedAt, resetsAt: Date.parse(line.resetsAt ?? ""), periodDurationMs: line.periodDurationMs ?? Number.NaN }, now)
      next.set(observationKey, state)
      forecasts.set(key, recentQuotaForecast(state, now, displayMode))
    }
    return { next, forecasts }
  }, [providerId, sourceId, lines, observedAt, now, stale, displayMode])
  useEffect(() => { observations.current = derived.next }, [derived])
  return derived.forecasts
}
