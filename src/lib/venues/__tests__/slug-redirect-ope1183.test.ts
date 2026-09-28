/**
 * OPE-1183 — merged venue slugs 301 to the survivor instead of 404ing.
 * Real SQLite; the shapes are prod's (champlain-valley-fair, deerfield).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { resolveVenueRedirect } from "../slug-redirect";

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](`
    CREATE TABLE venues (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'ACTIVE');
    CREATE TABLE venue_slug_history (
      id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, old_slug TEXT NOT NULL, new_slug TEXT NOT NULL,
      changed_at INTEGER NOT NULL, changed_by TEXT
    );`);
  db = drizzle(raw, { schema });
  const v = raw.prepare(`INSERT INTO venues (id, slug, status) VALUES (?,?,?)`);
  const h = raw.prepare(
    `INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at) VALUES (?,?,?,?,?)`
  );
  // champlain: tombstone + keeper; history original -> keeper, tombstone -> keeper.
  v.run("cvx", "champlain-valley-exposition", "ACTIVE");
  v.run("cvf", "champlain-valley-fair-merged-bdc5d9c7", "INACTIVE");
  h.run("h1", "cvx", "champlain-valley-fair", "champlain-valley-exposition", 1);
  h.run("h2", "cvx", "champlain-valley-fair-merged-bdc5d9c7", "champlain-valley-exposition", 2);
  // deerfield: keeper later renamed BACK to the original slug with no history
  // row, so the recorded new_slug (deerfield-fair-1) is dead.
  v.run("dfk", "deerfield-fairgrounds", "ACTIVE");
  v.run("dft", "deerfield-fairgrounds-merged-ef94c4cd", "INACTIVE");
  h.run("h3", "dfk", "deerfield-fairgrounds", "deerfield-fair-1", 3);
  h.run("h4", "dfk", "deerfield-fairgrounds-merged-ef94c4cd", "deerfield-fair-1", 4);
  // retired, never merged
  v.run("vsf", "vermont-state-fairgrounds", "INACTIVE");
});

const go = (slug: string) => resolveVenueRedirect(db as never, slug);

describe("resolveVenueRedirect (OPE-1183)", () => {
  it("ACCEPTANCE: a merge tombstone's parked slug 301s to the keeper", async () => {
    expect(await go("champlain-valley-fair-merged-bdc5d9c7")).toBe("champlain-valley-exposition");
  });

  it("the pre-merge original slug still 301s", async () => {
    expect(await go("champlain-valley-fair")).toBe("champlain-valley-exposition");
  });

  it("a chain whose recorded target was later renamed follows the keeper by id", async () => {
    expect(await go("deerfield-fairgrounds-merged-ef94c4cd")).toBe("deerfield-fairgrounds");
  });

  it("a live venue is served, not redirected", async () => {
    expect(await go("champlain-valley-exposition")).toBeNull();
    expect(await go("deerfield-fairgrounds")).toBeNull();
  });

  it("no OPE-420 regression: bogus and retired-unmerged slugs keep their 404", async () => {
    expect(await go("zzz-bogus-venue-xyz")).toBeNull();
    expect(await go("vermont-state-fairgrounds")).toBeNull();
  });
});
