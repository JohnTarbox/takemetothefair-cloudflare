/**
 * OPE-1392 — the email-side halves of the ticket:
 *
 *  - TPL-1: `newsletterDigestTemplate` (the one renderer the send, approve and
 *    vendor-digest paths share) sanitizes the issue body, so a row stored
 *    before the write-side sanitizer cannot reach an inbox unsanitized — and
 *    the site-built vendor digest survives that sanitizer unchanged.
 *  - TPL-2: user-derived subjects lose CR/LF.
 *  - TPL-3: the stale-red operator digest escapes the signal title.
 *  - TPL-5: one quote-escaping helper; `cta.url` is escaped in the href.
 */
import { describe, it, expect } from "vitest";
import {
  claimDecisionTemplate,
  newsletterDigestTemplate,
  passwordResetTemplate,
  promoterBlogMentionTemplate,
  vendorClaimConfirmationTemplate,
  vendorClaimVerificationTemplate,
} from "@/lib/email/templates";
import { renderVendorDigestContent, type VendorDigestEvent } from "@/lib/email/vendor-digest";
import { formatStaleRedDigest, type StaleRed } from "@/lib/cpi/stale-reds";

const digest = (contentHtml: string) =>
  newsletterDigestTemplate({
    subject: "This Weekend at the Fair — Oct 16",
    contentHtml,
    unsubscribeUrl: "https://meetmeatthefair.com/api/newsletter/unsubscribe?token=t",
    viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/x",
  });

describe("TPL-1 — newsletterDigestTemplate sanitizes the issue body", () => {
  it("drops script, event handlers, javascript: hrefs and svg from the body", () => {
    const { html, text } = digest(
      "<p>Fair</p><script>alert(1)</script>" +
        '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">go</a>' +
        '<svg onload="alert(1)"></svg>'
    );
    expect(html).toContain("<p>Fair</p><img><a>go</a>");
    expect(html).not.toMatch(/<script|onerror|javascript:|<svg|onload/i);
    expect(text).not.toContain("alert(1)");
  });

  it("the site-built vendor digest survives the sanitizer unchanged", () => {
    const ev: VendorDigestEvent = {
      name: "Fryeburg Fair & Expo",
      slug: "fryeburg-fair",
      startDate: new Date("2026-10-04T00:00:00Z"),
      endDate: null,
      datesUnconfirmed: false,
      categories: ["Agricultural", "Craft"],
      commercialVendorsAllowed: true,
      estimatedAttendance: 150000,
      eventScale: "MAJOR",
      indoorOutdoor: "OUTDOOR",
      applicationUrl: "https://apply.example/booths?a=1&b=2",
      sourceUrl: null,
      promoterWebsite: null,
    };
    const body = renderVendorDigestContent(
      [ev, { ...ev, slug: "b", name: "B" }],
      new Date("2026-07-16T12:00:00Z")
    )!;
    const { html } = digest(body);
    expect(html).toContain(body.replace(/<!--[\s\S]*?-->/g, ""));
  });
});

describe("TPL-5 — one quote-escaping helper; cta.url escaped", () => {
  it("escapes a quote in the CTA href so it cannot break out of the attribute", () => {
    const { html } = passwordResetTemplate({
      resetUrl: 'https://meetmeatthefair.com/reset?token=a"onmouseover="alert(1)',
      name: null,
    });
    expect(html).toContain(
      'href="https://meetmeatthefair.com/reset?token=a&quot;onmouseover=&quot;alert(1)"'
    );
    expect(html).not.toContain('"onmouseover="');
  });

  it("a normal CTA url is unchanged", () => {
    const { html } = passwordResetTemplate({
      resetUrl: "https://meetmeatthefair.com/reset-password?token=abc123",
      name: "Pat",
    });
    expect(html).toContain('href="https://meetmeatthefair.com/reset-password?token=abc123"');
  });

  it("escapes quotes in user-supplied names (was & < > only)", () => {
    const v = vendorClaimVerificationTemplate({
      businessName: `Bob's "Best" <Pies>`,
      verifyUrl: "https://meetmeatthefair.com/v",
    });
    expect(v.html).toContain("<strong>Bob&#39;s &quot;Best&quot; &lt;Pies&gt;</strong>");
    const c = claimDecisionTemplate({
      entityName: "<img src=x onerror=alert(1)>",
      decision: "rejected",
      reason: '"><script>alert(1)</script>',
    });
    expect(c.html).not.toMatch(/<img src=x|<script/);
    const b = promoterBlogMentionTemplate({
      promoterName: null,
      postTitle: "T",
      postUrl: 'https://meetmeatthefair.com/blog/t"x',
      eventName: "E",
      eventUrl: "https://meetmeatthefair.com/events/e",
    });
    expect(b.html).toContain('href="https://meetmeatthefair.com/blog/t&quot;x"');
  });
});

describe("TPL-2 — user-derived subjects lose CR/LF; clean ones are unchanged", () => {
  it("strips CR/LF from every templated subject", () => {
    const evil = "Acme\r\nBcc: victim@example.com";
    const subjects = [
      vendorClaimVerificationTemplate({ businessName: evil, verifyUrl: "https://x.test" }).subject,
      vendorClaimConfirmationTemplate({
        businessName: evil,
        vendorSlug: "a",
        siteUrl: "https://x.test",
      }).subject,
      promoterBlogMentionTemplate({
        promoterName: null,
        postTitle: evil,
        postUrl: "https://x.test",
        eventName: evil,
        eventUrl: "https://x.test",
      }).subject,
      claimDecisionTemplate({ entityName: evil, decision: "approved" }).subject,
      claimDecisionTemplate({ entityName: evil, decision: "rejected" }).subject,
      newsletterDigestTemplate({
        subject: evil,
        contentHtml: "<p>x</p>",
        unsubscribeUrl: "https://x.test/u",
        viewInBrowserUrl: "https://x.test/v",
      }).subject,
    ];
    for (const s of subjects) {
      expect(s).not.toMatch(/[\r\n]/);
      expect(s).toContain("Acme Bcc: victim@example.com");
    }
  });

  it("customer-facing subject copy is unchanged for a normal name", () => {
    expect(
      vendorClaimVerificationTemplate({ businessName: "Bob's Pies", verifyUrl: "https://x.test" })
        .subject
    ).toBe("Confirm your claim of Bob's Pies");
    expect(claimDecisionTemplate({ entityName: "Bob's Pies", decision: "rejected" }).subject).toBe(
      "Your claim for Bob's Pies wasn't approved"
    );
  });
});

describe("TPL-3 — the stale-red digest escapes the signal title", () => {
  const red = (title: string): StaleRed => ({
    priority: "P0",
    title,
    refKey: "k",
    href: "/admin/x",
    firstDetectedAt: "2026-10-01T00:00:00Z",
    hoursInRed: 30,
  });

  it("a title carrying markup renders as text", () => {
    const { html, text } = formatStaleRedDigest(
      [red('/events/<img src=x onerror=alert(1)> TypeError "x"')],
      "https://meetmeatthefair.com"
    );
    expect(html).toContain("/events/&lt;img src=x onerror=alert(1)&gt; TypeError &quot;x&quot;");
    expect(html).not.toContain("<img");
    // The text part is plain text — unchanged.
    expect(text).toContain('/events/<img src=x onerror=alert(1)> TypeError "x"');
  });
});
