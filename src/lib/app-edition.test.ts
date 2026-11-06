import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each([[undefined, false, "OpenUsage"], ["0", false, "OpenUsage"], ["1", true, "TokenUsageWidget"]])("uses the explicit test-build flag %s", async (flag, expected, name) => {
  vi.stubEnv("VITE_TOKEN_USAGE_TEST_BUILD", flag)
  vi.stubEnv("VITE_TOKEN_USAGE_BUILD_NUMBER", "20261022.1")
  vi.resetModules()
  const edition = await import("./app-edition")
  expect(edition.IS_TEST_BUILD).toBe(expected)
  expect(edition.APP_DISPLAY_NAME).toBe(name)
  expect(edition.APP_BUILD_NUMBER).toBe(expected ? "20261022.1" : undefined)
})
