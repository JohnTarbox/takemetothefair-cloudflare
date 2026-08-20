/**
 * OPE-333 follow-up — a sitemap's `<lastmod>` must not be the render time.
 *
 * Found by running the ticket's own acceptance checks against production:
 * `If-Modified-Since` returned 304 correctly, but `If-None-Match` never did,
 * and four consecutive HEADs returned four different ETags against one stable
 * `Last-Modified`. The body was changing between identical requests.
 *
 * Cause: the `/events?page=N` and `/events/all?page=N` entries emitted
 * `new Date()`, so 84 of 3,120 `<lastmod>` values moved every request. Two
 * costs, and the second outlives the first:
 *
 *   1. a body hash that changes per request makes the ETag unmatchable
 *      forever, killing the ETag half of the conditional-GET work for the
 *      whole file;
 *   2. every crawl is told those listing pages changed seconds ago, which is
 *      untrue and trains the crawler to discount a signal that IS accurate on
 *      the other 3,036 URLs.
 *
 * Source-level because the behaviour needs a live D1 and a deployed route, and
 * because what must not regress is a specific CONSTRUCT — a render-time clock
 * reaching a lastmod field — not an output value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const APP = `${process.cwd()}/src/app`;

/** Every sitemap route file. */
function sitemapRoutes(): string[] {
  return readdirSync(APP)
    .filter((d) => d.startsWith("sitemap") && d.endsWith(".xml"))
    .map((d) => `${APP}/${d}/route.ts`);
}

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("no sitemap emits a render-time lastmod", () => {
  it("finds the sitemap routes at all", () => {
    // Guards the whole suite against going vacuously green if the directory
    // layout changes.
    expect(sitemapRoutes().length).toBeGreaterThanOrEqual(7);
  });

  for (const file of sitemapRoutes()) {
    const short = file.slice(file.indexOf("/src/app/") + 9);

    it(`${short} never assigns a bare clock to lastModified`, () => {
      const src = code(readFileSync(file, "utf8"));
      // `lastModified: now` / `lastModified: new Date()` — the exact shape that
      // shipped. Whitespace-tolerant, comment-stripped.
      expect(src).not.toMatch(/lastModified:\s*now\b/);
      expect(src).not.toMatch(/lastModified:\s*new Date\(\s*\)/);
    });
  }
});

describe("the events sitemap uses the published type lastmod for listing pages", () => {
  const src = readFileSync(`${APP}/sitemap-events.xml/route.ts`, "utf8");

  it("derives listing lastmod from getSitemapTypeLastMod", () => {
    // The same source the index publishes for this type, so a listing page and
    // the index cannot disagree about when events last changed.
    expect(code(src)).toContain('getSitemapTypeLastMod("events")');
    expect(code(src)).toMatch(/listingLastMod/);
  });

  it("both pagination loops use it", () => {
    const uses = code(src).match(/lastModified:\s*listingLastMod/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("still keeps a `now` for time-of-query predicates", () => {
    // `now` is legitimate for "is this event upcoming" — the bug was
    // conflating that with "when did this page change". Deleting it outright
    // would break the upcoming filter, so the test pins that it survives.
    expect(code(src)).toMatch(/upcomingEndPredicate\(now\)/);
  });
});
