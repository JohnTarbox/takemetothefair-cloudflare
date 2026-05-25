/**
 * Component tests for SameDayEventsButton.
 *
 * EventCard is mocked because the real component pulls Next/Image,
 * FavoriteButton, AddToCalendar (which depend on next/navigation,
 * client-only window APIs, etc.) — none of those add value to a unit
 * test of the trigger/load/render state machine. The mock renders a
 * minimal <article data-testid="event-card"> so we can assert on
 * count without exercising the real card's UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/events/event-card", () => ({
  EventCard: ({ event }: { event: { id: string } }) => (
    <article data-testid="event-card" data-event-id={event.id} />
  ),
}));

import { SameDayEventsButton } from "../SameDayEventsButton";

const buttonLabel = /see other events on these dates/i;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SameDayEventsButton", () => {
  it("renders nothing when both startDate and endDate are null (TBD events)", () => {
    const { container } = render(
      <SameDayEventsButton slug="tbd-event" startDate={null} endDate={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the trigger button when dates are present, no list yet", () => {
    render(
      <SameDayEventsButton
        slug="anchor"
        startDate={new Date("2026-09-26T12:00:00Z")}
        endDate={new Date("2026-09-26T23:00:00Z")}
      />
    );
    expect(screen.getByRole("button", { name: buttonLabel })).toBeTruthy();
    expect(screen.queryByTestId("event-card")).toBeNull();
    expect(screen.queryByTestId("same-day-loading")).toBeNull();
  });

  it("on click, fetches the slug-scoped endpoint and shows loading state", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(
      () =>
        // Return a never-resolving promise so we can observe the loading
        // state without racing the resolved render.
        new Promise(() => {})
    );

    render(
      <SameDayEventsButton
        slug="my-event-slug"
        startDate={new Date("2026-09-26T12:00:00Z")}
        endDate={new Date("2026-09-26T23:00:00Z")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    expect(fetchSpy).toHaveBeenCalledWith("/api/events/my-event-slug/same-day");
    await waitFor(() => expect(screen.getByTestId("same-day-loading")).toBeTruthy());
  });

  it("renders an empty-state message when the API returns zero events", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, events: [] }), { status: 200 })
    );

    render(
      <SameDayEventsButton
        slug="lonely-event"
        startDate={new Date("2026-12-25T12:00:00Z")}
        endDate={new Date("2026-12-25T23:00:00Z")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => expect(screen.getByTestId("same-day-empty")).toBeTruthy());
    expect(screen.queryByTestId("event-card")).toBeNull();
  });

  it("renders N EventCards when the API returns N events", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          events: [
            { id: "ev-1", slug: "one", venue: null, promoter: null },
            { id: "ev-2", slug: "two", venue: null, promoter: null },
            { id: "ev-3", slug: "three", venue: null, promoter: null },
          ],
        }),
        { status: 200 }
      )
    );

    render(
      <SameDayEventsButton
        slug="anchor"
        startDate={new Date("2026-09-26T12:00:00Z")}
        endDate={new Date("2026-09-26T23:00:00Z")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => expect(screen.getAllByTestId("event-card")).toHaveLength(3));
  });

  it("shows the error state on non-2xx response and offers a retry", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 500 }));

    render(
      <SameDayEventsButton
        slug="anchor"
        startDate={new Date("2026-09-26T12:00:00Z")}
        endDate={new Date("2026-09-26T23:00:00Z")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => expect(screen.getByTestId("same-day-error")).toBeTruthy());
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});
