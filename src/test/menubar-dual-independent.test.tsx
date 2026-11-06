import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MenubarSummaryState } from "@/lib/menubar-summary"
import type { PluginDisplayState, PluginMeta } from "@/lib/plugin-types"
import type { MenubarIconStyle, PluginSettings } from "@/lib/settings"

const boundary = vi.hoisted(() => ({
  invoke: vi.fn(), render: vi.fn(), setIcon: vi.fn(), setIconAsTemplate: vi.fn(), setTitle: vi.fn(), setTooltip: vi.fn(),
  handlers: new Map<string, (event: { payload: any }) => void>(), store: new Map<string, unknown>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  boundary.handlers.set(name, handler)
  return () => boundary.handlers.delete(name)
}) }))
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: vi.fn(async () => "tray.png") }))
vi.mock("@tauri-apps/api/tray", () => ({ TrayIcon: { getById: vi.fn(async () => boundary) } }))
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {
  async get(key: string) { return boundary.store.get(key) }
  async set(key: string, value: unknown) { boundary.store.set(key, value) }
  async delete(key: string) { boundary.store.delete(key) }
  async save() {}
} }))
vi.mock("@/lib/tray-bars-icon", async () => ({ ...await vi.importActual<typeof import("@/lib/tray-bars-icon")>("@/lib/tray-bars-icon"), renderTrayBarsIcon: boundary.render }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }))
// Keep this check on the requested menu-bar and provider-card integration boundaries.
vi.mock("@/components/retirement-notice", () => ({ RetirementNotice: () => null }))
vi.mock("@/components/widget-controls", () => ({ WidgetControls: () => null }))
vi.mock("@/components/usage-exports", () => ({ UsageExports: () => null }))

import { loadMenubarIconStyle, migrateLegacyTraySettings, normalizePluginSettings, saveMenubarIconStyle, savePluginSettings, loadPluginSettings } from "@/lib/settings"
import { useNativeMenubarSummary } from "@/hooks/app/use-native-menubar-summary"
import { useTrayIcon } from "@/hooks/app/use-tray-icon"
import { OverviewPage } from "@/pages/overview"
import { MenubarIconStylePreview } from "@/components/settings/menubar-icon-style-preview"

const ids = ["claude", "codex", "antigravity"]
const settings: PluginSettings = { order: ids, disabled: [], menubarMetrics: { antigravity: "Gemini Flash", claude: "Weekly" } }
const metas: PluginMeta[] = ids.map((id) => ({ id, name: id === "antigravity" ? "Antigravity" : id === "claude" ? "Claude" : "Codex", iconUrl: `${id}.svg`, primaryCandidates: ["Session"], lines: [] }))
const packet = (enabled = true, geminiMetric: "flash" | "pro" = "flash"): MenubarSummaryState => ({
  enabled, pluginIds: [...ids], geminiMetric, error: null,
  groups: ids.map((id) => ({ id, name: id, rows: id === "antigravity" ? [
    { key: "gemini", label: "Gemini Flash", remainingPercent: 25, countdown: "4h02m", status: "fresh" },
    { key: "claude", label: "Claude", remainingPercent: null, countdown: null, status: "missing" },
  ] : [
    { key: "session", label: "Session", remainingPercent: 0, countdown: "12m", status: "fresh" },
    { key: "weekly", label: "Weekly", remainingPercent: 100, countdown: "3d01h02m", status: "fresh" },
  ] })),
})
const ready = () => Promise.resolve()

beforeEach(() => {
  vi.useRealTimers(); vi.clearAllMocks()
  boundary.handlers.clear(); boundary.store.clear()
  boundary.render.mockResolvedValue("legacy-image")
  for (const method of [boundary.setIcon, boundary.setIconAsTemplate, boundary.setTitle, boundary.setTooltip]) method.mockResolvedValue(undefined)
  boundary.invoke.mockImplementation(async (_command, args) => ({ ...packet(args.enabled, args.geminiMetric), pluginIds: args.pluginIds }))
})
afterEach(() => { vi.restoreAllMocks() })

describe("bounded independent dual quota acceptance", () => {
  it("round-trips quota and legacy styles while migration preserves quota and per-provider metrics", async () => {
    for (const style of ["provider", "bars", "donut", "quota"] as const) {
      await saveMenubarIconStyle(style)
      expect(await loadMenubarIconStyle()).toBe(style)
    }
    boundary.store.set("trayIconStyle", "bars")
    boundary.store.set("trayShowPercentage", true)
    await migrateLegacyTraySettings()
    expect(await loadMenubarIconStyle()).toBe("quota")
    expect(boundary.store.has("trayIconStyle")).toBe(false)
    const normalized = normalizePluginSettings(settings, metas)
    await savePluginSettings(normalized)
    expect((await loadPluginSettings()).menubarMetrics).toEqual(settings.menubarMetrics)
  })

  it("forwards exact enabled/configuration fields and accepts only matching native family/order events", async () => {
    const { result, rerender } = renderHook(({ value }) => useNativeMenubarSummary(true, value, ready), { initialProps: { value: settings } })
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("configure_menubar_summary", { enabled: true, pluginIds: ids, geminiMetric: "flash", metricSelections: settings.menubarMetrics })
    const changed = packet()
    changed.groups[0].rows[0] = { key: "session", label: "Session", remainingPercent: 18, countdown: "10m", status: "fresh" }
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: changed }))
    expect(result.current.summary?.groups[0].rows[0]).toEqual(changed.groups[0].rows[0])
    rerender({ value: { ...settings, menubarMetrics: { ...settings.menubarMetrics, antigravity: "Gemini Pro" } } })
    await waitFor(() => expect(result.current.summary?.geminiMetric).toBe("pro"))
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: { ...changed, error: "old family response" } }))
    expect(result.current.error).toBeNull()
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: { ...packet(true, "pro"), pluginIds: ["codex"], error: "wrong source set" } }))
    expect(result.current.error).toBeNull()
    expect(boundary.invoke).toHaveBeenCalledTimes(2)
  })

  it("retains all native groups across views and waits for disable acknowledgement before legacy painting", async () => {
    const args = { pluginsMeta: metas, pluginSettings: settings, pluginStates: {}, displayMode: "left" as const, menubarMetric: "default" as const }
    const { result, rerender } = renderHook(({ style, view }: { style: MenubarIconStyle; view: string }) => useTrayIcon({ ...args, menubarIconStyle: style, activeView: view }), { initialProps: { style: "quota" as MenubarIconStyle, view: "home" } })
    await waitFor(() => expect(result.current.traySettingsPreview.summaryGroups).toHaveLength(3))
    for (const view of ["codex", "settings", "home"]) {
      rerender({ style: "quota", view })
      expect(result.current.traySettingsPreview.summaryGroups?.map((group) => group.id)).toEqual(ids)
    }
    expect(boundary.render).not.toHaveBeenCalled()
    let release!: (value: MenubarSummaryState) => void
    boundary.invoke.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    rerender({ style: "donut", view: "settings" })
    await waitFor(() => expect(boundary.invoke).toHaveBeenCalledTimes(2))
    expect(boundary.render).not.toHaveBeenCalled()
    await act(async () => { release(packet(false)) })
    await waitFor(() => expect(boundary.render).toHaveBeenCalled())
    expect(boundary.render.mock.calls.at(-1)![0].style).toBe("donut")
  })

  it("renders per-slot unknown separately from true zero/full and repaints changed timer-only events", async () => {
    const { result } = renderHook(() => useTrayIcon({ pluginsMeta: metas, pluginSettings: settings, pluginStates: {}, displayMode: "left", menubarMetric: "default", menubarIconStyle: "quota", activeView: "home" }))
    await waitFor(() => expect(result.current.traySettingsPreview.summaryGroups).toHaveLength(3))
    const { rerender } = render(<MenubarIconStylePreview style="quota" isActive traySettingsPreview={result.current.traySettingsPreview} />)
    expect(screen.getByText(/S 0% · 12m/)).toBeInTheDocument()
    expect(screen.getByText(/W 100% · 3d01h02m/)).toBeInTheDocument()
    const changed = packet()
    changed.groups[0].rows[0].countdown = "11m"
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: changed }))
    rerender(<MenubarIconStylePreview style="quota" isActive traySettingsPreview={result.current.traySettingsPreview} />)
    expect(screen.getByText(/S 0% · 11m/)).toBeInTheDocument()
    rerender(<MenubarIconStylePreview style="quota" isActive traySettingsPreview={{ ...result.current.traySettingsPreview, summaryGroups: [packet().groups[2]] }} />)
    expect(screen.getByText(/G 25% · 4h02m/)).toBeInTheDocument()
    expect(screen.getByText(/C --% · --/)).toBeInTheDocument()
  })

  it("opens three provider cards without dropping Cost/Extra or duplicating their daily Token chart", () => {
    const now = Date.parse("2026-10-25T03:00:00Z")
    vi.spyOn(Date, "now").mockReturnValue(now)
    const plugins: PluginDisplayState[] = metas.map((meta, index) => ({ meta, loading: false, error: null, lastManualRefreshAt: null, lastUpdatedAt: now,
      data: { providerId: meta.id, displayName: meta.name, iconUrl: meta.iconUrl, tokenUsageReport: { status: index === 2 ? "unavailable" : "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", days: index === 2 ? [] : [{ date: "2026-10-25", totalTokens: index ? 200 : 100 }] },
        lines: [
          { type: "progress", label: index === 2 ? "Gemini Flash" : "Session", used: 20, limit: 100, format: { kind: "percent" } },
          ...(index === 2 ? [] : [{ type: "text" as const, label: "Local estimated cost", value: index ? "$3.00" : "$12.00", subtitle: "2026-10-25 ～ 2026-10-25；有金額紀錄 1/1 天" }]),
          ...(index === 0 ? [{ type: "progress" as const, label: "Extra usage spent", used: 1.25, limit: 10, format: { kind: "dollars" as const } }] : []),
        ] },
    }))
    render(<OverviewPage plugins={plugins} displayMode="left" resetTimerDisplayMode="relative" />)
    for (const meta of metas) {
      const card = screen.getByRole("region", { name: `${meta.name} 額度` })
      expect(within(card).getAllByRole("img", { name: "每日 Token 用量，缺資料以虛線表示" })).toHaveLength(1)
      expect(within(card).getAllByLabelText("額外用量資訊")).toHaveLength(1)
      expect(within(card).queryByText("Local estimated cost")).not.toBeInTheDocument()
      expect(within(card).queryByText("Extra usage spent")).not.toBeInTheDocument()
    }
    expect(screen.getAllByText("US$ 12.00")).toHaveLength(1)
    expect(screen.getAllByText("US$ 3.00")).toHaveLength(1)
    expect(screen.getAllByText("本月已用 US$ 1.25／上限 US$ 10.00")).toHaveLength(1)
    const agy = within(screen.getByRole("region", { name: "Antigravity 額度" }))
    expect(agy.getByText("來源未提供可信的費用紀錄")).toBeInTheDocument()
    expect(agy.queryByText(/US\$ 0/)).not.toBeInTheDocument()
    expect(agy.getByText(/期間已知合計/)).toHaveTextContent("未取得資料")
  })
})
