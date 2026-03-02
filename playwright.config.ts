import { defineConfig, devices } from "@playwright/test";

// Files that only run in the authenticated project
const authenticatedPatterns = [
  "**/import-url-authenticated.spec.ts",
  "**/single-day-event.spec.ts",
];

// Patterns to exclude from local runs (no PLAYWRIGHT_BASE_URL)
const localIgnore = process.env.PLAYWRIGHT_BASE_URL
  ? []
  : ["**/smoke.spec.ts"];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Auth setup — logs in once and saves session cookies to .auth/admin.json
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },

    // Unauthenticated tests (no storageState)
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [...authenticatedPatterns, "**/auth.setup.ts", ...localIgnore],
    },

    // Authenticated tests — reuse saved admin session
    {
      name: "chromium-authenticated",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/admin.json",
      },
      testMatch: authenticatedPatterns,
      dependencies: ["setup"],
    },

    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: [...authenticatedPatterns, "**/auth.setup.ts", ...localIgnore],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: [...authenticatedPatterns, "**/auth.setup.ts", ...localIgnore],
    },
  ],
  ...(!process.env.PLAYWRIGHT_BASE_URL ? {
    webServer: {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
  } : {}),
});
