import type { PluginDisplayState } from "@/lib/plugin-types"
import { calculatePaceStatus } from "@/lib/pace-status"

export function quotaGuidance(plugins: PluginDisplayState[], now = Date.now()): string | null {
  const fresh = plugins.filter((plugin) => !plugin.error && plugin.lastUpdatedAt != null && now >= plugin.lastUpdatedAt && now - plugin.lastUpdatedAt <= 10 * 60_000)
  const usable = fresh.filter((plugin) => plugin.data?.lines.some((line) => line.type === "progress" && line.format.kind === "percent" && Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > line.used && line.used >= 0 && line.resetsAt && Number.isFinite(Date.parse(line.resetsAt)) && Date.parse(line.resetsAt) > now))
  const pressured = fresh.filter((plugin) => plugin.data?.lines.some((line) => {
    if (line.type !== "progress" || line.format.kind !== "percent" || !Number.isFinite(line.used) || !Number.isFinite(line.limit) || line.used < 0 || line.limit <= 0 || !line.resetsAt || !Number.isFinite(Date.parse(line.resetsAt)) || Date.parse(line.resetsAt) <= now) return false
    if (line.used >= line.limit) return true
    return line.periodDurationMs && calculatePaceStatus(line.used, line.limit, Date.parse(line.resetsAt), line.periodDurationMs, now)?.status === "behind"
  }))
  if (!pressured.length) return null
  const alternatives = usable.filter((plugin) => !pressured.includes(plugin))
  return `${pressured.map((plugin) => plugin.meta.name).join("、")} 額度已用盡或消耗偏快。${alternatives.length ? `可查看 ${alternatives.map((plugin) => plugin.meta.name).join("、")} 的可用額度；服務能力與限制各自不同。` : "其他服務暫無可確認的替代額度。"}預估以週期平均速度計算，不會自動切換工作。`
}
