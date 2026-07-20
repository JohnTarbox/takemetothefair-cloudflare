/**
 * OPE-261 — the operator alert channel had been delivering exclusively to a
 * robot (`alert@meetmeatthefair.com` routes into our own inbound worker). These
 * cover the two mechanics that let a human finally receive it: splitting a
 * multi-recipient env value, and building links that actually resolve.
 */
import { describe, it, expect } from "vitest";
import {
  formatRecipientsForLedger,
  normalizeRecipients,
  resolveDigestHref,
} from "./email-recipients";

describe("normalizeRecipients", () => {
  it("splits the ALERT_EMAIL_TECHNICAL value this ticket ships", () => {
    expect(normalizeRecipients("alert@meetmeatthefair.com,jtarboxme@gmail.com")).toEqual([
      "alert@meetmeatthefair.com",
      "jtarboxme@gmail.com",
    ]);
  });

  it("keeps alert@ FIRST so the inbound-worker audit copy stays primary", () => {
    const out = normalizeRecipients(" alert@meetmeatthefair.com , jtarboxme@gmail.com ");
    expect(out[0]).toBe("alert@meetmeatthefair.com");
  });

  it("leaves a single address as a 1-element array (no behaviour change)", () => {
    expect(normalizeRecipients("john@pimboat.com")).toEqual(["john@pimboat.com"]);
  });

  it("accepts semicolons too — operators type either separator", () => {
    expect(normalizeRecipients("a@x.com; b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("drops empties from a trailing separator rather than sending to ''", () => {
    expect(normalizeRecipients("a@x.com,")).toEqual(["a@x.com"]);
    expect(normalizeRecipients("  ")).toEqual([]);
  });

  it("de-dupes case-insensitively, preserving first-seen casing", () => {
    expect(normalizeRecipients("John@X.com,john@x.com")).toEqual(["John@X.com"]);
  });

  it("returns [] for null/undefined so a caller can refuse to send", () => {
    expect(normalizeRecipients(null)).toEqual([]);
    expect(normalizeRecipients(undefined)).toEqual([]);
  });

  it("flattens an array input as well as a string", () => {
    expect(normalizeRecipients(["a@x.com,b@y.com", "c@z.com"])).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });
});

describe("formatRecipientsForLedger", () => {
  it("stores the whole list, so the ledger can't under-report the send", () => {
    expect(formatRecipientsForLedger("alert@meetmeatthefair.com,jtarboxme@gmail.com")).toBe(
      "alert@meetmeatthefair.com, jtarboxme@gmail.com"
    );
  });
});

describe("resolveDigestHref", () => {
  it("reproduces and fixes the real malformed IndexNow link", () => {
    // The digest that reached the archive on 2026-07-20 contained
    // "https://meetmeatthefair.comhttps://www.bing.com/webmasters" — an
    // already-absolute href concatenated onto the site base.
    const href = "https://www.bing.com/webmasters";
    const out = resolveDigestHref("https://meetmeatthefair.com", href);
    expect(out).toBe(href);
    expect(out).not.toContain("comhttps");
  });

  it("still prefixes site-relative admin deep links", () => {
    expect(
      resolveDigestHref("https://meetmeatthefair.com", "/admin/analytics?tab=site-health")
    ).toBe("https://meetmeatthefair.com/admin/analytics?tab=site-health");
  });

  it("does not double the slash when the base has a trailing one", () => {
    expect(resolveDigestHref("https://meetmeatthefair.com/", "/admin")).toBe(
      "https://meetmeatthefair.com/admin"
    );
  });

  it("treats protocol-relative hrefs as absolute", () => {
    expect(resolveDigestHref("https://meetmeatthefair.com", "//cdn.example.com/x")).toBe(
      "//cdn.example.com/x"
    );
  });
});
