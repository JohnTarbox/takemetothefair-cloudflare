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
import { loadBlogCoverageRows } from "../blog-coverage";

// Minimal shapes of only the columns the loader reads.
const SCHEMA_SQL = `
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    publish_date INTEGER,
    faqs TEXT,
    body TEXT
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
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

function seedPost(id: string, slug: string, status = "PUBLISHED") {
  raw
    .prepare(
      `INSERT INTO blog_posts (id, slug, title, status, publish_date, faqs, body) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, slug, `Title ${slug}`, status, 1_700_000_000, null, "body text");
}
function seedLink(id: string, sourceId: string, targetType: string) {
  raw
    .prepare(`INSERT INTO content_links (id, source_id, target_type) VALUES (?, ?, ?)`)
    .run(id, sourceId, targetType);
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

  it("returns [] on an empty corpus", async () => {
    const rows = await loadBlogCoverageRows(db);
    expect(rows).toEqual([]);
  });
});
