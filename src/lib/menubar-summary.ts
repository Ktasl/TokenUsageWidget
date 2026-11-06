export type MenubarSummaryRow = {
  key: string
  label: string
  remainingPercent: number | null
  countdown: string | null
  status: "fresh" | "stale" | "missing" | "error" | "expired"
}
export type MenubarSummaryGroup = { id: string; name: string; rows: MenubarSummaryRow[] }
export type MenubarSummaryState = {
  style?: "compact" | "quota"
  enabled: boolean
  pluginIds: string[]
  geminiMetric: "pro" | "flash"
  groups: MenubarSummaryGroup[]
  error: string | null
}
