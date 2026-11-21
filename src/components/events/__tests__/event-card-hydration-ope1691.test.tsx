/**
 * OPE-1691 — the listing card must hydrate cleanly when the HTML was rendered
 * before a UTC day boundary and is hydrated after it (cached listing HTML).
 *
 * Non-minified repro: server-render EventCard at 23:30Z, hydrate the same
 * markup at 01:00Z the next day, and count hydration errors. The positive
 * control renders WITHOUT RenderNowProvider — the pre-fix behaviour, where
 * each side read its own clock — and must report the mismatch; otherwise a
 * green result would only mean the repro cannot see one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { EventCard } from "@/components/events/event-card";
import { RenderNowProvider } from "@/lib/hooks/render-now";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (p: { src: string; alt: string }) => <img src={p.src} alt={p.alt} />,
}));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button type="button">fav</button>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const SERVER_NOW = Date.parse("2026-11-21T23:30:00Z");
const CLIENT_NOW = Date.parse("2026-11-22T01:00:00Z");

// A confirmed one-day event on 2026-11-22: "Tomorrow" at render, "Today" at hydration.
const event = {
  id: "e1",
  name: "Holiday Craft Fair",
  slug: "holiday-craft-fair",
  startDate: new Date("2026-11-22T00:00:00Z"),
  endDate: new Date("2026-11-22T00:00:00Z"),
  publicStartDate: new Date("2026-11-22T00:00:00Z"),
  publicEndDate: new Date("2026-11-22T00:00:00Z"),
  datesConfirmed: true,
  categories: '["Craft Fair"]',
  imageUrl: null,
  estimatedAttendance: 1200,
  eventScale: "MEDIUM",
  applicationDeadline: null,
  discontinuousDates: false,
  venue: null,
  promoter: null,
  vendors: [],
} as unknown as Parameters<typeof EventCard>[0]["event"];

async function serverThenHydrate(tree: (now: number) => ReactElement) {
  vi.setSystemTime(SERVER_NOW);
  const html = renderToString(tree(SERVER_NOW));
  vi.setSystemTime(CLIENT_NOW);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    hydrateRoot(container, tree(SERVER_NOW), { onRecoverableError: (e) => errors.push(e) });
  });
  consoleErr.mockRestore();
  return { html, container, errors };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("OPE-1691 EventCard hydration across a UTC day boundary", () => {
  it("positive control: without a shared render time the repro DOES see the mismatch", async () => {
    const { html, errors } = await serverThenHydrate(() => <EventCard event={event} />);
    expect(html).toContain("Tomorrow");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("with RenderNowProvider: no hydration error, then the label goes live after mount", async () => {
    const { html, container, errors } = await serverThenHydrate((now) => (
      <RenderNowProvider now={now}>
        <EventCard event={event} />
      </RenderNowProvider>
    ));
    expect(html).toContain("Tomorrow");
    expect(errors).toEqual([]);
    // After mount the provider switches to the live clock — a normal re-render.
    expect(container.textContent).toContain("Today");
    expect(container.textContent).not.toContain("Tomorrow");
  });

  it("attendance is formatted with a fixed locale", async () => {
    const { html } = await serverThenHydrate((now) => (
      <RenderNowProvider now={now}>
        <EventCard event={event} />
      </RenderNowProvider>
    ));
    expect(html).toContain("1,200");
  });
});
