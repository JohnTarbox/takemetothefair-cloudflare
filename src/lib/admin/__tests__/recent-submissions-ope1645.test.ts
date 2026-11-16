/**
 * OPE-1645 — the /admin Recent Submissions card lists PENDING events that can
 * still be acted on, soonest first, and counts the ended ones for its footer.
 * Real SQL against the MCP suite's schema (seconds-epoch date columns).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";
import { loadRecentSubmissions, startsSoon } from "../recent-submissions";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];

// 2026-11-12, mid-afternoon Eastern.
const NOW = new Date("2026-11-12T19:00:00Z");
const day = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12) / 1000;

function ev(
  id: string,
  name: string,
  start: string | null,
  end: string | null,
  o: { status?: string; confirmed?: 0 | 1; created?: string } = {}
) {
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, dates_confirmed, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    )
    .run(
      id,
      name,
      id,
      "p1",
      start ? day(start) : null,
      end ? day(end) : null,
      o.status ?? "PENDING",
      o.confirmed ?? 1,
      day(o.created ?? "2026-11-01")
    );
}

beforeEach(() => {
  ({ raw, db } = createTestDb());
  raw
    .prepare("INSERT INTO promoters (id, company_name, slug) VALUES ('p1','Some Promoter','p1')")
    .run();
  // The five the card showed on 2026-11-12 (four ended), oldest-created first.
  ev("gem", "Gem, Mineral & Jewelry Show – Fall 2026", "2026-08-18", "2026-08-19", {
    created: "2026-06-01",
  });
  ev("lovell", "Lovell Old Home Days", "2026-07-18", "2026-07-18", { created: "2026-06-02" });
  ev("weston", "Weston Craft Show 2026", "2026-10-09", "2026-10-11", { created: "2026-06-03" });
  ev("pine", "Pine State Expo 2027", "2027-04-17", "2027-04-18", {
    confirmed: 0,
    created: "2026-06-04",
  });
  ev("flea", "Old-Fashioned Flea Market", "2026-09-13", "2026-09-13", { created: "2026-06-05" });
  // Upcoming rows the old card hid.
  ev("stjohns", "St. John's Vermont Products & Crafts Fair 2026", "2026-11-14", "2026-11-14", {
    created: "2026-11-10",
  });
  ev("running", "Holiday Lights (running)", "2026-11-01", "2026-11-30", { created: "2026-11-11" });
  ev("endstoday", "Ends Today Market", "2026-11-12", null, { created: "2026-11-11" });
  ev("nodate", "Undated Fair", null, null, { created: "2026-11-11" });
  // Not PENDING: never on the card, never in the count.
  ev("approved", "Approved Show", "2026-11-13", "2026-11-13", { status: "APPROVED" });
  ev("rejected-ended", "Rejected Old Show", "2026-01-01", "2026-01-01", { status: "REJECTED" });
});

describe("loadRecentSubmissions", () => {
  it("lists only still-actionable PENDING rows, soonest first, undated last; footer counts the ended", async () => {
    const { rows, endedCount } = await loadRecentSubmissions(db as never, NOW);
    expect(rows.map((r) => r.id)).toEqual(["running", "endstoday", "stjohns", "pine", "nodate"]);
    // No row ends before today.
    for (const r of rows) {
      const last = r.endDate ?? r.startDate;
      if (last) expect(new Date(last).getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 12));
    }
    // The ended footer: exactly the four ended PENDING rows (not the REJECTED one).
    expect(endedCount).toBe(4);
    // Each row carries what the card renders.
    expect(rows.find((r) => r.id === "pine")).toMatchObject({
      datesConfirmed: false,
      promoterName: "Some Promoter",
    });
  });

  it("the first upcoming row by start is the soonest — St. John's comes before Pine State with only dated upcoming rows", async () => {
    raw.prepare("DELETE FROM events WHERE id IN ('running','endstoday','nodate')").run();
    const { rows } = await loadRecentSubmissions(db as never, NOW);
    expect(rows[0].id).toBe("stjohns");
  });

  it("startsSoon flags within 7 days (and a running event), not later or undated", () => {
    const d = (iso: string) => new Date(day(iso) * 1000);
    expect(startsSoon({ startDate: d("2026-11-14"), endDate: null }, NOW)).toBe(true);
    expect(startsSoon({ startDate: d("2026-11-01"), endDate: d("2026-11-30") }, NOW)).toBe(true);
    expect(startsSoon({ startDate: d("2026-11-25"), endDate: null }, NOW)).toBe(false);
    expect(startsSoon({ startDate: null, endDate: null }, NOW)).toBe(false);
  });
});
