/**
 * OPE-366 (R2) — the membrane-crossing ledger gets a reader.
 *
 * The interesting assertions here are the NEGATIVE ones. A detector over
 * `destination_ref IS NULL` is trivially easy to write and would have been
 * wrong: measured 2026-08-13, 8 of the 10 NULL rows were `support-ack` emails
 * that R1 had ALREADY handed off to a `support_obligations` row. The ledger
 * just could not record it. Alarming on those would have produced a second
 * GA4-liveness (97 rows, 96 alerts, green unreachable by construction).
 *
 * So: what must NOT fire matters as much as what must.
 */
import { describe, it, expect } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { membraneCrossings } from "../src/schema.js";
import {
  findUnterminatedCrossings,
  countUnterminatedCrossings,
  ageHoursFrom,
  UNTERMINATED_AGE_HOURS_DEFAULT,
  UNTERMINATED_EXCLUDED_TYPES,
} from "../src/inbound/unterminated-crossings.js";

const NOW = new Date("2026-08-13T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);

async function seed(
  db: TestDb,
  rows: {
    id: string;
    crossingType: string;
    destinationRef?: string | null;
    notes?: string | null;
    ago: number;
  }[]
) {
  for (const r of rows) {
    await db.insert(membraneCrossings).values({
      id: r.id,
      sourceRef: `inbound_email:${r.id}`,
      destinationRef: r.destinationRef ?? null,
      crossingType: r.crossingType,
      actor: "system",
      notes: r.notes ?? null,
      createdAt: hoursAgo(r.ago),
    });
  }
}

describe("OPE-366 — what the detector must NOT flag", () => {
  it("ignores a crossing that reached a destination", async () => {
    const { db } = createTestDb();
    await seed(db, [
      {
        id: "ok",
        crossingType: "email_to_ticket",
        destinationRef: "event:e1",
        notes: "ok-multi",
        ago: 48,
      },
    ]);
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(0);
  });

  it("ignores a support-ack that now carries an obligation destination", async () => {
    // THE case this ticket turned on. Post-fix these self-terminate; a detector
    // that flags them alarms forever on work that was handed off correctly.
    const { db } = createTestDb();
    await seed(db, [
      {
        id: "katie",
        crossingType: "email_to_ticket",
        destinationRef: "support_obligation:o1",
        notes: "support-ack",
        ago: 72,
      },
    ]);
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(0);
  });

  it("excludes email_to_hold — its NULL destination is by design", async () => {
    // A hold is a legitimate resting state awaiting a human, with its own exit
    // (hold_to_resolve) and its own surface (OPE-254). Policing it here would
    // double-report the photo-intake queue.
    const { db } = createTestDb();
    await seed(db, [
      { id: "held", crossingType: "email_to_hold", notes: "photo-intake-held", ago: 240 },
    ]);
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(0);
    expect(UNTERMINATED_EXCLUDED_TYPES).toContain("email_to_hold");
  });

  it("does not flag a fresh NULL crossing — ageing, not just counting", async () => {
    const { db } = createTestDb();
    await seed(db, [{ id: "fresh", crossingType: "email_to_ticket", notes: "no-url", ago: 1 }]);
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(0);
  });
});

describe("OPE-366 — what it must flag", () => {
  it("flags the same row once it crosses the age threshold", async () => {
    const { db } = createTestDb();
    await seed(db, [{ id: "aged", crossingType: "email_to_ticket", notes: "no-url", ago: 7 }]);
    const found = await findUnterminatedCrossings(db, NOW);
    expect(found.map((r) => r.id)).toEqual(["aged"]);
  });

  it("flags a handler failure that went nowhere", async () => {
    // The real prod row: notes = "failed: D1_ERROR: LIKE or GLOB pattern too
    // complex". In scope for DETECTION here; fixing the query is not.
    const { db } = createTestDb();
    await seed(db, [
      {
        id: "d1err",
        crossingType: "email_to_ticket",
        notes: "failed: D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR",
        ago: 80,
      },
    ]);
    const found = await findUnterminatedCrossings(db, NOW);
    expect(found).toHaveLength(1);
    expect(found[0].notes).toContain("D1_ERROR");
  });

  it("polices an UNKNOWN crossing type by default", async () => {
    // Direction matters: a type added later must be covered by default, not
    // silently unwatched. Exclusions are an explicit decision with a reason.
    const { db } = createTestDb();
    await seed(db, [{ id: "novel", crossingType: "some_future_type", ago: 99 }]);
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(1);
  });

  it("reproduces the prod mix: 2 real dead-ends, 8 terminated support-acks", async () => {
    const { db } = createTestDb();
    await seed(db, [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `sup${i}`,
        crossingType: "email_to_ticket",
        destinationRef: `support_obligation:o${i}`,
        notes: "support-ack",
        ago: 80,
      })),
      { id: "nourl", crossingType: "email_to_ticket", notes: "no-url", ago: 80 },
      { id: "failed", crossingType: "email_to_ticket", notes: "failed: D1_ERROR", ago: 80 },
      {
        id: "ok1",
        crossingType: "email_to_ticket",
        destinationRef: "event:e1",
        notes: "ok-multi",
        ago: 80,
      },
    ]);
    const found = await findUnterminatedCrossings(db, NOW);
    // Not vacuously clean — the criterion's INTENT — while correctly leaving
    // the 8 terminated support-acks alone, per John's ruling (a) 2026-08-13.
    expect(found.map((r) => r.id).sort()).toEqual(["failed", "nourl"]);
    expect(await countUnterminatedCrossings(db, NOW)).toBe(2);
  });

  it("orders newest-first — an operator wants what just broke", async () => {
    const { db } = createTestDb();
    await seed(db, [
      { id: "older", crossingType: "email_to_ticket", notes: "no-url", ago: 100 },
      { id: "newer", crossingType: "email_to_ticket", notes: "no-url", ago: 10 },
    ]);
    const found = await findUnterminatedCrossings(db, NOW);
    expect(found.map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("OPE-366 — the threshold is configurable", () => {
  it("falls back to the default on missing or nonsense values", () => {
    expect(ageHoursFrom({})).toBe(UNTERMINATED_AGE_HOURS_DEFAULT);
    expect(ageHoursFrom({ UNTERMINATED_CROSSING_AGE_HOURS: "nope" })).toBe(
      UNTERMINATED_AGE_HOURS_DEFAULT
    );
    // Zero would make every fresh crossing a fault the instant it is written.
    expect(ageHoursFrom({ UNTERMINATED_CROSSING_AGE_HOURS: "0" })).toBe(
      UNTERMINATED_AGE_HOURS_DEFAULT
    );
  });

  it("honours a real override", async () => {
    expect(ageHoursFrom({ UNTERMINATED_CROSSING_AGE_HOURS: "24" })).toBe(24);
    const { db } = createTestDb();
    await seed(db, [{ id: "mid", crossingType: "email_to_ticket", notes: "no-url", ago: 12 }]);
    // Flagged at the 6h default, not flagged at a 24h threshold.
    expect(await findUnterminatedCrossings(db, NOW)).toHaveLength(1);
    expect(await findUnterminatedCrossings(db, NOW, { ageHours: 24 })).toHaveLength(0);
  });
});
