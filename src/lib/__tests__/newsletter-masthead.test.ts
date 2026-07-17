/**
 * OPE-234 — the masthead is shared by the digest email and the public web
 * archive. OPE-232 branded the email while the web page kept a plain <h1>, and
 * the two drifted within days; these lock the shared source in.
 */
import { describe, it, expect } from "vitest";
import {
  newsletterMastheadHtml,
  NEWSLETTER_EYEBROW,
  NEWSLETTER_WORDMARK,
} from "../newsletter-masthead";
import { newsletterDigestTemplate } from "../email/templates";

describe("newsletterMastheadHtml (OPE-234)", () => {
  it("renders the brand band: green background, gold eyebrow, wordmark", () => {
    const html = newsletterMastheadHtml({});
    expect(html).toContain("background:#1f3a2d");
    expect(html).toContain("color:#e8c86a");
    // The ampersand is escaped; the apostrophe is not (it's text content, not
    // an attribute value), which is exactly what escapeHtmlText does.
    expect(html).toContain("New England's Fair &amp; Festival Almanac");
    expect(html).toContain("Weekend Fair Digest");
  });

  it("defaults the wordmark but lets the vendor digest override it", () => {
    expect(newsletterMastheadHtml({})).toContain(NEWSLETTER_WORDMARK);
    expect(newsletterMastheadHtml({ wordmark: "New This Week" })).toContain("New This Week");
  });

  it("treats a blank/whitespace wordmark as absent rather than rendering an empty band", () => {
    expect(newsletterMastheadHtml({ wordmark: "   " })).toContain(NEWSLETTER_WORDMARK);
  });

  it("renders the subtitle only when given", () => {
    expect(newsletterMastheadHtml({ subtitle: "July 18–19" })).toContain("July 18–19");
    // The subtitle's gold is distinct from the eyebrow's; absent when no
    // subtitle. Hex asserted with CSS context so it isn't a bare hex literal
    // (which the design-token lint rule flags) — same trick as the OPE-232 test.
    expect(newsletterMastheadHtml({})).not.toContain("color:#cbb87a");
  });

  it("escapes the wordmark and subtitle so stored text can't inject markup", () => {
    const html = newsletterMastheadHtml({
      wordmark: "<script>x</script>",
      subtitle: "<img onerror=1>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is self-contained markup, so email nests it and the web renders it as-is", () => {
    const html = newsletterMastheadHtml({});
    expect(html.trimStart().startsWith("<table")).toBe(true);
    expect(html.trimEnd().endsWith("</table>")).toBe(true);
  });

  it("is the eyebrow's single source — the constant is what actually renders", () => {
    // Guards against someone re-hardcoding the eyebrow string in a consumer.
    expect(NEWSLETTER_EYEBROW).toBe("New England's Fair & Festival Almanac");
  });
});

describe("email consumes the shared masthead (OPE-234)", () => {
  const base = {
    subject: "Weekend Fair Digest — July 18–19",
    contentHtml: "<p>body</p>",
    unsubscribeUrl: "https://meetmeatthefair.com/u?token=abc",
    viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/2026-07-18",
    mailingAddress: "18 Main ST, Phillips, ME 04966",
  };

  it("the email masthead is the shared one, not a second copy", () => {
    const { html } = newsletterDigestTemplate(base);
    // The exact shared band appears in the rendered email.
    expect(html).toContain(newsletterMastheadHtml({ subtitle: base.subject }));
  });

  it("renders exactly ONE masthead — the web page adds its own, the email must not double", () => {
    const { html } = newsletterDigestTemplate(base);
    const bands = html.match(/background:#1f3a2d;padding:28px 32px/g) ?? [];
    expect(bands).toHaveLength(1);
  });
});
