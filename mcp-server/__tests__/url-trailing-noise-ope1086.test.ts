/**
 * OPE-1086 — a bolded link in a forwarded newsletter cost us a 60-vendor craft
 * fair on the day it ran.
 *
 * Gmail renders Mailchimp's bold as `*…*` in the text/plain alternative, and
 * the tokenizer (`[^\s<>"']+`) kept the closing asterisk, so
 * `…/stephen-kings-79th-birthday-carnival/*` was stored and fetched, failed,
 * and the sender got `unfetchable-url`. The same URL without it returns 200.
 *
 * The normalization lives in `cleanUrl`, which BOTH extractors call — the same
 * place OPE-459's host guard landed, so there is no fourth code path.
 */
import { describe, expect, it } from "vitest";
import { extractAllUrls, pickPrimaryUrl, stripUrlTrailingNoise } from "../src/email-handler.js";

const CARNIVAL = "https://downtownbangor.com/events/stephen-kings-79th-birthday-carnival/";
/** The specimen's two lines, verbatim from inbound dde7e809. */
const SPECIMEN = `*Full list of activities and details visit: *\n*${CARNIVAL}*\n`;

describe("OPE-1086 — the specimen", () => {
  it("the bolded newsletter link stores clean, with no asterisk", () => {
    expect(pickPrimaryUrl(SPECIMEN, "")).toBe(CARNIVAL);
    expect(extractAllUrls(SPECIMEN, "")).toEqual([CARNIVAL]);
  });

  it("the paired case: the LEADING marker is outside the token, so both sides come off", () => {
    // Scope 2 asked for this to be confirmed by test rather than by reading.
    const out = pickPrimaryUrl("*https://example.com/path/*", "");
    expect(out).toBe("https://example.com/path/");
    expect(out).not.toContain("*");
  });
});

describe("OPE-1086 — what is stripped, and what is not", () => {
  it.each([
    ["trailing asterisk (Gmail bold)", "https://example.com/a/*", "https://example.com/a/"],
    ["trailing underscore (Gmail italic)", "https://example.com/a_", "https://example.com/a"],
    ["sentence period", "https://example.com/a.", "https://example.com/a"],
    ["comma", "https://example.com/a,", "https://example.com/a"],
    ["semicolon/colon", "https://example.com/a;", "https://example.com/a"],
    ["bang and question", "https://example.com/a!?", "https://example.com/a"],
    ["quote and angle", 'https://example.com/a">', "https://example.com/a"],
    ["two of them (bold then full stop)", "https://example.com/a/*.", "https://example.com/a/"],
    ["unbalanced closer", "https://example.com/a)", "https://example.com/a"],
  ])("strips %s", (_label, raw, expected) => {
    expect(stripUrlTrailingNoise(raw)).toBe(expected);
  });

  it.each([
    ["a balanced parenthesis in the path", "https://en.wikipedia.org/wiki/Fair_(disambiguation)"],
    ["balanced brackets", "https://example.com/a[b]"],
    ["an ordinary path", "https://example.com/events/fall-fair/"],
    ["a query string", "https://example.com/e?tag=fair"],
  ])("leaves %s alone", (_label, raw) => {
    expect(stripUrlTrailingNoise(raw)).toBe(raw);
  });

  it("ACCEPTANCE: a path that legitimately ends in a parenthesis survives extraction", () => {
    // The mutant the ticket names — stripping the closer unconditionally, which
    // is what the code did before — turns this red.
    const wiki = "https://en.wikipedia.org/wiki/Fair_(disambiguation)";
    expect(pickPrimaryUrl(`see ${wiki} for more`, "")).toBe(wiki);
    // Positive landmark beside it: the unbalanced case IS still stripped.
    expect(pickPrimaryUrl("(see https://example.com/a)", "")).toBe("https://example.com/a");
  });

  it("does not run away on a token that is all punctuation", () => {
    expect(stripUrlTrailingNoise("*****")).toBe("");
    expect(pickPrimaryUrl("https://*", "")).toBeNull();
  });

  it("OPE-459's host guard still holds (the truncated-host case)", () => {
    expect(pickPrimaryUrl("https://go/ is not a host", "")).toBeNull();
  });
});
