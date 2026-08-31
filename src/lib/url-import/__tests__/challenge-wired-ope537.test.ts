/**
 * OPE-537 item 3 — the challenge detector is actually CALLED.
 *
 * `detectChallengePage` shipped in `@takemetothefair/site-fetch` fully
 * implemented, exported from the package index, and with 91 passing tests —
 * and **nothing in the application called it**. A green suite over a detector
 * with no production caller is the exact shape of OPE-450, where
 * `findPriorAdjudication` sat inert for thirteen days behind thirteen green
 * tests. Two instances in one codebase is a pattern, not a coincidence.
 *
 * So this test does not re-test the detector. It asserts the WIRE: that the
 * fetch route reaches for it, on both the direct and the Browser Rendering
 * path, and that a challenge is reported to the submitter as a challenge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "api",
  "admin",
  "import-url",
  "fetch",
  "route.ts"
);

describe("OPE-537 — detectChallengePage is wired into the fetch route", () => {
  const src = readFileSync(ROUTE, "utf8");

  it("imports the shared detector rather than re-implementing one", () => {
    // A second detector would drift from the vendor marker list, and that
    // list is the part that has to stay current as vendors change markup.
    expect(src).toContain("detectChallengePage");
    expect(src).toMatch(/from "@takemetothefair\/site-fetch"/);
  });

  it("calls it on the DIRECT fetch result", () => {
    // Anchored on the call syntax, not a bare symbol: `indexOf("detectChallengePage")`
    // would match the import line and go vacuously green.
    expect(src).toMatch(/detectChallengePage\(\s*html\s*,/);
  });

  it("calls it again on the RENDERED result", () => {
    // Browser Rendering follows the challenge like any browser, so it can
    // return a second interstitial that merely has more text. Checking only
    // the direct path re-opens the hole one hop further along.
    expect(src).toMatch(/detectChallengePage\(\s*rendered\.html\s*,/);
  });

  it("a challenge short-circuits the success return", () => {
    // The verdict has to participate in the failure branch. Computing it and
    // not branching on it is the inert-detector failure inside one file.
    expect(src).toMatch(/challenge\.isChallenge/);
    expect(src).toMatch(/isEmptyExtraction\(content\)\s*\|\|\s*challenge\.isChallenge/);
  });

  it("tells the submitter it was a bot check, not that the page was empty", () => {
    // The URL loads perfectly in their own browser, so "no readable text"
    // reads as us being broken and invites them to re-send the same link.
    expect(src).toContain("CHALLENGE_USER_MESSAGE");
  });

  it("records which vendor's interstitial, for the log", () => {
    expect(src).toContain("challengeVendor");
  });
});
