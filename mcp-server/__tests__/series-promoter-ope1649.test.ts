/**
 * OPE-1649 — a promoter reassignment follows the event into its series.
 *
 *   - the rule (`decideSeriesPromoterPropagation`), on its own;
 *   - `update_event(promoter_id)` end-to-end on the real DDL: the series row
 *     moves when the rule says so, and the response says what happened when
 *     it does not;
 *   - `update_series(promoter_id)` for the cases the rule leaves to a person;
 *   - drizzle/0419 rehearsed: only the unambiguous placeholder series move, a
 *     re-run is a no-op, and the documented rollback restores them exactly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import {
  COMMUNITY_PROMOTER_ID,
  decideSeriesPromoterPropagation,
} from "@takemetothefair/event-series";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { handleUpdateSeries, planSeriesUpdate } from "../src/tools/admin-update-series.js";
import { eventSeries, events, promoters } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(ROOT, "drizzle/0419_ope1649_series_promoter_backfill.sql"),
  "utf8"
);
const ROLLBACK = (() => {
  // The rollback is the commented statement in the migration header — run the
  // exact text a person would copy, not a re-typed version of it.
  const m = MIGRATION.match(/--\s+UPDATE event_series SET promoter_id[\s\S]*?event_series\.id\);/);
  if (!m) throw new Error("rollback statement not found in the migration header");
  return m[0]
    .split("\n")
    .map((l) => l.replace(/^--\s?/, ""))
    .join("\n");
})();

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

function promoter(id: string) {
  db.insert(promoters)
    .values({ id, companyName: `Promoter ${id}`, slug: unsafeSlug(`p-${id}`) })
    .run();
}
function series(id: string, promoterId: string | null) {
  db.insert(eventSeries)
    .values({ id, canonicalSlug: unsafeSlug(`series-${id}`), name: `Series ${id}`, promoterId })
    .run();
}
function event(
  id: string,
  seriesId: string | null,
  promoterId: string,
  start: string,
  over: Partial<typeof events.$inferInsert> = {}
) {
  db.insert(events)
    .values({
      id,
      name: `Event ${id}`,
      slug: unsafeSlug(`event-${id}`),
      promoterId,
      seriesId,
      status: "APPROVED",
      startDate: new Date(`${start}T12:00:00Z`),
      endDate: new Date(`${start}T12:00:00Z`),
      ...over,
    })
    .run();
}
const seriesPromoter = (id: string) =>
  db.select({ p: eventSeries.promoterId }).from(eventSeries).where(eq(eventSeries.id, id)).all()[0]
    ?.p;

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  promoter(COMMUNITY_PROMOTER_ID);
  promoter("lehoux");
  promoter("old");
  promoter("other");
});
afterEach(() => mock.restore());

describe("the rule", () => {
  const base = { oldEventPromoterId: "old", newEventPromoterId: "new", isLatestEdition: true };
  it.each([
    [{ seriesPromoterId: "new" }, false, "already_set"],
    [{ seriesPromoterId: null }, true, "series_unset"],
    [
      { seriesPromoterId: COMMUNITY_PROMOTER_ID, isLatestEdition: false },
      true,
      "series_placeholder",
    ],
    [{ seriesPromoterId: "old" }, true, "latest_edition"],
    [{ seriesPromoterId: "old", isLatestEdition: false }, false, "not_latest_edition"],
    [{ seriesPromoterId: "other" }, false, "series_owned_by_other_promoter"],
  ] as const)("%o → propagate=%s (%s)", (over, propagate, reason) => {
    expect(decideSeriesPromoterPropagation({ ...base, ...over })).toEqual({ propagate, reason });
  });
});

describe("update_event(promoter_id) carries the change to the series", () => {
  it("the Foster's shape: a placeholder series takes the event's new real promoter", async () => {
    series("s-fosters", COMMUNITY_PROMOTER_ID);
    event("e-fosters", "s-fosters", COMMUNITY_PROMOTER_ID, "2026-12-06");
    // positive landmark: the series starts on the placeholder
    expect(seriesPromoter("s-fosters")).toBe(COMMUNITY_PROMOTER_ID);

    const res = parseJson(
      await server.invoke("update_event", { event_id: "e-fosters", promoter_id: "lehoux" })
    );
    expect(res.series_promoter).toMatchObject({
      seriesId: "s-fosters",
      outcome: "updated",
      reason: "series_placeholder",
      from: COMMUNITY_PROMOTER_ID,
      to: "lehoux",
    });
    expect(seriesPromoter("s-fosters")).toBe("lehoux");
    expect(res.warnings?.series_promoter_not_updated).toBeUndefined();
  });

  it("an organizer change on the LATEST edition moves the series", async () => {
    series("s-fair", "old");
    event("e-2025", "s-fair", "old", "2025-08-10");
    event("e-2026", "s-fair", "old", "2026-08-09");
    const res = parseJson(
      await server.invoke("update_event", { event_id: "e-2026", promoter_id: "lehoux" })
    );
    expect(res.series_promoter).toMatchObject({ outcome: "updated", reason: "latest_edition" });
    expect(seriesPromoter("s-fair")).toBe("lehoux");
  });

  it("a correction to a PAST edition leaves the series alone, and says so", async () => {
    series("s-fair", "old");
    event("e-2025", "s-fair", "old", "2025-08-10");
    event("e-2026", "s-fair", "old", "2026-08-09");
    const res = parseJson(
      await server.invoke("update_event", { event_id: "e-2025", promoter_id: "lehoux" })
    );
    expect(res.series_promoter).toMatchObject({ outcome: "skipped", reason: "not_latest_edition" });
    expect(seriesPromoter("s-fair")).toBe("old");
    expect(res.warnings.series_promoter_not_updated).toContain("update_series(promoter_id)");
  });

  it("a series another promoter owns is not overwritten", async () => {
    series("s-x", "other");
    event("e-x", "s-x", "old", "2026-08-09");
    const res = parseJson(
      await server.invoke("update_event", { event_id: "e-x", promoter_id: "lehoux" })
    );
    expect(res.series_promoter).toMatchObject({
      outcome: "skipped",
      reason: "series_owned_by_other_promoter",
    });
    expect(seriesPromoter("s-x")).toBe("other");
  });

  it("an edit that does not touch promoter_id never reads or writes the series", async () => {
    series("s-y", COMMUNITY_PROMOTER_ID);
    event("e-y", "s-y", "lehoux", "2026-08-09");
    const res = parseJson(
      await server.invoke("update_event", { event_id: "e-y", description: "New words." })
    );
    expect(res.series_promoter).toBeUndefined();
    expect(seriesPromoter("s-y")).toBe(COMMUNITY_PROMOTER_ID);
  });
});

describe("update_series(promoter_id)", () => {
  const row = {
    id: "s",
    canonicalSlug: "s",
    name: "S",
    description: null,
    imageUrl: null,
    categories: "[]",
    tags: "[]",
    promoterId: COMMUNITY_PROMOTER_ID,
  };
  it("plans a promoter change, and refuses an unknown promoter", () => {
    expect(planSeriesUpdate(row, { promoter_id: "lehoux" }).changes.promoter_id).toEqual({
      from: COMMUNITY_PROMOTER_ID,
      to: "lehoux",
    });
    expect(planSeriesUpdate(row, { promoter_id: "nope" }, undefined, false).problems).toEqual([
      'promoter_id "nope" is not a promoter',
    ]);
  });

  it("applies it, audited, and refuses a promoter that does not exist", async () => {
    series("s-z", "old");
    const missing = await handleUpdateSeries(db, ADMIN_AUTH, {
      series_id: "s-z",
      promoter_id: "nope",
      reason: "test",
      dry_run: false,
    });
    expect(missing.applied).toBe(false);
    expect(seriesPromoter("s-z")).toBe("old");

    const ok = await handleUpdateSeries(db, ADMIN_AUTH, {
      series_id: "s-z",
      promoter_id: "lehoux",
      reason: "organizer changed in 2026",
      dry_run: false,
    });
    expect(ok.applied).toBe(true);
    expect(seriesPromoter("s-z")).toBe("lehoux");
    const audit = raw
      .prepare(
        "SELECT payload_json FROM admin_actions WHERE action='series.update' AND target_id='s-z'"
      )
      .all() as Array<{ payload_json: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].payload_json).changes.promoter_id).toEqual({
      from: "old",
      to: "lehoux",
    });
  });
});

describe("drizzle/0419 — the placeholder backfill", () => {
  const backfillAudit = () =>
    raw
      .prepare(
        "SELECT target_id, payload_json FROM admin_actions WHERE action='series.promoter_backfill_ope1649' ORDER BY target_id"
      )
      .all() as Array<{ target_id: string; payload_json: string }>;

  function seed() {
    // A — placeholder series, every live member on one real promoter → MOVES
    series("A", COMMUNITY_PROMOTER_ID);
    event("a1", "A", "lehoux", "2025-12-06");
    event("a2", "A", "lehoux", "2026-12-05");
    // B — placeholder series whose members disagree → stays (review list)
    series("B", COMMUNITY_PROMOTER_ID);
    event("b1", "B", "lehoux", "2025-06-01");
    event("b2", "B", "other", "2026-06-01");
    // C — placeholder series; a merged tombstone on another promoter is ignored → MOVES
    series("C", COMMUNITY_PROMOTER_ID);
    event("c1", "C", "other", "2026-07-04");
    event("c-dup", "C", "lehoux", "2026-07-04", { status: "REJECTED", mergedInto: "c1" });
    // D — a series on a real promoter that disagrees → stays (not this migration's call)
    series("D", "old");
    event("d1", "D", "lehoux", "2026-09-01");
    // E — placeholder series whose only member is ALSO on the placeholder → stays
    series("E", COMMUNITY_PROMOTER_ID);
    event("e1", "E", COMMUNITY_PROMOTER_ID, "2026-10-01");
    // F — placeholder series with no live members → stays
    series("F", COMMUNITY_PROMOTER_ID);
  }

  it("is a no-op on an empty database", () => {
    raw["exec"](MIGRATION);
    expect(backfillAudit()).toEqual([]);
  });

  it("moves exactly the unambiguous rows, audits each, and is idempotent", () => {
    seed();
    raw["exec"](MIGRATION);
    expect(["A", "B", "C", "D", "E", "F"].map((id) => [id, seriesPromoter(id)])).toEqual([
      ["A", "lehoux"],
      ["B", COMMUNITY_PROMOTER_ID],
      ["C", "other"],
      ["D", "old"],
      ["E", COMMUNITY_PROMOTER_ID],
      ["F", COMMUNITY_PROMOTER_ID],
    ]);
    const audit = backfillAudit();
    expect(
      audit.map((a) => [
        a.target_id,
        JSON.parse(a.payload_json).from,
        JSON.parse(a.payload_json).to,
      ])
    ).toEqual([
      ["A", COMMUNITY_PROMOTER_ID, "lehoux"],
      ["C", COMMUNITY_PROMOTER_ID, "other"],
    ]);

    raw["exec"](MIGRATION);
    expect(backfillAudit()).toHaveLength(2);
    expect(seriesPromoter("A")).toBe("lehoux");
  });

  it("the documented rollback restores the moved rows and nothing else", () => {
    seed();
    raw["exec"](MIGRATION);
    // a later, deliberate change to C must survive the rollback
    raw.prepare("UPDATE event_series SET promoter_id='old' WHERE id='C'").run();
    raw["exec"](ROLLBACK);
    expect(seriesPromoter("A")).toBe(COMMUNITY_PROMOTER_ID);
    expect(seriesPromoter("C")).toBe("old");
    expect(seriesPromoter("D")).toBe("old");
  });
});
