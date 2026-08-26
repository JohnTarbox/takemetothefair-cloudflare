/**
 * OPE-567 — a GSC verdict describes the LAST CRAWL, not the page.
 *
 * `health_issues` stored Google's rich-result verdict as if it described the
 * page now. Measured 2026-08-26: of 52 `GSC_RICH_RESULT_FAIL` rows ever raised,
 * 47 had already resolved themselves as Google re-crawled — and all 5 survivors
 * were ALSO false, every one serving a valid `location` when fetched live.
 *
 * A 100% false-positive rate on the **only** ERROR-severity class the dashboard
 * has. At the time of writing, all four open ERROR rows in prod were these.
 *
 * ⚠️ The second describe block is the one that decides whether this fix is worth
 * having. A rule that downgrades everything passes the first block and is worse
 * than the noise it replaced: it would take the dashboard from "cries wolf" to
 * "says nothing". Both halves are mutation-checked separately.
 */
import { describe, it, expect } from "vitest";
import { summarizeRichResults, isVerdictStale } from "../gsc-rich-results";
import { parseEntityRef } from "../gsc-page-last-changed";

/** A FAIL block shaped like the real K46 one. */
const FAILING = {
  verdict: "FAIL",
  detectedItems: [
    {
      richResultType: "Events",
      items: [{ issues: [{ issueMessage: 'Missing field "location"', severity: "ERROR" }] }],
    },
  ],
} as never;

const CRAWLED = new Date("2026-06-23T09:44:42Z");

describe("a verdict about a page that has since changed is downgraded and ANNOTATED", () => {
  it("downgrades to INFO when the page changed after the crawl", () => {
    // The real pizza-pilsners-festival shape: crawled 06-23, row updated 06-29.
    const out = summarizeRichResults(FAILING, {
      lastCrawlTime: CRAWLED,
      pageLastChangedAt: new Date("2026-06-29T19:00:23Z"),
    });
    expect(out?.severity).toBe("INFO");
    expect(out?.staleVerdict).toBe(true);
  });

  it("still reports the row — downgraded is not suppressed", () => {
    const out = summarizeRichResults(FAILING, {
      lastCrawlTime: CRAWLED,
      pageLastChangedAt: new Date("2026-06-29T19:00:23Z"),
    });
    // `failing` stays true so the row is still raised and still visible.
    expect(out).not.toBeNull();
    expect(out?.failing).toBe(true);
  });

  it("states BOTH dates in the message, so staleness is readable without a tool call", () => {
    const out = summarizeRichResults(FAILING, {
      lastCrawlTime: CRAWLED,
      pageLastChangedAt: new Date("2026-06-29T19:00:23Z"),
    });
    expect(out?.message).toContain("STALE VERDICT");
    expect(out?.message).toContain("last crawled 2026-06-23");
    expect(out?.message).toContain("page changed 2026-06-29");
    // and it must not lose the original finding
    expect(out?.message).toContain('Missing field "location"');
  });
});

describe("⚠️ the half that keeps the rail useful — a REAL failure still reports ERROR", () => {
  it("a broken page crawled AFTER its last change is ERROR, not INFO", () => {
    const out = summarizeRichResults(FAILING, {
      lastCrawlTime: new Date("2026-08-20T00:00:00Z"),
      pageLastChangedAt: new Date("2026-06-29T00:00:00Z"),
    });
    expect(out?.severity).toBe("ERROR");
    expect(out?.staleVerdict).toBeUndefined();
    expect(out?.message).not.toContain("STALE");
  });

  it("no freshness information at all leaves the verdict at ERROR", () => {
    // The safe direction. A stale ERROR costs a re-check; a hidden live one
    // costs the thing the dashboard exists for.
    expect(summarizeRichResults(FAILING)?.severity).toBe("ERROR");
    expect(summarizeRichResults(FAILING, {})?.severity).toBe("ERROR");
  });

  it("a missing crawl time or a missing page date leaves it at ERROR", () => {
    expect(
      summarizeRichResults(FAILING, { lastCrawlTime: null, pageLastChangedAt: new Date() })
        ?.severity
    ).toBe("ERROR");
    expect(
      summarizeRichResults(FAILING, { lastCrawlTime: CRAWLED, pageLastChangedAt: null })?.severity
    ).toBe("ERROR");
  });

  it("an unparseable date leaves it at ERROR rather than NaN-comparing", () => {
    expect(
      summarizeRichResults(FAILING, {
        lastCrawlTime: new Date("nonsense"),
        pageLastChangedAt: new Date("2026-06-29T00:00:00Z"),
      })?.severity
    ).toBe("ERROR");
  });

  it("equal timestamps are NOT stale — the page did not change after the crawl", () => {
    expect(isVerdictStale({ lastCrawlTime: CRAWLED, pageLastChangedAt: CRAWLED })).toBe(false);
  });

  it("a passing rich result is still no row at all", () => {
    // The staleness rule must not accidentally start raising rows for pages
    // Google is happy with.
    const passing = { verdict: "PASS", detectedItems: [] } as never;
    expect(
      summarizeRichResults(passing, { lastCrawlTime: CRAWLED, pageLastChangedAt: new Date() })
    ).toBeNull();
  });
});

describe("parseEntityRef — which URLs can be resolved to a row at all", () => {
  it("resolves the five inspected page types", () => {
    for (const [url, seg] of [
      ["https://meetmeatthefair.com/events/pizza-pilsners-festival", "events"],
      ["https://meetmeatthefair.com/venues/some-venue", "venues"],
      ["https://meetmeatthefair.com/vendors/sea-bags", "vendors"],
      ["https://meetmeatthefair.com/promoters/jenks", "promoters"],
      ["https://meetmeatthefair.com/blog/a-post", "blog"],
    ] as const) {
      expect(parseEntityRef(url)?.segment).toBe(seg);
    }
    expect(parseEntityRef("https://meetmeatthefair.com/events/pizza-pilsners-festival")?.slug).toBe(
      "pizza-pilsners-festival"
    );
  });

  it("returns null for anything that is not a single entity page", () => {
    // Each of these would otherwise be looked up as a slug and silently miss.
    for (const url of [
      "https://meetmeatthefair.com/",
      "https://meetmeatthefair.com/events", // the listing, not an entity
      "https://meetmeatthefair.com/events/me/september", // an OPE-395 facet URL
      "https://meetmeatthefair.com/admin/analytics",
      "not a url at all",
    ]) {
      expect(parseEntityRef(url)).toBeNull();
    }
  });

  it("accepts a bare path as well as an absolute URL", () => {
    expect(parseEntityRef("/events/pizza-pilsners-festival")?.slug).toBe("pizza-pilsners-festival");
  });

  it("decodes a percent-encoded slug so the DB lookup can match", () => {
    expect(parseEntityRef("/vendors/caf%C3%A9-du-monde")?.slug).toBe("café-du-monde");
  });
});
