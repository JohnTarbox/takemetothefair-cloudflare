/**
 * H1 regression guard (OPE-44 / Bing on-page nit "multiple H1").
 *
 * EventsView is mounted on many routes that already render their own
 * page-level <h1> ("Browse Events", "My Calendar", etc.). Its print-only
 * calendar title used to be an <h1>, producing a SECOND <h1> in the DOM.
 * It was demoted to <h2>. This test asserts EventsView contributes ZERO
 * <h1> elements so the host page keeps exactly one.
 *
 * Heavy children (the calendar grid, popovers, event cards, router hooks)
 * are stubbed — they add no value to a heading-level assertion.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@johntarbox/calendar-grid", () => ({
  MonthCalendar: () => <div data-testid="month-calendar" />,
}));

vi.mock("../event-card", () => ({
  EventCard: () => <article data-testid="event-card" />,
}));

vi.mock("../event-popover", () => ({
  EventPopover: () => null,
  DayEventsPopover: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  trackFilterApplied: vi.fn(),
}));

import { EventsView } from "../events-view";

type EventsProp = React.ComponentProps<typeof EventsView>["events"];

const sampleEvents = [
  {
    id: "ev-1",
    name: "Fryeburg Fair",
    slug: "fryeburg-fair",
    startDate: new Date("2026-10-04T12:00:00Z"),
    endDate: new Date("2026-10-11T12:00:00Z"),
    categories: null,
    venue: null,
    promoter: null,
  },
] as unknown as EventsProp;

describe("EventsView heading level", () => {
  it("renders no <h1> in calendar view (page owns the single h1)", () => {
    const { container } = render(<EventsView events={sampleEvents} view="calendar" />);
    expect(container.querySelectorAll("h1")).toHaveLength(0);
  });

  it("renders the print calendar title as an <h2>", () => {
    const { container } = render(<EventsView events={sampleEvents} view="calendar" />);
    const printTitle = Array.from(container.querySelectorAll("h2")).find((el) =>
      el.textContent?.includes("Events Calendar —")
    );
    expect(printTitle).toBeTruthy();
  });

  it("renders no <h1> in cards view either", () => {
    const { container } = render(<EventsView events={sampleEvents} view="cards" />);
    expect(container.querySelectorAll("h1")).toHaveLength(0);
  });
});
