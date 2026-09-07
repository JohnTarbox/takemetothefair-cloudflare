/**
 * OPE-837 scope 6 — robots.txt.
 *
 * The specimen matters less here than the rules: this is the first thing in
 * the codebase that fetches a page nobody handed us directly, so the
 * permission check has to be right in both directions — it must actually
 * block a disallowed path, and it must not block everything the moment a
 * robots.txt is missing.
 */
import { describe, it, expect } from "vitest";
import {
  parseRobots,
  allowAll,
  denyAll,
  robotsUrlFor,
  robotsUnavailableMeansStop,
  effectiveCrawlDelayMs,
  isProbablyHtml,
  DEFAULT_CRAWL_DELAY_MS,
} from "./robots";

describe("robotsUrlFor", () => {
  it("builds the origin-root robots URL", () => {
    expect(robotsUrlFor("https://example.org/?page_id=54")).toBe("https://example.org/robots.txt");
  });
  it("returns null for an unusable URL", () => {
    expect(robotsUrlFor("not a url")).toBeNull();
  });
});

describe("robotsUnavailableMeansStop", () => {
  // RFC 9309: 4xx means no restrictions; 5xx means assume disallow.
  it("stops on server errors only", () => {
    expect(robotsUnavailableMeansStop(503)).toBe(true);
    expect(robotsUnavailableMeansStop(500)).toBe(true);
    expect(robotsUnavailableMeansStop(404)).toBe(false);
    expect(robotsUnavailableMeansStop(200)).toBe(false);
  });
});

describe("parseRobots", () => {
  it("blocks a disallowed prefix and allows everything else", () => {
    const r = parseRobots("User-agent: *\nDisallow: /wp-admin/\n", "MeetMeAtTheFairBot");
    expect(r.isAllowed("/wp-admin/edit.php")).toBe(false);
    expect(r.isAllowed("/?page_id=21")).toBe(true);
  });

  it("honours Allow overriding a broader Disallow by longest match", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /private/\nAllow: /private/public-page\n",
      "MeetMeAtTheFairBot"
    );
    expect(r.isAllowed("/private/secret")).toBe(false);
    expect(r.isAllowed("/private/public-page")).toBe(true);
  });

  it("treats an empty Disallow as allow-all", () => {
    const r = parseRobots("User-agent: *\nDisallow:\n", "MeetMeAtTheFairBot");
    expect(r.isAllowed("/anything")).toBe(true);
  });

  it("blocks the whole site on Disallow: /", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n", "MeetMeAtTheFairBot");
    expect(r.isAllowed("/")).toBe(false);
    expect(r.isAllowed("/?page_id=21")).toBe(false);
  });

  it("prefers a group naming our agent over the wildcard group", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: MeetMeAtTheFairBot\nDisallow: /admin\n",
      "MeetMeAtTheFairBot"
    );
    expect(r.matchedSpecificAgent).toBe(true);
    expect(r.isAllowed("/?page_id=21")).toBe(true);
    expect(r.isAllowed("/admin")).toBe(false);
  });

  it("supports * and $ wildcards", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\n", "MeetMeAtTheFairBot");
    expect(r.isAllowed("/files/map.pdf")).toBe(false);
    expect(r.isAllowed("/files/map.pdf.html")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const r = parseRobots("# comment\n\nUser-agent: *\n# another\nDisallow: /x\n", "Bot");
    expect(r.isAllowed("/x")).toBe(false);
    expect(r.isAllowed("/y")).toBe(true);
  });

  it("reads Crawl-delay from the matching group", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 2\nDisallow: /x\n", "Bot");
    expect(r.crawlDelaySeconds).toBe(2);
  });

  it("allows everything when robots.txt names no groups", () => {
    expect(parseRobots("", "Bot").isAllowed("/anything")).toBe(true);
  });
});

describe("allowAll / denyAll", () => {
  it("are total", () => {
    expect(allowAll().isAllowed("/x")).toBe(true);
    expect(denyAll().isAllowed("/x")).toBe(false);
  });
});

describe("effectiveCrawlDelayMs", () => {
  it("defaults when robots names no delay", () => {
    expect(effectiveCrawlDelayMs(null)).toBe(DEFAULT_CRAWL_DELAY_MS);
  });
  it("caps an unreasonable delay rather than abandoning the crawl", () => {
    expect(effectiveCrawlDelayMs(30)).toBe(5000);
  });
  it("raises a sub-second delay to the floor", () => {
    expect(effectiveCrawlDelayMs(0)).toBe(DEFAULT_CRAWL_DELAY_MS);
  });
});

describe("isProbablyHtml — the WordPress catch-all robots.txt", () => {
  // Measured on the OPE-837 specimen: /robots.txt 301s to /robots.txt/ and
  // returns 200 with the site homepage. A status-only check reads that as a
  // valid rule set.
  it("detects an HTML page served as robots.txt", () => {
    expect(isProbablyHtml('<!doctype html>\n<html lang="en-US">\n<head>')).toBe(true);
    expect(isProbablyHtml('<html><head><meta charset="UTF-8" />')).toBe(true);
  });

  it("does not flag a real robots.txt", () => {
    expect(isProbablyHtml("User-agent: *\nDisallow: /wp-admin/\n")).toBe(false);
    expect(isProbablyHtml("# comment\nUser-agent: *\nCrawl-delay: 2\n")).toBe(false);
    expect(isProbablyHtml("")).toBe(false);
  });
});
