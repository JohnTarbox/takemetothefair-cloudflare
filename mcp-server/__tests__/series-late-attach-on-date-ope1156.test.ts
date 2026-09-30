/**
 * OPE-1156 — an undated event is parented when it GAINS a start date.
 *
 * The submit route no longer mints a series for a row with no date. The only
 * later moment parentage is attempted is update_event's late-attach block,
 * which fired on gaining a venue. This pins that it also fires on gaining a
 * date — and only for an event with no series, no prior date, and a venue.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADMIN = readFileSync(join(__dirname, "../src/tools/admin.ts"), "utf8");

describe("OPE-1156 — update_event parents an event when it gains a date", () => {
  it("the late attach fires on gaining a venue OR a date", () => {
    expect(ADMIN).toContain("if (gainedVenue || gainedDate) {");
  });

  it("gainedDate requires a new date, no prior date, no series, and a venue", () => {
    const m = ADMIN.match(/const gainedDate =([\s\S]*?);/);
    expect(m, "gainedDate declaration not found").not.toBeNull();
    const cond = m![1];
    expect(cond).toContain("updates.startDate !== undefined");
    expect(cond).toContain("updates.startDate !== null");
    expect(cond).toContain("!event.startDate");
    expect(cond).toContain("!event.seriesId");
    expect(cond).toContain("!!effectiveVenueId");
  });
});
