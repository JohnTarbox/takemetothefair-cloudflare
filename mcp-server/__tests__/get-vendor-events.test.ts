/**
 * K24 (2026-06-16) — get_vendor_events, the reverse of list_event_vendors.
 *
 * Pins the gating posture: the tool returns only PUBLIC events (publicEventWhere)
 * that the vendor is linked to via a PUBLIC vendor status (APPROVED/CONFIRMED),
 * so neither a non-public event nor a private application state (APPLIED/
 * REJECTED/WAITLISTED) ever leaks. Also covers since/until date bounds and the
 * vendor-not-found path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPublicTools } from "../src/tools/public.js";
import { events, eventVendors, promoters, users, vendors } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
  db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({
      id: "ven-1",
      userId: "u-v",
      businessName: "Acme Foods",
      slug: unsafeSlug("acme-foods"),
    })
    .run();
  registerPublicTools(server as never, db);
});

function seedEvent(opts: {
  id: string;
  name: string;
  slug: string;
  status?: string;
  lifecycle?: string;
  startDate?: Date;
  endDate?: Date;
}) {
  db.insert(events)
    .values({
      id: opts.id,
      name: opts.name,
      slug: unsafeSlug(opts.slug),
      promoterId: "promoter-1",
      status: opts.status ?? "APPROVED",
      lifecycleStatus: opts.lifecycle ?? "SCHEDULED",
      startDate: opts.startDate ?? new Date("2026-09-15T12:00:00Z"),
      endDate: opts.endDate ?? new Date("2026-09-15T12:00:00Z"),
    })
    .run();
}

function link(eventId: string, status: string, participation = "EXHIBITOR") {
  db.insert(eventVendors)
    .values({
      id: `ev-${eventId}`,
      eventId,
      vendorId: "ven-1",
      status,
      participationType: participation,
    })
    .run();
}

async function call(args: Record<string, unknown>) {
  const r = (await server.invoke("get_vendor_events", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: !!r.isError,
    payload: r.isError ? null : (JSON.parse(r.content[0].text) as Record<string, unknown>),
    errorText: r.isError ? r.content[0].text : null,
  };
}

describe("get_vendor_events (K24)", () => {
  it("returns only public events linked via a public vendor status", async () => {
    seedEvent({ id: "evt-a", name: "Approved Public Fair", slug: "a" });
    link("evt-a", "APPROVED", "EXHIBITOR");
    seedEvent({ id: "evt-b", name: "Confirmed Public Fair", slug: "b" });
    link("evt-b", "CONFIRMED", "SPONSOR_ONLY");
    // Non-public event (PENDING) — must be excluded even though the link is CONFIRMED.
    seedEvent({ id: "evt-c", name: "Pending Fair", slug: "c", status: "PENDING" });
    link("evt-c", "CONFIRMED");
    // Public event but a private/rejected link — must be excluded.
    seedEvent({ id: "evt-d", name: "Rejected-link Fair", slug: "d" });
    link("evt-d", "REJECTED");

    const { payload } = await call({ vendor_id: "ven-1" });
    const list = payload!.events as Array<Record<string, unknown>>;
    const ids = list.map((e) => e.event_id).sort();
    expect(ids).toEqual(["evt-a", "evt-b"]);

    const a = list.find((e) => e.event_id === "evt-a")!;
    expect(a.application_status).toBe("APPROVED");
    expect(a.participation_type).toBe("EXHIBITOR");
    expect(a.event_name).toBe("Approved Public Fair");
    expect(typeof a.dates).toBe("string");

    const b = list.find((e) => e.event_id === "evt-b")!;
    expect(b.application_status).toBe("CONFIRMED");
    expect(b.participation_type).toBe("SPONSOR_ONLY");
  });

  it("honors since/until date bounds", async () => {
    seedEvent({
      id: "evt-jun",
      name: "June Fair",
      slug: "jun",
      startDate: new Date("2026-06-10T12:00:00Z"),
      endDate: new Date("2026-06-10T12:00:00Z"),
    });
    link("evt-jun", "APPROVED");
    seedEvent({
      id: "evt-oct",
      name: "October Fair",
      slug: "oct",
      startDate: new Date("2026-10-10T12:00:00Z"),
      endDate: new Date("2026-10-10T12:00:00Z"),
    });
    link("evt-oct", "APPROVED");

    const sinceSep = await call({ vendor_id: "ven-1", since: "2026-09-01" });
    expect(
      (sinceSep.payload!.events as unknown[]).map((e) => (e as { event_id: string }).event_id)
    ).toEqual(["evt-oct"]);

    const untilSep = await call({ vendor_id: "ven-1", until: "2026-09-01" });
    expect(
      (untilSep.payload!.events as unknown[]).map((e) => (e as { event_id: string }).event_id)
    ).toEqual(["evt-jun"]);
  });

  it("returns isError for an unknown vendor", async () => {
    const { isError, errorText } = await call({ vendor_id: "nope" });
    expect(isError).toBe(true);
    expect(errorText).toContain("Vendor not found");
  });

  it("returns an empty list for a real vendor with no public links", async () => {
    const { payload } = await call({ vendor_id: "ven-1" });
    expect(payload!.count).toBe(0);
    expect(payload!.events).toEqual([]);
  });
});
