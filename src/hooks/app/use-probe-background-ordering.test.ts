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
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }))
import { useProbe } from "./use-probe"

const quota = (used: number): PluginOutput => ({ providerId: "codex", displayName: "Codex", iconUrl: "",
  lines: [{ type: "progress", label: "Session", used, limit: 100, format: { kind: "percent" } }],
})
const props = { pluginSettings: { order: ["codex"], disabled: [] }, autoUpdateInterval: 5 as const }
type Snapshot = { output: PluginOutput; fetchedAt: number }

const emit = async (name: string, payload: unknown) => act(async () => {
  handlers.get(name)?.({ payload })
  await Promise.resolve()
})

describe("foreground and native background ordering", () => {
  let snapshots: Snapshot[]
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T00:00:00Z"))
    handlers.clear(); invokeMock.mockReset(); snapshots = []
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "configure_background_refresh") return
      if (cmd === "get_background_usage") return snapshots
      return { batchId: args.batchId, pluginIds: args.pluginIds }
    })
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it("reconciles a newer background snapshot skipped during a superseded foreground batch, then accepts two later refreshes", async () => {
    const { result } = renderHook(() => useProbe(props))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const first = invokeMock.mock.calls.find(([cmd]) => cmd === "start_probe_batch")![1].batchId
    await emit("probe:result", { batchId: first, output: quota(87) })
    await emit("probe:batch-complete", { batchId: first })
    const initialTime = result.current.pluginStates.codex.lastUpdatedAt!
    vi.setSystemTime(Date.now() + 1000)
    act(() => result.current.setLoadingForPlugins(["codex"]))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const foreground = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
    vi.setSystemTime(Date.now() + 1000)
    const backgroundTime = Date.now()
    snapshots = [{ output: quota(9), fetchedAt: backgroundTime }]
    await emit("probe:background-result", snapshots[0])
    expect(result.current.pluginStates.codex).toMatchObject({ loading: true, data: quota(87) })
    vi.setSystemTime(Date.now() + 1000)
    // Native generation ownership suppresses the older foreground success payload.
    // Its batch-complete must clear pending ownership and recover the newer snapshot.
    await emit("probe:batch-complete", { batchId: foreground })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(9), lastUpdatedAt: backgroundTime })
    expect(backgroundTime).toBeGreaterThan(initialTime)
    for (const used of [8, 7]) {
      vi.setSystemTime(Date.now() + 1000)
      act(() => result.current.setLoadingForPlugins(["codex"]))
      await act(async () => { await result.current.startBatch(["codex"]) })
      const batchId = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
      await emit("probe:result", { batchId, output: quota(used) })
      await emit("probe:batch-complete", { batchId })
      expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(used) })
    }
  })

  it("does not let a delayed reconciliation snapshot replace a newly pending foreground request", async () => {
    const { result } = renderHook(() => useProbe(props))
    let resolvePull!: (snapshots: Snapshot[]) => void
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd === "get_background_usage") return new Promise(resolve => { resolvePull = resolve })
      return Promise.resolve(cmd === "start_probe_batch" ? { batchId: args.batchId, pluginIds: args.pluginIds } : undefined)
    })
    await act(async () => { await result.current.startBatch(["codex"]) })
    const old = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
    await emit("probe:batch-complete", { batchId: old })
    await act(async () => { await result.current.startBatch(["codex"]) })
    const current = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
    await act(async () => { resolvePull([{ output: quota(87), fetchedAt: Date.now() }]); await Promise.resolve() })
    expect(result.current.pluginStates.codex.data).toBeNull()
    await emit("probe:result", { batchId: current, output: quota(7) })
    expect(result.current.pluginStates.codex.data).toEqual(quota(7))
  })

  it("bounds a lost reconciliation pull at two seconds and permits the next query", async () => {
    const { result } = renderHook(() => useProbe(props))
    invokeMock.mockImplementation((cmd, args) => cmd === "get_background_usage" ? new Promise(() => {}) :
      Promise.resolve(cmd === "start_probe_batch" ? { batchId: args.batchId, pluginIds: args.pluginIds } : undefined))
    await act(async () => { await result.current.startBatch(["codex"]) })
    const old = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
    await emit("probe:batch-complete", { batchId: old })
    expect(result.current.pluginStates.codex.loading).toBe(false)
    expect(invokeMock).toHaveBeenCalledWith("get_background_usage")
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(2001) })
    expect(error).toHaveBeenCalledWith("probe_refresh outcome=background_snapshot_timed_out")
    await act(async () => { await result.current.startBatch(["codex"]) })
    const current = invokeMock.mock.calls.filter(([cmd]) => cmd === "start_probe_batch").at(-1)![1].batchId
    await emit("probe:result", { batchId: current, output: quota(7) })
    expect(result.current.pluginStates.codex).toMatchObject({ loading: false, error: null, data: quota(7) })
  })
})
