/**
 * OPE-1145 — a vendor-form signup was told "Confirm your subscription to This
 * Weekend at the Fair" (received 2026-09-23, Gmail 1a0cf9f4446eb8a1), while
 * confirming correctly put it on the vendor list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newsletterConfirmTemplate } from "@/lib/email/templates";
import { NEWSLETTER_NAME, VENDOR_NEWSLETTER_NAME } from "@/lib/newsletter-masthead";

const URL_ = "https://meetmeatthefair.com/api/newsletter/confirm?token=abc";

describe("newsletterConfirmTemplate names the list confirming will join", () => {
  it("the weekend copy is unchanged when no list is passed (the fallback)", () => {
    expect(newsletterConfirmTemplate({ confirmUrl: URL_ })).toEqual(
      newsletterConfirmTemplate({ confirmUrl: URL_, list: "weekend" })
    );
    expect(newsletterConfirmTemplate({ confirmUrl: URL_ }).subject).toBe(
      `Confirm your subscription to ${NEWSLETTER_NAME}`
    );
  });

  it("a vendor signup is told New This Week — subject, HTML and text — and never the weekend name", () => {
    const t = newsletterConfirmTemplate({ confirmUrl: URL_, list: "vendor" });
    expect(t.subject).toBe(`Confirm your subscription to ${VENDOR_NEWSLETTER_NAME}`);
    for (const part of [t.subject, t.html, t.text]) {
      expect(part).toContain(VENDOR_NEWSLETTER_NAME);
      expect(part).not.toContain(NEWSLETTER_NAME);
    }
    expect(t.text).toContain("taking vendors");
    expect(t.text).toContain(URL_);
  });
});

describe("the subscribe route passes the list (source)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/app/api/newsletter/subscribe/route.ts"),
    "utf8"
  );
  it("derives it with listForSource, preferring the STORED source the confirm path reads", () => {
    expect(src).toMatch(/list: listForSource\(existing\?\.source \?\? source\)/);
  });
});
