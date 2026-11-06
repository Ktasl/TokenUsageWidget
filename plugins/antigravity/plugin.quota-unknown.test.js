import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const routes = ["user-status", "command-configs", "cloud-models", "agy-buckets"]
const marker = "fixture-quota-response"
function fixtureContext(route, entries) {
  const ctx = makeCtx()
  ctx.host.sqlite.query.mockReturnValue("[]")
  const configs = entries.map(({ fraction, resetTime, label = "Gemini Pro", quotaInfo }, i) => ({ label, modelOrAlias: { model: "fixture-model-" + i }, quotaInfo: quotaInfo === undefined ? { remainingFraction: fraction, resetTime } : quotaInfo }))
  const body = route === "user-status" ? { userStatus: { cascadeModelConfigData: { clientModelConfigs: configs } } } :
    route === "command-configs" ? { clientModelConfigs: configs } : route === "cloud-models" ? {
      models: Object.fromEntries(configs.map((c, i) => ["fixture-model-" + i, { displayName: c.label, quotaInfo: c.quotaInfo }]))
    } : { buckets: entries.map(({ fraction, resetTime, label = "Gemini Pro" }) => ({ modelId: label, remainingFraction: fraction, resetTime })) }
  // Preserve synthetic NaN/Infinity at the host boundary instead of JSON.stringify -> null.
  ctx.util.tryParseJson = text => { if (text === marker) return body; try { return JSON.parse(text) } catch { return null } }
  ctx.host.ls.discover.mockReturnValue(route === "user-status" || route === "command-configs" ? { pid: 1, csrf: "fixture", ports: [42001], extensionPort: null } : null)
  if (route === "cloud-models") ctx.host.fs.writeText(ctx.app.pluginDataDir + "/auth.json", JSON.stringify({ accessToken: "fixture-only", expiresAtMs: Date.now() + 3600000 }))
  if (route === "agy-buckets") ctx.host.keychain.readGenericPassword.mockReturnValue(JSON.stringify({ access_token: "fixture-only" }))
  ctx.host.http.request.mockImplementation(({ url }) => {
    if (url.includes("GetUnleashData")) return { status: 200, bodyText: "{}" }
    if (url.includes("GetUserStatus") && route === "command-configs") return { status: 500, bodyText: "" }
    if (url.includes("loadCodeAssist")) return { status: 200, bodyText: JSON.stringify({ paidTier: { name: "fixture-plan" }, cloudaicompanionProject: "fixture-project" }) }
    if (url.includes("GetUserStatus") || url.includes("GetCommandModelConfigs") || url.includes("fetchAvailableModels") || url.includes("retrieveUserQuota")) return { status: 200, bodyText: marker }
    return { status: 500, bodyText: "" }
  })
  return ctx
}
for (const route of routes) describe("Antigravity quota unknown: " + route, () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  async function probe(entries) { await import("./plugin.js"); return globalThis.__openusage_plugin.probe(fixtureContext(route, entries)) }
  it.each([undefined, null, "0", "0.5", "invalid", Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])("does not publish a valid percentage for invalid fraction %s", async fraction => {
    const { lines } = await probe([{ fraction }])
    expect(lines.find(line => line.label === "Gemini Pro")).toMatchObject({ type: "text", value: "未提供有效額度" })
    expect(lines.some(line => line.type === "progress")).toBe(false)
    expect(lines.some(line => line.used !== undefined || line.resetsAt !== undefined)).toBe(false)
  })
  it("does not interpret malformed quotaInfo=0 as an explicit zero fraction", async () => {
    const { lines } = await probe([{ quotaInfo: 0 }])
    expect(lines[0]).toMatchObject({ type: "text", value: "未提供有效額度" })
    expect(lines.some(line => line.type === "progress")).toBe(false)
  })
  it.each([0, 1])("keeps source explicit boundary %s as a real quota", async fraction => {
    const { lines } = await probe([{ fraction }])
    expect(lines.find(line => line.label === "Gemini Pro")).toMatchObject({ type: "progress", used: (1 - fraction) * 100, limit: 100 })
    expect(lines[0].resetsAt).toBeUndefined()
  })
  it("ignores an unknown sibling when deduplicating a pool, while preserving the worst valid fraction", async () => {
    const { lines } = await probe([{ fraction: undefined, label: "Gemini Pro (Unknown)" }, { fraction: 0.8, label: "Gemini Pro (High)" }, { fraction: 0.5, label: "Gemini Pro (Low)" }])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ type: "progress", label: "Gemini Pro", used: 50 })
  })
  it.each([undefined, "", "invalid-reset", 123])("never invents a reset from invalid resetTime %s", async resetTime => {
    const { lines } = await probe([{ fraction: 0.5, resetTime }])
    expect(lines[0]).toMatchObject({ type: "progress", used: 50 })
    expect(lines[0].resetsAt).toBeUndefined()
  })
})
