/**
 * OPE-1330 — the claim matcher's private block-list moved to the ONE shared
 * list in @takemetothefair/utils (`NON_OWNABLE_DOMAINS`). Moving a security
 * list must not drop an entry: this is the list exactly as it stood in
 * `domain-match.ts` before the move, and every entry must still refuse to
 * match.
 */
import { describe, it, expect } from "vitest";
import { NON_OWNABLE_DOMAINS } from "@takemetothefair/utils";
import { decideDomainMatch } from "../domain-match";

const FORMER_PRIVATE_LIST = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "cox.net",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "linktr.ee",
  "bit.ly",
  "wordpress.com",
  "wix.com",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "blogspot.com",
  "godaddysites.com",
  "webflow.io",
  "square.site",
  "myshopify.com",
  "etsy.com",
  "eventbrite.com",
  "googlebusiness.com",
  "business.site",
];

describe("claim domain-match after the list moved to utils", () => {
  it("keeps every domain the private list held (49)", () => {
    const missing = FORMER_PRIVATE_LIST.filter((d) => !NON_OWNABLE_DOMAINS.has(d));
    expect(missing).toEqual([]);
  });

  it.each(FORMER_PRIVATE_LIST)("%s still never produces a match", (d) => {
    expect(decideDomainMatch(`owner@${d}`, `https://${d}`)).toMatchObject({ match: false });
  });

  it("a real business domain still matches (positive landmark)", () => {
    expect(decideDomainMatch("jane@mail.grange.org", "https://www.grange.org/fair")).toEqual({
      match: true,
      registrableDomain: "grange.org",
    });
  });
});
