import { beforeEach, describe, expect, it, vi } from "vitest"
import { arePluginSettingsEqual, loadPluginSettings, savePluginSettings, normalizePluginSettings, migrateWindsurfToDevin } from "./settings"

const data = new Map<string, unknown>()
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {
  async get(key: string) { return data.get(key) }
  async set(key: string, value: unknown) { data.set(key, value) }
  async save() {}
} }))
beforeEach(() => data.clear())

describe("saved menu bar metrics", () => {
  it("loads and saves raw metric labels while ignoring malformed values", async () => {
    data.set("plugins", { order: ["antigravity"], disabled: [], menubarMetrics: { antigravity: "Gemini Flash", bad: 3, blank: "" } })
    expect(await loadPluginSettings()).toEqual({ order: ["antigravity"], disabled: [], menubarMetrics: { antigravity: "Gemini Flash" } })
    await savePluginSettings({ order: ["antigravity"], disabled: [], menubarMetrics: { antigravity: "Claude" } })
    expect(await loadPluginSettings()).toEqual({ order: ["antigravity"], disabled: [], menubarMetrics: { antigravity: "Claude" } })
  })

  it("omits empty maps for compatibility with older settings", async () => {
    await savePluginSettings({ order: [], disabled: [], menubarMetrics: {} })
    expect(data.get("plugins")).toEqual({ order: [], disabled: [] })
    expect(await loadPluginSettings()).toEqual({ order: [], disabled: [] })
  })

  it("keeps a known provider's selection even if disabled or its current metric is missing", () => {
    const settings = { order: ["antigravity"], disabled: ["antigravity"], menubarMetrics: { antigravity: "Temporarily Missing", unknown: "Other" } }
    expect(normalizePluginSettings(settings, [{ id: "antigravity", name: "Antigravity", iconUrl: "", lines: [], primaryCandidates: [] }])).toEqual({
      order: ["antigravity"], disabled: ["antigravity"], menubarMetrics: { antigravity: "Temporarily Missing" },
    })
    expect(settings.menubarMetrics.unknown).toBe("Other")
  })

  it("migrates a renamed provider's metric without overwriting an explicit new-provider choice", () => {
    const original = { order: ["windsurf"], disabled: [], menubarMetrics: { windsurf: "Credits", codex: "Weekly" } }
    expect(migrateWindsurfToDevin(original).menubarMetrics).toEqual({ devin: "Credits", codex: "Weekly" })
    expect(original.menubarMetrics).toEqual({ windsurf: "Credits", codex: "Weekly" })
    expect(migrateWindsurfToDevin({ ...original, menubarMetrics: { windsurf: "Credits", devin: "Plan" } }).menubarMetrics).toEqual({ devin: "Plan" })
  })

  it("compares metric changes and treats absent and empty maps as equivalent", () => {
    const base = { order: ["antigravity"], disabled: [] }
    expect(arePluginSettingsEqual(base, { ...base, menubarMetrics: {} })).toBe(true)
    expect(arePluginSettingsEqual(base, { ...base, menubarMetrics: { antigravity: "Claude" } })).toBe(false)
    expect(arePluginSettingsEqual({ ...base, menubarMetrics: { antigravity: "Claude" } }, { ...base, menubarMetrics: { antigravity: "Gemini Flash" } })).toBe(false)
    expect(arePluginSettingsEqual({ ...base, menubarMetrics: { antigravity: "Claude", codex: "Weekly" } }, { ...base, menubarMetrics: { codex: "Weekly", antigravity: "Claude" } })).toBe(true)
  })
})
