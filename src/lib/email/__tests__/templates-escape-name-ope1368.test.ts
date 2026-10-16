/**
 * OPE-1368 — a user-supplied name is escaped in transactional email HTML.
 *
 * Anyone could register with a victim's address and an HTML `name`; the
 * verification email then carried that markup (links, buttons) to the victim
 * from our own domain. The plain-text part keeps the name verbatim — the copy
 * is unchanged, only the HTML is escaped.
 */
import { describe, it, expect } from "vitest";
import {
  emailVerificationTemplate,
  passwordResetTemplate,
  promoterBlogMentionTemplate,
} from "../templates";

const EVIL = `<a href="https://evil.example/login">Click here to keep your account</a>`;

describe("OPE-1368 — name escaped in email HTML", () => {
  it("verification email escapes name in HTML", () => {
    const t = emailVerificationTemplate({
      verifyUrl: "https://meetmeatthefair.com/v?t=1",
      name: EVIL,
    });
    expect(t.html).not.toContain('<a href="https://evil.example');
    // OPE-1392 — the shared escapeHtml also escapes quotes.
    expect(t.html).toContain("Hi &lt;a href=&quot;https://evil.example/login&quot;&gt;Click here");
    // plain text unchanged
    expect(t.text.startsWith(`Hi ${EVIL},`)).toBe(true);
  });

  it("password reset email escapes name in HTML", () => {
    const t = passwordResetTemplate({ resetUrl: "https://meetmeatthefair.com/r?t=1", name: EVIL });
    expect(t.html).not.toContain('<a href="https://evil.example');
    expect(t.html).toContain("&lt;a href=");
  });

  it("blog mention email escapes promoterName in HTML", () => {
    const t = promoterBlogMentionTemplate({
      promoterName: EVIL,
      postTitle: "Post",
      postUrl: "https://meetmeatthefair.com/blog/p",
      eventName: "Fair",
      eventUrl: "https://meetmeatthefair.com/events/f",
    });
    expect(t.html).not.toContain('<a href="https://evil.example');
    expect(t.html).toContain("&lt;a href=");
  });

  it("an ordinary name renders exactly as before", () => {
    const t = emailVerificationTemplate({ verifyUrl: "https://x/v", name: "Jane Doe" });
    expect(t.html).toContain(`<p style="margin:0 0 12px;">Hi Jane Doe,</p>`);
    const n = emailVerificationTemplate({ verifyUrl: "https://x/v", name: null });
    expect(n.html).toContain(`<p style="margin:0 0 12px;">Hi,</p>`);
  });
});
