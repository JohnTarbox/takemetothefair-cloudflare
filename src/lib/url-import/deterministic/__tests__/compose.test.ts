/**
 * End-to-end test for the deterministic composer. Exercises the salvage
 * gate (name + (date OR venue)) and the confidence-assignment rules.
 *
 * The canonical moose-lottery shape is the headline fixture: HTML with a
 * <title> and <h2> month-day range, no JSON-LD, no calendar links. AI
 * extraction returned zero events on this page; the composer should
 * salvage it.
 */

import { describe, it, expect } from "vitest";
import { composeDeterministicExtract } from "../compose";

describe("composeDeterministicExtract — moose-lottery shape", () => {
  it("salvages the moose-lottery page (h1 name + h2 date range)", () => {
    const html = `
      <html>
        <head><title>2026 Maine State Moose Lottery Permit Drawing</title></head>
        <body>
          <h1>2026 Maine State Moose Lottery Permit Drawing</h1>
          <h2>JUNE 19-20, 2026</h2>
          <p>Acton Fairgrounds, Acton, ME</p>
        </body>
      </html>
    `;
    const cleanedText =
      "2026 Maine State Moose Lottery Permit Drawing JUNE 19-20, 2026 Acton Fairgrounds, Acton, ME";

    const result = composeDeterministicExtract(
      html,
      cleanedText,
      { title: "2026 Maine State Moose Lottery Permit Drawing" },
      "https://me2026mooseloto.com"
    );

    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.name).toBe("2026 Maine State Moose Lottery Permit Drawing");
    expect(ev.startDate).toBe("2026-06-19");
    expect(ev.endDate).toBe("2026-06-20");
    // Confidence: name medium, regex dates medium, everything else low.
    const conf = result.confidence[ev._extractId];
    expect(conf.name).toBe("medium");
    expect(conf.startDate).toBe("medium");
    expect(conf.venueAddress).toBe("low");
  });
});

describe("composeDeterministicExtract — TEC-plugin shape with gcal link", () => {
  it("salvages a TEC page where the calendar link supplies dates + location", () => {
    const html = `
      <html>
        <head><title>Maine Antique Tractor Show 2026 | Maine Antique Tractor Club</title></head>
        <body>
          <h1>Maine Antique Tractor Show 2026</h1>
          <a class="tribe-events-gcal" href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=Maine+Antique+Tractor+Show&dates=20260626T080000Z/20260628T170000Z&location=PO+Box+1%2C+Acton%2C+ME+04001">
            Add to Google Calendar
          </a>
        </body>
      </html>
    `;
    const cleanedText = "Maine Antique Tractor Show 2026 Add to Google Calendar";

    const result = composeDeterministicExtract(
      html,
      cleanedText,
      { title: "Maine Antique Tractor Show 2026 | Maine Antique Tractor Club" },
      "https://maineantiquetractorclub.org/show-2026"
    );

    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    // OG title with " | <chrome>" tail gets stripped to the event name.
    expect(ev.name).toBe("Maine Antique Tractor Show 2026");
    expect(ev.startDate).toBe("2026-06-26");
    expect(ev.endDate).toBe("2026-06-28");
    expect(ev.venueAddress).toContain("Acton, ME");
    expect(ev.venueCity).toBe("Acton");
    expect(ev.venueState).toBe("ME");
    // Calendar-link-sourced fields are high confidence.
    const conf = result.confidence[ev._extractId];
    expect(conf.startDate).toBe("high");
    expect(conf.venueAddress).toBe("high");
  });
});

describe("composeDeterministicExtract — Makers Market body-only", () => {
  it("returns empty when there's no calendar link and no name+date in body prose", () => {
    // Body without an explicit date phrase — the composer should fail the
    // gate because there's no parseable date AND no venue address.
    const cleanedText = "Save the date for our makers market";

    const result = composeDeterministicExtract("", cleanedText, undefined, undefined);

    expect(result.events).toHaveLength(0);
  });

  it("salvages a body that has name in h1 + date in prose", () => {
    const html = "<h1>It's Finally Fall Makers Market</h1>";
    const cleanedText =
      "It's Finally Fall Makers Market — Saturday, October 3, 2026 at Farmington Fairgrounds";

    const result = composeDeterministicExtract(html, cleanedText, undefined, undefined);

    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.name).toBe("It's Finally Fall Makers Market");
    expect(ev.startDate).toBe("2026-10-03");
    expect(ev.endDate).toBe("2026-10-03");
  });
});

describe("composeDeterministicExtract — salvage gate", () => {
  it("returns empty when only a name is found (no date, no venue)", () => {
    const html = "<h1>Annual Festival</h1>";
    const cleanedText = "Annual Festival — TBD";

    const result = composeDeterministicExtract(html, cleanedText, undefined, undefined);
    expect(result.events).toHaveLength(0);
  });

  it("returns empty when only a date is found (no name)", () => {
    const cleanedText = "Save the date: October 3, 2026";

    const result = composeDeterministicExtract("", cleanedText, undefined, undefined);
    expect(result.events).toHaveLength(0);
  });
});
