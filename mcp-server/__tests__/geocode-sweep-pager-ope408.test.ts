/**
 * OPE-408 (bounce 2026-09-23) — the nightly geocode sweep re-read the same
 * first page forever.
 *
 * Prod: `next_cursor` was `b3c4004c…` on 14 consecutive nights; 3 writes in 26
 * runs; 60 fully-addressed venues created 09-23 never reached. The cron made
 * ONE call with no `after_id`, so the OPE-214 cursor was produced and dropped.
 *
 * The route is simulated faithfully here — keyset on id, 25 per page,
 * `next_cursor` only on a full page — with 25 REFUSED rows sorting first and
 * 60 addressable rows behind them, the prod shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  sweepGeocodePages,
  lastGeocodeSweepCursor,
  GEOCODE_SWEEP_MAX_PAGES,
} from "../src/venues/geocode-sweep-pager.js";
import { createTestDb } from "./setup-db.js";

const PAGE = 25;
const REFUSED = Array.from({ length: 25 }, (_, i) => `a${String(i).padStart(3, "0")}`);
const ADDRESSABLE = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(3, "0")}`);
const BACKLOG = [...REFUSED, ...ADDRESSABLE].sort();

/** The route: keyset page after `afterId`, next_cursor only when the page is full. */
function route(attempted: string[]) {
  return async (afterId: string | null) => {
    const rows = BACKLOG.filter((id) => afterId === null || id > afterId).slice(0, PAGE);
    attempted.push(...rows);
    return { next_cursor: rows.length === PAGE ? rows[rows.length - 1] : null };
  };
}

describe("OPE-408 — the sweep reaches rows past the refused first page", () => {
  it("REPRO: one call per night with no cursor never gets past the refused 25", async () => {
    const attempted: string[] = [];
    for (let night = 0; night < 14; night++) await route(attempted)(null);
    expect(new Set(attempted)).toEqual(new Set(REFUSED));
    expect(attempted.some((id) => ADDRESSABLE.includes(id))).toBe(false);
  });

  it("ACCEPTANCE: one night now attempts every addressable row behind them", async () => {
    const attempted: string[] = [];
    const outcome = await sweepGeocodePages(route(attempted), null);
    for (const id of ADDRESSABLE) expect(attempted).toContain(id);
    expect(outcome.stoppedBy).toBe("exhausted");
    expect(outcome.pages).toBe(4); // 85 rows: 25+25+25+10
  });

  it("the page cap bounds a night — and the cursor it stops on is where the next night resumes", async () => {
    const attempted: string[] = [];
    const n1 = await sweepGeocodePages(route(attempted), null, 2);
    expect(n1.stoppedBy).toBe("cap");
    expect(attempted).toHaveLength(50);
    const n2 = await sweepGeocodePages(route(attempted), n1.endedAt, 2);
    // No row attempted twice across the two nights, and the tail is reached.
    expect(new Set(attempted).size).toBe(attempted.length);
    expect(attempted).toContain(ADDRESSABLE[ADDRESSABLE.length - 1]);
    expect(n2.stoppedBy).toBe("exhausted");
  });

  it("stops on a failed page rather than looping", async () => {
    let calls = 0;
    const outcome = await sweepGeocodePages(async () => {
      calls++;
      return null;
    }, "x");
    expect(calls).toBe(1);
    expect(outcome.stoppedBy).toBe("error");
  });

  it("the default cap is the documented 4 pages (100 billed geocodes a night)", () => {
    expect(GEOCODE_SWEEP_MAX_PAGES).toBe(4);
  });
});

describe("lastGeocodeSweepCursor reads the sweep's own audit rows", () => {
  function d1(raw: ReturnType<typeof createTestDb>["raw"]) {
    return {
      prepare: (sql: string) => ({ first: async () => raw.prepare(sql).get() }),
    } as unknown as D1Database;
  }
  const insert = (
    raw: ReturnType<typeof createTestDb>["raw"],
    at: number,
    payload: Record<string, unknown>,
    action = "venue.geocode.sweep"
  ) =>
    raw
      .prepare(
        "INSERT INTO admin_actions (id, action, target_type, target_id, created_at, payload_json) VALUES (?, ?, 'venue', 'sweep', ?, ?)"
      )
      .run(`aa-${Math.random()}`, action, at, JSON.stringify(payload));

  it("returns the NEWEST row's next_cursor, same-second ties broken by insertion", async () => {
    const { raw } = createTestDb();
    insert(raw, 100, { next_cursor: "old" });
    insert(raw, 200, { next_cursor: "page1" });
    insert(raw, 200, { next_cursor: "page2" }); // same second, later page
    insert(raw, 300, { next_cursor: "not-me" }, "venue.update");
    expect(await lastGeocodeSweepCursor(d1(raw))).toBe("page2");
  });

  it("returns null when the last night walked to the end — the next night restarts", async () => {
    const { raw } = createTestDb();
    insert(raw, 100, { next_cursor: "mid" });
    insert(raw, 200, { next_cursor: null });
    expect(await lastGeocodeSweepCursor(d1(raw))).toBeNull();
  });

  it("returns null with no sweep history", async () => {
    const { raw } = createTestDb();
    expect(await lastGeocodeSweepCursor(d1(raw))).toBeNull();
  });
});

describe("the 08:30 cron uses the pager", () => {
  it("resumes from lastGeocodeSweepCursor and passes after_id", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf('controller.cron === "30 8 * * *"'));
    expect(branch).toMatch(/await lastGeocodeSweepCursor\(env\.DB\)/);
    expect(branch).toMatch(/await sweepGeocodePages\(/);
    expect(branch).toMatch(/after_id: afterId/);
  });
});
