/**
 * OPE-453 — we told a contributor they forgot the link they had sent.
 *
 * One inbound email recorded two mutually exclusive facts: `parsed_url` held
 * `https://share.google/JAFhqhevUuDYKe2Eu`, and the delivered reply read
 * "We couldn't find a link to the event in your message." (Wording confirmed
 * from the real `email_send_ledger` row, not inferred from the kind.)
 *
 * The mechanism is a deliberate override that outgrew its blast radius:
 *
 *     const noUrlOrFreeText = !rowSnapshot.parsedUrl || isFreeText;
 *
 * GH #244 added the `isFreeText` half so a signature/footer link wouldn't drag
 * a prose submission down the fetch path. Right for ROUTING — but the branch's
 * reply copy asserts the link doesn't exist, and for that half there demonstrably
 * IS one.
 *
 * The system already knew: the same branch writes
 * `extract_fail_reason: 'no-fetchable-url'` to telemetry while telling the
 * sender the opposite. The fact was computed and stored; only the copy lied.
 */
import { describe, expect, it } from "vitest";
import {
  chooseNoUrlReplyKind,
  violatesNoUrlInvariant,
} from "../src/email-handlers/no-url-reply-kind.js";
import { buildReply } from "../src/email-reply-builder.js";

const SPECIMEN_URL = "https://share.google/JAFhqhevUuDYKe2Eu";

describe("the reported specimen", () => {
  it("no longer chooses 'no-url' when a URL was parsed", () => {
    expect(chooseNoUrlReplyKind({ parsedUrl: SPECIMEN_URL, attemptedProse: false })).toBe(
      "unfetchable-url"
    );
  });

  it("chooses unfetchable-url even when prose extraction was also attempted", () => {
    // The free_text override is exactly the path that produced the defect, and
    // it always sets attemptedProse. If `attemptedProse` were tested first,
    // the row would land on `no-url-prose-failed` — whose copy is equally false
    // when a URL is present.
    expect(chooseNoUrlReplyKind({ parsedUrl: SPECIMEN_URL, attemptedProse: true })).toBe(
      "unfetchable-url"
    );
  });
});

describe("the honest cases still get the honest copy", () => {
  it("no URL and no prose attempt → no-url", () => {
    expect(chooseNoUrlReplyKind({ parsedUrl: null, attemptedProse: false })).toBe("no-url");
  });

  it("no URL but prose was attempted → no-url-prose-failed", () => {
    expect(chooseNoUrlReplyKind({ parsedUrl: null, attemptedProse: true })).toBe(
      "no-url-prose-failed"
    );
  });

  it.each([undefined, null, "", "   "])("treats %p as no URL", (v) => {
    // A whitespace-only parsed_url must not silently promote a genuine
    // no-link submission into "we tried your link", which would be its own lie.
    expect(chooseNoUrlReplyKind({ parsedUrl: v as string | null, attemptedProse: false })).toBe(
      "no-url"
    );
  });
});

describe("the invariant predicate", () => {
  it("flags both no-url-family kinds paired with a URL", () => {
    expect(violatesNoUrlInvariant("no-url", SPECIMEN_URL)).toBe(true);
    expect(violatesNoUrlInvariant("no-url-prose-failed", SPECIMEN_URL)).toBe(true);
  });

  it("does not flag the honest pairings", () => {
    expect(violatesNoUrlInvariant("no-url", null)).toBe(false);
    expect(violatesNoUrlInvariant("no-url-prose-failed", null)).toBe(false);
    expect(violatesNoUrlInvariant("unfetchable-url", SPECIMEN_URL)).toBe(false);
  });

  it("ignores unrelated reply kinds entirely", () => {
    // The guard runs before EVERY send, so a false positive here would
    // downgrade a perfectly good 'ok' reply into an error path.
    for (const k of ["ok", "ok-multi", "already-exists", "empty-message", null, undefined]) {
      expect(violatesNoUrlInvariant(k, SPECIMEN_URL)).toBe(false);
    }
  });
});

describe("the replacement copy", () => {
  const render = (params: Record<string, unknown>) =>
    buildReply("unfetchable-url", "someone@example.com", params as never).text;

  it("does not accuse the sender of omitting anything", () => {
    const text = render({ subject: "Events this week", attemptedUrl: SPECIMEN_URL });
    // The exact sentence that went out 8 times to one sender.
    expect(text).not.toContain("couldn't find a link");
    expect(text).not.toMatch(/didn'?t include/i);
  });

  it("names the URL we actually tried, so they can see we had it", () => {
    expect(render({ subject: "x", attemptedUrl: SPECIMEN_URL })).toContain(SPECIMEN_URL);
  });

  it("asks for the destination page, not for a link they already sent", () => {
    const text = render({ subject: "x", attemptedUrl: SPECIMEN_URL });
    expect(text).toMatch(/event's own page/i);
  });

  it("still renders when no URL was threaded through", () => {
    // The guard's downgrade path may fire without attemptedUrl if the row read
    // races; the copy must not emit a dangling "The link we tried was:".
    const text = render({ subject: "x" });
    expect(text).not.toContain("The link we tried was");
    expect(text.length).toBeGreaterThan(50);
  });

  it("is a different message from no-url", () => {
    const a = render({ subject: "x", attemptedUrl: SPECIMEN_URL });
    const b = buildReply("no-url", "someone@example.com", { subject: "x" } as never).text;
    expect(a).not.toBe(b);
  });
});
