import { describe, it, expect } from "vitest";
import { isFacebookSource, summarizeFacebookTraffic, type TrafficSourceRow } from "@/lib/ga4";

describe("isFacebookSource", () => {
  it("matches canonical facebook.com", () => {
    expect(isFacebookSource("facebook.com")).toBe(true);
  });

  it("matches FB's mobile subdomain", () => {
    expect(isFacebookSource("m.facebook.com")).toBe(true);
  });

  it("matches FB's link-redirector hostnames", () => {
    expect(isFacebookSource("l.facebook.com")).toBe(true);
    expect(isFacebookSource("lm.facebook.com")).toBe(true);
    expect(isFacebookSource("lite.facebook.com")).toBe(true);
  });

  it("matches FB short-link domains", () => {
    expect(isFacebookSource("fb.com")).toBe(true);
    expect(isFacebookSource("fb.me")).toBe(true);
  });

  it("matches the bare 'facebook' source GA4 uses when UTM-tagged", () => {
    expect(isFacebookSource("facebook")).toBe(true);
  });

  it("matches unknown FB subdomains via the .facebook.com suffix rule", () => {
    expect(isFacebookSource("business.facebook.com")).toBe(true);
    expect(isFacebookSource("developers.facebook.com")).toBe(true);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(isFacebookSource("Facebook.com")).toBe(true);
    expect(isFacebookSource("  M.FACEBOOK.COM  ")).toBe(true);
  });

  it("rejects empty / direct / unrelated sources", () => {
    expect(isFacebookSource("")).toBe(false);
    expect(isFacebookSource("(direct)")).toBe(false);
    expect(isFacebookSource("google")).toBe(false);
    expect(isFacebookSource("instagram.com")).toBe(false);
  });

  it("rejects look-alike hostnames that aren't Facebook", () => {
    expect(isFacebookSource("notfacebook.com")).toBe(false);
    expect(isFacebookSource("bookface.com")).toBe(false);
    expect(isFacebookSource("facebook.evil.com")).toBe(false);
  });
});

describe("summarizeFacebookTraffic", () => {
  const fb = (source: string, sessions: number, activeUsers: number): TrafficSourceRow => ({
    source,
    medium: "referral",
    sessions,
    activeUsers,
  });

  it("returns zeros and empty rows for an empty input", () => {
    expect(summarizeFacebookTraffic([])).toEqual({
      sessions: 0,
      activeUsers: 0,
      rows: [],
    });
  });

  it("returns zeros when no rows match", () => {
    const rows = [fb("google", 100, 80), fb("bing", 20, 15)];
    const summary = summarizeFacebookTraffic(rows);
    expect(summary.sessions).toBe(0);
    expect(summary.activeUsers).toBe(0);
    expect(summary.rows).toEqual([]);
  });

  it("aggregates sessions and users across all FB subdomains", () => {
    const rows = [
      fb("facebook.com", 50, 40),
      fb("m.facebook.com", 80, 70),
      fb("l.facebook.com", 10, 8),
      fb("google", 200, 150), // should be excluded
    ];
    const summary = summarizeFacebookTraffic(rows);
    expect(summary.sessions).toBe(140);
    expect(summary.activeUsers).toBe(118);
    expect(summary.rows).toHaveLength(3);
  });

  it("sorts the rows by sessions descending", () => {
    const rows = [
      fb("facebook.com", 50, 40),
      fb("m.facebook.com", 80, 70),
      fb("l.facebook.com", 10, 8),
    ];
    const summary = summarizeFacebookTraffic(rows);
    expect(summary.rows.map((r) => r.source)).toEqual([
      "m.facebook.com",
      "facebook.com",
      "l.facebook.com",
    ]);
  });

  it("preserves the original input array (does not mutate)", () => {
    const rows = [fb("facebook.com", 50, 40), fb("m.facebook.com", 80, 70)];
    const before = rows.map((r) => r.source);
    summarizeFacebookTraffic(rows);
    // Note: implementation may sort an internal copy; this test guards against
    // accidental in-place sort that would reorder caller's array.
    expect(rows.map((r) => r.source)).toEqual(before);
  });
});
