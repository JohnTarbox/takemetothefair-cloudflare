/**
 * OPE-1573 — /blog public index served from one cached published set.
 *   1. blogPostMatchesTag is the SAME predicate as the SQL it replaced
 *      (containsCI(tags, '"<tag>"')), checked against real SQLite.
 *   2. selectBlogIndexPage paginates and counts like LIMIT/OFFSET + count(*).
 *   3. The page keys the cache on a constant, never on the URL's tag.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOG_INDEX_CACHE_KEY,
  blogPostMatchesTag,
  selectBlogIndexPage,
  type CachedBlogIndexPost,
} from "../index-cache";

function post(id: string, tags: string | null): CachedBlogIndexPost {
  return {
    id,
    title: `Post ${id}`,
    slug: `post-${id}`,
    excerpt: null,
    authorName: null,
    tags,
    categories: null,
    featuredImageUrl: null,
    status: "PUBLISHED",
    publishDate: null,
  };
}

const POSTS: CachedBlogIndexPost[] = [
  post("a", '["Maine","Craft Fairs"]'),
  post("b", '["maine"]'),
  post("c", '["Maine Fairs"]'), // "Maine" is a substring but not a whole quoted tag
  post("d", null),
  post("e", '["Fête","Québec"]'), // non-ASCII: SQLite lower() leaves É alone
  post("h", '["FÊTE"]'),
  post("f", '["Say \\"Hi\\""]'),
  post("g", "[]"),
];

const TAGS = [
  "Maine",
  "MAINE",
  "maine",
  "Craft Fairs",
  "Fête",
  "FÊTE",
  "québec",
  'Say "Hi"',
  "",
  "x",
];

describe("blogPostMatchesTag — parity with the SQL containsCI predicate", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE blog_posts (id TEXT PRIMARY KEY, tags TEXT)");
  const ins = db.prepare("INSERT INTO blog_posts (id, tags) VALUES (?, ?)");
  for (const p of POSTS) ins.run(p.id, p.tags);
  // Exactly the SQL the page ran: containsCI(blogPosts.tags, `"${safeTag}"`)
  // → instr(lower(tags), lower(needle)) > 0, needle lower-cased in JS.
  const sqlMatch = db.prepare(
    "SELECT id FROM blog_posts WHERE instr(lower(tags), ?) > 0 ORDER BY id"
  );

  for (const tag of TAGS) {
    it(`tag ${JSON.stringify(tag)}`, () => {
      const needle = `"${tag.replace(/["\\]/g, "")}"`.toLowerCase();
      const expected = (sqlMatch.all(needle) as Array<{ id: string }>).map((r) => r.id);
      const actual = POSTS.filter((p) => blogPostMatchesTag(p, tag))
        .map((p) => p.id)
        .sort();
      expect(actual).toEqual(expected);
    });
  }

  it("landmark: the parity cases actually match something", () => {
    const total = TAGS.reduce(
      (n, t) => n + POSTS.filter((p) => blogPostMatchesTag(p, t)).length,
      0
    );
    expect(total).toBeGreaterThan(5);
    expect(POSTS.filter((p) => blogPostMatchesTag(p, "Maine")).map((p) => p.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("selectBlogIndexPage", () => {
  const all = Array.from({ length: 30 }, (_, i) =>
    post(String(i), i % 3 === 0 ? '["Maine"]' : '["NH"]')
  );

  it("pages the unfiltered set in stored order and counts all of it", () => {
    const p1 = selectBlogIndexPage(all, { page: 1, perPage: 12 });
    const p3 = selectBlogIndexPage(all, { page: 3, perPage: 12 });
    expect(p1.total).toBe(30);
    expect(p1.posts.map((p) => p.id)).toEqual(all.slice(0, 12).map((p) => p.id));
    expect(p3.posts.map((p) => p.id)).toEqual(all.slice(24).map((p) => p.id));
  });

  it("filters before paging, and total counts the filtered set", () => {
    const sel = selectBlogIndexPage(all, { tag: "maine", page: 1, perPage: 4 });
    expect(sel.total).toBe(10);
    expect(sel.posts.map((p) => p.id)).toEqual(["0", "3", "6", "9"]);
  });

  it("a page past the end is empty, not an error", () => {
    expect(selectBlogIndexPage(all, { page: 9, perPage: 12 }).posts).toEqual([]);
  });
});

describe("/blog page wiring", () => {
  const src = readFileSync(join(import.meta.dirname, "../../../app/blog/page.tsx"), "utf8");

  it("the public path reads the cache under the constant key", () => {
    expect(src).toMatch(/kvReadThrough\(\s*getCloudflareRateLimitKv\(\),\s*BLOG_INDEX_CACHE_KEY,/);
    expect(BLOG_INDEX_CACHE_KEY).not.toMatch(/tag/i);
  });

  it("the cache loader reads PUBLISHED posts only — drafts never enter the public cache", () => {
    const loader = src.slice(src.indexOf("async function loadPublishedBlogIndex"));
    const body = loader.slice(0, loader.indexOf("\n}\n"));
    expect(body).toContain('eq(blogPosts.status, "PUBLISHED")');
  });
});
