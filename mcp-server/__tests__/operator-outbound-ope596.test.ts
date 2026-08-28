/**
 * OPE-596 — operator-initiated outbound: draft → approve → send.
 *
 * Build authorized by John with one explicit guardrail:
 *
 *   "build it with OPERATOR_OUTBOUND_ENABLED defaulting OFF. The flip to
 *    actually enable sending is John's, made when he's ready — the build going
 *    in does not by itself put mail in front of anyone."
 *
 * So the most important tests here are the ones asserting that **nothing
 * sends**. A feature whose whole risk is "it puts mail in front of customers"
 * earns its tests on the refusal path, not the happy one.
 *
 * The gate is checked in the TOOL, before anything is enqueued. That is item 2
 * of the ruling: the existing asymmetry exists precisely because
 * `EMAIL_REPLY_ENABLED` is enforced only inside the queue consumer, so whether
 * a path is governed depends on which transport it happens to use rather than
 * on any decision about the path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import {
  operatorOutboundEnabled,
  OPERATOR_OUTBOUND_SOURCE,
} from "../src/tools/admin-operator-outbound.js";

// Only the raw handle is used here: these tests assert the GATE and the table
// constraints, both of which are exercised through plain SQL. Holding a drizzle
// handle we never query would just be an unused binding.
let raw: { exec: (s: string) => unknown };

const NOW = Math.floor(new Date("2026-08-28T12:00:00Z").getTime() / 1000);

function seedDraft(id: string, status = "pending") {
  raw.exec(`
    INSERT INTO operator_outbound_drafts
      (id, to_address, subject, body_text, reason, composed_by, composed_at, status)
    VALUES ('${id}', 'vendor@example.com', 'About your listing',
            'Your listed dates do not match your site.', 'Listing shows 2025 dates',
            'developer-claude-code', ${NOW}, '${status}')
  `);
}

beforeEach(() => {
  const t = createTestDb();
  raw = t.raw as unknown as { exec: (s: string) => unknown };
});

describe("operatorOutboundEnabled — the guardrail", () => {
  it("is OFF when the flag is absent — the shipped default", () => {
    // John's condition for authorizing the build. If this ever defaults on,
    // merging the feature would itself start sending mail.
    expect(operatorOutboundEnabled(undefined)).toBe(false);
    expect(operatorOutboundEnabled({})).toBe(false);
  });

  it('is OFF for every value except exactly "true"', () => {
    // Exact-matched, mirroring queue-consumers.ts. A truthiness test would read
    // the STRING "false" as on, which is the most expensive possible way to
    // misread a kill switch.
    expect(operatorOutboundEnabled({ OPERATOR_OUTBOUND_ENABLED: "false" })).toBe(false);
    expect(operatorOutboundEnabled({ OPERATOR_OUTBOUND_ENABLED: "TRUE" })).toBe(false);
    expect(operatorOutboundEnabled({ OPERATOR_OUTBOUND_ENABLED: "1" })).toBe(false);
    expect(operatorOutboundEnabled({ OPERATOR_OUTBOUND_ENABLED: "yes" })).toBe(false);
  });

  it('is ON only for "true"', () => {
    expect(operatorOutboundEnabled({ OPERATOR_OUTBOUND_ENABLED: "true" })).toBe(true);
  });
});

describe("the ledger source is deliberately NOT reply:*", () => {
  it("uses its own source so the inbound flag does not silently govern it", () => {
    // If this were a `reply:*` source it would be caught by the inbound queue's
    // gate — recreating in a new place the exact confusion this ticket exists
    // to end: one flag quietly governing two unrelated decisions.
    expect(OPERATOR_OUTBOUND_SOURCE).toBe("operator:outbound");
    expect(OPERATOR_OUTBOUND_SOURCE.startsWith("reply:")).toBe(false);
  });
});

describe("the drafts table stands alone", () => {
  it("stores a draft with no inbound email — the reason it is a separate table", async () => {
    // `pending_email_replies.inbound_email_id` is NOT NULL, and that coupling
    // is load-bearing. Operator-initiated mail has no inbound, so reusing that
    // table would have meant weakening a constraint that is doing real work.
    seedDraft("d1");
    const rows = raw as unknown as {
      prepare: (s: string) => { all: () => unknown[] };
    };
    const all = rows.prepare(`SELECT id, status, reason FROM operator_outbound_drafts`).all() as {
      id: string;
      status: string;
      reason: string;
    }[];
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("pending");
    // A draft with no stated purpose cannot be approved responsibly, so the
    // column is NOT NULL and the tool requires it.
    expect(all[0].reason).toBeTruthy();
  });

  it("refuses a draft with no reason — NOT NULL at the storage layer", () => {
    const r = raw as unknown as { exec: (s: string) => unknown };
    expect(() =>
      r.exec(`
        INSERT INTO operator_outbound_drafts
          (id, to_address, subject, body_text, composed_at)
        VALUES ('d2','x@example.com','Subject','Body', ${NOW})
      `)
    ).toThrow();
  });
});
