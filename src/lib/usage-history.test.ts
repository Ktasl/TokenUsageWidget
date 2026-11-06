import { describe, expect, it, vi } from "vitest"
import type { TokenUsageReport } from "./token-report"
import { shiftDay } from "./token-report"
import { captureUsageHistory, currentUsageHistory, emptyUsageHistory, HISTORY_DAYS, loadUsageHistory,
  monthlyUsage, saveUsageHistory, usageHistoryCsv, usageStatusJson, validateUsageHistory } from "./usage-history"

const today = "2026-10-25"
const report = (days: TokenUsageReport["days"], sourceId = "source_01234567"): TokenUsageReport => ({
  status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", sourceId, sourceVersion: "v1", days,
})
const snapshot = (value: TokenUsageReport) => [{ providerId: "codex", report: value }]

describe("safe scoped daily history", () => {
  it("replaces snapshots including lower totals, never incrementing or combining overlapping token components", () => {
    const original = report([{ date: today, totalTokens: 100, inputTokens: 80, cachedTokens: 30, outputTokens: 20 }])
    const first = captureUsageHistory(emptyUsageHistory(), snapshot(original), today)
    expect(captureUsageHistory(first, snapshot(original), today)).toEqual(first)
    const next = captureUsageHistory(first, snapshot(report([{ date: today, totalTokens: 40 }])), today)
    expect(next.scopes[0].days).toEqual([{ date: today, totalTokens: 40 }])
  })

  it("retains only 180 inclusive days and excludes future records", () => {
    const days = Array.from({ length: 182 }, (_, index) => ({ date: shiftDay(today, -index), totalTokens: index }))
    days.push({ date: shiftDay(today, 1), totalTokens: 999 })
    const history = captureUsageHistory(emptyUsageHistory(), snapshot(report(days)), today)
    expect(history.scopes[0].days).toHaveLength(HISTORY_DAYS)
    expect(history.scopes[0].days[0].date).toBe(shiftDay(today, -179))
    expect(history.scopes[0].days.at(-1)?.date).toBe(today)
    const advanced = captureUsageHistory(history, [], shiftDay(today, 180))
    expect(advanced.scopes).toEqual([])
  })

  it("isolates providers and source changes without pretending local-directory identifies an account", () => {
    const previous = report([{ date: today, totalTokens: 500 }], "old_source_0123")
    const current = report([{ date: today, totalTokens: 20 }], "new_source_0123")
    const first = captureUsageHistory(emptyUsageHistory(), snapshot(previous), today)
    const history = captureUsageHistory(first, [{ providerId: "codex", report: current }, { providerId: "claude", report: current }], today)
    expect(history.scopes).toHaveLength(3)
    const visible = currentUsageHistory(history, snapshot(current))
    expect(visible.scopes).toHaveLength(1)
    expect(visible.scopes[0]).toMatchObject({ providerId: "codex", sourceId: "new_source_0123" })
    expect(visible.scopes[0].days[0].totalTokens).toBe(20)
  })

  it("does not persist missing identities, paths, account strings, failed reports or conflicting snapshots", () => {
    const base = report([{ date: today, totalTokens: 1 }])
    const cases = [{ ...base, sourceId: undefined }, { ...base, sourceId: "/Users/private" }, { ...base, sourceId: "user@example.com" },
      { ...base, status: "unverified" as const }, { ...base, status: "unavailable" as const },
      report([{ date: today, totalTokens: 1 }, { date: today, totalTokens: 2 }]),
      report([{ date: today, totalTokens: 1, models: [{ name: "/Users/private/project", totalTokens: 1 }] }])]
    for (const candidate of cases) expect(captureUsageHistory(emptyUsageHistory(), snapshot(candidate), today).scopes).toEqual([])
  })

  it("distinguishes known zero from absent days across a calendar month boundary", () => {
    const history = captureUsageHistory(emptyUsageHistory(), snapshot(report([
      { date: "2026-09-30", totalTokens: 50 }, { date: "2026-10-01", totalTokens: 0 },
    ])), "2026-10-01")
    const months = monthlyUsage(history.scopes[0], "2026-10-01")
    expect(months.current).toMatchObject({ totalTokens: 0, knownDays: 1, expectedDays: 1, complete: true })
    expect(months.previous).toMatchObject({ totalTokens: 50, knownDays: 1, expectedDays: 30, complete: false })
    expect(monthlyUsage(undefined, "2026-10-01").current.totalTokens).toBeNull()
  })

  it("whitelists persisted/exported values and excludes reasons, raw paths and extra response fields", () => {
    const candidate = { ...report([{ date: today, totalTokens: 10, models: [{ name: "gpt-5", totalTokens: 10 }] }]),
      reason: "/Users/private/secret", account: "sensitive@example.com", rawResponse: { accessToken: "NEVER_EXPORT" } }
    const history = captureUsageHistory(emptyUsageHistory(), snapshot(candidate), today)
    const storage = { getItem: vi.fn(), setItem: vi.fn() }
    saveUsageHistory(storage, history)
    const stored = storage.setItem.mock.calls[0][1]
    const json = usageStatusJson(history, snapshot(candidate), today)
    for (const output of [stored, json, usageHistoryCsv(history)]) {
      expect(output).not.toMatch(/Users|secret|sensitive@|NEVER_EXPORT|rawResponse/)
    }
    expect(JSON.parse(json)).toMatchObject({ timezone: "Asia/Taipei", accountScope: "local-directory" })
    const modified = { ...history, secret: "NEVER_EXPORT", scopes: history.scopes.map((scope) => ({ ...scope, home: "/Users/private" })) }
    expect(JSON.stringify(validateUsageHistory(modified))).not.toMatch(/NEVER_EXPORT|Users|home/)
  })

  it("protects CSV formula prefixes in opaque identities and quotes model JSON", () => {
    const history = captureUsageHistory(emptyUsageHistory(), snapshot(report([
      { date: today, totalTokens: 5, models: [{ name: "claude-sonnet", totalTokens: 5 }] },
    ], "-formula_12345")), today)
    const csv = usageHistoryCsv(history)
    expect(csv.startsWith("\uFEFF")).toBe(true)
    expect(csv).toContain('"\'-formula_12345"')
    expect(csv).toContain('"[{""name"":""claude-sonnet"",""totalTokens"":5}]"')
  })

  it("reports read/write/malformed failures and does not overwrite corrupt history", () => {
    const denied = { getItem: () => { throw new Error("denied") }, setItem: vi.fn() }
    expect(() => loadUsageHistory(denied)).toThrow("無法讀取")
    const corrupt = { getItem: () => "not json", setItem: vi.fn() }
    expect(() => loadUsageHistory(corrupt)).toThrow("已保留原資料")
    expect(corrupt.setItem).not.toHaveBeenCalled()
    expect(() => saveUsageHistory({ getItem: () => null, setItem: () => { throw new Error("full") } }, emptyUsageHistory())).toThrow("無法儲存")
    expect(loadUsageHistory({ getItem: () => null, setItem: vi.fn() })).toEqual(emptyUsageHistory())
  })
})
