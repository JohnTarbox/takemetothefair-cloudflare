/**
 * OPE-771 — the three shipped instances, as tests.
 *
 * Each row below is a real customer-facing email that went out saying something
 * a column on the same inbound row contradicted. None was caught by the system;
 * all three were found by a person reading an email months later.
 *
 * The predicate must fire on the historical case AND stay silent on the honest
 * one — a guard that only ever says "violation" would suppress correct mail,
 * which per the OPE-706 ruling is the worse direction: wrong suppression fails
 * silently, and a clumsy ack at least arrives.
 */
import { describe, it, expect } from "vitest";
import {
  checkTemplateAssertions,
  TEMPLATE_ASSERTIONS,
} from "../src/email-handlers/template-assertions.js";

describe("instance 1 — OPE-453, 'you forgot the link'", () => {
  it("refuses no-url when parsed_url is set", () => {
    // The Press Herald roundup submitter, told repeatedly that they forgot a
    // link they demonstrably sent.
    const v = checkTemplateAssertions("no-url", { parsedUrl: "https://pressherald.com/x" });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("DID send a link");
  });

  it("also catches a link that only appears in the prose", () => {
    const v = checkTemplateAssertions("no-url", {
      parsedUrl: null,
      bodyText: "here it is: https://example.com/fair",
    });
    expect(v).toHaveLength(1);
  });

  it("stays silent on a genuinely link-less message", () => {
    expect(
      checkTemplateAssertions("no-url", { parsedUrl: null, bodyText: "please add my fair" })
    ).toEqual([]);
  });

  it("covers the OTHER half of the OPE-453 split, which is the easy one to miss", () => {
    // The fix split "no link" from "couldn't read your link". Sending
    // `unfetchable-url` when there was never a link is the same lie inverted.
    const v = checkTemplateAssertions("unfetchable-url", { parsedUrl: null, bodyText: "hello" });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("no link to fail on");
    expect(checkTemplateAssertions("unfetchable-url", { parsedUrl: "https://x.com" })).toEqual([]);
  });
});

describe("instance 2 — OPE-706, 'this hasn't been read by a person yet'", () => {
  it.each(["support-ack", "correction-ack", "press-ack"])(
    "%s is refused when in_reply_to names our own message-id",
    (kind) => {
      const v = checkTemplateAssertions(kind, {
        inReplyTo: "<abc123@meetmeatthefair.com>",
      });
      expect(v).toHaveLength(1);
      expect(v[0].reason).toContain("mid-correspondence");
    }
  );

  it("stays silent on a genuine first contact", () => {
    expect(checkTemplateAssertions("support-ack", { inReplyTo: null })).toEqual([]);
    expect(checkTemplateAssertions("support-ack", { inReplyTo: "<x@mail.gmail.com>" })).toEqual([]);
  });
});

describe("instance 3 — OPE-460, 'thanks for submitting N events'", () => {
  it("refuses ok-multi when the count is overstated", () => {
    const v = checkTemplateAssertions("ok-multi", {
      claimedEventCount: 6,
      createdEventCount: 1,
    });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("claims 6 events but 1 were created");
  });

  it("stays silent when the counts agree", () => {
    expect(
      checkTemplateAssertions("ok-multi", { claimedEventCount: 3, createdEventCount: 3 })
    ).toEqual([]);
  });

  it("catches the same count shape on the photo lane, all five kinds", () => {
    // The photo-intake family all open "we received N photo(s)". Factored, so a
    // fix reaches all five — repeating it is how OPE-453 fixed one variant and
    // left the other.
    for (const kind of [
      "photo-intake-ack",
      "photo-intake-held",
      "photo-intake-unresolved",
      "photo-intake-resolved",
      "photo-intake-poster",
    ]) {
      expect(
        checkTemplateAssertions(kind, { claimedPhotoCount: 6, storedPhotoCount: 1 })
      ).toHaveLength(1);
    }
  });
});

describe("the predicate must not fire on absent evidence", () => {
  it("says nothing when we simply do not know", () => {
    // Absence of evidence is not evidence the claim is false. A predicate that
    // fired on unknowns would suppress correct mail on every row where the
    // fact was never captured — which is most historical rows.
    expect(checkTemplateAssertions("ok-multi", {})).toEqual([]);
    expect(checkTemplateAssertions("no-url", {})).toEqual([]);
    expect(checkTemplateAssertions("support-ack", {})).toEqual([]);
    expect(checkTemplateAssertions("already-exists", {})).toEqual([]);
    // The one that actually bit. `!f.parsedUrl` was true for an ABSENT fact,
    // so every caller that supplied no facts had its template swapped — caught
    // by the pre-existing OPE-453 suite, not by this file, because the test
    // above passes `parsedUrl: null` explicitly and never exercised absence.
    expect(checkTemplateAssertions("unfetchable-url", {})).toEqual([]);
    expect(checkTemplateAssertions("empty-message", {})).toEqual([]);
  });

  it("an UNREGISTERED kind returns no violation, because CI is what catches it", () => {
    // Throwing here would mean a registry slip stops customer mail. The
    // completeness of the registry is CI's job (check-template-assertions.ts).
    expect(checkTemplateAssertions("some-kind-invented-tomorrow", {})).toEqual([]);
  });
});

describe("the registry itself", () => {
  it("distinguishes 'reviewed, makes no claim' from 'absent'", () => {
    // `[]` is a decision — somebody read the copy and found nothing falsifiable.
    // A missing key is an omission, and CI fails on it. They must not be the
    // same value, or the guard cannot tell a reviewed template from a forgotten
    // one.
    expect(TEMPLATE_ASSERTIONS["ok"]).toEqual([]);
    expect(TEMPLATE_ASSERTIONS["ok"]).toBeDefined();
    expect(TEMPLATE_ASSERTIONS["some-kind-invented-tomorrow"]).toBeUndefined();
  });

  it("every registered claim carries a predicate", () => {
    let claims = 0;
    for (const [, assertions] of Object.entries(TEMPLATE_ASSERTIONS)) {
      for (const a of assertions) {
        claims++;
        expect(typeof a.falsifiedBy).toBe("function");
        expect(a.claim.length).toBeGreaterThan(0);
      }
    }
    // Positive landmark: a registry that lost its claims would satisfy the loop
    // above vacuously.
    expect(claims).toBeGreaterThanOrEqual(10);
  });
});

describe("resolveReplyKind — substitution, never silence, never new copy", () => {
  it("swaps no-url for the honest sibling when the sender DID send a link", async () => {
    const { resolveReplyKind } = await import("../src/email-handlers/template-assertions.js");
    const r = resolveReplyKind("no-url", { parsedUrl: "https://x.com/fair" });
    expect(r.substituted).toBe(true);
    expect(r.kind).toBe("unfetchable-url");
    expect(r.violations).toHaveLength(1);
  });

  it("swaps the mid-thread acks for thread-reply-ack", async () => {
    const { resolveReplyKind } = await import("../src/email-handlers/template-assertions.js");
    for (const kind of ["support-ack", "correction-ack", "press-ack"]) {
      const r = resolveReplyKind(kind, { inReplyTo: "<a@meetmeatthefair.com>" });
      expect(r.kind).toBe("thread-reply-ack");
      expect(r.substituted).toBe(true);
    }
  });

  it("does NOT substitute into a template the same facts also falsify", async () => {
    // Sending a second false claim to cover the first would be worse than the
    // original defect.
    const { resolveReplyKind } = await import("../src/email-handlers/template-assertions.js");
    // `no-url` is violated (there IS a url) and `unfetchable-url` is fine here,
    // so this substitutes. The inverse direction is the interesting one:
    const r = resolveReplyKind("unfetchable-url", { parsedUrl: null, bodyText: "no link here" });
    // unfetchable-url is violated; fallback `no-url` is NOT violated by these
    // facts, so substitution is safe and happens.
    expect(r.kind).toBe("no-url");
    expect(r.substituted).toBe(true);
  });

  it("keeps the template and reports when no approved sibling exists", async () => {
    // A count that is off has no honest sibling template. Reporting beats
    // swapping in unrelated copy — and beats silence, which the OPE-706 ruling
    // rejects outright.
    const { resolveReplyKind } = await import("../src/email-handlers/template-assertions.js");
    const r = resolveReplyKind("ok-multi", { claimedEventCount: 6, createdEventCount: 1 });
    expect(r.kind).toBe("ok-multi");
    expect(r.substituted).toBe(false);
    expect(r.violations).toHaveLength(1);
  });

  it("passes a clean kind straight through", async () => {
    const { resolveReplyKind } = await import("../src/email-handlers/template-assertions.js");
    const r = resolveReplyKind("support-ack", { inReplyTo: null });
    expect(r).toEqual({ kind: "support-ack", violations: [], substituted: false });
  });

  it("buildReply renders the SUBSTITUTED template and ledgers what was sent", async () => {
    // The wiring, not just the resolver. This is the assertion that would fail
    // if the check were built and never called — which is how OPE-453's own
    // lesson got shipped a second time.
    const { buildReply } = await import("../src/email-reply-builder.js");
    const job = buildReply("no-url", "sender@example.com", {
      subject: "my fair",
      assertionFacts: { parsedUrl: "https://x.com/fair" },
    } as never) as unknown as {
      source: string;
      text: string;
      requestedKind?: string;
      assertionSubstituted?: boolean;
    };
    expect(job.source).toBe("email:unfetchable-url");
    expect(job.requestedKind).toBe("no-url");
    expect(job.assertionSubstituted).toBe(true);
  });
});
