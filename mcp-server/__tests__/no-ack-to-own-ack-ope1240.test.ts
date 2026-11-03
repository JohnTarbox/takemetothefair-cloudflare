/**
 * OPE-1240 — John's ruling (2026-09-30): a reply to one of our OWN automatic
 * replies (ledger source `reply:*`, not `reply:manual*`) gets NO automatic
 * reply. The message is still logged, still opens/joins its support
 * obligation, still queues.
 *
 * Rework (10-15 review): the first build only withheld generic acks, so the
 * 10-01 reply to a photo hold notice (`a38d02bf`, parent
 * `reply:photo-intake-unresolved`) drew a second automatic reply
 * (`no-url-prose-failed`). The rule now withholds EVERY kind except a reply
 * that carries the outcome the parent asked for (`photo-intake-resolved`).
 *
 * Not covered, by design: replies to automated NOTICES (`content-links-sync.*`,
 * newsletters, digests) keep their ack, and replies to a person keep
 * `thread-reply-ack` (OPE-706).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createTestDb, type TestDb } from "./setup-db.js";
import { supportObligations } from "../src/schema.js";
import type { ReplyKind } from "../src/email-handlers/types.js";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));
vi.mock("../src/tools/admin-send-vendor-email.js", () => ({
  isEmailSuppressed: async () => false,
}));

const { decideThreadAckGuard } = await import("../src/email-handlers/thread-ack-suppression.js");
const { isOwnAutomaticReply } = await import("../src/email-handlers/thread-reply-ack.js");
const { handle: handleSupport } = await import("../src/email-handlers/support.js");

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
const T = 1790500000;
const PARENT = "<parentFixture@meetmeatthefair.com>";

function parent(source: string, sentAt = T - 3600) {
  raw["prepare"](
    "INSERT INTO email_send_ledger (message_id, sent_at, source, status, provider_message_id, recipient) VALUES (?, ?, ?, 'sent', ?, 'pat@example.com')"
  ).run(`p-${source}`, sentAt, source, PARENT);
}
function reply(id: string, body = "Any update on my listing?") {
  raw["prepare"](
    `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, classified_intent, classified_confidence, thread_id, in_reply_to, subject, body_text)
     VALUES (?, ?, ?, 'pat@example.com', 'support@meetmeatthefair.com', 'support', 'support', 0.9, 't1', ?, 'Re: your message', ?)`
  ).run(id, T, T, PARENT, body);
}
const ledgerFor = (id: string) =>
  raw["prepare"]("SELECT status, error, source FROM email_send_ledger WHERE message_id = ?").get(
    `reply-${id}`
  ) as { status: string; error: string; source: string } | undefined;

const guard = (id: string, replyKind: ReplyKind) =>
  decideThreadAckGuard(db as never, { messageRowId: id, replyKind, closedBySender: false });

beforeEach(() => {
  ({ db, raw } = createTestDb());
  harness.db = db;
  // support_obligations is not in the hand-written setup-db DDL; generate it
  // from the Drizzle table so it cannot drift from the schema.
  const cfg = getTableConfig(supportObligations);
  const cols = cfg.columns.map(
    (c) =>
      `${c.name} ${c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT"}${c.primary ? " PRIMARY KEY" : ""}${(c as unknown as { isUnique?: boolean }).isUnique ? " UNIQUE" : ""}`
  );
  raw["exec"](`CREATE TABLE IF NOT EXISTS ${cfg.name} (${cols.join(", ")});`);
});

describe("isOwnAutomaticReply — a prefix rule, not a list", () => {
  it.each([
    ["reply:support-ack", true],
    ["reply:correction-ack", true],
    ["reply:photo-intake-unresolved", true],
    ["reply:photo-intake-held", true],
    ["reply:sweep-exceeded", true],
    ["reply:some-kind-added-next-month", true],
    ["reply:manual", false],
    ["reply:manual-gmail", false],
    ["content-links-sync.promoter-mention", false],
    ["newsletter", false],
    [null, false],
  ] as const)("%s → %s", (src, expected) => expect(isOwnAutomaticReply(src)).toBe(expected));
});

describe("decideThreadAckGuard — reply to our own automatic reply", () => {
  it("photo hold notice (the 10-01 a38d02bf shape): no automatic reply, ledgered with the reason, obligation still opened", async () => {
    parent("reply:photo-intake-unresolved");
    reply("r-photo", "Southern Maine Successful Aging Expo 2026");
    // The handler runs first in the workflow and opens the obligation; the
    // guard runs later and must not undo it.
    const rowRaw = raw["prepare"](
      "SELECT * FROM inbound_emails WHERE id = 'r-photo'"
    ).get() as Record<string, unknown>;
    const row = Object.fromEntries(
      Object.entries(rowRaw).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        v,
      ])
    );
    const handled = await handleSupport({ DB: {} } as never, {} as never, row as never);
    expect(handled.crossingDestinationRef).toBeTruthy();

    // Whatever the lane picked — the 10-01 row picked a submit verdict.
    for (const kind of ["no-url-prose-failed", "correction-ack"] as ReplyKind[]) {
      raw["exec"]("DELETE FROM email_send_ledger WHERE message_id = 'reply-r-photo'");
      const g = await guard("r-photo", kind);
      expect(g.reason).toBe("reply-to-own-ack");
      expect(ledgerFor("r-photo")).toMatchObject({
        status: "stubbed",
        error: expect.stringContaining("suppressed: reply-to-own-ack"),
      });
    }
    const ob = raw["prepare"](
      "SELECT status FROM support_obligations WHERE inbound_email_id = 'r-photo'"
    ).get() as { status: string } | undefined;
    expect(ob?.status).toBe("open");
  });

  it("support-ack parent: no automatic reply", async () => {
    parent("reply:support-ack");
    reply("r1");
    const g = await guard("r1", "support-ack");
    expect(g.reason).toBe("reply-to-own-ack");
    expect(ledgerFor("r1")).toMatchObject({ status: "stubbed" });
  });

  it("a non-ack reply kind is withheld too — the narrower first build let this through", async () => {
    parent("reply:support-ack");
    reply("r4");
    const g = await guard("r4", "ok-medium");
    expect(g.reason).toBe("reply-to-own-ack");
  });

  it("photo-intake-resolved still goes: it is the answer the hold notice asked for (OPE-254)", async () => {
    parent("reply:photo-intake-unresolved");
    reply("r5", "Fryeburg Fair");
    const g = await guard("r5", "photo-intake-resolved");
    expect(g.reason).toBeNull();
    expect(g.kind).toBe("photo-intake-resolved");
    expect(ledgerFor("r5")).toBeUndefined();
  });

  it("a reply to an automated NOTICE keeps its intent ack (the Christmas Prelude case)", async () => {
    parent("content-links-sync.promoter-mention");
    reply("r2");
    const g = await guard("r2", "correction-ack");
    expect(g.reason).toBeNull();
    expect(g.kind).toBe("correction-ack");
    expect(ledgerFor("r2")).toBeUndefined();
  });

  it("a reply to a PERSON keeps thread-reply-ack (OPE-706 unchanged)", async () => {
    // Manual parent outside the 72h quiet window, so OPE-1163 doesn't fire either.
    parent("reply:manual", T - 200 * 3600);
    reply("r3");
    const g = await guard("r3", "support-ack");
    expect(g.kind).toBe("thread-reply-ack");
    expect(g.reason).toBeNull();
    expect(ledgerFor("r3")).toBeUndefined();
  });

  it("a thread holding BOTH our ack and a person's reply is a human thread — not withheld", async () => {
    parent("reply:support-ack");
    raw["prepare"](
      "INSERT INTO email_send_ledger (message_id, sent_at, source, status, provider_message_id, recipient) VALUES ('p-m2', ?, 'reply:manual', 'sent', '<human@meetmeatthefair.com>', 'x@example.com')"
    ).run(T - 200 * 3600);
    raw["prepare"](
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id, in_reply_to, email_references, subject, body_text)
       VALUES ('r6', ?, ?, 'pat@example.com', 'support@meetmeatthefair.com', 'support', 't6', '<human@meetmeatthefair.com>', ?, 'Re', 'more info')`
    ).run(T, T, `${PARENT} <human@meetmeatthefair.com>`);
    const g = await guard("r6", "support-ack");
    expect(g.reason).not.toBe("reply-to-own-ack");
    expect(g.kind).toBe("thread-reply-ack");
  });
});
