/**
 * Tests for the deterministic calendar-link extractor.
 *
 * Coverage targets the three calendar URL shapes seen in production fair
 * pages: Google Calendar TEMPLATE (most common — emitted by The Events
 * Calendar / Modern Tribe plugin), Outlook deeplink (chamber + .gov pages),
 * and the malformed-but-recoverable variants observed during the URL-import
 * audit.
 */

import { describe, it, expect } from "vitest";
import { parseCalendarLink, findCalendarLinks } from "../calendar-link";

describe("parseCalendarLink — Google Calendar", () => {
  it("parses a same-day timed Google Calendar template URL", () => {
    const url =
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=Maine+Antique+Tractor+Show" +
      "&dates=20260626T080000Z/20260626T170000Z" +
      "&location=123+Main+St%2C+Springfield%2C+ME+04081" +
      "&details=Annual+vintage+tractor+exhibition.";
    const result = parseCalendarLink(url);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Maine Antique Tractor Show");
    expect(result!.startDate).toBe("2026-06-26");
    expect(result!.endDate).toBe("2026-06-26");
    expect(result!.startTime).toBe("08:00");
    expect(result!.endTime).toBe("17:00");
    expect(result!.venueAddress).toBe("123 Main St, Springfield, ME 04081");
    expect(result!.venueCity).toBe("Springfield");
    expect(result!.venueState).toBe("ME");
    expect(result!.description).toContain("vintage tractor exhibition");
  });

  it("parses a multi-day all-day range (no time component)", () => {
    const url =
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=Maine+Antique+Tractor+Club+Show" +
      "&dates=20260626/20260628" +
      "&location=PO+Box+1%2C+Acton%2C+ME";
    const result = parseCalendarLink(url);
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-06-26");
    expect(result!.endDate).toBe("2026-06-28");
    expect(result!.startTime).toBeNull();
    expect(result!.endTime).toBeNull();
  });

  it("returns null when action is not TEMPLATE", () => {
    const url = "https://calendar.google.com/calendar/render?action=VIEW&cid=primary";
    expect(parseCalendarLink(url)).toBeNull();
  });

  it("returns null when dates param is missing", () => {
    const url = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Some+Event";
    expect(parseCalendarLink(url)).toBeNull();
  });

  it("returns null when dates param has unrecognized shape", () => {
    const url =
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=Some+Event" +
      "&dates=tomorrow/next-week";
    expect(parseCalendarLink(url)).toBeNull();
  });
});

describe("parseCalendarLink — Outlook", () => {
  it("parses an Outlook deeplink with ISO datetime", () => {
    const url =
      "https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose" +
      "&subject=Winthrop+Arts+Festival" +
      "&startdt=2026-08-15T09:00:00" +
      "&enddt=2026-08-15T16:00:00" +
      "&location=Main+St%2C+Winthrop%2C+ME" +
      "&body=Annual+downtown+festival.";
    const result = parseCalendarLink(url);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Winthrop Arts Festival");
    expect(result!.startDate).toBe("2026-08-15");
    expect(result!.endDate).toBe("2026-08-15");
    expect(result!.startTime).toBe("09:00");
    expect(result!.endTime).toBe("16:00");
    // location uses literal '+', so decodeFormPlus is exercised — but
    // Outlook's params come URL-decoded on the URL object; verify the
    // raw-string fallback path.
  });

  it("treats missing enddt as same-day all-day", () => {
    const url =
      "https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose" +
      "&subject=Open+Studio+Day" +
      "&startdt=2026-09-15";
    const result = parseCalendarLink(url);
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-09-15");
    expect(result!.endDate).toBe("2026-09-15");
  });
});

describe("parseCalendarLink — junk input", () => {
  it("returns null for non-URL strings", () => {
    expect(parseCalendarLink("not a url")).toBeNull();
    expect(parseCalendarLink("")).toBeNull();
  });

  it("returns null for non-calendar URLs", () => {
    expect(parseCalendarLink("https://example.com/events/foo")).toBeNull();
    expect(parseCalendarLink("https://www.facebook.com/events/12345")).toBeNull();
  });
});

describe("findCalendarLinks", () => {
  it("finds Google Calendar href in HTML", () => {
    const html =
      `<html><body>` +
      `<a href="https://calendar.google.com/calendar/render?action=TEMPLATE&dates=20260626/20260628">Add</a>` +
      `<a href="/some/other/link">Other</a>` +
      `</body></html>`;
    const links = findCalendarLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("calendar.google.com");
  });

  it("finds Outlook href in HTML", () => {
    const html = `<a href='https://outlook.live.com/calendar/0/deeplink/compose?startdt=2026-08-15'>Outlook</a>`;
    const links = findCalendarLinks(html);
    expect(links).toHaveLength(1);
  });

  it("dedups identical hrefs", () => {
    const url =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&dates=20260626/20260628";
    const html = `<a href="${url}">A</a><a href="${url}">B</a>`;
    const links = findCalendarLinks(html);
    expect(links).toHaveLength(1);
  });

  it("caps at 5 links to bound parsing", () => {
    const url =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&dates=20260626/20260628";
    // Make each link unique so dedup doesn't kick in.
    const html = Array.from({ length: 10 }, (_, i) => `<a href="${url}&n=${i}">x</a>`).join("");
    const links = findCalendarLinks(html);
    expect(links).toHaveLength(5);
  });

  it("returns empty array when no calendar links present", () => {
    const html = `<a href="/foo">x</a><a href="https://example.com">y</a>`;
    expect(findCalendarLinks(html)).toEqual([]);
  });
});
