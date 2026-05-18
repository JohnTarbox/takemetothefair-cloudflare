/**
 * Tests for the inbound_emails dedup INSERT used by email-handler.ts
 * step 6. Exercises the actual SQL drizzle generates against an in-memory
 * SQLite with the partial unique index from drizzle/0073 applied — this
 * is the closest we can get to D1 without running wrangler.
 *
 * Backstory: PR-B's first cut used `.onConflictDoNothing({target: ...})`
 * which errored with "ON CONFLICT clause does not match any PRIMARY KEY
 * or UNIQUE constraint" against the partial index. Second cut added
 * `where: sql\`...\`` which Drizzle emits AFTER `DO NOTHING` (invalid
 * SQLite syntax). The fix landed on bare `.onConflictDoNothing()` with
 * no target — matches any unique-constraint violation. These tests pin
 * that behavior down so the bug can't sneak back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { inboundEmails } from "../src/schema.js";
import { createTestDb, type TestDb } from "./setup-db.js";

let db: TestDb;

beforeEach(() => {
  db = createTestDb().db;
});

function insertWithDedup(
  messageId: string | null,
  overrides: { id?: string; subject?: string } = {}
) {
  const now = new Date();
  return db
    .insert(inboundEmails)
    .values({
      id: overrides.id ?? crypto.randomUUID(),
      receivedAt: now,
      fromAddress: "alice@example.com",
      toAddress: "submit@meetmeatthefair.com",
      subject: overrides.subject ?? null,
      intent: "submit",
      status: "received",
      workflowInstanceId: null,
      bodyTextExcerpt: null,
      parsedUrl: null,
      attachmentCount: 0,
      rawSize: 1024,
      error: null,
      messageId,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: inboundEmails.id });
}

describe("inbound_emails INSERT with dedup", () => {
  it("inserts a new row with non-null message_id and returns the id", async () => {
    const result = await insertWithDedup("<msg-1@example.com>");
    expect(result).toHaveLength(1);
  });

  it("dedups a second INSERT with the same message_id (returning is empty)", async () => {
    const first = await insertWithDedup("<msg-dup@example.com>");
    expect(first).toHaveLength(1);
    const second = await insertWithDedup("<msg-dup@example.com>");
    expect(second).toHaveLength(0);
  });

  it("allows multiple NULL message_id rows (partial index exempts NULLs)", async () => {
    const first = await insertWithDedup(null);
    const second = await insertWithDedup(null);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Both rows persisted
    const rows = await db.select({ id: inboundEmails.id }).from(inboundEmails);
    expect(rows).toHaveLength(2);
  });

  it("different message_id values don't collide", async () => {
    const a = await insertWithDedup("<a@example.com>");
    const b = await insertWithDedup("<b@example.com>");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
