import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { HELP_ARTICLES } from "@/lib/help-articles";

// OPE-62 — `/help/<slug>.md` serves the raw markdown of a help article. App
// Router can't express this as a dynamic route in Next 15 (a `[slug].md`
// segment is treated as a literal static path), so it's served from
// middleware, ahead of routing and without any Cloudflare env/DB access — which
// lets us exercise it here with a plain NextRequest (no CF context mock).

describe("middleware /help/<slug>.md", () => {
  it("returns the article body as text/markdown with a long cache", async () => {
    const article = HELP_ARTICLES[0];
    const res = await middleware(
      new NextRequest(`https://meetmeatthefair.com/help/${article.slug}.md`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(await res.text()).toBe(article.body);
  });

  it("404s for an unknown help slug", async () => {
    const res = await middleware(
      new NextRequest("https://meetmeatthefair.com/help/does-not-exist.md")
    );
    expect(res.status).toBe(404);
  });
});
