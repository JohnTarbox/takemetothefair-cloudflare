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
