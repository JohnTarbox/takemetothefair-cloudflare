/**
 * OPE-64 — domain-match decision core (rung 2). SECURITY cases.
 *
 * These assertions ARE the security contract for auto-approval via domain
 * match: only a genuine, non-freemail/non-builder registrable-domain match
 * between the account email and the STORED website may qualify.
 */
import { describe, expect, it } from "vitest";
import {
  decideDomainMatch,
  registrableDomainFromEmail,
  registrableDomainFromWebsite,
} from "../domain-match";

describe("decideDomainMatch", () => {
  it("matches a real business domain email + website", () => {
    expect(decideDomainMatch("jane@acme.com", "https://acme.com")).toEqual({
      match: true,
      registrableDomain: "acme.com",
    });
  });

  it("matches when the email is on a subdomain (registrable domains equal)", () => {
    expect(decideDomainMatch("jane@shop.acme.com", "acme.com")).toEqual({
      match: true,
      registrableDomain: "acme.com",
    });
  });

  it("matches a multi-part eTLD (acme.co.uk)", () => {
    expect(decideDomainMatch("jane@acme.co.uk", "acme.co.uk")).toEqual({
      match: true,
      registrableDomain: "acme.co.uk",
    });
  });

  it("blocks a freemail email even if the website equals it (non_matchable_email)", () => {
    expect(decideDomainMatch("jane@gmail.com", "acme.com")).toEqual({
      match: false,
      reason: "non_matchable_email",
    });
  });

  it("blocks a social/builder website (non_matchable_website)", () => {
    expect(decideDomainMatch("jane@acme.com", "https://facebook.com/acme")).toEqual({
      match: false,
      reason: "non_matchable_website",
    });
  });

  it("rejects a genuinely different domain (different_domain)", () => {
    expect(decideDomainMatch("jane@acme.com", "https://other.com")).toEqual({
      match: false,
      reason: "different_domain",
    });
  });

  it("returns no_email / no_website for missing inputs", () => {
    expect(decideDomainMatch(null, "acme.com")).toEqual({ match: false, reason: "no_email" });
    expect(decideDomainMatch("", "acme.com")).toEqual({ match: false, reason: "no_email" });
    expect(decideDomainMatch("jane@acme.com", null)).toEqual({
      match: false,
      reason: "no_website",
    });
    expect(decideDomainMatch("jane@acme.com", "")).toEqual({ match: false, reason: "no_website" });
  });

  it("parses a bare-host website with no scheme", () => {
    // No http(s):// prefix — still resolves to the registrable domain.
    expect(decideDomainMatch("jane@acme.com", "www.acme.com")).toEqual({
      match: true,
      registrableDomain: "acme.com",
    });
  });

  it("reports unparseable_email when there is no @ host", () => {
    expect(decideDomainMatch("not-an-email", "acme.com")).toEqual({
      match: false,
      reason: "unparseable_email",
    });
  });
});

describe("registrableDomainFromEmail / registrableDomainFromWebsite", () => {
  it("extracts eTLD+1 from an email host", () => {
    expect(registrableDomainFromEmail("jane@shop.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomainFromEmail("JANE@ACME.COM ")).toBe("acme.com");
    expect(registrableDomainFromEmail(null)).toBeNull();
    expect(registrableDomainFromEmail("nope")).toBeNull();
  });

  it("extracts eTLD+1 from a website with or without scheme", () => {
    expect(registrableDomainFromWebsite("https://www.acme.com/path")).toBe("acme.com");
    expect(registrableDomainFromWebsite("acme.com")).toBe("acme.com");
    expect(registrableDomainFromWebsite(null)).toBeNull();
    expect(registrableDomainFromWebsite("  ")).toBeNull();
  });
});
