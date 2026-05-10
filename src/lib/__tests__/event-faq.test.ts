import { describe, it, expect } from "vitest";
import {
  buildEventFaqItems,
  FAQ_MIN_ITEMS,
  type EventFaqInput,
  type FaqEvent,
  type FaqEventDay,
  type FaqVenue,
} from "../event-faq";

const NOW = new Date("2026-05-09T00:00:00Z");

function emptyEvent(overrides: Partial<FaqEvent> = {}): FaqEvent {
  return {
    name: "Test Fair",
    startDate: null,
    endDate: null,
    applicationDeadline: null,
    applicationUrl: null,
    applicationInstructions: null,
    vendorFeeMinCents: null,
    vendorFeeMaxCents: null,
    walkInsAllowed: null,
    estimatedAttendance: null,
    ticketPriceMinCents: null,
    ticketPriceMaxCents: null,
    ticketUrl: null,
    indoorOutdoor: null,
    ...overrides,
  };
}

function call(input: Partial<EventFaqInput> & { event: FaqEvent }) {
  return buildEventFaqItems({
    venue: input.venue ?? null,
    eventDays: input.eventDays ?? [],
    now: input.now ?? NOW,
    event: input.event,
  });
}

describe("buildEventFaqItems — suppression rules", () => {
  it("returns [] when every field is null and no eventDays/venue", () => {
    expect(call({ event: emptyEvent() })).toEqual([]);
  });

  it("does not synthesize answers from missing data", () => {
    const items = call({ event: emptyEvent({ name: "X" }) });
    expect(items).toEqual([]);
  });

  it("suppresses application deadline when in the past", () => {
    const items = call({
      event: emptyEvent({
        applicationDeadline: new Date("2026-04-01T00:00:00Z"),
      }),
    });
    expect(items.find((i) => i.question.includes("application deadline"))).toBeUndefined();
  });

  it("renders application deadline when in the future", () => {
    const items = call({
      event: emptyEvent({
        applicationDeadline: new Date("2026-06-01T00:00:00Z"),
      }),
    });
    const q = items.find((i) => i.question.includes("application deadline"));
    expect(q).toBeDefined();
    expect(q!.answer).toMatch(/Jun 1, 2026/);
  });

  it("suppresses booth fee when both min and max are null", () => {
    const items = call({ event: emptyEvent() });
    expect(items.find((i) => i.question.includes("booth fee"))).toBeUndefined();
  });

  it("renders booth fee 'Free' when min and max are 0", () => {
    const items = call({
      event: emptyEvent({ vendorFeeMinCents: 0, vendorFeeMaxCents: 0 }),
    });
    const q = items.find((i) => i.question.includes("booth fee"));
    expect(q?.answer).toBe("There is no booth fee.");
  });

  it("renders booth fee range when both populated", () => {
    const items = call({
      event: emptyEvent({ vendorFeeMinCents: 15000, vendorFeeMaxCents: 40000 }),
    });
    const q = items.find((i) => i.question.includes("booth fee"));
    expect(q?.answer).toBe("Booth fees are $150 - $400.");
  });

  it("does NOT render commercial-vendors question (column defaults to true)", () => {
    const items = call({ event: emptyEvent() });
    expect(items.find((i) => i.question.includes("commercial vendors"))).toBeUndefined();
  });

  it("suppresses walk-ins question when null", () => {
    const items = call({ event: emptyEvent({ walkInsAllowed: null }) });
    expect(items.find((i) => i.question.includes("walk-in"))).toBeUndefined();
  });

  it("renders walk-ins=true with affirmative answer", () => {
    const items = call({ event: emptyEvent({ walkInsAllowed: true }) });
    const q = items.find((i) => i.question.includes("walk-in"));
    expect(q?.answer).toMatch(/^Yes/);
  });

  it("renders walk-ins=false with negative answer", () => {
    const items = call({ event: emptyEvent({ walkInsAllowed: false }) });
    const q = items.find((i) => i.question.includes("walk-in"));
    expect(q?.answer).toMatch(/^No/);
  });

  it("formats estimated attendance with thousands separator", () => {
    const items = call({ event: emptyEvent({ estimatedAttendance: 25000 }) });
    const q = items.find((i) => i.question.includes("attendees"));
    expect(q?.answer).toContain("25,000");
  });

  it("suppresses estimatedAttendance when 0 or null", () => {
    expect(
      call({ event: emptyEvent({ estimatedAttendance: 0 }) }).find((i) =>
        i.question.includes("attendees")
      )
    ).toBeUndefined();
    expect(
      call({ event: emptyEvent({ estimatedAttendance: null }) }).find((i) =>
        i.question.includes("attendees")
      )
    ).toBeUndefined();
  });

  it("renders vendor-only setup days from eventDays.vendorOnly === true", () => {
    const days: FaqEventDay[] = [
      {
        date: "2026-08-14",
        openTime: "08:00",
        closeTime: "18:00",
        closed: false,
        vendorOnly: true,
      },
      {
        date: "2026-08-15",
        openTime: "10:00",
        closeTime: "20:00",
        closed: false,
        vendorOnly: false,
      },
    ];
    const items = call({ event: emptyEvent(), eventDays: days });
    const q = items.find((i) => i.question.includes("setup"));
    expect(q?.answer).toMatch(/Aug 14, 2026/);
  });

  it("renders date range from start/end dates", () => {
    const items = call({
      event: emptyEvent({
        name: "Acton Fair",
        startDate: new Date("2026-08-14T00:00:00Z"),
        endDate: new Date("2026-08-16T00:00:00Z"),
      }),
    });
    const q = items.find((i) => i.question.includes("When is Acton Fair"));
    expect(q?.answer).toMatch(/Aug 14.*Aug 16/);
  });

  it("renders venue location with city, state", () => {
    const venue: FaqVenue = {
      name: "Acton Fairgrounds",
      address: "123 Main St",
      city: "Acton",
      state: "ME",
    };
    const items = call({ event: emptyEvent(), venue });
    const q = items.find((i) => i.question.includes("Where is it held"));
    expect(q?.answer).toBe("Acton Fairgrounds, 123 Main St, Acton, ME.");
  });

  it("renders 'Open daily' hours only when public days share open/close times", () => {
    const sameHours: FaqEventDay[] = [
      {
        date: "2026-08-14",
        openTime: "10:00",
        closeTime: "20:00",
        closed: false,
        vendorOnly: false,
      },
      {
        date: "2026-08-15",
        openTime: "10:00",
        closeTime: "20:00",
        closed: false,
        vendorOnly: false,
      },
    ];
    const items = call({ event: emptyEvent(), eventDays: sameHours });
    expect(items.find((i) => i.question.includes("What time"))?.answer).toBe(
      "Open daily from 10 AM to 8 PM."
    );
  });

  it("suppresses hours question when public days have varying hours", () => {
    const variedHours: FaqEventDay[] = [
      {
        date: "2026-08-14",
        openTime: "10:00",
        closeTime: "20:00",
        closed: false,
        vendorOnly: false,
      },
      {
        date: "2026-08-15",
        openTime: "09:00",
        closeTime: "18:00",
        closed: false,
        vendorOnly: false,
      },
    ];
    const items = call({ event: emptyEvent(), eventDays: variedHours });
    expect(items.find((i) => i.question.includes("What time"))).toBeUndefined();
  });

  it("renders admission 'free' when both ticket prices are 0", () => {
    const items = call({
      event: emptyEvent({ ticketPriceMinCents: 0, ticketPriceMaxCents: 0 }),
    });
    expect(items.find((i) => i.question.includes("admission"))?.answer).toBe("Admission is free.");
  });

  it("renders indoor/outdoor mapped to a friendly answer", () => {
    expect(
      call({ event: emptyEvent({ indoorOutdoor: "OUTDOOR" }) }).find((i) =>
        i.question.includes("indoor or outdoor")
      )?.answer
    ).toBe("This is an outdoor event.");
    expect(
      call({ event: emptyEvent({ indoorOutdoor: "MIXED" }) }).find((i) =>
        i.question.includes("indoor or outdoor")
      )?.answer
    ).toBe("This event has both indoor and outdoor portions.");
  });

  it("suppresses indoor/outdoor question when value is unknown", () => {
    const items = call({ event: emptyEvent({ indoorOutdoor: "UNKNOWN" }) });
    expect(items.find((i) => i.question.includes("indoor or outdoor"))).toBeUndefined();
  });
});

describe("buildEventFaqItems — caps and ordering", () => {
  it("never returns more than 10 items", () => {
    const items = call({
      event: emptyEvent({
        name: "Fully Populated Fair",
        startDate: new Date("2026-08-14T00:00:00Z"),
        endDate: new Date("2026-08-16T00:00:00Z"),
        applicationDeadline: new Date("2026-07-01T00:00:00Z"),
        applicationUrl: "https://example.com/apply",
        applicationInstructions: "Submit photos of your work.",
        vendorFeeMinCents: 15000,
        vendorFeeMaxCents: 40000,
        walkInsAllowed: false,
        estimatedAttendance: 25000,
        ticketPriceMinCents: 1000,
        ticketPriceMaxCents: 1500,
        ticketUrl: "https://example.com/tickets",
        indoorOutdoor: "OUTDOOR",
      }),
      venue: {
        name: "Fairgrounds",
        address: "123 Main St",
        city: "Acton",
        state: "ME",
      },
      eventDays: [
        {
          date: "2026-08-13",
          openTime: "08:00",
          closeTime: "18:00",
          closed: false,
          vendorOnly: true,
        },
        {
          date: "2026-08-14",
          openTime: "10:00",
          closeTime: "20:00",
          closed: false,
          vendorOnly: false,
        },
        {
          date: "2026-08-15",
          openTime: "10:00",
          closeTime: "20:00",
          closed: false,
          vendorOnly: false,
        },
      ],
    });
    expect(items.length).toBeLessThanOrEqual(10);
  });

  it("emits vendor-side questions before attendee-side questions", () => {
    const items = call({
      event: emptyEvent({
        name: "Mixed Fair",
        startDate: new Date("2026-08-14T00:00:00Z"),
        endDate: new Date("2026-08-16T00:00:00Z"),
        applicationDeadline: new Date("2026-07-01T00:00:00Z"),
        vendorFeeMinCents: 15000,
        vendorFeeMaxCents: null,
      }),
      venue: { name: "Fairgrounds", address: null, city: null, state: null },
    });
    const ixDeadline = items.findIndex((i) => i.question.includes("application deadline"));
    const ixWhen = items.findIndex((i) => i.question === "When is Mixed Fair?");
    expect(ixDeadline).toBeGreaterThanOrEqual(0);
    expect(ixWhen).toBeGreaterThan(ixDeadline);
  });
});

describe("FAQ_MIN_ITEMS export", () => {
  it("equals 3 per the strategy doc §3.5", () => {
    expect(FAQ_MIN_ITEMS).toBe(3);
  });
});
