/**
 * OPE-79 — /admin/blog coverage loader must stay correct past D1's 100-bound-
 * parameter cap. Before the fix, `inArray(<all post ids>)` (114 params) threw
 * "too many SQL variables" and crashed the page's render on every load. These
 * tests seed >100 posts (the exact trigger) and assert the chunked loader
 * returns every row with correct per-post link counts + coverage state, without
 * throwing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { loadBlogCoverageRows, blogClusterRollup } from "../blog-coverage";

// Minimal shapes of only the columns the loader reads.
const SCHEMA_SQL = `
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    publish_date INTEGER,
    faqs TEXT,
    body TEXT,
    tags TEXT
  );
  CREATE TABLE content_links (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL
  );
  CREATE TABLE gsc_inspection_state (
    url TEXT PRIMARY KEY,
    last_verdict TEXT,
    last_coverage_state TEXT
  );
  CREATE TABLE bing_inspection_state (
    url TEXT PRIMARY KEY,
    is_indexed INTEGER,
    last_crawled INTEGER,
    crawl_error TEXT,
    last_checked_at INTEGER
  );
  CREATE TABLE gsc_search_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    query TEXT NOT NULL,
    page TEXT NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    ctr REAL NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

function seedPost(id: string, slug: string, status = "PUBLISHED", tags: string | null = null) {
  raw
    .prepare(
      `INSERT INTO blog_posts (id, slug, title, status, publish_date, faqs, body, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, slug, `Title ${slug}`, status, 1_700_000_000, null, "body text", tags);
}
function seedLink(id: string, sourceId: string, targetType: string) {
  raw
    .prepare(`INSERT INTO content_links (id, source_id, target_type) VALUES (?, ?, ?)`)
    .run(id, sourceId, targetType);
}
function seedMetric(page: string, date: string, clicks: number, impressions: number) {
  raw
    .prepare(
      `INSERT INTO gsc_search_metrics (date, query, page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(date, `q-${clicks}-${impressions}`, page, clicks, impressions, 0, 0);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("loadBlogCoverageRows — D1 100-param cap (OPE-79)", () => {
  it("returns every row for a >100-post corpus without throwing", async () => {
    for (let i = 0; i < 150; i++) seedPost(`p${i}`, `post-${i}`);
    const rows = await loadBlogCoverageRows(db);
    expect(rows).toHaveLength(150);
  });

  it("computes per-post link counts correctly, including posts beyond the first chunk", async () => {
    for (let i = 0; i < 150; i++) seedPost(`p${i}`, `post-${i}`);
    // Post 3 (first chunk): 3 EVENT + 2 VENDOR + 1 VENUE + 1 BLOG_POST.
    seedLink("l1", "p3", "EVENT");
    seedLink("l2", "p3", "EVENT");
    seedLink("l3", "p3", "EVENT");
    seedLink("l4", "p3", "VENDOR");
    seedLink("l5", "p3", "VENDOR");
    seedLink("l6", "p3", "VENUE");
    seedLink("l7", "p3", "BLOG_POST");
    // Post 149 (SECOND chunk, index > 90): proves the chunk boundary merges.
    seedLink("l8", "p149", "EVENT");
    seedLink("l9", "p149", "VENDOR");

    const rows = await loadBlogCoverageRows(db);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const p3 = byId.get("p3")!;
    expect(p3.eventLinks).toBe(3);
    expect(p3.vendorLinks).toBe(2);
    expect(p3.venueLinks).toBe(1);
    expect(p3.blogLinks).toBe(1);
    expect(p3.totalLinks).toBe(7);

    const p149 = byId.get("p149")!;
    expect(p149.eventLinks).toBe(1);
    expect(p149.vendorLinks).toBe(1);
    expect(p149.totalLinks).toBe(2);

    // A post with no links reports zeros, not undefined.
    expect(byId.get("p10")!.totalLinks).toBe(0);
  });

  it("maps GSC coverage state through for posts past the cap", async () => {
    for (let i = 0; i < 120; i++) seedPost(`p${i}`, `post-${i}`);
    raw
      .prepare(
        `INSERT INTO gsc_inspection_state (url, last_verdict, last_coverage_state) VALUES (?, ?, ?)`
      )
      .run("https://meetmeatthefair.com/blog/post-118", "PASS", "Submitted and indexed");

    const rows = await loadBlogCoverageRows(db);
    const p118 = rows.find((r) => r.slug === "post-118")!;
    expect(p118.coverageState).toBe("Submitted and indexed");
  });

  it("maps Bing inspection state through for posts past the cap (OPE-91)", async () => {
    for (let i = 0; i < 120; i++) seedPost(`p${i}`, `post-${i}`);
    raw
      .prepare(
        `INSERT INTO bing_inspection_state (url, is_indexed, last_crawled, crawl_error, last_checked_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("https://meetmeatthefair.com/blog/post-119", 1, 1_700_000_000, null, 1_700_000_500);

    const rows = await loadBlogCoverageRows(db);
    const p119 = rows.find((r) => r.slug === "post-119")!;
    expect(p119.bingIndexed).toBe(true);
    expect(p119.bingLastCrawled).toBe(1_700_000_000 * 1000);
    // A post with no bing row reports null, not undefined.
    expect(rows.find((r) => r.slug === "post-10")!.bingIndexed).toBeNull();
  });

  it("returns [] on an empty corpus", async () => {
    const rows = await loadBlogCoverageRows(db);
    expect(rows).toEqual([]);
  });

  it("OPE-107: suppresses a Bing last_crawled earlier than the post's publish date (impossible → null)", async () => {
    // seedPost stores publish_date = 1_700_000_000 for every post.
    seedPost("stale", "post-stale");
    seedPost("fresh", "post-fresh");
    const ins = raw.prepare(
      `INSERT INTO bing_inspection_state (url, is_indexed, last_crawled, crawl_error, last_checked_at) VALUES (?, ?, ?, ?, ?)`
    );
    // Impossible: crawled a year BEFORE publish → suppressed.
    ins.run("https://meetmeatthefair.com/blog/post-stale", 1, 1_668_464_000, null, 1_700_000_500);
    // Plausible: crawled AFTER publish → kept.
    ins.run("https://meetmeatthefair.com/blog/post-fresh", 1, 1_800_000_000, null, 1_700_000_500);

    const rows = await loadBlogCoverageRows(db);
    expect(rows.find((r) => r.slug === "post-stale")!.bingLastCrawled).toBeNull();
    // isIndexed is still reported — only the impossible crawl DATE is suppressed.
    expect(rows.find((r) => r.slug === "post-stale")!.bingIndexed).toBe(true);
    expect(rows.find((r) => r.slug === "post-fresh")!.bingLastCrawled).toBe(1_800_000_000 * 1000);
  });
});

describe("loadBlogCoverageRows — GSC reach (Pass 5, OPE-96)", () => {
  it("sums clicks/impressions per post and recomputes CTR from totals", async () => {
    for (let i = 0; i < 120; i++) seedPost(`p${i}`, `post-${i}`);
    const url = "https://meetmeatthefair.com/blog/post-118"; // second chunk
    // Two in-window query rows for the same page — must SUM, not average CTR.
    seedMetric(url, today(), 8, 100);
    seedMetric(url, today(), 2, 100);

    const rows = await loadBlogCoverageRows(db);
    const p118 = rows.find((r) => r.slug === "post-118")!;
    expect(p118.clicks).toBe(10);
    expect(p118.impressions).toBe(200);
    // 10/200 = 0.05, NOT the average of the two per-row ctrs.
    expect(p118.ctr).toBeCloseTo(0.05, 6);
    // A post with no metric rows reports zeros and ctr 0 (not NaN).
    const p10 = rows.find((r) => r.slug === "post-10")!;
    expect(p10.clicks).toBe(0);
    expect(p10.impressions).toBe(0);
    expect(p10.ctr).toBe(0);
  });

  it("excludes rows outside the rolling date window", async () => {
    seedPost("p0", "post-0");
    const url = "https://meetmeatthefair.com/blog/post-0";
    seedMetric(url, today(), 5, 50); // in window
    seedMetric(url, "2000-01-01", 99, 990); // far outside window

    const rows = await loadBlogCoverageRows(db);
    expect(rows[0].clicks).toBe(5);
    expect(rows[0].impressions).toBe(50);
  });
});

describe("blog clusters + rollup (OPE-96)", () => {
  it("classifies posts and reports ageWeeks/cluster on each row", async () => {
    seedPost("g", "gun-shows-new-england");
    seedPost("b", "maine-breweries-guide");
    seedPost("o", "something-unclassifiable");

    const rows = await loadBlogCoverageRows(db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("g")!.cluster).toBe("Gun shows");
    expect(byId.get("b")!.cluster).toBe("Breweries & beer");
    expect(byId.get("o")!.cluster).toBe("Other / general");
    // publish_date is a fixed past timestamp → mature (non-null, large age).
    expect(byId.get("g")!.ageWeeks).toBeGreaterThan(10);
  });

  it("rolls up per cluster: posts, clicks, clicks/post, impressions, internal links", async () => {
    seedPost("g1", "gun-shows-nh");
    seedPost("g2", "gun-shows-maine");
    seedPost("b1", "vermont-breweries");
    // Gun cluster: 82 + 4 clicks across 2 posts; internal links exclude blog→blog.
    seedMetric("https://meetmeatthefair.com/blog/gun-shows-nh", today(), 82, 1000);
    seedMetric("https://meetmeatthefair.com/blog/gun-shows-maine", today(), 4, 60);
    seedLink("l1", "g1", "EVENT");
    seedLink("l2", "g1", "VENDOR");
    seedLink("l3", "g1", "BLOG_POST"); // must NOT count toward internalLinks
    seedLink("l4", "b1", "VENDOR");

    const rows = await loadBlogCoverageRows(db);
    const rollup = blogClusterRollup(rows);
    // Sorted clicks desc — Gun shows first.
    expect(rollup[0].cluster).toBe("Gun shows");
    expect(rollup[0].posts).toBe(2);
    expect(rollup[0].clicks).toBe(86);
    expect(rollup[0].clicksPerPost).toBeCloseTo(43, 6);
    expect(rollup[0].impressions).toBe(1060);
    expect(rollup[0].internalLinks).toBe(2); // EVENT + VENDOR, not the BLOG_POST link

    const beer = rollup.find((c) => c.cluster === "Breweries & beer")!;
    expect(beer.internalLinks).toBe(1);
    expect(beer.clicks).toBe(0);
  });
});
