/**
 * OPE-537 — `FETCH_UA`'s version number is load-bearing, and it rots silently.
 *
 * It said `Chrome/120.0.0.0`, set 2026-06-12. Chrome 120 shipped December 2023,
 * so it was ~18 months stale on commit and ~2.7 years stale when a WAF
 * fake-browser rule started refusing it. Measured against
 * vermontartscouncil.org, three trials each: Chrome/120, /124 and /131 all
 * returned 403; Chrome/141 returned 200. Not the platform token — Mac/120 also
 * 403s and Windows/141 also 200s.
 *
 * The reason this deserves a test rather than a comment: a 403 here does NOT
 * surface as an error. The inbound workflow falls through to the body-prose
 * fallback, and for a URL-only email that meant an event fabricated from the
 * URL string, stored with a description contradicting the source page and
 * replied to as a success.
 *
 * This test cannot know today's real Chrome version, so it does not pretend to.
 * It asserts the shape and a floor — enough to catch the string being reverted
 * or edited into something implausible, and to put a named failure in front of
 * whoever bumps it next.
 */
import { describe, it, expect } from "vitest";
import { FETCH_UA } from "./browser-rendering";

/**
 * The lowest Chrome major we have EVIDENCE passes a live WAF (verified
 * 2026-08-24 against vermontartscouncil.org, ctcraftfairconnection.com and
 * castleberryfairs.com). Raise this when you re-verify against a newer one;
 * do not lower it without evidence that a lower version still gets through.
 */
const VERIFIED_MIN_CHROME_MAJOR = 138;

describe("FETCH_UA", () => {
  it("claims to be Chrome, not a self-identifying bot", () => {
    // A "compatible; MeetMeAtTheFair/1.0" UA is refused by these same sites.
    // That is a deliberate posture for SCRAPER_USER_AGENT elsewhere; this
    // constant is explicitly the browser-shaped one.
    expect(FETCH_UA).toMatch(
      /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/
    );
    expect(FETCH_UA).not.toMatch(/MeetMeAtTheFair|compatible;|bot|crawler/i);
  });

  it("names a Chrome major at or above the last version verified against a live WAF", () => {
    const major = Number(FETCH_UA.match(/Chrome\/(\d+)\./)?.[1]);
    expect(Number.isFinite(major)).toBe(true);
    expect(
      major,
      `FETCH_UA is Chrome/${major}. Anything below ${VERIFIED_MIN_CHROME_MAJOR} was measured 403ing ` +
        `real source domains on 2026-08-24, and a 403 here does not fail loudly — it falls through ` +
        `to the body-prose fallback and can fabricate an event from the URL. See OPE-537.`
    ).toBeGreaterThanOrEqual(VERIFIED_MIN_CHROME_MAJOR);
  });

  it("pins the exact versions measured as blocked, so a revert cannot pass", () => {
    for (const blocked of [120, 124, 131]) {
      expect(FETCH_UA).not.toContain(`Chrome/${blocked}.`);
    }
  });
});
