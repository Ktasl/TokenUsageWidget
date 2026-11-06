import { describe, expect, it } from "vitest"
import { tokenUsageText } from "@/lib/token-usage"
import { metricLabel, formatRelativeTime } from "@/lib/locale"

describe("explicit Token usage", () => {
  it("recognizes actual composite provider text and preserves its reported period and count", () => {
    expect(tokenUsageText({ type: "text", label: "Today", value: "$3.50 · 12,345 tokens" })).toBe("12,345 Token")
    expect(tokenUsageText({ type: "text", label: "Last 30 Days", value: "$45 · 1.2M tokens" })).toBe("1.2M Token")
    expect(tokenUsageText({ type: "text", label: "TodayTokens", value: "0" })).toBe("0 Token")
    expect(tokenUsageText({ type: "progress", label: "Monthly", used: 1200, limit: 10000, format: { kind: "count", suffix: "tokens" } })).toBe("1,200 Token")
  })
  it("does not manufacture Token counts from quota, requests, credits, currency, or invalid values", () => {
    for (const suffix of ["credits", "requests"]) {
      expect(tokenUsageText({ type: "progress", label: "Tokens", used: 50, limit: 100, format: { kind: "count", suffix } })).toBeNull()
    }
    expect(tokenUsageText({ type: "progress", label: "Tokens", used: 50, limit: 100, format: { kind: "percent" } })).toBeNull()
    expect(tokenUsageText({ type: "text", label: "Today", value: "$3.50" })).toBeNull()
    expect(tokenUsageText({ type: "text", label: "TodayTokens", value: "not provided" })).toBeNull()
    expect(tokenUsageText({ type: "text", label: "Today", value: "-12 tokens" })).toBeNull()
    expect(tokenUsageText({ type: "text", label: "Today", value: "1,23 tokens" })).toBeNull()
    expect(tokenUsageText({ type: "text", label: "Today", value: `${"9".repeat(400)} tokens` })).toBeNull()
  })
  it("translates display labels without translating model names", () => {
    expect(metricLabel("Session")).toBe("本次工作階段")
    expect(metricLabel("Weekly")).toBe("每週額度")
    expect(metricLabel("ExtraUsage")).toBe("額外使用量")
    expect(metricLabel("Flash")).toBe("Flash")
    expect(metricLabel("Claude Sonnet 4.6")).toBe("Claude Sonnet 4.6")
    expect(formatRelativeTime(5000)).toBe("剛剛")
    expect(formatRelativeTime(120000)).toBe("2 分鐘前")
  })
})
