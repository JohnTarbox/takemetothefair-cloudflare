/**
 * OPE-1324 — golden test: the shared occurrence-URL module produces EXACTLY what
 * the hand-written copies it replaced produced. Every series is annual in this
 * step, so any difference here is an output change on a live page.
 *
 * The OLD_* functions are the pre-OPE-1324 expressions, copied verbatim from the
 * files they lived in. Fixture rows are real prod rows (D1, 2026-10-06) plus the
 * UTC/Eastern year boundary that the year rule has to get right.
 */
import { describe, it, expect } from "vitest";
import {
  eventCanonicalPath,
  occurrencePath,
  occurrenceYear,
  parseOccurrenceSegment,
  pickOccurrenceForYear,
  seriesOccurrencePath,
} from "@takemetothefair/utils";
import { canonicalEventPath } from "@/lib/sitemap/indexable-events";
import { occurrenceUrl } from "@/lib/series/series-schema-org";
import { matchConditionalRoute } from "@/lib/conditional-get";
import { parseOccurrenceYear } from "@/lib/series/occurrence-year";

const SITE_URL = "https://meetmeatthefair.com";
const sec = (s: number) => new Date(s * 1000);

/** Real prod rows (slug, series canonical_slug, start_date). */
const ROWS: Array<{ slug: string; seriesSlug: string | null; startDate: Date | null }> = [
  {
    slug: "newport-international-boat-show-2025",
    seriesSlug: "newport-international-boat-show",
    startDate: sec(1757592000),
  },
  { slug: "cheshire-fair", seriesSlug: "cheshire-fair", startDate: sec(1785412800) },
  { slug: "near-fest-xl", seriesSlug: "near-fest", startDate: sec(1790942400) },
  { slug: "fryeburg-fair-2026", seriesSlug: "fryeburg-fair", startDate: sec(1791115200) },
  { slug: "first-night-boston-2027", seriesSlug: "first-night-boston", startDate: sec(1798718400) },
  { slug: "cheshire-fair-nh-2027", seriesSlug: "cheshire-fair", startDate: sec(1816848000) },
  // Year boundary: 11:30pm Eastern on Dec 31 is already Jan 1 in UTC. The URL
  // rule is UTC; the golden test proves that did not move.
  { slug: "nye-edge", seriesSlug: "nye-series", startDate: new Date("2027-01-01T04:30:00Z") },
  { slug: "undated-member", seriesSlug: "some-series", startDate: null },
  { slug: "standalone-event", seriesSlug: null, startDate: sec(1791115200) },
  { slug: "standalone-undated", seriesSlug: null, startDate: null },
];

// ── the replaced copies, verbatim ────────────────────────────────────────────
/** src/lib/sitemap/indexable-events.ts (sitemap, gsc-sweep, event guides). */
function OLD_canonicalEventPath(row: (typeof ROWS)[number]): string {
  if (row.seriesSlug && row.startDate) {
    return `/events/${row.seriesSlug}/${new Date(row.startDate).getUTCFullYear()}`;
  }
  return `/events/${row.slug}`;
}
/** event-detail-data.ts canonical / og:url. */
function OLD_detailCanonical(row: (typeof ROWS)[number]): string {
  const occYear = row.seriesSlug && row.startDate ? new Date(row.startDate).getUTCFullYear() : null;
  return row.seriesSlug && occYear
    ? `${SITE_URL}/events/${row.seriesSlug}/${occYear}`
    : `https://meetmeatthefair.com/events/${row.slug}`;
}
/** events/[slug]/page.tsx ask-about canonical. */
function OLD_askAbout(row: (typeof ROWS)[number]): string {
  return row.seriesSlug && row.startDate
    ? `${SITE_URL}/events/${row.seriesSlug}/${new Date(row.startDate).getUTCFullYear()}`
    : `${SITE_URL}/events/${row.slug}`;
}
/** middleware event-slug → occurrence 301 target (null = no redirect). */
function OLD_middleware301(row: (typeof ROWS)[number]): string | null {
  if (row.seriesSlug && row.startDate && row.slug !== row.seriesSlug) {
    const year = new Date(row.startDate).getUTCFullYear();
    return `/events/${row.seriesSlug}/${year}`;
  }
  return null;
}
/** conditional-get / middleware / own-event-url year-segment test. */
const OLD_isYearSegment = (seg: string) => /^\d{4}$/.test(seg);
/** occurrence-year.ts parseOccurrenceYear. */
function OLD_parseOccurrenceYear(yearStr: string): number | null {
  const year = Number.parseInt(yearStr, 10);
  return Number.isInteger(year) && String(year) === yearStr ? year : null;
}

// ── new equivalents (what the rewired call sites now compute) ────────────────
const NEW_detailCanonical = (row: (typeof ROWS)[number]) => {
  const p = row.seriesSlug ? occurrencePath(row.seriesSlug, row.startDate) : null;
  return p ? `${SITE_URL}${p}` : `https://meetmeatthefair.com/events/${row.slug}`;
};
const NEW_askAbout = (row: (typeof ROWS)[number]) => {
  const p = row.seriesSlug ? occurrencePath(row.seriesSlug, row.startDate) : null;
  return p ? `${SITE_URL}${p}` : `${SITE_URL}/events/${row.slug}`;
};
const NEW_middleware301 = (row: (typeof ROWS)[number]) =>
  row.seriesSlug && row.slug !== row.seriesSlug
    ? occurrencePath(row.seriesSlug, row.startDate)
    : null;

describe("OPE-1324 golden — every builder is byte-for-byte unchanged", () => {
  for (const row of ROWS) {
    it(`${row.slug}`, () => {
      // OPE-1326 — every series here is annual: the edition inputs are what an
      // unflagged prod row carries, and must change nothing.
      expect(canonicalEventPath({ ...row, editionMode: "annual", editionKey: null })).toBe(
        OLD_canonicalEventPath(row)
      );
      expect(eventCanonicalPath(row)).toBe(OLD_canonicalEventPath(row));
      expect(NEW_detailCanonical(row)).toBe(OLD_detailCanonical(row));
      expect(NEW_askAbout(row)).toBe(OLD_askAbout(row));
      expect(NEW_middleware301(row)).toBe(OLD_middleware301(row));
      const year = row.startDate ? new Date(row.startDate).getUTCFullYear() : null;
      expect(occurrenceYear(row.startDate)).toBe(year);
      if (row.seriesSlug) {
        // JSON-LD subEvent url (series-schema-org occurrenceUrl).
        expect(occurrenceUrl(row.seriesSlug, year, row.slug, null)).toBe(
          year === null
            ? `${SITE_URL}/events/${row.slug}`
            : `${SITE_URL}/events/${row.seriesSlug}/${year}`
        );
      }
    });
  }

  it("the UTC boundary row is still the UTC year (2027), not Eastern (2026)", () => {
    expect(eventCanonicalPath(ROWS[6])).toBe("/events/nye-series/2027");
  });

  it("seriesOccurrencePath is the single template", () => {
    expect(seriesOccurrencePath("near-fest", 2026)).toBe("/events/near-fest/2026");
    expect(seriesOccurrencePath("near-fest", "2026")).toBe("/events/near-fest/2026");
  });
});

describe("OPE-1324 golden — parsers agree on every 4-digit segment", () => {
  const segments = ["2026", "2027", "1999", "0999", "0000", "9999"];
  for (const seg of segments) {
    it(`"${seg}"`, () => {
      const old = OLD_isYearSegment(seg) ? OLD_parseOccurrenceYear(seg) : null;
      const parsed = parseOccurrenceSegment(seg);
      expect(parsed?.kind === "year" ? parsed.year : null).toBe(old);
      expect(parseOccurrenceYear(seg)).toBe(old);
    });
  }

  it("non-year segments never match (vendors subroute, facets, partial years)", () => {
    for (const seg of ["vendors", "maine", "craft-fairs", "26", "20266", "2026.0", ""]) {
      expect(parseOccurrenceSegment(seg)).toBeNull();
    }
  });

  // OPE-1326 — "2026-05" was in the list above in step 1. It is now, by design,
  // an EDITION KEY: it parses, but never as a year, so no year-based caller can
  // read it as 2026.
  it("an edition-key-shaped segment parses as an edition, never as a year", () => {
    expect(parseOccurrenceSegment("2026-05")).toEqual({ kind: "edition", key: "2026-05" });
    expect(parseOccurrenceYear("2026-05")).toBeNull();
  });

  it("the ETag route matcher output is unchanged", () => {
    expect(matchConditionalRoute("/events/near-fest/2026")).toEqual({
      type: "event-occurrence",
      slug: "near-fest",
      segment: "2026",
    });
    expect(matchConditionalRoute("/events/fryeburg-fair/vendors")).toBeNull();
    expect(matchConditionalRoute("/events/near-fest")).toEqual({
      type: "event",
      slug: "near-fest",
    });
  });
});

describe("OPE-1324 — stable pick for two same-year members", () => {
  const a = { id: "b-id", startDate: new Date("2027-10-02T12:00:00Z"), slug: "oct" };
  const b = { id: "a-id", startDate: new Date("2027-05-01T12:00:00Z"), slug: "may" };
  const c = { id: "c-id", startDate: new Date("2027-05-01T12:00:00Z"), slug: "may-tie" };

  it("earliest start wins, whatever order the query returned", () => {
    expect(pickOccurrenceForYear([a, b], 2027)?.slug).toBe("may");
    expect(pickOccurrenceForYear([b, a], 2027)?.slug).toBe("may");
  });

  it("a start-time tie breaks on the lower id", () => {
    expect(pickOccurrenceForYear([c, b], 2027)?.slug).toBe("may");
    expect(pickOccurrenceForYear([b, c], 2027)?.slug).toBe("may");
  });

  it("undated rows and other years are ignored", () => {
    expect(pickOccurrenceForYear([{ id: "x", startDate: null }], 2027)).toBeUndefined();
    expect(pickOccurrenceForYear([a], 2026)).toBeUndefined();
  });
});
