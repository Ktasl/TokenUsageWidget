import { useMemo } from "react"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import type { PluginState } from "@/hooks/app/types"

export type SettingsPluginState = {
  id: string
  name: string
  enabled: boolean
  metricOptions?: { value: string; label: string }[]
  selectedMetric?: string
}

type UseSettingsPluginListArgs = {
  pluginSettings: PluginSettings | null
  pluginsMeta: PluginMeta[]
  pluginStates?: Record<string, PluginState>
}

export function useSettingsPluginList({ pluginSettings, pluginsMeta, pluginStates }: UseSettingsPluginListArgs) {
  return useMemo<SettingsPluginState[]>(() => {
    if (!pluginSettings) return []
    const pluginMap = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))

    return pluginSettings.order
      .map((id): SettingsPluginState | null => {
        const meta = pluginMap.get(id)
        if (!meta) return null
        const metricLabels = [...new Set([
          ...meta.lines.filter((line) => line.type === "progress" && line.scope === "overview").map((line) => line.label),
          ...(pluginStates?.[id]?.data?.lines ?? []).filter((line) => line.type === "progress").map((line) => line.label),
        ])]
        return {
          id,
          name: meta.name,
          enabled: !pluginSettings.disabled.includes(id),
          metricOptions: metricLabels.map((label) => ({ value: label, label })),
          selectedMetric: pluginSettings.menubarMetrics?.[id] ?? "",
        }
      })
      .filter((plugin): plugin is SettingsPluginState => Boolean(plugin))
  }, [pluginSettings, pluginsMeta, pluginStates])
}
