/**
 * OPE-1629 — the default "kids" program rule dropped public markets.
 *
 * Fixtures are the live TEC REST reads of 2026-11-11, trimmed to the fields
 * mapTecEvent reads (organizer domains rewritten to .example; the local part,
 * which is what the organizer rule keys on, is unchanged).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapTecEvent, type FeedEvent } from "../feeds/feed-event";
import { DEFAULT_INCLUSION_RULES, decideInclusion, parseInclusionRules } from "../feeds/inclusion";

type Raw = Record<string, unknown>;
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures/ope1629-tec-feeds-2026-11-11.json"), "utf8")
) as { feeds: Record<string, Raw[]> };

const events = (feed: string): FeedEvent[] => {
  const raw = FIXTURE.feeds[feed];
  expect(raw?.length, `fixture feed ${feed}`).toBeGreaterThan(0);
  return raw.map((r) => mapTecEvent(r)!).filter(Boolean);
};
const verdicts = (feed: string) =>
  events(feed).map((ev) => ({ ...decideInclusion(ev, DEFAULT_INCLUSION_RULES), ev }));

const ev = (o: Partial<FeedEvent>): FeedEvent => ({
  externalId: "x",
  title: "Untitled",
  url: null,
  startDate: "2027-01-16",
  endDate: "2027-01-16",
  startTime: null,
  endTime: null,
  allDay: false,
  timezone: null,
  venue: null,
  organizerEmails: [],
  imageUrl: null,
  description: "",
  categories: [],
  cost: null,
  statusCancelled: false,
  ...o,
});
const decide = (o: Partial<FeedEvent>) => decideInclusion(ev(o), DEFAULT_INCLUSION_RULES);

describe("OPE-1629 — real feeds, 2026-11-11", () => {
  it("keeps all 7 of Marshfield Fair's Indoor Farmers' Markets", () => {
    const v = verdicts("marsh");
    expect(v).toHaveLength(7);
    // Positive landmark: the description really does say "kids" — this is
    // the input that used to be dropped, not a fixture that never matched.
    for (const x of v) expect(x.ev.description).toMatch(/\bkids\b/i);
    expect(v.filter((x) => x.included)).toHaveLength(7);
    for (const x of v) expect(x.reason).toBe("title matches /market/");
  });

  it("OHTM still includes exactly the same 3 of 20, and drops every program", () => {
    const v = verdicts("ohtm");
    expect(v).toHaveLength(20);
    expect(
      v
        .filter((x) => x.included)
        .map((x) => x.ev.title)
        .sort()
    ).toEqual([
      "Holidays at the Museum",
      "Parade of Lights- Offsite Event",
      "Rockland Parade of Lights",
    ]);
    for (const x of v.filter((y) => /junior|stem|owls nest/i.test(y.ev.title)))
      expect(x.included, x.ev.title).toBe(false);
  });

  it("keeps Saco's Main Street Market (its description matched /stem/)", () => {
    const market = verdicts("saco").find((x) => x.ev.title === "Main Street Market")!;
    expect(market.ev.description).toMatch(/\bstem\b/i);
    expect(market).toMatchObject({ included: true, reason: "title matches /market/" });
  });

  it("does not flip any Saco or Gurley item to excluded", () => {
    for (const feed of ["saco", "gurley"]) {
      const v = verdicts(feed);
      expect(v.length).toBeGreaterThan(0);
      expect(v.filter((x) => !x.included).map((x) => x.ev.title)).toEqual([]);
    }
  });
});

describe("OPE-1629 — the program rule", () => {
  it("a program word in the title still drops on its own", () => {
    expect(decide({ title: "Kids STEM Saturday" })).toEqual({
      included: false,
      reason: "program title matches /\\bkids?\\b/",
    });
  });

  it("a description that only MENTIONS kids is an ordinary public event", () => {
    expect(
      decide({ title: "Harvest Supper", description: "Live music, and kids activities." })
    ).toEqual({ included: true, reason: "default include" });
  });

  it.each([
    ["registration", "Kids build robots. Registration required."],
    ["an age band", "A morning for kids, ages 6-10."],
    ["a grade band", "Hands-on STEM for families, K-8th grade."],
    ["an after-school schedule", "Join us for after-school STEM programming."],
    ["a session schedule", "Kids art: four weekly sessions."],
  ])("a description that reads like a program (%s) still drops", (_label, description) => {
    const v = decide({ title: "Saturday Morning", description });
    expect(v.included).toBe(false);
    expect(v.reason).toMatch(/^program description matches \/.+\/ and \/.+\/$/);
  });

  it("'Kids Day at the Fair' is kept by fair", () => {
    expect(decide({ title: "Kids Day at the Fair" })).toEqual({
      included: true,
      reason: "title matches /fair/",
    });
  });

  it.each([
    "Holiday Bazaar",
    "Spring Flea Market",
    "Antique Tractor Day",
    "Home Expo",
    "Craft Sale",
  ])("%s is kept by its title word", (title) => {
    expect(decide({ title, description: "Fun for kids! Register at the door." }).included).toBe(
      true
    );
  });

  it("a closure still drops before any include word", () => {
    expect(decide({ title: "[Closed] Farmers' Market" }).included).toBe(false);
  });

  it("a per-feed override that predates the signals still gets the default signals", () => {
    const r = parseInclusionRules(JSON.stringify({ excludeProgramPatterns: ["\\bscouts\\b"] }));
    expect(r.programDescriptionSignals).toEqual(DEFAULT_INCLUSION_RULES.programDescriptionSignals);
    expect(
      decideInclusion(ev({ title: "Open House", description: "Scouts welcome" }), r).included
    ).toBe(true);
    expect(
      decideInclusion(ev({ title: "Open House", description: "Scouts: register by Friday" }), r)
        .included
    ).toBe(false);
  });
});
