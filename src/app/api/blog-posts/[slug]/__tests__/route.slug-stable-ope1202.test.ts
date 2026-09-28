/**
 * OPE-1202 — a PUBLISHED post's URL moves only on an explicit newSlug.
 *
 * 2026-09-28: retitling the Augusta holiday guide silently moved it to a new
 * slug; the old URL 301'd, but 7 published posts still linked it and the
 * response did not say the URL had changed. Real SQLite for the tables the
 * route writes; only the side-effecting helpers (link sync, IndexNow) are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db, getCloudflareEnv: () => ({}) }));
vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/content-links-sync", () => ({ syncContentLinks: vi.fn(async () => {}) }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => {}),
  indexNowUrlFor: () => "",
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const { PUT } = await import("../route");

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
    excerpt TEXT, author_id TEXT, tags TEXT DEFAULT '[]', categories TEXT DEFAULT '[]', faqs TEXT,
    featured_image_url TEXT, image_focal_x REAL DEFAULT 0.5, image_focal_y REAL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'DRAFT', publish_date INTEGER, meta_title TEXT, meta_description TEXT,
    view_count INTEGER DEFAULT 0, featured INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE blog_slug_history (
    id TEXT PRIMARY KEY, blog_post_id TEXT, old_slug TEXT, new_slug TEXT, changed_at INTEGER, changed_by TEXT
  );
  CREATE TABLE content_links (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL,
    target_slug TEXT NOT NULL, target_id TEXT, created_at INTEGER, notified_at INTEGER
  );
`;

function post(id: string, slug: string, status: string, title = `Post ${id}`) {
  raw
    .prepare(`INSERT INTO blog_posts (id,title,slug,body,status,created_at) VALUES (?,?,?,?,?,0)`)
    .run(id, title, slug, "body", status);
}
function link(fromId: string, toSlug: string, toId: string) {
  raw
    .prepare(
      `INSERT INTO content_links (id,source_type,source_id,target_type,target_slug,target_id,created_at) VALUES (?, 'BLOG_POST', ?, 'BLOG_POST', ?, ?, 0)`
    )
    .run(`${fromId}->${toId}`, fromId, toSlug, toId);
}
async function put(slug: string, body: Record<string, unknown>) {
  const res = await PUT(
    new NextRequest(`http://localhost/api/blog-posts/${slug}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const slugOf = (id: string) =>
  (raw.prepare(`SELECT slug FROM blog_posts WHERE id = ?`).get(id) as { slug: string }).slug;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](DDL);
  db = drizzle(raw, { schema });
  // D1 exposes db.batch (sequential, atomic); better-sqlite3's drizzle does not.
  (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (stmts) => {
    const out: unknown[] = [];
    for (const st of stmts) out.push(await st);
    return out;
  };
  post("augusta", "augusta-civic-center-holiday-craft-show-series-2026", "PUBLISHED");
  post("linker1", "maine-holiday-guide", "PUBLISHED", "Maine Holiday Guide");
  post("linker2", "draft-roundup", "DRAFT", "Draft Roundup");
  link("linker1", "augusta-civic-center-holiday-craft-show-series-2026", "augusta");
  link("linker2", "augusta-civic-center-holiday-craft-show-series-2026", "augusta");
});

describe("PUT /api/blog-posts/[slug] — OPE-1202", () => {
  it("ACCEPTANCE: renaming a PUBLISHED post keeps its slug and reports no slug change", async () => {
    const r = await put("augusta-civic-center-holiday-craft-show-series-2026", {
      title: "Augusta Holiday Craft Shows 2026: Dates, Venues and Admission for All Six Shows",
    });
    expect(r.status).toBe(200);
    expect(r.body.title).toContain("Augusta Holiday Craft Shows 2026");
    expect(slugOf("augusta")).toBe("augusta-civic-center-holiday-craft-show-series-2026");
    expect(r.body.slugChange).toBeUndefined();
    expect(raw.prepare(`SELECT COUNT(*) n FROM blog_slug_history`).get()).toEqual({ n: 0 });
  });

  it("ACCEPTANCE: an explicit newSlug moves it, returns old/new, and lists the PUBLISHED linkers", async () => {
    const r = await put("augusta-civic-center-holiday-craft-show-series-2026", {
      newSlug: "Augusta Holiday Craft Shows 2026",
    });
    expect(r.status).toBe(200);
    expect(slugOf("augusta")).toBe("augusta-holiday-craft-shows-2026");
    expect(r.body.slugChange).toEqual({
      old: "augusta-civic-center-holiday-craft-show-series-2026",
      new: "augusta-holiday-craft-shows-2026",
      linkingPublishedPosts: [{ slug: "maine-holiday-guide", title: "Maine Holiday Guide" }],
    });
    // The redirect row is still written, so the old URL 301s.
    expect(raw.prepare(`SELECT old_slug, new_slug FROM blog_slug_history`).get()).toEqual({
      old_slug: "augusta-civic-center-holiday-craft-show-series-2026",
      new_slug: "augusta-holiday-craft-shows-2026",
    });
  });

  it("a DRAFT's slug still follows its title", async () => {
    post("d", "old-draft-title", "DRAFT");
    const r = await put("old-draft-title", { title: "New Draft Title" });
    expect(slugOf("d")).toBe("new-draft-title");
    expect(r.body.slugChange?.old).toBe("old-draft-title");
  });

  it("a newSlug that normalizes to nothing is refused", async () => {
    const r = await put("augusta-civic-center-holiday-craft-show-series-2026", { newSlug: "!!!" });
    expect(r.status).toBe(400);
  });
});
