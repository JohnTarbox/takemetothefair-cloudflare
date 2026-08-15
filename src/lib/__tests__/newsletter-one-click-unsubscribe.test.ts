/**
 * OPE-385 — RFC 8058 one-click unsubscribe on the newsletter rail.
 *
 * The headers are set on the SHARED `enqueueNewsletterDigest` rail rather than
 * in either composer, so both audiences inherit them by construction. These
 * tests pin that: OPE-359's audience bug came from exactly the kind of
 * per-composer duplication this avoids, and OPE-360's from a mapping nothing
 * asserted.
 *
 * The CF-transport question ("does the allowlist accept these headers?") is NOT
 * testable here — it was settled by a real probe send on 2026-08-15 and the
 * verdict recorded in queue-consumers.ts. This file pins the wiring only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueued: Record<string, unknown>[] = [];

vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: vi.fn(async (args: Record<string, unknown>) => {
    enqueued.push(args);
  }),
}));

import { enqueueNewsletterDigest } from "../email/newsletter-broadcast";

const BASE = {
  subject: "This Weekend at the Fair",
  contentHtml: "<p>hi</p>",
  contentText: "hi",
  siteUrl: "https://meetmeatthefair.com",
  secret: "test-secret-value-for-hmac",
  mailingAddress: "PO Box 1, Maine",
  viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/issue-test",
};

beforeEach(() => {
  enqueued.length = 0;
});

describe("OPE-385 — one-click headers on the shared rail", () => {
  it("attaches both headers to every recipient", async () => {
    await enqueueNewsletterDigest({ ...BASE, recipients: ["a@x.com", "b@y.com"] });

    expect(enqueued).toHaveLength(2);
    for (const msg of enqueued) {
      expect(msg.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
      expect(String(msg.listUnsubscribe)).toMatch(
        /^<https:\/\/meetmeatthefair\.com\/api\/newsletter\/unsubscribe\?token=.+>$/
      );
    }
  });

  it("uses the SAME token in the header as in the footer link", async () => {
    // One mechanism, one target. Two tokens would be two things to expire, and
    // a recipient could unsubscribe via one and still receive mail.
    await enqueueNewsletterDigest({ ...BASE, recipients: ["a@x.com"] });

    const msg = enqueued[0];
    const headerToken = String(msg.listUnsubscribe).match(/token=([^>]+)>/)?.[1];
    expect(headerToken).toBeTruthy();
    // The same URL must appear in the rendered body.
    expect(String(msg.text) + String(msg.html)).toContain(headerToken!);
  });

  it("gives each recipient their OWN token", async () => {
    // A shared token would let one person's unsubscribe drop everyone.
    await enqueueNewsletterDigest({ ...BASE, recipients: ["a@x.com", "b@y.com"] });

    const tokens = enqueued.map((m) => String(m.listUnsubscribe).match(/token=([^>]+)>/)?.[1]);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("applies to the VENDOR audience too, not just weekend", async () => {
    // Both audiences enqueue through this one rail. This is the OPE-359
    // regression guard: that bug existed because a per-audience concern was
    // implemented per-composer instead of once, here.
    await enqueueNewsletterDigest({
      ...BASE,
      subject: "New This Week — shows just added (4)",
      source: "newsletter:vendor-digest",
      recipients: ["vendor@x.com"],
    });

    expect(enqueued[0].source).toBe("newsletter:vendor-digest");
    expect(enqueued[0].listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
    expect(String(enqueued[0].listUnsubscribe)).toContain("/api/newsletter/unsubscribe?token=");
  });

  it("wraps the URL in angle brackets, as RFC 2369 requires", async () => {
    // A bare URL is silently ignored by conforming clients — the header would
    // be present and useless, which is the worst of both outcomes.
    await enqueueNewsletterDigest({ ...BASE, recipients: ["a@x.com"] });
    const v = String(enqueued[0].listUnsubscribe);
    expect(v.startsWith("<")).toBe(true);
    expect(v.endsWith(">")).toBe(true);
  });
});
