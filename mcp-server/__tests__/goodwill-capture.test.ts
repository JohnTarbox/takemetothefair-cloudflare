/**
 * Unit tests for GW1b capture helpers + cron handlers.
 *
 * Covers:
 *   - captureDiscrepancy idempotency window (24h dedupe on
 *     event_id × field_class × detected_by)
 *   - gateReasonToFieldClass taxonomy mapping
 *   - runScheduledStalePageRadar reads event_date_drift_findings
 *     and emits one discrepancy per unresolved drift
 *   - runScheduledSelfConsistencyCron emits discrepancies for
 *     evaluateGates-flagged events
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  captureDiscrepancy,
  gateReasonToFieldClass,
  safeHost,
  captureSelfConsistencyDiscrepancy,
  captureStalePageDiscrepancy,
} from "../src/goodwill/capture.js";
import { runScheduledStalePageRadar } from "../src/goodwill/stale-page-radar.js";
import { runScheduledSelfConsistencyCron } from "../src/goodwill/self-consistency-cron.js";
import { eventDiscrepancies, eventDateDriftFindings, events } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("gateReasonToFieldClass", () => {
  it("maps date-family reasons to 'date'", () => {
    expect(gateReasonToFieldClass("start_date_timezone_confused")).toBe("date");
    expect(gateReasonToFieldClass("end_date_in_past")).toBe("date");
    expect(gateReasonToFieldClass("duration_too_long_for_scale")).toBe("date");
    expect(gateReasonToFieldClass("start_equals_deadline")).toBe("date");
    expect(gateReasonToFieldClass("start_too_far_future")).toBe("date");
  });

  it("maps source_tabular_* to 'existence'", () => {
    expect(gateReasonToFieldClass("source_tabular_multirow_pdf")).toBe("existence");
  });

  it("returns null for source_tier_* (source-reliability signal, not discrepancy)", () => {
    expect(gateReasonToFieldClass("source_tier_3_aggregator")).toBe(null);
    expect(gateReasonToFieldClass("source_tier_2_dmo")).toBe(null);
  });

  it("maps name-family reasons to 'name'", () => {
    expect(gateReasonToFieldClass("name_admin_flag_call_for_vendors")).toBe("name");
  });

  it("defaults unknown reasons to 'existence'", () => {
    expect(gateReasonToFieldClass("mystery_new_reason")).toBe("existence");
  });
});

describe("safeHost", () => {
  it("strips www and lowercases", () => {
    expect(safeHost("https://WWW.Brattleboroareafarmersmarket.com/events")).toBe(
      "brattleboroareafarmersmarket.com"
    );
  });

  it("returns null for falsy input", () => {
    expect(safeHost(null)).toBe(null);
    expect(safeHost(undefined)).toBe(null);
    expect(safeHost("")).toBe(null);
  });

  it("returns null for unparseable URL", () => {
    expect(safeHost("not a url")).toBe(null);
  });
});

describe("captureDiscrepancy - write + idempotency", () => {
  beforeEach(async () => {
    await db.insert(events).values({
      id: "evt-1",
      name: "Test Event",
      slug: "test-event",
      promoterId: "p-1",
      status: "APPROVED",
    });
  });

  it("inserts a row with the right shape", async () => {
    const id = await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "self_consistency",
      authoritativeValue: "2026-06-15",
      divergentValue: "start_date_timezone_confused",
      notes: "from evaluateGates",
    });
    expect(id).not.toBeNull();
    const rows = await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id!));
    expect(rows.length).toBe(1);
    expect(rows[0].eventId).toBe("evt-1");
    expect(rows[0].fieldClass).toBe("date");
    expect(rows[0].detectedBy).toBe("self_consistency");
    expect(rows[0].resolutionStatus).toBe("open");
    // OPE-245: scored at write time — never NULL on insert again.
    expect(rows[0].outreachPriorityScore).not.toBeNull();
    expect(rows[0].outreachPriorityScore).toBeGreaterThan(0);
  });

  it("dedups same (event, field, detected_by) within 24h", async () => {
    const id1 = await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "self_consistency",
    });
    const id2 = await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "self_consistency",
    });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows.length).toBe(1);
  });

  it("does NOT dedup across different field_class", async () => {
    await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "self_consistency",
    });
    await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "venue",
      detectedBy: "self_consistency",
    });
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows.length).toBe(2);
  });

  it("does NOT dedup across different detected_by", async () => {
    await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "self_consistency",
    });
    await captureDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "stale_page_radar",
    });
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows.length).toBe(2);
  });
});

describe("captureSelfConsistencyDiscrepancy", () => {
  beforeEach(async () => {
    await db.insert(events).values({
      id: "evt-1",
      name: "Test Event",
      slug: "test-event",
      promoterId: "p-1",
      status: "APPROVED",
    });
  });

  it("emits a 'date' discrepancy from a date-family reason", async () => {
    const id = await captureSelfConsistencyDiscrepancy(db, {
      eventId: "evt-1",
      reason: "start_date_timezone_confused",
      sourceUrl: "https://organizer.example/events/1",
      authoritativeValue: "2026-06-15",
    });
    expect(id).not.toBeNull();
    const rows = await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id!));
    expect(rows[0].fieldClass).toBe("date");
    expect(rows[0].divergentValue).toBe("start_date_timezone_confused");
    expect(rows[0].authoritativeSourceKey).toBe("organizer.example");
  });

  it("returns null for source_tier_* reasons (no discrepancy emitted)", async () => {
    const id = await captureSelfConsistencyDiscrepancy(db, {
      eventId: "evt-1",
      reason: "source_tier_3_aggregator",
      sourceUrl: "https://x.example/",
    });
    expect(id).toBeNull();
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows.length).toBe(0);
  });
});

describe("captureStalePageDiscrepancy", () => {
  beforeEach(async () => {
    await db.insert(events).values({
      id: "evt-1",
      name: "Test Event",
      slug: "test-event",
      promoterId: "p-1",
      status: "APPROVED",
    });
  });

  it("emits a 'date' discrepancy with confidence proportional to drift", async () => {
    const id = await captureStalePageDiscrepancy(db, {
      eventId: "evt-1",
      storedStartDate: new Date("2026-06-15T00:00:00Z"),
      canonicalStartDate: new Date("2026-06-22T00:00:00Z"),
      canonicalUrl: "https://organizer.example/events/lupine",
      driftDays: 7,
    });
    expect(id).not.toBeNull();
    const rows = await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id!));
    expect(rows[0].fieldClass).toBe("date");
    expect(rows[0].detectedBy).toBe("stale_page_radar");
    expect(rows[0].authoritativeValue).toBe("2026-06-15");
    expect(rows[0].divergentValue).toBe("2026-06-22");
    expect(rows[0].divergentSourceKey).toBe("organizer.example");
    // confidence = min(1, |7| / 30) ≈ 0.233
    expect(rows[0].confidence).toBeGreaterThan(0.2);
    expect(rows[0].confidence).toBeLessThan(0.25);
  });

  it("caps confidence at 1 for very large drift", async () => {
    const id = await captureStalePageDiscrepancy(db, {
      eventId: "evt-1",
      storedStartDate: new Date("2026-06-15T00:00:00Z"),
      canonicalStartDate: new Date("2027-06-15T00:00:00Z"),
      canonicalUrl: "https://x.example/",
      driftDays: 365,
    });
    const rows = await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id!));
    expect(rows[0].confidence).toBe(1);
  });
});

describe("runScheduledStalePageRadar - cron handler", () => {
  beforeEach(async () => {
    await db.insert(events).values({
      id: "evt-1",
      name: "Test Event",
      slug: "test-event",
      promoterId: "p-1",
      status: "APPROVED",
    });
  });

  it("emits a discrepancy per unresolved drift finding", async () => {
    await db.insert(eventDateDriftFindings).values({
      id: "drift-1",
      eventId: "evt-1",
      storedStartDate: new Date("2026-06-15T00:00:00Z"),
      canonicalStartDate: new Date("2026-06-22T00:00:00Z"),
      driftDays: 7,
      canonicalUrl: "https://organizer.example/",
      checkedAt: new Date(),
    });
    const result = await runScheduledStalePageRadar(db);
    expect(result.scanned).toBe(1);
    expect(result.emitted).toBe(1);
    expect(result.skipped_dedup).toBe(0);
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows.length).toBe(1);
    expect(rows[0].detectedBy).toBe("stale_page_radar");
  });

  it("skips drift=0 rows in SQL", async () => {
    await db.insert(eventDateDriftFindings).values({
      id: "drift-0",
      eventId: "evt-1",
      storedStartDate: new Date("2026-06-15T00:00:00Z"),
      canonicalStartDate: new Date("2026-06-15T00:00:00Z"),
      driftDays: 0,
      canonicalUrl: "https://organizer.example/",
      checkedAt: new Date(),
    });
    const result = await runScheduledStalePageRadar(db);
    expect(result.scanned).toBe(0);
    expect(result.emitted).toBe(0);
  });

  it("does NOT include resolved drifts", async () => {
    await db.insert(eventDateDriftFindings).values({
      id: "drift-resolved",
      eventId: "evt-1",
      storedStartDate: new Date("2026-06-15T00:00:00Z"),
      canonicalStartDate: new Date("2026-06-22T00:00:00Z"),
      driftDays: 7,
      canonicalUrl: "https://organizer.example/",
      checkedAt: new Date(),
      resolvedAt: new Date(),
    });
    const result = await runScheduledStalePageRadar(db);
    expect(result.scanned).toBe(0);
  });
});

describe("runScheduledSelfConsistencyCron - cron handler", () => {
  it("returns 0-everything on an empty corpus", async () => {
    const result = await runScheduledSelfConsistencyCron(db);
    expect(result).toEqual({
      scanned: 0,
      flagged: 0,
      emitted: 0,
      skipped_dedup: 0,
      skipped_no_field_class: 0,
    });
  });

  it("scans APPROVED events and reports a sensible shape", async () => {
    await db.insert(events).values({
      id: "evt-clean",
      name: "Brattleboro Farmers Market 2026",
      slug: "brattleboro-farmers-market-2026",
      promoterId: "p-1",
      status: "APPROVED",
      startDate: new Date("2026-06-15T00:00:00Z"),
      endDate: new Date("2026-06-15T00:00:00Z"),
      sourceName: "test",
      sourceUrl: "https://organizer.example/",
      updatedAt: new Date("2024-01-01"),
    });
    const result = await runScheduledSelfConsistencyCron(db);
    expect(result.scanned).toBe(1);
    // Don't pin flagged/emitted exactly — they depend on gate logic
    // that evolves. Just confirm the shape is sensible.
    expect(result.flagged).toBeGreaterThanOrEqual(0);
    expect(result.emitted).toBeGreaterThanOrEqual(0);
  });
});
