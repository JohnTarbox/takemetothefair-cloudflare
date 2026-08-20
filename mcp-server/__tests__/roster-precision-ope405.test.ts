/**
 * OPE-405 rework — roster detection had 0% precision in production.
 *
 * It was filed as a silent no-op. It is the opposite: it fires confidently and
 * stages junk, and every detection sets `flagged_for_review=1`, so an operator
 * is sent to look at nothing. That is worse than silence, because it looks
 * like coverage.
 *
 * Measured 2026-08-20 — three detections in all of prod, zero real exhibitor
 * names between them. Each `describe` below is one of those payloads, copied
 * from `admin_actions(action='roster.detected')` rather than invented, so these
 * are regressions against reality and not against my idea of it.
 */
import { describe, it, expect } from "vitest";
import { detectRosterEntries } from "../src/email-handlers/roster-detect.js";

describe("false positives measured in prod — all must now detect nothing", () => {
  it("34b06089: a vision model DESCRIBING a booth map is not a roster", () => {
    // OCR of a 1.97 MB PNG booth map. `artisans?` in ROSTER_KEYWORD matches the
    // "Artisan Stalls:" heading, so the heading gate passed and the structural
    // bullets became "exhibitors".
    const ocr = `The image shows the layout for the fair.

**Artisan Stalls:**
- **Peripheral Rows:**
- **Top-right:** Stalls 21, 22, 35, 36, and 31.
- **Far-right edge:** Stalls 32, 33, and 34.
- **Inner/Central Area:**
- **Adjacent to the Stone Wall:** Stalls 03, 62, and 28.
- **Miscellaneous:**`;

    expect(detectRosterEntries(ocr)).toEqual([]);
  });

  it("4c536723: a blank application FORM is not a roster", () => {
    const ocr = `Craft Fair Vendor Application

The form requests the following:
- Name
- Phone Number
- Mailing Address
- Email Address
- Business Name
- **Product Description:** (A field labeled "What will you be selling?")`;

    expect(detectRosterEntries(ocr)).toEqual([]);
  });

  it("ac46add3: a lone section heading is not a roster", () => {
    const ocr = `**Artisan Stalls:**
- **Artisan Stalls:**
- **Peripheral Rows:**
- **Miscellaneous:**`;

    expect(detectRosterEntries(ocr)).toEqual([]);
  });
});

describe("true positives still detected — the gate must not cost recall", () => {
  it("the Winthrop numbered placement table (the ticket's own specimen)", () => {
    const ocr = `| # | Name | Type of Work |
| 3 | Clair Hersom | Authors |
| 8 | Paul Menice | Photos |
| 21 | Carolyn Smith | Ptg |
| 22 | Anne Cough | crochet |`;

    const out = detectRosterEntries(ocr);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ position: 3, name: "Clair Hersom", detail: "Authors" });
    expect(out.map((e) => e.name)).toContain("Carolyn Smith");
  });

  it("the Art in the Park bulleted body roster (the OPE-176 shape)", () => {
    const body = `*Art in the Park Vendors 2026*
   - *Sea Glass Studio*
   - *Kennebec Pottery*
   - *Downeast Woodworks*
   - *Casco Bay Candles*`;

    const out = detectRosterEntries(body);
    expect(out.map((e) => e.name)).toEqual([
      "Sea Glass Studio",
      "Kennebec Pottery",
      "Downeast Woodworks",
      "Casco Bay Candles",
    ]);
  });

  it("a business name ending in a period is NOT rejected as a sentence", () => {
    // The `.` rule is word-count gated precisely so this survives.
    const body = `Vendors:
   - Smith & Sons Inc.
   - Blue Hill Farm Co.
   - Acadia Trading Ltd.`;

    const out = detectRosterEntries(body);
    expect(out.map((e) => e.name)).toEqual([
      "Smith & Sons Inc.",
      "Blue Hill Farm Co.",
      "Acadia Trading Ltd.",
    ]);
  });

  it("a real name is kept even when the list also contains headings", () => {
    // Mixed shape: the junk drops out, and what remains must still clear
    // MIN_ROSTER on its own rather than riding on the rejected entries.
    const body = `Exhibitors:
   - Sea Glass Studio
   - **Peripheral Rows:**
   - Kennebec Pottery
   - Miscellaneous:
   - Downeast Woodworks`;

    const out = detectRosterEntries(body);
    expect(out.map((e) => e.name)).toEqual([
      "Sea Glass Studio",
      "Kennebec Pottery",
      "Downeast Woodworks",
    ]);
  });

  it("drops below MIN_ROSTER once junk is removed → no roster at all", () => {
    const body = `Exhibitors:
   - Sea Glass Studio
   - **Peripheral Rows:**
   - Miscellaneous:
   - Top-right:** Stalls 21, 22, 35, 36, and 31.`;

    // One real name is not a roster.
    expect(detectRosterEntries(body)).toEqual([]);
  });
});
