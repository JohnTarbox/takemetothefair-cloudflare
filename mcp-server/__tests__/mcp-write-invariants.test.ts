/**
 * K25 — MCP write-authority invariant regression suite.
 *
 * This file is the executable counterpart to docs/mcp-write-invariants.md.
 * It pins the five write-authority guarantees the MCP tool surface relies on
 * so a future change — in particular the calendar-module v2 write surface
 * (drag-to-edit, click-to-create) — cannot silently regress one of them.
 *
 * Each `describe` block maps to one numbered invariant in the doc. If a block
 * goes red, the doc's "how it's enforced" row for that invariant is no longer
 * true. See the doc for the canonical bug each one prevents.
 *
 * Harness: in-memory SQLite + CapturingMcpServer (see setup-db.ts). The same
 * pattern as citations.test.ts / create-or-link-vendor.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerEventLifecycleTools } from "../src/tools/admin-event-lifecycle.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { eventDataCitations, eventDays, events, promoters, users, vendors } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let indexnow: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerEventLifecycleTools(server as never, db, ADMIN_AUTH, ENV as never);
  indexnow = mockIndexNowFetch();
});

afterEach(() => {
  indexnow.restore();
});

// ── helpers ──────────────────────────────────────────────────────────────

function seedPromoter(id = "promoter-1") {
  db.insert(promoters)
    .values({ id, companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
  return id;
}

/** Seed an APPROVED event. createdAt is explicit so tests can make one row
 *  the unambiguous "most recent" decoy for the wrong-echo checks. */
function seedEvent(opts: { id: string; name: string; slug: string; createdAt: Date }) {
  db.insert(events)
    .values({
      id: opts.id,
      name: opts.name,
      slug: unsafeSlug(opts.slug),
      promoterId: "promoter-1",
      status: "APPROVED",
      createdAt: opts.createdAt,
    })
    .run();
}

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(`tool returned isError: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

// ── Invariant 1: wrong-echo under concurrency ──────────────────────────────
// create_*/update_* return the row they actually wrote, NOT a global
// most-recent row. Canonical bugs: update_event_status wrong-echo + K19
// create_vendor echo. We seed a NEWER decoy row in each case; a
// "SELECT ... ORDER BY created_at DESC LIMIT 1" regression would echo the
// decoy instead of the targeted/written row.

describe("invariant 1 — write echoes the row written, not the most-recent row", () => {
  it("update_event_status echoes the targeted event even when a newer event exists", async () => {
    seedPromoter();
    seedEvent({
      id: "evt-alpha",
      name: "Alpha Fair",
      slug: "alpha-fair",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Decoy: created LATER, so a most-recent query would surface this one.
    seedEvent({
      id: "evt-bravo",
      name: "Bravo Fair",
      slug: "bravo-fair",
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });

    const payload = parse(
      await server.invoke("update_event_status", { event_id: "evt-alpha", status: "REJECTED" })
    );

    const echoed = payload.event as { id: string; name: string };
    expect(echoed.id).toBe("evt-alpha");
    expect(echoed.name).toBe("Alpha Fair");
    // And the write actually landed on Alpha, not the decoy.
    const alpha = db.select().from(events).where(eq(events.id, "evt-alpha")).all()[0];
    const bravo = db.select().from(events).where(eq(events.id, "evt-bravo")).all()[0];
    expect(alpha.status).toBe("REJECTED");
    expect(bravo.status).toBe("APPROVED");
  });

  it("create_or_link_vendor echoes the vendor it created, not a newer decoy vendor", async () => {
    seedPromoter();
    seedEvent({
      id: "evt-host",
      name: "Host Fair",
      slug: "host-fair",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Decoy vendor created with the latest timestamp.
    db.insert(users).values({ id: "u-decoy", email: "decoy@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({
        id: "ven-decoy",
        userId: "u-decoy",
        businessName: "Decoy Co",
        slug: unsafeSlug("decoy-co"),
        createdAt: new Date("2026-06-10T00:00:00Z"),
      })
      .run();

    const payload = parse(
      await server.invoke("create_or_link_vendor", {
        event_id: "evt-host",
        business_name: "Target Co",
      })
    );

    expect(payload.was_created).toBe(true);
    // The echoed vendor_id must resolve to the row we just wrote ("Target Co"),
    // never the newer decoy.
    const echoedId = payload.vendor_id as string;
    expect(echoedId).not.toBe("ven-decoy");
    const row = db.select().from(vendors).where(eq(vendors.id, echoedId)).all()[0];
    expect(row.businessName).toBe("Target Co");
  });
});

// ── Invariant 2: idempotent event_days IDs ─────────────────────────────────
// Repeated create_event_day for the same (event_id, date) must NOT fork a
// duplicate occurrence. Closed in K25 (was: unconditional crypto.randomUUID()).

describe("invariant 2 — create_event_day is idempotent on (event_id, date)", () => {
  beforeEach(() => {
    seedPromoter();
    seedEvent({
      id: "evt-series",
      name: "Series Market",
      slug: "series-market",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("a repeat create returns the existing day and does not fork a row", async () => {
    const first = parse(
      await server.invoke("create_event_day", {
        event_id: "evt-series",
        date: "2026-09-15",
        open_time: "10:00",
        close_time: "17:00",
      })
    );
    expect(first.created).toBe(true);

    const second = parse(
      await server.invoke("create_event_day", {
        event_id: "evt-series",
        date: "2026-09-15",
        open_time: "11:00", // different args — still a no-op create
        close_time: "18:00",
      })
    );
    expect(second.created).toBe(false);
    expect(second.already_exists).toBe(true);
    expect(second.id).toBe(first.id);

    const rows = db
      .select()
      .from(eventDays)
      .where(and(eq(eventDays.eventId, "evt-series"), eq(eventDays.date, "2026-09-15")))
      .all();
    expect(rows).toHaveLength(1);
    // First write's hours are preserved — the second create did not overwrite.
    expect(rows[0].openTime).toBe("10:00");
  });

  it("distinct dates on the same event still create distinct rows", async () => {
    await server.invoke("create_event_day", { event_id: "evt-series", date: "2026-09-15" });
    await server.invoke("create_event_day", { event_id: "evt-series", date: "2026-09-16" });
    const rows = db.select().from(eventDays).where(eq(eventDays.eventId, "evt-series")).all();
    expect(rows).toHaveLength(2);
  });
});

// ── Invariant 3: citations on tracked-field event mutations ────────────────
// When update_event changes a tracked field AND provenance is supplied, a
// citation row is written and any prior active citation for the same
// (event, field, year) is superseded. (The system records provenance when
// given; it does not fabricate a citation when none is supplied — that
// conditional is the invariant, and is pinned here so v2 can't drop the wire.)

describe("invariant 3 — tracked-field updates record + supersede citations", () => {
  beforeEach(() => {
    seedPromoter();
    seedEvent({
      id: "evt-cite",
      name: "Cite Fair",
      slug: "cite-fair",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  function activeCitations(field: string) {
    return db
      .select()
      .from(eventDataCitations)
      .where(
        and(
          eq(eventDataCitations.eventId, "evt-cite"),
          eq(eventDataCitations.fieldName, field),
          eq(eventDataCitations.state, "active")
        )
      )
      .all();
  }

  it("writes a citation for a tracked field and supersedes the prior active one", async () => {
    await server.invoke("update_event", {
      event_id: "evt-cite",
      estimated_attendance: 1000,
      citation: { source_url: "https://example.org/a", source_type: "official_website" },
    });
    expect(activeCitations("estimated_attendance")).toHaveLength(1);

    await server.invoke("update_event", {
      event_id: "evt-cite",
      estimated_attendance: 2000,
      citation: { source_url: "https://example.org/b", source_type: "official_website" },
    });
    const active = activeCitations("estimated_attendance");
    expect(active).toHaveLength(1); // still exactly one active …
    expect(active[0].value).toContain("2000"); // … and it's the newest
    const superseded = db
      .select()
      .from(eventDataCitations)
      .where(
        and(eq(eventDataCitations.eventId, "evt-cite"), eq(eventDataCitations.state, "superseded"))
      )
      .all();
    expect(superseded).toHaveLength(1);
  });

  it("does not fabricate a citation when none is supplied", async () => {
    await server.invoke("update_event", { event_id: "evt-cite", estimated_attendance: 1500 });
    expect(activeCitations("estimated_attendance")).toHaveLength(0);
  });
});

// ── Invariant 4: date anchor noon-UTC, never midnight ──────────────────────
// Every write that anchors a timestamp-typed event date must land at 12:00
// UTC, not 00:00 — midnight UTC renders as the PREVIOUS calendar day in US
// (EDT/EST) zones. Enforced via normalizeEventDate from @takemetothefair/utils.

describe("invariant 4 — event-date writes anchor at noon UTC", () => {
  it("update_event anchors a bare YYYY-MM-DD start_date at noon UTC", async () => {
    seedPromoter();
    seedEvent({
      id: "evt-anchor",
      name: "Anchor Fair",
      slug: "anchor-fair",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    await server.invoke("update_event", { event_id: "evt-anchor", start_date: "2026-09-15" });

    const row = db.select().from(events).where(eq(events.id, "evt-anchor")).all()[0];
    const d = row.startDate as Date;
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8); // September (0-indexed)
    expect(d.getUTCDate()).toBe(15); // not shifted to the 14th
    expect(d.getUTCHours()).toBe(12); // noon, not midnight
  });

  it("suggest_event anchors a bare YYYY-MM-DD start_date at noon UTC", async () => {
    db.insert(users).values({ id: "u-sub", email: "sub@test", role: "USER" }).run();
    const vendorServer = new CapturingMcpServer();
    registerVendorTools(vendorServer as never, db, { userId: "u-sub", role: "USER" }, undefined);

    const payload = parse(
      await vendorServer.invoke("suggest_event", {
        name: "Community Pumpkin Festival",
        start_date: "2026-09-15",
      })
    );
    const eventId = (payload.event as { id: string }).id;

    const row = db.select().from(events).where(eq(events.id, eventId)).all()[0];
    const d = row.startDate as Date;
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(12);
  });
});

// ── Invariant 5: merge preview before mutation ─────────────────────────────
// merge_events(preview=true) must produce a preview WITHOUT committing the
// merge. preview=false (default) commits. We record which endpoint the tool
// calls; the preview path must never hit the committing /merge endpoint.

describe("invariant 5 — merge_events previews before it mutates", () => {
  let fetchCalls: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      fetchCalls.push(typeof url === "string" ? url : url.toString());
      return new Response(JSON.stringify({ success: true, mergedEntity: { slug: "keeper" } }), {
        status: 200,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("preview=true hits the preview endpoint and never the committing merge endpoint", async () => {
    await server.invoke("merge_events", {
      keeper_event_id: "evt-keeper",
      duplicate_event_id: "evt-dup",
      preview: true,
    });
    expect(fetchCalls.some((u) => u.includes("/api/admin/duplicates/preview"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("/api/admin/duplicates/merge"))).toBe(false);
  });

  it("the committing path (preview omitted) does call the merge endpoint", async () => {
    await server.invoke("merge_events", {
      keeper_event_id: "evt-keeper",
      duplicate_event_id: "evt-dup",
    });
    expect(fetchCalls.some((u) => u.includes("/api/admin/duplicates/merge"))).toBe(true);
  });

  it("refuses to merge an event into itself (no fetch at all)", async () => {
    const r = (await server.invoke("merge_events", {
      keeper_event_id: "evt-same",
      duplicate_event_id: "evt-same",
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });
});
