/**
 * OPE-1496 — the pure parts of the /go/ redirect: scanner classification,
 * query attribution, and the on-site beacon now carrying utm_campaign.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyGoRequest, goEventName, readGoParams, safeHttpUrl } from "@/lib/go-redirect";
import { classifyTrafficSource } from "@/lib/analytics/traffic-attribution";
import { CONVERSION_EVENT_NAMES } from "@/lib/analytics-overview/shared";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("classifyGoRequest", () => {
  it.each([
    ["a desktop browser GET", "GET", CHROME, null, "human", null],
    ["HEAD", "HEAD", CHROME, null, "scanner", "head"],
    ["a speculative prefetch", "GET", CHROME, "prefetch", "scanner", "prefetch"],
    ["no user agent", "GET", "", null, "scanner", "empty-ua"],
    [
      "Gmail's proxy",
      "GET",
      "Mozilla/5.0 via ggpht.com GoogleImageProxy",
      null,
      "scanner",
      "ua:googleimageproxy",
    ],
    ["Barracuda", "GET", "Barracuda Sentinel (EE)", null, "scanner", "ua:barracuda"],
    ["curl", "GET", "curl/8.5.0", null, "scanner", "ua:curl/"],
    ["Python", "GET", "python-requests/2.32", null, "scanner", "ua:python-requests"],
  ])("%s", (_l, method, userAgent, purpose, uaClass, uaReason) => {
    expect(classifyGoRequest({ method, userAgent, purpose })).toEqual({ uaClass, uaReason });
  });
});

describe("readGoParams — same attribution rules as the on-site beacon", () => {
  it("source + medium lower-cased, campaign + label as given", () => {
    expect(
      readGoParams(new URLSearchParams("c=Vendor-Digest-2026-10-26&s=Newsletter&m=Email&l=card-3"))
    ).toEqual({
      campaign: "Vendor-Digest-2026-10-26",
      trafficSource: "newsletter",
      trafficMedium: "email",
      linkLabel: "card-3",
    });
  });
  it("nothing given → (direct)/(none), never a missing medium", () => {
    expect(readGoParams(new URLSearchParams(""))).toEqual({
      campaign: null,
      trafficSource: "(direct)",
      trafficMedium: "(none)",
      linkLabel: null,
    });
  });
  it("half a pair → (not set) for the missing half", () => {
    expect(readGoParams(new URLSearchParams("s=newsletter"))).toMatchObject({
      trafficSource: "newsletter",
      trafficMedium: "(not set)",
    });
  });
  it("caps each value at 100 characters", () => {
    expect(readGoParams(new URLSearchParams(`c=${"x".repeat(500)}`)).campaign).toHaveLength(100);
  });
});

describe("goEventName — a scanner hit never lands in the conversion names", () => {
  it("human rows use the shared names every report already counts", () => {
    expect(goEventName("apply", "human")).toBe("outbound_application_click");
    expect(goEventName("tickets", "human")).toBe("outbound_ticket_click");
  });
  it("scanner rows are outside CONVERSION_EVENT_NAMES", () => {
    for (const kind of ["apply", "tickets"] as const) {
      expect(CONVERSION_EVENT_NAMES as readonly string[]).not.toContain(
        goEventName(kind, "scanner")
      );
    }
  });
});

describe("safeHttpUrl", () => {
  it.each([
    ["https://a.example/x", "https://a.example/x"],
    ["  http://a.example  ", "http://a.example/"],
    ["javascript:alert(1)", null],
    ["/relative", null],
    ["", null],
    [null, null],
  ])("%s → %s", (input, want) => expect(safeHttpUrl(input)).toBe(want));
});

describe("on-site beacon carries utm_campaign (item 5)", () => {
  it("the landing classifier keeps the campaign beside source/medium", () => {
    expect(
      classifyTrafficSource({
        search: "?utm_source=newsletter&utm_medium=email&utm_campaign=weekend-digest-2026-10-23",
        referrer: "",
        selfHost: "meetmeatthefair.com",
      })
    ).toEqual({ medium: "email", source: "newsletter", campaign: "weekend-digest-2026-10-23" });
  });
  it("no utm_campaign → no campaign key at all", () => {
    expect(
      classifyTrafficSource({ search: "?utm_source=x&utm_medium=y", referrer: "", selfHost: "s" })
    ).not.toHaveProperty("campaign");
  });
  it("the click beacon's traffic props include it (source-level: the beacon is browser-only)", () => {
    const src = readFileSync(join(__dirname, "../analytics.ts"), "utf8");
    const fn = src.slice(
      src.indexOf("function trafficProps("),
      src.indexOf("function sendBeacon(")
    );
    expect(fn).toMatch(/campaign: a\.campaign/);
  });
});

describe("robots.txt disallows /go/", () => {
  it("under the wildcard agent", () => {
    const robots = readFileSync(join(__dirname, "../../../public/robots.txt"), "utf8");
    const wildcard = robots.slice(
      robots.indexOf("User-agent: *"),
      robots.indexOf("User-agent: GPTBot")
    );
    expect(wildcard).toMatch(/^Disallow: \/go\/$/m);
  });
});
