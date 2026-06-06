/**
 * Tests for mainepublic.org scraper — specifically the event_days extraction
 * restored after #358 dropped the source-page time-of-day stuffing.
 *
 * The mainepublic parser splits the page on `<article>` / event divs and
 * extracts dates from text like "Feb 15" and times from inline strings
 * like "03:00 PM - 05:00 PM".
 */

import { describe, it, expect } from "vitest";
import { parseEventsFromHtml } from "../mainepublic";

function event(opts: {
  slug: string;
  title: string;
  // Free-text content of the article. Date + time text live here.
  body: string;
}): string {
  return `
    <article>
      <a href="https://www.mainepublic.org/community-calendar/event/${opts.slug}">${opts.title}</a>
      ${opts.body}
    </article>
  `;
}

describe("mainepublic parseEventsFromHtml — event_days extraction", () => {
  it("extracts eventDays from canonical 'HH:MM AM - HH:MM PM' inline pattern", () => {
    const html = event({
      slug: "winter-talk",
      title: "Winter Talk",
      body: "Feb 15, 2026 — 03:00 PM - 05:00 PM at the library",
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.name).toBe("Winter Talk");
    // Date-only midnight UTC anchor — time-of-day is NOT baked in.
    expect(e.startDate?.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(e.eventDays).toEqual([{ date: "2026-02-15", openTime: "15:00", closeTime: "17:00" }]);
  });

  it("omits eventDays when source has no time-of-day text", () => {
    const html = event({
      slug: "all-day-fair",
      title: "All Day Fair",
      body: "Apr 20, 2026 — annual event open to all",
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].eventDays).toBeUndefined();
  });

  it("omits eventDays when time text is ambiguous (no AM/PM)", () => {
    const html = event({
      slug: "ambiguous",
      title: "Ambiguous",
      body: "May 10, 2026 from 9-5",
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].eventDays).toBeUndefined();
  });

  it("startDate stays midnight UTC even when time text is present", () => {
    // Regression guard: #358 explicitly removed time-stuffing into startDate.
    const html = event({
      slug: "evening-show",
      title: "Evening Show",
      body: "Jul 4, 2026 — 06:00 PM - 11:00 PM",
    });

    const result = parseEventsFromHtml(html);
    const e = result[0];
    expect(e.startDate?.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(e.startDate?.getUTCHours()).toBe(0);
    expect(e.eventDays).toEqual([{ date: "2026-07-04", openTime: "18:00", closeTime: "23:00" }]);
  });
});
