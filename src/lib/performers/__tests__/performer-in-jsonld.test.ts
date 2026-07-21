/**
 * OPE-263 — `performerIn` Event nodes.
 *
 * Both indexed performer pages returned Google Rich Results
 * `FAIL — Missing field "location"` because this mapping emitted
 * `{ "@type": "Event", name, url, startDate? }` and nothing else. Google reads a
 * nested performerIn entry as a full Event DECLARATION, so the invalid stub
 * suppressed rich results on the very pages the performer feature exists to win.
 */
import { describe, it, expect } from "vitest";
import { buildPerformerInEvents } from "../performer-in-jsonld";

const SITE = "https://meetmeatthefair.com";
const VENUE = {
  name: "Topsham Fairgrounds",
  address: "54 Elm St",
  city: "Topsham",
  state: "ME",
  zip: "04086",
  latitude: 43.96,
  longitude: -69.97,
};
const DATE = new Date("2026-08-11T00:00:00Z");

describe("buildPerformerInEvents", () => {
  it("emits location — the field whose absence failed Rich Results", () => {
    const [ev] = buildPerformerInEvents(
      [{ name: "Topsham Fair", slug: "topsham-fair", startDate: DATE, venue: VENUE }],
      SITE
    );
    const loc = ev.location as Record<string, unknown>;
    expect(loc).toBeTruthy();
    expect(loc["@type"]).toBe("Place");
    const addr = loc.address as Record<string, unknown>;
    expect(addr.addressLocality).toBe("Topsham");
  });

  it("emits every required Event field", () => {
    const [ev] = buildPerformerInEvents(
      [{ name: "Topsham Fair", slug: "topsham-fair", startDate: DATE, venue: VENUE }],
      SITE
    );
    expect(ev["@type"]).toBe("Event");
    expect(ev.name).toBe("Topsham Fair");
    expect(ev.startDate).toBe(DATE.toISOString());
    expect(ev.url).toBe(`${SITE}/events/topsham-fair`);
  });

  it("still emits a location when the event has NO venue", () => {
    // The most likely regression path: a performer linked to a venue-less
    // event would silently reintroduce the original bug.
    const [ev] = buildPerformerInEvents(
      [{ name: "TBD Fair", slug: "tbd-fair", startDate: DATE, stateCode: "ME" }],
      SITE
    );
    expect(ev.location).toBeTruthy();
  });

  it("drops a dateless event rather than emitting it invalid (OPE-32)", () => {
    // startDate is required too. An omitted appearance costs one internal
    // link; an invalid one costs the whole page's rich result.
    expect(buildPerformerInEvents([{ name: "No Date", slug: "no-date" }], SITE)).toEqual([]);
    expect(buildPerformerInEvents([{ name: "N", slug: "n", startDate: null }], SITE)).toEqual([]);
  });

  it("drops an unparseable date instead of emitting 'Invalid Date'", () => {
    expect(
      buildPerformerInEvents([{ name: "Bad", slug: "bad", startDate: "not-a-date" }], SITE)
    ).toEqual([]);
  });

  it("accepts an ISO string as well as a Date", () => {
    const [ev] = buildPerformerInEvents(
      [{ name: "S", slug: "s", startDate: "2026-08-11T00:00:00.000Z", venue: VENUE }],
      SITE
    );
    expect(ev.startDate).toBe("2026-08-11T00:00:00.000Z");
  });

  it("keeps valid events when a sibling is dropped", () => {
    const out = buildPerformerInEvents(
      [
        { name: "Dateless", slug: "dateless" },
        { name: "Good", slug: "good", startDate: DATE, venue: VENUE },
      ],
      SITE
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Good");
  });

  it("returns [] for no events, so the caller omits performerIn entirely", () => {
    expect(buildPerformerInEvents([], SITE)).toEqual([]);
  });
});
