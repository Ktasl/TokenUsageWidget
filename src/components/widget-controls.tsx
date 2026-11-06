import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

type Mode = { pinned: boolean; clickThrough: boolean }
export function WidgetControls() {
  const [mode, setMode] = useState<Mode>({ pinned: false, clickThrough: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let revision = 0
    let unlisten: (() => void) | undefined
    setBusy(true)
    void (async () => {
      try {
        const fn = await listen<Mode>("widget:mode-changed", ({ payload }) => { revision++; if (!disposed) setMode(payload) })
        if (disposed) { fn(); return }
        unlisten = fn
        const before = revision
        const initial = await invoke<Mode>("get_desktop_widget_state")
        if (!disposed && before === revision) setMode(initial)
      } catch { if (!disposed) setError("無法讀取浮窗狀態，請從選單列恢復互動後重試") }
      finally { if (!disposed) setBusy(false) }
    })()
    return () => { disposed = true; unlisten?.() }
  }, [])
  const change = async (next: Mode) => {
    if (!isTauri()) { setError("浮窗需在桌面 App 中使用"); return }
    setBusy(true)
    setError(null)
    try { setMode(await invoke<Mode>("configure_desktop_widget", next)) }
    catch { setError("無法切換浮窗，請從選單列恢復互動後重試") }
    finally { setBusy(false) }
  }
  return <div className="mt-3 text-xs">
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} aria-pressed={mode.pinned} className="rounded-lg border px-3 py-1.5" onClick={() => void change({ pinned: !mode.pinned, clickThrough: false })}>{mode.pinned ? "取消釘選" : "釘選為浮窗"}</button>
      {mode.pinned && <button type="button" disabled={busy} className="rounded-lg border px-3 py-1.5" onClick={() => void change({ pinned: true, clickThrough: !mode.clickThrough })}>{mode.clickThrough ? "恢復互動" : "滑鼠穿透"}</button>}
    </div>
    {mode.pinned && <p className="mt-1 text-muted-foreground">右鍵點選選單列可恢復互動或取消釘選；重新開啟 App 會還原。</p>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>
}
