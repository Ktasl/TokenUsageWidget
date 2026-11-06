import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MenubarSummaryState } from "@/lib/menubar-summary"
import type { PluginMeta } from "@/lib/plugin-types"
import type { MenubarIconStyle, PluginSettings } from "@/lib/settings"

const boundary = vi.hoisted(() => ({
  invoke: vi.fn(), render: vi.fn(), setIcon: vi.fn(), setIconAsTemplate: vi.fn(), setTitle: vi.fn(), setTooltip: vi.fn(),
  handlers: new Map<string, (event: { payload: MenubarSummaryState }) => void>(), store: new Map<string, unknown>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  boundary.handlers.set(name, handler); return () => boundary.handlers.delete(name)
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

import { useNativeMenubarSummary } from "@/hooks/app/use-native-menubar-summary"
import { useTrayIcon } from "@/hooks/app/use-tray-icon"
import { MenubarIconStylePreview } from "@/components/settings/menubar-icon-style-preview"

const ids = ["antigravity", "claude", "codex"]
const settings: PluginSettings = { order: ids, disabled: [], menubarMetrics: { antigravity: "Gemini Flash", claude: "Weekly" } }
const metas: PluginMeta[] = ids.map(id => ({ id, name: id, iconUrl: `${id}-brand.svg`, primaryCandidates: ["Session"], lines: [] }))
const packet = (style: "compact" | "quota" = "compact", enabled = true): MenubarSummaryState => ({
  enabled, style, pluginIds: [...ids], geminiMetric: "flash", error: null,
  groups: ids.map(id => ({ id, name: id, rows: id === "antigravity" ? [
    { key: "gemini", label: "Gemini Flash", remainingPercent: 0, countdown: "4h02m", status: "fresh" },
    { key: "claude", label: "Claude", remainingPercent: 100, countdown: "2h12m", status: "fresh" },
  ] : [
    { key: "session", label: "Session", remainingPercent: 63, countdown: "38m", status: "fresh" },
    { key: "weekly", label: "Weekly", remainingPercent: null, countdown: null, status: "missing" },
  ] })),
})
const ready = () => Promise.resolve()
const trayArgs = { pluginsMeta: metas, pluginSettings: settings, pluginStates: {}, displayMode: "left" as const, menubarMetric: "default" as const, activeView: "home" }
beforeEach(() => {
  vi.useRealTimers(); vi.clearAllMocks(); boundary.handlers.clear(); boundary.store.clear()
  boundary.render.mockResolvedValue("legacy-image")
  for (const fn of [boundary.setIcon, boundary.setIconAsTemplate, boundary.setTitle, boundary.setTooltip]) fn.mockResolvedValue(undefined)
  boundary.invoke.mockImplementation(async (_command, args) => ({ ...packet(args.style ?? "quota", args.enabled), pluginIds: args.pluginIds }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("independent compact theme acceptance", () => {
  it("loads compact for a fresh test edition but retains every saved theme and model preference", async () => {
    vi.stubEnv("VITE_TOKEN_USAGE_TEST_BUILD", "1"); vi.resetModules()
    const storage = await import("@/lib/settings")
    expect(await storage.loadMenubarIconStyle()).toBe("compact")
    for (const style of ["quota", "provider", "bars", "donut", "compact"] as const) {
      await storage.saveMenubarIconStyle(style)
      await storage.savePluginSettings(settings)
      await storage.migrateLegacyTraySettings()
      expect(await storage.loadMenubarIconStyle()).toBe(style)
      expect((await storage.loadPluginSettings()).menubarMetrics).toEqual(settings.menubarMetrics)
    }
    vi.stubEnv("VITE_TOKEN_USAGE_TEST_BUILD", "0"); vi.resetModules()
    boundary.store.clear()
    expect(await (await import("@/lib/settings")).loadMenubarIconStyle()).toBe("provider")
  })

  it("keeps native ownership when changing themes and rejects delayed events from the previous theme", async () => {
    const { result, rerender } = renderHook(({ style }) => useNativeMenubarSummary(true, settings, ready, style), { initialProps: { style: "compact" as "compact" | "quota" } })
    await waitFor(() => expect(result.current.summary?.style).toBe("compact"))
    expect(boundary.invoke).toHaveBeenLastCalledWith("configure_menubar_summary", { enabled: true, pluginIds: ids, geminiMetric: "flash", metricSelections: settings.menubarMetrics, style: "compact" })
    rerender({ style: "quota" })
    expect(result.current.owned).toBe(true)
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: { ...packet("compact"), error: "old compact" } }))
    expect(result.current.error).toBeNull()
    await waitFor(() => expect(result.current.summary?.style).toBe("quota"))
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: { ...packet("quota"), pluginIds: ["claude"], error: "wrong enabled set" } }))
    expect(result.current.error).toBeNull()
    rerender({ style: "compact" })
    await waitFor(() => expect(result.current.summary?.style).toBe("compact"))
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: { ...packet("quota"), error: "old quota" } }))
    expect(result.current.error).toBeNull()
    expect(result.current.owned).toBe(true)
  })

  it("switches compact through detailed to legacy only after the native disable is acknowledged", async () => {
    const { result, rerender } = renderHook(({ style }: { style: MenubarIconStyle }) => useTrayIcon({ ...trayArgs, menubarIconStyle: style }), { initialProps: { style: "compact" as MenubarIconStyle } })
    await waitFor(() => expect(result.current.traySettingsPreview.summaryGroups).toHaveLength(3))
    rerender({ style: "quota" })
    await waitFor(() => expect(boundary.invoke).toHaveBeenCalledTimes(2))
    expect(boundary.render).not.toHaveBeenCalled()
    let release!: (value: MenubarSummaryState) => void
    boundary.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    rerender({ style: "provider" })
    await waitFor(() => expect(boundary.invoke).toHaveBeenCalledTimes(3))
    expect(boundary.render).not.toHaveBeenCalled()
    await act(async () => { release(packet("quota", false)) })
    await waitFor(() => expect(boundary.render).toHaveBeenCalled())
    expect(boundary.render.mock.calls.at(-1)![0].style).toBe("provider")
  })

  it("uses metadata and distinct model icons with large 0/100/unknown percentages even without legacy data", async () => {
    const { result } = renderHook(() => useTrayIcon({ ...trayArgs, menubarIconStyle: "compact" }))
    await waitFor(() => expect(result.current.traySettingsPreview.summaryGroups).toHaveLength(3))
    expect(result.current.traySettingsPreview.providerItems).toEqual([])
    const { container, rerender } = render(<MenubarIconStylePreview style="compact" isActive={false} traySettingsPreview={result.current.traySettingsPreview} />)
    const masks = Array.from(container.querySelectorAll<HTMLElement>("[aria-hidden]"))
    expect(masks).toHaveLength(3)
    expect(masks[0].style.maskImage).toContain("antigravity-brand.svg")
    expect(masks[1].style.maskImage).not.toBe(masks[2].style.maskImage)
    for (const value of ["0%", "100%"]) expect(screen.getByText(value)).toHaveClass("text-[17px]")
    expect(container.textContent).not.toMatch(/4h02m|2h12m|Gemini|Claude|AG/)
    const missing = packet(); missing.groups[0].rows[0] = { ...missing.groups[0].rows[0], remainingPercent: null, countdown: null, status: "missing" }
    act(() => boundary.handlers.get("menubar:summary-updated")?.({ payload: missing }))
    rerender(<MenubarIconStylePreview style="compact" isActive={false} traySettingsPreview={result.current.traySettingsPreview} />)
    expect(screen.getByText("--%")).toHaveClass("text-[17px]")
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
  })

  it("shows the same native values without times in compact while preserving detailed two-row countdowns", () => {
    const preview = { bars: [], providerBars: [], providerItems: [], providerPercentText: "--%", summaryIconUrls: { claude: "claude-brand.svg" }, summaryGroups: [packet().groups[1]] }
    const { container, rerender } = render(<MenubarIconStylePreview style="quota" isActive traySettingsPreview={preview} />)
    expect(screen.getByText("S 63% · 38m")).toBeInTheDocument()
    expect(screen.getByText("W --% · --")).toBeInTheDocument()
    rerender(<MenubarIconStylePreview style="compact" isActive traySettingsPreview={preview} />)
    expect(screen.getByText("63%")).toHaveClass("text-[17px]")
    expect(screen.getByText("--%")).toBeInTheDocument()
    expect(container.querySelector('[style*="claude-brand.svg"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/38m|·|claude/)
    rerender(<MenubarIconStylePreview style="quota" isActive traySettingsPreview={preview} />)
    expect(screen.getByText("S 63% · 38m")).toBeInTheDocument()
  })
})
