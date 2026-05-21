/**
 * Unit tests for B3 confidence-aware reply tier templates + B2 signature
 * stripping. The workflow integration (which decides ok vs ok-medium vs
 * ok-low based on field confidence) is exercised by hand-running the
 * pipeline end-to-end; here we just verify the pure helpers produce
 * sensible text for each tier.
 */

import { describe, it, expect } from "vitest";
import { buildReply, isNameUnsure } from "../src/email-reply-builder.js";
import { stripSignature } from "../src/email-handlers/submit.js";

describe("buildReply — B3 confidence tiers", () => {
  it("ok (HIGH) — current polished pending-review reply", () => {
    const msg = buildReply("ok", "sender@example.com", {
      subject: "Test",
      eventName: "Holiday Fair",
      hasAttachments: false,
    });
    expect(msg.text).toContain('"Holiday Fair"');
    expect(msg.text).toContain("being reviewed");
    expect(msg.text).not.toContain("could not");
    expect(msg.subject.startsWith("Re:")).toBe(true);
  });

  it("ok-medium — captured + asks for confirmation of unsure fields", () => {
    const msg = buildReply("ok-medium", "sender@example.com", {
      subject: "Test",
      eventName: "Holiday Fair",
      unsureFields: "date, venue",
    });
    expect(msg.text).toContain('"Holiday Fair"');
    expect(msg.text).toContain("date, venue");
    expect(msg.text).toContain("speed up the review");
  });

  it("ok-low — asks for date + venue + name + description outright", () => {
    const msg = buildReply("ok-low", "sender@example.com", {
      subject: "Test",
      eventName: "Holiday Fair",
      unsureFields: "event name, date, venue",
    });
    expect(msg.text).toContain("date(s)");
    expect(msg.text).toContain("venue");
    // The low template should be explicit that we need more info, not
    // just say "approved soon".
    expect(msg.text).toContain("more details");
  });

  it("ok-medium with empty unsureFields renders without dangling clause", () => {
    const msg = buildReply("ok-medium", "sender@example.com", {
      subject: "Test",
      eventName: "Holiday Fair",
      unsureFields: "",
    });
    // No "- specifically the " dangling phrase.
    expect(msg.text).not.toContain("specifically the .");
    expect(msg.text).not.toContain("specifically the  ");
  });

  // PR-L: don't quote the AI-extracted name back to the sender when we
  // just flagged event_name as unsure. Reads as contradictory:
  // "Thanks for submitting "Next Business Meeting" ... the event name was
  // hard to pin down". The 2026-05-21 nobarc.org submission flagged this.
  it("ok-medium uses generic opening when event name is unsure", () => {
    const msg = buildReply("ok-medium", "sender@example.com", {
      subject: "Test",
      eventName: "Next Business Meeting", // dubious AI extraction
      unsureFields: "event name, date, venue",
    });
    expect(msg.text).not.toContain(`"Next Business Meeting"`);
    expect(msg.text).toContain("about your event submission");
    // Still names the unsure fields in the clause.
    expect(msg.text).toContain("specifically the event name, date, venue");
  });

  it("ok-medium keeps the quoted name when event name is NOT in unsureFields", () => {
    const msg = buildReply("ok-medium", "sender@example.com", {
      subject: "Test",
      eventName: "Holiday Fair",
      unsureFields: "date, venue", // name not flagged
    });
    expect(msg.text).toContain(`"Holiday Fair"`);
    expect(msg.text).not.toContain("about your event submission");
  });

  it("ok-low uses generic opening when event name is unsure", () => {
    const msg = buildReply("ok-low", "sender@example.com", {
      subject: "Test",
      eventName: "Next Business Meeting",
      unsureFields: "event name, date, venue",
    });
    expect(msg.text).not.toContain(`"Next Business Meeting"`);
    // ok-low's no-name opening still says "Thanks for emailing Meet Me
    // at the Fair!" but drops the "about X" phrase.
    expect(msg.text).toContain("Thanks for emailing Meet Me at the Fair");
    expect(msg.text).not.toContain('about "');
  });

  // PR-M: B1 multi-URL combined reply.
  it("ok-multi summarizes N URL outcomes in a single reply", () => {
    const msg = buildReply("ok-multi", "sender@example.com", {
      subject: "Three URLs",
      eventCount: 3,
      resultsText: [
        '✅ "Event A" — pending review',
        '✅ "Event B" — already in our directory: https://meetmeatthefair.com/events/event-b',
        "❌ Couldn't extract event details from https://example.com/junk",
      ].join("\n"),
      hasAttachments: false,
      overflowed: false,
    });
    expect(msg.text).toContain("Thanks for submitting 3 events");
    expect(msg.text).toContain('"Event A"');
    expect(msg.text).toContain("already in our directory");
    expect(msg.text).toContain("Couldn't extract");
    expect(msg.text).toContain("review pending submissions within 24 hours");
  });

  it("ok-multi includes overflow note when caller flagged overflowed=true", () => {
    const msg = buildReply("ok-multi", "sender@example.com", {
      subject: "Many URLs",
      eventCount: 10,
      resultsText: "...processed list...",
      overflowed: true,
    });
    expect(msg.text).toContain("more than 10 URLs");
    expect(msg.text).toContain("Reply with the remaining URLs");
  });

  it("ok-multi singular wording at eventCount=1 (edge case)", () => {
    // Won't normally happen — workflow falls back to single-URL path
    // when extractAllUrls returns <2 — but the template should still
    // pluralize correctly if it does.
    const msg = buildReply("ok-multi", "sender@example.com", {
      subject: "One URL",
      eventCount: 1,
      resultsText: '✅ "Single Event" — pending review',
    });
    expect(msg.text).toContain("Thanks for submitting 1 event ");
    expect(msg.text).not.toContain("1 events");
  });
});

describe("isNameUnsure", () => {
  it("returns true when 'event name' is in the list", () => {
    expect(isNameUnsure("event name, date, venue")).toBe(true);
  });
  it("returns true when bare 'name' is in the list", () => {
    expect(isNameUnsure("name, date")).toBe(true);
  });
  it("returns true when 'title' is in the list (defensive)", () => {
    expect(isNameUnsure("title, venue")).toBe(true);
  });
  it("returns false when only date/venue are flagged", () => {
    expect(isNameUnsure("date, venue")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isNameUnsure("")).toBe(false);
  });
  it("returns false for unrelated words (doesn't substring-match)", () => {
    // "nameless" would substring-match a naive .includes("name") but
    // \bname\b respects word boundaries.
    expect(isNameUnsure("date, nameless venue")).toBe(false);
  });
});

describe("stripSignature — B2 helper", () => {
  it("cuts at the RFC 3676 '-- ' delimiter", () => {
    const body = `There's a craft fair at Town Hall on December 12.

--
Bob Smith
bob@example.com`;
    expect(stripSignature(body)).toBe("There's a craft fair at Town Hall on December 12.");
  });

  it("cuts at iOS 'Sent from my iPhone' signature", () => {
    const body = `There's a craft fair at Town Hall on December 12.

Sent from my iPhone`;
    expect(stripSignature(body)).toBe("There's a craft fair at Town Hall on December 12.");
  });

  it("cuts at Outlook 'Get Outlook for iOS' signature", () => {
    const body = `There's a craft fair at Town Hall on December 12.

Get Outlook for iOS<https://aka.ms/o0ukef>`;
    expect(stripSignature(body)).toBe("There's a craft fair at Town Hall on December 12.");
  });

  it("does not cut when no signature delimiter present", () => {
    const body = "There's a craft fair at Town Hall on December 12.";
    expect(stripSignature(body)).toBe(body);
  });

  it("does not falsely cut on 'Sent' appearing mid-sentence", () => {
    // The mobile-sig regex is anchored on (^|\n) + "Sent from my ", so
    // text like "He Sent from his phone" mid-prose shouldn't trip it.
    const body = "He Sent from his phone earlier. Event is on Dec 12.";
    expect(stripSignature(body)).toBe(body);
  });

  it("handles both delimiter types together — cuts at the earlier one", () => {
    const body = `Event is on Dec 12.

--
Bob

Sent from my iPhone`;
    // The "-- " delimiter comes first, so the iOS signature line is
    // inside the already-cut region.
    expect(stripSignature(body)).toBe("Event is on Dec 12.");
  });
});
