export const IS_TEST_BUILD = import.meta.env.VITE_TOKEN_USAGE_TEST_BUILD === "1"
export const APP_DISPLAY_NAME = IS_TEST_BUILD ? "TokenUsageWidget" : "OpenUsage"
export const APP_BUILD_NUMBER = IS_TEST_BUILD ? import.meta.env.VITE_TOKEN_USAGE_BUILD_NUMBER : undefined
