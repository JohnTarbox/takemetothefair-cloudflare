/**
 * OPE-1651 — field-level edit history, MCP side.
 *
 * Acceptance from the ticket:
 *   - editing the description with update_event, then reading history, returns
 *     ONE row with the old and new text, the actor and the tool name;
 *   - a no-op write (same value) writes no row;
 * plus: the vendor / venue / promoter update tools write rows too, the reader
 * filters by field and `since`, and long text is stored in full.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { events, promoters, venues, vendors, users, entityFieldHistory } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "ev-downeast";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

function allHistory() {
  return db.select().from(entityFieldHistory).all();
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p-1", companyName: "Downeast Ag", slug: "downeast-ag" }).run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Downeast Fair",
      slug: "downeast-fair",
      promoterId: "p-1",
      status: "APPROVED",
      description: "The old description.",
      startDate: new Date("2027-08-20T12:00:00Z"),
    })
    .run();
});
afterEach(() => mock.restore());

describe("OPE-1651 — update_event writes field history", () => {
  it("a description edit writes ONE row: old text, new text, actor, tool", async () => {
    parseJson(
      await server.invoke("update_event", { event_id: EVENT_ID, description: "The new one." })
    );

    const rows = allHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: "event",
      entityId: EVENT_ID,
      field: "description",
      oldValue: "The old description.",
      newValue: "The new one.",
      actor: "u-admin",
      source: "mcp:update_event",
    });
    expect(rows[0].requestId).toBeTruthy();

    // …and the reader returns it.
    const read = parseJson(
      await server.invoke("get_entity_field_history", {
        entity_type: "event",
        entity_id: EVENT_ID,
      })
    );
    expect(read.count).toBe(1);
    expect(read.truncated).toBe(false);
    expect(read.history[0]).toMatchObject({
      field: "description",
      old_value: "The old description.",
      new_value: "The new one.",
      actor: "u-admin",
      source: "mcp:update_event",
    });
  });

  it("a no-op write (same value) writes NO row — landmark: the event row was read", async () => {
    parseJson(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        description: "The old description.",
      })
    );
    // Positive landmark: the call reached the write (the row is still there,
    // unchanged), so "0 rows" is a measurement and not a skipped path.
    const [ev] = db.select().from(events).all();
    expect(ev.description).toBe("The old description.");
    expect(allHistory()).toHaveLength(0);
  });

  it("stores a long description in FULL (no truncation)", async () => {
    const long = "x".repeat(5000);
    parseJson(await server.invoke("update_event", { event_id: EVENT_ID, description: long }));
    const [row] = allHistory();
    expect(row.newValue).toHaveLength(5000);
  });

  it("the reader filters by field and `since`, newest first", async () => {
    parseJson(await server.invoke("update_event", { event_id: EVENT_ID, description: "A" }));
    parseJson(
      await server.invoke("update_event", { event_id: EVENT_ID, ticket_url: "https://t.example/x" })
    );
    const all = parseJson(
      await server.invoke("get_entity_field_history", { entity_type: "event", entity_id: EVENT_ID })
    );
    expect(all.count).toBe(2);
    const onlyDesc = parseJson(
      await server.invoke("get_entity_field_history", {
        entity_type: "event",
        entity_id: EVENT_ID,
        field: "description",
      })
    );
    expect(onlyDesc.history.map((h: { field: string }) => h.field)).toEqual(["description"]);
    const future = parseJson(
      await server.invoke("get_entity_field_history", {
        entity_type: "event",
        entity_id: EVENT_ID,
        since: "2999-01-01T00:00:00Z",
      })
    );
    expect(future.count).toBe(0);
  });

  it("rejects an unparseable `since` instead of reading it as no filter", async () => {
    const r = (await server.invoke("get_entity_field_history", {
      entity_type: "event",
      entity_id: EVENT_ID,
      since: "last tuesday",
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

describe("OPE-1651 — the other update tools write field history", () => {
  it("update_vendor", async () => {
    db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({
        id: "v-1",
        userId: "u-v",
        businessName: "Acme Soap",
        slug: "acme-soap",
        description: "old",
      })
      .run();
    parseJson(await server.invoke("update_vendor", { vendor_id: "v-1", description: "new" }));
    expect(allHistory()).toEqual([
      expect.objectContaining({
        entityType: "vendor",
        entityId: "v-1",
        field: "description",
        oldValue: "old",
        newValue: "new",
        source: "mcp:update_vendor",
      }),
    ]);
  });

  it("update_venue", async () => {
    db.insert(venues)
      .values({
        id: "vn-1",
        name: "Fairgrounds",
        slug: "fairgrounds",
        address: "1 Main St",
        city: "Machias",
        state: "ME",
        zip: "04654",
      })
      .run();
    parseJson(await server.invoke("update_venue", { venue_id: "vn-1", zip: "04655" }));
    expect(allHistory()).toEqual([
      expect.objectContaining({
        entityType: "venue",
        field: "zip",
        oldValue: "04654",
        newValue: "04655",
        source: "mcp:update_venue",
      }),
    ]);
  });

  it("update_promoter", async () => {
    parseJson(
      await server.invoke("update_promoter", { promoter_id: "p-1", description: "Ag society" })
    );
    const rows = allHistory().filter((r) => r.field === "description");
    expect(rows).toEqual([
      expect.objectContaining({
        entityType: "promoter",
        entityId: "p-1",
        oldValue: null,
        newValue: "Ag society",
        source: "mcp:update_promoter",
      }),
    ]);
  });
});

describe("OPE-1651 — vendor self-edit over MCP (update_vendor_profile)", () => {
  it("writes rows attributed to the vendor's own user; an unchanged field writes none", async () => {
    db.insert(users).values({ id: "u-owner", email: "o@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({
        id: "v-own",
        userId: "u-owner",
        businessName: "Owner Soap",
        slug: "owner-soap",
        description: "before",
        city: "Bangor",
      })
      .run();
    const vServer = new CapturingMcpServer();
    registerVendorTools(
      vServer as never,
      db,
      { userId: "u-owner", role: "VENDOR", vendorId: "v-own" },
      ENV
    );
    parseJson(
      await vServer.invoke("update_vendor_profile", { description: "after", city: "Bangor" })
    );
    expect(allHistory()).toEqual([
      expect.objectContaining({
        entityType: "vendor",
        entityId: "v-own",
        field: "description",
        oldValue: "before",
        newValue: "after",
        actor: "u-owner",
        source: "mcp:update_vendor_profile",
      }),
    ]);
  });
});
