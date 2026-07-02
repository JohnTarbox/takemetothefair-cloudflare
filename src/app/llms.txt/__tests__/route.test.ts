import { describe, it, expect } from "vitest";
import { GET } from "../route";

// /llms.txt is a hand-built, DB-free static route (OPE-41). These assertions
// lock the llmstxt.org shape (H1 title + `>` summary + `## Sections`), the
// text/plain content type, and the presence of the key structured-index links
// an AI agent needs to crawl the site.

describe("/llms.txt route", () => {
  it("returns text/plain with a long cache header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
  });

  it("follows the llmstxt.org convention (H1 title + blockquote summary + Sections)", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("# Meet Me at the Fair");
    // Blockquote summary line.
    expect(body).toMatch(/^> /m);
    expect(body).toContain("## Sections");
  });

  it("links the structured indexes and OPE-40 browse directories", async () => {
    const body = await (await GET()).text();
    const base = "https://meetmeatthefair.com";
    for (const link of [
      `${base}/sitemap.xml`,
      `${base}/events`,
      `${base}/events/all`,
      `${base}/venues`,
      `${base}/vendors`,
      `${base}/vendors/browse`,
      `${base}/venues/browse`,
    ]) {
      expect(body).toContain(link);
    }
  });

  it("includes the OPE-62 Help section with the hub + known help article links", async () => {
    const body = await (await GET()).text();
    const base = "https://meetmeatthefair.com";
    expect(body).toContain("### Help");
    expect(body).toContain(`${base}/help)`);
    // A stable, known help slug (the FAQ article).
    expect(body).toContain(`${base}/help/faq)`);
    // Another known task-guide slug.
    expect(body).toContain(`${base}/help/find-events-near-you)`);
  });

  it("links every New England state hub", async () => {
    const body = await (await GET()).text();
    const base = "https://meetmeatthefair.com";
    for (const state of [
      "maine",
      "vermont",
      "new-hampshire",
      "massachusetts",
      "connecticut",
      "rhode-island",
    ]) {
      expect(body).toContain(`${base}/events/${state}`);
    }
  });
});
