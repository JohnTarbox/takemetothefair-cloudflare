/**
 * OPE-113 — performer-tracking Phase 1 MCP tools. Uses the in-memory SQLite +
 * CapturingMcpServer harness. Covers CRUD, fuzzy-dedup on create_or_link, the
 * appearance-key behaviour (repeat set allowed, exact dup idempotent, NULL-start
 * app-dedup), the appearance setters, alias, and merge (appearance move + clash
 * drop + tombstone + slug-history).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import {
  performers,
  eventPerformers,
  performerSlugHistory,
  events,
  promoters,
} from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}
const call = async (name: string, args: Record<string, unknown> = {}) =>
  parse(await server.invoke(name, args));

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "e1", name: "Fair", slug: "fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

describe("create/update/delete/search performer (OPE-113)", () => {
  it("creates a performer with a slug and audit row", async () => {
    const r = await call("create_performer", {
      name: "Mr. Drew and His Animals Too",
      performer_type: "PERSON",
      act_category: "ANIMAL_SHOW",
    });
    expect(r.success).toBe(true);
    const p = r.performer as Record<string, unknown>;
    expect(p.slug).toBe("mr-drew-and-his-animals-too");
    expect(p.act_category).toBe("ANIMAL_SHOW");
  });

  it("soft-deletes and restores; search excludes deleted by default", async () => {
    const c = await call("create_performer", { name: "The Jugglers" });
    const id = (c.performer as { id: string }).id;
    expect((await call("search_performers", { query: "juggl" })).count).toBe(1);
    await call("delete_performer", { performer_id: id });
    expect((await call("search_performers", { query: "juggl" })).count).toBe(0);
    expect((await call("search_performers", { query: "juggl", include_deleted: true })).count).toBe(
      1
    );
    await call("undelete_performer", { performer_id: id });
    expect((await call("search_performers", { query: "juggl" })).count).toBe(1);
  });
});

describe("create_or_link_performer — dedup + appearances (OPE-113)", () => {
  it("creates the performer + appearance on first link", async () => {
    const r = await call("create_or_link_performer", {
      event_id: "e1",
      name: "The Fiddleheads",
      act_category: "MUSIC",
      performer_type: "GROUP",
      source_url: "https://src/1",
    });
    expect(r.success).toBe(true);
    expect(r.created_appearance).toBe(true);
    expect((await call("list_event_performers", { event_id: "e1" })).count).toBe(1);
  });

  it("surfaces a fuzzy duplicate for manual confirm instead of auto-linking", async () => {
    await call("create_performer", { name: "The Fiddleheads Band" });
    const r = await call("create_or_link_performer", {
      event_id: "e1",
      name: "The Fiddleheads Band!",
      source_url: "https://src/2",
    });
    expect(r.success).toBe(false);
    expect(r.needs_confirmation).toBe(true);
    expect((r.matches as unknown[]).length).toBeGreaterThan(0);
    // confirm_create_new forces a distinct new act.
    const forced = await call("create_or_link_performer", {
      event_id: "e1",
      name: "The Fiddleheads Band!",
      confirm_create_new: true,
      source_url: "https://src/2",
    });
    expect(forced.created_appearance).toBe(true);
  });

  it("allows the same act to appear twice the same day (different start) but dedups exact repeats", async () => {
    const first = await call("create_or_link_performer", {
      event_id: "e1",
      name: "Solo Act",
      event_day_id: "d1",
      performance_start: 1000,
      source_url: "https://s",
    });
    const performerId = (db.select().from(eventPerformers).all()[0] as { performerId: string })
      .performerId;
    // Same day, later slot → new appearance.
    const second = await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: performerId,
      event_day_id: "d1",
      performance_start: 2000,
      source_url: "https://s",
    });
    expect(second.created_appearance).toBe(true);
    // Exact repeat of the first slot → idempotent (not created).
    const repeat = await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: performerId,
      event_day_id: "d1",
      performance_start: 1000,
      source_url: "https://s",
    });
    expect(repeat.created_appearance).toBe(false);
    expect(first.success).toBe(true);
    expect((await call("list_event_performers", { event_id: "e1" })).count).toBe(2);
  });

  it("app-dedups NULL-start appearances the UNIQUE index can't (OPE-112 caveat)", async () => {
    const c = await call("create_or_link_performer", {
      event_id: "e1",
      name: "No Time Act",
      source_url: "https://s",
    });
    const performerId = (db.select().from(eventPerformers).all()[0] as { performerId: string })
      .performerId;
    const again = await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: performerId,
      source_url: "https://s",
    });
    expect(c.created_appearance).toBe(true);
    expect(again.created_appearance).toBe(false); // NULL start deduped in tool logic
  });
});

describe("appearance setters + list ordering (OPE-113)", () => {
  it("sets status/billing/slot and orders list by billing", async () => {
    const a = await call("create_or_link_performer", {
      event_id: "e1",
      name: "Headliner Act",
      billing: "SUPPORTING",
      source_url: "https://s",
    });
    const apprId = (a.appearance as { id: string }).id;
    await call("set_event_performer_status", { event_performer_id: apprId, status: "CONFIRMED" });
    await call("set_event_performer_billing", { event_performer_id: apprId, billing: "HEADLINER" });
    await call("set_event_performer_slot", {
      event_performer_id: apprId,
      stage: "Main Stage",
      performance_start: 5000,
    });
    await call("create_or_link_performer", {
      event_id: "e1",
      name: "Opener Act",
      billing: "FEATURED",
      source_url: "https://s",
    });

    const list = await call("list_event_performers", { event_id: "e1" });
    const rows = list.appearances as Array<{
      billing: string;
      stage: string | null;
      status: string;
    }>;
    expect(rows[0].billing).toBe("HEADLINER"); // headliner first
    expect(rows[0].stage).toBe("Main Stage");
    expect(rows[0].status).toBe("CONFIRMED");
  });

  it("unlinks an appearance by id", async () => {
    const a = await call("create_or_link_performer", {
      event_id: "e1",
      name: "Temp Act",
      source_url: "https://s",
    });
    await call("unlink_performer_from_event", {
      event_performer_id: (a.appearance as { id: string }).id,
    });
    expect((await call("list_event_performers", { event_id: "e1" })).count).toBe(0);
  });
});

describe("alias + merge (OPE-113)", () => {
  it("set_performer_alias tombstones the alias + writes slug history", async () => {
    const canon = (await call("create_performer", { name: "Canonical Act" })).performer as {
      id: string;
    };
    const alias = (await call("create_performer", { name: "Canonical Act Dup" })).performer as {
      id: string;
      slug: string;
    };
    const r = await call("set_performer_alias", {
      alias_performer_id: alias.id,
      canonical_performer_id: canon.id,
    });
    expect(r.success).toBe(true);
    const aliasRow = db
      .select()
      .from(performers)
      .where(eq(performers.id, alias.id))
      .all()[0] as Record<string, unknown>;
    expect(aliasRow.aliasOfPerformerId).toBe(canon.id);
    expect(aliasRow.deletedAt).not.toBeNull();
    expect(aliasRow.slug).not.toBe(alias.slug); // renamed so canonical is free
    expect(db.select().from(performerSlugHistory).all().length).toBe(1);
  });

  it("merge_performer moves appearances, drops clashes, tombstones the duplicate", async () => {
    const keeper = (await call("create_performer", { name: "Keeper Act", website: "" }))
      .performer as { id: string };
    const dup = (
      await call("create_performer", { name: "Dup Act", website: "https://dup.example" })
    ).performer as { id: string; slug: string };
    // Keeper already has a slot that the dup also has → clash (dropped). Dup also has a unique slot → moved.
    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: keeper.id,
      event_day_id: "d1",
      performance_start: 100,
      source_url: "https://s",
    });
    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: dup.id,
      event_day_id: "d1",
      performance_start: 100,
      source_url: "https://s",
    }); // clashes with keeper
    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: dup.id,
      event_day_id: "d1",
      performance_start: 200,
      source_url: "https://s",
    }); // unique

    const r = await call("merge_performer", {
      keeper_performer_id: keeper.id,
      duplicate_performer_id: dup.id,
    });
    expect(r.appearances_moved).toBe(1);
    expect(r.appearances_dropped).toBe(1);

    const keeperAppearances = db
      .select()
      .from(eventPerformers)
      .where(eq(eventPerformers.performerId, keeper.id))
      .all();
    expect(keeperAppearances.length).toBe(2); // its own + the moved one
    const dupRow = db.select().from(performers).where(eq(performers.id, dup.id)).all()[0] as Record<
      string,
      unknown
    >;
    expect(dupRow.deletedAt).not.toBeNull();
    expect(dupRow.redirectToPerformerId).toBe(keeper.id);
    // gap-fill: keeper had empty website, dup had one.
    const keeperRow = db
      .select()
      .from(performers)
      .where(eq(performers.id, keeper.id))
      .all()[0] as Record<string, unknown>;
    expect(keeperRow.website).toBe("https://dup.example");
    // slug-history row so the old dup slug 301s to the keeper.
    expect(db.select().from(performerSlugHistory).all().length).toBe(1);
  });

  it("refuses self-merge", async () => {
    const p = (await call("create_performer", { name: "X" })).performer as { id: string };
    const r = await call("merge_performer", {
      keeper_performer_id: p.id,
      duplicate_performer_id: p.id,
    });
    expect(r.error).toBe("self_merge");
  });
});
