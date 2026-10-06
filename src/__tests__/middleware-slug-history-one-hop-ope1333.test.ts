/**
 * OPE-1333 — a retired event slug reaches its final URL in ONE hop.
 *
 * The event slug-history walk used to 301 to `/events/<terminus-slug>`. When
 * the terminus is a series member, that URL itself 301s to
 * `/events/<series>/<year|edition>` — so every retired slug of a series member
 * was a two-hop chain (280 of 326 live chains on 2026-10-06; specimen
 * `/events/near-fest-xxxix` → `near-fest-xl` → `/events/near-fest/2026-10`).
 *
 * "One hop" is asserted the only way that means anything: the Location the
 * middleware returns is fed back through the SAME middleware and must not
 * redirect again. Asserting the Location string alone would pass a chain
 * whose first hop happens to name the right-looking URL.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";

vi.mock("drizzle-orm/d1", async () => {
  const sqlite = await import("drizzle-orm/better-sqlite3");
  return { drizzle: (client: Database.Database) => sqlite.drizzle(client) };
});

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { middleware } from "../middleware";

const ORIGIN = "https://meetmeatthefair.com";
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

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
  const series = db.prepare("INSERT INTO event_series VALUES (?, ?, ?, ?, 1700000000)");
  series.run("s-near", "near-fest", "near-fest", "multi");
  series.run("s-pett", "pettengill-family-farm-day", "pettengill-family-farm-day", "annual");
  series.run("s-clean", "clean-fair", "clean-fair", "annual");

  const ev = db.prepare(
    "INSERT INTO events VALUES (?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, ?, 1800000000, NULL)"
  );
  const at = sec("2026-10-02T12:00:00Z");
  // multi-edition member, keyed
  ev.run("e-xl", "near-fest-xl", "NEAR-Fest XL", "APPROVED", at, at, "s-near", "2026-10");
  // annual member
  ev.run(
    "e-pett",
    "pettengill-family-farm-day-2026",
    "Pettengill",
    "APPROVED",
    at,
    at,
    "s-pett",
    null
  );
  // member whose slug IS the series clean slug — the landing, rendered not redirected
  ev.run("e-clean", "clean-fair", "Clean Fair", "APPROVED", at, at, "s-clean", null);
  // standalone (no series)
  ev.run("e-solo", "solo-show", "Solo Show", "APPROVED", at, at, null, null);
  // not public — the walk must not 301 into it
  ev.run("e-pend", "pending-show", "Pending", "PENDING", at, at, null, null);

  const hist = db.prepare("INSERT INTO event_slug_history VALUES (?, ?, ?, ?, ?)");
  hist.run("h1", "near-fest-xxxix", "near-fest-xl", "e-xl", 1); // the live specimen
  hist.run("h2", "near-fest-xxxviii", "near-fest-xxxix", "e-xl", 0); // a 2-row history chain
  hist.run("h3", "pettengill-farm-day", "pettengill-family-farm-day-2026", "e-pett", 1);
  hist.run("h4", "clean-fair-old", "clean-fair", "e-clean", 1);
  hist.run("h5", "solo-show-old", "solo-show", "e-solo", 1);
  hist.run("h6", "pending-show-old", "pending-show", "e-pend", 1);

  vi.mocked(getCloudflareContext).mockReturnValue({
    env: { DB: db },
    ctx: { waitUntil() {}, passThroughOnException() {} },
    cf: {},
  } as never);
});

const get = (path: string) => middleware(new NextRequest(`${ORIGIN}${path}`));

/** Follow redirects through the real middleware; return every hop's Location. */
async function follow(path: string) {
  const hops: string[] = [];
  let current = path;
  for (let i = 0; i < 5; i++) {
    const res = await get(current);
    const loc = res.headers.get("location");
    if (!(res.status === 301 || res.status === 308) || !loc) {
      return { hops, finalStatus: res.status, finalPath: current };
    }
    hops.push(loc);
    current = new URL(loc).pathname;
  }
  throw new Error(`redirect loop from ${path}`);
}

describe("retired slug → series member: ONE hop to the final URL", () => {
  it("the live specimen: near-fest-xxxix → /events/near-fest/2026-10 directly (multi-edition)", async () => {
    const r = await follow("/events/near-fest-xxxix");
    expect(r.hops).toEqual([`${ORIGIN}/events/near-fest/2026-10`]);
  });

  it("a two-row history chain still costs ONE response hop", async () => {
    const r = await follow("/events/near-fest-xxxviii");
    expect(r.hops).toEqual([`${ORIGIN}/events/near-fest/2026-10`]);
  });

  it("annual series member → /events/<series>/<year> directly", async () => {
    const r = await follow("/events/pettengill-farm-day");
    expect(r.hops).toEqual([`${ORIGIN}/events/pettengill-family-farm-day/2026`]);
  });
});

describe("fallback: /events/<terminus> where no occurrence URL applies", () => {
  it("a standalone event (no series) keeps /events/<slug>", async () => {
    const r = await follow("/events/solo-show-old");
    expect(r.hops).toEqual([`${ORIGIN}/events/solo-show`]);
  });

  it("a member whose slug IS the series clean slug lands on the landing, not /<series>/<year>", async () => {
    const r = await follow("/events/clean-fair-old");
    expect(r.hops).toEqual([`${ORIGIN}/events/clean-fair`]);
  });

  it("a non-public terminus is not redirected into (unchanged)", async () => {
    const r = await follow("/events/pending-show-old");
    expect(r.hops).toEqual([]);
  });
});
