import type { MetricLine } from "@/lib/plugin-types"
import { formatCountNumber } from "@/lib/utils"

/** Recognize only explicit Token counts; quota percentages and credits are not Token usage. */
export function tokenUsageText(line: MetricLine): string | null {
  if (line.type === "progress") {
    return line.format.kind === "count" && /^tokens?$/i.test(line.format.suffix.trim()) && Number.isFinite(line.used) && line.used >= 0
      ? `${formatCountNumber(line.used)} Token`
      : null
  }
  if (line.type !== "text") return null
  const explicitCount = line.value.match(/(?:^|[^\w.,+-])(\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[kmbt])?)\s*tokens?\b/i)
  if (explicitCount) {
    const reported = explicitCount[1].trim()
    if (/[kmbt]$/i.test(reported)) return `${reported} Token`
    const value = Number(reported.replace(/,/g, ""))
    return Number.isFinite(value) ? `${formatCountNumber(value)} Token` : null
  }
  if (/tokens?$/i.test(line.label.trim()) && /^\d[\d,]*(?:\.\d+)?$/.test(line.value.trim())) {
    const value = Number(line.value.replace(/,/g, ""))
    return Number.isFinite(value) ? `${formatCountNumber(value)} Token` : null
  }
  return null
}

export function isMoneyLine(line: MetricLine): boolean {
  return (line.type === "progress" && line.format.kind === "dollars") ||
    /\b(?:cost|spend(?:ing)?|price|fee)s?\b|費用|月費|支出/i.test(line.label) ||
    (line.type === "text" && /[$€£]|\b(?:USD|TWD)\b/.test(line.value))
}
