/**
 * Regression: get_blog_links_in_post must chunk its name-resolution IN(...)
 * queries (2026-06-25 follow-up to Bundle A / K42).
 *
 * Once rebuild_content_links could store 100+ rows (K42 write-path fix), the
 * READ path's unchunked `inArray(events.id, ids)` started tripping the same
 * "too many SQL variables" cap on the CT pillar (144 links).
 *
 * NOTE: better-sqlite3's param cap is far higher than D1's 100, so this can't
 * reproduce the D1 throw — it guards the chunk loop's COMPLETENESS instead: a
 * 100-link post must resolve every name across the 90-id chunk boundary (a
 * broken loop would drop ids 90–99). The D1 cap itself is re-verified live.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerContentLinksTools } from "../src/tools/content-links.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerContentLinksTools(server as never, db, ADMIN_AUTH, undefined);
});

describe("get_blog_links_in_post — chunked name resolution", () => {
  it("resolves a 100-event-link post completely across the chunk boundary", async () => {
    // Seed via raw SQL (the Drizzle blog_posts insert emits columns the minimal
    // test table omits). The tool only reads id/slug/title from blog_posts.
    raw
      .prepare("INSERT INTO blog_posts (id, slug, title, body) VALUES (?, ?, ?, ?)")
      .run("p1", "ct-pillar", "CT Guide", "x");

    // 100 EVENT links — over D1's 100 bound-param cap once names are resolved
    // in one IN(...). Seed the events + the content_links rows pointing at them.
    const insEvent = raw.prepare(
      "INSERT INTO events (id, name, slug, promoter_id, status) VALUES (?, ?, ?, 'pr', 'APPROVED')"
    );
    const insLink = raw.prepare(
      "INSERT INTO content_links (id, source_type, source_id, target_type, target_slug, target_id) VALUES (?, 'BLOG_POST', 'p1', 'EVENT', ?, ?)"
    );
    for (let i = 0; i < 100; i++) {
      const id = `e${i}`;
      insEvent.run(id, `Fair ${i}`, `fair-${i}`);
      insLink.run(`cl${i}`, `fair-${i}`, id);
    }

    const res = (await server.invoke("get_blog_links_in_post", { slug: "ct-pillar" })) as {
      content: Array<{ text: string }>;
    };
    const json = JSON.parse(res.content[0].text) as {
      links: Array<{ target_name: string | null; resolved: boolean }>;
    };

    expect(json.links).toHaveLength(100);
    // Every link resolved a name (the chunked resolver covered all 100).
    expect(json.links.every((l) => l.resolved && l.target_name)).toBe(true);
    expect(json.links.filter((l) => l.target_name === "Fair 0")).toHaveLength(1);
    expect(json.links.filter((l) => l.target_name === "Fair 99")).toHaveLength(1);
  });
});
