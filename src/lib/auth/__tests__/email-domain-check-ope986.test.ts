/**
 * OPE-986 — undeliverable email domains are refused at registration.
 *
 * Pinned from BOTH sides. The rejection half is the 2026-09-13 bounce
 * (`sanzaarts@gmail.vom`). The acceptance half matters as much: the same
 * person's OTHER address, `sanzaart@gmail.com`, was a typo of his mailbox but a
 * perfectly deliverable address — this check cannot know it was the wrong one,
 * and must not pretend to. Legitimate newer TLDs must keep working.
 */
import { describe, it, expect } from "vitest";
import { checkEmailDomain } from "../email-domain-check";

describe("checkEmailDomain — refuses known-undeliverable domains", () => {
  it("rejects sanzaarts@gmail.vom and suggests gmail.com (the incident address)", () => {
    const v = checkEmailDomain("sanzaarts@gmail.vom");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.suggestion).toBe("sanzaarts@gmail.com");
    expect(v.message).toBe("Did you mean sanzaarts@gmail.com?");
  });

  it.each([
    ["jane@gmail.con", "jane@gmail.com"],
    ["jane@gmail.cmo", "jane@gmail.com"],
    ["jane@gmail.comm", "jane@gmail.com"],
    ["jane@gmail.cm", "jane@gmail.com"],
    ["jane@gmail.co", "jane@gmail.com"],
    ["jane@gmial.com", "jane@gmail.com"],
    ["jane@gamil.com", "jane@gmail.com"],
    ["jane@hotmial.com", "jane@hotmail.com"],
    ["jane@yaho.com", "jane@yahoo.com"],
    ["jane@outlok.com", "jane@outlook.com"],
    ["jane@iclod.com", "jane@icloud.com"],
    // A provider-label slip AND a TLD slip in the same address.
    ["jane@gmial.vom", "jane@gmail.com"],
    // A typo TLD on a domain we know nothing about still gets its TLD fixed.
    ["jane@mapleworks.ocm", "jane@mapleworks.com"],
    ["jane@grange.ogr", "jane@grange.org"],
    // Case and a trailing dot do not dodge the check.
    ["Jane@GMAIL.VOM", "Jane@gmail.com"],
    ["jane@gmail.vom.", "jane@gmail.com"],
  ])("rejects %s with suggestion %s", (email, suggestion) => {
    const v = checkEmailDomain(email);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.suggestion).toBe(suggestion);
  });

  it.each(["jane@gmail.c0m", "jane@gmail.c", "jane@mapleworks.123"])(
    "rejects a malformed TLD with no guess: %s",
    (email) => {
      const v = checkEmailDomain(email);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.suggestion).toBeNull();
        expect(v.message).toMatch(/not a valid email domain/);
      }
    }
  );
});

describe("checkEmailDomain — accepts deliverable addresses", () => {
  it("accepts sanzaart@gmail.com — deliverable, even though it was the wrong mailbox", () => {
    expect(checkEmailDomain("sanzaart@gmail.com")).toEqual({ ok: true });
  });

  it.each([
    "info@grange.org",
    "clerk@merrimack.nh.us",
    "hello@beadshop.shop",
    "maker@wool.farm",
    "sam@studio.co.uk",
    "me@yahoo.ca",
    "me@hotmail.co.uk",
    "someone@company.co",
    "a@b.xn--p1ai",
    "person@comcast.net",
  ])("accepts %s", (email) => {
    expect(checkEmailDomain(email)).toEqual({ ok: true });
  });

  it("leaves shape errors to z.string().email()", () => {
    // No '@' or no domain: not this check's call, and it must not throw.
    expect(checkEmailDomain("not-an-email")).toEqual({ ok: true });
    expect(checkEmailDomain("trailing@")).toEqual({ ok: true });
  });
});
