/**
 * OPE-537 — a bare-URL submission fabricated an entire event.
 *
 * inbound `712add39` carried one thing in its body:
 *
 *     https://www.vermontartscouncil.org/event/vermont-crafters-expo/2026-11-07/
 *
 * The fetch 403'd (stale `FETCH_UA`), so the workflow fell through to OPE-185's
 * body-prose fallback — which measured RAW LENGTH — and handed that URL to the
 * extractor as prose. Out came event `5f917800`: name from the slug, date from
 * the `/2026-11-07/` path segment, and a fluent description stating the
 * OPPOSITE of the page ("handmade goods" for an expo that is explicitly about
 * tools and materials, not finished goods). Stored PENDING, replied to as a
 * success, zero citations, null `source_url`.
 *
 * The two gates disagreed about the same string. OPE-457 had already removed
 * exactly this bar one gate over — and converted only one of the two call
 * sites. These tests pin that they now share one definition.
 */
import { describe, it, expect } from "vitest";
import { bodyHasProseSubstance } from "../src/email-handlers/body-prose-substance.js";
import { stripSignature, stripForwardedPreamble } from "../src/email-handlers/submit.js";

/** Exactly what arrived, including the trailing newlines. */
const VT_BODY = "https://www.vermontartscouncil.org/event/vermont-crafters-expo/2026-11-07/\n\n";

/** The fanout gate, `inbound-email.ts:1193`. */
const fanoutGate = (body: string) => bodyHasProseSubstance(stripSignature(body));

/** The OPE-185 fallback gate, `inbound-email.ts:~1620` — post-fix. */
const fallbackGate = (body: string) =>
  bodyHasProseSubstance(stripSignature(stripForwardedPreamble(body)));

/** What the fallback gate used to be. Kept to show what changed. */
const oldFallbackGate = (body: string) =>
  stripSignature(stripForwardedPreamble(body)).trim().length > 40;

describe("the specimen", () => {
  it("is refused by BOTH gates now — it was refused by only one", () => {
    expect(fanoutGate(VT_BODY)).toBe(false);
    expect(fallbackGate(VT_BODY)).toBe(false);
  });

  it("reproduces the disagreement that caused the fabrication", () => {
    // The old bar let it through at 74 chars. This is the defect, pinned.
    expect(oldFallbackGate(VT_BODY)).toBe(true);
    expect(fanoutGate(VT_BODY)).toBe(false);
  });
});

describe("the two gates agree on every shape that matters", () => {
  const cases: Array<[string, string, boolean]> = [
    ["bare URL (the specimen)", VT_BODY, false],
    ["bare URL, no trailing newlines", VT_BODY.trim(), false],
    ["a long URL and nothing else", `https://example.org/${"a".repeat(300)}`, false],
    ["two URLs, no prose", "https://a.example.org/x\nhttps://b.example.org/y", false],
    [
      "URL plus a real sentence",
      `${VT_BODY}\nThe Vermont Crafters Expo runs November 7 and 8 at the Champlain Valley Expo in Essex, 10am to 5pm both days.`,
      true,
    ],
    [
      "prose with no URL at all",
      "Our craft fair is on September 12 from 10am to 3pm at the community school in Vassalboro.",
      true,
    ],
    ["empty body", "", false],
    ["whitespace only", "   \n\n\t  ", false],
  ];

  for (const [name, body, expected] of cases) {
    it(`${name} → ${expected ? "prose" : "no prose"}, and both gates say so`, () => {
      expect(fanoutGate(body)).toBe(expected);
      expect(fallbackGate(body)).toBe(expected);
      // The invariant that actually matters: they can never diverge, because
      // divergence is what produced a fabricated public-facing description.
      expect(fanoutGate(body)).toBe(fallbackGate(body));
    });
  }
});

describe("what the fix costs", () => {
  it("still admits a genuine un-fetchable-URL submission — OPE-185's real case", () => {
    // The reason that fallback exists: share.google/short links 429 server-side
    // fetchers, and the body carries the actual event details. That must still
    // draft an event. Removing the fallback entirely would have broken this.
    const shareLinkWithProse =
      "https://share.google/aBcD\n\nHi — we're running the Kingfield Craft Fair on " +
      "October 4th, 9am to 4pm, at the Kingfield Elementary School gym. Booths are $40.";
    expect(fallbackGate(shareLinkWithProse)).toBe(true);
  });
});

/**
 * The tests above exercise the shared helper. That is necessary and NOT
 * sufficient: reverting the workflow's call site to a raw-length bar left every
 * one of them green, which is precisely how the original defect survived
 * OPE-457 — the definition was fixed and one call site was not.
 *
 * So these assert the call site itself. Source-level, because the branch needs
 * a live fetch failure to reach and a mocked test would pin the mock.
 *
 * Anchored on call SYNTAX, never a bare symbol: `indexOf("bodyHasProseSubstance")`
 * would match the import line and pass vacuously.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = readFileSync(
  resolve(__dirname, "..", "src", "workflows", "inbound-email.ts"),
  "utf8"
);

describe("the workflow's own gates (source-level)", () => {
  it("has NO raw-length prose bar in CODE", () => {
    // The exact shape that shipped the fabrication: a character count standing
    // in for "is there prose here". A bare URL clears any such bar — the
    // OPE-537 body was 74 chars after stripping.
    //
    // Comments are stripped first, because the fix's own comment quotes the
    // old expression and would otherwise fail its own test. `subject.trim()
    // .length > 0` is deliberately allowed: an emptiness check is not a prose
    // bar, and this test should not push anyone into deleting a good one.
    const code = WORKFLOW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const proseBars = code.match(/\.trim\(\)\.length\s*>\s*(?!0\b)\d+/g) ?? [];
    expect(
      proseBars,
      `Found a raw-length prose gate: ${proseBars.join(", ")}. Three of these ` +
        `existed and all three fed submitFreeTextExtract. Use bodyHasProseSubstance().`
    ).toEqual([]);
  });

  it("gates the B2 free-text branch on prose too — the third instance", () => {
    expect(WORKFLOW).toContain("const hasBodyText = bodyHasProseSubstance(");
  });

  it("gates the OPE-185 fetch-failure fallback on bodyHasProseSubstance", () => {
    expect(WORKFLOW).toContain(
      "if (bodyHasProseSubstance(stripSignature(stripForwardedPreamble(rawBody)))) {"
    );
  });

  it("records the multi-source-fanout decline instead of leaving it silent", () => {
    // OPE-537 deliverable 2: an absent step row could mean "declined" or
    // "crashed", and the output row cannot tell them apart.
    expect(WORKFLOW).toContain('stepName: "multi-source-fanout",\n        status: "skipped",');
    // The decline must say WHICH condition declined, not merely that one did.
    for (const field of [
      "free_text_intent:",
      "body_has_prose_substance:",
      "body_url_count:",
      "body_chars:",
    ]) {
      expect(WORKFLOW).toContain(field);
    }
  });
});
