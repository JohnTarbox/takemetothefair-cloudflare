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
        // Tightened gate over a meaningful denominator (src/lib/ minus
        // integration code). Floor is set ~2 points below current measured
        // coverage so day-to-day fluctuations don't break CI; significant
        // regressions still trip it. Raise as more lib helpers gain tests.
        // Current measured: lines/statements ~35%, functions ~66%, branches ~76%.
        lines: 33,
        functions: 60,
        branches: 70,
        statements: 33,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
