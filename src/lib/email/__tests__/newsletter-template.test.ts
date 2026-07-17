/**
 * OPE-232 — the Weekend Fair Digest must render in the NEWSLETTER shell, not
 * the transactional one. These assert the acceptance criteria directly against
 * the produced HTML so a regression to `baseLayout` is caught at build time.
 */
import { describe, it, expect } from "vitest";
import { newsletterDigestTemplate } from "../templates";
import { SOCIAL_LINKS } from "@/lib/social-links";

const base = {
  subject: "Weekend Fair Digest — July 12–13",
  contentHtml: "<p>Fryeburg Fair this weekend</p>",
  unsubscribeUrl: "https://meetmeatthefair.com/api/newsletter/unsubscribe?token=abc",
  viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/2026-07-12",
  mailingAddress: "18 Main St, Phillips, ME 04966",
};

describe("newsletterDigestTemplate — branded shell (OPE-232)", () => {
  const { html, text } = newsletterDigestTemplate(base);

  it("uses the green/gold brand, not the transactional navy/orange", () => {
    // Hex checked with CSS context so these aren't bare-hex literals (which the
    // design-token lint rule flags); the template embeds them the same way.
    expect(html).toContain("background:#1f3a2d"); // masthead green
    expect(html).toContain("color:#e8c86a"); // gold eyebrow
    expect(html).not.toContain(":#1E2761"); // transactional navy
    expect(html).not.toContain(":#E8960C"); // transactional orange
  });

  it("shows the Weekend Fair Digest masthead + almanac eyebrow", () => {
    expect(html).toContain("Weekend Fair Digest");
    expect(html).toContain("New England's Fair &amp; Festival Almanac");
  });

  it("drops the transactional 'if you didn't expect this email' line", () => {
    expect(html).not.toContain("safely ignore");
  });

  it("does not render the subject as a duplicate <h1>", () => {
    expect(html).not.toMatch(/<h1[^>]*>/);
  });

  it("keeps the CAN-SPAM footer: unsubscribe + mailing address + view-in-browser", () => {
    expect(html).toContain(base.unsubscribeUrl);
    expect(html).toContain(base.viewInBrowserUrl);
    expect(html).toContain("18 Main St, Phillips, ME 04966");
    expect(html).toContain("Unsubscribe");
  });

  it("carries the subject through as the dated subtitle and in the text part", () => {
    expect(html).toContain("Weekend Fair Digest — July 12–13");
    expect(text).toContain("Weekend Fair Digest — July 12–13");
    expect(text).toContain(base.unsubscribeUrl);
  });

  it("embeds the caller's content verbatim (callers ship inner body only)", () => {
    expect(html).toContain("<p>Fryeburg Fair this weekend</p>");
  });

  it("lets OPE-191's vendor digest override the wordmark, same shell", () => {
    const vendor = newsletterDigestTemplate({ ...base, wordmark: "New This Week" });
    expect(vendor.html).toContain("New This Week");
    expect(vendor.html).toContain("background:#1f3a2d"); // same branded shell
    expect(vendor.html).not.toContain("safely ignore");
  });

  it("falls back to a region line when no mailing address is given", () => {
    const { html: h } = newsletterDigestTemplate({ ...base, mailingAddress: undefined });
    expect(h).toContain("Meet Me at the Fair, New England");
  });

  it("escapes a wordmark so it can't inject markup", () => {
    const { html: h } = newsletterDigestTemplate({ ...base, wordmark: "<script>x</script>" });
    expect(h).not.toContain("<script>x</script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("newsletterDigestTemplate — social footer (OPE-235)", () => {
  const { html } = newsletterDigestTemplate(base);

  it("shows both Facebook and Instagram, matching last week's issue", () => {
    expect(html).toContain("https://facebook.com/meetmeatthefair");
    expect(html).toContain("https://instagram.com/meet.me.at.the.fair");
    expect(html).toContain(">Facebook</a>");
    expect(html).toContain(">Instagram</a>");
  });

  it("renders every SOCIAL_LINKS entry, so a future platform needs no email edit", () => {
    for (const s of SOCIAL_LINKS) {
      expect(html).toContain(s.href);
    }
  });

  it("uses text links, not inline <svg> — Gmail strips SVG and would show a gap", () => {
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<path");
  });

  it("the vendor digest inherits the same social footer (shared shell)", () => {
    const vendor = newsletterDigestTemplate({ ...base, wordmark: "New This Week" });
    expect(vendor.html).toContain("https://instagram.com/meet.me.at.the.fair");
    expect(vendor.html).toContain("https://facebook.com/meetmeatthefair");
  });
});
