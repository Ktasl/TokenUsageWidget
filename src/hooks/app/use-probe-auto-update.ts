import { useCallback, useEffect, useState } from "react"
import {
  getEnabledPluginIds,
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"

type UseProbeAutoUpdateArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  isPluginLoading: (id: string) => boolean
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
  nativeBackgroundReady?: boolean
}

export function useProbeAutoUpdate({
  pluginSettings,
  autoUpdateInterval,
  setLoadingForPlugins,
  setErrorForPlugins,
  isPluginLoading,
  startBatch,
  nativeBackgroundReady = false,
}: UseProbeAutoUpdateArgs) {
  const [autoUpdateNextAt, setAutoUpdateNextAt] = useState<number | null>(null)
  const [autoUpdateResetToken, setAutoUpdateResetToken] = useState(0)

  useEffect(() => {
    if (!pluginSettings) {
      setAutoUpdateNextAt(null)
      return
    }

    const enabledIds = getEnabledPluginIds(pluginSettings)
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }

    const intervalMs = autoUpdateInterval * 60_000
    let nextAt = 0
    const scheduleNext = () => {
      nextAt = Date.now() + intervalMs
      setAutoUpdateNextAt(nextAt)
    }
    scheduleNext()

    const refreshIfDue = (forceVisible = false) => {
      if (Date.now() < nextAt) return
      // macOS 13 can suspend a hidden WebView. Native owns background queries.
      if (nativeBackgroundReady && !forceVisible && document.visibilityState === "hidden") return
      const idleIds = enabledIds.filter((id) => !isPluginLoading(id))
      if (idleIds.length === 0) {
        scheduleNext()
        return
      }

      setLoadingForPlugins(idleIds)
      startBatch(idleIds).catch((error) => {
        console.error("Failed to start auto-update batch:", error)
        setErrorForPlugins(idleIds, "Failed to start probe")
      })
      scheduleNext()
    }
    const interval = setInterval(() => refreshIfDue(), intervalMs)
    const nativeResume = () => refreshIfDue(true)
    const wake = () => { if (document.visibilityState !== "hidden") refreshIfDue() }
    window.addEventListener("focus", wake)
    window.addEventListener("usage:resume", nativeResume)
    document.addEventListener("visibilitychange", wake)
    return () => {
      clearInterval(interval)
      window.removeEventListener("focus", wake)
      window.removeEventListener("usage:resume", nativeResume)
      document.removeEventListener("visibilitychange", wake)
    }
  }, [
    autoUpdateInterval,
    autoUpdateResetToken,
    pluginSettings,
    isPluginLoading,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    nativeBackgroundReady,
  ])

  const resetAutoUpdateSchedule = useCallback(() => {
    if (!pluginSettings) return
    const enabledIds = getEnabledPluginIds(pluginSettings)
    /* v8 ignore start */
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }
    /* v8 ignore stop */

    setAutoUpdateNextAt(Date.now() + autoUpdateInterval * 60_000)
    setAutoUpdateResetToken((value) => value + 1)
  }, [autoUpdateInterval, pluginSettings])

  return {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  }
}
