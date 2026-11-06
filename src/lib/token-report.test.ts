import { describe, expect, it } from "vitest"
import { summarizeTokens, taipeiDay, tokenPeriodRange, validatedDays, type TokenUsageReport } from "./token-report"

const report = (days: TokenUsageReport["days"]): TokenUsageReport => ({ status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", days })
const now = Date.parse("2026-10-25T12:00:00+08:00")

describe("Taipei weekly Token totals", () => {
  it("uses Taipei midnight regardless of the machine timezone", () => {
    expect(taipeiDay(Date.parse("2026-10-25T15:59:59Z"))).toBe("2026-10-25")
    expect(taipeiDay(Date.parse("2026-10-25T16:00:00Z"))).toBe("2026-10-26")
    expect(tokenPeriodRange("week", now)).toEqual({ start: "2026-10-19", end: "2026-10-25" })
    expect(tokenPeriodRange("previous", now)).toEqual({ start: "2026-10-12", end: "2026-10-18" })
    expect(tokenPeriodRange("recent", now).start).toBe("2026-10-19")
  })
  it("crosses month and year boundaries with a Monday start", () => {
    expect(tokenPeriodRange("week", Date.parse("2027-01-01T03:00:00Z"))).toEqual({ start: "2026-12-28", end: "2027-01-01" })
  })
  it("deduplicates identical snapshots without doubling counts or adding overlapping cache", () => {
    const day = { date: "2026-10-19", totalTokens: 100, inputTokens: 80, cachedTokens: 70, outputTokens: 20 }
    expect(summarizeTokens(report([day, day]), "week", now).totalTokens).toBe(100)
  })
  it("rejects conflicting dates instead of silently summing them", () => {
    expect(validatedDays(report([{ date: "2026-10-19", totalTokens: 10 }, { date: "2026-10-19", totalTokens: 20 }]))).toBeNull()
  })
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid count %s", (totalTokens) => {
    expect(validatedDays(report([{ date: "2026-10-19", totalTokens }]))).toBeNull()
  })
  it("distinguishes an explicitly reported zero from missing data and excludes future dates", () => {
    const summary = summarizeTokens(report([{ date: "2026-10-19", totalTokens: 0 }, { date: "2026-10-26", totalTokens: 999 }]), "week", now)
    expect(summary.totalTokens).toBe(0)
    expect(summary.knownDays).toBe(1)
    expect(summary.missingDays).toBe(6)
    expect(summary.days[1].data).toBeNull()
    expect(summarizeTokens(report([]), "week", now).totalTokens).toBeNull()
  })
  it("rejects wrong source timezone and impossible dates", () => {
    expect(validatedDays({ ...report([]), timezone: "UTC" } as unknown as TokenUsageReport)).toBeNull()
    expect(validatedDays(report([{ date: "2026-02-30", totalTokens: 10 }]))).toBeNull()
  })
  it("does not use failed or unverified sources as valid totals", () => {
    for (const status of ["invalid", "unavailable", "unverified"] as const) expect(summarizeTokens({ ...report([{ date: "2026-10-19", totalTokens: 50 }]), status }, "week", now).totalTokens).toBeNull()
  })
  it("keeps models partial instead of inventing attribution for unclassified tokens", () => {
    const summary = summarizeTokens(report([{ date: "2026-10-19", totalTokens: 100, models: [{ name: "model-a", totalTokens: 40 }] }]), "week", now)
    expect(summary.models).toEqual([{ name: "model-a", totalTokens: 40 }])
    expect(summary.unclassifiedTokens).toBe(60)
    expect(validatedDays(report([{ date: "2026-10-19", totalTokens: 5, models: [{ name: "a", totalTokens: 10 }] }]))).toBeNull()
  })
  it("does not overflow when individually safe daily totals are summed", () => {
    const summary = summarizeTokens(report([{ date: "2026-10-19", totalTokens: Number.MAX_SAFE_INTEGER }, { date: "2026-10-20", totalTokens: 1 }]), "week", now)
    expect(summary.totalTokens).toBeNull()
  })
  it("does not export private paths or emails as model names", () => {
    for (const name of ["/Users/private/project", "private@example.invalid", "../private", "model\nsecret"]) expect(validatedDays(report([{ date: "2026-10-19", totalTokens: 10, models: [{ name, totalTokens: 10 }] }]))).toBeNull()
  })
})
