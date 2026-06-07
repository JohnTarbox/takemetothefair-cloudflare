/**
 * F — K18 Phase 2 (2026-06-06): tests for the per-occurrence vendor
 * grouping helper. The semantics are load-bearing for the event detail
 * page render AND the JSON-LD subEvent emitter, so we exercise the edge
 * cases once here rather than in each consumer.
 */
import { describe, it, expect } from "vitest";
import { groupVendorsByDay, formatOccurrenceDate } from "../k18-vendor-grouping";

interface TestVendor {
  id: string;
  eventDayId: string | null;
}

const days = [
  { id: "day-2026-07-04", date: "2026-07-04" },
  { id: "day-2026-08-01", date: "2026-08-01" },
  { id: "day-2026-09-05", date: "2026-09-05" },
];

describe("formatOccurrenceDate", () => {
  it("formats YYYY-MM-DD as a readable weekday + month + day", () => {
    // 2026-07-04 is a Saturday.
    expect(formatOccurrenceDate("2026-07-04")).toBe("Saturday, July 4");
  });

  it("returns the input unchanged when the format is unrecognized", () => {
    expect(formatOccurrenceDate("not-a-date")).toBe("not-a-date");
    expect(formatOccurrenceDate("2026/07/04")).toBe("2026/07/04");
  });
});

describe("groupVendorsByDay", () => {
  it("returns empty array for empty vendor list", () => {
    expect(groupVendorsByDay<TestVendor>([], days)).toEqual([]);
  });

  it("renders flat (no heading) when all vendors are series-wide AND event has <= 1 day", () => {
    const vendors: TestVendor[] = [
      { id: "v1", eventDayId: null },
      { id: "v2", eventDayId: null },
    ];
    const groups = groupVendorsByDay(vendors, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe("");
    expect(groups[0].eventDayId).toBeNull();
    expect(groups[0].vendors.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("renders flat when all vendors are series-wide AND event has exactly 1 day", () => {
    const vendors: TestVendor[] = [{ id: "v1", eventDayId: null }];
    const groups = groupVendorsByDay(vendors, [{ id: "d1", date: "2026-07-04" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe("");
  });

  it("shows 'Regular participants' heading when some vendors are per-day AND some are series-wide", () => {
    const vendors: TestVendor[] = [
      { id: "v1", eventDayId: null },
      { id: "v2", eventDayId: "day-2026-07-04" },
    ];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups).toHaveLength(2);
    expect(groups[0].heading).toBe("Regular participants");
    expect(groups[0].vendors.map((v) => v.id)).toEqual(["v1"]);
    expect(groups[1].heading).toBe("Saturday, July 4");
    expect(groups[1].vendors.map((v) => v.id)).toEqual(["v2"]);
  });

  it("sorts per-day groups chronologically regardless of input order", () => {
    const vendors: TestVendor[] = [
      { id: "v-sep", eventDayId: "day-2026-09-05" },
      { id: "v-jul", eventDayId: "day-2026-07-04" },
      { id: "v-aug", eventDayId: "day-2026-08-01" },
    ];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups.map((g) => g.date)).toEqual(["2026-07-04", "2026-08-01", "2026-09-05"]);
    expect(groups.map((g) => g.vendors[0].id)).toEqual(["v-jul", "v-aug", "v-sep"]);
  });

  it("omits 'Regular participants' group when all vendors are per-day", () => {
    const vendors: TestVendor[] = [
      { id: "v1", eventDayId: "day-2026-07-04" },
      { id: "v2", eventDayId: "day-2026-08-01" },
    ];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups).toHaveLength(2);
    expect(groups[0].heading).toBe("Saturday, July 4");
    expect(groups[1].heading).toBe("Saturday, August 1");
  });

  it("groups multiple vendors on the same day together", () => {
    const vendors: TestVendor[] = [
      { id: "v1", eventDayId: "day-2026-07-04" },
      { id: "v2", eventDayId: "day-2026-07-04" },
      { id: "v3", eventDayId: "day-2026-08-01" },
    ];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups).toHaveLength(2);
    expect(groups[0].vendors.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(groups[1].vendors.map((v) => v.id)).toEqual(["v3"]);
  });

  it("places per-day vendors with orphaned event_day_id (unknown date) last", () => {
    // Defensive case — shouldn't happen in clean data but the helper
    // mustn't crash if event_days is missing the referenced id.
    const vendors: TestVendor[] = [
      { id: "v-orphan", eventDayId: "day-does-not-exist" },
      { id: "v-jul", eventDayId: "day-2026-07-04" },
    ];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups).toHaveLength(2);
    expect(groups[0].date).toBe("2026-07-04");
    expect(groups[1].date).toBeNull();
    expect(groups[1].heading).toBe("Specific occurrence");
  });

  it("when suppressIfFlat=false, emits 'Regular participants' heading even for series-wide-only lineup", () => {
    const vendors: TestVendor[] = [
      { id: "v1", eventDayId: null },
      { id: "v2", eventDayId: null },
    ];
    const groups = groupVendorsByDay(vendors, days, /* suppressIfFlat */ false);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe("Regular participants");
  });

  it("emits headings on series-wide-only lineup when event has multiple days (assumes per-day vendors might be coming)", () => {
    // suppressIfFlat default behavior: when event has multiple days, even
    // a purely series-wide lineup gets the "Regular participants" heading.
    // This is intentional -- multi-day events benefit from the explicit
    // label even before per-day vendors are added.
    const vendors: TestVendor[] = [{ id: "v1", eventDayId: null }];
    const groups = groupVendorsByDay(vendors, days);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe("Regular participants");
  });
});
