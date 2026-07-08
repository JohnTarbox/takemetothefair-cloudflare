/**
 * OPE-123 — performer-lineup freshness/verification layer.
 *
 *   - set_event_performer_status / _slot stamp event_performers.last_verified_at
 *     (+ last_verified_source when provided)
 *   - set_performer_roster_status writes events.performer_roster_status; terminal
 *     statuses stamp performer_roster_checked_at + source_url; NEEDS_RESEARCH
 *     clears them
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventPerformers, events, promoters } from "../src/schema.js";

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

async function makeAppearance(): Promise<string> {
  await call("create_or_link_performer", {
    event_id: "e1",
    name: "Mr. Drew and His Animals Too",
    status: "PENDING",
    source_url: "https://fair.example/lineup",
  });
  const [row] = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
  return row.id;
}

describe("appearance verification stamp (OPE-123)", () => {
  it("set_event_performer_status stamps last_verified_at + source", async () => {
    const apprId = await makeAppearance();
    const [before] = await db.select().from(eventPerformers).where(eq(eventPerformers.id, apprId));
    expect(before.lastVerifiedAt).toBeNull();

    await call("set_event_performer_status", {
      event_performer_id: apprId,
      status: "CONFIRMED",
      verified_source: "https://fair.example/lineup-final",
    });

    const [after] = await db.select().from(eventPerformers).where(eq(eventPerformers.id, apprId));
    expect(after.status).toBe("CONFIRMED");
    expect(after.lastVerifiedAt).not.toBeNull();
    expect(after.lastVerifiedSource).toBe("https://fair.example/lineup-final");
  });

  it("set_event_performer_slot also stamps last_verified_at", async () => {
    const apprId = await makeAppearance();
    await call("set_event_performer_slot", { event_performer_id: apprId, stage: "Main Stage" });
    const [after] = await db.select().from(eventPerformers).where(eq(eventPerformers.id, apprId));
    expect(after.stage).toBe("Main Stage");
    expect(after.lastVerifiedAt).not.toBeNull();
  });
});

describe("set_performer_roster_status (OPE-123)", () => {
  it("VERIFIED stamps checked_at + source_url", async () => {
    const r = await call("set_performer_roster_status", {
      event_id: "e1",
      status: "VERIFIED",
      source_url: "https://fair.example/schedule",
    });
    expect(r.success).toBe(true);
    expect(r.checked_at).not.toBeNull();
    const [ev] = await db.select().from(events).where(eq(events.id, "e1"));
    expect(ev.performerRosterStatus).toBe("VERIFIED");
    expect(ev.performerRosterCheckedAt).not.toBeNull();
    expect(ev.performerRosterSourceUrl).toBe("https://fair.example/schedule");
  });

  it("NO_LINEUP_PUBLISHED is a terminal (sticky) state that stamps checked_at", async () => {
    await call("set_performer_roster_status", { event_id: "e1", status: "NO_LINEUP_PUBLISHED" });
    const [ev] = await db.select().from(events).where(eq(events.id, "e1"));
    expect(ev.performerRosterStatus).toBe("NO_LINEUP_PUBLISHED");
    expect(ev.performerRosterCheckedAt).not.toBeNull();
  });

  it("NEEDS_RESEARCH clears checked_at + source (fresh attempt)", async () => {
    await call("set_performer_roster_status", {
      event_id: "e1",
      status: "VERIFIED",
      source_url: "https://fair.example/schedule",
    });
    await call("set_performer_roster_status", { event_id: "e1", status: "NEEDS_RESEARCH" });
    const [ev] = await db.select().from(events).where(eq(events.id, "e1"));
    expect(ev.performerRosterStatus).toBe("NEEDS_RESEARCH");
    expect(ev.performerRosterCheckedAt).toBeNull();
    expect(ev.performerRosterSourceUrl).toBeNull();
  });

  it("resolves by event_slug and 404s a missing event", async () => {
    const ok = await call("set_performer_roster_status", {
      event_slug: "fair",
      status: "VERIFIED",
    });
    expect(ok.success).toBe(true);
    const bad = await call("set_performer_roster_status", {
      event_id: "nope",
      status: "VERIFIED",
    });
    expect(bad.error).toBe("not_found");
  });
});
