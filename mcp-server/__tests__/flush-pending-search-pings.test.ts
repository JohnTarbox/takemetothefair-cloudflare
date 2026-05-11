/**
 * Tests for the flush_pending_search_pings MCP tool. Covers the wrapper
 * around claimAndFlush + audit logging contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, pendingSearchPings } from "../src/schema.js";
import { enqueuePendingPing } from "../src/pending-pings.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

async function invoke(args: Record<string, unknown> = {}) {
  const result = (await server.invoke("flush_pending_search_pings", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: !!result.isError,
    payload: JSON.parse(result.content[0].text) as {
      batch_id: string;
      flushed_count: number;
      by_entity_type: Record<string, number>;
      indexnow_response: string;
      schema_org_regen_count: number;
      dry_run: boolean;
    },
  };
}

describe("flush_pending_search_pings", () => {
  it("empty queue: returns flushed_count:0 and writes one audit row", async () => {
    const { payload } = await invoke();
    expect(payload.flushed_count).toBe(0);
    expect(payload.indexnow_response).toBe("ok");
    expect(mock.calls).toHaveLength(0);

    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "search_pings.flush"))
      .all();
    expect(audits).toHaveLength(1);
  });

  it("flushes 3 enqueued vendor pings and writes audit", async () => {
    for (let i = 0; i < 3; i++) {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: `v-${i}`,
        entitySlug: `s-${i}`,
        action: "create",
      });
    }
    const { payload } = await invoke();
    expect(payload.flushed_count).toBe(3);
    expect(payload.by_entity_type).toEqual({ vendor: 3 });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].urls).toHaveLength(3);

    const audit = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "search_pings.flush"))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0].targetId).toBe(payload.batch_id);
  });

  it("dry_run: returns counts without writing audit or pinging", async () => {
    await enqueuePendingPing(db, {
      entityType: "event",
      entityId: "e-1",
      entitySlug: "fest",
      action: "create",
    });
    const { payload } = await invoke({ dry_run: true });
    expect(payload.dry_run).toBe(true);
    expect(payload.flushed_count).toBe(1);
    expect(mock.calls).toHaveLength(0);

    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "search_pings.flush"))
      .all();
    expect(audits).toHaveLength(0);

    const rows = db.select().from(pendingSearchPings).all();
    expect(rows[0].flushedAt).toBeNull();
  });

  it("entity_type filter only drains the requested type", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "vend",
      action: "create",
    });
    await enqueuePendingPing(db, {
      entityType: "event",
      entityId: "e-1",
      entitySlug: "evt",
      action: "create",
    });
    const { payload } = await invoke({ entity_type: "vendor" });
    expect(payload.flushed_count).toBe(1);
    expect(payload.by_entity_type).toEqual({ vendor: 1 });
  });

  it("schema_org_regen_count is always 0 in v1 (no regen pipeline yet)", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "anyvendor",
      action: "create",
    });
    const { payload } = await invoke();
    expect(payload.schema_org_regen_count).toBe(0);
  });
});
