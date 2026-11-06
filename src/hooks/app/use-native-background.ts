import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getEnabledPluginIds, type AutoUpdateIntervalMinutes, type PluginSettings } from "@/lib/settings"

export function useNativeBackground(settings: PluginSettings | null, interval: AutoUpdateIntervalMinutes) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = settings ? getEnabledPluginIds(settings) : []
  const fingerprint = JSON.stringify(ids)
  useEffect(() => {
    if (!settings || !isTauri()) return
    let cancelled = false
    setReady(false)
    void invoke("configure_background_refresh", { pluginIds: ids, intervalMinutes: interval }).then(() => {
      if (!cancelled) { setReady(true); setError(null) }
    }).catch(() => { if (!cancelled) { setReady(false); setError("背景更新尚未啟動，面板開啟時仍會更新；請重新開啟應用程式後重試。") } })
    return () => { cancelled = true }
  // Only configuration values, not derived array identity, may reconfigure native scheduling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, interval, Boolean(settings)])
  return { ready, error }
}
