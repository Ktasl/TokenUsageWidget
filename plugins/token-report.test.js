import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "./test-helpers.js"

function probeContext(provider, result) {
  const ctx = makeCtx()
  if (provider === "claude") {
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "fixture", subscriptionType: "pro" } })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ five_hour: { utilization: 30 }, seven_day: { utilization: 50 } }) })
  } else {
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({ tokens: { access_token: "fixture" }, last_refresh: new Date().toISOString() }))
    ctx.host.http.request.mockReturnValue({ status: 200, headers: { "x-codex-primary-used-percent": "10" }, bodyText: "{}" })
  }
  ctx.host.ccusage.query.mockImplementation(() => {
    if (result instanceof Error) throw result
    return result
  })
  return ctx
}
const ok = (daily, extra = {}) => ({ status: "ok", timezone: "Asia/Taipei", data: { daily }, ...extra })

for (const provider of ["claude", "codex"]) describe(provider + " structured Token report", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })
  async function run(result) {
    const ctx = probeContext(provider, result)
    await import(`./${provider}/plugin.js`)
    return { ctx, result: globalThis.__openusage_plugin.probe(ctx) }
  }

  it("requests Taipei grouping and reports only local-directory scope and whitelisted fields", async () => {
    const raw = { date: "2026-10-24", totalTokens: 123, inputTokens: 90, outputTokens: 33, totalCost: 1, path: "/private/log", secret: "SECRET", prompt: "private text", models: { "gpt-5": { totalTokens: 123, secret: "SECRET" } } }
    const { ctx, result } = await run(ok([raw], { sourceId: "sha256:abc", sourceVersion: "20.0.2" }))
    expect(ctx.host.ccusage.query).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Asia/Taipei" }))
    expect(result.tokenUsageReport).toEqual({ status: "ok", timezone: "Asia/Taipei", source: "local-logs", accountScope: "local-directory", sourceId: "sha256:abc", sourceVersion: "20.0.2", days: [{ date: "2026-10-24", totalTokens: 123, inputTokens: 90, outputTokens: 33, models: [{ name: "gpt-5", totalTokens: 123 }] }] })
    expect(JSON.stringify(result.tokenUsageReport)).not.toMatch(/SECRET|private|Cost|prompt/)
  })

  it("does not convert unconfirmed daily grouping to Taipei", async () => {
    const { result } = await run(ok([{ date: "2026-10-24", totalTokens: 10 }], { timezone: undefined }))
    expect(result.tokenUsageReport).toMatchObject({ status: "unavailable", reason: "timezone_unconfirmed", days: [] })
  })

  it("retains explicit zero and distinguishes no records from absent optional fields", async () => {
    expect((await run(ok([]))).result.tokenUsageReport).toMatchObject({ status: "ok", days: [] })
    const { result } = await run(ok([{ date: "2026-10-24", totalTokens: 0 }]))
    expect(result.tokenUsageReport.days).toEqual([{ date: "2026-10-24", totalTokens: 0 }])
  })

  it.each([
    [null],
    [{ date: "2026-02-30", totalTokens: 1 }],
    [{ date: "2026-10-24" }],
    [{ date: "2026-10-24", totalTokens: "123" }],
    [{ date: "2026-10-24", totalTokens: -1 }],
    [{ date: "2026-10-24", totalTokens: Number.MAX_SAFE_INTEGER + 1 }],
    [{ date: "2026-10-24", totalTokens: 1, inputTokens: null }],
    [{ date: "2026-10-24", totalTokens: 1, models: { "/secret/path": { totalTokens: 1 } } }],
    [{ date: "2026-10-24", totalTokens: 1, models: { model: { totalTokens: 2 } } }],
  ])("rejects malformed day or unsafe fields %j", async (day) => {
    expect((await run(ok([day]))).result.tokenUsageReport).toMatchObject({ status: "invalid", days: [] })
  })

  it("deduplicates identical days but rejects conflicting daily observations", async () => {
    const day = { date: "2026-10-24", totalTokens: 10 }
    expect((await run(ok([day, day]))).result.tokenUsageReport.days).toEqual([day])
    expect((await run(ok([day, { ...day, totalTokens: 11 }]))).result.tokenUsageReport).toMatchObject({ status: "invalid", reason: "conflicting_daily", days: [] })
  })

  it("does not manufacture missing model totals from potentially overlapping components", async () => {
    const { result } = await run(ok([{ date: "2026-10-24", totalTokens: 30, modelBreakdowns: [{ modelName: "model", inputTokens: 20, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 5 }] }]))
    expect(result.tokenUsageReport.days).toEqual([{ date: "2026-10-24", totalTokens: 30 }])
  })

  it.each(["timed_out", "probe_budget_exhausted"])("keeps fixed failure reason %s and fetched quota", async (reason) => {
    const { result } = await run({ status: "runner_failed", reason, stderr: "SECRET" })
    expect(result.tokenUsageReport).toMatchObject({ status: "unavailable", reason, days: [] })
    expect(result.lines.some(line => line.type === "progress")).toBe(true)
  })

  it("keeps quota even if optional statistics throw, without exposing exception content", async () => {
    const { ctx, result } = await run(new Error("SECRET /private/log user@example.invalid"))
    expect(result.tokenUsageReport).toMatchObject({ status: "unavailable", reason: "runner_failed", days: [] })
    expect(result.lines.some(line => line.type === "progress")).toBe(true)
    expect(ctx.host.log.error.mock.calls.flat().join(" ")).not.toMatch(/SECRET|private|example.invalid/)
  })

  if (provider === "codex") it("rejects legacy Codex aggregate with known duplicate risk", async () => {
    const { result } = await run(ok([{ date: "2026-10-24", totalTokens: 1 }], { sourceVersion: "18.0.11", flavor: "legacy" }))
    expect(result.tokenUsageReport).toMatchObject({ status: "unavailable", reason: "legacy_duplicate_risk", days: [] })
  })
})
