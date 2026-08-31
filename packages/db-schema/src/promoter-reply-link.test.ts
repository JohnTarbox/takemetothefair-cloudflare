import { describe, it, expect } from "vitest";
import {
  linkPromoterReply,
  normalizeEmailAddress,
  parseMessageIds,
  type ReplyLinkCandidate,
} from "./promoter-reply-link";

const SENT = new Date("2026-06-01T12:00:00Z");
const REPLY = new Date("2026-06-03T09:00:00Z");

const candidate = (over: Partial<ReplyLinkCandidate> = {}): ReplyLinkCandidate => ({
  attemptId: "a1",
  eventId: "evt-1",
  toAddress: "info@dartmouthgrange.org",
  sentAt: SENT,
  providerMessageIds: ["msg-1@resend"],
  ...over,
});

describe("normalizeEmailAddress", () => {
  it("pulls the address out of a display-name From header", () => {
    // The organizer whose client adds a display name is exactly the organizer
    // we most want to hear from; raw comparison would drop them.
    expect(normalizeEmailAddress('"Jane Doe" <Jane@Grange.ORG>')).toBe("jane@grange.org");
  });

  it("accepts a bare address and lowercases it", () => {
    expect(normalizeEmailAddress("  INFO@Grange.org ")).toBe("info@grange.org");
  });

  it("returns null for something that is not an address", () => {
    expect(normalizeEmailAddress("undisclosed-recipients")).toBeNull();
    expect(normalizeEmailAddress(null)).toBeNull();
  });
});

describe("parseMessageIds", () => {
  it("reads both In-Reply-To and the whole References chain", () => {
    // References accumulates the thread, so a reply to our FOLLOW-UP still
    // carries the first ask's id — which is how a threaded conversation stays
    // attached to the ask that started it.
    expect(parseMessageIds("<b@x>", "<a@x> <b@x>")).toEqual(["b@x", "a@x"]);
  });

  it("handles a bare id with no angle brackets", () => {
    expect(parseMessageIds("a@x")).toEqual(["a@x"]);
  });

  it("is empty for empty headers", () => {
    expect(parseMessageIds(null, undefined, "")).toEqual([]);
  });
});

describe("linkPromoterReply — exact match on Message-ID", () => {
  it("matches through the References chain, not just In-Reply-To", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "someone-else@example.org",
        inReplyTo: null,
        emailReferences: "<msg-1@resend> <msg-9@other>",
        receivedAt: REPLY,
      },
      candidates: [candidate()],
    });
    // Note the From does NOT match the address we wrote to — a Message-ID hit
    // has to stand on its own, because organizers forward our ask to whoever
    // actually knows the dates and that person replies from their own account.
    expect(v).toEqual({ match: "message_id", attemptId: "a1" });
  });

  it("still matches when the reply timestamp precedes the send, and says so", () => {
    // A Message-ID match is definitional. Discarding it because two clocks
    // disagree would throw away the only signal we can be sure of.
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: "<msg-1@resend>",
        emailReferences: null,
        receivedAt: new Date(SENT.getTime() - 60_000),
      },
      candidates: [candidate()],
    });
    expect(v).toMatchObject({ match: "message_id", attemptId: "a1" });
    expect((v as { note?: string }).note).toMatch(/clock skew/);
  });

  it("refuses to choose when two attempts claim the same Message-ID", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: "<msg-1@resend>",
        emailReferences: null,
        receivedAt: REPLY,
      },
      // The two candidates must have DIFFERENT addresses. With the same
      // address, deleting the Message-ID ambiguity check leaves the fallthrough
      // address rule returning an identical `ambiguous` verdict, and the test
      // passes while measuring the wrong mechanism entirely.
      candidates: [candidate(), candidate({ attemptId: "a2", toAddress: "someone@else.test" })],
    });
    expect(v).toMatchObject({ match: "ambiguous", attemptIds: ["a1", "a2"] });
  });
});

describe("linkPromoterReply — fuzzy match on the address we wrote to", () => {
  it("matches a reply from the address we asked, ignoring case and display name", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: '"Dartmouth Grange" <INFO@DartmouthGrange.org>',
        inReplyTo: null,
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [candidate({ providerMessageIds: [] })],
    });
    expect(v).toEqual({ match: "address", attemptId: "a1" });
  });

  it("REFUSES a reply that arrived before we sent the ask", () => {
    // Without this guard an organizer's older, unrelated email attaches itself
    // to a new ask and marks it answered by a message written before the
    // question was asked.
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: new Date(SENT.getTime() - 1),
      },
      candidates: [candidate({ providerMessageIds: [] })],
    });
    expect(v).toMatchObject({ match: "none" });
  });

  it("matches at the instant of sending, not one millisecond later", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: SENT,
      },
      candidates: [candidate({ providerMessageIds: [] })],
    });
    expect(v).toMatchObject({ match: "address", attemptId: "a1" });
  });

  it("never address-matches an attempt with no sent_at — nobody was asked", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [candidate({ sentAt: null, providerMessageIds: [] })],
    });
    expect(v).toMatchObject({ match: "none" });
  });

  it("refuses to guess when one organizer has two open asks", () => {
    // A promoter running two fairs replies once. Picking either would mark an
    // ask answered and let its event leave the queue carrying an answer about
    // the OTHER event.
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [
        candidate({ providerMessageIds: [] }),
        candidate({ attemptId: "a2", eventId: "evt-2", providerMessageIds: [] }),
      ],
    });
    expect(v).toMatchObject({ match: "ambiguous", attemptIds: ["a1", "a2"] });
  });

  it("does not match a stranger's address", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "spam@elsewhere.test",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [candidate({ providerMessageIds: [] })],
    });
    expect(v).toMatchObject({ match: "none" });
  });

  it("reports no candidates distinctly from no match", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: null,
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [],
    });
    expect(v).toMatchObject({ match: "none", reason: expect.stringContaining("no open outreach") });
  });

  it("falls through to the address rule when the Message-ID matches nothing", () => {
    // A referenced id we do not recognise must not short-circuit the search:
    // organizers reply inside older threads all the time.
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: "<unknown@somewhere>",
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [candidate({ providerMessageIds: ["msg-1@resend"] })],
    });
    expect(v).toEqual({ match: "address", attemptId: "a1" });
  });

  it("prefers the Message-ID hit over an address hit on a different attempt", () => {
    const v = linkPromoterReply({
      inbound: {
        fromAddress: "info@dartmouthgrange.org",
        inReplyTo: "<msg-2@resend>",
        emailReferences: null,
        receivedAt: REPLY,
      },
      candidates: [
        candidate({ providerMessageIds: [] }),
        candidate({ attemptId: "a2", eventId: "evt-2", providerMessageIds: ["msg-2@resend"] }),
      ],
    });
    expect(v).toEqual({ match: "message_id", attemptId: "a2" });
  });
});
