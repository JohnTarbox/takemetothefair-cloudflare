/**
 * OPE-1233 / OPE-1187 — 13 fairs kept their 2026 and 2027 editions in two
 * event_series. The 2026 EVENT names still carried an SEO tail ("Sterling Fair
 * 2026 — Sep 11–13 in Sterling, MA") or a mid-name year ("The Big E 2026
 * (Eastern States Exposition)"), so neither the grouper's name key nor the live
 * attach path's `seriesNameKey` ever met the 2027 edition's "Sterling Fair 2027".
 *
 * Fixture: the 26 real events (slug, name, venue) read from prod D1 2026-10-01.
 */
import { describe, it, expect } from "vitest";
import { groupEvents, stripNameEditionSuffix, type GroupableEvent } from "../group-events";
import { seriesNameKey } from "@takemetothefair/event-series";

const PAIRS: [string, string, string, string, string][] = [
  // [venue, 2026 slug, 2026 name, 2027 slug, 2027 name]
  [
    "v-barn",
    "barnstable-county-fair-2026",
    "Barnstable County Fair 2026",
    "barnstable-county-fair-ma-2027",
    "Barnstable County Fair 2027",
  ],
  [
    "v-belc",
    "belchertown-fair-2026",
    "Belchertown Fair 2026 — Sep 25–27 in Belchertown, MA",
    "belchertown-fair-ma-2027",
    "Belchertown Fair 2027",
  ],
  [
    "v-berl",
    "berlin-fair-2026",
    "Berlin Fair 2026 — Sep 17–20 in Berlin, CT",
    "berlin-fair-ct-2027",
    "Berlin Fair 2027",
  ],
  ["v-bolt", "bolton-fair-2026", "Bolton Fair 2026", "bolton-fair-ma-2027", "Bolton Fair 2027"],
  [
    "v-cumm",
    "cummington-fair-2026",
    "Cummington Fair 2026 — Aug 27–30 in Cummington, MA",
    "cummington-fair-ma-2027",
    "Cummington Fair 2027",
  ],
  [
    "v-hadd",
    "haddam-neck-fair-2026",
    "Haddam Neck Fair 2026 — Sep 4–7 in East Hampton, CT",
    "haddam-neck-fair-ct-2027",
    "Haddam Neck Fair 2027",
  ],
  [
    "v-mars",
    "marshfield-fair-2026",
    "Marshfield Fair 2026 — Aug 21–30 in Marshfield, MA",
    "marshfield-fair-ma-2027",
    "Marshfield Fair 2027",
  ],
  [
    "v-ster",
    "sterling-fair-2026",
    "Sterling Fair 2026 — Sep 11–13 in Sterling, MA",
    "sterling-fair-ma-2027",
    "Sterling Fair 2027",
  ],
  [
    "v-tunb",
    "tunbridge-worlds-fair-2026",
    "Tunbridge World's Fair 2026",
    "tunbridge-worlds-fair-vt-2027",
    "Tunbridge World's Fair 2027",
  ],
  [
    "v-west",
    "westfield-fair-2026",
    "Westfield Fair 2026 — Aug 21–23 in Westfield, MA",
    "westfield-fair-ma-2027",
    "Westfield Fair 2027",
  ],
  [
    "v-wolc",
    "wolcott-country-fair-2026",
    "Wolcott Country Fair 2026 — Aug 7–9 in Wolcott, CT",
    "wolcott-country-fair-ct-2027",
    "Wolcott Country Fair 2027",
  ],
  [
    "v-wood",
    "woodstock-fair-2026",
    "Woodstock Fair 2026 — Sep 3–7 in South Woodstock, CT",
    "woodstock-fair-ct-2027",
    "Woodstock Fair 2027",
  ],
  [
    "v-bige",
    "the-big-e-2026-eastern-states-exposition",
    "The Big E 2026 (Eastern States Exposition)",
    "the-big-e-eastern-states-exposition-ma-2027",
    "The Big E (Eastern States Exposition) 2027",
  ],
];

let seq = 0;
const ev = (slug: string, name: string, venueId: string | null, year: number): GroupableEvent => ({
  id: `e${seq++}`,
  slug,
  name,
  venueId,
  startDate: new Date(Date.UTC(year, 8, 1)),
  completenessScore: 0,
  vendorLinkCount: 0,
});

describe("OPE-1233 stripNameEditionSuffix — the shapes the split fairs carried", () => {
  it("strips an SEO date tail and a pre-parenthetical year", () => {
    expect(stripNameEditionSuffix("Sterling Fair 2026 — Sep 11–13 in Sterling, MA")).toBe(
      "Sterling Fair"
    );
    expect(stripNameEditionSuffix("Woodstock Fair 2026 — Sep 3–7 in South Woodstock, CT")).toBe(
      "Woodstock Fair"
    );
    expect(stripNameEditionSuffix("The Big E 2026 (Eastern States Exposition)")).toBe(
      "The Big E (Eastern States Exposition)"
    );
  });
  it("leaves names that only look similar", () => {
    expect(stripNameEditionSuffix("Summer 2026 Kickoff")).toBe("Summer 2026 Kickoff");
    expect(stripNameEditionSuffix("Fair - May Edition")).toBe("Fair - May Edition"); // month, no day
    expect(stripNameEditionSuffix("Route 66 Rally")).toBe("Route 66 Rally");
    expect(stripNameEditionSuffix("Sterling Fair")).toBe("Sterling Fair");
  });
});

describe("OPE-1233 every split pair now shares ONE key", () => {
  it("the live attach key (seriesNameKey) matches across each pair", () => {
    for (const [, , n26, , n27] of PAIRS) {
      expect(`${n26} → ${seriesNameKey(n26)}`).toBe(`${n26} → ${seriesNameKey(n27)}`);
    }
  });

  it("the backfill grouper puts all 13 pairs into 13 two-edition groups", () => {
    const events = PAIRS.flatMap(([v, s26, n26, s27, n27]) => [
      ev(s26, n26, v, 2026),
      ev(s27, n27, v, 2027),
    ]);
    const groups = groupEvents(events);
    expect(groups).toHaveLength(PAIRS.length);
    for (const g of groups) expect(`${g.canonicalSlug}:${g.members.length}`).toMatch(/:2$/);
  });

  it("does NOT fuse the same name at two different venues (Guilford CT vs Guilford VT)", () => {
    const groups = groupEvents([
      ev("guilford-fair-2026", "Guilford Fair 2026 — Sep 18–20 in Guilford, CT", "v-gct", 2026),
      ev("guilford-fair-vt-2026", "Guilford Fair 2026", "v-gvt", 2026),
    ]);
    expect(groups).toHaveLength(2);
  });
});
