/**
 * OPE-1393 (CLB5) — MCP `update_event` turns scraper sync OFF when it edits a
 * field the sync writes, so the next sync cannot silently revert the edit.
 * Driven through the REAL tool on a real (sqlite) row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, events, users, promoters } from "../src/schema.js";

const AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(async () => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" as never })
    .run();
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, AUTH, undefined);
  await db.insert(events).values({
    id: "ev-1",
    name: "Harvest Fair",
    slug: "harvest-fair" as never,
    promoterId: "p-1",
    status: "APPROVED",
    description: "Scraped description",
    sourceName: "mainefairs.net",
    sourceUrl: "https://mainefairs.example/hf",
    syncEnabled: true,
  } as typeof events.$inferInsert);
});

async function call(args: Record<string, unknown>) {
  const res = (await server.invoke("update_event", { event_id: "ev-1", ...args })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

const syncEnabled = () =>
  (
    db.select({ s: events.syncEnabled }).from(events).where(eq(events.id, "ev-1")).all()[0] as {
      s: boolean;
    }
  ).s;

describe("OPE-1393 — update_event turns sync off on a synced-field edit", () => {
  it("a description edit sets sync_enabled=0 and reports it (response + audit)", async () => {
    const res = await call({ description: "Operator-corrected description" });
    expect(syncEnabled()).toBe(false);
    expect(res.syncDisabled).toMatchObject({ fields: ["description"] });
    const audit = db
      .select({ p: adminActions.payloadJson })
      .from(adminActions)
      .where(and(eq(adminActions.targetId, "ev-1"), eq(adminActions.action, "event.update")))
      .all()[0] as { p: string };
    expect(JSON.parse(audit.p)).toMatchObject({ sync_disabled_by_edit: ["description"] });
  });

  it("a date edit turns sync off", async () => {
    await call({ start_date: "2026-09-12" });
    expect(syncEnabled()).toBe(false);
  });

  it("a non-synced field edit leaves sync on", async () => {
    const res = await call({ vendor_fee_notes: "Booths $50" });
    expect(syncEnabled()).toBe(true);
    expect(res.syncDisabled).toBeUndefined();
  });

  it("an explicit sync_enabled: true in the same call wins", async () => {
    await call({ description: "Edited", sync_enabled: true });
    expect(syncEnabled()).toBe(true);
  });

  it("re-sending the stored value is not an edit", async () => {
    await call({ description: "Scraped description" });
    expect(syncEnabled()).toBe(true);
  });
});
