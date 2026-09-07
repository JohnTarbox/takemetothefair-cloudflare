/**
 * OPE-830 — the vendor form tells you saves won't land, and shows the result
 * where you can see it.
 *
 * Two defects, both measured on the live page before this change:
 *
 *   1. The form gave no indication that an unverified email makes every save
 *      403. A vendor spent 3½ minutes filling it in while every PATCH was
 *      refused, then wrote to say only his photo had saved — accurate, because
 *      photo upload takes `auth()` and this form takes a verified email.
 *
 *   2. The result banner rendered at line 338, the Save button at line 614 —
 *      276 lines apart, with no scroll-to and no toast. Tapping Save on a
 *      phone produced no visible feedback at all.
 *
 * ⚠️ The site-wide banner is NOT a substitute and its existence is why this
 * needed care: `components/layout/unverified-banner` already rendered for
 * these users. It says "Please verify your email" — a nag, with no mention of
 * the consequence — and it lives in the root layout, scrolled out of sight.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(
  join(process.cwd(), "src", "app", "vendor", "profile", "page.tsx"),
  "utf8"
);
const ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "vendor", "profile", "route.ts"),
  "utf8"
);

/**
 * The page with comments stripped.
 *
 * ⚠️ Negative assertions MUST run against this, not the raw file. The first
 * version of the `includes("success")` check below failed against the very
 * comments explaining why that pattern was removed — a guard grepping its own
 * documentation, which is the third instance of that shape in this repo
 * (OPE-811's vocabulary guard, OPE-830's `reason:` guard matching a type
 * union). Positive assertions can use the raw text; "X is absent" cannot.
 */
const PAGE_CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the form can know a save will be refused", () => {
  it("GET returns ownerEmailVerified", () => {
    // Without this the page cannot know until a save has already failed.
    expect(ROUTE).toMatch(/ownerEmailVerified/);
    expect(ROUTE).toMatch(/\.\.\.vendor\[0\], ownerEmailVerified/);
  });

  it("⚠️ the verification read fails OPEN", () => {
    // A DB hiccup must not put a false "your edits will not save" notice in
    // front of a verified vendor. The PATCH gate is the real enforcement; this
    // field only drives copy.
    const getBlock = ROUTE.slice(0, ROUTE.indexOf("export async function PATCH"));
    expect(getBlock).toMatch(/catch\s*\{[\s\S]{0,400}ownerEmailVerified = true/);
  });

  it("the notice renders only on an explicit false", () => {
    // ⚠️ `=== false`, not falsy. An older cached response or a fixture without
    // the field would be `undefined`, and `!profile.ownerEmailVerified` would
    // show every vendor a notice telling them their edits do not save.
    expect(PAGE).toMatch(/profile\.ownerEmailVerified === false/);
    expect(PAGE_CODE).not.toMatch(/!profile\.ownerEmailVerified\b/);
  });

  it("the notice states the CONSEQUENCE, not just 'verify your email'", () => {
    // The whole reason the existing site-wide banner did not prevent this.
    const notice = PAGE.slice(PAGE.indexOf("ownerEmailVerified === false"));
    expect(notice).toMatch(/won&apos;t save until you verify/);
    // And explains the photo asymmetry the vendor actually reported.
    expect(notice).toMatch(/Photo uploads work/);
  });

  it("offers a way out, not just a diagnosis", () => {
    expect(PAGE).toMatch(/<ResendVerificationButton/);
  });
});

describe("the result renders where the action is", () => {
  const msgIdx = PAGE.indexOf("{message && (");
  const btnIdx = PAGE.indexOf('<Button type="submit"');

  it("⚠️ the message sits within 40 lines of the Save button", () => {
    // It was 276 lines above it. A distance assertion rather than a mere
    // ordering one: "after the fields" would still pass if it drifted back to
    // the top of a different section.
    expect(msgIdx).toBeGreaterThan(0);
    expect(btnIdx).toBeGreaterThan(msgIdx);
    const between = PAGE.slice(msgIdx, btnIdx).split("\n").length;
    expect(between).toBeLessThan(40);
  });

  it("the message is announced to screen readers", () => {
    const block = PAGE.slice(msgIdx, btnIdx);
    expect(block).toMatch(/aria-live="polite"/);
  });

  it("appearing scrolls it into view, guarded", () => {
    // jsdom and older WebKit lack scrollIntoView; a save must never fail
    // because feedback could not be scrolled to.
    expect(PAGE).toMatch(/messageRef\.current\?\.scrollIntoView\?\./);
  });
});

describe("success colouring", () => {
  it("⚠️ keyed on the exact string, not includes('success')", () => {
    // The server's error text is surfaced verbatim in this same box, so an
    // error mentioning "successfully" used to paint green.
    expect(PAGE).toMatch(/message === SAVE_SUCCESS/);
    expect(PAGE_CODE).not.toMatch(/message\.includes\("success"\)/);
  });

  it("the success string is one constant, used by both sides", () => {
    // Positive landmark: if the constant were defined and never used, the
    // assertion above would still pass against a dead declaration.
    expect(PAGE).toMatch(/const SAVE_SUCCESS = "Profile updated successfully";/);
    expect(PAGE).toMatch(/setMessage\(SAVE_SUCCESS\)/);
  });
});
