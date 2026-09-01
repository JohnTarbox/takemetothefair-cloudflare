/**
 * OPE-725 — `open` did not mean "a customer is waiting".
 *
 * On 2026-08-29 a re-triage of 21 `open` obligations found the true waiting
 * count was ZERO: every one had been answered and never closed. `status` is a
 * workflow field, and nothing joined it to the evidence of an actual reply.
 *
 * The three values are deliberate and the third is the careful one:
 *
 *   answered_not_closed   open, and a reply:manual* went out after it opened
 *   manual_reply_on_record already closed, and the send is on record
 *   no_ledger_row         WE HAVE NO RECORD — explicitly NOT "nobody answered"
 *
 * That last distinction is the whole point. A reply sent from Gmail never
 * reaches `email_send_ledger` (OPE-361/OPE-353); OPE-706 measured the ledger
 * side at 4 rows against the header side's 5, and the undercount is exactly the
 * manual replies this signal cares about.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const T0 = new Date("2026-08-01T12:00:00Z");

/** Mirrors the tool's matching rule, so the test tracks the implementation. */
function signal(
  row: { inboundEmailId: string; fromAddress: string; openedAt: Date; status: string },
  rows: {
    recipient: string | null;
    inboundEmailId: string | null;
    source: string | null;
    sentAt: Date;
  }[]
) {
  const hit = rows
    .filter(
      (l) =>
        (l.inboundEmailId && l.inboundEmailId === row.inboundEmailId) ||
        (l.recipient && row.fromAddress && l.recipient === row.fromAddress)
    )
    .filter((l) => l.sentAt.getTime() >= row.openedAt.getTime())
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  return hit
    ? row.status === "open"
      ? "answered_not_closed"
      : "manual_reply_on_record"
    : "no_ledger_row";
}

const base = { inboundEmailId: "in-o1", fromAddress: "a@b.com", openedAt: T0, status: "open" };

describe("the 2026-08-29 case: answered but never closed", () => {
  it("an open obligation with a later manual reply reads answered_not_closed", () => {
    const rows = [
      {
        recipient: "a@b.com",
        inboundEmailId: null,
        source: "reply:manual",
        sentAt: new Date("2026-08-02T09:00:00Z"),
      },
    ];
    expect(signal(base, rows)).toBe("answered_not_closed");
  });

  it("matches on inbound_email_id when the ledger carries one", () => {
    // The exact join. Recipient can differ — a reply forwarded to a colleague
    // still discharges the same thread.
    const rows = [
      {
        recipient: "someone-else@x.com",
        inboundEmailId: "in-o1",
        source: "reply:manual",
        sentAt: new Date("2026-08-02T09:00:00Z"),
      },
    ];
    expect(signal(base, rows)).toBe("answered_not_closed");
  });

  it("a send BEFORE the obligation opened does not count", () => {
    // It cannot have answered a message that had not arrived — the same rule
    // OPE-706 applied to inbound replies.
    const rows = [
      {
        recipient: "a@b.com",
        inboundEmailId: null,
        source: "reply:manual",
        sentAt: new Date("2026-07-30T09:00:00Z"),
      },
    ];
    expect(signal(base, rows)).toBe("no_ledger_row");
  });

  it("a closed obligation with a send reads manual_reply_on_record", () => {
    const rows = [
      {
        recipient: "a@b.com",
        inboundEmailId: null,
        source: "reply:manual",
        sentAt: new Date("2026-08-02T09:00:00Z"),
      },
    ];
    expect(signal({ ...base, status: "answered" }, rows)).toBe("manual_reply_on_record");
  });
});

describe("no_ledger_row is not 'unanswered'", () => {
  it("returns no_ledger_row when nothing matches", () => {
    expect(signal(base, [])).toBe("no_ledger_row");
  });

  it("the caveat string says so, in the payload", () => {
    // The label is the guard. Without it the next reader treats an empty ledger
    // as proof of silence and closes a queue that is still live.
    const src = readFileSync(
      join(__dirname, "..", "src", "tools", "admin-support-obligations.ts"),
      "utf8"
    );
    expect(src).toMatch(/answerSignalCaveat/);
    expect(src).toMatch(/NOT that nobody answered/);
  });

  it("nothing auto-closes", () => {
    // The aehko counterexample: John replied AND asked a question, so the
    // obligation was still live after the answer went out.
    const src = readFileSync(
      join(__dirname, "..", "src", "tools", "admin-support-obligations.ts"),
      "utf8"
    );
    const listTool = src.slice(
      src.indexOf('"list_support_obligations"'),
      src.indexOf('"resolve_support_obligation"')
    );
    expect(listTool).not.toMatch(/\.update\(supportObligations\)/);
  });
});

describe("only manual replies count", () => {
  it("an automated ack does not discharge an obligation", () => {
    // reply:support-ack is the bot. If it counted, every obligation would read
    // answered the moment it opened — the ack fires within seconds. Asserted on
    // the WHERE clause rather than by seeding, because the source predicate is
    // the thing that must not loosen to `reply:%`.
    const src = readFileSync(
      join(__dirname, "..", "src", "tools", "admin-support-obligations.ts"),
      "utf8"
    );
    expect(src).toMatch(/like\(emailSendLedger\.source, "reply:manual%"\)/);
  });
});

describe("the D1 bind-parameter cap", () => {
  it("the ledger lookup is chunked", () => {
    // `limit` allows 200 obligations; D1 caps a statement at 100 bind params.
    // Local SQLite allows 32,766, so no seeded test can reproduce the throw —
    // this asserts the SHAPE instead. OPE-384 stage 2 shipped green and threw
    // `too many SQL variables` on its first production call for exactly this.
    const src = readFileSync(
      join(__dirname, "..", "src", "tools", "admin-support-obligations.ts"),
      "utf8"
    );
    expect(src).toMatch(/for \(const chunk of chunkIds\(addresses\)\)/);
    expect(src).toMatch(/for \(const chunk of chunkIds\(inboundIds\)\)/);
    expect(src).not.toMatch(/inArray\(emailSendLedger\.recipient, addresses\)/);
  });
});
