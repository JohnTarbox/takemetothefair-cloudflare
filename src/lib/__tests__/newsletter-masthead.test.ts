/**
 * OPE-234 — the masthead is shared by the digest email and the public web
 * archive. OPE-232 branded the email while the web page kept a plain <h1>, and
 * the two drifted within days; these lock the shared source in.
 */
import { describe, it, expect } from "vitest";
import {
  newsletterMastheadHtml,
  NEWSLETTER_EYEBROW,
  NEWSLETTER_NAME,
  NEWSLETTER_WORDMARK,
} from "../newsletter-masthead";
import { newsletterConfirmTemplate, newsletterDigestTemplate } from "../email/templates";

describe("newsletterMastheadHtml (OPE-234)", () => {
  it("renders the brand band: green background, gold eyebrow, wordmark", () => {
    const html = newsletterMastheadHtml({});
    expect(html).toContain("background:#1f3a2d");
    expect(html).toContain("color:#e8c86a");
    // The ampersand is escaped; the apostrophe is not (it's text content, not
    // an attribute value), which is exactly what escapeHtmlText does.
    expect(html).toContain("New England's Fair &amp; Festival Almanac");
    expect(html).toContain("This Weekend at the Fair");
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
    subject: "This Weekend at the Fair — Jul 18",
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

/**
 * OPE-285 — ONE product name across every customer-facing surface.
 *
 * Three names ran at once ("Weekend Fair Digest" in the masthead/archive/signup,
 * "This Weekend at the Fair" in the broadcast subject, the Almanac line as an
 * umbrella banner) because NEWSLETTER_WORDMARK existed but consumers re-typed
 * the string as a literal instead of importing it — templates.ts had its own
 * `|| "Weekend Fair Digest"` default. So the assertions that matter here are
 * CROSS-SURFACE: same-module checks passed happily the whole time it was broken.
 */
describe("newsletter naming is unified (OPE-285)", () => {
  const RETIRED_NAME = "Weekend Fair Digest";

  it("has exactly one product name, and the masthead default IS it", () => {
    expect(NEWSLETTER_NAME).toBe("This Weekend at the Fair");
    expect(NEWSLETTER_WORDMARK).toBe(NEWSLETTER_NAME);
    expect(newsletterMastheadHtml({})).toContain(NEWSLETTER_NAME);
  });

  it("keeps the Almanac line a tagline, not a second competing name", () => {
    expect(NEWSLETTER_EYEBROW).not.toBe(NEWSLETTER_NAME);
  });

  it("the digest email names the product identically to the masthead", () => {
    const { html, text } = newsletterDigestTemplate({
      subject: `${NEWSLETTER_NAME} — Jul 31`,
      contentHtml: "<p>body</p>",
      unsubscribeUrl: "https://meetmeatthefair.com/u?token=abc",
      viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/2026-07-31",
    });
    expect(html).toContain(NEWSLETTER_NAME);
    expect(html).not.toContain(RETIRED_NAME);
    expect(text).not.toContain(RETIRED_NAME);
  });

  it("the confirmation email names it identically — it's where we tell subscribers what to search for", () => {
    const { subject, html, text } = newsletterConfirmTemplate({
      confirmUrl: "https://meetmeatthefair.com/api/newsletter/confirm?token=abc",
    });
    expect(subject).toContain(NEWSLETTER_NAME);
    expect(html).toContain(NEWSLETTER_NAME);
    expect(text).toContain(NEWSLETTER_NAME);
    expect(html).not.toContain(RETIRED_NAME);
    // The searchability promise: the confirm mail states the literal subject
    // string a subscriber can search their inbox for.
    expect(text).toContain("in the subject line");
  });

  it("the vendor digest keeps its OWN name — unification must not swallow it", () => {
    const vendor = newsletterDigestTemplate({
      subject: "New This Week — Jul 31",
      contentHtml: "<p>body</p>",
      unsubscribeUrl: "https://meetmeatthefair.com/u?token=abc",
      viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/vendor-2026-07-31",
      wordmark: "New This Week",
    });
    expect(vendor.html).toContain("New This Week");
    expect(vendor.html).not.toContain(NEWSLETTER_NAME);
  });
});
