import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import { DEFAULT_DISPLAY_MODE, type DisplayMode } from "@/lib/settings"
import { clamp01 } from "@/lib/utils"

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

export type TrayPrimaryBar = {
  id: string
  fraction?: number
  /** Label of the metric line that produced this bar (when data is available). */
  label?: string
  /** True when the value came from the provider's declared weekly line. */
  weekly?: boolean
}

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress"; label: string; used: number; limit: number }
>

function isProgressLine(line: PluginOutput["lines"][number]): line is ProgressLine {
  return line.type === "progress"
}

function hasValidQuota(line: ProgressLine | undefined): line is ProgressLine {
  return line !== undefined && Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0
}

export function getTrayPrimaryBars(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  maxBars?: number
  displayMode?: DisplayMode
  pluginId?: string
  preferWeekly?: boolean
}): TrayPrimaryBar[] {
  const {
    pluginsMeta,
    pluginSettings,
    pluginStates,
    maxBars = 4,
    displayMode = DEFAULT_DISPLAY_MODE,
    pluginId,
    preferWeekly = false,
  } = args
  if (!pluginSettings) return []

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  const disabled = new Set(pluginSettings.disabled)
  const orderedIds = pluginId
    ? [pluginId]
    : pluginSettings.order

  const out: TrayPrimaryBar[] = []
  for (const id of orderedIds) {
    if (disabled.has(id)) continue
    const meta = metaById.get(id)
    if (!meta) continue
    
    const candidateLabels = [
      ...(pluginSettings.menubarMetrics?.[id] ? [pluginSettings.menubarMetrics[id]] : []),
      ...(preferWeekly && meta.weeklyCandidate ? [meta.weeklyCandidate] : []),
      ...(meta.primaryCandidates ?? []),
      ...meta.lines.filter((line) => line.type === "progress" && line.scope === "overview").map((line) => line.label),
    ]
    if (candidateLabels.length === 0) continue

    const state = pluginStates[id]
    const data = state?.data ?? null

    let fraction: number | undefined
    let label: string | undefined
    let weekly: true | undefined
    if (data) {
      const candidates = candidateLabels.map((candidate) =>
        data.lines.find(
          (line): line is ProgressLine => isProgressLine(line) && line.label === candidate
        )
      )
      // A declared metric can be absent or invalid for the current account.
      // Try the remaining primary metrics, then declared overview quota lines.
      const metricLine = candidates.find(hasValidQuota)
      const selectedLine = metricLine ?? candidates.find((line) => line !== undefined)
      label = selectedLine?.label
      weekly = (preferWeekly && label !== undefined && label === meta.weeklyCandidate) || undefined
      if (metricLine) {
        const shownAmount = displayMode === "used" ? metricLine.used : metricLine.limit - metricLine.used
        fraction = clamp01(shownAmount / metricLine.limit)
      }
    }

    out.push({ id, fraction, label, weekly })
    if (out.length >= maxBars) break
  }

  return out
}
