/**
 * Pure-function tests for the inbound email intent router.
 * No I/O, no mocks.
 */
import { describe, expect, it } from "vitest";
import { looksLikeGscMilestone } from "../src/email-handler.js";
import {
  isPhotoOnlySubmission,
  resolveIntent,
  shouldForwardToAdmin,
  toWorkflowIntent,
} from "../src/email-intents.js";

describe("resolveIntent — recognized addresses", () => {
  it("submit@ → submit", () => {
    expect(resolveIntent("submit@meetmeatthefair.com")).toBe("submit");
  });
  it("corrections@ → correction", () => {
    expect(resolveIntent("corrections@meetmeatthefair.com")).toBe("correction");
  });
  it("support@ → support", () => {
    expect(resolveIntent("support@meetmeatthefair.com")).toBe("support");
  });
  it("hello@ → support (same intent as support@)", () => {
    expect(resolveIntent("hello@meetmeatthefair.com")).toBe("support");
  });
  it("press@ → press", () => {
    expect(resolveIntent("press@meetmeatthefair.com")).toBe("press");
  });
  it("unsubscribe@ → unsubscribe", () => {
    expect(resolveIntent("unsubscribe@meetmeatthefair.com")).toBe("unsubscribe");
  });
});

describe("resolveIntent — normalization", () => {
  it("uppercase recipient address", () => {
    expect(resolveIntent("SUBMIT@meetmeatthefair.com")).toBe("submit");
  });
  it("mixed-case", () => {
    expect(resolveIntent("Corrections@MeetMeAtTheFair.com")).toBe("correction");
  });
  it("surrounding whitespace", () => {
    expect(resolveIntent("  submit@meetmeatthefair.com  ")).toBe("submit");
  });
});

describe("resolveIntent — unknown / catch-all", () => {
  it("never-configured @meetmeatthefair address falls through", () => {
    expect(resolveIntent("billing@meetmeatthefair.com")).toBe("unknown");
  });
  it("wrong domain falls through", () => {
    expect(resolveIntent("submit@example.com")).toBe("unknown");
  });
  it("empty string falls through", () => {
    expect(resolveIntent("")).toBe("unknown");
  });
  it("malformed address falls through", () => {
    expect(resolveIntent("not-an-email")).toBe("unknown");
  });
});

describe("shouldForwardToAdmin", () => {
  it("submit does NOT forward (events land in D1 for admin review)", () => {
    expect(shouldForwardToAdmin("submit")).toBe(false);
  });
  it("correction forwards", () => {
    expect(shouldForwardToAdmin("correction")).toBe(true);
  });
  it("support forwards", () => {
    expect(shouldForwardToAdmin("support")).toBe(true);
  });
  it("press forwards", () => {
    expect(shouldForwardToAdmin("press")).toBe(true);
  });
  it("unsubscribe forwards (so admin sees opt-outs)", () => {
    expect(shouldForwardToAdmin("unsubscribe")).toBe(true);
  });
  it("unknown forwards (catch-all goes to admin)", () => {
    expect(shouldForwardToAdmin("unknown")).toBe(true);
  });
});

describe("toWorkflowIntent — classifier → workflow dispatch mapping", () => {
  it("legacy values pass through unchanged", () => {
    expect(toWorkflowIntent("submit")).toBe("submit");
    expect(toWorkflowIntent("correction")).toBe("correction");
    expect(toWorkflowIntent("support")).toBe("support");
    expect(toWorkflowIntent("press")).toBe("press");
    expect(toWorkflowIntent("unsubscribe")).toBe("unsubscribe");
    expect(toWorkflowIntent("unknown")).toBe("unknown");
  });
  it("new_event collapses to submit (same pipeline)", () => {
    expect(toWorkflowIntent("new_event")).toBe("submit");
  });
  it("source_suggestion routes through correction handler", () => {
    expect(toWorkflowIntent("source_suggestion")).toBe("correction");
  });
  it("claim_request routes through correction handler", () => {
    expect(toWorkflowIntent("claim_request")).toBe("correction");
  });
  it("vendor_inquiry routes through support handler", () => {
    expect(toWorkflowIntent("vendor_inquiry")).toBe("support");
  });
  it("spam/unclear/multi route to unknown (admin triage)", () => {
    expect(toWorkflowIntent("spam")).toBe("unknown");
    expect(toWorkflowIntent("unclear")).toBe("unknown");
    expect(toWorkflowIntent("multi")).toBe("unknown");
  });
});

/**
 * OPE-315 — a photo-only mail is a photo submission whatever address it
 * arrived at. The live case: two booth photos mailed to submit@ with no body.
 * The event-extraction lane tried to read prose that wasn't there, failed
 * `no-url-prose-failed`, and replied "couldn't pull out key fields" — while
 * the photo-intake lane sat unused because it is keyed to photos@.
 */
describe("isPhotoOnlySubmission (OPE-315)", () => {
  const img = { mimeType: "image/jpeg" };

  it("recognises the live case: images, empty body", () => {
    expect(isPhotoOnlySubmission({ attachments: [img, img], bodyText: "" })).toBe(true);
    expect(isPhotoOnlySubmission({ attachments: [img], bodyText: null })).toBe(true);
  });

  it("sees through phone signatures and stray whitespace", () => {
    // Phone mail is never literally empty — this is what "no body" looks like
    // in practice, and treating it as prose is what produced the rejection.
    expect(
      isPhotoOnlySubmission({ attachments: [img], bodyText: "\n\n Sent from my iPhone\n" })
    ).toBe(true);
    expect(isPhotoOnlySubmission({ attachments: [img], bodyText: "   \n\t  " })).toBe(true);
  });

  it("does NOT hijack a mail that actually says something", () => {
    // The sender wrote a real submission and attached a poster — the
    // extraction lane must still get it.
    expect(
      isPhotoOnlySubmission({
        attachments: [img],
        bodyText:
          "Please add the Cheshire Fair, August 5-9 at the fairgrounds in Swanzey NH. Gates at 9am.",
      })
    ).toBe(false);
  });

  it("does NOT treat a PDF-only mail as photos — posters belong to submit", () => {
    expect(
      isPhotoOnlySubmission({ attachments: [{ mimeType: "application/pdf" }], bodyText: "" })
    ).toBe(false);
  });

  it("requires an attachment at all", () => {
    expect(isPhotoOnlySubmission({ attachments: [], bodyText: "" })).toBe(false);
    expect(isPhotoOnlySubmission({ attachments: null, bodyText: "" })).toBe(false);
  });

  it("takes a mixed mail with any image as photo-only when there is no body", () => {
    expect(
      isPhotoOnlySubmission({
        attachments: [{ mimeType: "application/pdf" }, img],
        bodyText: "",
      })
    ).toBe(true);
  });
});

/**
 * OPE-311 — GSC milestone pre-filter. Deliberately loose: the authoritative
 * parse lives in the main app's parseGscMilestoneEmail, so a false positive
 * costs one no-op request while a false negative loses a milestone date we
 * cannot reconstruct later.
 */
describe("looksLikeGscMilestone (OPE-311)", () => {
  it("matches mail straight from Google, whatever the subject", () => {
    expect(looksLikeGscMilestone("sc-noreply@google.com", "Search Console update")).toBe(true);
    expect(looksLikeGscMilestone("SC-NoReply@Google.com", "anything")).toBe(true);
  });

  it("matches a human-forwarded copy by subject shape", () => {
    // Forwarding rewrites From but keeps the subject — this is how the 7K
    // milestone actually reached us.
    expect(
      looksLikeGscMilestone("john@pimboat.com", "Fwd: Congrats on reaching 7K clicks in 28 days!")
    ).toBe(true);
    expect(
      looksLikeGscMilestone("someone@example.com", "reaching 10,000 impressions in 28 days")
    ).toBe(true);
  });

  it("ignores ordinary mail", () => {
    expect(looksLikeGscMilestone("vendor@example.com", "Please add our craft fair")).toBe(false);
    expect(looksLikeGscMilestone("john@pimboat.com", "clicks are up this week")).toBe(false);
  });
});

/**
 * OPE-317 — subscribe@ is a dedicated signup address John hands out at shows.
 */
describe("subscribe@ routing (OPE-317)", () => {
  it("routes to newsletter_subscribe", () => {
    expect(resolveIntent("subscribe@meetmeatthefair.com")).toBe("newsletter_subscribe");
    expect(resolveIntent("SUBSCRIBE@MeetMeAtTheFair.com")).toBe("newsletter_subscribe");
  });

  it("is NOT forwarded to admin", () => {
    // The sender gets their confirmation email server-side; forwarding every
    // show-floor signup to the admin inbox would rebuild the noise the alert
    // diet (OPE-308) just removed.
    expect(shouldForwardToAdmin("newsletter_subscribe")).toBe(false);
  });

  it("does not disturb the neighbouring unsubscribe address", () => {
    // One character apart in practice, opposite meanings — worth pinning.
    expect(resolveIntent("unsubscribe@meetmeatthefair.com")).toBe("unsubscribe");
  });

  it("passes through toWorkflowIntent unchanged", () => {
    // It has its own handler; collapsing it to "unknown" would reply
    // "we couldn't understand this" to someone who just signed up.
    expect(toWorkflowIntent("newsletter_subscribe")).toBe("newsletter_subscribe");
  });
});
