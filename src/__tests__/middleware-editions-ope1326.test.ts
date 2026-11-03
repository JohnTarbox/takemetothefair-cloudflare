/**
 * OPE-1326 — multi-edition series step 3/5, driven through the REAL middleware.
 *
 * `drizzle-orm/d1` is swapped for the better-sqlite3 driver so the middleware's
 * own queries run unmodified against a fixture holding a FLAGGED series with
 * two same-year editions (the case that motivated the change), an annual
 * series, and an annual series whose member still carries a key (the
 * rollback path). Retired series slugs exercise the one-hop walker.
 *
 * Section-7 tests from the OPE-1315 round-2 report covered here:
 *   - event slug → `Location` equals `occurrencePath` (#7, the chokepoint)
 *   - a year URL on a flagged series 301s to its edition in ONE hop
 *   - an old series slug resolves year → edition in the same hop
 *   - ETag key matches the rendered row
 *   - the matcher accepts every builder output
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { occurrencePath } from "@takemetothefair/utils";

vi.mock("drizzle-orm/d1", async () => {
  const sqlite = await import("drizzle-orm/better-sqlite3");
  return { drizzle: (client: Database.Database) => sqlite.drizzle(client) };
});

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { middleware, config } from "../middleware";

const ORIGIN = "https://meetmeatthefair.com";
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

type Member = {
  id: string;
  slug: string;
  series: string;
  start: string;
  key: string | null;
  updated: number;
};
const SERIES = [
  { id: "s-near", slug: "near-fest", mode: "multi" },
  { id: "s-frye", slug: "fryeburg-fair", mode: "annual" },
  { id: "s-roll", slug: "rollback-fest", mode: "annual" },
];
const MEMBERS: Member[] = [
  {
    id: "e1",
    slug: "near-fest-xl",
    series: "s-near",
    start: "2026-10-02T12:00:00Z",
    key: "2026-10",
    updated: 1_800_000_001,
  },
  {
    id: "e2",
    slug: "near-fest-xli",
    series: "s-near",
    start: "2027-05-15T12:00:00Z",
    key: "2027-05",
    updated: 1_800_000_002,
  },
  {
    id: "e3",
    slug: "near-fest-xlii",
    series: "s-near",
    start: "2027-10-01T12:00:00Z",
    key: "2027-10",
    updated: 1_800_000_003,
  },
  {
    id: "e4",
    slug: "fryeburg-fair-2026",
    series: "s-frye",
    start: "2026-10-04T12:00:00Z",
    key: null,
    updated: 1_800_000_004,
  },
  {
    id: "e5",
    slug: "rollback-fest-2027",
    series: "s-roll",
    start: "2027-05-20T12:00:00Z",
    key: "2027-05",
    updated: 1_800_000_005,
  },
];
const SERIES_UPDATED = 1_700_000_000; // older than every member, so the member stamp wins

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE event_series (id TEXT PRIMARY KEY, canonical_slug TEXT NOT NULL UNIQUE, name TEXT,
      edition_mode TEXT NOT NULL DEFAULT 'annual', updated_at INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT, status TEXT,
      lifecycle_status TEXT, start_date INTEGER, end_date INTEGER, series_id TEXT, edition_key TEXT,
      updated_at INTEGER, merged_into TEXT);
    CREATE TABLE series_slug_history (id TEXT PRIMARY KEY, old_slug TEXT, new_slug TEXT, series_id TEXT, changed_at INTEGER);
    CREATE TABLE event_slug_history (id TEXT PRIMARY KEY, old_slug TEXT, new_slug TEXT, event_id TEXT, changed_at INTEGER);
  `);
  for (const s of SERIES)
    db.prepare("INSERT INTO event_series VALUES (?, ?, ?, ?, ?)").run(
      s.id,
      s.slug,
      s.slug,
      s.mode,
      SERIES_UPDATED
    );
  for (const m of MEMBERS)
    db.prepare(
      "INSERT INTO events VALUES (?, ?, ?, 'APPROVED', 'SCHEDULED', ?, ?, ?, ?, ?, NULL)"
    ).run(m.id, m.slug, m.slug, sec(m.start), sec(m.start), m.series, m.key, m.updated);
  db.prepare(
    "INSERT INTO series_slug_history VALUES ('h1', 'near-fest-old', 'near-fest', 's-near', 1)"
  ).run();
  db.prepare(
    "INSERT INTO series_slug_history VALUES ('h2', 'fryeburg-old', 'fryeburg-fair', 's-frye', 1)"
  ).run();

  vi.mocked(getCloudflareContext).mockReturnValue({
    env: { DB: db },
    ctx: { waitUntil() {}, passThroughOnException() {} },
    cf: {},
  } as never);
});

const get = (path: string) => middleware(new NextRequest(`${ORIGIN}${path}`));
const location = async (path: string) => {
  const res = await get(path);
  return {
    status: res.status,
    location: res.headers.get("location"),
    etag: res.headers.get("etag"),
  };
};
const modeOf = (seriesId: string) => SERIES.find((s) => s.id === seriesId)!.mode;
const slugOf = (seriesId: string) => SERIES.find((s) => s.id === seriesId)!.slug;
const canonical = (m: Member) =>
  occurrencePath(slugOf(m.series), new Date(m.start), {
    editionMode: modeOf(m.series),
    editionKey: m.key,
  })!;

describe("event slug → Location equals occurrencePath (#7, the chokepoint)", () => {
  for (const m of MEMBERS) {
    it(`/events/${m.slug} → ${canonical(m)}`, async () => {
      const r = await location(`/events/${m.slug}`);
      expect(r.status).toBe(301);
      expect(r.location).toBe(`${ORIGIN}${canonical(m)}`);
    });
  }

  it("the two 2027 NEAR-Fest editions land on two DIFFERENT pages", async () => {
    const a = await location("/events/near-fest-xli");
    const b = await location("/events/near-fest-xlii");
    expect(a.location).toBe(`${ORIGIN}/events/near-fest/2027-05`);
    expect(b.location).toBe(`${ORIGIN}/events/near-fest/2027-10`);
  });
});

describe("year ↔ edition on a live series", () => {
  it("a year URL on a flagged series 301s to that year's earliest edition, in one hop", async () => {
    expect(await location("/events/near-fest/2027")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/near-fest/2027-05`,
    });
    expect(await location("/events/near-fest/2026")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/near-fest/2026-10`,
    });
  });

  it("an edition URL on a flagged series renders (no redirect)", async () => {
    for (const key of ["2026-10", "2027-05", "2027-10"]) {
      const r = await location(`/events/near-fest/${key}`);
      expect(r.location).toBeNull();
      expect(r.status).toBe(200);
    }
  });

  it("an annual series' year URL is untouched", async () => {
    expect(await location("/events/fryeburg-fair/2026")).toMatchObject({
      status: 200,
      location: null,
    });
  });

  it("ROLLBACK: an edition URL on an annual series 301s to the member's year (kept permanently)", async () => {
    expect(await location("/events/rollback-fest/2027-05")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/rollback-fest/2027`,
    });
  });

  it("an unknown edition key falls through to the page (which 404s)", async () => {
    expect(await location("/events/near-fest/2027-06")).toMatchObject({
      status: 200,
      location: null,
    });
  });
});

describe("retired series slugs resolve in ONE hop", () => {
  it("old slug + year on a flagged series → the edition directly, never via /<new>/<year>", async () => {
    expect(await location("/events/near-fest-old/2027")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/near-fest/2027-05`,
    });
  });
  it("old slug + edition key → the same edition on the new slug", async () => {
    expect(await location("/events/near-fest-old/2027-10")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/near-fest/2027-10`,
    });
  });
  it("old slug + year on an annual series → the year on the new slug (unchanged)", async () => {
    expect(await location("/events/fryeburg-old/2026")).toMatchObject({
      status: 301,
      location: `${ORIGIN}/events/fryeburg-fair/2026`,
    });
  });
});

describe("ETag key matches the rendered row", () => {
  for (const m of MEMBERS.filter((x) => canonical(x).split("/").length === 4)) {
    it(`${canonical(m)} carries ${m.slug}'s own updated_at`, async () => {
      const r = await location(canonical(m));
      expect(r.status).toBe(200);
      const seg = canonical(m).split("/")[3];
      expect(r.etag).toContain(`-${slugOf(m.series)}-${seg}-${m.updated}-`);
    });
  }

  it("the two 2027 editions get different validators", async () => {
    const a = await location("/events/near-fest/2027-05");
    const b = await location("/events/near-fest/2027-10");
    expect(a.etag).toBeTruthy();
    expect(a.etag).not.toBe(b.etag);
  });
});

describe("the matcher accepts every builder output", () => {
  const matches = (path: string) =>
    unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` });
  it("every member's canonical path, and a suffixed key", () => {
    const paths = [...MEMBERS.map(canonical), "/events/near-fest/2027-05-xli"];
    expect(paths.length).toBe(MEMBERS.length + 1); // landmark
    for (const p of paths) expect(matches(p), p).toBe(true);
  });
  it("still not facet routes", () => {
    expect(matches("/events/maine/this-weekend")).toBe(false);
  });
});
