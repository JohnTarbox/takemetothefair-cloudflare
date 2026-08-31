/**
 * OPE-626 — the two outbound gates, and the asymmetry between them.
 *
 * The single most important property here is NOT that the gate can close. It is
 * that an UNSET `AUTO_REPLY_ENABLED` leaves the acks flowing. "Nothing changes
 * on deploy" was a requirement of the 2026-08-31 ruling, and the failure being
 * avoided is silently suppressing 106 customer acknowledgements per 30 days —
 * the only thing telling a submitter we received their email.
 *
 * That makes the obvious implementation the wrong one: `!== "true"` is how the
 * OPERATOR flag reads, and copying it here would fail closed on an unset value
 * and mute every ack the moment this deployed. The tests below fail on exactly
 * that mistake.
 */
import { describe, it, expect } from "vitest";
import {
  isAutoReplyEnabled,
  isOperatorReplyEnabled,
  AUTO_REPLY_HELD_REASON,
} from "../src/email-gates.js";

describe("isAutoReplyEnabled — fails OPEN", () => {
  it("is enabled when the flag is UNSET — nothing changes on deploy", () => {
    // The whole point. A `!== "true"` implementation returns false here and
    // silently mutes every acknowledgement on the deploy that ships it.
    expect(isAutoReplyEnabled({})).toBe(true);
    expect(isAutoReplyEnabled(undefined)).toBe(true);
  });

  it('is enabled for "true"', () => {
    expect(isAutoReplyEnabled({ AUTO_REPLY_ENABLED: "true" })).toBe(true);
  });

  it('is DISABLED only for the exact string "false"', () => {
    expect(isAutoReplyEnabled({ AUTO_REPLY_ENABLED: "false" })).toBe(false);
  });

  it("stays enabled on a typo or a stray value", () => {
    // A misspelled flag must not mute customer mail. Under `!== "true"` every
    // one of these would suppress, and the operator would have no signal that
    // their edit did something other than what they meant.
    for (const v of ["False", "FALSE", "0", "no", "off", "", "  ", "tru"]) {
      expect(isAutoReplyEnabled({ AUTO_REPLY_ENABLED: v })).toBe(true);
    }
  });
});

describe("isOperatorReplyEnabled — fails CLOSED", () => {
  it('is enabled ONLY for the exact string "true"', () => {
    expect(isOperatorReplyEnabled({ EMAIL_REPLY_ENABLED: "true" })).toBe(true);
  });

  it("is disabled when unset", () => {
    // Preserves queue-consumers.ts's existing semantics exactly. An
    // operator-composed reply is a deliberate act; its absence is safe.
    expect(isOperatorReplyEnabled({})).toBe(false);
    expect(isOperatorReplyEnabled(undefined)).toBe(false);
  });

  it("is disabled for anything else", () => {
    for (const v of ["false", "True", "TRUE", "1", "yes", ""]) {
      expect(isOperatorReplyEnabled({ EMAIL_REPLY_ENABLED: v })).toBe(false);
    }
  });
});

describe("the two gates are independent", () => {
  it("turning operator replies off does not mute the automated acks", () => {
    // This is the defect inverted. Before OPE-626 there was one flag and it
    // reached only the reviewed paths; the tidy fix — putting the workflow
    // behind the SAME flag — would have stopped all 106 acks the day it
    // shipped, because EMAIL_REPLY_ENABLED reads false as often as true.
    const env = { EMAIL_REPLY_ENABLED: "false", AUTO_REPLY_ENABLED: "true" };
    expect(isOperatorReplyEnabled(env)).toBe(false);
    expect(isAutoReplyEnabled(env)).toBe(true);
  });

  it("muting the acks does not enable operator replies", () => {
    const env = { EMAIL_REPLY_ENABLED: "false", AUTO_REPLY_ENABLED: "false" };
    expect(isAutoReplyEnabled(env)).toBe(false);
    expect(isOperatorReplyEnabled(env)).toBe(false);
  });
});

describe("held mail is attributable", () => {
  it("names the flag that held it, so a stubbed row explains itself", () => {
    // A ledger row reading only "stubbed" cannot say WHICH gate held it now
    // that there are two, and this ticket exists because a send path was
    // unattributable.
    expect(AUTO_REPLY_HELD_REASON).toContain("AUTO_REPLY_ENABLED");
    expect(AUTO_REPLY_HELD_REASON).not.toContain("EMAIL_REPLY_ENABLED");
  });
});
