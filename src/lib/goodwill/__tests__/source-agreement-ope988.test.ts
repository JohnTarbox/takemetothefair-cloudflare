/**
 * OPE-988 — does the cited page name the event's town or venue?
 *
 * Real pages (fixtures/ope988), fetched 2026-09-13 with the MMATF UA:
 *   - johnnyappleseedfest_com.html  — the Fort Wayne, INDIANA festival that sat
 *     in the Leominster, MA event's source_url. Must read RED (disagrees).
 *   - leominsterrotary_org_events.html — the corrected source. Must read GREEN.
 *
 * A check that only ever returns one of those answers fails this file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSourceAgreement,
  isOrganizerSourceUrl,
  prominentStateMentions,
} from "../source-agreement";

const F = (f: string) => readFileSync(join(__dirname, "fixtures/ope988", f), "utf8");

const LEOMINSTER = {
  eventName: "Johnny Appleseed Arts and Cultural Festival",
  city: "Leominster",
  state: "MA",
  venueName: "Downtown Leominster (Monument Square)",
};

/** Enough prose to clear the too-little-text floor without naming any place. */
const FILLER =
  "Join us for a weekend of music, food and crafts for the whole family. Vendors, " +
  "demonstrators and performers from all around will be here, and admission is free. " +
  "Bring a chair, bring your appetite, and plan to stay the whole day with us this year.";

const page = (body: string, head = "") =>
  `<html lang="en"><head><title>Festival</title>${head}</head><body>${body}</body></html>`;

describe("OPE-988 ACCEPTANCE — the real specimen pages", () => {
  it("RED: the Fort Wayne, Indiana page does not describe the Leominster, MA event", () => {
    const r = checkSourceAgreement(F("johnnyappleseedfest_com.html"), LEOMINSTER);
    expect(r.agrees).toBe(false);
    expect(r.otherStates).toEqual(["IN"]);
    expect(r.signals).toContain("other-state:IN(address)");
    expect(r.signals.some((s) => s.startsWith("named-town"))).toBe(false);
  });

  it("GREEN: the Leominster Rotary events page names the town", () => {
    const r = checkSourceAgreement(F("leominsterrotary_org_events.html"), LEOMINSTER);
    expect(r.agrees).toBe(true);
    expect(r.signals).toContain("named-town:Leominster");
  });

  it("the SAME Fort Wayne page agrees with a Fort Wayne, IN event — the check is about place, not the page", () => {
    const r = checkSourceAgreement(F("johnnyappleseedfest_com.html"), {
      eventName: "Johnny Appleseed Festival",
      city: "Fort Wayne",
      state: "IN",
      venueName: "Johnny Appleseed Park",
    });
    expect(r.agrees).toBe(true);
  });
});

describe("town and venue matching", () => {
  it("is case- and punctuation-insensitive, and word-bounded", () => {
    const ctx = { eventName: "X", city: "Leominster", state: "MA" };
    expect(
      checkSourceAgreement(page(`${FILLER} Held in LEOMINSTER, rain or shine.`), ctx).agrees
    ).toBe(true);
    // `Leominster` inside a longer token is not the town.
    const inside = checkSourceAgreement(page(`${FILLER} Email leominsterrotary@gmail.com.`), ctx);
    expect(inside.agrees).toBeNull();
  });

  it("matches the venue even when the town is absent", () => {
    const r = checkSourceAgreement(page(`${FILLER} See you at Monument Square!`), LEOMINSTER);
    expect(r.agrees).toBe(true);
    expect(r.signals).toContain("named-venue:Monument Square");
  });

  it("a generic venue name ('Town Common') is never evidence by itself", () => {
    const r = checkSourceAgreement(
      page(`${FILLER} On the Town Common. 12 Main St, Anytown, NY 10001.`),
      { eventName: "X", city: "Townsend", state: "MA", venueName: "Town Common" }
    );
    expect(r.signals.some((s) => s.startsWith("named-venue"))).toBe(false);
    expect(r.agrees).toBe(false);
  });

  it("decodes entities before matching (Coeur d&#8217;Alene)", () => {
    const r = checkSourceAgreement(page(`${FILLER} Downtown Coeur d&#8217;Alene.`), {
      eventName: "X",
      city: "Coeur d'Alene",
      state: "ID",
    });
    expect(r.agrees).toBe(true);
  });

  it("reads JSON-LD addressLocality", () => {
    const ld = `<script type="application/ld+json">{"@type":"Event","location":{"address":{"addressLocality":"Leominster","addressRegion":"MA"}}}</script>`;
    const r = checkSourceAgreement(page(FILLER, ld), LEOMINSTER);
    expect(r.agrees).toBe(true);
  });
});

describe("state detection", () => {
  it("reads an address block, `City, Indiana`, and a repeated state name", () => {
    expect(prominentStateMentions("1502 Harry W. Baals Dr. Ft. Wayne, IN 46805")).toEqual([
      { code: "IN", how: "address" },
    ]);
    expect(prominentStateMentions("Fort Wayne, Indiana is lovely")).toEqual([
      { code: "IN", how: "comma-name" },
    ]);
    expect(prominentStateMentions("Indiana's best. Proudly Indiana.")).toEqual([
      { code: "IN", how: "name-repeated" },
    ]);
  });

  it("does NOT read an all-caps word as a state without a ZIP (IN, OR, ME)", () => {
    expect(prominentStateMentions("FOOD, IN THE PARK. RAIN, OR SHINE. JOIN, ME!")).toEqual([]);
    // Real text from franklinfarmri.org (read-only scan, 2026-09-13): NE = New England.
    expect(prominentStateMentions("RI Antique Tractor, NE Antique Tractor Club")).toEqual([]);
    // …but a non-word code after a comma is a location.
    expect(prominentStateMentions("Portland, CT")).toEqual([{ code: "CT", how: "comma-code" }]);
  });

  it("reads 'West Virginia' as WV, not also as VA", () => {
    expect(prominentStateMentions("Wheeling, West Virginia").map((m) => m.code)).toEqual(["WV"]);
  });

  it("a person or street named for a state is not a place ('George Washington', twice)", () => {
    expect(prominentStateMentions("George Washington slept here. Washington Street.")).toEqual([]);
  });

  it("accepts the event's state as a code or a full name", () => {
    const html = page(`${FILLER} Ft. Wayne, IN 46805`);
    expect(
      checkSourceAgreement(html, { eventName: "X", city: "Leominster", state: "MA" }).agrees
    ).toBe(false);
    expect(
      checkSourceAgreement(html, { eventName: "X", city: "Leominster", state: "Massachusetts" })
        .agrees
    ).toBe(false);
  });
});

describe("the three ways to say 'cannot tell'", () => {
  it("too little text", () => {
    const r = checkSourceAgreement(page("Ft. Wayne, IN 46805"), LEOMINSTER);
    expect(r.agrees).toBeNull();
    expect(r.signals).toEqual(["too-little-text"]);
  });

  it("a page naming no place at all", () => {
    const r = checkSourceAgreement(page(FILLER), LEOMINSTER);
    expect(r.agrees).toBeNull();
    expect(r.signals).toContain("no-location-evidence");
  });

  it("a page naming BOTH the other state and ours (a multi-state promoter's schedule)", () => {
    const r = checkSourceAgreement(
      page(`${FILLER} Shows in Nashua, NH 03060 and Worcester, MA 01608.`),
      LEOMINSTER
    );
    expect(r.agrees).toBeNull();
    expect(r.signals).toContain("own-state-only");
  });

  it("an event with no state cannot be contradicted by one", () => {
    const r = checkSourceAgreement(page(`${FILLER} Ft. Wayne, IN 46805`), {
      eventName: "X",
      city: null,
      state: null,
    });
    expect(r.agrees).toBeNull();
  });
});

describe("isOrganizerSourceUrl — the population", () => {
  it("excludes aggregators (canonical classifySource list), Facebook, and listing platforms", () => {
    expect(isOrganizerSourceUrl("https://www.mainemade.com/event/x/")).toBe(false);
    expect(isOrganizerSourceUrl("https://www.facebook.com/events/1")).toBe(false);
    expect(isOrganizerSourceUrl("https://www.eventbrite.com/e/x")).toBe(false);
    expect(isOrganizerSourceUrl("https://docs.google.com/forms/x")).toBe(false);
  });

  it("keeps organizer pages, including an organizer's own site on a site-builder subdomain", () => {
    expect(isOrganizerSourceUrl("https://www.leominsterrotary.org/Events")).toBe(true);
    expect(isOrganizerSourceUrl("https://maynardporchfest.wixsite.com/website")).toBe(true);
    expect(isOrganizerSourceUrl("not a url")).toBe(false);
  });
});
