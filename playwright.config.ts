import { defineConfig, devices } from "@playwright/test";

// Files that only run in the authenticated project
const authenticatedPatterns = [
  "**/import-url-authenticated.spec.ts",
  "**/single-day-event.spec.ts",
];

// Patterns to exclude from local runs (no PLAYWRIGHT_BASE_URL)
const localIgnore = process.env.PLAYWRIGHT_BASE_URL ? [] : ["**/smoke.spec.ts"];

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

    // OPE-361 — iOS Safari on a real iPhone profile.
    //
    // The /register bug was reported by a customer on an iPhone and could not be
    // reproduced by desktop-width testing. Desktop Safari shares WebKit, but not
    // the mobile viewport, deviceScaleFactor, touch flags or iOS user-agent —
    // and this was a responsive-layout fault, i.e. exactly the class those
    // settings decide.
    //
    // Deliberately scoped to mobile-layout specs rather than the whole suite:
    // running every e2e test a fourth time buys little and slows CI, while the
    // layout specs are the ones with a device-specific failure mode.
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
      // OPE-363 — also carries the funnel canary, which is a mobile-layout
      // concern by nature. Added explicitly rather than by widening the glob:
      // the glob is what keeps the other 3× suite runs off this project.
      testMatch: ["**/*-mobile-*.spec.ts", "**/funnel-canary.spec.ts"],
    },
    // OPE-363 — an Android-class profile alongside iOS.
    //
    // Not redundant with mobile-safari: OPE-361 presented DIFFERENTLY on the two
    // engines — the form was pushed past the right edge on iPhone but merely
    // shoved right on Android. A canary that only ran WebKit would have seen one
    // of those two symptoms and could have been "fixed" against the wrong one.
    // Chromium engine, Android viewport/UA/touch flags.
    {
      name: "mobile-android",
      use: { ...devices["Pixel 5"] },
      testMatch: ["**/*-mobile-*.spec.ts", "**/funnel-canary.spec.ts"],
    },
    // Desktop control. If a canary check fails on mobile AND here, the fault is
    // not responsive layout and the triage should start somewhere else.
    {
      name: "canary-desktop",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/funnel-canary.spec.ts"],
    },
  ],
  ...(!process.env.PLAYWRIGHT_BASE_URL
    ? {
        webServer: {
          command: "npm run dev",
          url: "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          timeout: 120 * 1000,
        },
      }
    : {}),
});
