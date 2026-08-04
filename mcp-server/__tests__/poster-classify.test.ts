/**
 * OPE-325 — poster-vs-photo classification.
 *
 * The asymmetry is the point and is tested as such: a missed poster costs a
 * "which fair?" reply the sender can answer, while a booth photo misread as a
 * poster would extract nonsense and stage a junk event. So the tests push
 * hardest on NOT over-calling POSTER.
 */
import { describe, it, expect } from "vitest";
import { classifyPosterText } from "../src/photo/poster-classify.js";

// Close to what OCR returns for the Maynard poster that started this.
const MAYNARD_POSTER = `
MAYNARD COUNTRY MUSICFEST 2026
Saturday, August 15, 2026 — 11:00 AM to 8:00 PM
Memorial Park, Maynard MA
Live music all day · Craft vendors · Food trucks
Vendor applications close July 1 — booth fee $75
Free admission. Rain or shine.
`;

describe("classifyPosterText (OPE-325)", () => {
  it("calls the Maynard poster a POSTER", () => {
    const r = classifyPosterText(MAYNARD_POSTER);
    expect(r.verdict).toBe("POSTER");
    expect(r.hasDate).toBe(true);
    expect(r.reason).toMatch(/chars with a date/);
  });

  it("calls a near-empty OCR a photo", () => {
    // What a booth shot actually yields: a banner word or two.
    expect(classifyPosterText("HILLTOP FARM").verdict).toBe("BOOTH_OR_SCENERY");
    expect(classifyPosterText("").verdict).toBe("BOOTH_OR_SCENERY");
    expect(classifyPosterText(null).verdict).toBe("BOOTH_OR_SCENERY");
  });

  it("will NOT call a dateless wall of text a poster", () => {
    // A busy vendor banner can OCR long. Without a date there is nothing to
    // dedup against, so staging it would create an unmatchable candidate.
    const banner = "ARTISAN SOAPS AND CANDLES ".repeat(8);
    const r = classifyPosterText(banner);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reason).toMatch(/no date/);
  });

  it("will NOT call a dated-but-sparse image a poster", () => {
    // A photo of a sign that happens to show "Aug 15" is not an announcement.
    // Asserting "not POSTER" rather than a specific non-poster verdict: BOOTH
    // and UNKNOWN both route to the same which-fair flow, so which one it lands
    // on is an implementation detail — only "doesn't get staged" is a contract.
    const r = classifyPosterText("Open Aug 15 — see you there!");
    expect(r.verdict).not.toBe("POSTER");
    expect(r.hasDate).toBe(true);
  });

  it("recognises the date formats posters actually use", () => {
    const base = "SUMMER CRAFT FAIR AT THE COMMON ".repeat(5);
    for (const d of ["August 15", "Aug 15th", "8/15/2026", "2026-08-15", "15 August"]) {
      expect(classifyPosterText(`${base} ${d}`).verdict, d).toBe("POSTER");
    }
  });

  it("always explains itself — the verdict has to be auditable", () => {
    // OPE-204's rule: no public writes from an unmeasured classifier. A reason
    // string is what makes precision computable at a retro.
    for (const t of [MAYNARD_POSTER, "HILLTOP FARM", "no date here at all ".repeat(10)]) {
      expect(classifyPosterText(t).reason.length).toBeGreaterThan(10);
    }
  });
});
