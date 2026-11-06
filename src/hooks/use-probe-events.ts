import { useCallback, useEffect, useRef } from "react"
import { listen } from "@tauri-apps/api/event"
import { invoke, isTauri } from "@tauri-apps/api/core"
import type { PluginOutput } from "@/lib/plugin-types"

type ProbeResult = { batchId: string; output: PluginOutput }
type ProbeBatchStarted = { batchId: string; pluginIds: string[] }
type Options = { onResult: (output: PluginOutput, fetchedAt?: number) => void; onBatchComplete: () => void }
type Batch = {
  pending: Set<string>
  seen: Set<string>
  sequence: number
  discover: boolean
  deadline: number
  timer: ReturnType<typeof setTimeout>
  settle: () => void
}

// Native workers run at most four 30s probes concurrently; include queue time.
export const probeBatchTimeoutMs = (count: number) => Math.max(1, Math.ceil(count / 4)) * 30_000 + 15_000

export function useProbeEvents({ onResult, onBatchComplete }: Options) {
  const batches = useRef(new Map<string, Batch>())
  const latest = useRef(new Map<string, { batchId: string; sequence: number }>())
  const sequence = useRef(0)
  const callbacks = useRef({ onResult, onBatchComplete })
  callbacks.current = { onResult, onBatchComplete }
  const ready = useRef<Promise<void> | null>(null)
  const mounted = useRef(false)

  const finish = useCallback((batchId: string, message?: string) => {
    const batch = batches.current.get(batchId)
    if (!batch) return
    batches.current.delete(batchId)
    clearTimeout(batch.timer)
    for (const id of batch.pending) {
      if (latest.current.get(id)?.batchId !== batchId) continue
      if (message) callbacks.current.onResult({
        providerId: id, displayName: id, iconUrl: "",
        lines: [{ type: "badge", label: "Error", text: message }],
      })
    }
    batch.settle()
    callbacks.current.onBatchComplete()
  }, [])

  const expire = useCallback(() => {
    const now = Date.now()
    for (const [id, batch] of batches.current) {
      if (now >= batch.deadline) {
        console.error("probe_refresh outcome=timed_out pending_count=", batch.pending.size)
        finish(id, "更新逾時，請重新整理")
      }
    }
  }, [finish])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const unlisteners: (() => void)[] = []
    const reconcileBackground = async (providers?: Set<string>) => {
      if (!isTauri()) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const snapshots = await Promise.race([
          invoke<{ output: PluginOutput; fetchedAt: number }[]>("get_background_usage"),
          new Promise<[]>(resolve => { timer = setTimeout(() => {
            console.error("probe_refresh outcome=background_snapshot_timed_out")
            resolve([])
          }, 2000) }),
        ])
        if (cancelled) return
        for (const snapshot of snapshots) {
          const id = snapshot.output.providerId
          if (providers && !providers.has(id)) continue
          const owner = latest.current.get(id)?.batchId
          if (owner && batches.current.get(owner)?.pending.has(id)) continue
          if (Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt <= Date.now()) callbacks.current.onResult(snapshot.output, snapshot.fetchedAt)
        }
      } catch { console.error("probe_refresh outcome=background_snapshot_failed") }
      finally { clearTimeout(timer) }
    }
    ready.current = (async () => {
      const resultUnlisten = await listen<ProbeResult>("probe:result", ({ payload }) => {
        expire()
        const batch = batches.current.get(payload.batchId)
        const id = payload.output.providerId
        if (!batch) return
        if (batch.discover && !batch.seen.has(id)) {
          if ((latest.current.get(id)?.sequence ?? -1) > batch.sequence) return
          latest.current.set(id, { batchId: payload.batchId, sequence: batch.sequence })
          batch.seen.add(id)
          batch.pending.add(id)
        }
        if (latest.current.get(id)?.batchId !== payload.batchId || !batch.pending.delete(id)) return
        callbacks.current.onResult(payload.output)
      })
      if (cancelled) { resultUnlisten(); return }
      unlisteners.push(resultUnlisten)
      const completeUnlisten = await listen<{ batchId: string }>("probe:batch-complete", ({ payload }) => {
        expire()
        const missing = new Set([...(batches.current.get(payload.batchId)?.pending ?? [])]
          .filter(id => latest.current.get(id)?.batchId === payload.batchId))
        finish(payload.batchId, "更新未完成，請重新整理")
        // Native suppresses superseded foreground results. Clear their pending
        // ownership before recovering a newer background result skipped earlier.
        if (missing.size > 0) void reconcileBackground(missing)
      })
      if (cancelled) { completeUnlisten(); return }
      unlisteners.push(completeUnlisten)
      const backgroundUnlisten = await listen<{ output: PluginOutput; fetchedAt: number }>("probe:background-result", ({ payload }) => {
        expire()
        const owner = latest.current.get(payload.output.providerId)?.batchId
        if (owner && batches.current.get(owner)?.pending.has(payload.output.providerId)) return
        if (Number.isFinite(payload.fetchedAt) && payload.fetchedAt <= Date.now()) callbacks.current.onResult(payload.output, payload.fetchedAt)
      })
      if (cancelled) { backgroundUnlisten(); return }
      unlisteners.push(backgroundUnlisten)
      // A native menu-bar panel can reopen without a DOM visibility transition.
      const shownUnlisten = await listen("tray:shown", () => {
        expire()
        const resume = () => { if (!cancelled) window.dispatchEvent(new Event("usage:resume")) }
        void reconcileBackground().then(resume)
      })
      if (cancelled) { shownUnlisten(); return }
      unlisteners.push(shownUnlisten)
    })()
    // Register a handler immediately even if there is no batch awaiting setup yet.
    void ready.current.catch(() => {
      console.error("probe_refresh outcome=listener_failed")
      for (const id of batches.current.keys()) finish(id, "無法接收更新，請重新開啟應用程式")
    })
    // Per-batch timers still enforce the exact deadline; this is only a wall-clock backup.
    const interval = setInterval(expire, 15_000)
    window.addEventListener("focus", expire)
    document.addEventListener("visibilitychange", expire)
    return () => {
      cancelled = true
      mounted.current = false
      clearInterval(interval)
      window.removeEventListener("focus", expire)
      document.removeEventListener("visibilitychange", expire)
      for (const batch of batches.current.values()) {
        clearTimeout(batch.timer)
        batch.settle()
      }
      batches.current.clear()
      latest.current.clear()
      unlisteners.forEach((unlisten) => unlisten())
      ready.current = null
    }
  }, [expire, finish])

  const startBatch = useCallback(async (pluginIds?: string[]) => {
    if (!mounted.current) return []
    const ids = [...new Set(pluginIds ?? [])]
    const batchId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID() : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`
    let settle!: () => void
    const ended = new Promise<undefined>((resolve) => { settle = () => resolve(undefined) })
    const timeout = probeBatchTimeoutMs(ids.length)
    const batch: Batch = { pending: new Set(ids), seen: new Set(ids), sequence: ++sequence.current, discover: !pluginIds, deadline: Date.now() + timeout,
      timer: setTimeout(expire, timeout), settle }
    batches.current.set(batchId, batch)
    for (const id of ids) latest.current.set(id, { batchId, sequence: batch.sequence })

    const request = (async () => {
      try {
        await ready.current
        if (!batches.current.has(batchId)) return []
        const response = await invoke<ProbeBatchStarted>("start_probe_batch", pluginIds ? { batchId, pluginIds: ids } : { batchId })
        if (!batches.current.has(batchId)) return []
        if (!pluginIds) {
          for (const id of response.pluginIds) {
            if (!batch.seen.has(id) && (latest.current.get(id)?.sequence ?? -1) < batch.sequence) {
              latest.current.set(id, { batchId, sequence: batch.sequence })
              batch.pending.add(id)
              batch.seen.add(id)
            }
          }
        }
        if (!pluginIds) {
          batch.deadline += probeBatchTimeoutMs(response.pluginIds.length) - timeout
          clearTimeout(batch.timer)
          batch.timer = setTimeout(expire, Math.max(0, batch.deadline - Date.now()))
        }
        const selected = new Set(response.pluginIds)
        for (const id of batch.pending) {
          if (selected.has(id) || latest.current.get(id)?.batchId !== batchId) continue
          batch.pending.delete(id)
          callbacks.current.onResult({ providerId: id, displayName: id, iconUrl: "",
            lines: [{ type: "badge", label: "Error", text: "服務無法更新，請檢查設定" }] })
        }
        return response.pluginIds
      } catch {
        if (batches.current.has(batchId)) {
          console.error("probe_refresh outcome=start_failed")
          finish(batchId, "無法開始更新，請重新整理")
        }
        return []
      }
    })()
    // Neither listener setup nor a native command may hold the caller forever.
    return Promise.race([request, ended])
  }, [expire, finish])

  return { startBatch }
}
