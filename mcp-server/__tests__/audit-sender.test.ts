/**
 * OPE-74 — unit tests for isNonActionableSender, the pure classifier that gates
 * the ingest-time audit-noop short-circuit in email-handler.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isNonActionableSender,
  NON_ACTIONABLE_EXACT_SENDERS,
} from "../src/email-handlers/audit-sender.js";

describe("isNonActionableSender — exact audit loopbacks", () => {
  it("matches notify@meetmeatthefair.com with the audit-copy reason", () => {
    expect(isNonActionableSender("notify@meetmeatthefair.com")).toEqual({
      match: true,
      reason: "outbound-audit-copy-notify-at-meetmeatthefair",
    });
  });

  it("matches the exact address case-insensitively / with surrounding whitespace", () => {
    expect(isNonActionableSender("  Notify@MeetMeAtTheFair.com ")).toEqual({
      match: true,
      reason: "outbound-audit-copy-notify-at-meetmeatthefair",
    });
  });
});

describe("isNonActionableSender — generic system local-parts", () => {
  it("matches noreply@ case-insensitively with a system-sender reason", () => {
    expect(isNonActionableSender("NoReply@Foo.com")).toEqual({
      match: true,
      reason: "system-sender-noreply",
    });
  });

  it("matches no-reply@, postmaster@, mailer-daemon@", () => {
    expect(isNonActionableSender("no-reply@bar.org").reason).toBe("system-sender-no-reply");
    expect(isNonActionableSender("postmaster@bar.org").reason).toBe("system-sender-postmaster");
    expect(isNonActionableSender("mailer-daemon@mx.google.com").reason).toBe(
      "system-sender-mailer-daemon"
    );
  });

  it("matches a bare MAILER-DAEMON with no domain", () => {
    expect(isNonActionableSender("MAILER-DAEMON")).toEqual({
      match: true,
      reason: "system-sender-mailer-daemon",
    });
  });

  it("does NOT match a real user whose local-part merely starts with a system token", () => {
    // Exact local-part equality — not a prefix — so this is a genuine human.
    expect(isNonActionableSender("noreplyfan@acme.com").match).toBe(false);
    expect(isNonActionableSender("postmastergeneral@acme.com").match).toBe(false);
  });
});

describe("isNonActionableSender — non-matches", () => {
  it("does not match an ordinary sender", () => {
    expect(isNonActionableSender("jane@acme.com")).toEqual({ match: false, reason: "" });
  });

  it("treats null / undefined / empty / whitespace as no-match (fail-open)", () => {
    expect(isNonActionableSender(null)).toEqual({ match: false, reason: "" });
    expect(isNonActionableSender(undefined)).toEqual({ match: false, reason: "" });
    expect(isNonActionableSender("")).toEqual({ match: false, reason: "" });
    expect(isNonActionableSender("   ")).toEqual({ match: false, reason: "" });
  });
});

describe("NON_ACTIONABLE_EXACT_SENDERS — shared source of truth", () => {
  it("is lowercased and contains the notify loopback address", () => {
    expect(NON_ACTIONABLE_EXACT_SENDERS).toContain("notify@meetmeatthefair.com");
    for (const addr of NON_ACTIONABLE_EXACT_SENDERS) {
      expect(addr).toBe(addr.toLowerCase());
    }
  });
});
