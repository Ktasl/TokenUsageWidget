import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"
import type { AutoUpdateIntervalMinutes, PluginSettings } from "@/lib/settings"

const native = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: any }) => unknown>() }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  native.handlers.set(name, handler)
  return () => native.handlers.delete(name)
}) }))

import { useProbe } from "@/hooks/app/use-probe"
import { useNativeBackground } from "@/hooks/app/use-native-background"

const start = Date.parse("2026-10-25T00:00:00Z")
const settings: PluginSettings = { order: ["claude", "codex", "antigravity"], disabled: ["antigravity"] }
const props = { pluginSettings: settings, autoUpdateInterval: 5 as const }
const quota = (used: number): PluginOutput => ({ providerId: "codex", displayName: "Codex", iconUrl: "",
  lines: [{ type: "progress", label: "Session", used, limit: 100, format: { kind: "percent" } }],
})
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const emit = async (event: string, payload: unknown = {}) => { await act(async () => { await native.handlers.get(event)?.({ payload }) }) }
const batches = () => native.invoke.mock.calls.filter(([command]) => command === "start_probe_batch")

describe("independent native background bridge acceptance", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    native.handlers.clear()
    native.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "start_probe_batch") return { batchId: args.batchId, pluginIds: args.pluginIds }
      if (command === "get_background_usage") return []
      return undefined
    })
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it("configures enabled IDs and intervals once per value change, including disabling every provider", async () => {
    const { result, rerender } = renderHook(({ current, interval }) => useNativeBackground(current, interval), {
      initialProps: { current: settings as PluginSettings | null, interval: 5 as AutoUpdateIntervalMinutes },
    })
    await flush()
    expect(result.current.ready).toBe(true)
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("configure_background_refresh", { pluginIds: ["claude", "codex"], intervalMinutes: 5 })
    rerender({ current: { ...settings, order: [...settings.order], disabled: [...settings.disabled] }, interval: 5 })
    await flush()
    expect(native.invoke).toHaveBeenCalledTimes(1)
    rerender({ current: settings, interval: 15 })
    await flush()
    expect(native.invoke).toHaveBeenLastCalledWith("configure_background_refresh", { pluginIds: ["claude", "codex"], intervalMinutes: 15 })
    rerender({ current: { ...settings, disabled: [...settings.order] }, interval: 15 })
    await flush()
    expect(native.invoke).toHaveBeenLastCalledWith("configure_background_refresh", { pluginIds: [], intervalMinutes: 15 })
    expect(native.invoke).toHaveBeenCalledTimes(3)
  })

  it("waits for settings and reports native configuration failure without claiming ready", async () => {
    const { result, rerender } = renderHook(({ current }) => useNativeBackground(current, 5), { initialProps: { current: null as PluginSettings | null } })
    await flush()
    expect(native.invoke).not.toHaveBeenCalled()
    native.invoke.mockRejectedValueOnce(new Error("fixture native failure"))
    rerender({ current: settings })
    await flush()
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toContain("背景更新尚未啟動")
    rerender({ current: { ...settings, disabled: [] } })
    await flush()
    expect(result.current.ready).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it("does not create duplicate hidden JS batches when native scheduling is ready", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    renderHook(() => useProbe(props))
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60_000) })
    expect(batches()).toHaveLength(0)
    expect(native.invoke.mock.calls.filter(([command]) => command === "configure_background_refresh")).toHaveLength(1)
  })

  it("reopens from the tray despite stale DOM hidden visibility, merges snapshots then starts an overdue query", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    const { result } = renderHook(() => useProbe(props))
    await flush()
    vi.setSystemTime(start + 600_000)
    const fetchedAt = Date.now() - 30_000
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "get_background_usage") return [{ output: quota(15), fetchedAt }]
      if (command === "start_probe_batch") return { batchId: args.batchId, pluginIds: args.pluginIds }
    })
    await emit("tray:shown")
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(15), lastUpdatedAt: fetchedAt, loading: true })
    expect(batches()).toHaveLength(1)
    const batchId = batches()[0][1].batchId
    await emit("probe:result", { batchId, output: quota(20) })
    await emit("probe:batch-complete", { batchId })
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(20), lastUpdatedAt: Date.now(), loading: false })
  })

  it("accepts two background updates at source timestamps and ignores old or future snapshots", async () => {
    const { result } = renderHook(() => useProbe(props))
    await flush()
    const first = start - 20_000
    const second = start - 10_000
    await emit("probe:background-result", { output: quota(10), fetchedAt: first })
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(10), lastUpdatedAt: first })
    await emit("probe:background-result", { output: quota(20), fetchedAt: second })
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(20), lastUpdatedAt: second })
    await emit("probe:background-result", { output: quota(1), fetchedAt: first })
    await emit("probe:background-result", { output: quota(99), fetchedAt: start + 1 })
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(20), lastUpdatedAt: second, loading: false })
  })

  it("protects a foreground-owned pending result and then rejects an older pulled snapshot", async () => {
    const { result } = renderHook(() => useProbe(props))
    await flush()
    act(() => result.current.handleRetryPlugin("codex"))
    await flush()
    const batchId = batches()[0][1].batchId
    await emit("probe:background-result", { output: quota(90), fetchedAt: start })
    expect(result.current.pluginStates.codex).toMatchObject({ data: null, loading: true })
    await emit("probe:result", { batchId, output: quota(30) })
    await emit("probe:batch-complete", { batchId })
    native.invoke.mockResolvedValueOnce([{ output: quota(90), fetchedAt: start - 1 }])
    await emit("tray:shown")
    expect(result.current.pluginStates.codex).toMatchObject({ data: quota(30), lastUpdatedAt: start, loading: false })
    expect(result.current.pluginStates.codex.lastManualRefreshAt).toBe(start)
  })

  it("continues an overdue visible refresh if snapshot retrieval fails", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    renderHook(() => useProbe(props))
    await flush()
    vi.setSystemTime(start + 600_000)
    native.invoke.mockRejectedValueOnce(new Error("snapshot fixture failure"))
    await emit("tray:shown")
    expect(error).toHaveBeenCalledWith("probe_refresh outcome=background_snapshot_failed")
    expect(batches()).toHaveLength(1)
  })

  it("does not let a non-returning snapshot pull hold reopening refresh forever", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    renderHook(() => useProbe(props))
    await flush()
    vi.setSystemTime(start + 600_000)
    native.invoke.mockImplementation((command, args) => command === "get_background_usage"
      ? new Promise(() => {}) : Promise.resolve(command === "start_probe_batch" ? { batchId: args.batchId, pluginIds: args.pluginIds } : undefined))
    act(() => { void native.handlers.get("tray:shown")?.({ payload: {} }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
    expect(batches()).toHaveLength(1)
  })
})
