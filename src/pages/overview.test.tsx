import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { OverviewPage } from "@/pages/overview"
import type { MetricLine } from "@/lib/plugin-types"

vi.mock("@/components/retirement-notice", () => ({ RetirementNotice: () => null }))

describe("OverviewPage", () => {
  it("renders empty state", () => {
    render(<OverviewPage plugins={[]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("尚未啟用服務")).toBeInTheDocument()
  })

  it("opens service selection from the empty state when provided", () => {
    const onOpenSettings = vi.fn()
    render(<OverviewPage plugins={[]} onOpenSettings={onOpenSettings} displayMode="used" resetTimerDisplayMode="relative" />)
    fireEvent.click(screen.getByRole("button", { name: "選擇服務" }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it("renders provider cards", () => {
    const plugins = [
      {
        meta: { id: "a", name: "Alpha", iconUrl: "icon", lines: [] },
        data: { providerId: "a", displayName: "Alpha", lines: [], iconUrl: "icon" },
        loading: false,
        error: null,
        lastManualRefreshAt: null,
        lastUpdatedAt: null,
      },
    ]
    render(<OverviewPage plugins={plugins} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("only shows overview-scoped lines", () => {
    const plugins = [
      {
        meta: {
          id: "test",
          name: "Test",
          iconUrl: "icon",
          lines: [
            { type: "text" as const, label: "Primary", scope: "overview" as const },
            { type: "text" as const, label: "Secondary", scope: "detail" as const },
          ],
        },
        data: {
          providerId: "test",
          displayName: "Test",
          lines: [
            { type: "text" as const, label: "Primary", value: "Shown" },
            { type: "text" as const, label: "Secondary", value: "Hidden" },
          ],
          iconUrl: "icon",
        },
        loading: false,
        error: null,
        lastManualRefreshAt: null,
        lastUpdatedAt: null,
      },
    ]
    render(<OverviewPage plugins={plugins} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("Primary")).toBeInTheDocument()
    expect(screen.getByText("Shown")).toBeInTheDocument()
    expect(screen.queryByText("Secondary")).not.toBeInTheDocument()
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument()
  })

  it("does not show provider quick links in combined view", () => {
    const plugins = [
      {
        meta: {
          id: "alpha",
          name: "Alpha",
          iconUrl: "icon",
          lines: [],
          links: [{ label: "Status", url: "https://status.example.com" }],
        },
        data: { providerId: "alpha", displayName: "Alpha", lines: [], iconUrl: "icon" },
        loading: false,
        error: null,
        lastManualRefreshAt: null,
        lastUpdatedAt: null,
      },
    ]

    render(<OverviewPage plugins={plugins} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.queryByRole("button", { name: /status/i })).toBeNull()
  })
})

it("shows all three services, runtime model quota and detail Token counts without combining periods or showing money", () => {
  const progress = (label: string, used: number, limit = 100) => ({ type: "progress" as const, label, used, limit, format: { kind: "percent" as const }, resetsAt: new Date(Date.now() + 3_600_000).toISOString() })
  const makePlugin = (id: string, name: string, lines: MetricLine[]) => ({
    meta: { id, name, iconUrl: `${id}.svg`, brandColor: "#74AA9C", primaryCandidates: ["Session"], lines: [
      { type: "progress" as const, label: "Session", scope: "overview" as const },
      { type: "text" as const, label: "Today", scope: "detail" as const },
      { type: "text" as const, label: "Last 30 Days", scope: "detail" as const },
    ] },
    data: { providerId: id, displayName: name, iconUrl: `${id}.svg`, lines },
    loading: false, error: null, lastManualRefreshAt: null, lastUpdatedAt: null,
  })
  render(<OverviewPage plugins={[
    makePlugin("codex", "Codex", [progress("Session", 40), { type: "text", label: "Today", value: "$3.50 · 12,345 tokens" }, { type: "text", label: "Last 30 Days", value: "$40.50 · 1.2M tokens" }]),
    makePlugin("antigravity", "Antigravity", [progress("Flash", 0), progress("Claude", 100), { type: "progress", label: "Credits", used: 10, limit: 100, format: { kind: "count", suffix: "credits" } }]),
    makePlugin("claude", "Claude", [progress("Weekly", 70), { type: "text", label: "TodayTokens", value: "0" }, { type: "progress", label: "Monthly Cost", used: 5, limit: 20, format: { kind: "dollars" } }]),
  ]} displayMode="left" resetTimerDisplayMode="relative" />)
  expect(screen.getByRole("heading", { name: "Token 與額度總覽" })).toBeInTheDocument()
  for (const name of ["Codex", "Antigravity", "Claude"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument()
  expect(screen.getByRole("progressbar", { name: "Flash" })).toHaveAttribute("aria-valuenow", "100")
  expect(screen.getByRole("progressbar", { name: "Claude" })).toHaveAttribute("aria-valuenow", "0")
  expect(screen.getByText("12,345 Token")).toBeInTheDocument()
  expect(screen.getByText("1.2M Token")).toBeInTheDocument()
  expect(screen.getByText("0 Token")).toBeInTheDocument()
  expect(screen.getByText("今日")).toBeInTheDocument()
  expect(screen.getByText("最近 30 天")).toBeInTheDocument()
  expect(screen.getAllByText("未提供 Token 用量")).toHaveLength(1)
  expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  expect(screen.getByText("已啟用服務").nextElementSibling).toHaveTextContent("3")
  expect(screen.getByText("有額度已用盡").nextElementSibling).toHaveTextContent("1")
  expect(screen.getByLabelText("所有已啟用服務的額度")).toHaveClass("grid-cols-1", "min-[720px]:grid-cols-2")
})
