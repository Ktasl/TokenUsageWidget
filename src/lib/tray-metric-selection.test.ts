import { describe, expect, it } from "vitest"
import { getTrayPrimaryBars } from "@/lib/tray-primary-progress"
import antigravityManifest from "../../plugins/antigravity/plugin.json"
import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"

describe("Antigravity quota selection", () => {
  const meta: PluginMeta = {
    id: antigravityManifest.id,
    name: antigravityManifest.name,
    iconUrl: "antigravity.svg",
    lines: antigravityManifest.lines as PluginMeta["lines"],
    primaryCandidates: antigravityManifest.lines
      .flatMap((line) => "primaryOrder" in line ? [{ label: line.label, order: Number(line.primaryOrder) }] : [])
      .sort((a, b) => a.order - b.order).map((line) => line.label),
  }
  const quota = (label: string, used = 0, limit = 100): PluginOutput["lines"][number] => ({
    type: "progress", label, used, limit, format: { kind: "percent" },
  })
  const run = (lines: PluginOutput["lines"], extra: Partial<Parameters<typeof getTrayPrimaryBars>[0]> = {}) => getTrayPrimaryBars({
    pluginsMeta: [meta],
    pluginSettings: { order: [meta.id], disabled: [] },
    pluginStates: { [meta.id]: { loading: false, error: null, data: { providerId: meta.id, displayName: meta.name, iconUrl: meta.iconUrl, lines } } },
    ...extra,
  })

  it("shows Gemini Flash's real 100% remaining when Pro is missing, following manifest order", () => {
    expect(run([quota("Claude"), quota("Gemini Flash")])).toEqual([
      { id: "antigravity", label: "Gemini Flash", fraction: 1 },
    ])
  })

  it.each([[0, 0], [NaN, 100], [Infinity, 100], [0, Infinity]])("falls back from invalid Pro %s/%s to Flash", (used, limit) => {
    expect(run([quota("Gemini Pro", used, limit), quota("Gemini Flash"), quota("Claude")])[0]).toMatchObject({ label: "Gemini Flash", fraction: 1 })
  })

  it("falls back to Claude if both Pro and Flash have no valid quota", () => {
    expect(run([quota("Gemini Pro", 0, 0), quota("Gemini Flash", NaN), quota("Claude", 40)])[0]).toMatchObject({ label: "Claude", fraction: 0.6 })
  })

  it("keeps declared Pro priority and a real zero remaining value", () => {
    expect(run([quota("Gemini Flash"), quota("Gemini Pro", 100)])[0]).toMatchObject({ label: "Gemini Pro", fraction: 0 })
    expect(run([quota("Gemini Pro", 30), quota("Gemini Flash")], { displayMode: "used" })[0]).toMatchObject({ label: "Gemini Pro", fraction: 0.3 })
  })

  it("allows valid overview quota without primaryCandidates", () => {
    expect(run([quota("Gemini Flash")], { pluginsMeta: [{ ...meta, primaryCandidates: [] }] })[0]).toMatchObject({ label: "Gemini Flash", fraction: 1 })
  })

  it("uses the saved raw metric label ahead of primary and weekly choices", () => {
    expect(run([quota("Gemini Pro", 20), quota("Gemini Flash", 40), quota("Claude", 60)], {
      pluginsMeta: [{ ...meta, weeklyCandidate: "Gemini Flash" }], preferWeekly: true,
      pluginSettings: { order: [meta.id], disabled: [], menubarMetrics: { antigravity: "Claude" } },
    })[0]).toEqual({ id: "antigravity", label: "Claude", fraction: 0.4 })
  })

  it("temporarily falls back when the saved metric is unavailable without changing its setting", () => {
    const pluginSettings = { order: [meta.id], disabled: [], menubarMetrics: { antigravity: "Claude" } }
    expect(run([quota("Gemini Flash")], { pluginSettings })[0]).toMatchObject({ label: "Gemini Flash", fraction: 1 })
    expect(pluginSettings.menubarMetrics).toEqual({ antigravity: "Claude" })
    expect(run([quota("Gemini Pro", 20), quota("Claude", 0, 0)], { pluginSettings })[0]).toMatchObject({ label: "Gemini Pro", fraction: 0.8 })
  })

  it("keeps a valid weekly-only quota and falls back from invalid weekly quota", () => {
    expect(run([quota("Gemini Flash", 20)], { preferWeekly: true, pluginsMeta: [{ ...meta, primaryCandidates: [], weeklyCandidate: "Gemini Flash" }] })[0]).toEqual({ id: "antigravity", label: "Gemini Flash", fraction: 0.8, weekly: true })
    expect(run([quota("Gemini Flash", 0, 0), quota("Gemini Pro", 20)], { preferWeekly: true, pluginsMeta: [{ ...meta, weeklyCandidate: "Gemini Flash" }] })[0]).toMatchObject({ label: "Gemini Pro", fraction: 0.8 })
  })
})
