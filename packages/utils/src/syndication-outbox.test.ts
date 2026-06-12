import { describe, it, expect } from "vitest";
import {
  mirroredFieldsChanged,
  mirroredFieldsOnly,
  buildEventSnapshot,
  buildVenueSnapshot,
  MIRRORED_EVENT_FIELDS,
  MIRRORED_VENUE_FIELDS,
} from "./syndication-outbox";

describe("mirroredFieldsChanged", () => {
  it("fires for a mirrored event field", () => {
    expect(mirroredFieldsChanged("event", ["name"])).toBe(true);
    expect(mirroredFieldsChanged("event", ["startDate", "description"])).toBe(true);
  });

  it("does NOT fire when only non-mirrored event fields change", () => {
    expect(mirroredFieldsChanged("event", ["description", "ticketUrl", "imageFocalX"])).toBe(false);
    expect(mirroredFieldsChanged("event", [])).toBe(false);
  });

  it("fires for a mirrored venue field, not for others", () => {
    expect(mirroredFieldsChanged("venue", ["city"])).toBe(true);
    expect(mirroredFieldsChanged("venue", ["contactPhone", "website"])).toBe(false);
  });

  it("fires for event_day date-range fields only (not image/notes/times)", () => {
    expect(mirroredFieldsChanged("event_day", ["date"])).toBe(true);
    expect(mirroredFieldsChanged("event_day", ["vendorOnly"])).toBe(true);
    expect(mirroredFieldsChanged("event_day", ["openTime", "imageUrl", "notes"])).toBe(false);
    expect(mirroredFieldsChanged("event_day", [])).toBe(false);
  });
});

describe("mirroredFieldsOnly", () => {
  it("narrows to mirrored fields for events/venues", () => {
    expect(mirroredFieldsOnly("event", ["name", "description", "endDate"])).toEqual([
      "name",
      "endDate",
    ]);
    expect(mirroredFieldsOnly("venue", ["zip", "website"])).toEqual(["zip"]);
  });

  it("narrows event_day to date-range fields", () => {
    expect(mirroredFieldsOnly("event_day", ["date", "openTime", "vendorOnly"])).toEqual([
      "date",
      "vendorOnly",
    ]);
  });
});

describe("buildEventSnapshot", () => {
  it("serializes dates to ISO and nests the mirrored venue fields", () => {
    const snap = buildEventSnapshot(
      {
        name: "Gray Wild Blueberry Festival",
        slug: "gray-wild-blueberry-festival",
        startDate: new Date("2026-08-15T00:00:00.000Z"),
        endDate: new Date("2026-08-16T00:00:00.000Z"),
      },
      { name: "Town Common", address: "1 Main St", city: "Gray", state: "ME", zip: "04039" }
    );
    expect(snap).toEqual({
      name: "Gray Wild Blueberry Festival",
      slug: "gray-wild-blueberry-festival",
      startDate: "2026-08-15T00:00:00.000Z",
      endDate: "2026-08-16T00:00:00.000Z",
      venue: { name: "Town Common", address: "1 Main St", city: "Gray", state: "ME", zip: "04039" },
    });
  });

  it("accepts epoch-ms numbers and null venue", () => {
    const snap = buildEventSnapshot(
      { name: "X", startDate: Date.UTC(2026, 0, 1), endDate: null },
      null
    );
    expect(snap.startDate).toBe("2026-01-01T00:00:00.000Z");
    expect(snap.endDate).toBeNull();
    expect(snap.venue).toBeNull();
    expect(snap.slug).toBeNull();
  });

  it("only emits the mirrored venue fields (ignores extra props)", () => {
    const snap = buildEventSnapshot(
      { name: "X" },
      {
        name: "V",
        address: "A",
        city: "C",
        state: "S",
        zip: "Z",
        // @ts-expect-error — extra non-mirrored field must be dropped
        contactPhone: "555",
      }
    );
    expect(Object.keys(snap.venue ?? {})).toEqual(["name", "address", "city", "state", "zip"]);
  });
});

describe("buildVenueSnapshot", () => {
  it("returns exactly the mirrored venue fields, coercing undefined to null", () => {
    expect(
      buildVenueSnapshot({ name: "V", address: null, city: "Gray", state: "ME", zip: null })
    ).toEqual({ name: "V", address: null, city: "Gray", state: "ME", zip: null });
  });
});

describe("allow-list constants", () => {
  it("are the documented mirrored field sets", () => {
    expect([...MIRRORED_EVENT_FIELDS]).toEqual(["name", "startDate", "endDate"]);
    expect([...MIRRORED_VENUE_FIELDS]).toEqual(["name", "address", "city", "state", "zip"]);
  });
});
