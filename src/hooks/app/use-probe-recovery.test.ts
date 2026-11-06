import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"

const { handlers, invokeMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: any }) => void>(), invokeMock: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  handlers.set(name, handler)
  return () => handlers.delete(name)
}) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => false }))

import { useProbe } from "./use-probe"
import { probeBatchTimeoutMs } from "../use-probe-events"

const quota = (used: number): PluginOutput => ({ providerId: "codex", displayName: "Codex", iconUrl: "",
  lines: [{ type: "progress", label: "Session", used, limit: 100, format: { kind: "percent" } }],
})
const emit = (name: string, payload: unknown) => act(() => handlers.get(name)?.({ payload }))
const props = { pluginSettings: { order: ["codex"], disabled: [] }, autoUpdateInterval: 5 as const }

describe("refresh recovery across native calls and UI state", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T00:00:00Z"))
    handlers.clear(); invokeMock.mockReset()
    invokeMock.mockImplementation(async (_, args) => ({ batchId: args.batchId, pluginIds: args.pluginIds }))
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it("releases a hung request on wake, starts an overdue refresh, and rejects stale results/rejections", async () => {
    const { result } = renderHook(() => useProbe(props))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const initial = invokeMock.mock.calls[0][1].batchId
    emit("probe:result", { batchId: initial, output: quota(87) })
    emit("probe:batch-complete", { batchId: initial })
    const updatedAt = result.current.pluginStates.codex.lastUpdatedAt
    let rejectOld!: (error: Error) => void
    invokeMock.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    const old = invokeMock.mock.calls[1][1].batchId
    expect(result.current.pluginStates.codex.loading).toBe(true)
    // Simulate suspended timers; only wall-clock advances, then the panel regains focus.
    vi.setSystemTime(Date.now() + 17 * 60 * 60 * 1000)
    emit("tray:shown", {})
    await act(async () => { await Promise.resolve() })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: true, data: quota(87), lastUpdatedAt: updatedAt })
    expect(invokeMock).toHaveBeenCalledTimes(3)
    const current = invokeMock.mock.calls[2][1].batchId
    emit("probe:result", { batchId: current, output: quota(9) })
    emit("probe:batch-complete", { batchId: current })
    emit("probe:result", { batchId: old, output: quota(87) })
    emit("probe:batch-complete", { batchId: old })
    await act(async () => { rejectOld(new Error("old native rejection")); await Promise.resolve() })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(9) })
    expect(result.current.pluginStates.codex.lastUpdatedAt).toBeGreaterThan(updatedAt!)
  })

  it("closes missing results at batch completion, keeps successful providers, and ignores duplicate output", async () => {
    const settings = { ...props, pluginSettings: { order: ["codex", "claude"], disabled: [] } }
    const { result } = renderHook(() => useProbe(settings))
    act(() => result.current.setLoadingForPlugins(["codex", "claude"]))
    await act(async () => { await result.current.startBatch(["codex", "claude"]) })
    const batchId = invokeMock.mock.calls[0][1].batchId
    emit("probe:result", { batchId, output: quota(9) })
    emit("probe:result", { batchId, output: quota(87) })
    emit("probe:batch-complete", { batchId })
    expect(result.current.pluginStates.codex).toMatchObject({ error: null, loading: false, data: quota(9) })
    expect(result.current.pluginStates.claude).toMatchObject({ loading: false, error: "更新未完成，請重新整理" })
  })

  it("permits immediate manual recovery despite a recent successful manual refresh", async () => {
    const { result } = renderHook(() => useProbe(props))
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    const first = invokeMock.mock.calls[0][1].batchId
    emit("probe:result", { batchId: first, output: quota(9) })
    emit("probe:batch-complete", { batchId: first })
    expect(result.current.pluginStates.codex.lastManualRefreshAt).toBe(Date.now())
    act(() => result.current.setLoadingForPlugins(["codex"]))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const second = invokeMock.mock.calls[1][1].batchId
    emit("probe:batch-complete", { batchId: second })
    expect(result.current.pluginStates.codex.error).toBeTruthy()
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(result.current.pluginStates.codex.loading).toBe(true)
  })

  it("allows the next automatic update after a lost result times out", async () => {
    const { result } = renderHook(() => useProbe(props))
    act(() => result.current.setLoadingForPlugins(["codex"]))
    await act(async () => { await result.current.startBatch(["codex"]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
    expect(result.current.pluginStates.codex.loading).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(255_000) })
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(result.current.pluginStates.codex.loading).toBe(true)
  })

  it("budgets queued batches and settles callers even if native invoke never resolves", async () => {
    expect(probeBatchTimeoutMs(3)).toBe(45_000)
    expect(probeBatchTimeoutMs(5)).toBe(75_000)
    invokeMock.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useProbe(props))
    let pending!: ReturnType<typeof result.current.startBatch>
    act(() => { pending = result.current.startBatch(["codex"]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
    await expect(pending).resolves.toBeUndefined()
    expect(result.current.pluginStates.codex.error).toContain("逾時")
  })

  it("closes a failed native start and permits a new manual attempt", async () => {
    invokeMock.mockRejectedValueOnce(new Error("fixture start failure"))
    const { result } = renderHook(() => useProbe(props))
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: "無法開始更新，請重新整理" })
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(result.current.pluginStates.codex.loading).toBe(true)
  })

  it("handles an unselected provider without leaving it loading", async () => {
    invokeMock.mockImplementationOnce(async (_, args) => ({ batchId: args.batchId, pluginIds: [] }))
    const { result } = renderHook(() => useProbe(props))
    act(() => result.current.setLoadingForPlugins(["codex"]))
    await act(async () => { await result.current.startBatch(["codex"]) })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: "服務無法更新，請檢查設定" })
  })

  it("gives a queued fifth provider its second worker wave before expiring", async () => {
    const ids = ["codex", "claude", "a", "b", "c"]
    const settings = { ...props, pluginSettings: { order: ids, disabled: [] } }
    const { result } = renderHook(() => useProbe(settings))
    act(() => result.current.setLoadingForPlugins(ids))
    await act(async () => { await result.current.startBatch(ids) })
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
    expect(result.current.pluginStates.c).toMatchObject({ loading: true, error: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    for (const id of ids) expect(result.current.pluginStates[id]).toMatchObject({ loading: false, error: "更新逾時，請重新整理" })
  })

  it("accepts two consecutive automatic results across rerenders and panel reopen without restarting batches", async () => {
    const callbacks = [vi.fn(), vi.fn(), vi.fn()]
    const { result, rerender } = renderHook(({ onProbeResult }) => useProbe({ ...props, onProbeResult }), {
      initialProps: { onProbeResult: callbacks[0] },
    })
    act(() => result.current.setLoadingForPlugins(["codex"]))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const first = invokeMock.mock.calls[0][1].batchId
    rerender({ onProbeResult: callbacks[1] })
    emit("probe:result", { batchId: first, output: quota(10) })
    emit("probe:batch-complete", { batchId: first })
    expect(callbacks[1]).toHaveBeenCalledTimes(1)
    expect(callbacks[0]).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    const second = invokeMock.mock.calls[1][1].batchId
    rerender({ onProbeResult: callbacks[2] })
    emit("tray:shown", {})
    expect(invokeMock).toHaveBeenCalledTimes(2)
    emit("probe:result", { batchId: second, output: quota(20) })
    emit("probe:batch-complete", { batchId: second })
    const secondUpdatedAt = result.current.pluginStates.codex.lastUpdatedAt
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(20) })

    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    const third = invokeMock.mock.calls[2][1].batchId
    emit("probe:result", { batchId: third, output: quota(30) })
    emit("probe:batch-complete", { batchId: third })
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(callbacks[2]).toHaveBeenCalledTimes(2)
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(30) })
    expect(result.current.pluginStates.codex.lastUpdatedAt).toBeGreaterThan(secondUpdatedAt!)
  })

  it("keeps an active watchdog through callback changes and accepts a fresh retry after timeout", async () => {
    const { result, rerender } = renderHook(({ onProbeResult }) => useProbe({ ...props, onProbeResult }), {
      initialProps: { onProbeResult: vi.fn() },
    })
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    const expired = invokeMock.mock.calls[0][1].batchId
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    rerender({ onProbeResult: vi.fn() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: "更新逾時，請重新整理" })
    act(() => result.current.handleRetryPlugin("codex"))
    await act(async () => { await Promise.resolve() })
    const current = invokeMock.mock.calls[1][1].batchId
    emit("probe:result", { batchId: current, output: quota(40) })
    emit("probe:batch-complete", { batchId: current })
    emit("probe:result", { batchId: expired, output: quota(10) })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(40) })
  })
})
