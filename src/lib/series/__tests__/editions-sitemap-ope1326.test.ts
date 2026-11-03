/**
 * OPE-1326 — section-7 invariants on the SITEMAP side, against a flagged series
 * holding two same-year editions plus an annual series:
 *
 *   - canonical == sitemap URL, for every edition
 *   - the sitemap has no duplicates and no 3xx members
 *   - the hub canonical is in the sitemap
 *
 * Every function here is the one production calls (no re-implementation): the
 * sitemap's `collectCanonicalEventPaths`/`canonicalEventPath`, the hub's
 * `seriesHubCanonicalPath`, and the shared `resolveOccurrence` that the
 * middleware uses to decide a 301.
 */
import { describe, it, expect } from "vitest";
import { occurrencePath, parseOccurrenceSegment, resolveOccurrence } from "@takemetothefair/utils";
import {
  canonicalEventPath,
  collectCanonicalEventPaths,
  type IndexableEventRow,
} from "@/lib/sitemap/indexable-events";
import { seriesHubCanonicalPath } from "@/lib/series/occurrence-view";

const NOW = new Date("2026-11-01T12:00:00Z");
const d = (iso: string) => new Date(iso);

const row = (
  slug: string,
  seriesSlug: string | null,
  start: string,
  editionMode: string | null,
  editionKey: string | null
): IndexableEventRow => ({
  slug,
  seriesSlug,
  startDate: d(start),
  endDate: d(start),
  updatedAt: null,
  editionMode,
  editionKey,
});

const ROWS: IndexableEventRow[] = [
  row("near-fest-xl", "near-fest", "2026-10-02T12:00:00Z", "multi", "2026-10"),
  row("near-fest-xli", "near-fest", "2027-05-15T12:00:00Z", "multi", "2027-05"),
  row("near-fest-xlii", "near-fest", "2027-10-01T12:00:00Z", "multi", "2027-10"),
  row("fryeburg-fair-2026", "fryeburg-fair", "2026-10-04T12:00:00Z", "annual", null),
  row("fryeburg-fair-2027", "fryeburg-fair", "2027-10-03T12:00:00Z", "annual", null),
  row("one-off", null, "2027-06-01T12:00:00Z", null, null),
];

const occurrencesOf = (seriesSlug: string) =>
  ROWS.filter((r) => r.seriesSlug === seriesSlug).map((r, i) => ({
    id: String(i),
    slug: r.slug,
    name: r.slug,
    startDate: r.startDate,
    endDate: r.endDate,
    editionKey: r.editionKey,
  }));

const sitemap = collectCanonicalEventPaths(ROWS);

describe("OPE-1326 — sitemap ↔ canonical ↔ redirects, with two same-year editions", () => {
  it("lists every edition at its own URL (no duplicate collapsed the two 2027 editions)", () => {
    const occPaths = ROWS.filter((r) => r.seriesSlug).map(canonicalEventPath);
    expect(occPaths.length).toBe(5); // landmark
    expect(new Set(occPaths).size).toBe(occPaths.length);
    expect(sitemap).toContain("/events/near-fest/2027-05");
    expect(sitemap).toContain("/events/near-fest/2027-10");
    expect(sitemap).not.toContain("/events/near-fest/2027"); // a year URL on a flagged series 301s
  });

  it("canonical (detail-page builder) == sitemap URL, for every row", () => {
    for (const r of ROWS) {
      const detail = r.seriesSlug
        ? occurrencePath(r.seriesSlug, r.startDate, {
            editionMode: r.editionMode,
            editionKey: r.editionKey,
          })
        : `/events/${r.slug}`;
      expect(sitemap, r.slug).toContain(detail);
      expect(canonicalEventPath(r)).toBe(detail);
    }
  });

  it("no sitemap member is a redirect: every occurrence URL resolves to RENDER", () => {
    const occMembers = [...sitemap].filter((p) => p.split("/").length === 4);
    expect(occMembers.length).toBe(5); // landmark: the check examined every occurrence URL
    for (const p of occMembers) {
      const [, , seriesSlug, seg] = p.split("/");
      const mode = ROWS.find((r) => r.seriesSlug === seriesSlug)!.editionMode;
      const res = resolveOccurrence(
        seriesSlug,
        mode,
        occurrencesOf(seriesSlug),
        parseOccurrenceSegment(seg)!
      );
      expect(res?.action, p).toBe("render");
    }
  });

  it("the hub canonical is in the sitemap — for the flagged series AND the annual one", () => {
    for (const [slug, mode] of [
      ["near-fest", "multi"],
      ["fryeburg-fair", "annual"],
    ] as const) {
      const hub = seriesHubCanonicalPath(slug, occurrencesOf(slug), NOW, mode);
      expect(sitemap, slug).toContain(hub);
    }
    // NOW is after October 2026 → the hero is the next edition, May 2027.
    expect(seriesHubCanonicalPath("near-fest", occurrencesOf("near-fest"), NOW, "multi")).toBe(
      "/events/near-fest/2027-05"
    );
  });
});
