import { defineConfig, devices } from "@playwright/test";

// Files that only run in the authenticated project
const authenticatedPatterns = [
  "**/import-url-authenticated.spec.ts",
  "**/single-day-event.spec.ts",
];

// Patterns to exclude from local runs (no PLAYWRIGHT_BASE_URL)
const localIgnore = process.env.PLAYWRIGHT_BASE_URL ? [] : ["**/smoke.spec.ts"];

// OPE-1669 — which local server the suite runs against.
//
// CI (and `E2E_SERVER=start` locally) runs a PRODUCTION BUILD under `next
// start`. Under `next dev` every route compiles on its first request, so the
// first assertion on any not-yet-warmed route raced that compile: on a loaded
// runner it lost (OPE-1518 — `vendor-logo` failed 3 of 4 runs and one failure
// skipped every deploy job), and the 20s waits that papered over it could no
// longer tell "slow compile" from "the form never rendered".
//
// Fidelity accepted: this is still the Node.js runtime, NOT the workerd
// runtime production uses (`@opennextjs/cloudflare` → the meetmeatthefair-app
// Worker). That is exactly what `next dev` tested too, so nothing is lost; what
// changes is that the code under test is the optimised production bundle.
// An OpenNext build served by `wrangler dev` was rejected: it adds the OpenNext
// bundling step whose failures have already blocked deploys (OPE-1516), plus
// local emulation of the R2 incremental cache, the DO queue and the
// WORKER_SELF_REFERENCE service binding — each a new way for the deploy gate
// to fail on runner conditions rather than on the app (OPE-1670). The Workers
// runtime is exercised only against the real deploy: deploy.yml's post-deploy
// smoke step and the weekly Production Verification workflow — not here, and
// it wasn't before this change either.
//
// Local runs default to `next dev` (no build step, reuses a running server).
const useProductionBuild = !!process.env.CI || process.env.E2E_SERVER === "start";

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
        webServer: useProductionBuild
          ? {
              // OPE-1669 — serve the production build. CI's "Build app for E2E"
              // step runs `E2E_BUILD=1 next build` first; if it didn't, `next
              // start` exits with "Could not find a production build" and the
              // suite fails at startup instead of testing a stale build.
              command: "npx next start -p 3000",
              url: "http://localhost:3000",
              reuseExistingServer: false,
              timeout: 120 * 1000,
              // Opts `next start` into the local miniflare D1/KV/R2 bindings
              // (next.config.mjs). Playwright merges this over process.env.
              env: { E2E_LOCAL_BINDINGS: "1" },
            }
          : {
              command: "npm run dev",
              url: "http://localhost:3000",
              reuseExistingServer: true,
              timeout: 120 * 1000,
            },
      }
    : {}),
});
