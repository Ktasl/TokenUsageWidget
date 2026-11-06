import { useCallback } from "react"
import { useProbeEvents } from "@/hooks/use-probe-events"
import {
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"
import { useProbeAutoUpdate } from "@/hooks/app/use-probe-auto-update"
import { useProbeRefreshActions } from "@/hooks/app/use-probe-refresh-actions"
import { useProbeState } from "@/hooks/app/use-probe-state"
import { useNativeBackground } from "@/hooks/app/use-native-background"

type UseProbeArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  onProbeResult?: () => void
}

export function useProbe({
  pluginSettings,
  autoUpdateInterval,
  onProbeResult,
}: UseProbeArgs) {
  const nativeBackground = useNativeBackground(pluginSettings, autoUpdateInterval)
  const {
    pluginStates,
    pluginStatesRef,
    manualRefreshIdsRef,
    setLoadingForPlugins,
    setErrorForPlugins,
    handleProbeResult,
  } = useProbeState({ onProbeResult })

  const handleBatchComplete = useCallback(() => {}, [])

  const { startBatch } = useProbeEvents({
    onResult: handleProbeResult,
    onBatchComplete: handleBatchComplete,
  })

  const isPluginLoading = useCallback(
    (id: string) => Boolean(pluginStatesRef.current[id]?.loading),
    [pluginStatesRef]
  )

  const {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  } = useProbeAutoUpdate({
    pluginSettings,
    autoUpdateInterval,
    setLoadingForPlugins,
    setErrorForPlugins,
    isPluginLoading,
    startBatch,
    nativeBackgroundReady: nativeBackground.ready,
  })

  const { handleRetryPlugin, handleRefreshAll } = useProbeRefreshActions({
    pluginSettings,
    pluginStatesRef,
    manualRefreshIdsRef,
    resetAutoUpdateSchedule,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  })

  return {
    pluginStates,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    handleRetryPlugin,
    handleRefreshAll,
    backgroundError: nativeBackground.error,
  }
}
