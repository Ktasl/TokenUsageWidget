import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { UsageExports } from "./usage-exports"

const now = Date.parse("2026-10-25T00:00:00Z")
const plugin: PluginDisplayState = {
  meta: { id: "codex", name: "Codex", iconUrl: "", lines: [], primaryCandidates: [] },
  data: { providerId: "codex", displayName: "Codex", iconUrl: "", lines: [], tokenUsageReport: {
    status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", sourceId: "source_12345678",
    reason: "/Users/private/never-export", days: [{ date: "2026-10-25", totalTokens: 42 }],
  } }, loading: false, error: null, lastUpdatedAt: now, lastManualRefreshAt: null,
}
const storage = () => ({ getItem: vi.fn(() => null), setItem: vi.fn() })

describe("UsageExports", () => {
  it("shows local coverage and exports safe readonly JSON and CSV through the supplied save boundary", async () => {
    const saveFile = vi.fn().mockResolvedValue(undefined)
    render(<UsageExports plugins={[plugin]} now={now} storage={storage()} saveFile={saveFile} />)
    expect(screen.getByText("本機歷史與匯出")).toBeInTheDocument()
    expect(screen.getByText(/無法當作登入帳號的完整帳單/)).toBeInTheDocument()
    expect(screen.getByText(/42 Token/)).toBeInTheDocument()
    expect(screen.getByText(/不計算增減百分比/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "匯出唯讀 JSON" }))
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    const [name, contents, mime] = saveFile.mock.calls[0]
    expect(name).toMatch(/^TokenUsageWidget-2026-10-25-\d+\.json$/)
    expect(mime).toBe("application/json")
    expect(JSON.parse(contents).history.scopes[0].days[0].totalTokens).toBe(42)
    expect(contents).not.toMatch(/private|never-export|reason/)
    await waitFor(() => expect(screen.getByRole("button", { name: "匯出每日 CSV" })).toBeEnabled())
    expect(screen.getByRole("status")).toHaveTextContent(name)
    fireEvent.click(screen.getByRole("button", { name: "匯出每日 CSV" }))
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2))
    expect(saveFile.mock.calls[1][0]).toMatch(/\.csv$/)
    expect(saveFile.mock.calls[1][1]).toContain('"42"')
  })

  it("explains unidentifiable sources and displays save/export errors", async () => {
    const unknown: PluginDisplayState = { ...plugin, data: { ...plugin.data!, tokenUsageReport: { ...plugin.data!.tokenUsageReport!, sourceId: undefined } } }
    const saveFile = vi.fn().mockRejectedValue(new Error("permission"))
    render(<UsageExports plugins={[unknown]} now={now} storage={storage()} saveFile={saveFile} />)
    expect(screen.getByText(/缺少可靠的來源識別/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "匯出唯讀 JSON" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("無法匯出用量")
  })

  it("keeps local storage errors visible", () => {
    const full = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error("full") }) }
    render(<UsageExports plugins={[plugin]} now={now} storage={full} saveFile={vi.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("無法儲存本機歷史")
  })
})
