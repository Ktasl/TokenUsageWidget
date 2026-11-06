import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSettingsPluginList } from "@/hooks/app/use-settings-plugin-list"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"

function createPluginMeta(id: string, name: string): PluginMeta {
  return {
    id,
    name,
    iconUrl: `/${id}.svg`,
    brandColor: "#000000",
    lines: [],
    primaryCandidates: [],
  }
}

describe("useSettingsPluginList", () => {
  it("returns ordered settings plugins with enabled state", () => {
    const pluginSettings: PluginSettings = {
      order: ["codex", "missing", "cursor"],
      disabled: ["cursor"],
    }

    const { result } = renderHook(() =>
      useSettingsPluginList({
        pluginSettings,
        pluginsMeta: [
          createPluginMeta("cursor", "Cursor"),
          createPluginMeta("codex", "Codex"),
        ],
      })
    )

    expect(result.current).toEqual([
      { id: "codex", name: "Codex", enabled: true, metricOptions: [], selectedMetric: "" },
      { id: "cursor", name: "Cursor", enabled: false, metricOptions: [], selectedMetric: "" },
    ])
  })

  it("returns empty list when settings are not loaded", () => {
    const { result } = renderHook(() =>
      useSettingsPluginList({
        pluginSettings: null,
        pluginsMeta: [createPluginMeta("codex", "Codex")],
      })
    )

    expect(result.current).toEqual([])
  })

  it("combines overview and runtime quota choices while preserving a temporarily unavailable selection", () => {
    const { result } = renderHook(() => useSettingsPluginList({
      pluginSettings: { order: ["antigravity"], disabled: [], menubarMetrics: { antigravity: "Stored Missing" } },
      pluginsMeta: [{ ...createPluginMeta("antigravity", "Antigravity"), lines: [
        { type: "progress", label: "Gemini Pro", scope: "overview" },
        { type: "progress", label: "Gemini Flash", scope: "overview" },
        { type: "text", label: "Today", scope: "overview" },
      ] }],
      pluginStates: { antigravity: { data: { providerId: "antigravity", displayName: "Antigravity", iconUrl: "", lines: [
        { type: "progress", label: "Gemini Flash", used: 0, limit: 100, format: { kind: "percent" } },
        { type: "progress", label: "Claude", used: 0, limit: 100, format: { kind: "percent" } },
      ] }, loading: false, error: null, lastUpdatedAt: null, lastManualRefreshAt: null } },
    }))
    expect(result.current[0].selectedMetric).toBe("Stored Missing")
    expect(result.current[0].metricOptions).toEqual(["Gemini Pro", "Gemini Flash", "Claude"].map((label) => ({ value: label, label })))
  })
})
