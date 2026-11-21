/**
 * OPE-1541 — a series renamed by `update_series` redirects, measured end to end.
 *
 * The MCP handler writes into the MCP test database. That SAME database then
 * serves the real middleware. So "the old URL 301s to the new one" is asserted
 * against the rows the tool actually wrote, not against rows hand-seeded in the
 * shape the tool is believed to write.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type Database from "better-sqlite3";
import { NextRequest } from "next/server";

vi.mock("drizzle-orm/d1", async () => {
  const sqlite = await import("drizzle-orm/better-sqlite3");
  return { drizzle: (client: Database.Database) => sqlite.drizzle(client) };
});

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { middleware } from "../middleware";
import { createTestDb } from "../../mcp-server/__tests__/setup-db";
import { handleUpdateSeries } from "../../mcp-server/src/tools/admin-update-series";

const ORIGIN = "https://meetmeatthefair.com";
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

beforeAll(async () => {
  const { db, raw } = createTestDb();
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'GAHS', 'gahs')`).run();
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, promoter_id) VALUES ('s1', 'a-fair', 'A Fair', 'p1')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, series_id, start_date, end_date, status, lifecycle_status)
       VALUES ('e26', 'A Fair', 'a-fair-2026', 'p1', 's1', ?, ?, 'APPROVED', 'SCHEDULED')`
    )
    .run(sec("2026-05-02T14:00:00Z"), sec("2026-05-02T20:00:00Z"));

  // A → B, then B → C: two real applies through the tool.
  for (const slug of ["b-fair", "c-fair"]) {
    // The MCP test db is better-sqlite3 with a D1 batch shim (setup-db.ts).
    const r = await handleUpdateSeries(
      db as never,
      { userId: "admin-1" },
      {
        series_id: "s1",
        slug,
        reason: "test",
        dry_run: false,
      }
    );
    expect(r.applied).toBe(true);
  }

  vi.mocked(getCloudflareContext).mockReturnValue({
    env: { DB: raw },
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
      return { hops, finalStatus: res.status };
    }
    hops.push(loc);
    current = new URL(loc).pathname;
  }
  throw new Error(`redirect loop from ${path}`);
}

describe("update_series renames redirect through the real middleware", () => {
  it("the live hub renders: no redirect (positive control)", async () => {
    const r = await follow("/events/c-fair");
    expect(r.hops).toEqual([]);
    expect(r.finalStatus).toBe(200);
  });

  it("the first retired slug A reaches C in one hop", async () => {
    expect((await follow("/events/a-fair")).hops).toEqual([`${ORIGIN}/events/c-fair`]);
  });

  it("the intermediate slug B reaches C in one hop", async () => {
    expect((await follow("/events/b-fair")).hops).toEqual([`${ORIGIN}/events/c-fair`]);
  });

  it("an edition URL under the old slug keeps its year", async () => {
    expect((await follow("/events/a-fair/2026")).hops).toEqual([`${ORIGIN}/events/c-fair/2026`]);
  });

  it("a slug that was never this series' does not redirect (negative control)", async () => {
    expect((await follow("/events/z-fair")).hops).toEqual([]);
  });
});
