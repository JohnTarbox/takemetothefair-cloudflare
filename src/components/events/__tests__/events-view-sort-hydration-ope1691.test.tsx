/**
 * OPE-1691 follow-up — the card grid's ORDER must not depend on the browser's
 * clock during hydration.
 *
 * events-view sorted by next occurrence against `new Date()`. Measured live on
 * 2026-11-21 after the card-text fix shipped: with the browser clock +26h,
 * /events/festivals and /events/new-hampshire threw #418 args[]=HTML in 5 of 6
 * loads, and 0 of 6 with no skew. A card that is "today" on the server but over
 * on the client moves from first to last, so a slot holds a different card.
 *
 * Positive control: without RenderNowProvider (each side reads its own clock)
 * the repro must report the mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { RenderNowProvider } from "@/lib/hooks/render-now";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/events",
}));
vi.mock("@johntarbox/calendar-grid", () => ({ MonthCalendar: () => <div /> }));
vi.mock("../event-card", () => ({
  EventCard: ({ event }: { event: { id: string; name: string } }) => (
    <article data-id={event.id}>
      <h3>{event.name}</h3>
    </article>
  ),
}));
vi.mock("../event-popover", () => ({ EventPopover: () => null, DayEventsPopover: () => null }));
vi.mock("@/lib/analytics", () => ({ trackFilterApplied: vi.fn() }));

import { EventsView } from "../events-view";

type EventsProp = React.ComponentProps<typeof EventsView>["events"];
const SERVER_NOW = Date.parse("2026-11-21T23:30:00Z");
const CLIENT_NOW = Date.parse("2026-11-22T01:00:00Z");

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
// "Today only" on the server → first; over on the client → sorts last.
// The other runs on the 25th either way.
const events = [
  {
    id: "later",
    name: "Thanksgiving Market",
    slug: "thanksgiving-market",
    startDate: day("2026-11-25"),
    endDate: day("2026-11-25"),
    categories: null,
    venue: null,
    promoter: null,
  },
  {
    id: "today",
    name: "Saturday Craft Fair",
    slug: "saturday-craft-fair",
    startDate: day("2026-11-21"),
    endDate: day("2026-11-21"),
    categories: null,
    venue: null,
    promoter: null,
  },
] as unknown as EventsProp;

async function serverThenHydrate(tree: (now: number) => ReactElement) {
  vi.setSystemTime(SERVER_NOW);
  const html = renderToString(tree(SERVER_NOW));
  vi.setSystemTime(CLIENT_NOW);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    hydrateRoot(container, tree(SERVER_NOW), { onRecoverableError: (e) => errors.push(e) });
  });
  spy.mockRestore();
  const order = [...container.querySelectorAll("article")].map((a) => a.getAttribute("data-id"));
  return { html, errors, order };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("OPE-1691 EventsView sort order across a UTC day boundary", () => {
  it("positive control: each side on its own clock → mismatch reported", async () => {
    const { html, errors } = await serverThenHydrate(() => (
      <EventsView events={events} view="cards" />
    ));
    expect(html.indexOf('data-id="today"')).toBeLessThan(html.indexOf('data-id="later"'));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("with RenderNowProvider: hydrates cleanly, then re-sorts on the live clock", async () => {
    const { html, errors, order } = await serverThenHydrate((now) => (
      <RenderNowProvider now={now}>
        <EventsView events={events} view="cards" />
      </RenderNowProvider>
    ));
    expect(html.indexOf('data-id="today"')).toBeLessThan(html.indexOf('data-id="later"'));
    expect(errors).toEqual([]);
    expect(order).toEqual(["later", "today"]);
  });
});
