import { afterEach, expect, it, vi } from "vitest"
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }))
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
it("defaults a fresh TokenUsageWidget installation to compact icons without changing the upstream edition", async () => {
  for (const [flag, expected] of [["1", "compact"], ["0", "provider"]]) {
    vi.stubEnv("VITE_TOKEN_USAGE_TEST_BUILD", flag)
    vi.resetModules()
    expect((await import("./settings")).DEFAULT_MENUBAR_ICON_STYLE).toBe(expected)
  }
})
