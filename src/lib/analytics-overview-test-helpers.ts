/**
 * Re-exports of internal symbols from analytics-overview.ts for test access.
 * Keeping the actual constants module-private (not exported from the main
 * file) avoids polluting the public surface; callers import the test-only
 * symbol from this companion module.
 */
export const BRAND_KEYWORDS_FOR_TEST = [
  "meet me at the fair",
  "meetmeatthefair",
  "mmatf",
  "take me to the fair",
] as const;
