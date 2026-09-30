/**
 * OPE-987 — organizer-page cancellation notices, on pages as fetched 2026-09-13
 * with the MMATF User-Agent (fixtures/ope987, unedited and whole).
 *
 *   capecodbrewfest_com.html                 the specimen: "2026 Festival Canceled",
 *                                            with the 2026 roster sections still live
 *   durhamfair_com.html                      live upcoming fair (2026-09-24), control
 *   guilfordfair_org_2026-tickets.html       live upcoming fair, carries the real
 *                                            "subject to change and/or cancellation
 *                                            due to weather" boilerplate
 *   coggeshallfarm_org_harvest-festival-2026 live upcoming event, carries "In case of
 *                                            inclement weather, some activities may
 *                                            be altered or canceled."
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_LEAD_CHARS,
  detectCancellationNotice,
  stripRosterRegions,
} from "../cancellation-notice";

const F = (f: string) => readFileSync(join(__dirname, "fixtures/ope987", f), "utf8");
const CAPE_COD = F("capecodbrewfest_com.html");
const DURHAM = F("durhamfair_com.html");
const GUILFORD = F("guilfordfair_org_2026-tickets.html");
const COGGESHALL = F("coggeshallfarm_org_harvest-festival-2026.html");

const page = (body: string, head = "<title>Somewhere Fair</title>") =>
  `<html><head>${head}</head><body>${body}</body></html>`;

describe("OPE-987 — real pages", () => {
  it("ACCEPTANCE (red): capecodbrewfest.com announces the 2026 cancellation", () => {
    const r = detectCancellationNotice(CAPE_COD, { eventYear: 2026 });
    expect(r.matched).toBe(true);
    expect(r.phrase).toMatch(/cancel/i);
    expect(r.hits.map((h) => h.sentence)).toEqual(
      expect.arrayContaining([
        "2026 Festival Canceled",
        expect.stringContaining("decision to cancel the 2026 Cape Cod Brew Fest"),
      ])
    );
  });

  it("LANDMARK: the specimen still carries the live 2026 roster sections the old checks read as 'on'", () => {
    expect(CAPE_COD).toMatch(/Attending Breweries/);
    expect(CAPE_COD).toMatch(/Attending Vendors/);
  });

  it("Cape Cod scope is UNCLEAR, with both readings kept: body names 2026, meta ends the series", () => {
    const r = detectCancellationNotice(CAPE_COD, { eventYear: 2026 });
    expect(r.scope).toBe("unclear");
    expect(r.scopes).toEqual(expect.arrayContaining(["year", "series"]));
    const meta = r.hits.find((h) => h.region === "meta");
    expect(meta).toMatchObject({ scope: "series", phrase: "decision to end the" });
    expect(r.hits.some((h) => h.region === "body" && h.scope === "year")).toBe(true);
  });

  it("the heading region on its own also fires on the specimen", () => {
    const r = detectCancellationNotice(CAPE_COD, { eventYear: 2026 });
    expect(
      r.hits.some((h) => h.region === "heading" && h.sentence === "2026 Festival Cancelled")
    ).toBe(true);
  });

  it("ACCEPTANCE (green): durhamfair.com, a live upcoming fair, raises nothing", () => {
    expect(detectCancellationNotice(DURHAM, { eventYear: 2026 }).matched).toBe(false);
  });

  it("ACCEPTANCE (green): guilfordfair.org's weather/cancellation boilerplate raises nothing", () => {
    expect(GUILFORD).toMatch(/subject to change and\/or cancellation due to weather/);
    expect(detectCancellationNotice(GUILFORD, { eventYear: 2026 }).matched).toBe(false);
  });

  it("ACCEPTANCE (green): coggeshallfarm.org's 'may be altered or canceled' raises nothing", () => {
    expect(COGGESHALL).toMatch(/some activities may be altered or canceled/);
    expect(detectCancellationNotice(COGGESHALL, { eventYear: 2026 }).matched).toBe(false);
  });
});

describe("OPE-987 — boilerplate is not an announcement", () => {
  const negatives: Array<[string, string]> = [
    [
      "refund policy",
      "<p>Refund policy: if the event is cancelled due to weather, tickets will be refunded.</p>",
    ],
    [
      "cancellation policy heading",
      "<h2>Cancellation Policy</h2><p>No refunds within 14 days.</p>",
    ],
    ["vendor cancellation fee", "<p>A cancellation fee of $25 applies to booth refunds.</p>"],
    ["rain or shine", "<p>The fair runs rain or shine, no cancellations.</p>"],
    ["in the event of", "<p>In the event of cancellation, vendors will be notified by email.</p>"],
    ["may be cancelled", "<p>Outdoor shows may be cancelled in high winds.</p>"],
    [
      "real: guilford",
      "<p>Performances &amp; Showtimes are subject to change and/or cancellation due to weather or other unforseen issues.</p>",
    ],
    [
      "real: coggeshall",
      "<p>In case of inclement weather, some activities may be altered or canceled.</p>",
    ],
    [
      "real: fairsandfestivals",
      "<p>Information: Some events do get cancelled or postponed due to various reasons.</p>",
    ],
    ["reader's own action", "<p>To cancel your booth registration, email the office.</p>"],
    ["rain date", "<p>If it rains Saturday the parade will be postponed to the rain date.</p>"],
    ["history (covid)", "<p>The fair was cancelled in 2020 due to COVID-19.</p>"],
    ["history (other year)", "<p>The 2021 festival was cancelled, but we came back stronger.</p>"],
    ["denial", "<p>The 2026 fair will not be cancelled.</p>"],
  ];
  for (const [name, body] of negatives) {
    it(`does not fire: ${name}`, () => {
      expect(detectCancellationNotice(page(body), { eventYear: 2026 }).matched).toBe(false);
    });
  }

  it("the same vocabulary WITHOUT the boilerplate does fire (the negatives are what hold the line)", () => {
    expect(
      detectCancellationNotice(page("<p>The 2026 fair has been cancelled.</p>"), {
        eventYear: 2026,
      }).matched
    ).toBe(true);
  });
});

describe("OPE-987 — scope", () => {
  it("year: the phrase names the event year", () => {
    const r = detectCancellationNotice(page("<h1>2026 Festival Canceled</h1>"), {
      eventYear: 2026,
    });
    expect(r).toMatchObject({ matched: true, scope: "year", scopes: ["year"] });
  });

  it("year: 'cancel the 2026 …' in prose", () => {
    const r = detectCancellationNotice(
      page("<p>We have made the difficult decision to cancel the 2026 Harvest Fair.</p>"),
      { eventYear: 2026 }
    );
    expect(r.scope).toBe("year");
  });

  it("series: 'end the …' with no year", () => {
    const r = detectCancellationNotice(
      page("<p>After 20 years we have decided to end the Harvest Fair. Thank you!</p>"),
      { eventYear: 2026 }
    );
    expect(r).toMatchObject({ matched: true, scope: "series" });
  });

  it("series: 'will no longer be held'", () => {
    const r = detectCancellationNotice(page("<p>The Harvest Fair will no longer be held.</p>"));
    expect(r.scope).toBe("series");
  });

  it("series: a cancellation sentence with a series cue ('permanently')", () => {
    const r = detectCancellationNotice(
      page("<h2>The festival has been permanently cancelled</h2>")
    );
    expect(r.scope).toBe("series");
  });

  it("unclear: 'Festival Cancelled' naming no year and no series cue", () => {
    const r = detectCancellationNotice(page("<h1>Festival Cancelled</h1><p>See you soon.</p>"));
    expect(r).toMatchObject({ matched: true, scope: "unclear" });
  });

  it("unclear + one definite scope resolves to the definite one", () => {
    const r = detectCancellationNotice(
      page("<h1>Festival Cancelled</h1><p>The 2026 festival has been cancelled.</p>"),
      { eventYear: 2026 }
    );
    expect(r.scope).toBe("year");
    expect(r.scopes).toEqual(expect.arrayContaining(["unclear", "year"]));
  });

  it("year + series → unclear (the Cape Cod conflict, synthetic)", () => {
    const r = detectCancellationNotice(
      page(
        "<p>We have decided to cancel the 2026 Brew Fest.</p>",
        '<title>Brew Fest</title><meta name="description" content="We have made the decision to end the Brew Fest.">'
      ),
      { eventYear: 2026 }
    );
    expect(r.scope).toBe("unclear");
    expect(r.scopes.sort()).toEqual(["series", "year"]);
  });

  it("postponed and called off are announcements too", () => {
    expect(
      detectCancellationNotice(page("<h2>2026 Fair Postponed</h2>"), { eventYear: 2026 }).matched
    ).toBe(true);
    expect(
      detectCancellationNotice(page("<p>This year's show has been called off.</p>")).matched
    ).toBe(true);
  });

  it("no html → no match", () => {
    expect(detectCancellationNotice(null).matched).toBe(false);
    expect(detectCancellationNotice("").matched).toBe(false);
  });
});

describe("OPE-987 — regions", () => {
  // A long nav/intro so the notice sits beyond the body lead window.
  const filler = `<div>${"Welcome to the fair, with rides and food and music for the whole family. ".repeat(40)}</div>`;

  it("title alone fires even when the body lead never mentions it", () => {
    const r = detectCancellationNotice(
      page(`${filler}<div>Details…</div>`, "<title>2026 Harvest Fair – CANCELLED</title>"),
      { eventYear: 2026 }
    );
    expect(filler.length).toBeGreaterThan(BODY_LEAD_CHARS);
    expect(r.hits.map((h) => h.region)).toEqual(["title"]);
  });

  it("a heading below the body lead still fires (headings are scanned whole-page)", () => {
    const r = detectCancellationNotice(
      page(`${filler}<h3>The 2026 Harvest Fair is cancelled</h3>`),
      {
        eventYear: 2026,
      }
    );
    expect(r.matched).toBe(true);
    expect(r.hits.map((h) => h.region)).toEqual(["heading"]);
  });

  it("a plain paragraph beyond the body lead does NOT fire — body is lead-only by design", () => {
    const r = detectCancellationNotice(
      page(`${filler}<p>Footnote: the 2026 raffle was cancelled.</p>`),
      {
        eventYear: 2026,
      }
    );
    expect(r.matched).toBe(false);
  });

  it("meta description fires", () => {
    const r = detectCancellationNotice(
      page(
        "<p>Hello</p>",
        '<title>x</title><meta property="og:description" content="The 2026 fair has been cancelled.">'
      ),
      { eventYear: 2026 }
    );
    expect(r.hits.map((h) => h.region)).toEqual(["meta"]);
  });
});

describe("OPE-987 — roster regions", () => {
  const roster = (n: number) =>
    `<h2>Attending Vendors</h2><div class="grid">${Array.from(
      { length: n },
      (_, i) => `<div class="card"><p>Vendor Number ${i} Handmade Goods and Crafts</p></div>`
    ).join("")}</div>`;

  it("a long roster ABOVE the notice does not push it out of the body lead", () => {
    const html = page(`${roster(80)}<h2>Details</h2><p>The 2026 fair has been cancelled.</p>`);
    expect(roster(80).length).toBeGreaterThan(BODY_LEAD_CHARS);
    const r = detectCancellationNotice(html, { eventYear: 2026 });
    expect(r.matched).toBe(true);
    expect(r.hits.some((h) => h.region === "body")).toBe(true);
  });

  it("a list above the notice (nav/ul) does not push it out of the body lead", () => {
    const nav = `<ul>${Array.from({ length: 120 }, (_, i) => `<li>Menu item ${i}</li>`).join("")}</ul>`;
    const r = detectCancellationNotice(page(`${nav}<p>The 2026 fair has been cancelled.</p>`), {
      eventYear: 2026,
    });
    expect(r.hits.some((h) => h.region === "body")).toBe(true);
  });

  it("cancellation vocabulary INSIDE a roster does not fire", () => {
    const html = page(
      `<p>Join us September 20, 2026!</p><h2>Attending Breweries</h2><div><p>Cancelled Plans Brewing Co.</p></div><h2>Directions</h2><p>Exit 5.</p>`
    );
    expect(detectCancellationNotice(html, { eventYear: 2026 }).matched).toBe(false);
  });

  it("cancellation vocabulary inside a schedule list does not fire", () => {
    const html = page(
      `<p>Join us September 20, 2026!</p><ul><li>9am Pancake breakfast (cancelled)</li><li>10am Parade</li></ul>`
    );
    expect(detectCancellationNotice(html, { eventYear: 2026 }).matched).toBe(false);
  });

  it("stripRosterRegions cuts from a roster heading to the next heading of the same level", () => {
    const out = stripRosterRegions(
      "<h2>Attending Vendors</h2><p>A</p><h3>Food</h3><p>B</p><h2>Location</h2><p>C</p>"
    );
    expect(out).not.toMatch(/>A<|>B</);
    expect(out).toMatch(/Location/);
    expect(out).toMatch(/>C</);
  });
});
