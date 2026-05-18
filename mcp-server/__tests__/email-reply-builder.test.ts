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
