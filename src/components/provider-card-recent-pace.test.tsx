import { act, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderCard } from "./provider-card"

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render, children }: { render?: ((props: Record<string, unknown>) => ReactNode) | ReactNode; children: ReactNode }) =>
    typeof render === "function" ? render({ children }) : <div>{render || children}</div>,
}))
const start = Date.parse("2026-10-25T00:00:00Z")
const card = (used: number, observedAt: number, providerId = "codex", error?: string, sourceId?: string) => <ProviderCard name="Codex" providerId={providerId}
  tokenUsageReport={sourceId ? { status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", sourceId, days: [] } : undefined}
  displayMode="left" lastUpdatedAt={observedAt} error={error} lines={[{ type: "progress", label: "Weekly", used, limit: 100,
    format: { kind: "percent" }, periodDurationMs: 7 * 86_400_000, resetsAt: new Date(start + 86_400_000).toISOString() }]} />

describe("ProviderCard recent forecast integration", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start) })
  afterEach(() => { vi.useRealTimers() })
  it("keeps an explicitly average marker, predicts only after two increments, and stops on unchanged refreshed quota", () => {
    const { rerender } = render(card(60, start))
    expect(screen.getByText(/週期平均：/)).toBeInTheDocument()
    expect(screen.queryByText(/近期速度估計/)).not.toBeInTheDocument()
    // A successful source update need not coincide with the 30s display ticker.
    act(() => { vi.setSystemTime(start + 300_001); rerender(card(65, start + 300_001)) })
    expect(screen.getByText(/近期速度估計 .*後用盡/)).toBeInTheDocument()
    act(() => { vi.setSystemTime(start + 600_001); rerender(card(65, start + 600_001)) })
    expect(screen.queryByText(/近期速度估計/)).not.toBeInTheDocument()
    expect(screen.getByText("近期增量不足，暫不預測耗盡時間")).toBeInTheDocument()
  })
  it("does not carry rate between providers or across a failed update", () => {
    const { rerender } = render(card(60, start))
    act(() => { vi.setSystemTime(start + 300_000); rerender(card(65, start + 300_000)) })
    expect(screen.getByText(/近期速度估計/)).toBeInTheDocument()
    rerender(card(65, start + 300_000, "claude"))
    expect(screen.queryByText(/近期速度估計/)).not.toBeInTheDocument()
    rerender(card(65, start + 300_000, "claude", "timed out"))
    expect(screen.queryByText(/近期速度估計/)).not.toBeInTheDocument()
  })
  it("clears recent samples when the local source identity changes", () => {
    const { rerender } = render(card(60, start, "codex", undefined, "source_first_123"))
    act(() => { vi.setSystemTime(start + 300_000); rerender(card(65, start + 300_000, "codex", undefined, "source_first_123")) })
    expect(screen.getByText(/近期速度估計/)).toBeInTheDocument()
    rerender(card(65, start + 300_000, "codex", undefined, "source_second_123"))
    expect(screen.queryByText(/近期速度估計/)).not.toBeInTheDocument()
  })
})
