import { useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getEnabledPluginIds, type PluginSettings } from "@/lib/settings"
import type { MenubarSummaryState } from "@/lib/menubar-summary"

const configurationError = "無法啟用選單列額度或切換樣式，請重新選擇樣式後重試。"
function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("menubar configuration timed out")), milliseconds)
  })]).finally(() => clearTimeout(timer))
}

/** Native owns the tray until disable is acknowledged; configuration changes stay ordered. */
export function useNativeMenubarSummary(enabled: boolean, settings: PluginSettings | null, beforeConfigure: () => Promise<unknown>, style: "compact" | "quota" = "quota") {
  const [owned, setOwned] = useState(enabled)
  const [summary, setSummary] = useState<MenubarSummaryState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const everEnabled = useRef(false)
  const ids = settings ? getEnabledPluginIds(settings) : []
  const geminiMetric = settings?.menubarMetrics?.antigravity === "Gemini Flash" ? "flash" : "pro"
  const selections = settings?.menubarMetrics ?? {}
  const fingerprint = JSON.stringify([enabled, ids, geminiMetric, selections, style])
  const expected = useRef({ enabled, ids, geminiMetric, style })
  expected.current = { enabled, ids, geminiMetric, style }

  useEffect(() => {
    if (!enabled || !isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<MenubarSummaryState>("menubar:summary-updated", ({ payload }) => {
      const current = expected.current
      if (!disposed && (payload.style ?? "quota") === current.style && payload.enabled === current.enabled && payload.geminiMetric === current.geminiMetric &&
        JSON.stringify(payload.pluginIds) === JSON.stringify(current.ids)) { setSummary(payload); setError(payload.error) }
    }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(() => {
      if (!disposed && expected.current.enabled) setError(configurationError)
    })
    return () => { disposed = true; unlisten?.() }
  }, [enabled])

  useEffect(() => {
    if (!settings || !isTauri() || (!enabled && !everEnabled.current)) return
    if (enabled) { everEnabled.current = true; setOwned(true) }
    let cancelled = false
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (cancelled) return
      try {
        await bounded(beforeConfigure(), 2000)
        if (cancelled) return
        const value = await bounded(invoke<MenubarSummaryState>("configure_menubar_summary", {
          enabled, pluginIds: ids, geminiMetric, metricSelections: selections,
          ...(style === "compact" ? { style } : {}),
        }), 4000)
        if (cancelled) return
        setSummary(value)
        setOwned(enabled)
        setError(value.error)
      } catch {
        if (!cancelled) { console.error("menubar_summary outcome=configuration_failed"); setError(configurationError) }
      }
    })
    return () => { cancelled = true }
  // Values, not derived array identities, configure the native renderer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, Boolean(settings), beforeConfigure])
  return { owned, summary, error }
}
