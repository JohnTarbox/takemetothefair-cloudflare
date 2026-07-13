import { describe, it, expect } from "vitest";
import { detectRosterNames } from "../src/email-handlers/roster-detect.js";

// OPE-176 — roster detection from inbound email bodies. The canonical fixture is
// the real Art in the Park email (inbound_emails d7ee53e0): a `*… Vendors 2026*`
// heading followed by 29 `   - *Vendor Name*` bullets, with wrapped-prose lines
// that merely mention "vendor" (which must NOT be mistaken for the roster).
const ART_IN_THE_PARK = `---------- Forwarded message ---------
From: Pyle, Tiernan <Tiernan.Pyle@maine.gov>

Hello,

We wanted to clarify that the Microsoft Form served as a *vendor
application* and was *not* a confirmation of acceptance into the event.
Applications closed earlier this year, and our vendor selection process was
completed in March.

*Art in the Park Vendors 2026*


   - *Art by Peggy Hemberg Bosse*
   - *Bobby Haskell Artworks*
   - *Chasing Dragonflies*
   - *Colleen K Fornier Watercolorist*
   - *Creighton Studios*
   - *Cromwell's Bakery*
   - *Coyote Graphics*
   - *Daydream Creations*
   - *Eisenhaur Photography*
   - *Fav'rit Daughter Designs*
   - *Fine Art by Jennifer Zulker*
   - *FLYN*
   - *Forged by Thor*
   - *Jakalope Design*
   - *Julia Lillian Art*
   - *Lisa James Artistry and Carvings*
   - *Portland Design Co*
   - *Rebekah Lowell Creative Studio*
   - *Sparkle and Spice*
   - *Squirrel Cat Designs*
   - *T.R.A.C.K.S.*
   - *Terry Golson Animal Sculptures*
   - *The Ugly Candle Company*
   - *Tidal Force Creations*
   - *Toni Maria Jewelry*
   - *Tori Lee Jackson Photography*
   - *Whiskered Wires*
   - *Wood & Waters Designs*
   - *Wood Wizard*


We sincerely appreciate your interest in being a part of Art in the Park.`;

describe("detectRosterNames — Art in the Park (real fixture)", () => {
  const names = detectRosterNames(ART_IN_THE_PARK);

  it("detects all 29 vendors", () => {
    expect(names).toHaveLength(29);
  });

  it("strips Gmail bold markers and keeps the real business name", () => {
    expect(names[0]).toBe("Art by Peggy Hemberg Bosse");
    expect(names).toContain("FLYN");
    expect(names).toContain("T.R.A.C.K.S.");
    expect(names).toContain("Wood & Waters Designs"); // ampersand preserved
    expect(names).toContain("Cromwell's Bakery"); // apostrophe preserved
  });

  it("does NOT mistake the wrapped-prose 'vendor application' lines for the roster", () => {
    expect(names.some((n) => /application/i.test(n))).toBe(false);
    expect(names.some((n) => n.length > 60)).toBe(false); // no prose lines captured
  });
});

describe("detectRosterNames — shape + guard cases", () => {
  it("handles a numbered list under an 'Exhibitors' heading", () => {
    const body = `Exhibitors:
1. Alpha Crafts
2) Beta Bakery
3. Gamma Goods`;
    expect(detectRosterNames(body)).toEqual(["Alpha Crafts", "Beta Bakery", "Gamma Goods"]);
  });

  it("dedupes case-insensitively, preserving first-seen order", () => {
    const body = `Vendors
- Foo Co
- foo co
- Bar Co`;
    expect(detectRosterNames(body)).toEqual(["Foo Co", "Bar Co"]);
  });

  it("returns [] for a bulleted list with NO roster-keyword heading (feature list)", () => {
    const body = `What to expect:
- Free parking
- Live music
- Food trucks`;
    expect(detectRosterNames(body)).toEqual([]);
  });

  it("returns [] when fewer than 3 items follow the heading", () => {
    const body = `Vendors
- Only One
- Only Two`;
    expect(detectRosterNames(body)).toEqual([]);
  });

  it("returns [] on empty / null / roster-less body", () => {
    expect(detectRosterNames("")).toEqual([]);
    expect(detectRosterNames(null)).toEqual([]);
    expect(detectRosterNames("Thanks for your email, see you Saturday!")).toEqual([]);
  });

  it("skips prose lines that sneak into the run but keeps real names", () => {
    const body = `Confirmed Vendors:
- Real Vendor One
- This line is far too long to be a business name and should be dropped as prose text here
- Real Vendor Two
- Real Vendor Three`;
    expect(detectRosterNames(body)).toEqual([
      "Real Vendor One",
      "Real Vendor Two",
      "Real Vendor Three",
    ]);
  });
});
