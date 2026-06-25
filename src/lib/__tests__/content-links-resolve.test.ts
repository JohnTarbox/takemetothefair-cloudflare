/**
 * Integration tests for the K42/K45/K43 blog-link cluster (Bundle A,
 * 2026-06-25), run against an in-memory better-sqlite3 + drizzle instance —
 * same harness style as venue-matching-autolink.test.ts.
 *
 * Covers:
 *   - K42  — resolveContentLinkTargetIds chunks its IN(...) lookups so a
 *            100+-link body resolves instead of throwing "too many SQL
 *            variables" (the CT pillar crash).
 *   - K45  — event_slug_history-aware resolution (a renamed-event link still
 *            resolves) AND in-place re-resolution of a stored-null row when its
 *            target finally exists, with no SOURCE re-save.
 *   - K43  — findBrokenContentLinksInDb treats slug-history redirects as
 *            resolved (not broken), and repairBlogLinksForSlugChange rewrites
 *            the body slug boundary-safely.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { findBrokenContentLinksInDb, resolveContentLinkTargetIds } from "../blog-links";
import { repairBlogLinksForSlugChange, syncContentLinks } from "../content-links-sync";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    promoter_id TEXT,
    status TEXT NOT NULL DEFAULT 'APPROVED'
  );
  CREATE TABLE vendors (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
  CREATE TABLE venues (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    updated_at INTEGER
  );
  CREATE TABLE event_slug_history (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );
  CREATE TABLE content_links (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    target_id TEXT,
    created_at INTEGER,
    notified_at INTEGER
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY,
    level TEXT,
    source TEXT,
    message TEXT,
    error_message TEXT,
    stack_trace TEXT,
    status_code INTEGER,
    url TEXT,
    method TEXT,
    user_agent TEXT,
    session_id TEXT,
    context TEXT,
    created_at INTEGER
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function seedEvent(id: string, slug: string) {
  raw.prepare("INSERT INTO events (id, slug, name) VALUES (?, ?, ?)").run(id, slug, slug);
}

describe("resolveContentLinkTargetIds", () => {
  it("K42: resolves a 120-link body across IN(...) chunk boundaries", async () => {
    const refs = [];
    for (let i = 0; i < 120; i++) {
      seedEvent(`e${i}`, `ev-${i}`);
      refs.push({ targetType: "EVENT" as const, targetSlug: `ev-${i}` });
    }
    const map = await resolveContentLinkTargetIds(db as never, refs);
    expect(map.size).toBe(120);
    expect(map.get("EVENT|ev-0")).toBe("e0");
    expect(map.get("EVENT|ev-119")).toBe("e119");
  });

  it("K45: resolves a renamed-event link via event_slug_history", async () => {
    seedEvent("e1", "big-fair-2026");
    raw
      .prepare(
        "INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("h1", "e1", "big-fair", "big-fair-2026", Date.now());

    const map = await resolveContentLinkTargetIds(db as never, [
      { targetType: "EVENT", targetSlug: "big-fair" }, // old slug
    ]);
    expect(map.get("EVENT|big-fair")).toBe("e1");
  });

  it("does not resolve a slug with no live entity and no history", async () => {
    const map = await resolveContentLinkTargetIds(db as never, [
      { targetType: "EVENT", targetSlug: "ghost-fair-2026" },
    ]);
    expect(map.size).toBe(0);
  });
});

describe("findBrokenContentLinksInDb", () => {
  it("flags a truly-dead link but NOT a slug-history redirect", async () => {
    seedEvent("e1", "live-fair-2026");
    raw
      .prepare(
        "INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("h1", "e1", "live-fair", "live-fair-2026", Date.now());

    const body =
      "Live: [a](/events/live-fair-2026), redirect: [b](/events/live-fair), dead: [c](/events/never-existed)";
    const broken = await findBrokenContentLinksInDb(db as never, body);
    expect(broken).toEqual([{ targetType: "EVENT", targetSlug: "never-existed" }]);
  });
});

describe("syncContentLinks — K45 in-place null re-resolution", () => {
  it("patches a stored-null row when the target later exists, with no body change", async () => {
    // Post body links an event that didn't exist when first synced.
    const body = "Check [the fair](/events/late-fair-2026).";
    raw
      .prepare("INSERT INTO blog_posts (id, slug, body) VALUES (?, ?, ?)")
      .run("p1", "guide", body);
    // Simulate the broken row that the original save wrote (target_id NULL).
    raw
      .prepare(
        "INSERT INTO content_links (id, source_type, source_id, target_type, target_slug, target_id) VALUES (?, 'BLOG_POST', 'p1', 'EVENT', 'late-fair-2026', NULL)"
      )
      .run("cl1");

    // Now the event goes live.
    seedEvent("e1", "late-fair-2026");

    const result = await syncContentLinks(db as never, "p1", body, {
      notify: false,
      sourceSlug: "guide",
    });
    // Nothing added/removed — the row already existed, only re-resolved.
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);

    const [row] = await db
      .select()
      .from(schema.contentLinks)
      .where(eq(schema.contentLinks.id, "cl1"));
    expect(row.targetId).toBe("e1");
  });
});

describe("repairBlogLinksForSlugChange — K43 A3.3", () => {
  it("rewrites /events/old → /events/new boundary-safely and re-syncs the index", async () => {
    const body =
      "Old: /events/winthrop-fair and unrelated /events/winthrop-fair-classic stay split.";
    raw
      .prepare("INSERT INTO blog_posts (id, slug, body) VALUES (?, ?, ?)")
      .run("p1", "guide", body);
    raw
      .prepare(
        "INSERT INTO content_links (id, source_type, source_id, target_type, target_slug, target_id) VALUES (?, 'BLOG_POST', 'p1', 'EVENT', 'winthrop-fair', NULL)"
      )
      .run("cl1");
    seedEvent("e1", "winthrop-fair-2026");

    const result = await repairBlogLinksForSlugChange(
      db as never,
      "EVENT",
      "winthrop-fair",
      "winthrop-fair-2026"
    );
    expect(result.postsUpdated).toBe(1);
    expect(result.linksRewritten).toBe(1);

    const [post] = await db
      .select({ body: schema.blogPosts.body })
      .from(schema.blogPosts)
      .where(eq(schema.blogPosts.id, "p1"));
    expect(post.body).toContain("/events/winthrop-fair-2026");
    // The distinct longer slug must be untouched by the boundary-safe rewrite.
    expect(post.body).toContain("/events/winthrop-fair-classic");

    // Index re-synced: a resolved row for the new slug now exists.
    const rows = await db
      .select()
      .from(schema.contentLinks)
      .where(
        and(
          eq(schema.contentLinks.sourceId, "p1"),
          eq(schema.contentLinks.targetSlug, "winthrop-fair-2026")
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe("e1");
  });

  it("is a no-op when nothing links to the old slug", async () => {
    const result = await repairBlogLinksForSlugChange(
      db as never,
      "EVENT",
      "nobody-links-here",
      "new-slug"
    );
    expect(result).toEqual({ postsUpdated: 0, linksRewritten: 0 });
  });
});
