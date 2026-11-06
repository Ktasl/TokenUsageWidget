import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { MetricLine } from "@/lib/plugin-types"
import { SupplementaryUsagePanel } from "./supplementary-usage-panel"
import { ProviderCard } from "./provider-card"

const estimate: MetricLine = { type: "text", label: "Local estimated cost", value: "$1.25", subtitle: "2026-10-24 ～ 2026-10-25；有金額紀錄 1/2 天" }
const extra: MetricLine = { type: "progress", label: "Extra usage spent", used: 2.5, limit: 10, format: { kind: "dollars" } }

describe("SupplementaryUsagePanel source-aware information", () => {
  it("separates local estimated cost with period from provider actual Extra Usage", () => {
    render(<SupplementaryUsagePanel lines={[estimate, extra]} hasTokenReport />)
    expect(screen.getByText("US$ 1.25")).toBeInTheDocument()
    expect(screen.getByText(estimate.subtitle!)).toBeInTheDocument()
    expect(screen.getByText(/不是月費或實際帳單/)).toBeInTheDocument()
    expect(screen.getByText("本月已用 US$ 2.50／上限 US$ 10.00")).toBeInTheDocument()
    expect(screen.getByText(/不相加/)).toBeInTheDocument()
    expect(screen.getByText(/沿用同一份每日紀錄/)).toBeInTheDocument()
  })
  it("explicitly marks missing fields and does not turn token failure into zero USD", () => {
    render(<SupplementaryUsagePanel lines={[{ type: "badge", label: "Token usage", text: "Token 統計逾時" }]} />)
    expect(screen.getByText("來源未提供可信的費用紀錄")).toBeInTheDocument()
    expect(screen.getByText("來源未提供額外用量費用")).toBeInTheDocument()
    expect(screen.queryByText(/US\$ 0/)).not.toBeInTheDocument()
  })
  it("displays an actual explicit zero and marks stale data", () => {
    render(<SupplementaryUsagePanel stale lines={[{ ...estimate, value: "$0.00" }, { type: "text", label: "Extra usage spent", value: "$0" }]} />)
    expect(screen.getByText("US$ 0.00")).toBeInTheDocument()
    expect(screen.getByText("本月已用 US$ 0.00")).toBeInTheDocument()
    expect(screen.getByText(/上次成功資料/)).toBeInTheDocument()
  })
  it("ignores ambiguous historic cost strings and Codex credits instead of calling them actual expenses", () => {
    render(<SupplementaryUsagePanel lines={[{ type: "text", label: "Today", value: "$500 · 3M tokens" }, { type: "text", label: "Credits", value: "$20.00 · 500 credits" }]} />)
    expect(screen.queryByText(/US\$/)).not.toBeInTheDocument()
    expect(screen.getByText("來源未提供額外用量費用")).toBeInTheDocument()
  })
  it("rejects invalid cost or amounts instead of rendering NaN or Infinity", () => {
    render(<SupplementaryUsagePanel lines={[{ ...estimate, value: "$Infinity" }, { ...extra, used: Number.NaN }]} />)
    expect(screen.getByText("來源未提供可信的費用紀錄")).toBeInTheDocument()
    expect(screen.getByText("來源未提供額外用量費用")).toBeInTheDocument()
  })
  it("wires supplementary information into the dashboard while keeping a single Token trend", () => {
    render(<ProviderCard providerId="claude" name="Claude" dashboard displayMode="left" lines={[estimate, extra, { type: "progress", label: "Session", used: 20, limit: 100, format: { kind: "percent" } }]} tokenUsageReport={{ status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", days: [] }} />)
    expect(screen.getByText("US$ 1.25")).toBeInTheDocument()
    expect(screen.getByText("本月已用 US$ 2.50／上限 US$ 10.00")).toBeInTheDocument()
    expect(screen.getAllByRole("img", { name: "每日 Token 用量，缺資料以虛線表示" })).toHaveLength(1)
    expect(screen.queryByText("Local estimated cost")).not.toBeInTheDocument()
    expect(screen.queryByText("Extra usage spent")).not.toBeInTheDocument()
  })
})
