import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginState } from "@/hooks/app/types"
import { useTrayIcon } from "./use-tray-icon"

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  setIcon: vi.fn(),
  setIconAsTemplate: vi.fn(),
  setTitle: vi.fn(),
  setTooltip: vi.fn(),
}))

vi.mock("@tauri-apps/api/path", () => ({ resolveResource: vi.fn(async () => "gauge.png") }))
vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: { getById: vi.fn(async () => mocks) },
}))
vi.mock("@/lib/tray-bars-icon", async () => ({
  ...await vi.importActual<typeof import("@/lib/tray-bars-icon")>("@/lib/tray-bars-icon"),
  renderTrayBarsIcon: mocks.render,
}))

function makeArgs(count = 2) {
  const ids = Array.from({ length: count }, (_, index) => `provider-${index}`)
  const pluginsMeta: PluginMeta[] = ids.map((id) => ({
    id, name: id, iconUrl: `${id}.svg`, primaryCandidates: ["Session"], weeklyCandidate: "Weekly", lines: [],
  }))
  const pluginStates: Record<string, PluginState> = Object.fromEntries(ids.map((id, index) => [id, {
    loading: false, error: null, lastManualRefreshAt: null, lastUpdatedAt: null,
    data: {
      providerId: id, displayName: id,
      lines: [
        { type: "progress", label: "Session", used: index * 10, limit: 100, format: { kind: "percent" } },
        { type: "progress", label: "Weekly", used: 80, limit: 100, format: { kind: "percent" } },
      ],
    },
  }]))
  return {
    pluginsMeta, pluginStates, pluginSettings: { order: ids, disabled: [] as string[] },
    displayMode: "used" as "used" | "left", menubarIconStyle: "provider" as "provider" | "donut" | "bars",
    menubarMetric: "default" as "default" | "weekly", activeView: "home",
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(mocks)) mock.mockResolvedValue({})
})

describe("provider tray items", () => {
  it("adds a late Claude result after an earlier startup tray update already ran", async () => {
    const base = makeArgs(3)
    const ids = ["antigravity", "claude", "codex"]
    const args: ReturnType<typeof makeArgs> = {
      ...base,
      pluginsMeta: base.pluginsMeta.map((meta, index) => ({ ...meta, id: ids[index], name: ids[index] })),
      pluginSettings: { order: ids, disabled: [] as string[] },
      pluginStates: Object.fromEntries(ids.map((id, index) => [id, {
        ...base.pluginStates[`provider-${index}`],
        data: { ...base.pluginStates[`provider-${index}`].data!, providerId: id, displayName: id },
      }])),
    }
    const startup: ReturnType<typeof makeArgs> = { ...args, pluginStates: {
      ...args.pluginStates, claude: { ...args.pluginStates.claude, data: null, loading: true },
    } }
    const { result, rerender } = renderHook((props) => useTrayIcon(props), { initialProps: startup })
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems.map((item) => item.id)).toEqual(["antigravity", "codex"]))

    // The probe's timer can run while React still has the old startup state.
    mocks.setTooltip.mockClear()
    act(() => result.current.scheduleTrayIconUpdate("probe"))
    await waitFor(() => expect(mocks.setTooltip).toHaveBeenLastCalledWith("OpenUsage\nantigravity: 0%\ncodex: 20%"))
    // Committing the later result must update the tray without toggling a setting/view.
    rerender(args)
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems.map((item) => item.id)).toEqual(ids))
    await waitFor(() => expect(mocks.setTooltip).toHaveBeenLastCalledWith("OpenUsage\nantigravity: 0%\nclaude: 10%\ncodex: 20%"))
  })

  it("renders all funded services including zero, with no four-service limit", async () => {
    const args = makeArgs(6)
    const { result } = renderHook(() => useTrayIcon(args))
    await waitFor(() => expect(mocks.render).toHaveBeenCalled())
    const rendered = mocks.render.mock.calls.at(-1)![0]
    expect(rendered.providerItems.map((item: { id: string }) => item.id)).toEqual(args.pluginSettings.order)
    expect(rendered.providerItems.map((item: { percentText: string }) => item.percentText)).toEqual(["0%", "10%", "20%", "30%", "40%", "50%"])
    expect(result.current.traySettingsPreview.providerItems).toHaveLength(6)
    expect(mocks.setTitle).toHaveBeenLastCalledWith("")
    expect(mocks.setTooltip).toHaveBeenLastCalledWith("OpenUsage\nprovider-0: 0%\nprovider-1: 10%\nprovider-2: 20%\nprovider-3: 30%\nprovider-4: 40%\nprovider-5: 50%")
  })

  it("filters missing and invalid quota, preserves enabled order, and updates after toggles", async () => {
    const args = makeArgs(6)
    args.pluginStates["provider-1"].data = null
    args.pluginStates["provider-2"].data!.lines = []
    args.pluginStates["provider-3"].data!.lines = [{ type: "progress", label: "Session", used: 5, limit: 0, format: { kind: "percent" } }]
    args.pluginStates["provider-4"].data!.lines = [{ type: "progress", label: "Session", used: NaN, limit: 100, format: { kind: "percent" } }]
    args.pluginSettings.order.reverse()
    const { result, rerender } = renderHook((props) => useTrayIcon(props), { initialProps: args })
    await waitFor(() => expect(mocks.render.mock.calls.at(-1)?.[0].providerItems).toHaveLength(2))
    expect(result.current.traySettingsPreview.providerItems.map((item) => item.id)).toEqual(["provider-5", "provider-0"])
    expect(mocks.setTooltip).toHaveBeenLastCalledWith("OpenUsage\nprovider-5: 50%\nprovider-0: 0%")
    rerender({ ...args, pluginSettings: { ...args.pluginSettings, disabled: ["provider-5"] } })
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems.map((item) => item.id)).toEqual(["provider-0"]))
    expect(mocks.setTitle).toHaveBeenLastCalledWith("0%")
    expect(mocks.render.mock.calls.at(-1)![0].providerIconUrl).toBe("provider-0.svg")
  })

  it("keeps the full set while changing detail, home and settings views", async () => {
    const args = makeArgs()
    const { rerender } = renderHook((props) => useTrayIcon(props), { initialProps: args })
    await waitFor(() => expect(mocks.render).toHaveBeenCalled())
    for (const activeView of ["provider-1", "home", "settings"]) {
      mocks.render.mockClear()
      rerender({ ...args, activeView })
      await waitFor(() => expect(mocks.render).toHaveBeenCalled())
      expect(mocks.render.mock.calls.at(-1)![0].providerItems.map((item: { id: string }) => item.id)).toEqual(args.pluginSettings.order)
      expect(mocks.setTitle).toHaveBeenLastCalledWith("")
    }
  })

  it("keeps used, remaining and weekly percentages for all services", async () => {
    const args = makeArgs()
    const { result, rerender } = renderHook((props) => useTrayIcon(props), { initialProps: args })
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems).toHaveLength(2))
    expect(result.current.traySettingsPreview.providerItems.map((item) => item.percentText)).toEqual(["0%", "10%"])
    rerender({ ...args, displayMode: "left" })
    act(() => result.current.scheduleTrayIconUpdate("settings"))
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems.map((item) => item.percentText)).toEqual(["100%", "90%"]))
    rerender({ ...args, displayMode: "left", menubarMetric: "weekly" })
    await waitFor(() => expect(result.current.traySettingsPreview.providerItems.map((item) => item.percentText)).toEqual(["20%", "20%"]))
  })

  it("preserves the startup fallback when no quota data is available", async () => {
    const args = makeArgs()
    for (const state of Object.values(args.pluginStates)) state.data = null
    const { result } = renderHook(() => useTrayIcon(args))
    await waitFor(() => expect(mocks.render).toHaveBeenCalled())
    expect(result.current.traySettingsPreview.providerItems).toEqual([])
    expect(mocks.render.mock.calls.at(-1)![0].providerItems).toBeUndefined()
    expect(mocks.setTitle).toHaveBeenLastCalledWith("--%")
    expect(mocks.setTooltip).toHaveBeenLastCalledWith("OpenUsage")
  })

  it("preserves bars and donut behavior", async () => {
    const args = makeArgs(6)
    const { rerender } = renderHook((props) => useTrayIcon(props), { initialProps: { ...args, menubarIconStyle: "bars" } })
    await waitFor(() => expect(mocks.render.mock.calls.at(-1)?.[0].style).toBe("bars"))
    expect(mocks.render.mock.calls.at(-1)![0].bars).toHaveLength(4)
    rerender({ ...args, menubarIconStyle: "donut", activeView: "provider-5" })
    await waitFor(() => expect(mocks.render.mock.calls.at(-1)?.[0].style).toBe("donut"))
    expect(mocks.render.mock.calls.at(-1)![0].providerIconUrl).toBe("provider-5.svg")
    expect(mocks.render.mock.calls.at(-1)![0].bars).toHaveLength(1)
  })

  it("remembers the selected provider when switching Plugin to Donut in settings", async () => {
    const args = makeArgs()
    const { rerender } = renderHook((props) => useTrayIcon(props), {
      initialProps: { ...args, activeView: "provider-1" },
    })
    await waitFor(() => expect(mocks.render).toHaveBeenCalled())
    expect(mocks.render.mock.calls.at(-1)![0].providerItems.map((item: { id: string }) => item.id)).toEqual(args.pluginSettings.order)
    mocks.render.mockClear()
    rerender({ ...args, activeView: "settings" })
    await waitFor(() => expect(mocks.render).toHaveBeenCalled())
    rerender({ ...args, activeView: "settings", menubarIconStyle: "donut" })
    await waitFor(() => expect(mocks.render.mock.calls.at(-1)?.[0].style).toBe("donut"))
    expect(mocks.render.mock.calls.at(-1)![0].providerIconUrl).toBe("provider-1.svg")
  })
})
