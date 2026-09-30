/**
 * OPE-768 — thread resolution, and the failure that is worse than the defect.
 *
 * The defect is a split conversation: one person reads as two waiting people.
 * The failure introduced by fixing it carelessly is a MERGED conversation: an
 * operator opens a thread and sees a stranger's mail. A split thread costs a
 * search; a merged one is a disclosure.
 *
 * So the weak (subject+participants) tier is tested from both sides, and the
 * ticket's own negative control — Holly Plush Cargo's two genuine, correctly
 * captured 2026-08-05 emails — is pinned as MUST-NOT-MERGE.
 */
import { describe, it, expect } from "vitest";
import {
  isThreadableSubject,
  normalizeMessageId,
  normalizeThreadSubject,
  parseMessageIdList,
  participantKey,
  resolveThread,
  type ThreadCandidateRow,
} from "./email-thread";

const NEW_ID = "new-thread-id";

function row(over: Partial<ThreadCandidateRow> = {}): ThreadCandidateRow {
  return {
    threadId: "t-existing",
    messageId: null,
    normalizedSubject: "",
    participants: "",
    ...over,
  };
}

describe("parseMessageIdList", () => {
  it("splits a References chain into normalised ids", () => {
    // `References` carries the whole chain, so one header yields many ids — and
    // our own outbound sets References to the inbound's id (OPE-163), which is
    // why a reply to our reply still names the ORIGINAL message here.
    expect(parseMessageIdList("<a@x.com> <b@y.com>\n <c@z.com>")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("is case-insensitive and bracket-insensitive", () => {
    expect(parseMessageIdList("<AbC@X.CoM>")).toEqual(["abc@x.com"]);
    expect(normalizeMessageId(" <AbC@X.CoM> ")).toBe("abc@x.com");
  });

  it("returns [] for absent headers rather than [''] ", () => {
    // A stray empty string here would match a stored NULL-ish id and thread two
    // unrelated messages together.
    expect(parseMessageIdList(null)).toEqual([]);
    expect(parseMessageIdList("")).toEqual([]);
    expect(normalizeMessageId(null)).toBeNull();
  });
});

describe("normalizeThreadSubject", () => {
  it.each([
    ["Re: Fall Craft Fair", "fall craft fair"],
    ["RE: Re: FWD: Fall Craft Fair", "fall craft fair"],
    ["[EXTERNAL] Re: Fall Craft Fair", "fall craft fair"],
    ["Fwd: Fall   Craft  Fair", "fall craft fair"],
    ["AW: Fall Craft Fair", "fall craft fair"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeThreadSubject(input)).toBe(expected);
  });

  it("returns empty for a subject that is nothing but prefixes", () => {
    expect(normalizeThreadSubject("Re: Fwd:")).toBe("");
    expect(normalizeThreadSubject(null)).toBe("");
  });
});

describe("isThreadableSubject — the guard on the weak tier", () => {
  it("rejects generic subjects that cannot distinguish two people", () => {
    // This is the whole safety of tier 2. "Question" is not a thread key.
    for (const s of ["", "hello", "question", "inquiry", "vendor application"]) {
      expect(isThreadableSubject(s)).toBe(false);
    }
  });

  it("accepts a specific subject", () => {
    expect(isThreadableSubject("manchester grange fall craft fair")).toBe(true);
    expect(isThreadableSubject("booth fee question")).toBe(true);
  });
});

describe("participantKey", () => {
  it("is order-independent and case-insensitive", () => {
    expect(participantKey(["A@x.com", "b@Y.com"])).toBe(participantKey(["b@y.com", "a@x.com"]));
  });

  it("extracts the address from a display-name form", () => {
    expect(participantKey(["Jane Doe <jane@x.com>"])).toBe("jane@x.com");
  });
});

describe("resolveThread — tier 1, the header chain", () => {
  it("threads a reply onto the message it answers", () => {
    const r = resolveThread(
      { inReplyTo: "<orig@mail.com>", participants: "a|b" },
      [row({ threadId: "t-1", messageId: "<orig@mail.com>" })],
      NEW_ID
    );
    expect(r).toEqual({ threadId: "t-1", basis: "header_chain" });
  });

  it("matches through References when In-Reply-To points at our own reply", () => {
    // The exact live shape: `in_reply_to` names OUR message-id on 7 of 21 rows,
    // and the original inbound's id survives in References.
    const r = resolveThread(
      {
        inReplyTo: "<ours@meetmeatthefair.com>",
        emailReferences: "<orig@mail.com>",
        participants: "a|b",
      },
      [row({ threadId: "t-1", messageId: "<orig@mail.com>" })],
      NEW_ID
    );
    expect(r.basis).toBe("header_chain");
    expect(r.threadId).toBe("t-1");
  });

  it("threads across a RENAMED subject — a header match outranks the subject", () => {
    const r = resolveThread(
      { inReplyTo: "<orig@mail.com>", subject: "completely different now", participants: "a|b" },
      [row({ threadId: "t-1", messageId: "<orig@mail.com>", normalizedSubject: "original" })],
      NEW_ID
    );
    expect(r.basis).toBe("header_chain");
  });

  it("ignores a candidate whose threadId is NULL (a pre-threading row)", () => {
    // Rows written before drizzle/0263 have no thread. Adopting their NULL
    // would write NULL as this message's thread and lose it entirely.
    const r = resolveThread(
      { inReplyTo: "<orig@mail.com>", participants: "a|b" },
      [row({ threadId: null, messageId: "<orig@mail.com>" })],
      NEW_ID
    );
    expect(r).toEqual({ threadId: NEW_ID, basis: "new" });
  });
});

describe("resolveThread — tier 2, and what it must refuse", () => {
  it("groups a repeat message on subject AND participants", () => {
    const r = resolveThread(
      {
        subject: "Re: Manchester Grange Fall Craft Fair",
        participants: "celina@x.com|hello@mmatf",
      },
      [
        row({
          threadId: "t-celina",
          normalizedSubject: "manchester grange fall craft fair",
          participants: "celina@x.com|hello@mmatf",
        }),
      ],
      NEW_ID
    );
    expect(r).toEqual({ threadId: "t-celina", basis: "subject_participants" });
  });

  it("NEGATIVE CONTROL: refuses to merge different participants on the same subject", () => {
    // Holly Plush Cargo's two 2026-08-05 rows went to DIFFERENT addresses with
    // DIFFERENT message-ids — two real, correctly-captured emails. A matcher
    // loose enough to fuse these is one that shows an operator somebody else's
    // correspondence, and it would also report a capture defect that does not
    // exist. The ticket names this case explicitly.
    const r = resolveThread(
      { subject: "Vendor booth at the fall fair", participants: "holly@x.com|photos@mmatf" },
      [
        row({
          threadId: "t-other",
          normalizedSubject: "vendor booth at the fall fair",
          participants: "holly@x.com|hello@mmatf", // different recipient
        }),
      ],
      NEW_ID
    );
    expect(r).toEqual({ threadId: NEW_ID, basis: "new" });
  });

  it("refuses to merge two strangers who both wrote a GENERIC subject", () => {
    const r = resolveThread(
      { subject: "Question", participants: "a@x.com|hello@mmatf" },
      [
        row({
          threadId: "t-someone-else",
          normalizedSubject: "question",
          participants: "a@x.com|hello@mmatf",
        }),
      ],
      NEW_ID
    );
    // Same subject, same participants, and STILL new — because "Question"
    // cannot distinguish two conversations from the same person either.
    expect(r.basis).toBe("new");
  });

  it("starts a new thread when there is nothing to match", () => {
    expect(
      resolveThread(
        { subject: "A brand new enquiry about booths", participants: "x|y" },
        [],
        NEW_ID
      )
    ).toEqual({
      threadId: NEW_ID,
      basis: "new",
    });
  });
});
