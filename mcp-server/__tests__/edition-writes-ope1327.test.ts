/**
 * OPE-1327 — multi-edition series, the MCP-side write paths:
 *
 *   - K27 rollover buckets a multi-edition series by (series, edition key): the
 *     October edition rolls even though May of the next year already exists.
 *   - set_series_edition_mode: dry-run by default; applies flag + keys + audit
 *     atomically; refuses (writes nothing) on a clash or an undated member;
 *     back to annual keeps the keys (the rollback 301s need them).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, mockIndexNowFetch, CapturingMcpServer, type TestDb } from "./setup-db.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";
import {
  planEditionMode,
  registerSeriesEditionModeTool,
} from "../src/tools/admin-series-edition-mode.js";
import type { AuthContext } from "../src/auth.js";

let db: TestDb;
let raw: Database.Database;
let mock: ReturnType<typeof mockIndexNowFetch>;
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

beforeEach(() => {
  ({ db, raw } = createTestDb());
  mock = mockIndexNowFetch();
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'NEAR', 'near')`).run();
});
afterEach(() => {
  mock.restore();
  raw.close();
});

function seedSeries(id: string, mode: "annual" | "multi") {
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, promoter_id, edition_mode) VALUES (?, ?, 'NEAR-Fest', 'p1', ?)`
    )
    .run(id, `${id}-hub`, mode);
}
function seedMember(
  id: string,
  seriesId: string,
  startIso: string | null,
  key: string | null,
  extra: { status?: string; lifecycle?: string; rrule?: string | null; merged?: string | null } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, series_id, start_date, end_date, status,
         lifecycle_status, recurrence_rule, edition_key, merged_into)
       VALUES (?, 'NEAR-Fest', ?, 'p1', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      seriesId,
      startIso ? sec(startIso) : null,
      startIso ? sec(startIso) + 86400 : null,
      extra.status ?? "APPROVED",
      extra.lifecycle ?? "SCHEDULED",
      extra.rrule ?? null,
      key,
      extra.merged ?? null
    );
}
const keyOf = (id: string) =>
  (raw.prepare("SELECT edition_key k FROM events WHERE id = ?").get(id) as { k: string | null }).k;
const modeOf = (id: string) =>
  (raw.prepare("SELECT edition_mode m FROM event_series WHERE id = ?").get(id) as { m: string }).m;

describe("K27 rollover on a multi-edition series", () => {
  it("rolls October 2026 → 2027-10 although May 2027 (same promoter + name) already exists", async () => {
    seedSeries("s", "multi");
    seedMember("oct26", "s", "2026-10-02T16:00:00Z", "2026-10", {
      lifecycle: "OCCURRED",
      rrule: "FREQ=YEARLY;INTERVAL=1",
    });
    seedMember("may27", "s", "2027-05-15T16:00:00Z", "2027-05");
    const r = await rolloverEventIfRecurring(db, "oct26", {
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(r).toMatchObject({ created: true });
    expect(keyOf(r.newEventId!)).toBe("2027-10");
  });

  it("is idempotent on the edition key: a second roll skips as edition-exists", async () => {
    seedSeries("s", "multi");
    seedMember("oct26", "s", "2026-10-02T16:00:00Z", "2026-10", {
      lifecycle: "OCCURRED",
      rrule: "FREQ=YEARLY;INTERVAL=1",
    });
    seedMember("oct27", "s", "2027-10-01T16:00:00Z", "2027-10");
    expect(
      await rolloverEventIfRecurring(db, "oct26", { now: new Date("2026-10-10T00:00:00Z") })
    ).toEqual({
      created: false,
      skipReason: "edition-exists",
    });
  });

  it("an ANNUAL series keeps the (promoter, name, year) bucket — unchanged", async () => {
    seedSeries("a", "annual");
    seedMember("oct26", "a", "2026-10-02T16:00:00Z", null, {
      lifecycle: "OCCURRED",
      rrule: "FREQ=YEARLY;INTERVAL=1",
    });
    seedMember("may27", "a", "2027-05-15T16:00:00Z", null);
    expect(
      await rolloverEventIfRecurring(db, "oct26", { now: new Date("2026-10-10T00:00:00Z") })
    ).toEqual({
      created: false,
      skipReason: "edition-exists",
    });
  });
});

describe("planEditionMode (pure)", () => {
  const m = (
    id: string,
    start: string | null,
    key: string | null = null,
    status = "APPROVED",
    mergedInto: string | null = null
  ) => ({
    id,
    slug: id,
    status,
    mergedInto,
    startDate: start ? new Date(start) : null,
    editionKey: key,
  });

  it("derives keys for every live member; skips REJECTED rows and tombstones", () => {
    const p = planEditionMode(
      [
        m("may", "2027-05-15T16:00:00Z"),
        m("oct", "2027-10-01T16:00:00Z"),
        m("rej", "2027-05-16T16:00:00Z", null, "REJECTED"),
        m("tomb", "2026-05-16T16:00:00Z", null, "REJECTED", "may"),
      ],
      "multi"
    );
    expect(p.problems).toEqual([]);
    expect(p.examined).toBe(2);
    expect(p.assignments.map((a) => [a.eventId, a.to])).toEqual([
      ["may", "2027-05"],
      ["oct", "2027-10"],
    ]);
  });

  it("refuses a same-month clash until suffixed keys are given", () => {
    const members = [m("a", "2027-05-01T16:00:00Z"), m("b", "2027-05-29T16:00:00Z")];
    expect(planEditionMode(members, "multi").problems).toHaveLength(1);
    const ok = planEditionMode(members, "multi", { b: "2027-05-late" });
    expect(ok.problems).toEqual([]);
    expect(ok.assignments.map((a) => a.to)).toEqual(["2027-05", "2027-05-late"]);
  });

  it("refuses an undated member, a malformed key, and a key for a non-member", () => {
    const p = planEditionMode([m("u", null), m("x", "2027-05-01T16:00:00Z")], "multi", {
      x: "May",
      ghost: "2027-06",
    });
    expect(p.problems.join("\n")).toMatch(/u has no start date/);
    expect(p.problems.join("\n")).toMatch(/"May" is not/);
    expect(p.problems.join("\n")).toMatch(/ghost/);
  });

  it("keeps a key a member already holds (no write)", () => {
    const p = planEditionMode([m("may", "2027-05-15T16:00:00Z", "2027-05")], "multi");
    expect(p.assignments).toEqual([]);
    expect(p.unchanged).toEqual([{ eventId: "may", slug: "may", key: "2027-05" }]);
  });

  it("annual: flag only — no assignments, no problems", () => {
    expect(planEditionMode([m("u", null)], "annual")).toMatchObject({
      assignments: [],
      problems: [],
    });
  });
});

describe("set_series_edition_mode (tool)", () => {
  let server: CapturingMcpServer;
  const call = async (params: Record<string, unknown>) => {
    const res = (await server.handlers.get("set_series_edition_mode")!(params)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  };
  const audits = () =>
    raw
      .prepare("SELECT count(*) n FROM admin_actions WHERE action = 'series.edition_mode_set'")
      .get() as { n: number };

  beforeEach(() => {
    server = new CapturingMcpServer();
    registerSeriesEditionModeTool(server as never, db, {
      role: "ADMIN",
      userId: "admin-1",
    } as AuthContext);
    seedSeries("s", "annual");
    seedMember("may", "s", "2027-05-15T16:00:00Z", null);
    seedMember("oct", "s", "2027-10-01T16:00:00Z", null);
  });

  it("is a DRY RUN by default: returns the plan, writes nothing", async () => {
    const r = await call({ series_id: "s", mode: "multi" });
    expect(r).toMatchObject({ applied: false, dry_run: true, examined_live_members: 2 });
    expect(modeOf("s")).toBe("annual");
    expect(keyOf("may")).toBeNull();
    expect(audits().n).toBe(0);
  });

  it("dry_run:false applies the flag, every key and the audit row together", async () => {
    const r = await call({ series_id: "s", mode: "multi", dry_run: false, reason: "test" });
    expect(r).toMatchObject({ applied: true });
    expect(modeOf("s")).toBe("multi");
    expect([keyOf("may"), keyOf("oct")]).toEqual(["2027-05", "2027-10"]);
    expect(audits().n).toBe(1);
  });

  it("a clash refuses EVERYTHING — not even the flag moves", async () => {
    seedMember("may2", "s", "2027-05-29T16:00:00Z", null);
    const r = await call({ series_id: "s", mode: "multi", dry_run: false });
    expect(r).toMatchObject({ applied: false });
    expect((r.problems as string[]).length).toBe(1);
    expect(modeOf("s")).toBe("annual");
    expect(keyOf("may")).toBeNull();
    expect(audits().n).toBe(0);
  });

  it("back to annual keeps the keys (the rollback 301s read them)", async () => {
    await call({ series_id: "s", mode: "multi", dry_run: false });
    await call({ series_id: "s", mode: "annual", dry_run: false });
    expect(modeOf("s")).toBe("annual");
    expect(keyOf("may")).toBe("2027-05");
  });
});
