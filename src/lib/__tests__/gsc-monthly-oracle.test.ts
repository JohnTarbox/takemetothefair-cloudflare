/**
 * OPE-344 — parser pinned against the REAL emails, not an invented shape.
 *
 * Fixtures are the actual plaintext bodies Google sent for May, June and July
 * 2026 (trimmed to the parts that matter, with the later "Clicks (web)" column
 * headers KEPT — those are the trap this parser exists to avoid).
 */
import { describe, expect, it } from "vitest";
import {
  parseGscMonthlyOracleEmail,
  resolveOracleMonth,
  divergence,
} from "@/lib/gsc-monthly-oracle";

/** Real July body, trimmed. Note: value BEFORE label, and "Clicks (web)"
 *  reappearing four times below as a column header. */
const JULY_BODY = `Your July performance
on Google Search

meetmeatthefair.com

9.37K

Clicks (web)

398K

Impressions (web)

2.06K

Pages with
first impressions
(estimated)

Your content achievements

Top growing pages

Compared to previous month

Page

Clicks (web)

https://meetmeatthefair.com/events/boston-carnival-caribbean-festival/2026

+424

Top performing pages

Page

Clicks (web)

https://meetmeatthefair.com/events/massachusetts

387

Top performing queries

Query

Clicks (web)

cummington fair

141

Google search type

By clicks

Web

9.37K
`;

const JUNE_BODY = `Your June performance
on Google Search

meetmeatthefair.com

2.55K

Clicks (web)

126K

Impressions (web)

2.44K

Pages with
first impressions
(estimated)

Your content achievements
`;

/** May is the one with NO K-shorthand on clicks — 668, a bare integer. */
const MAY_BODY = `Your May performance
on Google Search

meetmeatthefair.com

668

Clicks (web)

40.1K

Impressions (web)

1.34K

Pages with
first impressions
(estimated)

Your content achievements
`;

describe("parseGscMonthlyOracleEmail — real emails", () => {
  it("parses the July 2026 email (the one that caught the 65% undercount)", () => {
    const r = parseGscMonthlyOracleEmail({
      subject: "Your July Search performance for meetmeatthefair.com",
      body: JULY_BODY,
      emailDate: "2026-08-04T13:02:14Z",
    });
    expect(r).toMatchObject({
      month: "2026-07",
      clicks: 9370,
      impressions: 398000,
      pagesWithFirstImpressions: 2060,
      emailDate: "2026-08-04",
    });
  });

  it("does NOT pick up a per-page number from the repeated column headers", () => {
    // "Clicks (web)" appears 4 more times below the headline block, each
    // preceded by a page-level figure (387, 141, +424). A global match would
    // return one of those as the site total — a wrong oracle is worse than none,
    // because everything else gets compared against it.
    const r = parseGscMonthlyOracleEmail({
      subject: "Your July Search performance for meetmeatthefair.com",
      body: JULY_BODY,
      emailDate: "2026-08-04T13:02:14Z",
    });
    expect(r?.clicks).toBe(9370);
    expect(r?.clicks).not.toBe(387);
    expect(r?.clicks).not.toBe(141);
  });

  it("ignores a quoted table ABOVE the headline (what block isolation is for)", () => {
    // The previous test passes even without block isolation, because `.match()`
    // returns the FIRST occurrence and today the headline happens to come first.
    // This is the case that actually needs the isolation: a forward that quotes
    // a prior table, or any future layout where the summary is not first.
    // The quoted fragment must put a NUMBER directly before the label, or the
    // regex never matches it and the test proves nothing (first attempt did
    // exactly that — "Page" preceded the label, so it fell through by accident).
    const forwarded = `---------- Forwarded message ----------

387

Clicks (web)

11

Impressions (web)

${JULY_BODY}`;
    const r = parseGscMonthlyOracleEmail({
      subject: "Fwd: Your July Search performance for meetmeatthefair.com",
      body: forwarded,
      emailDate: "2026-08-04T13:02:14Z",
    });
    expect(r?.clicks).toBe(9370);
  });

  it("parses the June 2026 email", () => {
    const r = parseGscMonthlyOracleEmail({
      subject: "Your June Search performance for meetmeatthefair.com",
      body: JUNE_BODY,
      emailDate: "2026-07-07T13:45:09Z",
    });
    expect(r).toMatchObject({ month: "2026-06", clicks: 2550, impressions: 126000 });
  });

  it("parses May 2026, where clicks carry NO K suffix", () => {
    const r = parseGscMonthlyOracleEmail({
      subject: "Your May Search performance for meetmeatthefair.com",
      body: MAY_BODY,
      emailDate: "2026-06-04T13:34:18Z",
    });
    expect(r).toMatchObject({ month: "2026-05", clicks: 668, impressions: 40100 });
  });

  it("keeps Google's verbatim tokens alongside the parsed values", () => {
    // Google ROUNDS: "9.37K" is not exactly 9,370. Keeping the source text is
    // what lets a later reader tell a parse bug from Google's own rounding.
    const r = parseGscMonthlyOracleEmail({
      subject: "Your July Search performance for meetmeatthefair.com",
      body: JULY_BODY,
      emailDate: "2026-08-04T13:02:14Z",
    });
    expect(r?.raw).toMatchObject({ clicks: "9.37K", impressions: "398K" });
  });

  it("falls back to the body heading when a forward mangles the subject", () => {
    const r = parseGscMonthlyOracleEmail({
      subject: "Fwd: (no subject)",
      body: JULY_BODY,
      emailDate: "2026-08-04T13:02:14Z",
    });
    expect(r?.month).toBe("2026-07");
  });

  it("returns null for a milestone email, so the shared endpoint can tell them apart", () => {
    expect(
      parseGscMonthlyOracleEmail({
        subject: "Congrats on reaching 3K clicks in 28 days!",
        body: "Your site reached 3K clicks in the past 28 days / Jul 4, 2026",
        emailDate: "2026-07-06",
      })
    ).toBeNull();
  });

  it("returns null rather than a half-row when a metric is missing", () => {
    // A partial parse would write something that LOOKS like an oracle reading
    // and would then be compared against.
    const r = parseGscMonthlyOracleEmail({
      subject: "Your July Search performance for meetmeatthefair.com",
      body: "Your July performance\non Google Search\n\n9.37K\n\nClicks (web)\n\nYour content achievements",
      emailDate: "2026-08-04",
    });
    expect(r).toBeNull();
  });
});

describe("resolveOracleMonth", () => {
  it("maps a month to the year the report actually covers", () => {
    expect(resolveOracleMonth("July", new Date("2026-08-04T00:00:00Z"))).toBe("2026-07");
  });

  it("rolls back a year for December's report, which arrives in January", () => {
    // The once-a-year bug: using the email's own year would file December 2026
    // under 2027. These reports always cover a month that has already ended.
    expect(resolveOracleMonth("December", new Date("2027-01-05T00:00:00Z"))).toBe("2026-12");
  });

  it("handles January's report arriving in February", () => {
    expect(resolveOracleMonth("January", new Date("2027-02-03T00:00:00Z"))).toBe("2027-01");
  });

  it("returns null for a non-month word", () => {
    expect(resolveOracleMonth("Quarterly", new Date("2026-08-04T00:00:00Z"))).toBeNull();
  });
});

describe("divergence", () => {
  it("measures the July gap that motivated this ticket", () => {
    // 3,305 stored vs 9,370 oracle — the 65% undercount.
    expect(divergence(3305, 9370)).toBeCloseTo(0.647, 2);
  });

  it("is ~0 for the post-OPE-345 property totals", () => {
    // 9,374 measured against the 9,370 oracle.
    expect(divergence(9374, 9370)).toBeLessThan(0.01);
  });

  it("treats a zero oracle with a non-zero reading as total divergence", () => {
    expect(divergence(5, 0)).toBe(1);
    expect(divergence(0, 0)).toBe(0);
  });
});
