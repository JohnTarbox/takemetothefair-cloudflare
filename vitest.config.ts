import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts,jsx,tsx}"],
    exclude: ["node_modules", ".next", "e2e"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Restrict coverage to `src/lib/` — utility modules where unit tests
      // are meaningful. App routes and React Server Components live in
      // `src/app/` and aren't unit-testable in vitest (edge runtime, auth,
      // DB bindings); they're covered by E2E tests instead.
      include: ["src/lib/**/*.{ts,tsx}"],
      exclude: [
        "**/*.d.ts",
        "**/*.config.*",
        "**/__tests__/**",
        "src/lib/db/schema.ts", // Drizzle schema — type definitions only
        // Integration code that requires Cloudflare runtime / external APIs
        // (Workers AI, GA4, GSC). These are exercised through E2E and
        // production smoke tests, not unit tests.
        "src/lib/cloudflare.ts",
        "src/lib/ga4.ts",
        "src/lib/google-auth.ts",
        "src/lib/search-console.ts",
        "src/lib/bing-webmaster.ts",
        "src/lib/url-import/ai-extractor.ts",
        "src/lib/auth.ts",
        // Recommendations engine + rules — D1 + external-API integration code.
        // Engine is exercised via the admin scan endpoint (E2E surface); rules
        // are simple SQL queries that don't benefit from unit fixturing.
        "src/lib/recommendations/**",
      ],
      thresholds: {
        // Floor set ~2 points below current measured coverage so day-to-day
        // fluctuations don't break CI; significant regressions still trip it.
        // Raise as more lib helpers gain tests.
        //
        // Adjusted 2026-05-01 after Phase A.4 (validations moved into
        // @takemetothefair/validation workspace package). The validation
        // schemas had ~100% coverage and were mathematically over-weighted
        // toward the main-app average; moving 568 lines of well-tested code
        // out drags the measured % for the remaining src/lib/ down even
        // though no real coverage was lost (the tests still pass, just in
        // the package's own vitest run).
        //
        // Adjusted 2026-05-03 after recommendations engine + rules excluded
        // (integration code; D1 + external-API). With those out of scope,
        // measured drops to ~35.0% lines/statements (vs. ~38% comment above
        // which appears to have drifted before this measurement). Floor set
        // accordingly.
        //
        // Current measured: lines/statements ~35.06%, functions ~75%, branches ~80%.
        lines: 34,
        functions: 72,
        branches: 78,
        statements: 34,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
