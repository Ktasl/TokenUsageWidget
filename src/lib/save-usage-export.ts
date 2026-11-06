import { invoke, isTauri } from "@tauri-apps/api/core"

export async function saveUsageExport(filename: string, contents: string, mime: string) {
  if (!isTauri()) throw new Error("請在桌面 App 匯出，以確認檔案已保存。")
  await invoke("save_usage_export", { filename, contents, mime })
}
