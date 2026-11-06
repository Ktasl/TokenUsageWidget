import { countUnit } from "@/lib/locale"
import type { PaceResult, PaceStatus } from "@/lib/pace-status"
import type { ProgressFormat } from "@/lib/plugin-types"
import type { DisplayMode } from "@/lib/settings"
import { formatCountNumber, formatFixedPrecisionNumber } from "@/lib/utils"

export function getPaceStatusText(status: PaceStatus): string {
  return status === "ahead" ? "額度充裕" : status === "on-track" ? "用量符合預期" : "可能提前用盡"
}

export function formatCompactDuration(deltaMs: number): string | null {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null
  const totalSeconds = Math.floor(deltaMs / 1000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const minutes = totalMinutes % 60

  if (days > 0) return `${days} 天 ${hours} 小時`
  if (totalHours > 0) return `${totalHours} 小時 ${minutes} 分`
  if (totalMinutes > 0) return `${totalMinutes} 分`
  return "不到 1 分鐘"
}

function getRunsOutDurationText({
  paceResult,
  used,
  limit,
  periodDurationMs,
  resetsAtMs,
  nowMs,
}: {
  paceResult: PaceResult | null
  used: number
  limit: number
  periodDurationMs: number
  resetsAtMs: number
  nowMs: number
}): string | null {
  if (!paceResult || paceResult.status !== "behind") return null
  const rate = paceResult.projectedUsage / periodDurationMs
  if (rate <= 0) return null
  const etaMs = (limit - used) / rate
  const remainingMs = resetsAtMs - nowMs
  if (etaMs <= 0 || etaMs >= remainingMs) return null
  return formatCompactDuration(etaMs)
}

/**
 * ETA text for when usage will hit the limit, e.g. "Runs out in 4d 5h".
 * Returns null if not behind pace or ETA can't be computed.
 */
export function formatRunsOutText({
  paceResult,
  used,
  limit,
  periodDurationMs,
  resetsAtMs,
  nowMs,
}: {
  paceResult: PaceResult | null
  used: number
  limit: number
  periodDurationMs: number
  resetsAtMs: number
  nowMs: number
}): string | null {
  const durationText = getRunsOutDurationText({ paceResult, used, limit, periodDurationMs, resetsAtMs, nowMs })
  return durationText ? `預計 ${durationText}後用盡` : null
}

export function buildPaceDetailText({
  paceResult,
  used,
  limit,
  periodDurationMs,
  resetsAtMs,
  nowMs,
  displayMode,
}: {
  paceResult: PaceResult | null
  used: number
  limit: number
  periodDurationMs: number
  resetsAtMs: number
  nowMs: number
  displayMode: DisplayMode
}): string | null {
  if (!paceResult || !Number.isFinite(limit) || limit <= 0 || paceResult.projectedUsage === 0) return null

  if (paceResult.status === "behind") {
    const durationText = getRunsOutDurationText({ paceResult, used, limit, periodDurationMs, resetsAtMs, nowMs })
    if (durationText) return `預計 ${durationText}後達上限`
  }

  // Show projected % at reset (clamped to 100%)
  const projectedPercent = Math.min(100, Math.round((paceResult.projectedUsage / limit) * 100))
  const shownPercent = displayMode === "left" ? 100 - projectedPercent : projectedPercent
  const suffix = displayMode === "left" ? "重設時剩餘" : "重設時已用"
  return `預計${suffix} ${shownPercent}%`
}

export function formatDeficitText(
  deficit: number,
  format: ProgressFormat,
  displayMode: DisplayMode
): string | null {
  if (!Number.isFinite(deficit) || deficit <= 0) return null

  const suffix = displayMode === "left" ? "不足" : "超出預期"
  if (format.kind === "percent") {
    const roundedPercent = Math.round(deficit)
    return roundedPercent > 0 ? `${suffix} ${roundedPercent}%` : null
  }

  const roundedToCents = Math.round(deficit * 100) / 100
  if (roundedToCents <= 0) return null

  if (format.kind === "dollars") return `${suffix} $${formatFixedPrecisionNumber(roundedToCents)}`
  return `${suffix} ${formatCountNumber(roundedToCents)} ${countUnit(format.suffix)}`
}
