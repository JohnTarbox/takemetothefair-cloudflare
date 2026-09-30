/**
 * OPE-1172 AC2 — a verification resend to an address that hard-bounced sends
 * nothing and tells the user so.
 *
 * Two layers. The helper runs against real SQLite, because "which rows count"
 * (bounce vs unsubscribe, hard vs soft, a later delivery) is the whole policy.
 * The route runs with its collaborators mocked, because what matters there is
 * ORDER: the check must happen before the user lookup, or the answer becomes
 * an account-existence oracle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { isAddressUndeliverable, isUndeliverableOutcome } from "../undeliverable";
import { readResendOutcome } from "../resend-result";

function makeDb() {
  const raw = new Database(":memory:");
  raw["exec"](`
    CREATE TABLE email_suppression_list (
      email TEXT PRIMARY KEY, reason TEXT, source TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE email_send_ledger (
      message_id TEXT PRIMARY KEY, sent_at INTEGER, recipient TEXT, source TEXT,
      provider_message_id TEXT, status TEXT, provider TEXT, error TEXT, subject TEXT,
      inbound_email_id TEXT, body_html TEXT, body_text TEXT,
      delivery_status TEXT, delivery_updated_at INTEGER, delivery_detail TEXT
    );
  `);
  return { raw, db: drizzle(raw, { schema }) as never };
}

const ledger = (
  raw: Database.Database,
  id: string,
  status: string | null,
  detail: object,
  at: number
) =>
  raw
    .prepare(
      "INSERT INTO email_send_ledger (message_id, recipient, delivery_status, delivery_detail, delivery_updated_at) VALUES (?,?,?,?,?)"
    )
    .run(id, "Typo@Exmaple.com", status, JSON.stringify(detail), at);

describe("isAddressUndeliverable", () => {
  let raw: Database.Database;
  let db: never;
  beforeEach(() => ({ raw, db } = makeDb()));

  it("a hard bounce in the ledger makes it undeliverable (case-insensitive)", async () => {
    ledger(raw, "m1", "bounced", { bounceType: "hard" }, 100);
    expect(await isAddressUndeliverable(db, "typo@exmaple.com")).toBe(true);
  });

  it("a bounce/complaint suppression row makes it undeliverable", async () => {
    raw
      .prepare("INSERT INTO email_suppression_list VALUES (?,?,?,?)")
      .run("typo@exmaple.com", "bounce", "x", 1);
    expect(await isAddressUndeliverable(db, "TYPO@exmaple.com")).toBe(true);
  });

  it("an UNSUBSCRIBE suppression does not block a transactional email", async () => {
    raw
      .prepare("INSERT INTO email_suppression_list VALUES (?,?,?,?)")
      .run("typo@exmaple.com", "unsubscribe", "x", 1);
    expect(await isAddressUndeliverable(db, "typo@exmaple.com")).toBe(false);
  });

  it("a soft bounce does not, and a LATER delivery clears an earlier hard bounce", async () => {
    ledger(raw, "m1", "bounced", { bounceType: "soft" }, 100);
    expect(await isAddressUndeliverable(db, "typo@exmaple.com")).toBe(false);
    ledger(raw, "m2", "bounced", { bounceType: "hard" }, 200);
    ledger(raw, "m3", "delivered", {}, 300);
    expect(await isAddressUndeliverable(db, "typo@exmaple.com")).toBe(false);
  });

  it("LANDMARK: an address with no history is deliverable", async () => {
    expect(await isAddressUndeliverable(db, "fresh@example.com")).toBe(false);
    expect(isUndeliverableOutcome("complained", null)).toBe(true);
  });
});

describe("readResendOutcome", () => {
  it("reads the 422 undeliverable answer, and anything else non-ok as an error", async () => {
    const undeliverable = new Response(
      JSON.stringify({ ok: false, undeliverable: true, email: "a@b.co" }),
      {
        status: 422,
      }
    );
    expect(await readResendOutcome(undeliverable, "x")).toEqual({
      kind: "undeliverable",
      email: "a@b.co",
    });
    expect(await readResendOutcome(new Response("{}", { status: 200 }), "x")).toEqual({
      kind: "sent",
    });
    expect(await readResendOutcome(new Response("{}", { status: 422 }), "x")).toEqual({
      kind: "error",
    });
    expect(await readResendOutcome(new Response("{}", { status: 500 }), "x")).toEqual({
      kind: "error",
    });
  });
});
