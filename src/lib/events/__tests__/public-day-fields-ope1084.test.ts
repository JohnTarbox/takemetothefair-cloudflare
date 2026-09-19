/**
 * OPE-1084 — event_days.internal_notes must not reach the public event page.
 * It did: the loader selected full rows and handed them to a "use client"
 * component, so every note was serialized into the RSC payload.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripPrivateDayFields } from "../public-day-fields";

describe("stripPrivateDayFields — OPE-1084", () => {
  it("nulls internal_notes and keeps every public field", () => {
    const day = {
      id: "evd_x_2026-09-26",
      date: "2026-09-26",
      openTime: "09:00",
      closeTime: "14:00",
      notes: "Opening day",
      internalNotes: "INHERITED (OPE-1078) … submitter@example.com",
    };
    const out = stripPrivateDayFields(day);
    expect(out.internalNotes).toBeNull();
    expect(out).toMatchObject({
      date: "2026-09-26",
      openTime: "09:00",
      closeTime: "14:00",
      notes: "Opening day",
    });
    expect(JSON.stringify(out)).not.toContain("submitter@example.com");
  });
});

describe("the public event loader applies it", () => {
  const src = readFileSync(
    join(__dirname, "../../../app/events/[slug]/event-detail-data.ts"),
    "utf8"
  );
  it("the day query's result goes through stripPrivateDayFields", () => {
    // Call syntax, not the bare symbol: the import line would match that.
    expect(src).toMatch(/\.orderBy\(eventDays\.date\)\s*\)\.map\(stripPrivateDayFields\)/);
  });
  it("no other full-row event_days select remains in the loader", () => {
    const fullRowDaySelects = src.match(/\.select\(\)\s*\.from\(eventDays\)/g) ?? [];
    // Landmark: exactly the one we strip.
    expect(fullRowDaySelects).toHaveLength(1);
  });
});
