/**
 * OPE-363 — synthetic funnel canary. Runs against PRODUCTION on a schedule.
 *
 * ── What this catches that nothing else could ───────────────────────────────
 * OPE-361 displaced the /register form off-screen on mobile when Turnstile
 * mounted. The page returned 200, rendered clean, threw nothing, and logged
 * nothing. Uptime and error-rate monitoring are structurally blind to it, and
 * the conversion KPI was already at zero (OPE-59: 1 claim from 5,289 profiles),
 * so breaking the funnel entirely could not move the number. A real vendor had
 * to tell John.
 *
 * So every assertion here is about USABILITY, never presence. `toBeVisible()`
 * PASSED against the broken build — the control was in the tree, just crushed
 * to 8px or translated past the right edge. The invariants are therefore:
 * the control's box lies inside the viewport, AND it is wide enough to use, AND
 * (where safe) it actually accepts input.
 *
 * ── Scope, and what it deliberately does NOT do ─────────────────────────────
 * This asserts each funnel is USABLE up to the point of submission. It does NOT
 * submit.
 *
 * Production runs a real Turnstile site key with no test/bypass key configured
 * (verified 2026-08-16: no `1x0000…` test key, no bypass flag anywhere in the
 * repo), so an automated client cannot clear the challenge. Completing the
 * funnels against prod would also mean creating real users, claims and events
 * on every run. Both need a decision that is John's, not mine — recorded on the
 * ticket.
 *
 * That boundary costs less than it sounds: OPE-361 was a layout fault that
 * appeared WHEN TURNSTILE MOUNTED, and these assertions run after the widget
 * has had time to inject. The bug that motivated this ticket is caught here
 * without a single production write.
 *
 * ── Why against production and not a preview ────────────────────────────────
 * OPE-321: verification that does not touch the served surface is not
 * verification. An upload once returned 200, set the DB field, and 404'd on the
 * CDN. Requires PLAYWRIGHT_BASE_URL to be set to the production origin.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

/** Widths that matter in the field: iPhone SE, iPhone 12/13/14, Pro Max. */
const MOBILE_WIDTHS = [320, 390, 430];

/** Time for a third-party widget to inject. The OPE-361 fault only existed
 *  AFTER Turnstile mounted, so asserting sooner passes against a broken build. */
const WIDGET_SETTLE_MS = 3000;

/** Narrowest a control can be and still be usable by a thumb. The broken
 *  build produced an 8px-wide email input that was "visible". */
const MIN_USABLE_WIDTH = 180;

/**
 * The assertion OPE-361 needed and `toBeVisible()` could not provide.
 *
 * Checks three things a human needs and the DOM does not guarantee: the control
 * is inside the viewport horizontally, it is wide enough to interact with, and
 * it has non-zero height. Returns a failure string rather than throwing so one
 * canary run can report EVERY broken funnel instead of only the first.
 */
async function assertUsable(
  page: Page,
  locator: Locator,
  label: string,
  minWidth = MIN_USABLE_WIDTH
): Promise<string | null> {
  const viewport = page.viewportSize();
  if (!viewport) return `${label}: no viewport`;

  try {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return `${label}: not visible`;
  }

  const box = await locator.boundingBox();
  if (!box) return `${label}: no bounding box (not rendered)`;
  if (box.x < 0) return `${label}: starts off-screen left (x=${Math.round(box.x)})`;
  if (box.x + box.width > viewport.width + 1) {
    return `${label}: extends past right edge (x=${Math.round(box.x)}, w=${Math.round(box.width)}, vp=${viewport.width})`;
  }
  if (box.width < minWidth) {
    return `${label}: crushed to ${Math.round(box.width)}px (need ${minWidth}px)`;
  }
  if (box.height < 8) return `${label}: collapsed to ${Math.round(box.height)}px tall`;
  return null;
}

/** Report the whole run to D1 so a canary that STOPS is detectable, not just
 *  one that fails. No-op locally: only stamps when the internal key is present. */
async function stamp(profile: string, failures: string[], checks: number) {
  const base = process.env.PLAYWRIGHT_BASE_URL;
  const key = process.env.INTERNAL_API_KEY;
  if (!base || !key) return;
  try {
    await fetch(`${base}/api/internal/funnel-canary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      body: JSON.stringify({ ok: failures.length === 0, profile, failures, checks }),
    });
  } catch {
    // Never fail the canary because reporting failed — the test result is the
    // primary signal and the probe covers a silent reporter.
  }
}

test.describe("funnel canary (OPE-363)", () => {
  // Production only. Running these against a dev server would assert nothing
  // about the served surface and would quietly become a false green.
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "funnel canary runs against a deployed origin; set PLAYWRIGHT_BASE_URL"
  );

  for (const width of MOBILE_WIDTHS) {
    test(`register funnel is usable at ${width}px`, async ({ page }, testInfo) => {
      const failures: string[] = [];
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/register", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(WIDGET_SETTLE_MS);

      const checks: Array<[Locator, string, number?]> = [
        [page.locator('input[type="email"]').first(), "register:email"],
        [page.getByRole("button", { name: /create account/i }), "register:submit", 120],
      ];
      for (const [loc, label, min] of checks) {
        const f = await assertUsable(page, loc, `${label}@${width}`, min);
        if (f) failures.push(f);
      }

      // Presence is not usability: prove the field actually accepts input.
      const email = page.locator('input[type="email"]').first();
      if ((await email.count()) > 0) {
        try {
          await email.fill("canary@example.invalid", { timeout: 5000 });
          if ((await email.inputValue()) !== "canary@example.invalid") {
            failures.push(`register:email@${width}: would not accept input`);
          }
        } catch {
          failures.push(`register:email@${width}: fill() blocked (overlapped?)`);
        }
      }

      await stamp(`${testInfo.project.name}:register:${width}`, failures, checks.length + 1);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  // ── Does this canary actually catch OPE-361? ──────────────────────────────
  //
  // "A canary that would not have caught OPE-361 does not close this ticket."
  //
  // The exact CSS cannot be re-introduced against production: the fix moved the
  // Turnstile container INSIDE the card, so there is no longer a sibling to put
  // back in a flex row. What can be reproduced faithfully is the SYMPTOM, and
  // the symptom is what a detector must key on — measured on the broken build at
  // the time: the card crushed to 58px, and the control pushed past the right
  // edge.
  //
  // Injected client-side only. No production write, no state change.
  test("detector rejects the OPE-361 geometry (regression proof)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(WIDGET_SETTLE_MS);

    const email = page.locator('input[type="email"]').first();

    // Control: production is healthy right now, so the detector must be quiet.
    expect(await assertUsable(page, email, "healthy@390")).toBeNull();

    // Symptom 1 — CRUSHED. The measured 58px card, which `toBeVisible()` passed.
    await page.addStyleTag({
      content: `[class*="max-w-md"]{max-width:58px !important;width:58px !important;}`,
    });
    await page.waitForTimeout(300);
    const crushed = await assertUsable(page, email, "crushed@390");
    expect(crushed, "detector missed a 58px-wide form").not.toBeNull();
    expect(crushed).toContain("crushed to");

    // Symptom 2 — PUSHED OFF-SCREEN, the iPhone presentation of the same bug.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(WIDGET_SETTLE_MS);
    await page.addStyleTag({
      content: `[class*="max-w-md"]{transform:translateX(380px) !important;}`,
    });
    await page.waitForTimeout(300);
    const pushed = await assertUsable(page, email, "pushed@390");
    expect(pushed, "detector missed a form pushed past the right edge").not.toBeNull();
    expect(pushed).toContain("past right edge");
  });

  test("suggest-event funnel is usable at 390px", async ({ page }, testInfo) => {
    // The other Turnstile mount in the app (turnstile-size-guard.test.ts lists
    // exactly two), so it carries the same layout risk as /register.
    const failures: string[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/suggest-event", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(WIDGET_SETTLE_MS);

    const f = await assertUsable(page, page.locator("form").first(), "suggest:form@390", 250);
    if (f) failures.push(f);
    const firstInput = page.locator("form input, form textarea").first();
    const f2 = await assertUsable(page, firstInput, "suggest:first-field@390");
    if (f2) failures.push(f2);

    await stamp(`${testInfo.project.name}:suggest:390`, failures, 2);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("claim entry point is reachable from a vendor profile at 390px", async ({
    page,
  }, testInfo) => {
    // The claim funnel is what a real vendor could not complete (OPE-361 /
    // OPE-59). Navigates from a real listing rather than deep-linking, because
    // the entry CTA is part of what can break.
    const failures: string[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/vendors", { waitUntil: "domcontentloaded" });

    // ── Sample until we find an UNCLAIMED listing ────────────────────────────
    //
    // `ClaimListingCTA` renders only when `!claimed && !isOwner && !isAdmin`, so
    // an already-claimed vendor legitimately has no CTA. The first draft of this
    // test asserted on the first vendor link and failed against healthy
    // production on its very first run — a false positive that would have paged
    // John on day one.
    //
    // Sampling is also the more meaningful assertion: with ~7 claims against
    // 5,289 profiles (OPE-59), finding NO claimable listing in a sample of 5 is
    // itself a real signal, not a flake.
    const SAMPLE = 5;
    const hrefs = await page.locator('a[href^="/vendors/"]').evaluateAll((els, n) => {
      const seen = new Set<string>();
      for (const el of els) {
        const h = (el as HTMLAnchorElement).getAttribute("href");
        // Skip the index itself and any anchor/query variants.
        if (h && /^\/vendors\/[^/?#]+$/.test(h)) seen.add(h);
        if (seen.size >= n) break;
      }
      return [...seen];
    }, SAMPLE);

    if (hrefs.length === 0) {
      failures.push("claim:listing@390: no vendor links on /vendors");
    } else {
      let checked = 0;
      let ctaFailure: string | null = null;
      let foundClaimable = false;

      for (const href of hrefs) {
        await page.goto(href, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(WIDGET_SETTLE_MS);
        checked++;

        const link = page.getByRole("link", { name: /claim/i }).first();
        const button = page.getByRole("button", { name: /claim/i }).first();
        const target = (await link.count()) > 0 ? link : button;
        if ((await target.count()) === 0) continue; // claimed listing — fine

        foundClaimable = true;
        ctaFailure = await assertUsable(page, target, `claim:cta@390 (${href})`, 60);
        break;
      }

      if (!foundClaimable) {
        failures.push(
          `claim:cta@390: no claimable listing found in ${checked} sampled vendors — ` +
            `either every sample is claimed (implausible at ~7/5289) or the CTA stopped rendering`
        );
      } else if (ctaFailure) {
        failures.push(ctaFailure);
      }
    }

    await stamp(`${testInfo.project.name}:claim:390`, failures, 2);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
