/**
 * OPE-1032 — the self-consistency cron closes rows its retuned gate no longer
 * fires, feeds the gate the exemption inputs it was starved of, and does not
 * re-file a condition a person already adjudicated on an unchanged value.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  runScheduledSelfConsistencyCron,
  SUPERSEDED_BY_REEVALUATION,
} from "../src/goodwill/self-consistency-cron.js";
import { captureSelfConsistencyDiscrepancy } from "../src/goodwill/capture.js";
import { eventDiscrepancies, events } from "../src/schema.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

async function seedEvent(
  id: string,
  over: Partial<typeof events.$inferInsert> = {}
): Promise<void> {
  await db.insert(events).values({
    id,
    name: "Test Fair",
    slug: id,
    promoterId: "p-1",
    status: "APPROVED",
    startDate: new Date("2027-08-14T12:00:00Z"),
    endDate: new Date("2027-08-15T12:00:00Z"),
    sourceName: "organizer",
    sourceUrl: "https://organizer.example/fair",
    updatedAt: new Date("2024-01-01"),
    ...over,
  });
}

function seedOpenRow(id: string, eventId: string, reason: string, fieldClass = "date"): void {
  raw
    .prepare(
      `INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at, divergent_value, resolution_status, created_at)
       VALUES (?, ?, ?, 'self_consistency', 1789000000, ?, 'open', 1789000000)`
    )
    .run(id, eventId, fieldClass, reason);
}

const statusOf = async (id: string) =>
  (await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id)))[0]
    ?.resolutionStatus;

describe("re-evaluation closes rows the gate no longer fires", () => {
  it("closes a tz row on a summer 04:00Z start (a canonical shape), keeps one that still fires", async () => {
    await seedEvent("e-summer-midnight", { startDate: new Date("2027-08-14T04:00:00Z") });
    await seedEvent("e-utc-midnight", { startDate: new Date("2027-08-14T00:00:00Z") });
    seedOpenRow("d-1", "e-summer-midnight", "start_date_timezone_confused");
    seedOpenRow("d-2", "e-utc-midnight", "start_date_timezone_confused");

    const r = await runScheduledSelfConsistencyCron(db);
    expect(r.scanned).toBe(2); // landmark: both events were evaluated
    expect(await statusOf("d-1")).toBe(SUPERSEDED_BY_REEVALUATION);
    expect(await statusOf("d-2")).toBe("open");
    expect(r.superseded).toBe(1);
  });

  it("closes an em-dash row on a town qualifier (the 09-15 re-trip specimen)", async () => {
    await seedEvent("e-town", { name: "Rhode Island Home Show — West Kingston RI" });
    seedOpenRow("d-3", "e-town", "name_em_dash_subvenue", "name");
    await runScheduledSelfConsistencyCron(db);
    expect(await statusOf("d-3")).toBe(SUPERSEDED_BY_REEVALUATION);
  });

  it("passes the exemption inputs: a discontinuous season no longer fires duration_too_long_for_scale", async () => {
    await seedEvent("e-season", {
      startDate: new Date("2027-05-01T12:00:00Z"),
      endDate: new Date("2027-10-30T12:00:00Z"),
      discontinuousDates: true,
    });
    seedOpenRow("d-4", "e-season", "duration_too_long_for_scale");
    await runScheduledSelfConsistencyCron(db);
    expect(await statusOf("d-4")).toBe(SUPERSEDED_BY_REEVALUATION);
  });

  it("LANDMARK: the same long span with no exemption keeps its row open", async () => {
    await seedEvent("e-long", {
      startDate: new Date("2027-05-01T12:00:00Z"),
      endDate: new Date("2027-10-30T12:00:00Z"),
    });
    seedOpenRow("d-5", "e-long", "duration_too_long_for_scale");
    await runScheduledSelfConsistencyCron(db);
    expect(await statusOf("d-5")).toBe("open");
  });

  it("never closes an end_date_in_past row — the lifecycle sweep owns it", async () => {
    await seedEvent("e-clean");
    seedOpenRow("d-6", "e-clean", "end_date_in_past");
    await runScheduledSelfConsistencyCron(db);
    expect(await statusOf("d-6")).toBe("open");
  });
});

describe("an adjudicated condition is not re-filed while its value is unchanged", () => {
  it("skips a dismissed (event, reason, value) and files again once the value changes", async () => {
    await seedEvent("e-adj");
    raw
      .prepare(
        `INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at, divergent_value, authoritative_value, resolution_status, created_at)
         VALUES ('d-old', 'e-adj', 'name', 'self_consistency', 1789000000, 'name_em_dash_subvenue', 'Fair — Arts Alley', 'dismissed', 1789000000)`
      )
      .run();

    const same = await captureSelfConsistencyDiscrepancy(db, {
      eventId: "e-adj",
      reason: "name_em_dash_subvenue",
      sourceUrl: null,
      authoritativeValue: "Fair — Arts Alley",
    });
    expect(same).toBeNull();

    const changed = await captureSelfConsistencyDiscrepancy(db, {
      eventId: "e-adj",
      reason: "name_em_dash_subvenue",
      sourceUrl: null,
      authoritativeValue: "Fair — Kids Tent",
    });
    expect(changed).not.toBeNull();
  });
});
