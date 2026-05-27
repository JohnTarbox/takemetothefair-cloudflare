/**
 * Tests for the auto-reply template builder (email-reply-builder.ts).
 * Pure function — no mocks needed.
 *
 * The current ReplyKind union has 8 entries (4 from PR #174's
 * submit-only flow, 4 new ones added in the multi-intent rework).
 * Each kind has its own renderText branch in buildReply().
 */
import { describe, expect, it } from "vitest";
import { buildReply } from "../src/email-reply-builder.js";

describe("buildReply — common shape", () => {
  it("subject is prefixed with Re: and clamped to 200 chars", () => {
    const long = "x".repeat(300);
    const msg = buildReply("ok", "alice@example.com", { subject: long, eventName: "Fryeburg" });
    expect(msg.subject.startsWith("Re: ")).toBe(true);
    expect(msg.subject.length).toBeLessThanOrEqual(200);
  });

  it("source tag matches the reply kind", () => {
    const msg = buildReply("ok", "alice@example.com", { subject: "x", eventName: "y" });
    expect(msg.source).toBe("email:ok");
  });

  it("recipient address is preserved verbatim", () => {
    const msg = buildReply("support-ack", "alice@EXAMPLE.com", { subject: "hi" });
    expect(msg.to).toBe("alice@EXAMPLE.com");
  });

  it("html body escapes user-controlled subject content", () => {
    const msg = buildReply("ok", "a@x.com", {
      subject: "<script>alert(1)</script>",
      eventName: "<b>Boldface Fair</b>",
    });
    expect(msg.html).not.toContain("<b>Boldface");
    expect(msg.html).toContain("&lt;b&gt;Boldface");
  });
});

describe("buildReply — submit-intent kinds (legacy)", () => {
  it("ok includes the event name", () => {
    const msg = buildReply("ok", "a@x.com", {
      subject: "Fryeburg",
      eventName: "Fryeburg Fair 2026",
    });
    expect(msg.text).toContain("Fryeburg Fair 2026");
  });

  it("ok with attachments warns we don't process them", () => {
    const msg = buildReply("ok", "a@x.com", { eventName: "x", hasAttachments: true });
    expect(msg.text).toMatch(/don't process attachments/i);
  });

  it("ok without attachments doesn't mention them", () => {
    const msg = buildReply("ok", "a@x.com", { eventName: "x", hasAttachments: false });
    expect(msg.text).not.toMatch(/attachment/i);
  });

  it("no-url asks the sender to include a link", () => {
    const msg = buildReply("no-url", "a@x.com", { subject: "event idea" });
    expect(msg.text).toMatch(/URL|link/);
  });

  it("no-url-prose-failed asks for structured fields, NOT for a URL (GH #244)", () => {
    // Distinct from "no-url" because the user pasted full event details;
    // the reply should ask for the missing fields rather than "send a link."
    const msg = buildReply("no-url-prose-failed", "a@x.com", {
      subject: "Community Creations craft fair",
      hasAttachments: false,
    });
    expect(msg.text).toMatch(/event name|start date|location|venue/i);
    // Must NOT use the wrong-template "page you linked" phrasing.
    expect(msg.text).not.toMatch(/page you linked/i);
    // Should still mention a link is acceptable as an alternative,
    // since linking the official page is the highest-fidelity path.
    expect(msg.text).toMatch(/link|page/i);
  });

  it("no-url-prose-failed notes attachment-handling when relevant", () => {
    const msg = buildReply("no-url-prose-failed", "a@x.com", {
      subject: "event flyer",
      hasAttachments: true,
    });
    expect(msg.text).toMatch(/flyer image|PDF|attachments/i);
  });

  it("extract-failed mentions the URL that failed", () => {
    const msg = buildReply("extract-failed", "a@x.com", {
      subject: "fair",
      url: "https://broken.example.com/page",
    });
    expect(msg.text).toContain("https://broken.example.com/page");
  });

  it("submit-failed mentions that the team has been notified", () => {
    const msg = buildReply("submit-failed", "a@x.com", { subject: "fair" });
    expect(msg.text).toMatch(/team has been notified|saving it/i);
  });

  it("already-exists with APPROVED match shows the public URL", () => {
    const msg = buildReply("already-exists", "alice@example.com", {
      subject: "Hamfest",
      eventName: "ARRL Maine State Convention & Hamfest",
      eventUrl: "https://meetmeatthefair.com/events/arrl-maine-state-convention-and-hamfest",
      existingEventStatus: "APPROVED",
    });
    expect(msg.text).toContain("ARRL Maine State Convention & Hamfest");
    expect(msg.text).toContain(
      "https://meetmeatthefair.com/events/arrl-maine-state-convention-and-hamfest"
    );
    // Reply must invite the sender to flag corrections — that's the only
    // useful UX path when "we already have this" might still be wrong.
    expect(msg.text).toMatch(/missing or out of date|reply to this thread/i);
  });

  it("already-exists with PENDING match suppresses the (would-404) URL", () => {
    // Public route /events/[slug] returns 404 for PENDING events. Linking
    // them in the auto-reply confuses senders. The reply still ack's the
    // dedup and offers the corrections-reply path.
    const msg = buildReply("already-exists", "alice@example.com", {
      subject: "Test",
      eventName: "Chester Greenwood Day",
      eventUrl: "https://meetmeatthefair.com/events/chester-greenwood-day",
      existingEventStatus: "PENDING",
    });
    expect(msg.text).toContain("Chester Greenwood Day");
    expect(msg.text).not.toContain("https://meetmeatthefair.com/events/");
    expect(msg.text).toMatch(/in review|will go live|24 hours/i);
    expect(msg.text).toMatch(/missing or out of date|reply to this thread/i);
  });

  it("already-exists with CONFIRMED match also shows the public URL", () => {
    const msg = buildReply("already-exists", "alice@example.com", {
      subject: "Show",
      eventName: "Sample Confirmed Event",
      eventUrl: "https://meetmeatthefair.com/events/sample-confirmed",
      existingEventStatus: "CONFIRMED",
    });
    expect(msg.text).toContain("https://meetmeatthefair.com/events/sample-confirmed");
  });

  it("already-exists with missing existingEventStatus defaults to suppressing URL (safe fallback)", () => {
    // Pre-fix callers pass no status; we default to non-public so we never
    // send a 404 link. Worst case is a slightly less helpful reply on
    // APPROVED matches where the status field wasn't plumbed through.
    const msg = buildReply("already-exists", "alice@example.com", {
      subject: "Test",
      eventName: "Some Event",
      eventUrl: "https://meetmeatthefair.com/events/some-event",
    });
    expect(msg.text).toContain("Some Event");
    expect(msg.text).not.toContain("https://meetmeatthefair.com/events/some-event");
  });

  it("already-exists falls back gracefully when no eventName/eventUrl provided", () => {
    // Defensive — if the workflow ever fires this kind without params,
    // the reply must still be readable, not "Good news — we already have
    // undefined in our directory."
    const msg = buildReply("already-exists", "alice@example.com", { subject: "x" });
    expect(msg.text).toContain("this event");
    expect(msg.text).not.toContain("undefined");
  });
});

describe("buildReply — new intent acks", () => {
  it("correction-ack acknowledges receipt of the correction", () => {
    const msg = buildReply("correction-ack", "a@x.com", { subject: "wrong dates" });
    expect(msg.text).toMatch(/correction|team will review/i);
  });

  it("support-ack acknowledges and points at submit@ for events", () => {
    const msg = buildReply("support-ack", "a@x.com", { subject: "question" });
    expect(msg.text).toMatch(/submit@meetmeatthefair\.com/);
  });

  it("press-ack mentions media materials without committing to a URL", () => {
    const msg = buildReply("press-ack", "press@nyt.com", { subject: "media inquiry" });
    expect(msg.text).toMatch(/media materials/i);
    expect(msg.text).not.toMatch(/https?:\/\//); // no URL committed in MVP
  });

  it("unsubscribe-ack confirms removal", () => {
    const msg = buildReply("unsubscribe-ack", "a@x.com", { subject: "stop emailing me" });
    expect(msg.text).toMatch(/unsubscribed|removed/i);
  });
});

describe("buildReply — admin-decision-tailored kinds (waitForEvent flow)", () => {
  it("correction-applied confirms the change went live", () => {
    const msg = buildReply("correction-applied", "a@x.com", { subject: "wrong dates" });
    expect(msg.text).toMatch(/applied|visible on the site/i);
  });

  it("correction-applied includes admin note when provided", () => {
    const msg = buildReply("correction-applied", "a@x.com", {
      subject: "wrong dates",
      note: "Updated end date to Sunday Oct 12.",
    });
    expect(msg.text).toContain("Updated end date to Sunday Oct 12.");
  });

  it("correction-rejected explains the rejection (uses note if given)", () => {
    const msg = buildReply("correction-rejected", "a@x.com", {
      subject: "x",
      note: "We need a source for the new dates.",
    });
    expect(msg.text).toContain("We need a source for the new dates.");
  });

  it("correction-rejected falls back to a help-text suggestion when no note", () => {
    const msg = buildReply("correction-rejected", "a@x.com", { subject: "x" });
    expect(msg.text).toMatch(/source link|official announcement/i);
  });

  it("correction-needs-info uses the note as the request prompt", () => {
    const msg = buildReply("correction-needs-info", "a@x.com", {
      subject: "x",
      note: "Please send the new date range.",
    });
    expect(msg.text).toContain("Please send the new date range.");
  });

  it("press-handled prompts the sender to check for a direct follow-up", () => {
    const msg = buildReply("press-handled", "press@nyt.com", { subject: "media inquiry" });
    expect(msg.text).toMatch(/followed up directly|haven't heard from us/i);
  });

  it("press-needs-info requests outlet/deadline/angle", () => {
    const msg = buildReply("press-needs-info", "press@nyt.com", { subject: "media inquiry" });
    expect(msg.text).toMatch(/outlet|deadline|angle/i);
  });
});

describe("buildReply — submission-approved (post-review notification)", () => {
  it("source tag is email:submission-approved (used for reply-attribution rollups)", () => {
    const msg = buildReply("submission-approved", "alice@example.com", {
      subject: "Hamfest",
      eventName: "ARRL Maine Hamfest",
    });
    expect(msg.source).toBe("email:submission-approved");
  });

  it("includes the event name in the body", () => {
    const msg = buildReply("submission-approved", "alice@example.com", {
      subject: "Hamfest",
      eventName: "ARRL Maine State Convention & Hamfest",
      eventUrl: "https://meetmeatthefair.com/events/arrl-maine-hamfest",
    });
    expect(msg.text).toContain("ARRL Maine State Convention & Hamfest");
  });

  it("includes the live-listing URL when provided", () => {
    const msg = buildReply("submission-approved", "alice@example.com", {
      subject: "x",
      eventName: "Fryeburg Fair 2026",
      eventUrl: "https://meetmeatthefair.com/events/fryeburg-fair-2026",
    });
    expect(msg.text).toContain("https://meetmeatthefair.com/events/fryeburg-fair-2026");
  });

  it("uses generic phrasing about edits during review (covers the common 'admin fixed dates' case)", () => {
    // The whole point of this template is that we don't commit to "nothing
    // was changed" — admins routinely adjust dates/venue/categories before
    // approving. Sender must be invited to check the listing and reply
    // with corrections.
    const msg = buildReply("submission-approved", "alice@example.com", {
      subject: "x",
      eventName: "Fryeburg",
      eventUrl: "https://meetmeatthefair.com/events/fryeburg",
    });
    expect(msg.text).toMatch(/some details may have been adjusted|check the listing/i);
    expect(msg.text).toMatch(/reply to this thread|correction/i);
  });

  it("falls back gracefully when eventName/eventUrl are absent", () => {
    // Defensive — if a future call site forgets to pass params, the reply
    // must still be readable rather than 'has been approved and is now live'
    // with no subject.
    const msg = buildReply("submission-approved", "alice@example.com", { subject: "x" });
    expect(msg.text).toContain("your event");
    expect(msg.text).not.toContain("undefined");
  });
});
