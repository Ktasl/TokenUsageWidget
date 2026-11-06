import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

// Minimal credential + usage stubs so the probe reaches the ccusage path.
const CRED_JSON = JSON.stringify({ claudeAiOauth: { accessToken: "tok", subscriptionType: "pro" } })
const USAGE_RESPONSE = JSON.stringify({
  five_hour: { utilization: 30, resets_at: "2099-01-01T00:00:00.000Z" },
  seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00.000Z" },
})

function makeProbeCtx({ ccusageResult = { status: "runner_failed" } } = {}) {
  const ctx = makeCtx()
  ctx.host.fs.exists = () => true
  ctx.host.fs.readText = () => CRED_JSON
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: USAGE_RESPONSE })
  ctx.host.ccusage.query = vi.fn(() => ccusageResult)
  return ctx
}

const okUsage = (daily) => ({ status: "ok", data: { daily } })

function localDayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return year + "-" + month + "-" + day
}

describe("claude plugin ccusage usage trend", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it.each([
    [{ status: "runner_failed", reason: "timed_out" }, "Token 統計逾時，額度仍可使用"],
    [{ status: "runner_failed", reason: "probe_budget_exhausted" }, "本次先顯示額度，Token 統計稍後再試"],
    [{ status: "no_runner" }, "Token 統計工具尚未就緒"],
    [{ status: "runner_failed" }, "暫時無法取得 Token 統計"],
  ])("preserves live quota when optional Token statistics return %j", async (ccusageResult, text) => {
    const ctx = makeProbeCtx({ ccusageResult })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ type: "progress", label: "Session", used: 30, limit: 100 }))
    expect(result.lines).toContainEqual(expect.objectContaining({ type: "progress", label: "Weekly", used: 50, limit: 100 }))
    expect(result.lines).toContainEqual(expect.objectContaining({ type: "badge", label: "Token usage", text }))
    expect(result.lines.some((line) => line.label === "Error")).toBe(false)
    expect(result.lines.some((line) => line.label === "Today")).toBe(false)
  })

  it("keeps quota and logs no raw runner exception or credentials", async () => {
    const ctx = makeProbeCtx()
    ctx.host.ccusage.query.mockImplementation(() => { throw new Error("SECRET-token private@example.invalid /Users/private/log.json") })
    const result = (await loadPlugin()).probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Token usage").text).toBe("暫時無法取得 Token 統計")
    const errors = ctx.host.log.error.mock.calls.flat().join(" ")
    expect(errors).toMatch(/stage=tokens outcome=runner_failed elapsed_ms=\d+/)
    for (const secret of ["SECRET", "private@", "/Users/private"]) expect(errors).not.toContain(secret)
  })

  it("reports fixed probe stages in acquisition order", async () => {
    const ctx = makeProbeCtx()
    ctx.host.probe = { stage: vi.fn() }
    ;(await loadPlugin()).probe(ctx)
    expect(ctx.host.probe.stage.mock.calls.map(([name]) => name)).toEqual(["credentials", "quota", "tokens", "complete"])
  })

  it("does not claim quota is available when the source returned none", async () => {
    const ctx = makeProbeCtx({ ccusageResult: { status: "runner_failed", reason: "timed_out" } })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: "{}" })
    const result = (await loadPlugin()).probe(ctx)
    expect(result.lines.find((line) => line.label === "Token usage").text).toBe("Token 統計逾時，稍後再試")
    expect(result.lines.some((line) => line.type === "progress")).toBe(false)
  })

  it("stays at credentials when login is unavailable", async () => {
    const ctx = makeCtx()
    ctx.host.probe = { stage: vi.fn() }
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
    expect(ctx.host.probe.stage.mock.calls.map(([name]) => name)).toEqual(["credentials"])
  })

  it("adds model percentage text lines and a usage chart from claude ccusage", async () => {
    const todayKey = localDayKey(new Date())
    const yesterdayKey = localDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000))
    const ctx = makeProbeCtx({
      ccusageResult: okUsage([
        {
          date: todayKey,
          totalTokens: 300,
          totalCost: 1,
          modelBreakdowns: [
            { modelName: "claude-sonnet-4-20250514", totalTokens: 200 },
            { modelName: "claude-opus-4-1-20250805", totalTokens: 100 },
          ],
        },
        {
          date: yesterdayKey,
          totalTokens: 150,
          totalCost: 1,
          modelBreakdowns: [
            {
              modelName: "claude-opus-4-1-20250805",
              inputTokens: 30,
              cacheCreationTokens: 20,
              cacheReadTokens: 20,
              outputTokens: 30,
            },
          ],
        },
      ]),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const chart = result.lines.find((line) => line.label === "Usage Trend")
    expect(chart).toMatchObject({
      type: "barChart",
      note: "Estimated from local Claude logs at API rates.",
    })
    expect(chart.points.map((point) => point.value)).toEqual([150, 300])

    const sonnet = result.lines.find((line) => line.label === "claude-sonnet-4-20250514")
    const opus = result.lines.find((line) => line.label === "claude-opus-4-1-20250805")
    expect(sonnet).toMatchObject({
      type: "text",
      value: "50%",
    })
    expect(opus).toMatchObject({
      type: "text",
      value: "50%",
    })
  })
})
