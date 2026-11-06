import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "./test-helpers.js"

function context(provider, daily, { result, extra } = {}) {
  const ctx = makeCtx()
  if (provider === "claude") {
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "fixture", subscriptionType: "pro" } })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ five_hour: { utilization: 25 }, extra_usage: extra }) })
  } else {
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({ tokens: { access_token: "fixture" }, last_refresh: new Date().toISOString() }))
    ctx.host.http.request.mockReturnValue({ status: 200, headers: { "x-codex-primary-used-percent": "10" }, bodyText: "{}" })
  }
  ctx.host.ccusage.query.mockReturnValue(result ?? { status: "ok", timezone: "Asia/Taipei", sourceVersion: "20.0.2", data: { daily } })
  return ctx
}
for (const provider of ["claude", "codex"]) describe(provider + " supplementary cost", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  async function probe(daily, options) {
    await import(`./${provider}/plugin.js`)
    return globalThis.__openusage_plugin.probe(context(provider, daily, options))
  }
  const day = { date: "2026-10-24", totalTokens: 10, totalCost: 1.25 }
  it("deduplicates matching days and labels source date range and partial coverage", async () => {
    const output = await probe([day, day, { date: "2026-10-25", totalTokens: 20 }])
    expect(output.lines.find(line => line.label === "Local estimated cost")).toMatchObject({ type: "text", value: "$1.25", subtitle: "2026-10-24 ～ 2026-10-25；有金額紀錄 1/2 天" })
  })
  it.each([
    ["2026-10-24T15:59:59.999Z", "$1.25", "2026-10-24 ～ 2026-10-24；有金額紀錄 1/1 天"],
    ["2026-10-24T16:00:00.000Z", "$3.75", "2026-10-24 ～ 2026-10-25；有金額紀錄 2/2 天"],
  ])("uses Taipei midnight boundary and excludes future cost at %s", async (clock, value, subtitle) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(clock))
    try {
      const output = await probe([day, { date: "2026-10-25", totalTokens: 20, totalCost: 2.5 }, { date: "2026-10-26", totalTokens: 30, totalCost: 4 }])
      expect(output.lines.find(line => line.label === "Local estimated cost")).toMatchObject({ value, subtitle })
    } finally { vi.useRealTimers() }
  })
  it("preserves source explicit cost zero, rather than filling missing cost with zero", async () => {
    expect((await probe([{ ...day, totalCost: 0 }])).lines.find(line => line.label === "Local estimated cost").value).toBe("$0.00")
    delete globalThis.__openusage_plugin; vi.resetModules()
    expect((await probe([{ date: day.date, totalTokens: 0 }])).lines.find(line => line.label === "Local estimated cost")).toBeUndefined()
  })
  it.each([
    [day, { ...day, totalCost: 2 }],
    [{ ...day, totalCost: "1.25" }],
    [{ ...day, totalCost: -1 }],
    [{ ...day, totalCost: Number.NaN }],
    [{ ...day, totalCost: Number.POSITIVE_INFINITY }],
    [{ ...day, totalCost: 1.25, costUSD: 99 }],
    [{ ...day, totalCost: Number.MAX_SAFE_INTEGER }],
  ])("does not publish untrusted or conflicting cost %j", async (...daily) => {
    expect((await probe(daily)).lines.find(line => line.label === "Local estimated cost")).toBeUndefined()
  })
  it.each(["runner_failed", "no_runner"])("does not manufacture a price on %s", async (status) => {
    const output = await probe([], { result: { status } })
    expect(output.lines.find(line => line.label === "Local estimated cost")).toBeUndefined()
    expect(output.lines.some(line => line.type === "progress")).toBe(true)
  })
})

describe("Claude actual Extra Usage remains independent from optional estimates", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  it.each([0, 250])("keeps provider-reported used credits %s when local Token query fails", async (used) => {
    await import("./claude/plugin.js")
    const output = globalThis.__openusage_plugin.probe(context("claude", [], { result: { status: "runner_failed" }, extra: { is_enabled: true, used_credits: used, monthly_limit: 1000 } }))
    expect(output.lines.find(line => line.label === "Extra usage spent")).toMatchObject({ type: "progress", used: used / 100, limit: 10, format: { kind: "dollars" } })
    expect(output.lines.find(line => line.label === "Local estimated cost")).toBeUndefined()
  })
  it.each([undefined, { is_enabled: false, used_credits: 250 }, { is_enabled: true }])("does not invent Extra Usage when source omitted it %j", async (extra) => {
    await import("./claude/plugin.js")
    const output = globalThis.__openusage_plugin.probe(context("claude", [], { extra }))
    expect(output.lines.find(line => line.label === "Extra usage spent")).toBeUndefined()
  })
})
