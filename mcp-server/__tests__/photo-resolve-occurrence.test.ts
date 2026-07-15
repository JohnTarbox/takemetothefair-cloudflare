import { describe, it, expect } from "vitest";
import {
  resolveOccurrence,
  venuesWithinRadius,
  haversineMiles,
  expandEventDates,
  VENUE_RADIUS_MILES,
  type VenueCandidate,
  type EventCandidate,
} from "../src/photo/resolve-occurrence.js";

const FRYEBURG: VenueCandidate = {
  id: "v-fryeburg",
  name: "Fryeburg Fairgrounds",
  latitude: 44.0176,
  longitude: -70.9803,
};
// ~90 miles away — well outside any plausible radius.
const CUMBERLAND: VenueCandidate = {
  id: "v-cumberland",
  name: "Cumberland Fairgrounds",
  latitude: 43.7973,
  longitude: -70.2568,
};

/** GPS essentially on top of the Fryeburg point. */
const AT_FRYEBURG = { latitude: 44.0177, longitude: -70.9805 };

function ev(over: Partial<EventCandidate> & { id: string }): EventCandidate {
  return {
    name: over.name ?? over.id,
    slug: over.slug ?? over.id,
    venueId: over.venueId ?? FRYEBURG.id,
    dates: over.dates ?? ["2026-10-04"],
    ...over,
  };
}

describe("haversineMiles", () => {
  it("returns ~0 for the same point and a sane distance between known venues", () => {
    expect(haversineMiles(44.0176, -70.9803, 44.0176, -70.9803)).toBeCloseTo(0, 5);
    const d = haversineMiles(
      FRYEBURG.latitude,
      FRYEBURG.longitude,
      CUMBERLAND.latitude,
      CUMBERLAND.longitude
    );
    expect(d).toBeGreaterThan(30);
    expect(d).toBeLessThan(60);
  });
});

describe("venuesWithinRadius", () => {
  it("keeps only venues inside the radius, nearest first", () => {
    const near = venuesWithinRadius(AT_FRYEBURG, [CUMBERLAND, FRYEBURG]);
    expect(near.map((v) => v.id)).toEqual(["v-fryeburg"]);
    expect(near[0].distanceMiles).toBeLessThan(0.1);
  });

  it("excludes a venue just beyond the radius", () => {
    // ~2.5 mi north of Fryeburg (1 deg lat ≈ 69 mi).
    const far = { ...FRYEBURG, id: "v-far", latitude: 44.0176 + 2.5 / 69 };
    expect(venuesWithinRadius(AT_FRYEBURG, [far], VENUE_RADIUS_MILES)).toEqual([]);
  });
});

describe("resolveOccurrence", () => {
  it("resolves a booth photo to the single occurrence at that venue on that date", () => {
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG, CUMBERLAND],
      events: [
        ev({ id: "e-fryeburg-2026", name: "Fryeburg Fair", dates: ["2026-10-04", "2026-10-05"] }),
      ],
    });
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.eventId).toBe("e-fryeburg-2026");
    expect(r.method).toBe("exif");
    expect(r.venueName).toBe("Fryeburg Fairgrounds");
    expect(r.matchedDate).toBe("2026-10-04");
    expect(r.distanceMiles).toBeLessThan(0.1);
  });

  it("uses the DATE to pick between two fairs at the same venue — the core case", () => {
    // A fairground hosts many shows a year; GPS alone cannot disambiguate.
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG],
      events: [
        ev({ id: "e-fair", name: "Fryeburg Fair", dates: ["2026-10-04"] }),
        ev({ id: "e-craft", name: "Fryeburg Craft Show", dates: ["2026-06-14"] }),
      ],
    });
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.eventId).toBe("e-fair");
  });

  it("HOLDS rather than guessing when two fairs run at the venue the same day", () => {
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG],
      events: [
        ev({ id: "e-a", name: "Fryeburg Fair" }),
        ev({ id: "e-b", name: "Fryeburg Antique Show" }),
      ],
    });
    expect(r.status).toBe("held");
    if (r.status !== "held") return;
    expect(r.reason).toBe("ambiguous-multiple-events");
    // The reply must be able to name the competing fairs.
    expect(r.detail).toContain("Fryeburg Fair");
    expect(r.detail).toContain("Fryeburg Antique Show");
  });

  it("considers events at ALL venues in radius, not just the nearest", () => {
    // Adjacent arena is marginally nearer, but the event is at the fairground.
    const arena: VenueCandidate = {
      id: "v-arena",
      name: "Adjacent Arena",
      latitude: AT_FRYEBURG.latitude,
      longitude: AT_FRYEBURG.longitude,
    };
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-10-04",
      venues: [arena, FRYEBURG],
      events: [ev({ id: "e-fair", name: "Fryeburg Fair", venueId: FRYEBURG.id })],
    });
    // Nearest-venue-only logic would have found nothing at the arena.
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.eventId).toBe("e-fair");
  });

  it("holds when GPS is missing", () => {
    const r = resolveOccurrence({
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG],
      events: [ev({ id: "e" })],
    });
    expect(r).toMatchObject({ status: "held", reason: "no-exif-gps" });
  });

  it("holds when the capture date is missing", () => {
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      venues: [FRYEBURG],
      events: [ev({ id: "e" })],
    });
    expect(r).toMatchObject({ status: "held", reason: "no-exif-date" });
  });

  it("holds when no geocoded venue is near the photo", () => {
    const r = resolveOccurrence({
      gps: { latitude: 40.7128, longitude: -74.006 }, // NYC
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG],
      events: [ev({ id: "e" })],
    });
    expect(r).toMatchObject({ status: "held", reason: "no-venue-in-radius" });
  });

  it("holds when the venue matches but nothing was running that day", () => {
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-12-25",
      venues: [FRYEBURG],
      events: [ev({ id: "e", dates: ["2026-10-04"] })],
    });
    expect(r).toMatchObject({ status: "held", reason: "no-event-on-date" });
  });

  it("lets an explicit override win and skip EXIF entirely", () => {
    const r = resolveOccurrence({
      overrideEvent: { id: "e-override", name: "Named Fair", slug: "named-fair" },
      // Deliberately contradictory EXIF — the override must still win.
      gps: { latitude: 40.7128, longitude: -74.006 },
      takenOnLocalDate: "1999-01-01",
      venues: [FRYEBURG],
      events: [],
    });
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.eventId).toBe("e-override");
    expect(r.method).toBe("override");
  });

  it("ignores events whose venue is null", () => {
    const r = resolveOccurrence({
      gps: AT_FRYEBURG,
      takenOnLocalDate: "2026-10-04",
      venues: [FRYEBURG],
      events: [ev({ id: "e-orphan", venueId: null })],
    });
    expect(r).toMatchObject({ status: "held", reason: "no-event-on-date" });
  });
});

describe("expandEventDates", () => {
  it("prefers explicit event_days rows", () => {
    const days = ["2026-10-04", "2026-10-05"];
    expect(expandEventDates(days, new Date("2026-01-01"), new Date("2026-01-09"))).toEqual(days);
  });

  it("walks the start→end range when there are no event_days", () => {
    expect(
      expandEventDates([], new Date("2026-10-04T00:00:00Z"), new Date("2026-10-06T00:00:00Z"))
    ).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
  });

  it("treats a single-day event (no end date) as one day", () => {
    expect(expandEventDates([], new Date("2026-10-04T00:00:00Z"), null)).toEqual(["2026-10-04"]);
  });

  it("returns nothing when there is no start date", () => {
    expect(expandEventDates([], null, null)).toEqual([]);
  });

  it("caps a runaway range so a bad end-date cannot spin", () => {
    const out = expandEventDates(
      [],
      new Date("2026-01-01T00:00:00Z"),
      new Date("2030-01-01T00:00:00Z")
    );
    expect(out.length).toBeLessThanOrEqual(60);
  });
});
