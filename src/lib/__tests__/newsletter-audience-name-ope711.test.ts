/**
 * OPE-711 — a vendor subscriber must not be told they signed up for the
 * attendee newsletter.
 *
 * Verbatim footer of the vendor issue sent 2026-08-30, as received:
 *
 *   "You're receiving this because you subscribed to This Weekend at the Fair,
 *    the Meet Me at the Fair weekly newsletter."
 *
 * "This Weekend at the Fair" is the ATTENDEE list's name (OPE-285), and John
 * ruled on 2026-08-21 that the two lists are "completely separate". Under
 * OPE-710(a) every vendor issue now flows through this rail, so this stopped
 * being cosmetic on a dying path.
 *
 * ⚠️ The cause was a docblock that lied. `newsletter-masthead.ts` said the
 * vendor digest "overrides" the wordmark. Nothing passed one —
 * `enqueueNewsletterDigest` called the template without it — so BOTH the
 * masthead and the footer rendered the consumer name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newsletterDigestTemplate } from "@/lib/email/templates";
import {
  NEWSLETTER_NAME,
  VENDOR_NEWSLETTER_NAME,
  newsletterNameForAudience,
} from "@/lib/newsletter-masthead";

const base = {
  subject: "New This Week — shows just added (6)",
  contentHtml: "<p>six shows</p>",
  unsubscribeUrl: "https://meetmeatthefair.com/api/newsletter/unsubscribe?token=abc",
  viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/new-this-week-2026-08-30",
};

describe("the footer names the list the recipient is actually on", () => {
  it("a vendor issue never says the attendee list's name", () => {
    const { html, text } = newsletterDigestTemplate({
      ...base,
      wordmark: newsletterNameForAudience("vendor"),
    });
    expect(text).toContain(`you subscribed to ${VENDOR_NEWSLETTER_NAME}`);
    expect(text).not.toContain(NEWSLETTER_NAME);
    expect(html).not.toContain(NEWSLETTER_NAME);
  });

  it("the weekend issue is unchanged", () => {
    // The failure mode to avoid is fixing one audience by breaking the other.
    const { text } = newsletterDigestTemplate({
      ...base,
      wordmark: newsletterNameForAudience("weekend"),
    });
    expect(text).toContain(`you subscribed to ${NEWSLETTER_NAME}`);
  });

  it("an unknown or missing audience falls back to the consumer name", () => {
    // Pre-OPE-711 behaviour, and the safe direction: a vendor mislabelled as
    // attendee is the bug we are fixing, but an ATTENDEE mislabelled as vendor
    // would be a new one.
    expect(newsletterNameForAudience(null)).toBe(NEWSLETTER_NAME);
    expect(newsletterNameForAudience(undefined)).toBe(NEWSLETTER_NAME);
    expect(newsletterNameForAudience("something-new")).toBe(NEWSLETTER_NAME);
    expect(newsletterNameForAudience("vendor")).toBe(VENDOR_NEWSLETTER_NAME);
  });

  it("the unsubscribe URL is untouched by any of this", () => {
    // Explicitly out of scope per the ticket: the token is per-recipient and
    // correct. A rename must not go near it.
    const { text, html } = newsletterDigestTemplate({
      ...base,
      wordmark: VENDOR_NEWSLETTER_NAME,
    });
    expect(text).toContain(base.unsubscribeUrl);
    expect(html).toContain(base.unsubscribeUrl);
  });
});

describe("the vendor route actually passes it (not just that it could)", () => {
  const route = readFileSync(
    join(__dirname, "..", "..", "app", "api", "admin", "newsletter", "vendor-digest", "route.ts"),
    "utf8"
  );
  const rail = readFileSync(join(__dirname, "..", "email", "newsletter-broadcast.ts"), "utf8");

  it("the route sets a wordmark on the enqueue call", () => {
    // The whole defect was a capability nothing used. Asserting the template
    // ACCEPTS a wordmark would have passed for the last three Sundays.
    expect(route).toMatch(/wordmark:\s*newsletterNameForAudience\("vendor"\)/);
  });

  it("the shared rail forwards it to the template", () => {
    expect(rail).toMatch(/wordmark:\s*args\.wordmark/);
  });
});

describe("the Sunday cron is gone", () => {
  const toml = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "wrangler.toml"),
    "utf8"
  );
  const dispatcher = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "src", "index.ts"),
    "utf8"
  );

  it("no weekday cron is registered", () => {
    const crons = /^crons = \[(.*)\]$/m.exec(toml)?.[1] ?? "";
    expect(crons).not.toContain("* 1");
    expect(crons.length).toBeGreaterThan(0); // non-vacuous: we found the line
  });

  it("nothing dispatches on the removed expression", () => {
    expect(dispatcher).not.toMatch(/controller\.cron === "0 11 \* \* 1"/);
  });

  it("records that Cloudflare's weekday 1 is SUNDAY, so nobody re-adds it as Monday", () => {
    // The expression looked like correct Unix cron for Monday and fired Sunday
    // three weeks running. The next person to add a weekday cron will reach for
    // a crontab(5) reference and get it wrong the same way.
    expect(toml).toMatch(/1 = SUNDAY/);
  });
});
