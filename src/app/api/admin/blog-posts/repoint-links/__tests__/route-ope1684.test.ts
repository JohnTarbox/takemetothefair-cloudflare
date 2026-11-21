/**
 * OPE-1684 — POST /api/admin/blog-posts/repoint-links: the guards, the dry run
 * and a real run, on the pilot's own slugs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT, promoter_id TEXT, status TEXT, updated_at INTEGER);
  CREATE TABLE vendors (id TEXT PRIMARY KEY, slug TEXT NOT NULL, updated_at INTEGER);
  CREATE TABLE venues (id TEXT PRIMARY KEY, slug TEXT NOT NULL, updated_at INTEGER);
  CREATE TABLE event_slug_history (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, old_slug TEXT NOT NULL, new_slug TEXT NOT NULL, changed_at INTEGER, changed_by TEXT);
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, body TEXT,
    status TEXT NOT NULL DEFAULT 'PUBLISHED', tags TEXT, categories TEXT, faqs TEXT, updated_at INTEGER
  );
  CREATE TABLE blog_slug_history (id TEXT PRIMARY KEY, blog_post_id TEXT NOT NULL, old_slug TEXT NOT NULL, new_slug TEXT NOT NULL, changed_at INTEGER NOT NULL, changed_by TEXT);
  CREATE TABLE content_links (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
    target_type TEXT NOT NULL, target_slug TEXT NOT NULL, target_id TEXT,
    created_at INTEGER, notified_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
let authorized = true;

vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => authorized }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const { POST } = await import("../route");

const OLD = "your-complete-guide-to-maine-fairs-and-festivals-in-2026";
const NEW = "maine-fairs-and-festivals";

const post = async (body: unknown) => {
  const res = await POST(
    new Request("http://x/api/admin/blog-posts/repoint-links", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const LINKERS = 18;

beforeEach(() => {
  authorized = true;
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(
      "INSERT INTO blog_posts (id, slug, title, body, status, tags, categories, faqs, updated_at) VALUES ('target', ?, 'Maine guide', 'x', 'PUBLISHED', '[]', '[]', NULL, 1000)"
    )
    .run(NEW);
  raw
    .prepare(
      "INSERT INTO blog_slug_history (id, blog_post_id, old_slug, new_slug, changed_at) VALUES ('h1','target',?,?,1000)"
    )
    .run(OLD, NEW);
  // The pilot's shape: 18 published posts linking the old slug.
  for (let i = 0; i < LINKERS; i++) {
    raw
      .prepare(
        'INSERT INTO blog_posts (id, slug, title, body, status, tags, categories, faqs, updated_at) VALUES (?, ?, ?, ?, \'PUBLISHED\', \'["maine"]\', \'["guides"]\', \'[{"question":"q","answer":"a"}]\', 1000)'
      )
      .run(`p${i}`, `post-${i}`, `Post ${i}`, `Read [the Maine guide](/blog/${OLD}) today.`);
    raw
      .prepare(
        "INSERT INTO content_links (id, source_type, source_id, target_type, target_slug, target_id) VALUES (?, 'BLOG_POST', ?, 'BLOG_POST', ?, 'target')"
      )
      .run(`cl${i}`, `p${i}`, OLD);
  }
});

const oldRowsFromPublished = () =>
  (
    raw
      .prepare(
        "SELECT count(*) n FROM content_links c JOIN blog_posts b ON b.id=c.source_id WHERE b.status='PUBLISHED' AND c.target_slug=?"
      )
      .get(OLD) as { n: number }
  ).n;

describe("OPE-1684 — repoint-links route", () => {
  it("refuses without auth", async () => {
    authorized = false;
    expect((await post({ fromSlug: OLD, toSlug: NEW })).status).toBe(401);
  });

  it("refuses a to_slug that is not a blog post, and a from_slug that is still live", async () => {
    const missing = await post({ fromSlug: OLD, toSlug: "no-such-post", dryRun: false });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("to_slug_not_found");
    raw.prepare("INSERT INTO blog_posts (id, slug, body) VALUES ('live', 'live-post', 'y')").run();
    const live = await post({ fromSlug: "live-post", toSlug: NEW, dryRun: false });
    expect(live.status).toBe(409);
    expect(live.json.error).toBe("from_slug_is_live");
    expect(oldRowsFromPublished()).toBe(LINKERS); // nothing moved
  });

  it("defaults to a dry run that writes nothing", async () => {
    const snapshot = raw.prepare("SELECT id, body, updated_at FROM blog_posts ORDER BY id").all();
    const r = await post({ fromSlug: OLD, toSlug: NEW });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      dryRun: true,
      postsPlanned: LINKERS,
      postsUpdated: 0,
      linksRewritten: LINKERS,
      redirectOnRecord: true,
      errors: 0,
    });
    expect(raw.prepare("SELECT id, body, updated_at FROM blog_posts ORDER BY id").all()).toEqual(
      snapshot
    );
    expect(oldRowsFromPublished()).toBe(LINKERS);
  });

  it("acceptance: a real run leaves 0 published content_links on the old slug; fields, status and slug history untouched", async () => {
    expect(oldRowsFromPublished()).toBe(LINKERS); // positive landmark: 18 before
    const r = await post({ fromSlug: OLD, toSlug: NEW, dryRun: false });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: false, postsUpdated: LINKERS, linksRewritten: LINKERS });
    expect(oldRowsFromPublished()).toBe(0);
    const rows = raw
      .prepare(
        "SELECT slug, title, body, status, tags, categories, faqs, updated_at FROM blog_posts WHERE id LIKE 'p%' ORDER BY id"
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(LINKERS);
    for (const p of rows) {
      expect(p.body).toBe(`Read [the Maine guide](/blog/${NEW}) today.`);
      expect(p).toMatchObject({
        status: "PUBLISHED",
        tags: '["maine"]',
        categories: '["guides"]',
        faqs: '[{"question":"q","answer":"a"}]',
      });
      expect(p.updated_at).not.toBe(1000);
    }
    expect(
      raw.prepare("SELECT blog_post_id, old_slug, new_slug FROM blog_slug_history").all()
    ).toEqual([{ blog_post_id: "target", old_slug: OLD, new_slug: NEW }]);
  });
});
