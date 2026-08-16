import { describe, it, expect } from "vitest";
import {
  detectRosterNames,
  detectRosterTable,
  detectRosterEntries,
} from "../src/email-handlers/roster-detect.js";

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

// ── OPE-405: rosters that arrive as an OCR'd PDF table ──────────────────────
//
// The chamber's 34-spot Winthrop artist list sat unread for 12 days while the
// event showed 0 vendors. Roster capture read `body_text` only, and this roster
// was a PDF — whose OCR'd text was already being computed for event extraction
// and thrown away for this purpose.
//
// Fixture is the real `env.AI.toMarkdown` output for
// `2026-Winthrop-Art-Festival-Names-Final.pdf` (inbound f5858233), trimmed.
// Note the prose preamble and the empty/short rows: both must be survived.
const WINTHROP_PDF_MARKDOWN = `# names.pdf
## Metadata
- Title=2026 Winthrop Art Festival Names-Final

## Contents
### Page 1

2026 Winthrop Arts Festival

Hello and thank you for participating in the 40th Annual Winthrop Arts Festival this year!
Set up begins at 6:30am. Exhibit spaces are approximately 10' by 12'.

| Name | Type of Work |
| - | - |
| 1 |
| 2 |
| 3 | Clair Hersom | Authors |
| 4 | Alyssa Brugger | Robert's |
| 6 | Mark Hoplins | Wood |
| 8 | Paul Menice | Photos |
| 12 | Karen Cebenka | crochet |
| 14 | Historical Society |
| 21 | Carolyn Smith | Ptg |
| 34 | Paul Boucher | Paintings |
|  |
`;

describe("detectRosterTable (OPE-405)", () => {
  it("pulls structured entries out of an OCR'd placement PDF", () => {
    const entries = detectRosterTable(WINTHROP_PDF_MARKDOWN);
    expect(entries.length).toBe(8);
    expect(entries[0]).toEqual({ position: 3, name: "Clair Hersom", detail: "Authors" });
    // Verified against the real 147KB PDF: the full document yields 30 entries.
    expect(entries.find((e) => e.position === 8)?.name).toBe("Paul Menice");
  });

  it("keeps the booth number and the craft, not just the name", () => {
    // Both are what make a personal-name roster reconcilable later: the number
    // against the map PDF, the craft against a business. Winthrop spot 21 read
    // "Carolyn Smith / Ptg" and was really Maine Cardworks Inc.
    const e = detectRosterTable(WINTHROP_PDF_MARKDOWN).find((x) => x.position === 21);
    expect(e).toEqual({ position: 21, name: "Carolyn Smith", detail: "Ptg" });
  });

  it("tolerates a row with no craft column", () => {
    const e = detectRosterTable(WINTHROP_PDF_MARKDOWN).find((x) => x.position === 14);
    expect(e).toEqual({ position: 14, name: "Historical Society", detail: null });
  });

  it("ignores empty rows, separator rows, and the header", () => {
    const names = detectRosterTable(WINTHROP_PDF_MARKDOWN).map((e) => e.name);
    expect(names).not.toContain("Name");
    expect(names).not.toContain("-");
    expect(names.every((n) => n.trim().length > 0)).toBe(true);
  });

  it("does not fire on a table that is not a roster", () => {
    // MIN_ROSTER still gates it, so an incidental two-row table cannot qualify.
    const md = `| 1 | Alpha | x |\n| 2 | Beta | y |`;
    expect(detectRosterTable(md)).toEqual([]);
  });

  it("ignores a markdown table whose first column is not a number", () => {
    const md = `| Item | Price |\n| - | - |\n| Coffee | 2.00 |\n| Donut | 1.50 |\n| Water | 1.00 |`;
    expect(detectRosterTable(md)).toEqual([]);
  });
});

describe("detectRosterEntries (OPE-405)", () => {
  it("prefers the bullet form when the body carries one", () => {
    const entries = detectRosterEntries(ART_IN_THE_PARK);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0].position).toBeNull();
  });

  it("falls through to the table form for OCR'd PDF text", () => {
    const entries = detectRosterEntries(WINTHROP_PDF_MARKDOWN);
    expect(entries.length).toBe(8);
    expect(entries[0].position).toBe(3);
  });

  it("returns [] for null/empty rather than throwing", () => {
    expect(detectRosterEntries(null)).toEqual([]);
    expect(detectRosterEntries("")).toEqual([]);
  });
});
