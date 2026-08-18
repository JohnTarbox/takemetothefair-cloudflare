/**
 * OPE-378 — the extractor invented a word and put it in the event name.
 *
 * One unambiguous submission produced "28th Annual **Holiday** Craft Fair".
 * *Holiday* appears nowhere in the source. Every other word does. One added
 * token, entirely plausible for a November craft fair, and it changed what the
 * event is.
 *
 * The date equivalent (OPE-432) at least looks wrong when it is wrong. An
 * invented name reads perfectly — this one survived to a public record and was
 * caught only because submissions land PENDING.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groundNameInSources } from "../name-grounding";

/** The submission body, verbatim. */
const BODY =
  "Waterville Elks Lodge #905 is currently seeking crafters for their annual " +
  "craft fair on Sunday, November 1, 2026. Email secretary@waterville905.com " +
  "for application. This is our 28th Annual event that draws hundreds of " +
  "shoppers and the 65-table venue will fill up fast. Contact us today!";

describe("the specimen", () => {
  it("flags the invented word", () => {
    const r = groundNameInSources("28th Annual Holiday Craft Fair", [BODY]);
    expect(r.ungroundedTokens).toEqual(["holiday"]);
    expect(r.shouldFlag).toBe(true);
  });

  it("accepts the corrected name a human wrote", () => {
    // "Waterville Elks Lodge #905 28th Annual Craft Fair 2026" — every content
    // word is in the body, reordered and recombined. Reordering is not
    // fabrication, so this must pass or the check is unusable.
    const r = groundNameInSources("Waterville Elks Lodge #905 28th Annual Craft Fair 2026", [BODY]);
    expect(r.ungroundedTokens).toEqual([]);
    expect(r.shouldFlag).toBe(false);
  });

  it("names the offending token in the reason", () => {
    const r = groundNameInSources("28th Annual Holiday Craft Fair", [BODY]);
    expect(r.reason).toContain("holiday");
  });
});

describe("what must NOT be flagged", () => {
  it("the edition year we append by convention", () => {
    // We add the year deliberately; OPE-432 verifies dates separately.
    expect(groundNameInSources("Craft Fair 2027", [BODY]).shouldFlag).toBe(false);
  });

  it("ordinals", () => {
    expect(groundNameInSources("28th Craft Fair", [BODY]).shouldFlag).toBe(false);
  });

  it("stopwords and connectors", () => {
    expect(groundNameInSources("The Craft Fair of Waterville", [BODY]).shouldFlag).toBe(false);
  });

  it("plural/singular drift", () => {
    // "crafters" in the body grounds "craft"; drift is not invention.
    expect(groundNameInSources("Crafts Fair", [BODY]).shouldFlag).toBe(false);
  });

  it("a name drawn from an ATTACHMENT rather than the body", () => {
    // Passing every source matters — a name legitimately read off a flyer would
    // otherwise look fabricated.
    const r = groundNameInSources("Pumpkin Festival", [BODY, "OCR: Pumpkin Festival flyer"]);
    expect(r.shouldFlag).toBe(false);
  });

  it("case and punctuation differences", () => {
    expect(groundNameInSources("WATERVILLE ELKS LODGE #905!", [BODY]).shouldFlag).toBe(false);
  });
});

describe("failing safe", () => {
  it("does not flag when there is no source to check against", () => {
    // A fetch failure must not become an accusation — same rule as OPE-432.
    expect(groundNameInSources("Anything At All", []).shouldFlag).toBe(false);
    expect(groundNameInSources("Anything At All", ["", "   "]).shouldFlag).toBe(false);
  });

  it("passes through an empty name", () => {
    expect(groundNameInSources(null, [BODY]).shouldFlag).toBe(false);
    expect(groundNameInSources("", [BODY]).shouldFlag).toBe(false);
  });
});

describe("it still catches real fabrication", () => {
  it.each([
    ["Waterville Halloween Craft Fair", "halloween"],
    ["Waterville Christmas Market", "christmas"],
    ["28th Annual Seafood Festival", "seafood"],
  ])("%s → flags %s", (name, token) => {
    const r = groundNameInSources(name, [BODY]);
    expect(r.ungroundedTokens).toContain(token);
  });

  it("reports every ungrounded token, not just the first", () => {
    const r = groundNameInSources("Winter Holiday Craft Fair", [BODY]);
    expect(r.ungroundedTokens.sort()).toEqual(["holiday", "winter"]);
  });
});

/**
 * Wired, not merely written. A check that exists but never runs is this repo's
 * recurring defect class — and the reason this one is worth a source assertion
 * is that its effect (a flag on a PENDING row) is invisible in normal use.
 */
describe("wired into the submit route", () => {
  const ROUTE = readFileSync(
    resolve(__dirname, "..", "..", "..", "app/api/suggest-event/submit/route.ts"),
    "utf8"
  );

  it("calls the grounding check", () => {
    expect(ROUTE).toContain("groundNameInSources(effectiveName");
  });

  it("routes an ungrounded name to PENDING review", () => {
    expect(ROUTE).toContain('gateReasons.push("ungrounded_name")');
    expect(ROUTE).toContain('gateRoute = "PENDING_REVIEW"');
  });

  it("sets flaggedForReview so it reaches the queue a human reads", () => {
    // Gate flags alone are recorded but not surfaced; the flag is what puts it
    // in front of someone.
    expect(ROUTE).toContain('gateReasons.includes("ungrounded_name")');
    expect(ROUTE).toMatch(/flaggedForReview:/);
  });

  it("checks against the description, not just the submitted name", () => {
    // The submitted prose is where the evidence lives. Grounding a name only
    // against itself would pass everything.
    const call = ROUTE.slice(ROUTE.indexOf("groundNameInSources(effectiveName"));
    expect(call.slice(0, 200)).toContain("description");
  });
});
