/**
 * Tests the event_date_drift rule's per-event dedupe logic.
 *
 * Background (2026-05-19): the daily re-verification cron inserts a new
 * row in event_date_drift_findings each time it detects drift, without
 * deduping against existing unresolved findings for the same event. The
 * rule's SELECT JOINs that table, so a single event with two unresolved
 * findings produces two ItemMatch rows with the same targetId, which
 * trips the UNIQUE constraint on recommendation_items (rule_id,
 * target_id) when scanAll INSERTs the second one.
 *
 * Rule-level fix: dedupe by eventId after the SELECT, picking the row
 * with the highest driftDays per event (most severe wins). The engine
 * also Set-dedupes as a belt-and-suspenders safety net.
 *
 * These tests exercise the dedupe shape via a small helper that mirrors
 * the rule's logic in isolation.
 */
import { describe, expect, it } from "vitest";

interface RawRow {
  findingId: string;
  eventId: string;
  driftDays: number | null;
  eventName: string;
}

/** Mirrors the rule's in-memory dedupe. Kept in sync via comment in
 *  event-date-drift.ts referencing this test file. */
function pickBestPerEvent(rows: RawRow[]): RawRow[] {
  const bestByEvent = new Map<string, RawRow>();
  for (const r of rows) {
    const existing = bestByEvent.get(r.eventId);
    if (
      !existing ||
      (r.driftDays ?? 0) > (existing.driftDays ?? 0) ||
      ((r.driftDays ?? 0) === (existing.driftDays ?? 0) && r.findingId > existing.findingId)
    ) {
      bestByEvent.set(r.eventId, r);
    }
  }
  return [...bestByEvent.values()];
}

describe("event_date_drift rule dedupe", () => {
  it("passes through one finding per event unchanged", () => {
    const rows: RawRow[] = [
      { findingId: "f-1", eventId: "evt-a", driftDays: 2, eventName: "A" },
      { findingId: "f-2", eventId: "evt-b", driftDays: 3, eventName: "B" },
    ];
    const out = pickBestPerEvent(rows);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.eventId).sort()).toEqual(["evt-a", "evt-b"]);
  });

  it("picks the largest driftDays when multiple findings exist for one event", () => {
    const rows: RawRow[] = [
      { findingId: "f-old", eventId: "evt-a", driftDays: 2, eventName: "A" },
      { findingId: "f-new", eventId: "evt-a", driftDays: 5, eventName: "A" },
      { findingId: "f-mid", eventId: "evt-a", driftDays: 3, eventName: "A" },
    ];
    const out = pickBestPerEvent(rows);
    expect(out).toHaveLength(1);
    expect(out[0].findingId).toBe("f-new");
    expect(out[0].driftDays).toBe(5);
  });

  it("breaks driftDays ties deterministically (lex-higher findingId wins)", () => {
    const rows: RawRow[] = [
      { findingId: "f-aaa", eventId: "evt-a", driftDays: 4, eventName: "A" },
      { findingId: "f-zzz", eventId: "evt-a", driftDays: 4, eventName: "A" },
    ];
    const out = pickBestPerEvent(rows);
    expect(out).toHaveLength(1);
    expect(out[0].findingId).toBe("f-zzz"); // lex-higher wins on tie
  });

  it("handles null driftDays gracefully (treats as 0)", () => {
    const rows: RawRow[] = [
      { findingId: "f-null", eventId: "evt-a", driftDays: null, eventName: "A" },
      { findingId: "f-3", eventId: "evt-a", driftDays: 3, eventName: "A" },
    ];
    const out = pickBestPerEvent(rows);
    expect(out).toHaveLength(1);
    expect(out[0].driftDays).toBe(3);
  });

  it("handles the canonical 2026-05-19 incident shape (5 events x 2 findings)", () => {
    const eventIds = ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"];
    const rows: RawRow[] = [];
    for (const id of eventIds) {
      rows.push({ findingId: `${id}-f1`, eventId: id, driftDays: 1, eventName: id });
      rows.push({ findingId: `${id}-f2`, eventId: id, driftDays: 3, eventName: id });
    }
    const out = pickBestPerEvent(rows);
    expect(out).toHaveLength(5);
    // Each event should have its higher-drift finding picked.
    for (const r of out) {
      expect(r.driftDays).toBe(3);
      expect(r.findingId).toMatch(/-f2$/);
    }
  });

  it("returns empty array when no findings", () => {
    expect(pickBestPerEvent([])).toEqual([]);
  });
});
