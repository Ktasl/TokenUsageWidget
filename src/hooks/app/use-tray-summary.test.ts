import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useTrayIcon } from "./use-tray-icon"
import type { MenubarIconStyle } from "@/lib/settings"
const m = vi.hoisted(() => ({ invoke: vi.fn(), render: vi.fn(), setIcon: vi.fn(), setIconAsTemplate: vi.fn(), setTitle: vi.fn(), setTooltip: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: vi.fn(async () => "tray.png") }))
vi.mock("@tauri-apps/api/tray", () => ({ TrayIcon: { getById: vi.fn(async () => m) } }))
vi.mock("@/lib/tray-bars-icon", async () => ({ ...await vi.importActual<typeof import("@/lib/tray-bars-icon")>("@/lib/tray-bars-icon"), renderTrayBarsIcon: m.render }))
const args = {
  pluginsMeta: [{ id: "claude", name: "Claude", iconUrl: "claude.svg", primaryCandidates: ["Session"], lines: [] }],
  pluginSettings: { order: ["claude"], disabled: [] }, pluginStates: {}, displayMode: "left" as const,
  menubarMetric: "default" as const, activeView: "home",
}
beforeEach(() => {
  vi.clearAllMocks()
  m.render.mockResolvedValue("image")
  m.invoke.mockImplementation(async (_cmd, value) => ({ enabled: value.enabled, pluginIds: value.pluginIds, geminiMetric: value.geminiMetric, groups: [], error: null }))
})
describe("native and legacy tray ownership", () => {
  it("keeps both compact and detailed themes under native ownership without painting a canvas", async () => {
    const { result, rerender } = renderHook(({ style }: { style: MenubarIconStyle }) => useTrayIcon({ ...args, menubarIconStyle: style }), { initialProps: { style: "compact" as MenubarIconStyle } })
    await waitFor(() => expect(m.invoke).toHaveBeenCalledWith("configure_menubar_summary", expect.objectContaining({ style: "compact" })))
    expect(result.current.traySettingsPreview.summaryIconUrls?.claude).toBe("claude.svg")
    rerender({ style: "quota" })
    await waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(2))
    rerender({ style: "compact" })
    await waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(3))
    expect(m.render).not.toHaveBeenCalled()
  })
  it("does not paint a JavaScript canvas over native quota and waits for release before restoring a legacy style", async () => {
    const { rerender } = renderHook(({ style }: { style: MenubarIconStyle }) => useTrayIcon({ ...args, menubarIconStyle: style }), { initialProps: { style: "quota" as MenubarIconStyle } })
    await waitFor(() => expect(m.invoke).toHaveBeenCalled())
    expect(m.render).not.toHaveBeenCalled()
    let release!: (value: unknown) => void
    m.invoke.mockImplementationOnce((_cmd, value) => new Promise(resolve => { release = () => resolve({ ...value, groups: [], error: null }) }))
    rerender({ style: "provider" })
    await waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(2))
    expect(m.render).not.toHaveBeenCalled()
    await act(async () => { release(undefined) })
    await waitFor(() => expect(m.render).toHaveBeenCalled())
  })
  it("discards a late old canvas and enables native summary only after it has settled", async () => {
    let resolveImage!: (image: unknown) => void
    m.render.mockImplementationOnce(() => new Promise(resolve => { resolveImage = resolve }))
    const { rerender } = renderHook(({ style }: { style: MenubarIconStyle }) => useTrayIcon({ ...args, menubarIconStyle: style }), { initialProps: { style: "provider" as MenubarIconStyle } })
    await waitFor(() => expect(m.render).toHaveBeenCalledTimes(1))
    rerender({ style: "quota" })
    await act(async () => { await Promise.resolve() })
    expect(m.invoke).not.toHaveBeenCalled()
    await act(async () => { resolveImage("obsolete") })
    await waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(1))
    expect(m.setIcon).not.toHaveBeenCalledWith("obsolete")
  })
})
