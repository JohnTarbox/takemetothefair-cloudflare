/**
 * OPE-537 fix 1 — a truncated CMS excerpt must not be stored as a description.
 *
 * Live case (event `ea4fcb63`, 2026-08-24): the stored description was
 * byte-identical to the page's og:description, `[…]` and all —
 *
 *   "…the Vermont Crafters Expo. This is not a traditional craft […]"
 *
 * — cut one word before "fair", i.e. one word before the sentence reverses
 * the event's premise. Quoted, accurate, and misleading.
 */
import { describe, it, expect } from "vitest";
import { isTruncatedExcerpt } from "../truncated-excerpt";

describe("isTruncatedExcerpt", () => {
  it("catches the exact string that shipped", () => {
    expect(
      isTruncatedExcerpt(
        "On November 7th & 8th, Vermont Gatherings is proud to introduce a " +
          "brand-new event at the Champlain Valley Exposition — the Vermont " +
          "Crafters Expo. This is not a traditional craft […]"
      )
    ).toBe(true);
  });

  it.each([
    ["bracketed unicode ellipsis", "Some prose […]"],
    ["bracketed three dots", "Some prose [...]"],
    ["bare unicode ellipsis", "Some prose…"],
    ["bare three dots", "Some prose..."],
    ["trailing whitespace after the marker", "Some prose […]   "],
    ["read more tail", "Some prose Read More"],
    ["continue reading tail", "Some prose Continue reading »"],
  ])("flags %s", (_label, value) => {
    expect(isTruncatedExcerpt(value)).toBe(true);
  });

  it.each([
    ["a complete sentence", "A two-day expo for makers, focused on tools and materials."],
    ["no terminal punctuation", "Vermont Crafters Expo at the Champlain Valley Exposition"],
    ["an interior ellipsis", "Doors open at 10… and close at 5, both days."],
    ["'more' not at the end", "Read more about parking on the venue website before you arrive."],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("does NOT flag %s", (_label, value) => {
    expect(isTruncatedExcerpt(value)).toBe(false);
  });

  it("ignores non-strings rather than throwing", () => {
    // Runs on raw model output, which is `unknown` — a crash here would fail
    // an import over a field that is merely absent.
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(isTruncatedExcerpt(v)).toBe(false);
    }
  });

  it("does not flag prose that merely CONTAINS a bracketed ellipsis mid-string", () => {
    // Elided quotations are legitimate and complete.
    expect(isTruncatedExcerpt("The mayor said […] and then opened the fair.")).toBe(false);
  });
});
