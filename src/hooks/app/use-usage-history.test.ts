import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { useUsageHistory } from "./use-usage-history"

const now = Date.parse("2026-10-24T16:30:00Z") // October 25 in Taipei.
const plugin = (totalTokens = 10, sourceId = "source_12345678"): PluginDisplayState => ({
  meta: { id: "codex", name: "Codex", iconUrl: "", lines: [], primaryCandidates: [] },
  data: { providerId: "codex", displayName: "Codex", iconUrl: "", lines: [], tokenUsageReport: {
    status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", sourceId,
    days: [{ date: "2026-10-25", totalTokens }],
  } }, loading: false, error: null, lastUpdatedAt: now, lastManualRefreshAt: null,
})

describe("useUsageHistory", () => {
  it("captures snapshots once, replaces decreased totals and saves Taipei day", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
    const { result, rerender } = renderHook(({ plugins }) => useUsageHistory(plugins, { storage, now }), { initialProps: { plugins: [plugin()] } })
    expect(result.current.today).toBe("2026-10-25")
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    act(() => rerender({ plugins: [plugin()] }))
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    act(() => rerender({ plugins: [plugin(5)] }))
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(result.current.history.scopes[0].days[0].totalTokens).toBe(5)
  })

  it("keeps source switches isolated and only returns the active source", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
    const { result, rerender } = renderHook(({ plugins }) => useUsageHistory(plugins, { storage, now }), { initialProps: { plugins: [plugin()] } })
    act(() => rerender({ plugins: [plugin(5, "different_source_1234")] }))
    expect(result.current.history.scopes).toHaveLength(1)
    expect(result.current.history.scopes[0].sourceId).toBe("different_source_1234")
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).scopes).toHaveLength(2)
  })

  it("retains malformed original data and surfaces storage failures", () => {
    const storage = { getItem: vi.fn(() => "invalid json"), setItem: vi.fn() }
    const { result } = renderHook(() => useUsageHistory([plugin()], { storage, now }))
    expect(result.current.error).toContain("暫停歷史儲存")
    expect(storage.setItem).not.toHaveBeenCalled()
    const full = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error("full") }) }
    const { result: failed } = renderHook(() => useUsageHistory([plugin()], { storage: full, now }))
    expect(failed.current.error).toContain("無法儲存")
    expect(failed.current.history.scopes).toHaveLength(0)
  })
})
