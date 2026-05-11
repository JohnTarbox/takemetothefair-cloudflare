/**
 * Tests for the event_data_citations MCP tools (drizzle/0064) and the
 * update_event citation auto-insert wire-up.
 *
 * Tools exercised:
 *   - create_event_citation   (insert + auto-supersede + column sync)
 *   - list_event_citations    (filter by state, default = active-only)
 *   - update_event_citation   (state transitions, supersession on → active)
 *   - delete_event_citation   (hard delete + admin_actions audit row)
 *   - bulk_create_event_citations (partial success on bad event_id)
 *
 * Also covers update_event's optional `citation` param: passing
 * { source_url, source_type } alongside estimated_attendance must insert a
 * citation row and supersede the prior active for the same (event, field, year).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, eventDataCitations, events, promoters } from "../src/schema.js";
import { and, eq } from "drizzle-orm";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

function seedEvent(overrides: Partial<typeof events.$inferInsert> = {}) {
  const promoterId = overrides.promoterId ?? "promoter-1";
  db.insert(promoters)
    .values({
      id: promoterId,
      companyName: "Test Promoter",
      slug: "test-promoter",
    })
    .run();
  const id = overrides.id ?? "11111111-2222-3333-4444-555555555555";
  db.insert(events)
    .values({
      id,
      name: "Fryeburg Fair 2026",
      slug: "fryeburg-fair-2026",
      promoterId,
      status: "DRAFT",
      ...overrides,
    })
    .run();
  return id;
}

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// create_event_citation -----------------------------------------------------

describe("create_event_citation", () => {
  it("inserts a citation row and syncs the denormalized events column", async () => {
    const eventId = seedEvent();
    const result = await server.invoke("create_event_citation", {
      event_id: eventId,
      field_name: "estimated_attendance",
      value: "260,000",
      source_url: "https://www.fryeburgfair.org/p/vendor-services",
      source_type: "official_website",
      source_name: "fryeburgfair.org",
      year: 2026,
      confidence: 0.95,
      auto_supersede_prior: true,
      update_event_column: true,
    });

    const body = parseJson(result);
    expect(body.ok).toBe(true);
    expect(body.superseded_count).toBe(0);
    expect(body.event_column_updated).toBe("estimatedAttendance");

    // Citation row exists + state=active
    const rows = await db.select().from(eventDataCitations);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("active");
    expect(rows[0].value).toBe("260,000");
    expect(rows[0].year).toBe(2026);

    // Events column actually updated
    const eventRow = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventRow[0].estimatedAttendance).toBe(260000);
  });

  it("auto-supersedes prior active citation for the same (event, field, year)", async () => {
    const eventId = seedEvent();
    const first = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "200000",
        source_url: "https://example.com/old",
        source_type: "news_article",
        year: 2026,
      })
    );
    const second = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com/new",
        source_type: "official_website",
        year: 2026,
      })
    );

    expect(second.superseded_count).toBe(1);

    const firstRow = await db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, first.citation_id));
    expect(firstRow[0].state).toBe("superseded");

    const secondRow = await db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, second.citation_id));
    expect(secondRow[0].state).toBe("active");
    expect(secondRow[0].supersedesCitationId).toBe(first.citation_id);
  });

  it("treats different years as separate citation buckets", async () => {
    const eventId = seedEvent();
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com/2026",
        source_type: "official_website",
        year: 2026,
      })
    );
    const result2025 = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "250000",
        source_url: "https://example.com/2025",
        source_type: "official_website",
        year: 2025,
      })
    );

    expect(result2025.superseded_count).toBe(0);

    // Both should be active because they're different year-buckets
    const activeRows = await db
      .select()
      .from(eventDataCitations)
      .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")));
    expect(activeRows).toHaveLength(2);
  });

  it("skips column update when value can't be parsed (e.g. range)", async () => {
    const eventId = seedEvent();
    const result = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "vendor_fee_min",
        value: "$50-$75", // range, not a single number
        source_url: "https://example.com",
        source_type: "official_website",
        update_event_column: true,
      })
    );

    expect(result.event_column_updated).toBeNull();
    expect(result.column_skip_reason).toBe("parse_failed");

    // Citation row still inserted (text preserved)
    const rows = await db.select().from(eventDataCitations);
    expect(rows[0].value).toBe("$50-$75");

    // Column NOT touched
    const eventRow = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventRow[0].vendorFeeMinCents).toBeNull();
  });

  it("converts dollar input to cents for monetary fields", async () => {
    const eventId = seedEvent();
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "vendor_fee_min",
        value: "$50",
        source_url: "https://example.com",
        source_type: "official_website",
      })
    );

    const eventRow = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventRow[0].vendorFeeMinCents).toBe(5000);
  });

  it("records but does not sync unknown field_name", async () => {
    const eventId = seedEvent();
    const result = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "vendor_count",
        value: "298",
        source_url: "https://example.com",
        source_type: "official_website",
      })
    );

    expect(result.event_column_updated).toBeNull();
    expect(result.column_skip_reason).toBe("unknown_field_name");
    const rows = await db.select().from(eventDataCitations);
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldName).toBe("vendor_count");
  });

  it("refuses when event does not exist", async () => {
    const result = (await server.invoke("create_event_citation", {
      event_id: "00000000-0000-0000-0000-000000000000",
      field_name: "estimated_attendance",
      value: "1000",
      source_url: "https://example.com",
      source_type: "official_website",
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// list_event_citations ------------------------------------------------------

describe("list_event_citations", () => {
  it("returns only active citations by default", async () => {
    const eventId = seedEvent();
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "200000",
        source_url: "https://example.com/old",
        source_type: "news_article",
        year: 2026,
      })
    );
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com/new",
        source_type: "official_website",
        year: 2026,
      })
    );

    const result = parseJson(await server.invoke("list_event_citations", { event_id: eventId }));

    expect(result.count).toBe(1);
    expect(result.citations[0].value).toBe("260000");
    expect(result.citations[0].state).toBe("active");
  });

  it("returns full history when include_all_states=true", async () => {
    const eventId = seedEvent();
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "200000",
        source_url: "https://example.com/old",
        source_type: "news_article",
        year: 2026,
      })
    );
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com/new",
        source_type: "official_website",
        year: 2026,
      })
    );

    const result = parseJson(
      await server.invoke("list_event_citations", {
        event_id: eventId,
        include_all_states: true,
      })
    );
    expect(result.count).toBe(2);
  });
});

// update_event_citation -----------------------------------------------------

describe("update_event_citation", () => {
  it("transitions state to rejected", async () => {
    const eventId = seedEvent();
    const created = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com",
        source_type: "official_website",
      })
    );

    const result = parseJson(
      await server.invoke("update_event_citation", {
        citation_id: created.citation_id,
        state: "rejected",
      })
    );

    expect(result.state_changed).toBe(true);
    expect(result.previous_state).toBe("active");
    expect(result.new_state).toBe("rejected");
  });

  it("supersedes other actives when transitioning superseded → active", async () => {
    const eventId = seedEvent();
    // First citation, will be superseded by next
    const first = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "200000",
        source_url: "https://example.com/old",
        source_type: "news_article",
        year: 2026,
      })
    );
    // Second citation (now the active one, first is superseded)
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com/new",
        source_type: "official_website",
        year: 2026,
      })
    );

    // Recover the first one — should supersede the second
    const result = parseJson(
      await server.invoke("update_event_citation", {
        citation_id: first.citation_id,
        state: "active",
      })
    );

    expect(result.superseded_count).toBe(1);

    const activeRows = await db
      .select()
      .from(eventDataCitations)
      .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(first.citation_id);
  });
});

// delete_event_citation -----------------------------------------------------

describe("delete_event_citation", () => {
  it("hard-deletes and writes an admin_actions audit row", async () => {
    const eventId = seedEvent();
    const created = parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "260000",
        source_url: "https://example.com",
        source_type: "official_website",
      })
    );

    const result = parseJson(
      await server.invoke("delete_event_citation", {
        citation_id: created.citation_id,
        reason: "duplicate row created during ingestion bug",
      })
    );

    expect(result.deleted).toBe(true);

    const rows = await db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, created.citation_id));
    expect(rows).toHaveLength(0);

    const audit = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.targetId, created.citation_id));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("event_data_citation.delete");
  });
});

// bulk_create_event_citations -----------------------------------------------

describe("bulk_create_event_citations", () => {
  it("supports partial success on missing event_id", async () => {
    const eventId = seedEvent();
    const result = parseJson(
      await server.invoke("bulk_create_event_citations", {
        citations: [
          {
            event_id: eventId,
            field_name: "estimated_attendance",
            value: "260000",
            source_url: "https://example.com/a",
            source_type: "official_website",
          },
          {
            event_id: "00000000-0000-0000-0000-000000000000",
            field_name: "estimated_attendance",
            value: "1000",
            source_url: "https://example.com/b",
            source_type: "official_website",
          },
        ],
      })
    );

    expect(result.ok).toBe(false);
    expect(result.created_count).toBe(1);
    expect(result.error_count).toBe(1);
    expect(result.errors[0].index).toBe(1);
  });
});

// update_event citation auto-insert -----------------------------------------

describe("update_event with citation param", () => {
  it("inserts a citation row when a tracked field is updated", async () => {
    const eventId = seedEvent();

    const result = parseJson(
      await server.invoke("update_event", {
        event_id: eventId,
        estimated_attendance: 260000,
        citation: {
          source_url: "https://www.fryeburgfair.org/p/vendor-services",
          source_type: "official_website",
          source_name: "fryeburgfair.org",
          year: 2026,
          confidence: 0.95,
        },
      })
    );

    expect(result.updated).toBe(true);
    expect(result.citationsInserted).toHaveLength(1);
    expect(result.citationsInserted[0].field_name).toBe("estimated_attendance");

    const rows = await db.select().from(eventDataCitations);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("260000");
    expect(rows[0].state).toBe("active");

    // Column written by update_event's existing code path
    const eventRow = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventRow[0].estimatedAttendance).toBe(260000);
  });

  it("supersedes prior active citation when same (event, field, year) is re-cited", async () => {
    const eventId = seedEvent();
    // First citation via the standalone tool
    parseJson(
      await server.invoke("create_event_citation", {
        event_id: eventId,
        field_name: "estimated_attendance",
        value: "200000",
        source_url: "https://example.com/old",
        source_type: "news_article",
        year: 2026,
      })
    );

    // update_event with new citation — should auto-supersede
    parseJson(
      await server.invoke("update_event", {
        event_id: eventId,
        estimated_attendance: 260000,
        citation: {
          source_url: "https://example.com/new",
          source_type: "official_website",
          year: 2026,
        },
      })
    );

    const activeRows = await db
      .select()
      .from(eventDataCitations)
      .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].value).toBe("260000");
  });

  it("skips citation when no tracked field is touched", async () => {
    const eventId = seedEvent();
    const result = parseJson(
      await server.invoke("update_event", {
        event_id: eventId,
        description: "Updated description",
        citation: {
          source_url: "https://example.com",
          source_type: "official_website",
        },
      })
    );

    expect(result.updated).toBe(true);
    expect(result.citationsInserted).toBeUndefined();
    const rows = await db.select().from(eventDataCitations);
    expect(rows).toHaveLength(0);
  });
});

// update_event statewide params ---------------------------------------------

describe("update_event statewide params", () => {
  it("sets is_statewide + state_code (uppercased) together", async () => {
    const eventId = seedEvent();
    const result = parseJson(
      await server.invoke("update_event", {
        event_id: eventId,
        is_statewide: true,
        state_code: "me",
      })
    );

    expect(result.updated).toBe(true);

    const eventRow = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventRow[0].isStatewide).toBe(true);
    expect(eventRow[0].stateCode).toBe("ME");
  });

  it("refuses is_statewide=true without state_code when row has no existing stateCode", async () => {
    const eventId = seedEvent();
    const result = (await server.invoke("update_event", {
      event_id: eventId,
      is_statewide: true,
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it("allows is_statewide=true alone when stateCode already exists on the row", async () => {
    const eventId = seedEvent({ stateCode: "NH" });
    const result = parseJson(
      await server.invoke("update_event", {
        event_id: eventId,
        is_statewide: true,
      })
    );
    expect(result.updated).toBe(true);
  });

  it("refuses malformed state_code", async () => {
    const eventId = seedEvent();
    const result = (await server.invoke("update_event", {
      event_id: eventId,
      state_code: "12",
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});
