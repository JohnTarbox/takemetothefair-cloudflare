/**
 * Tests for the URL host denylist (analyst K1, 2026-05-29 PM).
 *
 * Three buckets:
 *   - exact hostname match (Mailchimp click-tracker, URL shorteners)
 *   - suffix wildcard match (*.list-manage.com)
 *   - non-match (real organizer pages, unparseable junk)
 *
 * Pure function tests — no fixtures, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  isDenylistedHost,
  URL_DENYLIST_HOSTS,
  URL_DENYLIST_SUFFIXES,
} from "../src/url-denylist.js";

describe("isDenylistedHost — exact matches", () => {
  it("blocks the K1 Mailchimp click-tracker root (list-manage.com)", () => {
    expect(isDenylistedHost("https://list-manage.com/track/abc")).toBe(true);
  });

  it("blocks mailchi.mp shortlinks", () => {
    expect(isDenylistedHost("https://mailchi.mp/abc123/newsletter")).toBe(true);
  });

  it("blocks common URL shorteners", () => {
    expect(isDenylistedHost("https://bit.ly/3xyz")).toBe(true);
    expect(isDenylistedHost("https://t.co/abc")).toBe(true);
    expect(isDenylistedHost("https://tinyurl.com/abc")).toBe(true);
    expect(isDenylistedHost("https://ow.ly/abc")).toBe(true);
  });

  it("blocks ESP click-trackers in common use", () => {
    expect(isDenylistedHost("https://click.hubspot.com/cta/abc")).toBe(true);
    expect(isDenylistedHost("https://click.icptrack.com/icp/abc")).toBe(true);
  });

  it("blocks GovDelivery's lnks.gd", () => {
    expect(isDenylistedHost("https://lnks.gd/l/abc")).toBe(true);
  });
});

describe("isDenylistedHost — suffix wildcards", () => {
  it("blocks the K1 case verbatim (us.list-manage.com Mailchimp redirect)", () => {
    expect(isDenylistedHost("https://us.list-manage.com/track/click?u=abc&id=def&e=g")).toBe(true);
  });

  it("blocks every subdomain of list-manage.com", () => {
    expect(isDenylistedHost("https://us1.list-manage.com/")).toBe(true);
    expect(isDenylistedHost("https://us20.list-manage.com/track")).toBe(true);
    expect(isDenylistedHost("https://something.list-manage.com/x")).toBe(true);
  });

  it("blocks SendGrid + Mailgun click-tracker subdomains", () => {
    expect(isDenylistedHost("https://u123.sendgrid.net/track/abc")).toBe(true);
    expect(isDenylistedHost("https://email.mailgun.org/track")).toBe(true);
  });

  it("does NOT block hosts that merely contain a denylisted string in path or query", () => {
    // Defense-in-depth: a real organizer page that happens to link to a
    // .list-manage.com subscription form via query param shouldn't itself
    // be classified by the URL of the link.
    expect(isDenylistedHost("https://winthroparts.org/?ref=list-manage.com")).toBe(false);
  });
});

describe("isDenylistedHost — non-match (the cases we want to KEEP)", () => {
  it("does NOT block organizer pages on common TLDs", () => {
    expect(isDenylistedHost("https://winthroparts.org/festival")).toBe(false);
    expect(isDenylistedHost("https://meetmeatthefair.com/events/abc")).toBe(false);
    expect(isDenylistedHost("https://www.winthropchamber.org/events/x")).toBe(false);
  });

  it("does NOT block gov / town sites", () => {
    expect(isDenylistedHost("https://belgrademaine.gov/events")).toBe(false);
    expect(isDenylistedHost("https://townofunity.org/market")).toBe(false);
  });

  it("returns false for unparseable URLs (delegates to downstream cleanUrl)", () => {
    expect(isDenylistedHost("not-a-url")).toBe(false);
    expect(isDenylistedHost("")).toBe(false);
    expect(isDenylistedHost("ftp://malformed")).toBe(false); // parses, but no host match
  });
});

describe("denylist data invariants", () => {
  it("URL_DENYLIST_HOSTS is non-empty and lowercased", () => {
    expect(URL_DENYLIST_HOSTS.size).toBeGreaterThan(0);
    for (const host of URL_DENYLIST_HOSTS) {
      expect(host).toBe(host.toLowerCase());
    }
  });

  it("URL_DENYLIST_SUFFIXES all start with a dot (subdomain match only)", () => {
    expect(URL_DENYLIST_SUFFIXES.length).toBeGreaterThan(0);
    for (const suf of URL_DENYLIST_SUFFIXES) {
      expect(suf.startsWith(".")).toBe(true);
    }
  });
});
