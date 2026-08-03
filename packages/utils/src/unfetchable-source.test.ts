import { describe, it, expect } from "vitest";
import { isUnfetchableSource } from "./unfetchable-source";

/**
 * OPE-297. The acceptance criterion this backs: "the unfetchable citation
 * provably never enters any rescrape/refetch queue."
 *
 * Both rescrape routes select on `events.source_url` — `rescrape-descriptions`
 * filters `isNotNull(events.source_url)` — so the save route leaves that column
 * NULL for an unfetchable source. Exclusion is therefore structural: nothing
 * can select a row that has no URL to select. These tests pin the predicate
 * that decides it.
 */
describe("isUnfetchableSource (OPE-297)", () => {
  it("matches Facebook event URLs in the forms operators actually paste", () => {
    for (const url of [
      "https://www.facebook.com/events/1234567890",
      "https://facebook.com/events/1234567890",
      "https://m.facebook.com/events/1234567890",
      "https://web.facebook.com/events/1234567890",
      "https://fb.me/e/abc123",
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com",
    ]) {
      expect(isUnfetchableSource(url), url).toBe(true);
    }
  });

  it("does NOT match a fetchable page that merely mentions facebook", () => {
    // The failure this guards: substring-matching would strand a perfectly
    // fetchable promoter page and silently stop it being re-scraped.
    for (const url of [
      "https://example.com/our-facebook-page",
      "https://example.com/events?utm_source=facebook.com",
      "https://notfacebook.com/events/1",
      "https://facebook.com.evil.example/events/1",
    ]) {
      expect(isUnfetchableSource(url), url).toBe(false);
    }
  });

  it("leaves ordinary sources alone", () => {
    expect(isUnfetchableSource("https://mainefairs.net/fair/1")).toBe(false);
    expect(isUnfetchableSource("https://www.cheshirefair.org/")).toBe(false);
  });

  it("is safe on absent or malformed input", () => {
    expect(isUnfetchableSource(null)).toBe(false);
    expect(isUnfetchableSource(undefined)).toBe(false);
    expect(isUnfetchableSource("")).toBe(false);
    expect(isUnfetchableSource("not a url")).toBe(false);
    // A bare host with no scheme doesn't parse; treat as fetchable rather than
    // silently suppressing re-fetch for something we failed to understand.
    expect(isUnfetchableSource("facebook.com/events/1")).toBe(false);
  });
});
