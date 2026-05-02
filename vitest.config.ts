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
        // Current measured: lines/statements ~33.1%, functions ~69.2%, branches ~78.7%.
        // Last raised 2026-05-02 with vendor-status.test.ts (+20 tests).
        lines: 32,
        functions: 67,
        branches: 76,
        statements: 32,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
