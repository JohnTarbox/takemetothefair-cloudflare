import { describe, it, expect } from "vitest";
import {
  GENERIC_EMAIL_PROVIDERS,
  NON_OWNABLE_DOMAINS,
  SHARED_HOST_DOMAINS,
  isNonOwnableDomain,
  organizationalDomain,
} from "../index";

describe("organizationalDomain", () => {
  it.each([
    ["events@mail.example.org", "example.org"],
    ["https://www.example.org/fair", "example.org"],
    ["www.example.org", "example.org"],
    ["example.org/path", "example.org"],
    ["Contact@GarlicFestCT.com", "garlicfestct.com"],
    ["https://garlicfestct.com/", "garlicfestct.com"],
    ["office@fair.example.co.uk", "example.co.uk"],
    ["https://x.sites.google.com/view/fair", "google.com"],
  ])("%s → %s", (input, want) => {
    expect(organizationalDomain(input)).toBe(want);
  });

  it.each([null, undefined, "", "   ", "not a domain"])("%j → null", (v) => {
    expect(organizationalDomain(v as string | null | undefined)).toBeNull();
  });
});

describe("isNonOwnableDomain — one list for every 'same organization?' decision", () => {
  it("contains all of OPE-856's mailbox providers and every shared host", () => {
    for (const d of GENERIC_EMAIL_PROVIDERS) expect(NON_OWNABLE_DOMAINS.has(d)).toBe(true);
    for (const d of SHARED_HOST_DOMAINS) expect(NON_OWNABLE_DOMAINS.has(d)).toBe(true);
  });

  it.each([
    "gmail.com",
    "yahoo.com",
    "facebook.com",
    "www.facebook.com",
    "foo.wixsite.com",
    "sites.google.com",
  ])("%s is non-ownable", (d) => expect(isNonOwnableDomain(d)).toBe(true));

  it.each(["garlicfestct.com", "christmasprelude.com", "mail.grange.org"])(
    "%s is an organization's own domain",
    (d) => expect(isNonOwnableDomain(d)).toBe(false)
  );
});
