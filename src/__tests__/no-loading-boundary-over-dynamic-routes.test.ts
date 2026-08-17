/**
 * OPE-420 — structural guard against the soft-404 regression.
 *
 * A `loading.tsx` creates an implicit Suspense boundary over its own segment
 * AND every descendant. Next then streams the response, committing the HTTP
 * 200 status line before the page body reaches `notFound()`. The result is a
 * correct 404 *page* served with a 200 *status* — indexable, and invisible to
 * any test that only inspects the HTML.
 *
 * That is exactly how `/events/*`, `/venues/*` and `/vendors/*` served an
 * unbounded surface of soft-404s while `/blog` and `/promoters` (no
 * `loading.tsx`) behaved correctly.
 *
 * So the invariant is: a `loading.tsx` must never sit at or above a dynamic
 * segment that can 404 on arbitrary user input. The fix keeps the skeletons by
 * scoping them to `(browse)` route groups containing only fixed listing paths.
 *
 * This runs in the unit suite rather than e2e because the e2e status test only
 * runs against a deployed site — by which point the regression is already live.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(process.cwd(), "src", "app");

/** Every directory under src/app that contains a loading.tsx. */
function segmentsWithLoading(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (existsSync(join(child, "loading.tsx"))) acc.push(child);
    segmentsWithLoading(child, acc);
  }
  return acc;
}

/** True when `dir` or anything beneath it is a dynamic segment (`[slug]`). */
function containsDynamicSegment(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("[")) return true;
    if (containsDynamicSegment(join(dir, entry.name))) return true;
  }
  return false;
}

describe("no loading.tsx boundary above a dynamic route", () => {
  it("every loading.tsx sits over fixed paths only", () => {
    const offenders = segmentsWithLoading(APP_DIR)
      .filter(containsDynamicSegment)
      .map((p) => p.replace(process.cwd() + "/", ""));

    // A failure here means a `loading.tsx` was added at or above a `[slug]`
    // route. That segment's bogus slugs now return HTTP 200 with the 404 page.
    // Fix by moving the listing pages into a `(browse)` route group and
    // putting loading.tsx inside it, leaving `[slug]` outside — route groups
    // do not change URLs, so nothing else moves.
    expect(offenders).toEqual([]);
  });

  it("still finds the loading.tsx files, so the check cannot pass vacuously", () => {
    // If a refactor moved or renamed every loading.tsx, the assertion above
    // would trivially pass. Pin that at least one boundary still exists.
    expect(segmentsWithLoading(APP_DIR).length).toBeGreaterThan(0);
  });
});
