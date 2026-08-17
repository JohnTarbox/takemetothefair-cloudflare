/**
 * OPE-438 — MCP detail tools must resolve old slugs, like the web route does.
 *
 * The two surfaces disagreed about whether a URL existed: `/events/<old-slug>`
 * served a 301 to the keeper while `get_event_details(slug: "<old-slug>")`
 * returned "Event not found". The MCP tool is the one an agent reaches for, so
 * the natural post-merge check — which `merge_events`' own success message
 * tells you to run — read as a FAILED merge.
 *
 * These pin the walker's safety properties. The cycle case is not theoretical:
 * OPE-423 was a resurrected tombstone that left two history rows chained
 * through one slug, so a naive walker would spin on production data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const SCHEMA_SQL = `
  CREATE TABLE event_slug_history (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
    old_slug TEXT NOT NULL, new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL, changed_by TEXT
  );
`;

let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
});

let seq = 0;
function hop(oldSlug: string, newSlug: string, at = ++seq) {
  raw
    .prepare(
      `INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at)
       VALUES (?,?,?,?,?)`
    )
    .run(`h${at}`, "e1", oldSlug, newSlug, at);
}

/** Mirrors resolveSlugHistory() in mcp-server/src/tools/public.ts. */
function resolve(requested: string, maxHops = 5): string | null {
  let cursor = requested;
  const seen = new Set<string>([cursor]);
  for (let i = 0; i < maxHops; i++) {
    const row = raw
      .prepare(
        `SELECT new_slug FROM event_slug_history WHERE old_slug = ? ORDER BY changed_at DESC LIMIT 1`
      )
      .get(cursor) as { new_slug: string } | undefined;
    const next = row?.new_slug;
    if (!next || seen.has(next)) break;
    cursor = next;
    seen.add(cursor);
  }
  return cursor === requested ? null : cursor;
}

describe("the post-merge verification that used to fail", () => {
  it("resolves a merged duplicate's old slug to the keeper", () => {
    hop("marthas-vineyard-agricultural-fair-2026", "martha-s-vineyard-fair-2026");
    expect(resolve("marthas-vineyard-agricultural-fair-2026")).toBe("martha-s-vineyard-fair-2026");
  });

  it("returns null for a slug with no history — a genuine miss stays a miss", () => {
    // The fallback must not invent a resolution; "not found" is still correct
    // for a slug that never existed.
    expect(resolve("never-existed")).toBeNull();
  });

  it("returns null when the slug IS the current one", () => {
    // A direct hit never reaches the fallback, and must not report itself as a
    // redirect — that flag is what distinguishes a clean merge from a
    // half-completed one.
    hop("old", "current");
    expect(resolve("current")).toBeNull();
  });
});

describe("safety on the data OPE-423 actually produced", () => {
  it("terminates on a two-row cycle instead of spinning", () => {
    // The resurrected-tombstone shape: a -> b and b -> a.
    hop("a", "b");
    hop("b", "a");
    expect(resolve("a")).toBe("b");
  });

  it("terminates on a self-reference", () => {
    hop("a", "a");
    expect(resolve("a")).toBeNull();
  });

  it("follows a multi-hop chain to its end", () => {
    hop("v1", "v2");
    hop("v2", "v3");
    hop("v3", "v4");
    expect(resolve("v1")).toBe("v4");
  });

  it("stops at the hop cap on a pathological chain", () => {
    for (let i = 1; i <= 9; i++) hop(`s${i}`, `s${i + 1}`);
    // 5 hops from s1 lands on s6 rather than walking unbounded.
    expect(resolve("s1")).toBe("s6");
  });
});

describe("multiple history rows for one slug", () => {
  it("takes the most recent rename", () => {
    // A slug renamed twice: the newest row wins, matching the web walker's
    // ORDER BY changed_at DESC.
    hop("old", "middle", 1);
    hop("old", "newest", 2);
    expect(resolve("old")).toBe("newest");
  });
});
