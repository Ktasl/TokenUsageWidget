import { useEffect, useRef, useState } from "react"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { taipeiDay } from "@/lib/token-report"
import { captureUsageHistory, currentUsageHistory, emptyUsageHistory, loadUsageHistory, saveUsageHistory,
  type HistoryStorage, type UsageHistory } from "@/lib/usage-history"

type Options = { storage?: HistoryStorage; now?: number }
export function useUsageHistory(plugins: PluginDisplayState[], options: Options = {}) {
  const today = taipeiDay(options.now)
  const [initial] = useState(() => {
    try {
      const storage = options.storage ?? window.localStorage
      return { history: loadUsageHistory(storage), storage, error: null as string | null }
    } catch (error) {
      return { history: emptyUsageHistory(), storage: null, error: error instanceof Error ? error.message : "無法讀取本機歷史。" }
    }
  })
  const historyRef = useRef(initial.history)
  const [history, setHistory] = useState<UsageHistory>(initial.history)
  const [error, setError] = useState(initial.error)
  const reports = plugins.map((plugin) => ({ providerId: plugin.meta.id, report: plugin.data?.tokenUsageReport }))
  // This fingerprint prevents state rerenders or repeated identical source snapshots from writing again.
  const fingerprint = JSON.stringify(reports)
  useEffect(() => {
    if (!initial.storage) return
    const next = captureUsageHistory(historyRef.current, reports, today)
    if (JSON.stringify(next) === JSON.stringify(historyRef.current)) return
    try {
      saveUsageHistory(initial.storage, next)
      historyRef.current = next
      setHistory(next)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "無法儲存本機歷史。")
    }
  // Reports are fingerprinted rather than depending on a freshly derived array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, today, initial])
  return { history: currentUsageHistory(history, reports), error, today, reports }
}
