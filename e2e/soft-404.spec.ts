import { test, expect } from "@playwright/test";

/**
 * OPE-420 — bogus slugs must return HTTP 404, not a 200 carrying the 404 page.
 *
 * These assert the STATUS LINE only. That is the whole point: the body was
 * always correct — right <title>, right noindex, no schema — so every check
 * that grepped the HTML passed while `/events/*`, `/venues/*` and `/vendors/*`
 * served an unbounded surface of indexable 200s. The defect was invisible to
 * content assertions for months.
 *
 * Root cause was a `loading.tsx` at `src/app/{events,venues,vendors}/`. A
 * `loading.tsx` creates an implicit Suspense boundary over its segment AND
 * every descendant, so Next streams the response and commits the 200 status
 * line before the page body reaches `notFound()`. blog / promoters /
 * performers had no such file and always returned a correct 404.
 *
 * The fix scopes each boundary to a `(listing)` route group holding only the
 * listing pages, leaving the `[slug]` detail routes outside it. Route groups
 * do not affect URLs, so the listing paths below must keep working unchanged —
 * that is what stops a "fix" that just deletes the skeleton everywhere.
 *
 * ---------------------------------------------------------------------------
 * Why the nonce is built inside the test body and not in the title
 * ---------------------------------------------------------------------------
 *
 * Not-found responses are edge-cached for ~600s, so reusing a fixed bogus slug
 * can return a cached status and mask a regression. The slug therefore has to
 * vary per run.
 *
 * But Playwright loads this file in the coordinator process AND again in each
 * worker process, then matches tests between them BY TITLE. A `Date.now()`
 * computed at module scope produces a different value in each process, the
 * titles stop matching, and every test fails with "Test not found in the worker
 * process" — which is exactly what happened on the first attempt at this file.
 *
 * So: titles are static, and the varying part is generated at run time inside
 * the test body.
 */

/** Static, human-readable stand-in used only in test TITLES. */
const SLUG_TOKEN = "<nonce>";

/** The actual slug used at request time. Generated per test, never in a title. */
function bogusSlug(): string {
  return `zz-ope420-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const shouldBe404 = [
  `/events/${SLUG_TOKEN}`,
  `/venues/${SLUG_TOKEN}`,
  `/vendors/${SLUG_TOKEN}`,
  // The [slug]/[year] occurrence route accepted ANY second segment, which is
  // what made the soft-404 surface effectively unbounded.
  `/events/${SLUG_TOKEN}/september`,
  `/events/${SLUG_TOKEN}/2027`,
  // OPE-395 facet routes inherited the boundary from the events segment.
  `/events/massachusetts/${SLUG_TOKEN}`,
  `/events/connecticut/${SLUG_TOKEN}`,
  // Found by the structural guard, NOT by the ticket: the browse letter/state
  // routes are dynamic too and sat under the same boundary.
  `/venues/browse/letter/${SLUG_TOKEN}`,
  `/venues/browse/state/${SLUG_TOKEN}`,
  `/vendors/browse/letter/${SLUG_TOKEN}`,
  `/vendors/browse/state/${SLUG_TOKEN}`,
  // Regression guards: these two always worked and must keep working.
  `/blog/${SLUG_TOKEN}`,
  `/promoters/${SLUG_TOKEN}`,
];

test.describe("bogus slugs return a real 404 status", () => {
  for (const template of shouldBe404) {
    test(`${template} -> 404`, async ({ page }) => {
      const response = await page.goto(template.replace(SLUG_TOKEN, bogusSlug()));
      expect(response?.status()).toBe(404);
    });
  }
});

/**
 * The fix moved real pages into `(listing)` route groups. Route groups are
 * URL-invisible, so every one of these must still resolve — if a move went
 * wrong these 404 instead, and the test above would still be green.
 */
const shouldBe200 = [
  "/events",
  "/events/maine",
  "/events/past",
  "/events/craft-fairs",
  "/events/massachusetts",
  "/events/connecticut",
  "/venues",
  "/vendors",
  "/venues/browse",
  "/vendors/browse",
];

test.describe("route-group moves did not change any URL", () => {
  for (const path of shouldBe200) {
    test(`${path} still resolves`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
    });
  }
});
