/**
 * OPE-1392 (TPL-1) — the public issue page sanitizes the stored body at RENDER.
 *
 * The write-side sanitizer only covers rows written after it shipped; the page
 * reads `newsletter_issues.html` straight from D1 and hands it to
 * dangerouslySetInnerHTML. A hostile row already in the table must render
 * inert, and a normal row must render exactly as it did.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

let issueRow: Record<string, unknown> | null = null;

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (issueRow ? [issueRow] : []) }) }),
    }),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/newsletter/newsletter-signup-block", () => ({
  NewsletterSignupBlock: () => null,
}));

const mod = await import("../page");
const Page = mod.default as (p: { params: Promise<{ slug: string }> }) => Promise<ReactElement>;

async function articleHtml(): Promise<string> {
  const markup = renderToStaticMarkup(await Page({ params: Promise.resolve({ slug: "i" }) }));
  const m = /<article class="p-6 sm:p-8">([\s\S]*?)<\/article>/.exec(markup);
  if (!m) throw new Error("no article in markup");
  return m[1];
}

const SENT = {
  slug: "i",
  subject: "This Weekend at the Fair",
  sentAt: new Date("2026-10-16T00:00:00Z"),
  audience: "weekend",
};

beforeEach(() => {
  issueRow = null;
});

describe("OPE-1392 — /newsletter/[slug] renders the stored body sanitized", () => {
  it("a hostile stored row renders inert", async () => {
    issueRow = {
      ...SENT,
      html:
        "<p>Fair</p><script>alert(document.cookie)</script>" +
        '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">go</a>' +
        '<svg onload="alert(1)"></svg></article><div class="fixed inset-0">x</div>',
    };
    const html = await articleHtml();
    expect(html).toBe("<p>Fair</p><img><a>go</a><div>x</div>");
  });

  it("a normal stored row renders byte-for-byte as before", async () => {
    const body =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="padding:8px;"><a href="https://meetmeatthefair.com/events/x" style="color:#1f3a2d;">' +
      "Fair &amp; Expo</a> &middot; Sat</td></tr></table>";
    issueRow = { ...SENT, html: body };
    expect(await articleHtml()).toBe(body);
  });
});
