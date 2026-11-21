/**
 * OPE-1622 — John's 2026-11-10 rulings (OPE-86) encoded in the citation_flag
 * path, plus the two tool gaps the ruling session hit.
 *
 * Acceptance from the ticket:
 *   - a free-by-nature event with an uncited $0 and no ticket signal files NO
 *     citation_flag row;
 *   - the same event with a ticket_url still files one;
 *   - update_event can clear ticket_price_min/max.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import {
  events,
  promoters,
  venues,
  eventDiscrepancies,
  eventDataCitations,
  eventInternalNotes,
} from "../src/schema.js";
import { isTicketingUrl } from "../src/goodwill/community-default.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "ev-bethel-autumn";
const SRC = "https://bethelmaine.example/autumn-craft-festival";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

function seedEvent(over: Partial<typeof events.$inferInsert> = {}) {
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Bethel Autumn Craft Festival 2026",
      slug: "bethel-autumn-craft-festival-2026",
      promoterId: "p-1",
      status: "APPROVED",
      categories: JSON.stringify(["Craft Fair", "Festival"]),
      ticketPriceMinCents: 0,
      ticketPriceMaxCents: 0,
      startDate: new Date("2026-10-10T12:00:00Z"),
      ...over,
    })
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
});
afterEach(() => mock.restore());

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

function flagRows() {
  return db
    .select()
    .from(eventDiscrepancies)
    .where(
      and(
        eq(eventDiscrepancies.eventId, EVENT_ID),
        eq(eventDiscrepancies.detectedBy, "citation_flag")
      )
    )
    .all();
}

function internalNotes(): string | null {
  const [row] = db
    .select({ notes: eventInternalNotes.notes })
    .from(eventInternalNotes)
    .where(eq(eventInternalNotes.eventId, EVENT_ID))
    .all();
  return row?.notes ?? null;
}

/** The OPE-1259 pass's shape: cite what the page says, declare the $0 unsupported. */
async function flagUnsupportedZero(over: Record<string, unknown> = {}) {
  return parseJson(
    await server.invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "ticket_price_min",
      value: "0",
      source_url: SRC,
      source_type: "official_website",
      update_event_column: false,
      live_defect: {
        kind: "unsupported",
        reason: "No 2026 source states the admission price.",
      },
      ...over,
    })
  );
}

describe("ruling 1 — the unsourced community default", () => {
  it("files NO row for a free-by-nature event with no paid-ticket signal, and records the marker once", async () => {
    seedEvent();
    const res = await flagUnsupportedZero();
    expect(res.live_defects).toHaveLength(1);
    expect(res.live_defects[0]).toMatchObject({
      outcome: "community_default",
      discrepancy_id: null,
      field_class: "price",
      community_default_check: "free-by-nature category, no paid-ticket signal",
    });
    expect(flagRows()).toHaveLength(0);
    expect(internalNotes()).toContain(
      "[OPE-1622] $0 admission kept as the unsourced community default"
    );

    // The next pass re-observes it: still nothing filed, marker not repeated.
    await flagUnsupportedZero();
    expect(flagRows()).toHaveLength(0);
    expect(internalNotes()!.match(/\[OPE-1622\]/g)).toHaveLength(1);
  });

  it("keeps an operator's existing private note and appends to it", async () => {
    seedEvent();
    db.insert(eventInternalNotes)
      .values({
        eventId: EVENT_ID,
        notes: "Venue checked 10-01.",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    await flagUnsupportedZero();
    expect(internalNotes()).toMatch(/^Venue checked 10-01\.\n\[OPE-1622\]/);
  });

  it("still files when the event has a ticket_url (acceptance 2)", async () => {
    seedEvent({ ticketUrl: "https://bethelmaine.example/tickets" });
    const res = await flagUnsupportedZero();
    expect(res.live_defects[0]).toMatchObject({
      outcome: "created",
      community_default_check: "the event has a ticket_url",
    });
    expect(flagRows()).toHaveLength(1);
    expect(internalNotes()).toBeNull();
  });

  it("still files when an active citation links a ticketing platform (the Maynard ShoWare case)", async () => {
    seedEvent({ categories: JSON.stringify(["Porchfest", "Community Event"]) });
    db.insert(eventDataCitations)
      .values({
        eventId: EVENT_ID,
        fieldName: "description",
        value: "x",
        sourceUrl: "https://maynard.showare.com/eventperformances.asp?evt=12",
        sourceType: "other",
      })
      .run();
    const res = await flagUnsupportedZero();
    expect(res.live_defects[0].outcome).toBe("created");
    expect(res.live_defects[0].community_default_check).toContain("maynard.showare.com");
  });

  it("still files for a gated category even alongside a free one", async () => {
    seedEvent({ categories: JSON.stringify(["Agricultural Fair", "Festival"]) });
    const res = await flagUnsupportedZero();
    expect(res.live_defects[0]).toMatchObject({
      outcome: "created",
      community_default_check: 'gated category "agricultural fair"',
    });
  });

  it("still files with no free-by-nature category at all", async () => {
    seedEvent({ categories: JSON.stringify(["Other"]) });
    const res = await flagUnsupportedZero();
    expect(res.live_defects[0].outcome).toBe("created");
  });

  it("still files at a fairgrounds venue", async () => {
    db.insert(venues)
      .values({
        id: "v-1",
        name: "Fryeburg Fairgrounds",
        slug: "fryeburg-fairgrounds",
        address: "1154 Main St",
        city: "Fryeburg",
        state: "ME",
        zip: "04037",
      })
      .run();
    seedEvent({ venueId: "v-1" });
    const res = await flagUnsupportedZero();
    expect(res.live_defects[0]).toMatchObject({
      outcome: "created",
      community_default_check: "the venue is a fairgrounds",
    });
  });

  it("still files when a paid price is stored, or the live min is not $0", async () => {
    seedEvent({ ticketPriceMaxCents: 1000 });
    expect((await flagUnsupportedZero()).live_defects[0].outcome).toBe("created");
  });

  it("only covers `unsupported` admission: a contradicted $0 still files", async () => {
    seedEvent();
    const res = await flagUnsupportedZero({
      live_defect: {
        kind: "contradicted",
        reason: "Poster says $5 at the gate.",
        source_says: "5",
      },
    });
    expect(res.live_defects[0].outcome).toBe("created");
    expect(res.live_defects[0].community_default_check).toBeUndefined();
  });

  it("bulk_create_event_citations counts a community default as neither filed nor failed", async () => {
    seedEvent();
    const res = parseJson(
      await server.invoke("bulk_create_event_citations", {
        citations: [
          {
            event_id: EVENT_ID,
            field_name: "ticket_price_min",
            value: "0",
            source_url: SRC,
            source_type: "official_website",
            update_event_column: false,
            live_defect: { kind: "unsupported", reason: "No 2026 source states the price." },
          },
        ],
      })
    );
    expect(res.live_defects_filed).toBe(0);
    expect(res.live_defects_failed).toBe(0);
    expect(res.live_defects_community_default).toBe(1);
  });
});

describe("ruling 3 — hours flags carry the clear-to-unconfirmed proposal", () => {
  it("files the hours flag, with the proposal in the row and the response", async () => {
    seedEvent();
    const res = parseJson(
      await server.invoke("create_event_citation", {
        event_id: EVENT_ID,
        field_name: "hours",
        value: "10am-3pm",
        source_url: "https://venue-calendar.example/oct",
        source_type: "other",
        live_defect: {
          kind: "contradicted",
          reason: "Venue calendar says 10-3; the aggregator says 9-4.",
          source_says: "10am-3pm",
        },
      })
    );
    expect(res.live_defects[0].outcome).toBe("created");
    expect(res.live_defects[0].proposal).toContain("clear the hours to 'not yet confirmed'");
    expect(flagRows()[0].notes).toContain("Ruling 3 (John, 2026-11-10, OPE-86)");
  });
});

describe("tool gaps", () => {
  it("update_event clears ticket_price_min/max with null", async () => {
    seedEvent({ ticketPriceMinCents: 0, ticketPriceMaxCents: 500 });
    const res = parseJson(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        ticket_price_min: null,
        ticket_price_max: null,
      })
    );
    expect(res.updated).toBe(true);
    const [row] = db
      .select({ min: events.ticketPriceMinCents, max: events.ticketPriceMaxCents })
      .from(events)
      .where(eq(events.id, EVENT_ID))
      .all();
    expect(row).toEqual({ min: null, max: null });
  });

  it("resolve_discrepancy says why a citation_flag row scores nothing, and answers a passed source key", async () => {
    seedEvent({ ticketUrl: "https://bethelmaine.example/tickets" });
    const filed = await flagUnsupportedZero();
    const id = filed.live_defects[0].discrepancy_id as string;
    const res = parseJson(
      await server.invoke("resolve_discrepancy", {
        discrepancy_id: id,
        resolution_status: "resolved_divergent",
        divergent_source_key: "bethelmaine.example",
      })
    );
    expect(res.scoring_note).toContain("no source keys by design (OPE-1065)");
    expect(res.ignored.divergent_source_key).toContain("not applied");
    const [row] = db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id)).all();
    expect(row.divergentSourceKey).toBeNull();
  });
});

describe("isTicketingUrl", () => {
  it("matches ticketing hosts and nothing else", () => {
    expect(isTicketingUrl("https://www.eventbrite.com/e/123")).toBe(true);
    expect(isTicketingUrl("https://maynard.showare.com/x")).toBe(true);
    expect(isTicketingUrl("https://bethelmaine.example/autumn")).toBe(false);
    expect(isTicketingUrl("not a url")).toBe(false);
    expect(isTicketingUrl(null)).toBe(false);
  });
});
