/**
 * OPE-744 — the inbound pipeline cites the numeric/date tracked fields it
 * actually carries, and the widened list does not breach D1's bind-param cap.
 *
 * Two failure modes are specifically defended here, because both pass silently:
 *
 *  1. A price of 0 dropped as falsy. Free admission is the single most common
 *     price on this site (13 of the 31 recently-created priced events are 0),
 *     so "cite the price" implemented with a truthiness check would miss the
 *     majority case while looking correct on every non-zero fixture.
 *
 *  2. The D1 100-bound-parameter ceiling. better-sqlite3 allows 32766, so a
 *     statement that D1 rejects runs happily in this very test file. The guard
 *     below counts placeholders in the emitted SQL rather than trusting that
 *     the insert "worked".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordSourceCitations } from "../src/email-handlers/pipeline-citations.js";
import { eventDataCitations, events, promoters } from "../src/schema.js";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";

/** D1/SQLite's hard ceiling on bound parameters in one statement. */
const D1_MAX_BIND_PARAMS = 100;

let db: TestDb;
let raw: Database.Database;

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

function seedEvent(id = "event-1"): string {
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
  db.insert(events)
    .values({
      id,
      name: "Fryeburg Fair 2026",
      slug: `fryeburg-fair-2026-${id}`,
      promoterId: "promoter-1",
      status: "PENDING",
    })
    .run();
  return id;
}

/** Every tracked field the pipeline can supply, all at once — the worst case. */
function fullFixture() {
  return {
    url: "https://fryeburgfair.org/schedule",
    event: {
      name: "Fryeburg Fair 2026",
      startDate: "2026-10-04",
      endDate: "2026-10-11",
      ticketPriceMin: 5,
      ticketPriceMax: 15,
      vendorFeeMin: 100,
      vendorFeeMax: 400,
      estimatedAttendance: 300000,
      applicationDeadline: "2026-09-15",
    },
    fieldConfidence: { name: "high" as const, ticketPriceMin: "medium" as const },
  };
}

const urlSource = { kind: "url" as const, url: "https://fryeburgfair.org/schedule" };

function readCitations(eventId: string) {
  return db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, eventId)).all();
}

describe("OPE-744 — the pipeline cites the fields it carries", () => {
  it("writes a citation for every tracked field the extractor supplied", async () => {
    const eventId = seedEvent();
    const res = await recordSourceCitations(db, {
      eventId,
      extracted: fullFixture(),
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    expect(res.reason).toBeNull();
    expect(res.inserted).toBe(9);

    const byField = new Map(readCitations(eventId).map((r) => [r.fieldName, r]));
    expect([...byField.keys()].sort()).toEqual(
      [
        "application_deadline",
        "end_date",
        "estimated_attendance",
        "name",
        "start_date",
        "ticket_price_max",
        "ticket_price_min",
        "vendor_fee_min",
        "vendor_fee_max",
      ].sort()
    );
  });

  it("stores money in DOLLARS, matching what DENORM_FIELD_MAP parses back", () => {
    // parseDollarsToCents reads the stored string, so "5" must mean $5.
    // Storing cents here would silently multiply every cited price by 100.
    return recordSourceCitations(db, {
      eventId: seedEvent(),
      extracted: fullFixture(),
      source: urlSource,
      fromAddress: "sender@example.com",
    }).then(() => {
      const byField = new Map(readCitations("event-1").map((r) => [r.fieldName, r]));
      expect(byField.get("ticket_price_min")?.value).toBe("5");
      expect(byField.get("ticket_price_max")?.value).toBe("15");
      expect(byField.get("estimated_attendance")?.value).toBe("300000");
    });
  });

  it("cites a price of ZERO — free admission is a real value, not a missing one", async () => {
    const eventId = seedEvent();
    const extracted = fullFixture();
    extracted.event.ticketPriceMin = 0;
    extracted.event.ticketPriceMax = 0;

    await recordSourceCitations(db, {
      eventId,
      extracted,
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    const byField = new Map(readCitations(eventId).map((r) => [r.fieldName, r]));
    expect(byField.get("ticket_price_min")?.value).toBe("0");
    expect(byField.get("ticket_price_max")?.value).toBe("0");
  });

  it("omits a field the extractor did not supply, rather than citing null", async () => {
    const eventId = seedEvent();
    const extracted = {
      url: "https://fryeburgfair.org/schedule",
      event: { name: "Fryeburg Fair 2026", startDate: "2026-10-04", ticketPriceMin: null },
      fieldConfidence: {},
    };

    await recordSourceCitations(db, {
      eventId,
      extracted,
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    const fields = readCitations(eventId).map((r) => r.fieldName);
    expect(fields).not.toContain("ticket_price_min");
    expect(fields).toContain("name");
  });

  it("carries the source URL onto the new fields, not just the old three", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: fullFixture(),
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    const price = readCitations(eventId).find((r) => r.fieldName === "ticket_price_min");
    expect(price?.sourceUrl).toBe("https://fryeburgfair.org/schedule");
    expect(price?.state).toBe("active");
  });
});

describe("OPE-744 — the widened list stays under D1's bind-param ceiling", () => {
  it("never emits an insert with more than 100 bound parameters", async () => {
    // better-sqlite3 permits 32766 bound parameters, so the insert below would
    // succeed here even at ~117 — and fail in production with
    // "too many SQL variables". Count the placeholders in the SQL itself.
    const seen: string[] = [];
    const originalPrepare = raw.prepare.bind(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (raw as any).prepare = (sql: string) => {
      seen.push(sql);
      return originalPrepare(sql);
    };

    const eventId = seedEvent();
    const res = await recordSourceCitations(db, {
      eventId,
      extracted: fullFixture(),
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    // All nine rows still land — chunking must not lose any.
    expect(res.inserted).toBe(9);
    expect(readCitations(eventId)).toHaveLength(9);

    // Match the citation INSERT precisely. A loose `includes("event_data_citations")`
    // would also match the SELECT that reads already-cited fields and go
    // vacuously green on a statement that binds almost nothing.
    const inserts = seen.filter((s) => /insert\s+into\s+["'`]?event_data_citations/i.test(s));
    expect(inserts.length).toBeGreaterThan(0);

    for (const sql of inserts) {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      expect(placeholders).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });

  it("splits the nine rows across more than one statement", async () => {
    // The previous test would also pass if Drizzle happened to bind few
    // columns. This one asserts the chunking actually happened, so the guard
    // cannot silently become a no-op.
    const inserts: string[] = [];
    const originalPrepare = raw.prepare.bind(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (raw as any).prepare = (sql: string) => {
      if (/insert\s+into\s+["'`]?event_data_citations/i.test(sql)) inserts.push(sql);
      return originalPrepare(sql);
    };

    await recordSourceCitations(db, {
      eventId: seedEvent(),
      extracted: fullFixture(),
      source: urlSource,
      fromAddress: "sender@example.com",
    });

    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });
});
