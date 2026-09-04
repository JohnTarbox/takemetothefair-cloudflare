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
    // OPE-791 — this used to assert NULL here, which was the defect: creation
    // requires `source_url`, so the appearance HAD been grounded and was still
    // born "never verified". It is now stamped at creation from the creating
    // source, and the assertion below is that a status call MOVES the stamp to
    // the newer source rather than setting it for the first time.
    expect(before.lastVerifiedAt).not.toBeNull();
    expect(before.lastVerifiedSource).toBe("https://fair.example/lineup");

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

/**
 * OPE-791 — the write IS the verification.
 *
 * Both `link_performer_to_event` and `create_or_link_performer` REQUIRE
 * `source_url`, so an appearance cannot be created without the caller having
 * grounded it against the organizer's own page. Neither stamped
 * `last_verified_at`, so a just-grounded appearance was born "never verified"
 * and read as stale to the OPE-123 rail immediately.
 *
 * 25 of the 26 appearances created since 2026-08-25 survived only because an
 * agent happened to follow the link call with a status call. That habit was the
 * only thing holding the invariant, and one row (`1dfc38ae…`, Kylie Morgan @
 * oxford-fair) escaped it.
 */
describe("appearance creation stamps its own verification (OPE-791)", () => {
  it("create_or_link_performer stamps last_verified_at + source at creation", async () => {
    await call("create_or_link_performer", {
      event_id: "e1",
      name: "Windsor Fair Headliner",
      status: "CONFIRMED",
      source_url: "https://windsorfair.example/lineup.png",
    });
    const [row] = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
    expect(row.lastVerifiedAt).not.toBeNull();
    expect(row.lastVerifiedSource).toBe("https://windsorfair.example/lineup.png");
  });

  it("link_performer_to_event does too — one helper, both tools", async () => {
    // The fix lives in the shared `linkAppearance`, so both callers inherit it.
    // Fixing only one is the "wired into one of two parallel paths" shape.
    await call("create_or_link_performer", {
      event_id: "e1",
      name: "Solo Act",
      status: "PENDING",
      source_url: "https://fair.example/first",
    });
    const [seeded] = await db
      .select()
      .from(eventPerformers)
      .where(eq(eventPerformers.eventId, "e1"));
    await db.delete(eventPerformers).where(eq(eventPerformers.id, seeded.id)).run();

    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: seeded.performerId,
      status: "PENDING",
      source_url: "https://fair.example/schedule",
    });
    const [row] = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
    expect(row.lastVerifiedAt).not.toBeNull();
    expect(row.lastVerifiedSource).toBe("https://fair.example/schedule");
  });

  it("a REPEAT link refreshes the stamp instead of no-op'ing, and does not duplicate", async () => {
    // Reaching the helper again means somebody re-grounded the appearance. The
    // old code returned the row untouched and threw that fact away.
    //
    // NOTE the `performer_id`: create_or_link_performer's fuzzy dedup returns
    // CANDIDATES for a same-name repeat rather than linking, so a repeat by name
    // never reaches linkAppearance at all. My first draft of this test did that
    // and was asserting on a path it never exercised.
    await call("create_or_link_performer", {
      event_id: "e1",
      name: "Repeat Act",
      status: "PENDING",
      source_url: "https://fair.example/v1",
    });
    const [first] = await db
      .select()
      .from(eventPerformers)
      .where(eq(eventPerformers.eventId, "e1"));

    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: first.performerId,
      status: "PENDING",
      source_url: "https://fair.example/v2-rechecked",
    });

    const rows = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
    expect(rows).toHaveLength(1); // idempotent — no duplicate row
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].lastVerifiedSource).toBe("https://fair.example/v2-rechecked");
  });

  it("a repeat keeps the ORIGINAL source_url — provenance and freshness are different questions", async () => {
    // Where the appearance came from, and where it was last confirmed, are two
    // facts. Overwriting the first with the second loses the answer to it.
    await call("create_or_link_performer", {
      event_id: "e1",
      name: "Provenance Act",
      status: "PENDING",
      source_url: "https://fair.example/original",
    });
    const [first] = await db
      .select()
      .from(eventPerformers)
      .where(eq(eventPerformers.eventId, "e1"));
    await call("link_performer_to_event", {
      event_id: "e1",
      performer_id: first.performerId,
      status: "PENDING",
      source_url: "https://fair.example/recheck",
    });
    const [row] = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
    expect(row.sourceUrl).toBe("https://fair.example/original");
    expect(row.lastVerifiedSource).toBe("https://fair.example/recheck");
  });
});
