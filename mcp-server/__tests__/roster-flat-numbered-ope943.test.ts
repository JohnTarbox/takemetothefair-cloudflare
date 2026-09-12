/**
 * OPE-943 — roster capture staged a PDF's METADATA block as 11 "exhibitors".
 *
 * Specimen: inbound `9fc287ef-be03-4f90-8cc8-1e1e9e8e76b4`, 2026-09-10 17:29Z,
 * "Fwd: New Gloucester Community Fair - Information". Attachment
 * `0-Vendorlist.pdf` is the organizer's 78-space booth assignment sheet.
 *
 * `admin_actions` `roster.detected` staged 11 entries, EVERY ONE a PDF metadata
 * key (`PDFFormatVersion=1.7`, `Author=Jennifer Bragdon`, …) — 0 of 11 real,
 * and 0 of the ~70 real exhibitors captured.
 *
 * NEW_GLOUCESTER_OCR below is the stored OCR markdown, read back verbatim from
 * `inbound_emails.attachment_ocr` via `get_inbound_email` on 2026-09-11. It is
 * not a reconstruction — the point of this fixture is that it is the exact text
 * the detector saw in production.
 */
import { describe, expect, it } from "vitest";
import {
  detectRosterEntries,
  detectRosterFlatNumbered,
  stripToMarkdownMetadata,
} from "../src/email-handlers/roster-detect.js";

const NEW_GLOUCESTER_OCR = `# Vendorlist.pdf
## Metadata
- PDFFormatVersion=1.7
- IsLinearized=false
- IsAcroFormPresent=false
- IsXFAPresent=false
- IsCollectionPresent=false
- IsSignaturesPresent=false
- Author=Jennifer Bragdon
- CreationDate=D:20260909192731-04'00'
- ModDate=D:20260909192731-04'00'
- Producer=Microsoft: Print To PDF
- Title=masterNGF26.xlsx



## Contents
### Page 1
# Last Name Activity - Org Name1 Goss Maine Community Robotics2 Danforth The Salty Bee Maine3 Gray Animal GNG Animal Hospital4 Smith maine card works5 Cronin CCCU6 Dame Crafty Chicks7 Spann SpannStudios8 Nelson First Congregational Church9 Mcgrath 4-H10 Lord Squirrely Works 20711 Lord Squirrely Works 20712 Forbes Joelsa Farm Fiber13 Emery Tarot Card Reading14 Allen Sabbathday Lake15 Diffin Crochet Plushies by Amanda16 Corcoran By-B crafts17 Norton Eric Norton18 Bryant D&K Flavors of Home19 Mathieu Create Epoxy20 Bangle Seaside Forever Jewelry21 Marsters Healthy Scents22 Madison SEWN by Lisa23 Pfeifle rep24 Jordan ERC25 Fralich BLING26 Bozuwa New Gloucester Dems27 Carpenter Granite Bay Care



### Page 2
28 Foster Home Team Realty29 Stevens Notta Lotta farm30 Mackeil Simply TM Creations31 Early Lincolns 3D Print Shop32 Morel Belinda Bakes33 Chasse Sandy's Diamond Art34 Linda Chase Historical knowledge35 Knowles Wolf Mountain Creations36 Paulin Candlewood37 Martin P & K Cardinal Crafts38 Martin P & K Cardinal Crafts39 OPEN40 Blaisdell Shimmer Crafts41 Campbell Brown Welded & Worn42 Mangin aMAIzing Soaps & Sundries43 Johnson High Tide Crafter44 Carr Royal River Conservation Trust45 Curtis Curtisy Crafts46 Richardson Lucky Pup Rescue47 Richardson Mo Treats48 Easter Easters Crafts49 Tufts Know Your Natural Roots50 Rodriguez GNG Rec51 Gwinn NG Bible Church52 OPEN53 Martin New Gloucester Public Library



### Page 3
54 Rodney Ruth-Annes Macrame55 Allen Trish Allen56 Cobb Cobb3DPrinting57 Caron Caron Crafts58 Michaud Konie's Krylics59 Real Altered Reality Designs60 Robbins Granite Ridge Dahlia Co.61 Harris62 Tsukroff Tsukroff Photography63 OPEN64 Colby NG Republicans65 Winslow House of Rep66 Davis GoNetSpeed67 Bowman Manes68 Demeritt Quilters 369 Bilodeau Kikis Happy Place70 Torok Charlies Crochet Collection71 Richard Scentsy72 Fischer Casco Bay Trail Alliance73 Dubois Hats by Lise74 Pacanza Marc's Woodworking75 Brooks All Things Crafty76 Melita Denim River Crafts77 Wills Utopian Utensils78 Arata Commuinity Connections
Pelletier 9-1-1

`;

describe("OPE-943 — the defect, on the exact production input", () => {
  const entries = detectRosterEntries(NEW_GLOUCESTER_OCR);

  it("stages ZERO PDF metadata keys (all 11 of the staged junk entries)", () => {
    // The precise 11 that reached admin_actions in prod. Named individually so
    // this cannot pass by the detector returning nothing at all — the positive
    // landmark is the next test, which requires a real roster from the SAME call.
    const staged = [
      "PDFFormatVersion=1.7",
      "IsLinearized=false",
      "IsAcroFormPresent=false",
      "IsXFAPresent=false",
      "IsCollectionPresent=false",
      "IsSignaturesPresent=false",
      "Author=Jennifer Bragdon",
      "CreationDate=D:20260909192731-04'00'",
      "ModDate=D:20260909192731-04'00'",
      "Producer=Microsoft: Print To PDF",
      "Title=masterNGF26.xlsx",
    ];
    expect(staged).toHaveLength(11);
    const names = entries.map((e) => e.name);
    for (const junk of staged) expect(names).not.toContain(junk);
    // And nothing else metadata-shaped either.
    expect(names.filter((n) => /=/.test(n))).toEqual([]);
  });

  it("captures the real roster instead — ≥60 candidates (acceptance criterion)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
  });

  it("reads the booth number as the position, so it reconciles with the map", () => {
    expect(entries[0]).toEqual({
      position: 1,
      name: "Goss Maine Community Robotics",
      detail: null,
    });
    // Space 4 is "Smith maine card works" — a real business the old path lost.
    expect(entries.find((e) => e.position === 4)?.name).toBe("Smith maine card works");
  });

  it("splits a value that ENDS in digits from the next row number (`Works 20711`)", () => {
    // The case that breaks the obvious "a row number is not preceded by a
    // digit" rule. Space 10 is "Lord Squirrely Works 207"; the text reads
    // `…Works 20711 Lord…` and must split 207 | 11.
    const ten = entries.find((e) => e.position === 10);
    expect(ten?.name).toBe("Lord Squirrely Works 207");
    // Spaces 10 and 11 are the same vendor on two spaces, so 11 dedupes away
    // and 12 is the next surviving row.
    expect(entries.find((e) => e.position === 11)).toBeUndefined();
    expect(entries.find((e) => e.position === 12)?.name).toBe("Forbes Joelsa Farm Fiber");
  });

  it("splits on the other digit-adjacent rows too (`4-H10`, `Dahlia Co.61`)", () => {
    expect(entries.find((e) => e.position === 9)?.name).toBe("Mcgrath 4-H");
    // Space 61 proves the `Dahlia Co.61` boundary was split correctly even
    // though space 60 itself is then dropped by a pre-existing gate — see the
    // known-gap test below.
    expect(entries.find((e) => e.position === 61)?.name).toBe("Harris");
  });

  it("KNOWN GAP: space 60 is lost to OPE-405's sentence rule, not to this parser", () => {
    // "Robbins Granite Ridge Dahlia Co." is 5 words and ends in a period, so
    // isPlausibleName (roster-detect.ts:196, OPE-405) rejects it as a sentence.
    // The boundary itself parses fine — space 61 above proves the split landed.
    //
    // The flat form makes this gate bite systematically harder than the other
    // two forms do: its cell is `<surname> <org name>`, one word longer than a
    // bare business name, so a 4-word company ending in "Co."/"Inc." crosses
    // the >4 threshold that was tuned against bare names.
    //
    // Measured on this specimen: exactly ONE row of 78. Left alone deliberately
    // — widening an OPE-405 precision gate is that ticket's call, not this
    // one's, and the gate is what keeps "Stalls 32, 33, and 34." out.
    // Tracked as an OPE-943 follow-up. If that lands, this test should flip.
    expect(entries.find((e) => e.position === 60)).toBeUndefined();
  });

  it("loses exactly the rows it should: 2 duplicates, 3 OPEN, 1 known gap", () => {
    // The positive landmark for every "not captured" assertion above: this
    // pins the FULL set, so a parser that silently started dropping rows would
    // turn this red instead of quietly shrinking the roster.
    const got = new Set(entries.map((e) => e.position));
    const missing = Array.from({ length: 78 }, (_, i) => i + 1).filter((p) => !got.has(p));
    expect(missing).toEqual([
      11, // same vendor as space 10 (Squirrely Works 207)
      38, // same vendor as space 37 (P & K Cardinal Crafts)
      39, // OPEN
      52, // OPEN
      60, // known gap — OPE-405 sentence rule, see above
      63, // OPEN
    ]);
    expect(entries).toHaveLength(72);
  });

  it("drops the three unassigned OPEN spaces (39, 52, 63)", () => {
    expect(entries.map((e) => e.name)).not.toContain("OPEN");
    for (const p of [39, 52, 63]) {
      expect(entries.find((e) => e.position === p)).toBeUndefined();
    }
  });

  it("dedupes a vendor holding two spaces, keeping the first (37/38)", () => {
    const cardinal = entries.filter((e) => e.name === "Martin P & K Cardinal Crafts");
    expect(cardinal).toHaveLength(1);
    expect(cardinal[0].position).toBe(37);
  });

  it("crosses the page breaks — the last space (78) is captured", () => {
    expect(entries.find((e) => e.position === 78)?.name).toBe("Arata Commuinity Connections");
    // …and the trailing UNNUMBERED row is not glued onto it.
    expect(entries.find((e) => e.position === 78)?.name).not.toMatch(/Pelletier/);
  });

  it("never takes a `### Page N` heading's number as a row", () => {
    expect(entries.map((e) => e.name)).not.toContain("Page 2");
    expect(entries.every((e) => e.position !== null && e.position >= 1)).toBe(true);
  });
});

describe("OPE-943 — each guard's OWN effect, asserted in isolation", () => {
  // v3.8: a guard that cannot fail is not a control. Each of the three changes
  // is pinned here on its own, so removing any ONE of them turns a test red
  // rather than being masked by the other two.

  it("stripToMarkdownMetadata removes the block and KEEPS the contents", () => {
    const out = stripToMarkdownMetadata(NEW_GLOUCESTER_OCR);
    expect(out).not.toMatch(/PDFFormatVersion/);
    expect(out).not.toMatch(/Author=Jennifer Bragdon/);
    // Positive landmark: it must not have eaten the document.
    expect(out).toMatch(/## Contents/);
    expect(out).toMatch(/Goss Maine Community Robotics/);
    // `### Page 1` is h3 and must NOT terminate the metadata block early.
    expect(out).toMatch(/### Page 1/);
  });

  it("stripToMarkdownMetadata is a no-op on text that has no such block", () => {
    const plain = "Vendors:\n- Alpha Co\n- Beta Co\n- Gamma Co";
    expect(stripToMarkdownMetadata(plain)).toBe(plain);
  });

  it("the Key=Value gate rejects a metadata key even when it reaches a bullet run", () => {
    // Metadata block deliberately NOT present — this exercises the
    // isPlausibleName gate alone, not the strip.
    const body = `Vendor manifest
- PDFFormatVersion=1.7
- IsLinearized=false
- Author=Jennifer Bragdon
- Producer=Microsoft: Print To PDF`;
    expect(detectRosterEntries(body)).toEqual([]);
  });

  it("the Key=Value gate does NOT reject a business name containing '='", () => {
    const body = `Vendors:
- A = B Designs
- Kennebec Pottery
- Casco Bay Candles`;
    // Anchored regex needs `Key=` with no space, so "A = B Designs" survives.
    expect(detectRosterEntries(body).map((e) => e.name)).toContain("A = B Designs");
  });

  it("the STRONGEST form wins — a short bullet run no longer masks a long list", () => {
    // This is the class fix, independent of the metadata strip. Under the old
    // first-non-empty-wins rule this returned the 3 bullets and never tried the
    // numbered list below them.
    const mixed = `Vendor notes
- Alpha Co
- Beta Co
- Gamma Co

Booth assignments: 1 Goss Maine Community Robotics2 Danforth The Salty Bee Maine3 Gray Animal GNG Animal Hospital4 Smith maine card works5 Cronin CCCU6 Dame Crafty Chicks7 Spann SpannStudios8 Nelson First Congregational Church9 Mcgrath 4-H10 Lord Squirrely Works 207`;
    const out = detectRosterEntries(mixed);
    expect(out.length).toBeGreaterThan(3);
    expect(out.map((e) => e.name)).toContain("Smith maine card works");
    expect(out.map((e) => e.name)).not.toContain("Alpha Co");
  });
});

describe("OPE-943 — the flat form fails closed", () => {
  it("does not fire on prose that happens to number a few points", () => {
    const prose = `Vendor application steps
We ask that you do the following. 1 Read the rules carefully before you begin.
2 Complete every field on the form. 3 Return it to the address shown above.`;
    expect(detectRosterFlatNumbered(prose)).toEqual([]);
  });

  it("requires a consecutive run of at least MIN_FLAT_ROSTER, not just 3", () => {
    // Seven rows: a real shape, but below the floor the flat form needs
    // because it has no delimiter of its own.
    const seven = `Vendors 1 Alpha Co2 Beta Co3 Gamma Co4 Delta Co5 Epsilon Co6 Zeta Co7 Eta Co`;
    expect(detectRosterFlatNumbered(seven)).toEqual([]);
    // Positive landmark: one more row and the identical shape DOES qualify, so
    // the emptiness above is the floor talking and not a broken matcher.
    const eight = `${seven}8 Theta Co`;
    expect(detectRosterFlatNumbered(eight).length).toBe(8);
  });

  it("requires a roster keyword somewhere in the text", () => {
    const noKeyword = `Inventory 1 Alpha Co2 Beta Co3 Gamma Co4 Delta Co5 Epsilon Co6 Zeta Co7 Eta Co8 Theta Co`;
    expect(detectRosterFlatNumbered(noKeyword)).toEqual([]);
  });

  it("stops rather than reaching across the document for a stray digit", () => {
    // Row 5 is missing; the gap is far wider than MAX_FLAT_CELL, so the walk
    // must end at 4 (and therefore fall below the floor) instead of gluing the
    // distant "5" on.
    const gap = `Vendors 1 Alpha Co2 Beta Co3 Gamma Co4 Delta Co${" filler".repeat(40)} 5 Epsilon Co6 Zeta Co7 Eta Co8 Theta Co`;
    expect(detectRosterFlatNumbered(gap)).toEqual([]);
  });
});
