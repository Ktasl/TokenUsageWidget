import { describe, expect, it } from "vitest"
import { observeQuota, recentQuotaForecast, RECENT_QUOTA_MAX_GAP_MS, type QuotaObservation } from "./recent-quota-pace"

const start = Date.parse("2026-10-25T00:00:00Z")
const sample = (used: number, observedAt = start): QuotaObservation => ({ providerId: "codex", metric: "Weekly:percent", used,
  limit: 100, observedAt, periodDurationMs: 7 * 86_400_000, resetsAt: start + 86_400_000 })

describe("recent quota increment forecast", () => {
  it("does not predict from the first observation or repeated renders of one timestamp", () => {
    const first = observeQuota(undefined, sample(60), start)
    expect(recentQuotaForecast(first, start, "left")).toBeNull()
    const repeated = observeQuota(first, sample(60), start + 30_000)
    expect(recentQuotaForecast(repeated, start + 30_000, "left")).toBeNull()
  })

  it("predicts from a recent positive increment and stops after an unchanged successful refresh", () => {
    const first = observeQuota(undefined, sample(60), start)
    const next = observeQuota(first, sample(65, start + 300_000), start + 300_000)
    expect(recentQuotaForecast(next, start + 300_000, "left")?.runsOutText).toBe("近期速度估計 35 分後用盡")
    const idle = observeQuota(next, sample(65, start + 600_000), start + 600_000)
    expect(recentQuotaForecast(idle, start + 600_000, "left")).toBeNull()
  })

  it("rejects long gaps, source age, decreases, changed cycles/providers/metrics/limits and near simultaneous samples", () => {
    const first = observeQuota(undefined, sample(60), start)
    const at = start + 300_000
    const fresh = sample(65, at)
    const invalid = [sample(59, at), { ...fresh, providerId: "claude" }, { ...fresh, metric: "Session:percent" },
      { ...fresh, sourceId: "new_local_source" },
      { ...fresh, limit: 200 }, { ...fresh, resetsAt: fresh.resetsAt + 1 }, { ...fresh, periodDurationMs: 3_600_000 },
      sample(65, start + 10_000), sample(65, start + RECENT_QUOTA_MAX_GAP_MS + 1)]
    for (const current of invalid) expect(recentQuotaForecast(observeQuota(first, current, current.observedAt), current.observedAt, "left")).toBeNull()
    const next = observeQuota(first, fresh, at)
    expect(recentQuotaForecast(next, at + RECENT_QUOTA_MAX_GAP_MS + 1, "left")).toBeNull()
  })

  it("uses current total plus recent rate for reset projections, not a whole-cycle average", () => {
    const first = observeQuota(undefined, { ...sample(10), resetsAt: start + 600_000 }, start)
    const next = observeQuota(first, { ...sample(11, start + 300_000), resetsAt: start + 600_000 }, start + 300_000)
    expect(recentQuotaForecast(next, start + 300_000, "left")).toEqual({ runsOutText: null, detailText: "依近期增量估計，重設時剩餘 88%" })
  })
})
