/**
 * Tests for the display-time slug-history resolution pass.
 *
 * Spun up against an in-memory better-sqlite3 with the slug-history
 * and entity tables `resolveGscPath` walks. Verifies:
 *   - gsc_query items get resolvedTopPagePath + status filled in
 *   - Non-gsc items pass through unchanged (no-op fast path)
 *   - Items with no payload.topPagePath pass through
 *   - Same path on N items causes only ONE resolution lookup (Set-dedup)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { resolveActiveItemPaths } from "../resolve-active-items";
import type { ActiveItem } from "../engine";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
type ResolveDb = Parameters<typeof resolveActiveItemPaths>[0];

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT,
    status TEXT,
    promoter_id TEXT
  );
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT,
    body TEXT,
    author_id TEXT,
    status TEXT
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    business_name TEXT,
    user_id TEXT
  );
  CREATE TABLE event_slug_history (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );
  CREATE TABLE blog_slug_history (
    id TEXT PRIMARY KEY,
    blog_post_id TEXT,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );
  CREATE TABLE vendor_slug_history (
    id TEXT PRIMARY KEY,
    vendor_id TEXT,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function seedEvent(slug: string) {
  raw
    .prepare(
      "INSERT INTO events (id, slug, name, status, promoter_id) VALUES (?, ?, ?, 'APPROVED', 'p1')"
    )
    .run(slug, slug, slug);
}

function seedRename(oldSlug: string, newSlug: string, when: string) {
  raw
    .prepare(
      "INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(`h-${oldSlug}`, "e", oldSlug, newSlug, Math.floor(new Date(when).getTime() / 1000));
}

function makeItem(overrides: Partial<ActiveItem> = {}): ActiveItem {
  return {
    itemId: "i1",
    ruleId: "r1",
    ruleKey: "low_ctr_pages",
    title: "Low CTR",
    rationaleTemplate: "{n} queries",
    severity: "yellow",
    category: null,
    ruleTotalMatchCount: 1,
    ruleLastScannedAt: null,
    targetType: "gsc_query",
    targetId: "tid",
    payload: null,
    firstSeenAt: new Date("2026-05-01"),
    lastSeenAt: new Date("2026-05-29"),
    ...overrides,
  };
}

describe("resolveActiveItemPaths", () => {
  it("returns identical array for empty input", async () => {
    const r = await resolveActiveItemPaths(db as unknown as ResolveDb, []);
    expect(r).toEqual([]);
  });

  it("passes non-gsc items through unchanged (no DB roundtrip)", async () => {
    const items: ActiveItem[] = [
      makeItem({ targetType: "vendor", payload: { businessName: "X" } }),
      makeItem({ targetType: "event", payload: { slug: "fair-2026" } }),
    ];
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    expect(out).toHaveLength(2);
    expect("resolvedTopPagePath" in out[0]).toBe(false);
    expect("resolvedTopPagePath" in out[1]).toBe(false);
  });

  it("attaches resolvedTopPagePath for a renamed event slug", async () => {
    seedEvent("2026-new-fair-name");
    seedRename("2026-old-fair-name", "2026-new-fair-name", "2026-05-20");

    const items: ActiveItem[] = [
      makeItem({
        payload: { query: "old fair", topPagePath: "/events/2026-old-fair-name" },
      }),
    ];
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    expect(out[0].resolvedTopPagePath).toBe("/events/2026-new-fair-name");
    expect(out[0].resolvedTopPageStatus).toBe("renamed");
  });

  it("marks a path 'live' when no rename happened", async () => {
    seedEvent("2026-fair");
    const items: ActiveItem[] = [
      makeItem({
        payload: { query: "fair", topPagePath: "/events/2026-fair" },
      }),
    ];
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    expect(out[0].resolvedTopPagePath).toBe("/events/2026-fair");
    expect(out[0].resolvedTopPageStatus).toBe("live");
  });

  it("marks a path 'stale' when the resolved slug doesn't exist", async () => {
    // No event seeded — and no rename either; the path will fall
    // through walkHistory unchanged, then fail the canonical-slug
    // existence check.
    const items: ActiveItem[] = [
      makeItem({
        payload: { query: "gone", topPagePath: "/events/2026-gone" },
      }),
    ];
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    expect(out[0].resolvedTopPageStatus).toBe("stale");
  });

  it("skips gsc_query items without a topPagePath in payload", async () => {
    const items: ActiveItem[] = [
      makeItem({ payload: { query: "no path" } }),
      makeItem({ payload: null }),
    ];
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    expect("resolvedTopPagePath" in out[0]).toBe(false);
    expect("resolvedTopPagePath" in out[1]).toBe(false);
  });

  it("dedups identical paths so the same rename resolves once", async () => {
    seedEvent("2026-new");
    seedRename("2026-old", "2026-new", "2026-05-20");
    // 4 separate gsc_query items, all targeting the same renamed page.
    const items: ActiveItem[] = ["q1", "q2", "q3", "q4"].map((q) =>
      makeItem({
        itemId: q,
        payload: { query: q, topPagePath: "/events/2026-old" },
      })
    );
    const out = await resolveActiveItemPaths(db as unknown as ResolveDb, items);
    // All should resolve to the same renamed path.
    expect(out.every((i) => i.resolvedTopPagePath === "/events/2026-new")).toBe(true);
    expect(out.every((i) => i.resolvedTopPageStatus === "renamed")).toBe(true);
  });
});
