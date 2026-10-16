/**
 * OPE-1390 (DUP3) — MCP `update_event` renames through the shared
 * planSlugRename("event") and commits its event_slug_history row in the SAME
 * batch as the events UPDATE.
 *
 * Before: its own collision loop, then a separate history INSERT after the
 * update inside a try/catch that only console.error'd — so a failed insert left
 * a renamed event whose old URL 404'd, and the tool reported success.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters, users } from "../src/schema.js";

const AUTH = { userId: "u-admin", role: "ADMIN" as const };
let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (name: string, args: Record<string, unknown>) =>
  server.invoke(name, args) as Promise<ToolResult>;
const all = (q: string) => raw.prepare(q).all();

beforeEach(async () => {
  ({ db, raw } = createTestDb());
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" as never })
    .run();
  for (const [id, name, slug] of [
    ["ev-1", "Kingfield Craft Fair", "kingfield-craft-fair"],
    ["ev-2", "Harvest Fair", "harvest-fair"],
    ["ev-3", "Harvest Fair", "harvest-fair-1"],
  ]) {
    await db.insert(events).values({
      id,
      name,
      slug: slug as never,
      promoterId: "p-1",
      status: "DRAFT",
    } as typeof events.$inferInsert);
  }
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, AUTH, undefined);
});

describe("update_event rename → planSlugRename('event')", () => {
  it("a rename onto a taken slug gets the collision suffix and an event_slug_history row", async () => {
    const res = await call("update_event", { event_id: "ev-1", name: "Harvest Fair" });
    expect(res.isError).toBeFalsy();
    expect(all(`SELECT slug FROM events WHERE id='ev-1'`)).toEqual([{ slug: "harvest-fair-2" }]);
    expect(all(`SELECT event_id, old_slug, new_slug, changed_by FROM event_slug_history`)).toEqual([
      {
        event_id: "ev-1",
        old_slug: "kingfield-craft-fair",
        new_slug: "harvest-fair-2",
        changed_by: "u-admin",
      },
    ]);
  });

  it("an explicit slug wins and is recorded", async () => {
    await call("update_event", { event_id: "ev-1", slug: "kingfield-fair-2026" });
    expect(all(`SELECT old_slug, new_slug FROM event_slug_history`)).toEqual([
      { old_slug: "kingfield-craft-fair", new_slug: "kingfield-fair-2026" },
    ]);
  });

  it("re-sending the current name does not walk a suffixed slug or write history", async () => {
    const res = await call("update_event", {
      event_id: "ev-3",
      name: "Harvest Fair",
      description: "Same fair, new copy",
    });
    expect(res.isError).toBeFalsy();
    expect(all(`SELECT slug FROM events WHERE id='ev-3'`)).toEqual([{ slug: "harvest-fair-1" }]);
    expect(all(`SELECT * FROM event_slug_history`)).toEqual([]);
  });

  it("a failing history INSERT fails the rename instead of being swallowed", async () => {
    raw["exec"](
      `CREATE TRIGGER boom BEFORE INSERT ON event_slug_history BEGIN SELECT RAISE(ABORT, 'history down'); END;`
    );
    await expect(
      call("update_event", { event_id: "ev-1", name: "Totally New Name" })
    ).rejects.toThrow(/history down/);
  });
});
