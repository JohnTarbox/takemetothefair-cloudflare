/**
 * OPE-1376 — an event with a long name still gets its related blog posts.
 *
 * The old `like(blogPosts.tags, \`%${eventName}%\`)` threw on D1 for any name
 * over ~48 characters (158 of 1,562 live events, OPE-1355), and the bare
 * `catch { return [] }` made it look like there were simply no matches. The
 * test db emulates D1's 50-char LIKE cap (local SQLite allows 50,000), so the
 * old shape is red here, not only in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { emulateD1LikeCap } from "@/test/d1-like-cap";

const logged: Array<{ message: string }> = [];
vi.mock("@/lib/logger", () => ({
  logError: vi.fn(async (_db: unknown, o: { message: string }) => void logged.push(o)),
}));

const { getCategoryMatchedBlogPosts } = await import("../category-matched-posts");

const DDL = `
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    excerpt TEXT,
    status TEXT NOT NULL,
    tags TEXT,
    categories TEXT,
    publish_date INTEGER
  );`;

// 60 characters — over D1's LIKE pattern cap once wrapped in %…%.
const LONG_NAME = "Northeast Regional Antique Tractor and Gas Engine Show 2026!";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function post(id: string, tags: string[], categories: string[] = [], status = "PUBLISHED") {
  raw
    .prepare(
      `INSERT INTO blog_posts (id, slug, title, status, tags, categories, publish_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `post-${id}`,
      `Post ${id}`,
      status,
      JSON.stringify(tags),
      JSON.stringify(categories),
      1_760_000_000
    );
}

beforeEach(() => {
  logged.length = 0;
  raw = new Database(":memory:");
  raw.exec(DDL);
  emulateD1LikeCap(raw);
  db = drizzle(raw, { schema });
});

describe("getCategoryMatchedBlogPosts", () => {
  it("the emulated D1 cap is live (landmark: the old LIKE shape would throw here)", () => {
    expect(LONG_NAME.length).toBe(60);
    post("a", ["x"]); // LIKE is only evaluated against a row
    expect(() =>
      raw.prepare("SELECT 1 FROM blog_posts WHERE tags LIKE ?").all(`%${LONG_NAME}%`)
    ).toThrow(/pattern too complex/);
  });

  it("a 60-character event name gets its tag-matched posts, and nothing is logged", async () => {
    post("a", [LONG_NAME.toLowerCase(), "tractors"]);
    post("b", ["unrelated"]);
    post("c", [LONG_NAME], [], "DRAFT");

    const rows = await getCategoryMatchedBlogPosts(db as never, LONG_NAME, [], [], 3);

    expect(rows.map((r) => r.slug)).toEqual(["post-a"]);
    expect(rows[0].kind).toBe("category");
    expect(logged).toHaveLength(0);
  });

  it("still matches on categories, case-insensitively, and honours excludeSlugs", async () => {
    post("a", ["agricultural"], []);
    post("b", [], ["Agricultural"]);
    post("c", ["agricultural"]);
    const rows = await getCategoryMatchedBlogPosts(
      db as never,
      "Some Fair",
      ["agricultural"],
      ["post-c"],
      3
    );
    expect(rows.map((r) => r.slug).sort()).toEqual(["post-a", "post-b"]);
  });

  it("a failing query degrades to [] but is LOGGED, not swallowed", async () => {
    raw.exec("DROP TABLE blog_posts");
    const rows = await getCategoryMatchedBlogPosts(db as never, "X Fair", [], [], 3);
    expect(rows).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toMatch(/category-matched blog posts/);
  });
});
