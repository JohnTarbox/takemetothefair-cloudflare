/**
 * OPE-191 — the past-date guard is the load-bearing bit (the ticket says
 * lifecycle_status alone let dead events through), so the date-boundary helpers
 * are pinned here. The full query is exercised in integration; these lock the
 * pure boundaries the SQL is built from.
 */
import { describe, it, expect } from "vitest";
import { startOfUtcDay, weekAgo } from "../new-this-week";

describe("selection boundaries", () => {
  it("startOfUtcDay drops the time — an event earlier today still counts", () => {
    const d = startOfUtcDay(new Date("2026-07-16T18:30:00Z"));
    expect(d.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("weekAgo is exactly 7 days before now", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    expect(weekAgo(now).toISOString()).toBe("2026-07-09T12:00:00.000Z");
  });
});
