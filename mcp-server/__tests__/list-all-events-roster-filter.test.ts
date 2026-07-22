/**
 * OPE-264 — vendor-roster rails gap. `list_all_events` gains a
 * `vendor_roster_status` filter (multi-valued) + `sort` and returns the roster
 * research state per row, so the weekly drain (OPE-262) can select targets in
 * ONE call instead of guessing from search_events and pre-checking each event
 * with get_event_details.
 *
 * Also covers the OPE-264 provenance warning on set_vendor_roster_status: a
 * terminal verdict (HAS_ROSTER / NO_PUBLIC_LIST) written without a source_url is
 * un-auditable, so the tool warns (soft, mirroring PARTIAL-without-offset).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerVendorRosterTools } from "../src/tools/admin-vendor-roster.js";
import { events, eventVendors, promoters, users, vendors } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerVendorRosterTools(server as never, db, ADMIN_AUTH);

  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
  db.insert(users).values({ id: "u-v1", email: "v1@test", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({ id: "ven-1", userId: "u-v1", businessName: "Acme", slug: unsafeSlug("acme") })
    .run();
});

function seedEvent(opts: {
  id: string;
  name: string;
  slug: string;
  endDate: Date;
  rosterStatus?: "NEEDS_RESEARCH" | "HAS_ROSTER" | "NO_PUBLIC_LIST" | "PARTIAL" | null;
  rosterCheckedAt?: Date | null;
  rosterSourceUrl?: string | null;
  rosterOffset?: number | null;
}) {
  db.insert(events)
    .values({
      id: opts.id,
      name: opts.name,
      slug: unsafeSlug(opts.slug),
      promoterId: "p-1",
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      startDate: opts.endDate,
      endDate: opts.endDate,
      vendorRosterStatus: opts.rosterStatus ?? null,
      vendorRosterCheckedAt: opts.rosterCheckedAt ?? null,
      vendorRosterSourceUrl: opts.rosterSourceUrl ?? null,
      vendorRosterOffset: opts.rosterOffset ?? null,
    })
    .run();
}

function linkVendors(eventId: string, n: number) {
  for (let i = 0; i < n; i++) {
    // Distinct vendor per link — event_vendors has a UNIQUE (event_id, vendor_id).
    const vendorId = `ven-${eventId}-${i}`;
    const userId = `u-${vendorId}`;
    db.insert(users)
      .values({ id: userId, email: `${userId}@test`, role: "VENDOR" })
      .run();
    db.insert(vendors)
      .values({ id: vendorId, userId, businessName: `V${i}`, slug: unsafeSlug(vendorId) })
      .run();
    db.insert(eventVendors)
      .values({
        id: `ev-${eventId}-${i}`,
        eventId,
        vendorId,
        status: "CONFIRMED",
        participationType: "EXHIBITOR",
      })
      .run();
  }
}

async function listEvents(args: Record<string, unknown>) {
  const r = (await server.invoke("list_all_events", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return JSON.parse(r.content[0].text) as {
    count: number;
    events: Array<{
      id: string;
      slug: string;
      vendor_count: number;
      vendor_roster_status: string | null;
      vendor_roster_checked_at: string | null;
      vendor_roster_source_url: string | null;
      vendor_roster_offset: number | null;
    }>;
  };
}

describe("list_all_events — vendor_roster_status filter (OPE-264)", () => {
  it("returns only events matching a single roster status", async () => {
    seedEvent({
      id: "e-needs",
      name: "Needs",
      slug: "needs",
      endDate: new Date("2026-08-01"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    seedEvent({
      id: "e-has",
      name: "Has",
      slug: "has",
      endDate: new Date("2026-08-02"),
      rosterStatus: "HAS_ROSTER",
    });
    seedEvent({
      id: "e-null",
      name: "Never",
      slug: "never",
      endDate: new Date("2026-08-03"),
      rosterStatus: null,
    });

    const out = await listEvents({ vendor_roster_status: ["NEEDS_RESEARCH"] });
    expect(out.events.map((e) => e.id)).toEqual(["e-needs"]);
    expect(out.events[0].vendor_roster_status).toBe("NEEDS_RESEARCH");
  });

  it("is multi-valued (OR across statuses)", async () => {
    seedEvent({
      id: "e-needs",
      name: "Needs",
      slug: "needs",
      endDate: new Date("2026-08-01"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    seedEvent({
      id: "e-has",
      name: "Has",
      slug: "has",
      endDate: new Date("2026-08-02"),
      rosterStatus: "HAS_ROSTER",
    });
    seedEvent({
      id: "e-partial",
      name: "Partial",
      slug: "partial",
      endDate: new Date("2026-08-03"),
      rosterStatus: "PARTIAL",
    });

    const out = await listEvents({ vendor_roster_status: ["HAS_ROSTER", "PARTIAL"] });
    expect(out.events.map((e) => e.id).sort()).toEqual(["e-has", "e-partial"]);
  });

  it("surfaces the PARTIAL resume offset so a crashed run is locatable (2nd symptom)", async () => {
    seedEvent({
      id: "e-partial",
      name: "Foxboro",
      slug: "foxboro",
      endDate: new Date("2026-08-03"),
      rosterStatus: "PARTIAL",
      rosterOffset: 60,
    });
    const out = await listEvents({ vendor_roster_status: ["PARTIAL"] });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].vendor_roster_offset).toBe(60);
  });

  it("returns vendor_count so populated-but-unstamped events are visible", async () => {
    // The self-perpetuating case: NEEDS_RESEARCH yet already has vendors linked.
    seedEvent({
      id: "e-pop",
      name: "Auburn Home Show",
      slug: "auburn",
      endDate: new Date("2026-08-01"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    linkVendors("e-pop", 3);
    const out = await listEvents({ vendor_roster_status: ["NEEDS_RESEARCH"] });
    expect(out.events[0].vendor_count).toBe(3);
  });

  it("exposes checked_at/source_url on terminal rows (audits null-source verdicts)", async () => {
    seedEvent({
      id: "e-has",
      name: "Boat Show",
      slug: "boat",
      endDate: new Date("2026-08-02"),
      rosterStatus: "HAS_ROSTER",
      rosterCheckedAt: new Date("2026-07-01T00:00:00Z"),
      rosterSourceUrl: null, // the un-auditable case the ticket flags
    });
    const out = await listEvents({ vendor_roster_status: ["HAS_ROSTER"] });
    expect(out.events[0].vendor_roster_checked_at).toBe("2026-07-01T00:00:00.000Z");
    expect(out.events[0].vendor_roster_source_url).toBeNull();
  });

  it("sorts by end_date desc (most-recently-ended first)", async () => {
    seedEvent({
      id: "e-old",
      name: "Old",
      slug: "old",
      endDate: new Date("2026-06-01"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    seedEvent({
      id: "e-new",
      name: "New",
      slug: "new",
      endDate: new Date("2026-09-01"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    seedEvent({
      id: "e-mid",
      name: "Mid",
      slug: "mid",
      endDate: new Date("2026-07-15"),
      rosterStatus: "NEEDS_RESEARCH",
    });
    const out = await listEvents({
      vendor_roster_status: ["NEEDS_RESEARCH"],
      sort: "end_date_desc",
    });
    expect(out.events.map((e) => e.id)).toEqual(["e-new", "e-mid", "e-old"]);
  });

  it("leaves default (no roster filter / no sort) behaviour intact", async () => {
    seedEvent({
      id: "e-1",
      name: "One",
      slug: "one",
      endDate: new Date("2026-08-01"),
      rosterStatus: null,
    });
    const out = await listEvents({});
    expect(out.count).toBe(1);
    // roster fields are still present (null) on an unfiltered listing
    expect(out.events[0].vendor_roster_status).toBeNull();
    expect(out.events[0].vendor_count).toBe(0);
  });
});

describe("set_vendor_roster_status — provenance warning (OPE-264)", () => {
  async function setStatus(args: Record<string, unknown>) {
    const r = (await server.invoke("set_vendor_roster_status", args)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return JSON.parse(r.content[0].text) as { warnings: string[] };
  }

  beforeEach(() => {
    seedEvent({ id: "e-x", name: "X Fair", slug: "x-fair", endDate: new Date("2026-08-01") });
  });

  it("warns when HAS_ROSTER is set without a source_url", async () => {
    const out = await setStatus({ event_id: "e-x", status: "HAS_ROSTER" });
    expect(out.warnings.some((w) => w.includes("cannot be audited"))).toBe(true);
  });

  it("warns when NO_PUBLIC_LIST is set without a source_url", async () => {
    const out = await setStatus({ event_id: "e-x", status: "NO_PUBLIC_LIST" });
    expect(out.warnings.some((w) => w.includes("cannot be audited"))).toBe(true);
  });

  it("does not warn when a terminal status includes a source_url", async () => {
    const out = await setStatus({
      event_id: "e-x",
      status: "HAS_ROSTER",
      source_url: "https://example.com/exhibitors",
    });
    expect(out.warnings.some((w) => w.includes("cannot be audited"))).toBe(false);
  });
});
