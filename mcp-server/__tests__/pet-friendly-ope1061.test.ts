/**
 * OPE-1061 — the four-state `pet_friendly` field, MCP side.
 *
 * Two fair-goers asked "can I bring my dog?"; the second asked from an event
 * page whose row held no answer. The field fails by stranding a person at a
 * gate, so the tests pin the four constraints rather than the happy path:
 * evidence or refusal, NO is never bare, no venue→event inheritance, and the
 * reader returns what the writer writes (the OPE-497 erase-on-rewrite shape).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { buildVendorInquiryBriefing } from "../src/inbound/vendor-inquiry-briefing.js";
import {
  events,
  venues,
  promoters,
  eventDataCitations,
  entityDataCitations,
} from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "a53509f1-0000-4000-8000-000000000001";
const VENUE_ID = "v-olde-mistick";
const SRC = "https://www.oldemistickvillage.com/garlic-festival-2/";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerAdminEventReadTools(server as never, db, ADMIN_AUTH as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
  db.insert(venues)
    .values({
      id: VENUE_ID,
      name: "Olde Mistick Village",
      slug: "olde-mistick-village",
      address: "27 Coogan Blvd",
      city: "Mystic",
      state: "CT",
      zip: "06355",
    })
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Olde Mistick Village Garlic Festival 2026",
      slug: "olde-mistick-village-garlic-festival-2026",
      promoterId: "p-1",
      venueId: VENUE_ID,
      status: "APPROVED",
    })
    .run();
});
afterEach(() => mock.restore());

function body(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    isError: !!r.isError,
    json: (() => {
      try {
        return JSON.parse(r.content[0].text);
      } catch {
        return r.content[0].text;
      }
    })(),
  };
}
const eventRow = () => db.select().from(events).where(eq(events.id, EVENT_ID)).all()[0];
const petCitations = () =>
  db
    .select()
    .from(eventDataCitations)
    .where(
      and(
        eq(eventDataCitations.eventId, EVENT_ID),
        eq(eventDataCitations.fieldName, "pet_friendly")
      )
    )
    .all();

describe("update_event — citation or it does not ship", () => {
  it.each([
    ["YES with no evidence", { pet_friendly: "YES" }],
    ["NO with no evidence", { pet_friendly: "NO" }],
    [
      "YES with evidence but no verbatim excerpt",
      {
        pet_friendly: "YES",
        pet_friendly_evidence: { source_url: SRC, source_type: "official_website" },
      },
    ],
    [
      "NOT_PUBLISHED without saying what was checked",
      {
        pet_friendly: "NOT_PUBLISHED",
        pet_friendly_evidence: { source_url: SRC, source_type: "official_website" },
      },
    ],
    [
      "evidence with no value",
      {
        pet_friendly_evidence: {
          source_url: SRC,
          source_type: "official_website",
          excerpt: "Dogs welcome",
        },
      },
    ],
  ])("refuses %s — and writes NOTHING", async (_label, args) => {
    const r = body(await server.invoke("update_event", { event_id: EVENT_ID, ...args }));
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("pet_friendly_evidence_required");
    // Read back: a refusal must leave no half-written state.
    expect(eventRow().petFriendly).toBe("UNSET");
    expect(petCitations()).toHaveLength(0);
  });

  it("writes YES with a citation carrying the verbatim excerpt", async () => {
    const r = body(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        pet_friendly: "YES",
        pet_friendly_evidence: {
          source_url: SRC,
          source_type: "official_website",
          excerpt: "Leashed, well-behaved dogs are welcome.",
        },
      })
    );
    expect(r.isError).toBe(false);
    expect(eventRow().petFriendly).toBe("YES");
    const [c] = petCitations();
    expect(c.value).toBe("YES");
    expect(c.state).toBe("active");
    expect(c.sourceExcerpt).toBe("Leashed, well-behaved dogs are welcome.");
    expect(c.notes).toContain("Leashed, well-behaved dogs are welcome.");
    expect(c.sourceFetchedAt).not.toBeNull();
    expect(r.json.petFriendlyCitationId).toBe(c.id);
  });

  it("a later NO supersedes the YES citation", async () => {
    const ev = { source_url: SRC, source_type: "official_website" };
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      pet_friendly: "YES",
      pet_friendly_evidence: { ...ev, excerpt: "Dogs welcome." },
    });
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      pet_friendly: "NO",
      pet_friendly_evidence: {
        ...ev,
        excerpt: "With the exception of service animals, pets are not allowed.",
      },
    });
    const rows = petCitations();
    expect(rows.filter((r) => r.state === "active").map((r) => r.value)).toEqual(["NO"]);
    expect(rows.filter((r) => r.state === "superseded").map((r) => r.value)).toEqual(["YES"]);
  });

  it("NOT_PUBLISHED records what was checked, and claims no captured excerpt", async () => {
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      pet_friendly: "NOT_PUBLISHED",
      pet_friendly_evidence: {
        source_url: SRC,
        source_type: "official_website",
        checked: "Festival page, FAQ and village rules page — no mention of pets.",
      },
    });
    const [c] = petCitations();
    expect(c.value).toBe("NOT_PUBLISHED");
    expect(c.notes).toContain("FAQ and village rules page");
    expect(c.sourceExcerpt).toBeNull();
    expect(c.sourceFetchedAt).toBeNull();
  });

  it("UNSET is a reset: accepted with no evidence, writes no citation", async () => {
    const r = body(
      await server.invoke("update_event", { event_id: EVENT_ID, pet_friendly: "UNSET" })
    );
    expect(r.isError).toBe(false);
    expect(petCitations()).toHaveLength(0);
  });
});

describe("no inheritance — the venue's value is never the event's", () => {
  it("get_event_details_admin returns the event's own value beside the venue's, not merged", async () => {
    db.update(venues).set({ petFriendly: "YES" }).where(eq(venues.id, VENUE_ID)).run();
    const r = body(await server.invoke("get_event_details_admin", { event_id: EVENT_ID }));
    expect(r.isError).toBe(false);
    expect(r.json.pet_friendly).toBe("UNSET");
    expect(r.json.venue.pet_friendly).toBe("YES");
  });

  it("the briefing carries both, labelled, and warns against answering from the venue", async () => {
    db.update(venues).set({ petFriendly: "YES" }).where(eq(venues.id, VENUE_ID)).run();
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "ap@mcrmanagement.com",
      subject: "Is the Olde Mystic Village Garlic Festival 2026 Pet (Dog) Friendly?",
      parsedUrl: "https://meetmeatthefair.com/events/olde-mistick-village-garlic-festival-2026",
    });
    // Landmark: the question resolved to the event, so the answer below is
    // about the right row.
    expect(b.matchedEvent?.id).toBe(EVENT_ID);
    expect(b.petPolicy).toEqual({ event: "UNSET", eventEvidence: null, venueOwnPolicy: "YES" });
    expect(b.warnings.join(" ")).toMatch(/Do not answer for the fair from the venue/);
  });

  it("the briefing hands over the event's own evidence when it has a value", async () => {
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      pet_friendly: "NO",
      pet_friendly_evidence: {
        source_url: SRC,
        source_type: "official_website",
        excerpt: "No pets, service animals excepted.",
      },
    });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i2",
      fromAddress: "ap@mcrmanagement.com",
      subject: "dogs?",
      parsedUrl: "https://meetmeatthefair.com/events/olde-mistick-village-garlic-festival-2026",
    });
    expect(b.petPolicy?.event).toBe("NO");
    expect(b.petPolicy?.eventEvidence).toEqual({
      sourceUrl: SRC,
      excerpt: "No pets, service animals excepted.",
    });
  });
});

describe("update_venue", () => {
  it("refuses YES without evidence and leaves the venue untouched", async () => {
    const r = body(
      await server.invoke("update_venue", { venue_id: VENUE_ID, pet_friendly: "YES" })
    );
    expect(r.isError).toBe(true);
    expect(db.select().from(venues).where(eq(venues.id, VENUE_ID)).all()[0].petFriendly).toBe(
      "UNSET"
    );
  });

  it("writes the venue's own value with an entity citation, and does not touch the event", async () => {
    const r = body(
      await server.invoke("update_venue", {
        venue_id: VENUE_ID,
        pet_friendly: "YES",
        pet_friendly_evidence: {
          source_url: "https://www.oldemistickvillage.com/faq/",
          source_type: "official_website",
          excerpt: "Leashed pets are welcome in the Village.",
        },
      })
    );
    expect(r.isError).toBe(false);
    expect(db.select().from(venues).where(eq(venues.id, VENUE_ID)).all()[0].petFriendly).toBe(
      "YES"
    );
    const cites = db
      .select()
      .from(entityDataCitations)
      .where(
        and(
          eq(entityDataCitations.entityId, VENUE_ID),
          eq(entityDataCitations.fieldName, "pet_friendly")
        )
      )
      .all();
    expect(cites).toHaveLength(1);
    expect(cites[0].notes).toContain("Leashed pets are welcome in the Village.");
    expect(r.json.pet_friendly_citation_id).toBe(cites[0].id);
    // No inheritance at WRITE time either.
    expect(eventRow().petFriendly).toBe("UNSET");
  });
});
