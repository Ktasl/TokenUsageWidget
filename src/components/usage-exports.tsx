import { useState } from "react"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { useUsageHistory } from "@/hooks/app/use-usage-history"
import { monthlyUsage, reportScope, usageHistoryCsv, usageStatusJson, type HistoryStorage } from "@/lib/usage-history"

export type SaveUsageFile = (filename: string, contents: string, mime: string) => Promise<void>
export async function downloadUsageFile(filename: string, contents: string, mime: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
}

export function UsageExports({ plugins, saveFile = downloadUsageFile, storage, now }: {
  plugins: PluginDisplayState[]
  saveFile?: SaveUsageFile
  storage?: HistoryStorage
  now?: number
}) {
  const { history, error, today, reports } = useUsageHistory(plugins, { storage, now })
  const [exportError, setExportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const exportData = async (format: "json" | "csv") => {
    setBusy(true)
    setExportError(null)
    setSaved(null)
    try {
      const contents = format === "json" ? usageStatusJson(history, reports, today) : usageHistoryCsv(history)
      const filename = `TokenUsageWidget-${today}-${Date.now()}.${format}`
      await saveFile(filename, contents, format === "json" ? "application/json" : "text/csv;charset=utf-8")
      setSaved(filename)
    } catch { setExportError("無法匯出用量，請檢查儲存位置或重試。") }
    finally { setBusy(false) }
  }
  const count = (value: number | null) => value === null ? "未知" : `${value.toLocaleString("zh-TW")} Token`
  return <section className="rounded-xl border border-border p-4 space-y-3" aria-label="本機歷史與匯出">
    <h2 className="font-semibold">本機歷史與匯出</h2>
    <p className="text-xs text-muted-foreground">每日快照保留 180 日；以台灣時間統計，只涵蓋此本機來源，無法當作登入帳號的完整帳單。缺少的日期代表未知。</p>
    {plugins.map((plugin) => {
      const snapshot = reports.find((item) => item.providerId === plugin.meta.id)!
      const key = reportScope(snapshot)
      const scope = history.scopes.find((item) => `${item.providerId}:${item.sourceId}:${item.timezone}` === key)
      const months = monthlyUsage(scope, today)
      return <div key={plugin.meta.id} className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
        <h3 className="font-medium">{plugin.meta.name} 歷史</h3>
        {!key && <p className="text-xs text-muted-foreground">缺少可靠的來源識別，歷史未保存；不會混入其他來源。</p>}
        {key && !scope && <p className="text-xs text-muted-foreground">尚無可保存的 Token 紀錄。</p>}
        <p>本月截至 {today}：{count(months.current.totalTokens)} <span className="text-muted-foreground">（已知 {months.current.knownDays}/{months.current.expectedDays} 日）</span></p>
        <p>上月：{count(months.previous.totalTokens)} <span className="text-muted-foreground">（已知 {months.previous.knownDays}/{months.previous.expectedDays} 日）</span></p>
        {(!months.current.complete || !months.previous.complete) && <p className="text-xs text-muted-foreground">涵蓋日期不完整，不計算增減百分比。</p>}
      </div>
    })}
    {(error || exportError) && <p role="alert" className="text-sm text-destructive">{error || exportError}</p>}
    {saved && <p role="status" className="text-xs text-muted-foreground">已匯出 {saved}；桌面版儲存於下載項目／TokenUsageWidget。</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void exportData("csv")} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">匯出每日 CSV</button>
      <button type="button" disabled={busy} onClick={() => void exportData("json")} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">匯出唯讀 JSON</button>
    </div>
    <p className="text-xs text-muted-foreground">來源變更後分開保存，不合併不同來源的統計；JSON 不提供網路服務。</p>
  </section>
}
