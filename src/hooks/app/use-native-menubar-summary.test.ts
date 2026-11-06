import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useNativeMenubarSummary } from "./use-native-menubar-summary"
import type { MenubarSummaryState } from "@/lib/menubar-summary"

const native = vi.hoisted(() => ({ invoke: vi.fn(), handler: undefined as undefined | ((event: { payload: MenubarSummaryState }) => void) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, handler) => { native.handler = handler; return () => {} }) }))
const settings = { order: ["claude", "codex", "antigravity"], disabled: ["codex"], menubarMetrics: { antigravity: "Gemini Flash" } }
const ready = () => Promise.resolve()
const response = (enabled = true): MenubarSummaryState => ({ enabled, pluginIds: ["claude", "antigravity"], geminiMetric: "flash", groups: [], error: null })
beforeEach(() => { vi.useRealTimers(); native.invoke.mockReset(); native.handler = undefined; native.invoke.mockImplementation(async (_cmd, args) => response(args.enabled)) })

describe("native dual quota configuration", () => {
  it("switches detailed and compact native themes and rejects late summaries from the previous theme", async () => {
    native.invoke.mockImplementation(async (_cmd, args) => ({ ...response(args.enabled), style: args.style ?? "quota" }))
    const { result, rerender } = renderHook(({ style }: { style: "compact" | "quota" }) => useNativeMenubarSummary(true, settings, ready, style), { initialProps: { style: "quota" as "compact" | "quota" } })
    await waitFor(() => expect(result.current.summary?.style).toBe("quota"))
    rerender({ style: "compact" })
    await waitFor(() => expect(result.current.summary?.style).toBe("compact"))
    expect(native.invoke).toHaveBeenLastCalledWith("configure_menubar_summary", expect.objectContaining({ enabled: true, style: "compact" }))
    act(() => native.handler?.({ payload: { ...response(), error: "obsolete detailed event" } }))
    expect(result.current.error).toBeNull()
    act(() => native.handler?.({ payload: { ...response(), style: "compact", error: "current compact error" } }))
    expect(result.current.error).toBe("current compact error")
    rerender({ style: "quota" })
    await waitFor(() => expect(result.current.summary?.style).toBe("quota"))
    act(() => native.handler?.({ payload: { ...response(), style: "compact", error: "obsolete compact event" } }))
    expect(result.current.error).toBeNull()
  })
  it("leaves existing legacy styles untouched until the user enables dual quota", () => {
    renderHook(() => useNativeMenubarSummary(false, settings, ready))
    expect(native.invoke).not.toHaveBeenCalled()
  })
  it("configures enabled order and Gemini selection without reconfiguring on an identical settings render", async () => {
    const { result, rerender } = renderHook(({ value }) => useNativeMenubarSummary(true, value, ready), { initialProps: { value: settings } })
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    expect(native.invoke).toHaveBeenCalledWith("configure_menubar_summary", { enabled: true, pluginIds: ["claude", "antigravity"], geminiMetric: "flash", metricSelections: settings.menubarMetrics })
    rerender({ value: { ...settings, order: [...settings.order] } })
    expect(native.invoke).toHaveBeenCalledTimes(1)
  })
  it("waits for an outstanding canvas paint before taking native ownership", async () => {
    let release!: () => void
    const painting = new Promise<void>(resolve => { release = resolve })
    const before = () => painting
    const { result } = renderHook(() => useNativeMenubarSummary(true, settings, before))
    await act(async () => { await Promise.resolve() })
    expect(native.invoke).not.toHaveBeenCalled()
    expect(result.current.owned).toBe(true)
    await act(async () => { release() })
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1))
  })
  it("keeps legacy writers blocked until native disable is acknowledged", async () => {
    let disable!: (value: MenubarSummaryState) => void
    native.invoke.mockImplementation(async (_cmd, args) => args.enabled ? response() : new Promise(resolve => { disable = resolve }))
    const { result, rerender } = renderHook(({ enabled }) => useNativeMenubarSummary(enabled, settings, ready), { initialProps: { enabled: true } })
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    rerender({ enabled: false })
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2))
    expect(result.current.owned).toBe(true)
    await act(async () => { disable(response(false)) })
    expect(result.current.owned).toBe(false)
  })
  it("shows rendering failures and ignores summaries for a different enabled selection", async () => {
    const { result } = renderHook(() => useNativeMenubarSummary(true, settings, ready))
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    act(() => native.handler?.({ payload: { ...response(), pluginIds: ["codex"], error: "wrong scope" } }))
    expect(result.current.error).toBeNull()
    act(() => native.handler?.({ payload: { ...response(), error: "無法繪製選單列摘要" } }))
    expect(result.current.error).toBe("無法繪製選單列摘要")
    act(() => native.handler?.({ payload: response() }))
    expect(result.current.error).toBeNull()
  })
  it("reports rejected native configuration without claiming success", async () => {
    native.invoke.mockRejectedValue(new Error("native unavailable"))
    const { result } = renderHook(() => useNativeMenubarSummary(true, settings, ready))
    await waitFor(() => expect(result.current.error).toMatch(/無法啟用/))
    expect(result.current.summary).toBeNull()
  })
  it("bounds a stuck prior painter and permits a later style change to recover", async () => {
    vi.useFakeTimers()
    const stuck = () => new Promise<void>(() => {})
    const { result, rerender } = renderHook(({ before }) => useNativeMenubarSummary(true, settings, before), { initialProps: { before: stuck } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.error).toMatch(/無法啟用/)
    expect(native.invoke).not.toHaveBeenCalled()
    rerender({ before: ready })
    await act(async () => { await Promise.resolve() })
    expect(result.current.error).toBeNull()
    expect(native.invoke).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
