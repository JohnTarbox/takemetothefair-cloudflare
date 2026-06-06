/**
 * Tests for mainemade.com scraper — specifically the event_days extraction
 * restored after #358 dropped the source-page time-of-day stuffing.
 *
 * Scope: parseEventsFromHtml's eventDays output. Test fixtures mirror the
 * site's actual HTML shape (split by `all_events__container__item` divs
 * with `itemprop="startDate"` spans and a date-container div carrying the
 * full "Month Day @ HH:MM AM - HH:MM PM" text).
 */

import { describe, it, expect } from "vitest";
import { parseEventsFromHtml } from "../mainemade";

// Wrap an event's content in the structure the scraper expects.
function event(opts: {
  slug: string;
  title: string;
  startDateSpan: string; // text inside <span itemprop="startDate">
  endDateSpan?: string;
  dateContainer?: string; // text inside the date container div
  imageUrl?: string;
}): string {
  return `
    <div class="all_events__container__item">
      <a href="https://www.mainemade.com/event/${opts.slug}/">link</a>
      <div class="all_events__container__item__content__title">${opts.title}</div>
      <span itemprop="startDate">${opts.startDateSpan}</span>
      ${opts.endDateSpan ? `<span itemprop="endDate">${opts.endDateSpan}</span>` : ""}
      <div class="all_events__container__item__content__date">
        ${opts.dateContainer ?? opts.startDateSpan}
      </div>
      ${opts.imageUrl ? `<img src="${opts.imageUrl}" />` : ""}
    </div>
  `;
}

describe("mainemade parseEventsFromHtml — event_days extraction", () => {
  it("extracts eventDays from canonical 'Month Day @ HH:MM AM - HH:MM PM' pattern", () => {
    // The exact pattern #358 dropped, now restored.
    const html = event({
      slug: "winter-craft-fair",
      title: "Winter Craft Fair",
      startDateSpan: "February 7",
      dateContainer: "February 7 @ 2:00 PM - 7:00 PM",
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.name).toBe("Winter Craft Fair");
    // startDate stays midnight UTC per the date-only convention.
    const year = new Date().getUTCFullYear();
    expect(e.startDate?.toISOString()).toBe(`${year}-02-07T00:00:00.000Z`);
    // eventDays carries the wall-clock-at-venue times as "HH:MM" strings.
    expect(e.eventDays).toEqual([{ date: `${year}-02-07`, openTime: "14:00", closeTime: "19:00" }]);
  });

  it("extracts eventDays for a multi-day event, one row per calendar day", () => {
    const html = event({
      slug: "spring-fest",
      title: "Spring Fest",
      startDateSpan: "March 21",
      endDateSpan: "March 23",
      dateContainer: "March 21 - March 23 — 10:00 AM - 5:00 PM daily",
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    const e = result[0];
    const year = new Date().getUTCFullYear();
    expect(e.eventDays).toEqual([
      { date: `${year}-03-21`, openTime: "10:00", closeTime: "17:00" },
      { date: `${year}-03-22`, openTime: "10:00", closeTime: "17:00" },
      { date: `${year}-03-23`, openTime: "10:00", closeTime: "17:00" },
    ]);
  });

  it("omits eventDays when source has no time-of-day text", () => {
    const html = event({
      slug: "garden-tour",
      title: "Garden Tour",
      startDateSpan: "April 15",
      dateContainer: "April 15", // no time info
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].eventDays).toBeUndefined();
  });

  it("omits eventDays when time range is ambiguous (no AM/PM)", () => {
    // "9-5" with no AM/PM — could be 9am-5pm or 9pm-5am. We don't guess;
    // the admin fills in manually.
    const html = event({
      slug: "ambiguous-event",
      title: "Ambiguous Event",
      startDateSpan: "May 10",
      dateContainer: "May 10 9-5", // ambiguous
    });

    const result = parseEventsFromHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].eventDays).toBeUndefined();
  });

  it("startDate is still midnight UTC even when time text is present", () => {
    // Regression guard: #358 specifically removed time-stuffing into
    // startDate. Make sure we haven't reintroduced it via the new code path.
    const html = event({
      slug: "evening-show",
      title: "Evening Show",
      startDateSpan: "July 4",
      dateContainer: "July 4 @ 6:00 PM - 11:00 PM",
    });

    const result = parseEventsFromHtml(html);
    const e = result[0];
    const year = new Date().getUTCFullYear();
    // startDate at midnight UTC, NOT at 18:00 UTC.
    expect(e.startDate?.toISOString()).toBe(`${year}-07-04T00:00:00.000Z`);
    expect(e.startDate?.getUTCHours()).toBe(0);
    expect(e.startDate?.getUTCMinutes()).toBe(0);
    // Time-of-day lives in eventDays.
    expect(e.eventDays).toEqual([{ date: `${year}-07-04`, openTime: "18:00", closeTime: "23:00" }]);
  });
});
