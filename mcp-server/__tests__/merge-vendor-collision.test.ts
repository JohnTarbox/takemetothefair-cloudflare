/**
 * OPE-451 scope 3 — the one part of `merge_vendor` that is not a
 * copy of `merge_venue`.
 *
 * `event_vendors` carries TWO unique indexes — `idx_eventvendors_series_unique`
 * on (event_id, vendor_id) for series-wide rows, and
 * `idx_eventvendors_perday_unique` on (event_id, vendor_id, event_day_id) for
 * per-day rows. So the obvious implementation,
 *
 *     UPDATE event_vendors SET vendor_id = keeper WHERE vendor_id = duplicate
 *
 * throws the moment both vendors are linked to the same event.
 *
 * CORRECTION (2026-08-20, from actually running the merge): this file used to
 * say the reported pair "behaves exactly that way". It does not. `dc755ad9` was
 * on the AUTUMN show and its keeper `4e1032cb` on the SPRING one, so the live
 * merge transferred 1 link and dropped 0. The collision case is real and worth
 * planning for — the unique indexes below prove it — but it was not what the
 * reported pair did, and the claim should not have been stated as observed.
 *
 * `merge_venue` never had to think about this, because `events.venue_id` has no
 * such constraint — which is precisely why copying that tool wholesale would
 * have produced a merge that fails on the first real pair anyone tried.
 *
 * These run against real in-memory SQLite WITH the unique indexes created, so a
 * planner that mis-classified a row would surface as a constraint violation
 * rather than a silently wrong count.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { planEventVendorTransfer } from "../src/tools/admin-merge-vendor.js";

const SCHEMA_SQL = `
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    event_day_id TEXT,
    status TEXT
  );
  CREATE UNIQUE INDEX idx_eventvendors_series_unique
    ON event_vendors(event_id, vendor_id) WHERE event_day_id IS NULL;
  CREATE UNIQUE INDEX idx_eventvendors_perday_unique
    ON event_vendors(event_id, vendor_id, event_day_id) WHERE event_day_id IS NOT NULL;
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function link(id: string, eventId: string, vendorId: string, dayId: string | null = null) {
  raw
    .prepare(
      `INSERT INTO event_vendors (id, event_id, vendor_id, event_day_id, status)
       VALUES (?,?,?,?, 'CONFIRMED')`
    )
    .run(id, eventId, vendorId, dayId);
}

/** Apply the plan exactly as the tool does, so the indexes judge it. */
function applyPlan(plan: { transferable: string[]; colliding: string[] }, keeperId: string) {
  for (const id of plan.transferable) {
    raw.prepare(`UPDATE event_vendors SET vendor_id = ? WHERE id = ?`).run(keeperId, id);
  }
  for (const id of plan.colliding) {
    raw.prepare(`DELETE FROM event_vendors WHERE id = ?`).run(id);
  }
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the collision shape — both vendors on the same event", () => {
  beforeEach(() => {
    link("keep-link", "defe4089", "4e1032cb");
    link("dup-link", "defe4089", "dc755ad9");
  });

  it("classifies the duplicate's link as colliding, not transferable", async () => {
    const plan = await planEventVendorTransfer(db, "4e1032cb", "dc755ad9");
    expect(plan.transferable).toEqual([]);
    expect(plan.colliding).toEqual(["dup-link"]);
  });

  it("applying the plan does not violate the unique index", async () => {
    // The whole point. A blind UPDATE here throws SQLITE_CONSTRAINT.
    const plan = await planEventVendorTransfer(db, "4e1032cb", "dc755ad9");
    expect(() => applyPlan(plan, "4e1032cb")).not.toThrow();
    const rows = raw.prepare(`SELECT vendor_id FROM event_vendors`).all();
    expect(rows).toEqual([{ vendor_id: "4e1032cb" }]); // exactly one link survives
  });

  it("a blind UPDATE really would have thrown (guards the premise)", () => {
    // If this ever stops throwing, the unique indexes have changed and the
    // planner's complexity is no longer earning its keep.
    expect(() =>
      raw
        .prepare(`UPDATE event_vendors SET vendor_id = ? WHERE vendor_id = ?`)
        .run("4e1032cb", "dc755ad9")
    ).toThrow();
  });
});

describe("links the keeper does not have are transferred", () => {
  it("moves a link for an event the keeper is absent from", async () => {
    link("keep-link", "event-A", "keeper");
    link("dup-link", "event-B", "dup");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.transferable).toEqual(["dup-link"]);
    expect(plan.colliding).toEqual([]);
    applyPlan(plan, "keeper");
    const n = raw
      .prepare(`SELECT COUNT(*) c FROM event_vendors WHERE vendor_id='keeper'`)
      .get() as {
      c: number;
    };
    expect(n.c).toBe(2);
  });

  it("handles a mix in one merge", async () => {
    link("k1", "event-A", "keeper");
    link("d1", "event-A", "dup"); // collides
    link("d2", "event-B", "dup"); // transfers
    link("d3", "event-C", "dup"); // transfers
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.colliding).toEqual(["d1"]);
    expect(plan.transferable.sort()).toEqual(["d2", "d3"]);
    expect(plan.dupLinkCount).toBe(3);
    expect(() => applyPlan(plan, "keeper")).not.toThrow();
  });
});

describe("per-day links (K18) are keyed including the day", () => {
  it("does not treat different days on one event as a collision", async () => {
    // Series-wide and per-day rows are separately unique, so a day-scoped link
    // can move even when the keeper is on the same event on ANOTHER day.
    link("k1", "event-A", "keeper", "day-1");
    link("d1", "event-A", "dup", "day-2");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.transferable).toEqual(["d1"]);
    expect(() => applyPlan(plan, "keeper")).not.toThrow();
  });

  it("DOES treat the same day on the same event as a collision", async () => {
    link("k1", "event-A", "keeper", "day-1");
    link("d1", "event-A", "dup", "day-1");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.colliding).toEqual(["d1"]);
    expect(() => applyPlan(plan, "keeper")).not.toThrow();
  });

  it("does not confuse a series-wide link with a per-day one", async () => {
    // event_day_id NULL vs set are governed by different indexes; collapsing
    // them into one key would drop a link that could legally have moved.
    link("k1", "event-A", "keeper", null);
    link("d1", "event-A", "dup", "day-1");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.transferable).toEqual(["d1"]);
    expect(() => applyPlan(plan, "keeper")).not.toThrow();
  });
});

describe("degenerate inputs", () => {
  it("returns empty plans when the duplicate has no links", async () => {
    link("k1", "event-A", "keeper");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan).toEqual({ transferable: [], colliding: [], dupLinkCount: 0 });
  });

  it("transfers everything when the keeper has no links at all", async () => {
    link("d1", "event-A", "dup");
    link("d2", "event-B", "dup");
    const plan = await planEventVendorTransfer(db, "keeper", "dup");
    expect(plan.transferable.sort()).toEqual(["d1", "d2"]);
    expect(() => applyPlan(plan, "keeper")).not.toThrow();
  });
});

/**
 * OPE-451 — keeper-direction warning.
 *
 * The five pre-existing pairs on the ticket all previewed with zero risk
 * (1 link, 0 dropped, 0 warnings). One of them, Little Cat Metals, was still
 * wrong: the keeper held `little-cat-metals-1` and the duplicate held the clean
 * `little-cat-metals`. Nothing in the output said so.
 */
describe("slugDirectionWarning (OPE-451)", () => {
  it("warns when the keeper carries the numeric suffix and the duplicate does not", async () => {
    const { slugDirectionWarning } = await import("../src/tools/admin-merge-vendor.js");
    const w = slugDirectionWarning("little-cat-metals-1", "little-cat-metals");
    expect(w).toContain("SLUG DIRECTION");
    expect(w).toContain("little-cat-metals-1");
  });

  it("is silent for the normal direction — keeper clean, duplicate suffixed", async () => {
    const { slugDirectionWarning } = await import("../src/tools/admin-merge-vendor.js");
    // The two merges actually executed on 2026-08-20 were both this shape.
    expect(slugDirectionWarning("salvage-sistas", "salvage-sistas-1")).toBeNull();
    expect(
      slugDirectionWarning("time-to-be-candle-company", "time-to-be-candle-company-1")
    ).toBeNull();
  });

  it("is silent when BOTH are suffixed — nothing to prefer between them", async () => {
    const { slugDirectionWarning } = await import("../src/tools/admin-merge-vendor.js");
    expect(slugDirectionWarning("acme-2", "acme-3")).toBeNull();
  });

  it("does not fire on a slug that merely ends in a year", async () => {
    const { slugDirectionWarning } = await import("../src/tools/admin-merge-vendor.js");
    // A vendor slug ending in digits without a hyphen is not a dedup suffix.
    expect(slugDirectionWarning("studio1999", "studio")).toBeNull();
  });
});
