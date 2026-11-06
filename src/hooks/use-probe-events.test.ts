import { renderHook, act } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"

const { listeners, invokeMock, listenMock } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => false,
}))

import { useProbeEvents } from "@/hooks/use-probe-events"

describe("useProbeEvents", () => {
  beforeEach(() => {
    listeners.clear()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockImplementation(async (event: string, cb: (event: { payload: any }) => void) => {
      listeners.set(event, cb)
      return () => listeners.delete(event)
    })
  })

  it("starts batch and returns plugin ids", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    const ids = await act(() => result.current.startBatch(["a", "b"]))
    expect(invokeMock).toHaveBeenCalledWith("start_probe_batch", expect.objectContaining({ pluginIds: ["a", "b"] }))
    expect(ids).toEqual(["a", "b"])
  })

  it("starts batch without plugin ids and uses fallback id", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test fallback path
    delete globalThis.crypto
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      const ids = await act(() => result.current.startBatch())
      expect(ids).toEqual([])
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: expect.stringMatching(/^batch-/) })
      )
    } finally {
      if (originalCrypto === undefined) {
        // @ts-expect-error cleanup undefined crypto
        delete globalThis.crypto
      } else {
        globalThis.crypto = originalCrypto
      }
    }
  })

  it("uses crypto randomUUID when available", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test randomUUID path
    globalThis.crypto = { randomUUID: vi.fn(() => "uuid-123") }
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      await act(() => result.current.startBatch())
      expect(globalThis.crypto?.randomUUID).toHaveBeenCalled()
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: "uuid-123" })
      )
    } finally {
      globalThis.crypto = originalCrypto
    }
  })

  it("does not start a batch after unmount", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const { result, unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    const start = result.current.startBatch
    unmount()
    const ids = await act(() => start())
    expect(ids).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("routes probe events to active batch", async () => {
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: args.pluginIds ?? [] }
    })
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const batchId = lastArgs.batchId

    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledWith(output)

    completeListener?.({ payload: { batchId } })
    expect(onBatchComplete).toHaveBeenCalledTimes(1)

    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it("ignores events for inactive batch", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId: "other", output } })
    completeListener?.({ payload: { batchId: "other" } })

    expect(onResult).not.toHaveBeenCalled()
    expect(onBatchComplete).not.toHaveBeenCalled()
  })

  it("accepts a fast result before the native start acknowledgement even with discovered ids", async () => {
    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      listeners.get("probe:result")?.({ payload: { batchId: args.batchId, output } })
      return { batchId: args.batchId, pluginIds: ["a"] }
    })
    const onResult = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete: vi.fn() }))
    await act(() => result.current.startBatch())
    expect(onResult).toHaveBeenCalledExactlyOnceWith(output)
    const batchId = invokeMock.mock.calls[0][1].batchId
    listeners.get("probe:batch-complete")?.({ payload: { batchId } })
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it("delivers a terminal error instead of leaving loading when invoke fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )

    await expect(result.current.startBatch(["a"])).resolves.toBeUndefined()
  })

  it("cancels before listeners are ready", async () => {
    const unlisten = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock.mockImplementationOnce(() => new Promise((resolve) => {
      ref.resolve = resolve
    }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    unmount()
    ref.resolve?.(unlisten)
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })

  it("fails pending providers cleanly when listener registration fails", async () => {
    listenMock.mockRejectedValueOnce(new Error("fixture listener failure"))
    const onResult = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete: vi.fn() }))
    await act(() => result.current.startBatch(["codex"]))
    expect(invokeMock).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult.mock.calls[0][0]).toMatchObject({ providerId: "codex", lines: [{ type: "badge", label: "Error" }] })
  })

  it("cancels after first listener is ready", async () => {
    const unlistenFirst = vi.fn()
    const unlistenSecond = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock
      .mockImplementationOnce(async () => unlistenFirst)
      .mockImplementationOnce(() => new Promise((resolve) => {
        ref.resolve = resolve
      }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    await Promise.resolve()
    unmount()
    ref.resolve?.(unlistenSecond)
    await Promise.resolve()
    expect(unlistenFirst).toHaveBeenCalled()
    expect(unlistenSecond).toHaveBeenCalled()
  })
})
