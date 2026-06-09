import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EventSchema } from "../EventSchema";

// EventSchema emits JSON-LD inside a <script type="application/ld+json"> tag.
// Tests extract the rendered JSON and assert specific fields rather than
// snapshotting the whole structure — the schema has many optional fields and
// a full snapshot would churn on every minor addition.
//
// Each test exercises one lifecycle state to confirm the lifecycle → schema.org
// mapping at LIFECYCLE_TO_SCHEMA_ORG is correctly wired through the component.

function extractJsonLd(container: HTMLElement): Record<string, unknown> {
  const script = container.querySelector('script[type="application/ld+json"]');
  expect(script).not.toBeNull();
  return JSON.parse(script!.innerHTML);
}

const baseProps = {
  name: "Test Event",
  slug: "test-event",
  startDate: new Date("2026-06-15T10:00:00Z"),
  endDate: new Date("2026-06-16T18:00:00Z"),
  url: "https://meetmeatthefair.com/events/test-event",
  imageUrl: "https://meetmeatthefair.com/test.jpg",
  venue: null,
  stateCode: "ME",
  organizer: null,
};

describe("EventSchema lifecycle → eventStatus mapping", () => {
  it("SCHEDULED lifecycle → EventScheduled URI", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="SCHEDULED" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  it("TENTATIVE lifecycle → EventScheduled (TENTATIVE has no schema.org equivalent)", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="TENTATIVE" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  it("POSTPONED lifecycle → EventPostponed URI", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="POSTPONED" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventPostponed");
  });

  it("RESCHEDULED lifecycle → EventRescheduled URI + emits previousStartDate", () => {
    const { container } = render(
      <EventSchema
        {...baseProps}
        lifecycleStatus="RESCHEDULED"
        previousStartDate={new Date("2026-05-01T10:00:00Z")}
        previousEndDate={new Date("2026-05-02T18:00:00Z")}
      />
    );
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventRescheduled");
    expect(ld.previousStartDate).toBe("2026-05-01T10:00:00.000Z");
    expect(ld.previousEndDate).toBe("2026-05-02T18:00:00.000Z");
  });

  it("RESCHEDULED without previous dates → URI emitted, dates omitted", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="RESCHEDULED" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventRescheduled");
    expect(ld.previousStartDate).toBeUndefined();
    expect(ld.previousEndDate).toBeUndefined();
  });

  it("CANCELLED lifecycle → EventCancelled URI", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="CANCELLED" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventCancelled");
  });

  it("MOVED_ONLINE lifecycle → EventMovedOnline URI + OnlineEventAttendanceMode", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="MOVED_ONLINE" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventMovedOnline");
    expect(ld.eventAttendanceMode).toBe("https://schema.org/OnlineEventAttendanceMode");
  });

  it("OCCURRED lifecycle → eventStatus omitted (no schema.org equivalent)", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="OCCURRED" />);
    const ld = extractJsonLd(container);
    // OCCURRED maps to null in LIFECYCLE_TO_SCHEMA_ORG, so the legacy
    // datesConfirmed-based fallback kicks in. With known confirmed dates
    // it lands on EventScheduled. With dates but datesConfirmed not set,
    // it's also EventScheduled (default). This is intentional: we'd rather
    // emit EventScheduled-with-past-dates than nothing, since Google's
    // crawler treats absence as ambiguous.
    expect(ld.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  it("NO_SHOW lifecycle → falls back to legacy heuristic (no schema.org equivalent)", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="NO_SHOW" />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  it("no lifecycleStatus → falls back to legacy datesConfirmed heuristic (Scheduled)", () => {
    const { container } = render(<EventSchema {...baseProps} datesConfirmed={true} />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  it("no lifecycleStatus + datesConfirmed=false → legacy heuristic emits Postponed", () => {
    const { container } = render(<EventSchema {...baseProps} datesConfirmed={false} />);
    const ld = extractJsonLd(container);
    expect(ld.eventStatus).toBe("https://schema.org/EventPostponed");
  });

  it("non-MOVED_ONLINE lifecycle keeps Offline attendance mode", () => {
    const { container } = render(<EventSchema {...baseProps} lifecycleStatus="SCHEDULED" />);
    const ld = extractJsonLd(container);
    expect(ld.eventAttendanceMode).toBe("https://schema.org/OfflineEventAttendanceMode");
  });
});

// participationType split (drizzle/0071, 2026-05-16 analyst spec)
describe("EventSchema participationType performer/sponsor split", () => {
  it("EXHIBITOR vendors only → performer populated, sponsor omitted", () => {
    const { container } = render(
      <EventSchema
        {...baseProps}
        vendors={[
          {
            name: "Acme Crafts",
            url: "https://example.com/acme",
            participationType: "EXHIBITOR",
          },
        ]}
      />
    );
    const ld = extractJsonLd(container);
    expect(ld.performer).toEqual([
      { "@type": "Organization", name: "Acme Crafts", url: "https://example.com/acme" },
    ]);
    expect(ld.sponsor).toBeUndefined();
  });

  it("SPONSOR_ONLY vendors → sponsor populated, performer omitted", () => {
    const { container } = render(
      <EventSchema
        {...baseProps}
        vendors={[
          {
            name: "RbA Greater Maine",
            url: "https://example.com/rba",
            participationType: "SPONSOR_ONLY",
          },
        ]}
      />
    );
    const ld = extractJsonLd(container);
    expect(ld.sponsor).toEqual([
      { "@type": "Organization", name: "RbA Greater Maine", url: "https://example.com/rba" },
    ]);
    expect(ld.performer).toBeUndefined();
  });

  it("SPONSOR_AND_EXHIBITOR appears in BOTH performer and sponsor", () => {
    const { container } = render(
      <EventSchema
        {...baseProps}
        vendors={[
          {
            name: "Naming Rights Co",
            url: "https://example.com/nrc",
            participationType: "SPONSOR_AND_EXHIBITOR",
          },
        ]}
      />
    );
    const ld = extractJsonLd(container);
    expect(ld.performer).toEqual([
      { "@type": "Organization", name: "Naming Rights Co", url: "https://example.com/nrc" },
    ]);
    expect(ld.sponsor).toEqual([
      { "@type": "Organization", name: "Naming Rights Co", url: "https://example.com/nrc" },
    ]);
  });

  it("mixed lineup correctly partitions each vendor", () => {
    const { container } = render(
      <EventSchema
        {...baseProps}
        vendors={[
          { name: "Acme Crafts", url: "/acme", participationType: "EXHIBITOR" },
          { name: "RbA Greater Maine", url: "/rba", participationType: "SPONSOR_ONLY" },
          { name: "Both Co", url: "/both", participationType: "SPONSOR_AND_EXHIBITOR" },
        ]}
      />
    );
    const ld = extractJsonLd(container);
    expect(Array.isArray(ld.performer)).toBe(true);
    expect((ld.performer as Array<{ name: string }>).map((p) => p.name)).toEqual([
      "Acme Crafts",
      "Both Co",
    ]);
    expect(Array.isArray(ld.sponsor)).toBe(true);
    expect((ld.sponsor as Array<{ name: string }>).map((p) => p.name)).toEqual([
      "RbA Greater Maine",
      "Both Co",
    ]);
  });

  it("legacy vendors without participationType default to EXHIBITOR (performer only)", () => {
    const { container } = render(
      <EventSchema {...baseProps} vendors={[{ name: "Legacy Vendor", url: "/legacy" }]} />
    );
    const ld = extractJsonLd(container);
    expect(ld.performer).toEqual([
      { "@type": "Organization", name: "Legacy Vendor", url: "/legacy" },
    ]);
    expect(ld.sponsor).toBeUndefined();
  });
});

describe("EventSchema venue.timezone threading (P3b)", () => {
  const eventDays = [
    { date: "2026-07-15", openTime: "09:00", closeTime: "17:00" },
    { date: "2026-07-16", openTime: "09:00", closeTime: "17:00" },
  ];

  it("default (no venue) emits Eastern offset for sub-event startDate (back-compat)", () => {
    const { container } = render(<EventSchema {...baseProps} eventDays={eventDays} />);
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ startDate: string; endDate: string }>;
    // 9:00 AM EDT in July = -04:00 offset
    expect(subs[0].startDate).toBe("2026-07-15T09:00:00-04:00");
    expect(subs[0].endDate).toBe("2026-07-15T17:00:00-04:00");
  });

  it("venue.timezone='America/Halifax' shifts sub-event offset to -03:00 (ADT, summer)", () => {
    const halifaxVenue = {
      name: "Halifax Fairgrounds",
      city: "Halifax",
      state: "NS",
      timezone: "America/Halifax",
    };
    const { container } = render(
      <EventSchema {...baseProps} venue={halifaxVenue} eventDays={eventDays} />
    );
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ startDate: string; endDate: string }>;
    expect(subs[0].startDate).toBe("2026-07-15T09:00:00-03:00");
    expect(subs[0].endDate).toBe("2026-07-15T17:00:00-03:00");
  });

  it("venue.timezone='America/St_Johns' emits the Newfoundland 30-minute offset", () => {
    const newfoundlandVenue = {
      name: "St. John's Exhibition Grounds",
      city: "St. John's",
      state: "NL",
      timezone: "America/St_Johns",
    };
    const { container } = render(
      <EventSchema {...baseProps} venue={newfoundlandVenue} eventDays={eventDays} />
    );
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ startDate: string; endDate: string }>;
    // NDT in summer is UTC-2:30 — the canonical 30-min-offset acceptance.
    expect(subs[0].startDate).toBe("2026-07-15T09:00:00-02:30");
    expect(subs[0].endDate).toBe("2026-07-15T17:00:00-02:30");
  });

  it("venue without timezone field falls back to default (legacy callers)", () => {
    const legacyVenue = {
      name: "Old Venue",
      city: "Portland",
      state: "ME",
      // No timezone field — pre-P3b shape
    };
    const { container } = render(
      <EventSchema {...baseProps} venue={legacyVenue} eventDays={eventDays} />
    );
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ startDate: string; endDate: string }>;
    expect(subs[0].startDate).toBe("2026-07-15T09:00:00-04:00");
  });
});

describe("EventSchema subEvent.image per-occurrence (F2 / E.2b, 2026-06-09)", () => {
  // Two-day event: first day has a per-occurrence image, second doesn't.
  // The emitted subEvent.image should match each day's wiring — per-day
  // URL when set, series-level resolvedImage when not.
  const eventDays = [
    {
      date: "2026-07-15",
      openTime: "09:00",
      closeTime: "17:00",
      imageUrl: "https://meetmeatthefair.com/day1-poster.jpg",
    },
    {
      date: "2026-07-16",
      openTime: "09:00",
      closeTime: "17:00",
      // No imageUrl — should fall back to series imageUrl from baseProps.
    },
  ];

  it("per-day imageUrl wins; absent day falls back to series-level image", () => {
    const { container } = render(<EventSchema {...baseProps} eventDays={eventDays} />);
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ image: string }>;
    expect(subs).toHaveLength(2);
    // Day 1 has its own image
    expect(subs[0].image).toBe("https://meetmeatthefair.com/day1-poster.jpg");
    // Day 2 falls back to series image (from baseProps.imageUrl)
    expect(subs[1].image).toBe("https://meetmeatthefair.com/test.jpg");
  });

  it("eventDays without imageUrl at all → every subEvent uses series image (back-compat)", () => {
    const daysWithoutImages = [
      { date: "2026-07-15", openTime: "09:00", closeTime: "17:00" },
      { date: "2026-07-16", openTime: "09:00", closeTime: "17:00" },
    ];
    const { container } = render(<EventSchema {...baseProps} eventDays={daysWithoutImages} />);
    const ld = extractJsonLd(container);
    const subs = ld.subEvent as Array<{ image: string }>;
    for (const sub of subs) {
      expect(sub.image).toBe("https://meetmeatthefair.com/test.jpg");
    }
  });
});
