/**
 * OPE-122 — public performers index data + filter helpers.
 *   - listPublicPerformers excludes soft-deleted, merge-tombstones, and merged
 *     slugs; returns the rest alphabetically.
 *   - filterPerformers does case-insensitive name search + category filter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { listPublicPerformers, filterPerformers, type PublicPerformer } from "../list-public";

const SCHEMA_SQL = `
  CREATE TABLE performers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    act_category TEXT, image_url TEXT, home_base_city TEXT, home_base_state TEXT,
    verified INTEGER DEFAULT 0 NOT NULL, redirect_to_performer_id TEXT, deleted_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

function perf(id: string, name: string, extra: Record<string, unknown> = {}) {
  const cols = ["id", "name", "slug", ...Object.keys(extra)];
  const vals = [id, name, name.toLowerCase().split(" ").join("-"), ...Object.values(extra)];
  raw
    .prepare(`INSERT INTO performers (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...vals);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("listPublicPerformers", () => {
  it("returns only live performers, alphabetically", async () => {
    perf("p1", "Zed the Great");
    perf("p2", "Aardvark Acrobats");
    perf("p3", "Mr. Drew");
    const rows = await listPublicPerformers(db);
    expect(rows.map((r) => r.name)).toEqual(["Aardvark Acrobats", "Mr. Drew", "Zed the Great"]);
  });

  it("excludes soft-deleted, tombstones, and merged slugs", async () => {
    perf("live", "Live Act");
    perf("del", "Deleted Act", { deleted_at: 1_700_000_000 });
    perf("tomb", "Tombstone Act", { redirect_to_performer_id: "live" });
    // A merged-away slug (createSlug never produces "-merged-<id>").
    raw
      .prepare("INSERT INTO performers (id, name, slug) VALUES (?,?,?)")
      .run("merged", "Old Name", "old-name-merged-abcd1234");

    const rows = await listPublicPerformers(db);
    expect(rows.map((r) => r.id)).toEqual(["live"]);
  });
});

describe("filterPerformers", () => {
  const list: PublicPerformer[] = [
    {
      id: "1",
      name: "Mr. Drew and His Animals Too",
      slug: "mr-drew",
      imageUrl: null,
      actCategory: "ANIMAL_SHOW",
      homeBaseCity: null,
      homeBaseState: null,
      verified: false,
    },
    {
      id: "2",
      name: "The Local Legends",
      slug: "the-local-legends",
      imageUrl: null,
      actCategory: "MUSIC",
      homeBaseCity: null,
      homeBaseState: null,
      verified: false,
    },
    {
      id: "3",
      name: "Magician Mike",
      slug: "magician-mike",
      imageUrl: null,
      actCategory: "MAGIC",
      homeBaseCity: null,
      homeBaseState: null,
      verified: false,
    },
  ];

  it("case-insensitive name search surfaces the match", () => {
    expect(filterPerformers(list, "mr. drew", null).map((p) => p.id)).toEqual(["1"]);
    expect(filterPerformers(list, "LEGENDS", null).map((p) => p.id)).toEqual(["2"]);
  });

  it("filters by category", () => {
    expect(filterPerformers(list, "", "MUSIC").map((p) => p.id)).toEqual(["2"]);
  });

  it("combines name + category (empty query returns all in category)", () => {
    expect(filterPerformers(list, "", null)).toHaveLength(3);
    expect(filterPerformers(list, "mike", "MAGIC").map((p) => p.id)).toEqual(["3"]);
    expect(filterPerformers(list, "mike", "MUSIC")).toHaveLength(0);
  });
});
