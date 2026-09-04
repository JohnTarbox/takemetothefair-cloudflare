/**
 * OPE-790 — the retry is WIRED, not merely available.
 *
 * `d1-resilience.test.ts` proves the primitive behaves. It would pass in full
 * with the primitive imported by nothing at all, which is the exact shape of
 * failure this repo keeps logging: a control that is correct and never runs is
 * indistinguishable from one that runs and passes.
 *
 * So this asserts the five fetchers named in OPE-790's acceptance actually call
 * it, anchored on the CALL SYNTAX with the literal source string. A bare symbol
 * search would match the import line and go vacuously green.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** file → the exact `source` strings that must be retry-wrapped in it. */
const WIRED: Array<[string, string[]]> = [
  ["src/app/events/(listing)/page.tsx", ["app/events/page.tsx:getEvents"]],
  ["src/app/events/[slug]/event-detail-data.ts", ["app/events/[slug]/page.tsx:getEvent"]],
  [
    "src/app/vendors/(listing)/page.tsx",
    [
      "app/vendors/page.tsx:getVendors",
      "app/vendors/page.tsx:getVendorTypes",
      "app/vendors/page.tsx:getFeaturedVendors",
    ],
  ],
];

describe("OPE-790 — every browse-surface fetcher in the acceptance is retry-wrapped", () => {
  const cases = WIRED.flatMap(([file, sources]) => sources.map((s) => [file, s] as const));

  // The positive landmark for the assertions below: if this drops, the suite is
  // checking fewer fetchers than the acceptance names, and every "wired" pass
  // below would still be green.
  it("examines exactly the five fetchers OPE-790 names", () => {
    expect(cases).toHaveLength(5);
  });

  it.each(cases)("%s wraps %s", (file, source) => {
    const src = read(file);
    // Anchored on the call, not the symbol: `withD1ReadLogged("<source>"`.
    expect(src).toContain(`withD1ReadLogged("${source}"`);
  });

  it.each(cases)(
    "%s still throws FetchError for %s when the retry does not help",
    (file, source) => {
      // REL1' §1 is preserved deliberately. A D1 failure that survives the retry
      // must remain visibly distinct from a real zero-result page — the 2026-06-04
      // outage went 17 hours undetected because an empty list looked identical to
      // an empty filter. If a future change swaps the throw for an empty default,
      // this fails and the reviewer has to argue for it.
      expect(read(file)).toContain(`new FetchError("${source}"`);
    }
  );
});
