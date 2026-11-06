import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { summarizeTokens, type TokenUsageReport } from "@/lib/token-report"
import { quotaGuidance } from "@/lib/quota-guidance"
import { TokenReportPanel } from "@/components/token-report-panel"
import { ProviderCard } from "@/components/provider-card"
import { WidgetControls } from "@/components/widget-controls"

const native = vi.hoisted(() => ({ mode: { pinned: false, clickThrough: false }, handlers: new Map<string, (event: { payload: any }) => void>(), invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  native.handlers.set(name, handler)
  return () => native.handlers.delete(name)
}) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }))

const now = Date.parse("2026-10-25T16:00:00Z") // Monday Taipei midnight, Sunday in UTC.
const report: TokenUsageReport = { status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory",
  days: [{ date: "2026-10-25", totalTokens: 100 }, { date: "2026-10-26", totalTokens: 0 }, { date: "2026-10-27", totalTokens: 900 }] }
const quota = (id: string, used: number, updatedAt = now, resetsAt = new Date(now + 3_600_000).toISOString()): PluginDisplayState => ({
  meta: { id, name: id, iconUrl: "", lines: [], primaryCandidates: [] },
  data: { providerId: id, displayName: id, iconUrl: "", lines: [{ type: "progress", label: "Session", used, limit: 100, resetsAt, periodDurationMs: 7_200_000, format: { kind: "percent" } }] },
  loading: false, error: null, lastUpdatedAt: updatedAt, lastManualRefreshAt: null,
})

describe("bounded independent frontend acceptance", () => {
  beforeEach(() => {
    native.mode = { pinned: false, clickThrough: false }
    native.handlers.clear()
    native.invoke.mockReset().mockImplementation(async (_command, args) => {
      if (args && "pinned" in args) native.mode = { ...args }
      return { ...native.mode }
    })
  })
  afterEach(() => { vi.useRealTimers() })

  it("uses Taipei Monday boundaries, keeps observed zero and excludes future source dates", () => {
    const week = summarizeTokens(report, "week", now)
    expect(week).toMatchObject({ start: "2026-10-26", end: "2026-10-26", totalTokens: 0, knownDays: 1, missingDays: 0 })
    expect(summarizeTokens(report, "previous", now).totalTokens).toBe(100)
    expect(summarizeTokens(report, "recent", now).totalTokens).toBe(100)
  })

  it("does not render missing or unverified reports as zero and labels local coverage", () => {
    const { rerender } = render(<TokenReportPanel report={{ ...report, days: [] }} now={now} />)
    expect(screen.getByText(/非登入帳號帳單/)).toBeInTheDocument()
    expect(screen.getByText(/期間已知合計/)).toHaveTextContent("未取得資料")
    expect(screen.queryByText("0 Token")).not.toBeInTheDocument()
    rerender(<TokenReportPanel report={{ ...report, status: "unverified" }} now={now} />)
    expect(screen.getByText(/期間已知合計/)).toHaveTextContent("未取得資料")
  })

  it("rejects duplicated legacy Token progress and badges when a structured report exists", () => {
    render(<ProviderCard name="Codex" displayMode="used" lastUpdatedAt={now} tokenUsageReport={report} lines={[
      { type: "progress", label: "Legacy token progress", used: 777, limit: 1000, format: { kind: "count", suffix: "tokens" } },
      { type: "badge", label: "Token usage", text: "Legacy incomplete token result" },
      { type: "progress", label: "Session", used: 50, limit: 100, format: { kind: "percent" } },
    ]} />)
    expect(screen.getByLabelText("每週 Token 統計")).toBeInTheDocument()
    expect(screen.queryByText("Legacy token progress")).not.toBeInTheDocument()
    expect(screen.queryByText("Legacy incomplete token result")).not.toBeInTheDocument()
    expect(screen.getByText("本次工作階段")).toBeInTheDocument()
  })

  it("uses only fresh healthy alternatives and never predicts from a stale or failed provider", () => {
    expect(quotaGuidance([quota("old", 90, now - 600_001), quota("idle", 0)], now)).toBeNull()
    expect(quotaGuidance([{ ...quota("failed", 90), error: "timeout" }, quota("idle", 0)], now)).toBeNull()
    const guidance = quotaGuidance([quota("busy", 90), quota("fresh", 0), quota("stale", 0, now - 600_001)], now)
    expect(guidance).toContain("可查看 fresh")
    expect(guidance).not.toContain("stale")
    expect(guidance).toContain("不會自動切換工作")
  })

  it("does not offer guidance from an invalid reset cycle", () => {
    expect(quotaGuidance([quota("unknown-cycle", 100, now, "not-a-date"), quota("fresh", 0)], now)).toBeNull()
  })

  it("restores the native pinned mode after leaving and remounting the overview controls", async () => {
    const first = render(<WidgetControls />)
    await waitFor(() => expect(screen.getByRole("button", { name: "釘選為浮窗" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "釘選為浮窗" }))
    await screen.findByRole("button", { name: "取消釘選" })
    first.unmount()
    render(<WidgetControls />)
    await waitFor(() => expect(screen.getByRole("button", { name: "取消釘選" })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "取消釘選" }))
    await waitFor(() => expect(native.mode).toEqual({ pinned: false, clickThrough: false }))
  })

  it("tracks tray recovery events without a second copy of floating state", async () => {
    render(<WidgetControls />)
    await act(async () => { await Promise.resolve() })
    act(() => native.handlers.get("widget:mode-changed")?.({ payload: { pinned: true, clickThrough: true } }))
    expect(screen.getByRole("button", { name: "恢復互動" })).toBeInTheDocument()
    act(() => native.handlers.get("widget:mode-changed")?.({ payload: { pinned: false, clickThrough: false } }))
    expect(screen.queryByRole("button", { name: "恢復互動" })).not.toBeInTheDocument()
    expect(within(screen.getByRole("button", { name: "釘選為浮窗" })).queryByText("取消釘選")).not.toBeInTheDocument()
  })
})
