/**
 * OPE-1562 — create_series: a standalone recurring event gets its series, so a
 * dates-TBD future edition can be staged under it. The specimen is the
 * Connors Waterville fairs (2026-11-02): one edition each, no parent, and no
 * tool that could mint one without a gated env flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, CapturingMcpServer, type TestDb } from "./setup-db.js";
import {
  planPromoteToSeries,
  registerCreateSeriesTool,
  type PromoteCandidate,
} from "../src/tools/admin-create-series.js";
import type { AuthContext } from "../src/auth.js";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

const call = async (params: Record<string, unknown>) => {
  const res = (await server.handlers.get("create_series")!(params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
};
const seriesOf = (id: string) =>
  (raw.prepare("SELECT series_id FROM events WHERE id = ?").get(id) as { series_id: string | null })
    .series_id;
const seriesCount = () =>
  (raw.prepare("SELECT count(*) n FROM event_series").get() as { n: number }).n;
const audits = () =>
  (
    raw.prepare("SELECT count(*) n FROM admin_actions WHERE action = 'series.promote'").get() as {
      n: number;
    }
  ).n;

function seedEvent(
  id: string,
  name: string,
  venue: string | null,
  extra: { series?: string; status?: string; merged?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, venue_id, series_id, status, merged_into)
       VALUES (?, ?, ?, 'p1', ?, ?, ?, ?)`
    )
    .run(
      id,
      name,
      id,
      venue,
      extra.series ?? null,
      extra.status ?? "APPROVED",
      extra.merged ?? null
    );
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw
    .prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'Connors', 'connors')`)
    .run();
  raw
    .prepare(`INSERT INTO venues (id, name, slug) VALUES ('bw', 'Best Western Waterville', 'bw')`)
    .run();
  raw.prepare(`INSERT INTO venues (id, name, slug) VALUES ('ot', 'Orono Grange', 'ot')`).run();
  server = new CapturingMcpServer();
  registerCreateSeriesTool(server as never, db, {
    role: "ADMIN",
    userId: "admin-1",
  } as AuthContext);
});
afterEach(() => raw.close());

describe("planPromoteToSeries (pure)", () => {
  const c = (id: string, over: Partial<PromoteCandidate> = {}): PromoteCandidate => ({
    id,
    name: "Holiday Craft & Vendor Fair",
    slug: id,
    status: "APPROVED",
    venueId: "bw",
    promoterId: "p1",
    seriesId: null,
    mergedInto: null,
    ...over,
  });

  it("one standalone event is a valid plan — no two-occurrence minimum", () => {
    const p = planPromoteToSeries(["a"], [c("a")]);
    expect(p).toMatchObject({ problems: [], examined: 1 });
    expect(p.toAttach.map((e) => e.id)).toEqual(["a"]);
  });

  it("refuses unknown, tombstone, REJECTED and venue-less ids, naming each", () => {
    const p = planPromoteToSeries(
      ["x", "t", "r", "nv"],
      [c("t", { mergedInto: "k" }), c("r", { status: "REJECTED" }), c("nv", { venueId: null })]
    );
    expect(p.problems).toHaveLength(4);
    expect(p.problems.join("|")).toMatch(/x is not an event.*tombstone.*REJECTED.*no venue/);
    expect(p.examined).toBe(4);
  });

  it("two fairs at one venue would be two series — refused, not merged", () => {
    const p = planPromoteToSeries(
      ["h", "s"],
      [c("h"), c("s", { name: "St Patrick's Day Craft and Vendor Fair" })]
    );
    expect(p.problems.join()).toMatch(/2 separate series/);
  });

  it("an event already in a series is reported and never planned for attach", () => {
    const p = planPromoteToSeries(["in"], [c("in", { seriesId: "s1" })]);
    expect(p.alreadyInSeries).toEqual([{ id: "in", slug: "in", seriesId: "s1" }]);
    expect(p.toAttach).toEqual([]);
    expect(p.problems.join()).toMatch(/nothing to do/);
  });
});

describe("create_series (tool)", () => {
  it("is a DRY RUN by default: previews the new series, writes nothing", async () => {
    seedEvent("hol", "Holiday Craft & Vendor Fair 2026", "bw");
    const r = await call({ event_ids: ["hol"] });
    expect(r).toMatchObject({
      applied: false,
      dry_run: true,
      outcome: "would_create",
      series_name: "Holiday Craft & Vendor Fair",
      problems: [],
    });
    expect(seriesOf("hol")).toBeNull();
    expect(seriesCount()).toBe(0);
    expect(audits()).toBe(0);
  });

  it("dry_run:false mints the series for ONE standalone event, audits, and reads back", async () => {
    seedEvent("hol", "Holiday Craft & Vendor Fair", "bw");
    const r = await call({ event_ids: ["hol"], dry_run: false, reason: "OPE-1562 test" });
    expect(r).toMatchObject({ applied: true, results: [{ id: "hol", outcome: "created" }] });
    const sid = seriesOf("hol");
    expect(sid).toBeTruthy();
    expect((r.series as { id: string }).id).toBe(sid);
    expect(String(r.next)).toContain(`create_occurrence({ series_id: "${sid}"`);
    expect(seriesCount()).toBe(1);
    expect(audits()).toBe(1);
  });

  it("JOINS an existing series for the same fair at the same venue (dedup), never duplicates", async () => {
    raw
      .prepare(
        `INSERT INTO event_series (id, canonical_slug, name, venue_id, promoter_id) VALUES ('s-hol', 'holiday-craft-vendor-fair', 'Holiday Craft & Vendor Fair', 'bw', 'p1')`
      )
      .run();
    seedEvent("hol", "Holiday Craft & Vendor Fair 2026", "bw");
    const dry = await call({ event_ids: ["hol"] });
    expect(dry).toMatchObject({ outcome: "would_match", series_id: "s-hol" });
    const r = await call({ event_ids: ["hol"], dry_run: false });
    expect(r).toMatchObject({ applied: true, results: [{ id: "hol", outcome: "matched" }] });
    expect(seriesOf("hol")).toBe("s-hol");
    expect(seriesCount()).toBe(1);
  });

  it("several editions of one fair land in ONE series", async () => {
    seedEvent("hol25", "Holiday Craft & Vendor Fair 2025", "bw");
    seedEvent("hol26", "Holiday Craft & Vendor Fair 2026", "bw");
    const r = await call({ event_ids: ["hol25", "hol26"], dry_run: false });
    expect(r).toMatchObject({ applied: true });
    expect(seriesOf("hol25")).toBe(seriesOf("hol26"));
    expect(seriesCount()).toBe(1);
  });

  it("refuses a mixed group and writes NOTHING (no series, no attach, no audit)", async () => {
    seedEvent("hol", "Holiday Craft & Vendor Fair", "bw");
    seedEvent("pat", "St Patrick's Day Craft and Vendor Fair", "bw");
    const r = await call({ event_ids: ["hol", "pat"], dry_run: false });
    expect(r).toMatchObject({ applied: false });
    expect(seriesOf("hol")).toBeNull();
    expect(seriesOf("pat")).toBeNull();
    expect(seriesCount()).toBe(0);
    expect(audits()).toBe(0);
  });

  it("never re-parents: an event already in a series keeps it", async () => {
    raw
      .prepare(
        `INSERT INTO event_series (id, canonical_slug, name, venue_id) VALUES ('s-other', 'other', 'Other', 'ot')`
      )
      .run();
    seedEvent("hol", "Holiday Craft & Vendor Fair", "bw", { series: "s-other" });
    const r = await call({ event_ids: ["hol"], dry_run: false });
    expect(r).toMatchObject({
      applied: false,
      already_in_series: [{ id: "hol", seriesId: "s-other" }],
    });
    expect(seriesOf("hol")).toBe("s-other");
  });

  it("is admin-only: a non-admin session registers no tool", () => {
    const s = new CapturingMcpServer();
    registerCreateSeriesTool(s as never, db, { role: "USER", userId: "u" } as AuthContext);
    expect(s.handlers.has("create_series")).toBe(false);
  });
});
