/**
 * OPE-541 — `venue_id IS NULL` has two causes and they were indistinguishable.
 *
 * Event `25c9c493` ("Crafters Care Events - Fall Fest 2026", 2026-08-24) was
 * stored with `venue_id = NULL` while its own description reads:
 *
 *     …at Doody's Totoket Inn Restaurant…
 *     📍 Location: 465 Foxon Rd, North Branford, CT 06471
 *
 * and no venue row for Doody's / Totoket / North Branford CT exists at all.
 *
 * Two completely different causes produce that identical row:
 *
 *   (a) the extractor produced no `venueName`, so the `if (!resolvedVenueId
 *       && data.venueName)` branch never runs and autoLinkVenue is never
 *       called;
 *   (b) a `venueName` WAS supplied and autoLinkVenue returned `no-match` —
 *       it matches only and NEVER creates (`venue-matching.ts` contains no
 *       `insert(venues)`), so a venue we have never seen cannot resolve.
 *
 * `result.decision` is the single value that separates them, and the route
 * computed it and threw it away. These tests pin that it is now recorded, and
 * that the record distinguishes "never attempted" from "attempted and
 * declined" — the distinction the OPE-531 minting question turns on.
 *
 * Source-level assertions: the route is a Next handler with D1, auth,
 * Turnstile and rate-limit dependencies, and the behaviour under test is
 * wiring rather than computation. The decision VALUES come from
 * autoLinkVenue, which has its own tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cwd-relative rather than import.meta.url: the app's vitest environment does
// not expose a file:// module URL (the mcp-server one does), so
// fileURLToPath throws "The URL must be of scheme file" at collection time.
const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
  "utf8"
);
const MATCHER = readFileSync(join(process.cwd(), "src/lib/venue-matching.ts"), "utf8");

describe("autoLinkVenue's contract, pinned", () => {
  it("never creates a venue row — the premise the whole ticket rests on", () => {
    // If this ever gains an insert, cause (b) stops being structural and this
    // ticket's conclusion needs revisiting. Worth failing loudly on.
    expect(MATCHER).not.toContain("insert(venues)");
  });

  it("still reports a decision for every outcome", () => {
    for (const d of ["no-name", "ambiguous", "no-match"]) {
      expect(MATCHER).toContain(`decision: "${d}"`);
    }
  });
});

describe("the route records how the venue resolved", () => {
  it("captures the decision instead of discarding it", () => {
    expect(ROUTE).toContain("venueDecision = result.decision");
  });

  it("distinguishes 'never attempted' from 'attempted and declined'", () => {
    // The whole point. A single `venue_id IS NULL` cannot tell cause (a) from
    // cause (b); a default of "not-attempted-no-venue-name" can.
    expect(ROUTE).toContain('"not-attempted-no-venue-name"');
  });

  it("records which venue inputs the extractor actually supplied", () => {
    // Cause (a) is precisely "these were absent". Without them, a `no-match`
    // and a never-attempted are still the same row one field further on.
    const logIdx = ROUTE.indexOf("venue-resolution");
    expect(logIdx).toBeGreaterThan(-1);
    const block = ROUTE.slice(logIdx, ROUTE.indexOf("recomputeEventCompleteness", logIdx));
    expect(block).toContain("venue_name_supplied");
    expect(block).toContain("venue_address_supplied");
    expect(block).toContain("venue_city_supplied");
    expect(block).toContain("venue_state_supplied");
  });

  it("logs on SUCCESS too, not only on failure", () => {
    // A record that exists only when resolution fails cannot measure a rate,
    // and OPE-531's open question ("should ingest mint venues from prose?")
    // is a question about a rate.
    const logIdx = ROUTE.indexOf("venue-resolution");
    const block = ROUTE.slice(logIdx, ROUTE.indexOf("recomputeEventCompleteness", logIdx));
    expect(block).toContain("resolved: resolvedVenueId !== null");
    // Not wrapped in an `if (!resolvedVenueId)`.
    const beforeLog = ROUTE.slice(ROUTE.indexOf("await logError", logIdx - 400), logIdx);
    expect(beforeLog).not.toMatch(/if\s*\(\s*!resolvedVenueId\s*\)\s*\{\s*$/);
  });

  it("is fail-soft — losing the record must not cost the submission", () => {
    const logIdx = ROUTE.indexOf("venue-resolution");
    const block = ROUTE.slice(logIdx, ROUTE.indexOf("recomputeEventCompleteness", logIdx));
    expect(block).toContain(".catch(()");
  });

  it("logs at info level, not as an error", () => {
    // A resolved venue is the normal case; emitting it as an error would
    // bury the genuine reds this same table is read for.
    const logIdx = ROUTE.indexOf("venue-resolution");
    const block = ROUTE.slice(Math.max(0, logIdx - 200), logIdx + 200);
    expect(block).toContain('level: "info"');
  });
});
