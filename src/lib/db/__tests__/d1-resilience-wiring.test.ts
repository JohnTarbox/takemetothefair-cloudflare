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
  // OPE-790 rework (John, 2026-10-04: "extend the retry to vendor detail pages";
  // a performer page hit the same "Network connection lost" on 10-04).
  ["src/app/vendors/[slug]/page.tsx", ["app/vendors/[slug]/page.tsx:getVendor"]],
  ["src/app/performers/[slug]/page.tsx", ["app/performers/[slug]/page.tsx:getPerformer"]],
];

describe("OPE-790 — every browse-surface fetcher in the acceptance is retry-wrapped", () => {
  const cases = WIRED.flatMap(([file, sources]) => sources.map((s) => [file, s] as const));

  // The positive landmark for the assertions below: if this drops, the suite is
  // checking fewer fetchers than the acceptance names, and every "wired" pass
  // below would still be green.
  it("examines exactly the seven fetchers (OPE-790's five + the 10-04 rework's two)", () => {
    expect(cases).toHaveLength(7);
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

/**
 * OPE-790 rework — the view counter is NOT inside the retried read.
 *
 * It was: `getEventOnce` ran `UPDATE events SET view_count …` mid-read, and
 * `getEvent` retries `getEventOnce`. A D1 timeout that committed and reported
 * failure (the very class retried) could count a view twice; a failed COUNTER
 * took the page down (both absorbed blips on 10-03/10-04 were this UPDATE); and
 * because generateMetadata ALSO calls getEvent, every render counted twice —
 * measured live 10-04: 2 requests moved a vendor's view_count by 4.
 */
const COUNTED: Array<[file: string, once: string, counter: string, table: string]> = [
  ["src/app/events/[slug]/event-detail-data.ts", "getEventOnce", "countEventView", "events"],
  ["src/app/vendors/[slug]/page.tsx", "getVendorOnce", "countVendorView", "vendors"],
  ["src/app/performers/[slug]/page.tsx", "getPerformerOnce", "countPerformerView", "performers"],
];

/** The body of `async function <name>(` up to the next top-level closing brace. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

describe("OPE-790 rework — view counters live outside the retried read, once per render", () => {
  it("examines all three detail pages (landmark)", () => {
    expect(COUNTED).toHaveLength(3);
  });

  it.each(COUNTED)("%s: %s does not write view_count", (file, once, _c, table) => {
    expect(fnBody(read(file), once)).not.toContain(`UPDATE ${table} SET view_count`);
  });

  it.each(COUNTED)("%s: the page calls %s exactly once, after the read", (file, _o, counter) => {
    const page = file.endsWith("event-detail-data.ts")
      ? read("src/app/events/[slug]/page.tsx")
      : read(file);
    const def = page.slice(page.indexOf("export default async function"));
    expect(def.split(`${counter}(`).length - 1).toBe(1);
  });

  it.each(COUNTED)("%s: generateMetadata never counts a view", (file, _o, counter) => {
    const src = read(file);
    const meta = file.endsWith("event-detail-data.ts")
      ? fnBody(src, "buildEventMetadata")
      : src.slice(
          src.indexOf("export async function generateMetadata"),
          src.indexOf("export default async function")
        );
    expect(meta.length).toBeGreaterThan(0);
    expect(meta).not.toContain(`${counter}(`);
  });
});

/**
 * OPE-790 rework (John, 2026-10-04) — a D1 platform blip that survives the retry
 * renders an honest degraded panel, not the error boundary. Only a PLATFORM
 * fault degrades: every catch re-throws anything else, so our own query defects
 * stay loud.
 */
const DEGRADED_PAGES = [
  "src/app/events/(listing)/page.tsx",
  "src/app/events/[slug]/page.tsx",
  "src/app/vendors/(listing)/page.tsx",
  "src/app/vendors/[slug]/page.tsx",
  "src/app/performers/[slug]/page.tsx",
];

describe("OPE-790 rework — degraded panel on a surviving platform blip, and only then", () => {
  it.each(DEGRADED_PAGES)(
    "%s renders DegradedPanel behind isD1PlatformFault and re-throws the rest",
    (file) => {
      // The PAGE component's branch — generateMetadata has its own (noindex) one.
      const full = read(file);
      const src = full.slice(full.indexOf("export default async function"));
      const at = src.indexOf("if (isD1PlatformFault(e))");
      expect(at, "no platform-fault branch").toBeGreaterThan(-1);
      const branch = src.slice(at, at + 260);
      expect(branch).toContain("<DegradedPanel");
      expect(branch).toContain("throw e;");
    }
  );

  it.each([
    "src/app/events/[slug]/event-detail-data.ts",
    "src/app/vendors/[slug]/page.tsx",
    "src/app/performers/[slug]/page.tsx",
  ])("%s: detail metadata returns noindex on a surviving blip", (file) => {
    expect(read(file)).toContain("if (isD1PlatformFault(e)) return DEGRADED_METADATA;");
  });
});
