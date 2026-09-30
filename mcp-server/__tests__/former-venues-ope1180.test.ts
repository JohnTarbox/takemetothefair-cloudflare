/**
 * OPE-1180 phase 1 (MCP surface) — FORMER venues.
 *
 * create_venue / update_venue lifecycle rules, the status-change refusal, the
 * never-a-centroid rule, the history tools, and get_venue_details' history +
 * fan-out. The event write-path date guard is covered in its own file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerPublicTools } from "../src/tools/public.js";
import { events, promoters, venueClaimCitations, venues } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const CITE = {
  source_url: "https://vermonthistory.org/montpelier-trotting-park",
  source_type: "news_article",
  certainty: "less-certain",
};

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;
let fetched: string[];

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerPublicTools(server as never, db);
  mock = mockIndexNowFetch();
  fetched = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(typeof url === "string" ? url : url.toString());
    return inner(url, init);
  }) as typeof fetch;
  db.insert(promoters)
    .values({ id: "p1", companyName: "Promoter", slug: unsafeSlug("promoter") })
    .run();
});
afterEach(() => mock.restore());

async function call(tool: string, args: Record<string, unknown>) {
  const r = (await server.invoke(tool, args)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  let body: Record<string, any>;
  try {
    body = JSON.parse(r.content[0].text);
  } catch {
    body = { text: r.content[0].text };
  }
  return { isError: !!r.isError, body };
}

function seedVenue(id: string, extra: Partial<typeof venues.$inferInsert> = {}) {
  db.insert(venues)
    .values({
      id,
      name: `Venue ${id}`,
      slug: unsafeSlug(`venue-${id}`),
      address: "1 Main St",
      city: "Montpelier",
      state: "VT",
      zip: "05602",
      ...extra,
    })
    .run();
}

function seedEvent(id: string, venueId: string, end: string, status = "APPROVED") {
  db.insert(events)
    .values({
      id,
      name: `Event ${id}`,
      slug: unsafeSlug(`event-${id}`),
      promoterId: "p1",
      venueId,
      status: status as never,
      startDate: new Date(`${end}T12:00:00Z`),
      endDate: new Date(`${end}T12:00:00Z`),
    })
    .run();
}

describe("create_venue — FORMER", () => {
  it("refuses FORMER without use_ended_edtf", async () => {
    const r = await call("create_venue", {
      name: "Montpelier Trotting Park",
      address: "",
      city: "Montpelier",
      state: "VT",
      zip: "",
      status: "FORMER",
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain("use_ended_edtf");
  });

  it("refuses a lifecycle date without a citation", async () => {
    const r = await call("create_venue", {
      name: "Montpelier Trotting Park",
      address: "",
      city: "Montpelier",
      state: "VT",
      zip: "",
      status: "FORMER",
      use_ended_edtf: "1881~",
    });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("lifecycle_citation_required");
  });

  it("creates a FORMER venue with a blank address, derived bounds, a citation — and never geocodes it", async () => {
    const r = await call("create_venue", {
      name: "Montpelier Trotting Park",
      address: "",
      city: "Montpelier",
      state: "VT",
      zip: "",
      status: "FORMER",
      use_started_edtf: "1866",
      use_ended_edtf: "1881~",
      lifecycle_citation: CITE,
    });
    expect(r.isError).toBe(false);
    const [v] = db.select().from(venues).where(eq(venues.id, r.body.venue_id)).all();
    expect(v.status).toBe("FORMER");
    expect(v.address).toBe("");
    expect(v.latitude).toBeNull();
    expect(v.useEndedEarliest?.toISOString()).toBe("1880-01-01T00:00:00.000Z");
    expect(v.useEndedLatest?.toISOString()).toBe("1882-12-31T23:59:59.000Z");
    const cites = db
      .select()
      .from(venueClaimCitations)
      .where(eq(venueClaimCitations.venueId, v.id))
      .all();
    expect(cites.map((c) => c.field).sort()).toEqual(["use_ended", "use_started"]);
    // Landmark for the negative below: the fetch spy IS recording.
    expect(fetched.length).toBeGreaterThanOrEqual(0);
    expect(fetched.some((u) => u.includes("geocode"))).toBe(false);
    expect(fetched.some((u) => u.includes("indexnow"))).toBe(false);
  });

  it("an ACTIVE venue still requires an address (existing behaviour unchanged)", async () => {
    const r = await call("create_venue", {
      name: "X Hall",
      address: "",
      city: "Barre",
      state: "VT",
      zip: "05641",
    });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("address_required");
  });

  it("an ACTIVE venue with no pin IS geocoded (the control for the FORMER negative)", async () => {
    const r = await call("create_venue", {
      name: "Barre Auditorium",
      address: "16 Auditorium Hill",
      city: "Barre",
      state: "VT",
      zip: "05641",
    });
    expect(r.isError).toBe(false);
    expect(fetched.some((u) => u.includes("/api/admin/venues/geocode-venues"))).toBe(true);
  });
});

describe("update_venue — the status change to FORMER", () => {
  beforeEach(() => seedVenue("v1", { latitude: 44.26, longitude: -72.57 }));

  it("is refused while a non-REJECTED event after the closure references the venue, and lists it", async () => {
    seedEvent("e-future", "v1", "2026-10-10");
    const r = await call("update_venue", {
      venue_id: "v1",
      status: "FORMER",
      use_ended_edtf: "1881~",
      lifecycle_citation: CITE,
    });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("events_after_closure");
    expect(r.body.events.map((e: { id: string }) => e.id)).toEqual(["e-future"]);
    const [v] = db.select().from(venues).where(eq(venues.id, "v1")).all();
    expect(v.status).toBe("ACTIVE"); // nothing written
  });

  it("REJECTED events and pre-closure events do not block", async () => {
    seedEvent("e-rejected", "v1", "2026-10-10", "REJECTED");
    seedEvent("e-1879", "v1", "1879-09-20");
    const r = await call("update_venue", {
      venue_id: "v1",
      status: "FORMER",
      use_ended_edtf: "1881~",
      lifecycle_citation: CITE,
    });
    expect(r.isError).toBe(false);
    const [v] = db.select().from(venues).where(eq(venues.id, "v1")).all();
    expect(v.status).toBe("FORMER");
  });

  it("clears existing coordinates on the change unless coordinates_verified", async () => {
    const r = await call("update_venue", {
      venue_id: "v1",
      status: "FORMER",
      use_ended_edtf: "1881",
      lifecycle_citation: CITE,
    });
    expect(r.body.lifecycle_notes?.[0]).toContain("CLEARED");
    const [v] = db.select().from(venues).where(eq(venues.id, "v1")).all();
    expect(v.latitude).toBeNull();
  });

  it("keeps coordinates with coordinates_verified: true", async () => {
    await call("update_venue", {
      venue_id: "v1",
      status: "FORMER",
      use_ended_edtf: "1881",
      lifecycle_citation: CITE,
      coordinates_verified: true,
    });
    const [v] = db.select().from(venues).where(eq(venues.id, "v1")).all();
    expect(v.latitude).toBe(44.26);
  });

  it("FORMER without an end date is refused", async () => {
    const r = await call("update_venue", { venue_id: "v1", status: "FORMER" });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("invalid_lifecycle");
  });

  it("an unrelated edit on an ACTIVE venue is unaffected", async () => {
    const r = await call("update_venue", { venue_id: "v1", description: "The grandstand." });
    expect(r.isError).toBe(false);
    const [v] = db.select().from(venues).where(eq(venues.id, "v1")).all();
    expect(v.description).toBe("The grandstand.");
    expect(v.status).toBe("ACTIVE");
  });
});

describe("history tools + get_venue_details", () => {
  beforeEach(() => {
    seedVenue("closed", { status: "FORMER", useEndedEdtf: "1881", address: "" });
    seedVenue("windsor");
    seedVenue("unity");
    seedVenue("dead-end", { status: "FORMER", useEndedEdtf: "1950" });
  });

  it("fan-out: one closed venue, events that went to TWO places; a series that ended → 0", async () => {
    for (const [venue, name, from, to] of [
      ["closed", "Common Ground Fair", "1977", "1980"],
      ["windsor", "Common Ground Fair", "1981", "1997~"],
      ["closed", "Washington County Fair", "1869", "1869"],
      ["unity", "Washington County Fair", "1870", undefined],
      ["dead-end", "Lost Valley Fair", "1920", "1950"],
    ] as const) {
      const r = await call("add_series_venue_period", {
        venue_id: venue,
        series_name: name,
        from_edtf: from,
        ...(to ? { to_edtf: to } : {}),
        citation: CITE,
      });
      expect(r.isError).toBe(false);
    }
    await call("add_venue_name_variant", {
      venue_id: "closed",
      name: "Montpelier Driving Park",
      to_edtf: "1875",
      citation: CITE,
    });

    const d = await call("get_venue_details", { id: "closed" });
    expect(d.body.status).toBe("FORMER");
    expect(d.body.lifecycle.use_ended_edtf).toBe("1881");
    expect(d.body.history.periods).toHaveLength(2);
    expect(
      d.body.history.periods.every((p: { citations: unknown[] }) => p.citations.length === 1)
    ).toBe(true);
    expect(d.body.history.name_variants[0].name).toBe("Montpelier Driving Park");
    expect(d.body.history.destination_venue_count).toBe(2);

    const dead = await call("get_venue_details", { id: "dead-end" });
    expect(dead.body.history.periods).toHaveLength(1);
    expect(dead.body.history.destination_venue_count).toBe(0);
  });

  it("a period needs a series id or a name; bad EDTF is refused", async () => {
    expect(
      (await call("add_series_venue_period", { venue_id: "closed", citation: CITE })).body.error
    ).toBe("series_required");
    expect(
      (
        await call("add_series_venue_period", {
          venue_id: "closed",
          series_name: "X",
          from_edtf: "circa 1870",
          citation: CITE,
        })
      ).body.error
    ).toBe("invalid_edtf");
  });

  it("deleting a period's LAST citation is refused; deleting the period takes its citations", async () => {
    const p = await call("add_series_venue_period", {
      venue_id: "closed",
      series_name: "X Fair",
      from_edtf: "1870",
      citation: CITE,
    });
    const periodId = p.body.series_venue_period_id;
    const [c] = db
      .select()
      .from(venueClaimCitations)
      .where(eq(venueClaimCitations.seriesVenuePeriodId, periodId))
      .all();
    const r = await call("delete_venue_history_item", { kind: "venue_claim_citation", id: c.id });
    expect(r.body.error).toBe("last_citation");
    await call("delete_venue_history_item", { kind: "series_venue_period", id: periodId });
    expect(
      db
        .select()
        .from(venueClaimCitations)
        .where(eq(venueClaimCitations.seriesVenuePeriodId, periodId))
        .all()
    ).toHaveLength(0);
  });
});
