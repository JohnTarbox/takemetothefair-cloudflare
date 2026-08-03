/**
 * OPE-308 — the Monday gate and the delta formatting.
 *
 * Pure-function tests: the send path needs D1 + the EMAIL_JOBS queue, but the
 * two decisions that actually govern operator experience — "does this send
 * today" and "what does the delta read as" — are extractable and worth pinning.
 * Getting the gate wrong means either daily mail (the thing being fixed) or
 * silence (worse than what we had).
 */
import { describe, it, expect } from "vitest";
import { decideWeeklyInventory, formatDelta } from "../src/weekly-inventory-notice.js";

// 2026-08-03 is a Monday; 08-04 Tuesday; 08-02 Sunday.
const MONDAY = new Date("2026-08-03T06:00:00Z");
const TUESDAY = new Date("2026-08-04T06:00:00Z");
const SUNDAY = new Date("2026-08-02T06:00:00Z");

describe("decideWeeklyInventory (OPE-308)", () => {
  it("sends on a Monday that hasn't sent yet", () => {
    expect(decideWeeklyInventory(MONDAY, null)).toBe(true);
    expect(decideWeeklyInventory(MONDAY, "2026-07-27")).toBe(true);
  });

  it("does not send twice on the same Monday", () => {
    // The daily cron calls this every day, so the once-per-Monday guard is the
    // only thing standing between "weekly summary" and "another daily email".
    expect(decideWeeklyInventory(MONDAY, "2026-08-03")).toBe(false);
  });

  it("never sends on any other day", () => {
    expect(decideWeeklyInventory(TUESDAY, null)).toBe(false);
    expect(decideWeeklyInventory(SUNDAY, null)).toBe(false);
    expect(decideWeeklyInventory(TUESDAY, "2026-07-27")).toBe(false);
  });

  it("recovers the cadence after a missed week", () => {
    // Date-keyed, not elapsed-days: a Worker outage on one Monday must not
    // shift every subsequent send to a different weekday.
    expect(decideWeeklyInventory(MONDAY, "2026-07-20")).toBe(true);
  });
});

describe("formatDelta (OPE-308)", () => {
  it("shows direction explicitly — the delta is the part worth reading", () => {
    expect(formatDelta(142, 105)).toBe("+37");
    expect(formatDelta(105, 142)).toBe("-37");
    expect(formatDelta(99, 99)).toBe("±0");
  });

  it("renders an em dash on the first run rather than inventing a jump", () => {
    // With no prior week, "+142" would read as growth that never happened.
    expect(formatDelta(142, null)).toBe("—");
  });
});
