import { fireEvent, act, render, renderHook, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useAppUpdate } from "@/hooks/use-app-update"
import { track } from "@/lib/analytics"
import { getEnabledPluginIds, normalizePluginSettings } from "@/lib/settings"
import { RetirementNotice } from "@/components/retirement-notice"
import { PanelFooter } from "@/components/panel-footer"
import { AboutDialog } from "@/components/about-dialog"
import { SettingsPage } from "@/pages/settings"
import { formatTrayTooltip } from "@/lib/tray-tooltip"

const mocks = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(), relaunch: vi.fn(), storeGet: vi.fn() }))

vi.mock("@/lib/app-edition", () => ({ IS_TEST_BUILD: true, APP_DISPLAY_NAME: "TokenUsageWidget", APP_BUILD_NUMBER: "20261022.1" }))
vi.mock("@tauri-apps/api/core", async () => ({
  ...await vi.importActual<typeof import("@tauri-apps/api/core")>("@tauri-apps/api/core"),
  isTauri: () => true,
  invoke: mocks.invoke,
}))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class { get = mocks.storeGet } }))

afterEach(() => {
  vi.useRealTimers()
})

describe("test edition", () => {
  it("does not check, download, install or poll for upstream app updates", async () => {
    vi.useFakeTimers()
    const download = vi.fn()
    const install = vi.fn()
    mocks.check.mockResolvedValue({ download, install })
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => {
      await result.current.checkForUpdates()
      await result.current.triggerInstall()
      vi.advanceTimersByTime(60 * 60 * 1000)
    })
    expect(result.current.updateStatus).toEqual({ status: "idle" })
    expect(mocks.check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it("does not send frontend analytics", () => {
    track("test_event", { edition: "test" })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("starts with no providers enabled and preserves later manual selections", () => {
    const plugins = ["codex", "claude", "cursor", "copilot"].map((id) => ({ id, name: id, iconUrl: "", lines: [] }))
    const fresh = normalizePluginSettings({ order: [], disabled: [] }, plugins)
    expect(getEnabledPluginIds(fresh)).toEqual([])
    const enabled = normalizePluginSettings({ ...fresh, disabled: fresh.disabled.filter((id) => id !== "codex") }, plugins)
    expect(getEnabledPluginIds(enabled)).toEqual(["codex"])
  })

  it("does not load or show the upstream retirement notice", async () => {
    const { container } = render(<RetirementNotice />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(mocks.storeGet).not.toHaveBeenCalled()
  })

  it("shows the independent name and build number without update actions", () => {
    render(<PanelFooter version="0.6.28" autoUpdateNextAt={null} updateStatus={{ status: "ready" }} onUpdateInstall={vi.fn()} onUpdateCheck={vi.fn()} showAbout={false} onShowAbout={vi.fn()} onCloseAbout={vi.fn()} />)
    expect(screen.getByRole("button", { name: "TokenUsageWidget 0.6.28 · 20261022.1" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /restart to update/i })).not.toBeInTheDocument()
    expect(formatTrayTooltip([], [])).toBe("TokenUsageWidget")
  })

  it("identifies the separate edition in About", () => {
    render(<AboutDialog version="0.6.28" onClose={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "TokenUsageWidget" })).toBeInTheDocument()
    expect(screen.getByText("建置 20261022.1")).toBeInTheDocument()
  })

  it("explains disabled app updates in Settings without offering an update button", () => {
    render(<SettingsPage
      plugins={[]} onReorder={vi.fn()} onToggle={vi.fn()} autoUpdateInterval={15} onAutoUpdateIntervalChange={vi.fn()}
      themeMode="system" onThemeModeChange={vi.fn()} displayMode="left" onDisplayModeChange={vi.fn()}
      resetTimerDisplayMode="relative" onResetTimerDisplayModeChange={vi.fn()} timeFormatMode="auto" onTimeFormatModeChange={vi.fn()}
      menubarIconStyle="provider" onMenubarIconStyleChange={vi.fn()} menubarMetric="default" onMenubarMetricChange={vi.fn()}
      traySettingsPreview={{ bars: [], providerBars: [], providerItems: [], providerPercentText: "--%" }}
      globalShortcut={null} onGlobalShortcutChange={vi.fn()} startOnLogin={false} onStartOnLoginChange={vi.fn()}
    />)
    fireEvent.click(screen.getByRole("tab", { name: "更新與系統" }))
    expect(screen.getByText("獨立版手動更新")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /check for updates|restart to update/i })).not.toBeInTheDocument()
  })
})
