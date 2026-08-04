/**
 * OPE-333 — conditional-request (304) support for sitemaps.
 *
 * The failure mode this guards is subtle: emit the headers but get the
 * comparison wrong, and every conditional GET returns 200. Crawlers keep
 * re-downloading, the crawl-budget benefit never arrives, and nothing looks
 * broken — the sitemap still serves correctly.
 */
import { describe, expect, it } from "vitest";
import { conditionalXmlResponse } from "../sitemap-xml";

const BODY = `<?xml version="1.0"?><urlset><url><loc>https://x/a</loc></url></urlset>`;
const MOD = new Date("2026-08-04T12:00:00.000Z");

const req = (headers: Record<string, string> = {}) =>
  new Request("https://meetmeatthefair.com/sitemap.xml", { headers });

describe("conditionalXmlResponse (OPE-333)", () => {
  it("emits both validators on an unconditional GET", () => {
    return conditionalXmlResponse({ request: req(), body: BODY, lastModified: MOD }).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]+"$/);
      expect(res.headers.get("Last-Modified")).toBe(MOD.toUTCString());
      expect(res.headers.get("Cache-Control")).toContain("public");
    });
  });

  it("304s on a matching ETag, with no body", async () => {
    const first = await conditionalXmlResponse({ request: req(), body: BODY, lastModified: MOD });
    const etag = first.headers.get("ETag")!;
    const second = await conditionalXmlResponse({
      request: req({ "If-None-Match": etag }),
      body: BODY,
      lastModified: MOD,
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("200s when the body changed, even though the client sent an ETag", async () => {
    const first = await conditionalXmlResponse({ request: req(), body: BODY, lastModified: MOD });
    const stale = first.headers.get("ETag")!;
    const res = await conditionalXmlResponse({
      request: req({ "If-None-Match": stale }),
      body: BODY + "<!-- a new event -->",
      lastModified: MOD,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("a new event");
  });

  it("304s on If-Modified-Since at or after the last change", async () => {
    for (const since of [MOD, new Date(MOD.getTime() + 60_000)]) {
      const res = await conditionalXmlResponse({
        request: req({ "If-Modified-Since": since.toUTCString() }),
        body: BODY,
        lastModified: MOD,
      });
      expect(res.status, since.toUTCString()).toBe(304);
    }
  });

  it("200s when the resource changed after the client's copy", async () => {
    // Adding an event must make the next conditional request return 200 —
    // the acceptance clause that keeps the sitemap from going stale forever.
    const res = await conditionalXmlResponse({
      request: req({ "If-Modified-Since": new Date(MOD.getTime() - 60_000).toUTCString() }),
      body: BODY,
      lastModified: MOD,
    });
    expect(res.status).toBe(200);
  });

  it("compares at second resolution, not milliseconds", async () => {
    // HTTP dates carry no sub-second part. Comparing raw ms would make a
    // .500 timestamp always look newer than its own truncated header value,
    // so the 304 path would never fire — the silent version of this bug.
    const withMillis = new Date("2026-08-04T12:00:00.750Z");
    const res = await conditionalXmlResponse({
      request: req({ "If-Modified-Since": withMillis.toUTCString() }),
      body: BODY,
      lastModified: withMillis,
    });
    expect(res.status).toBe(304);
  });

  it("ignores an unparseable If-Modified-Since rather than 304ing blindly", async () => {
    const res = await conditionalXmlResponse({
      request: req({ "If-Modified-Since": "not a date" }),
      body: BODY,
      lastModified: MOD,
    });
    expect(res.status).toBe(200);
  });

  it("still serves when lastModified is unknown", async () => {
    const res = await conditionalXmlResponse({
      request: req({ "If-Modified-Since": MOD.toUTCString() }),
      body: BODY,
      lastModified: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Last-Modified")).toBeNull();
    expect(res.headers.get("ETag")).not.toBeNull();
  });
});
