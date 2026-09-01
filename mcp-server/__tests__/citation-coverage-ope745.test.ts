/**
 * OPE-745 — the provenance gap must be countable, and counted correctly.
 *
 * These run the REAL `readCitationCoverage` query, not a copy of it. A copied
 * query drifts from the one that ships and a drifted metric test is exactly the
 * thing that fails to notice a metric going wrong (the reason `day-coverage.ts`
 * was extracted the same way).
 *
 * The fixtures are built so a wrong implementation gives a DIFFERENT answer:
 *
 *  - a `superseded` citation must not count as coverage, and a naive
 *    `EXISTS (… field_name = ?)` without the `state` check would count it;
 *  - a citation for a DIFFERENT field must not count, and a query that forgot
 *    the `field_name` predicate would count it;
 *  - PENDING and tombstoned events must be excluded, because "visitor-facing"
 *    is the premise of the whole metric.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { readCitationCoverage, CITED_VALUE_FIELDS } from "../src/events/citation-coverage.js";
import { events, promoters, eventDataCitations } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "p1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
});

function addEvent(
  id: string,
  over: Partial<{
    status: string;
    ingestionMethod: string;
    ticketPriceMinCents: number | null;
    mergedInto: string | null;
  }> = {}
) {
  db.insert(events)
    .values({
      id,
      name: `Fair ${id}`,
      slug: `fair-${id}`,
      promoterId: "p1",
      status: over.status ?? "APPROVED",
      ingestionMethod: over.ingestionMethod ?? "vendor_submission",
      ticketPriceMinCents: over.ticketPriceMinCents === undefined ? 500 : over.ticketPriceMinCents,
      mergedInto: over.mergedInto ?? null,
    } as never)
    .run();
}

function cite(eventId: string, fieldName: string, state: "active" | "superseded" = "active") {
  db.insert(eventDataCitations)
    .values({
      id: `${eventId}-${fieldName}-${state}`,
      eventId,
      fieldName,
      value: "5",
      sourceUrl: "https://example.org/tickets",
      sourceType: "official_website",
      state,
    } as never)
    .run();
}

const priceRow = (c: Awaited<ReturnType<typeof readCitationCoverage>>) =>
  c.by_field.find((f) => f.field === "ticket_price_min")!;

describe("OPE-745 — readCitationCoverage", () => {
  it("counts a populated value with no citation as uncited", async () => {
    addEvent("e1");
    const row = priceRow(await readCitationCoverage(db));
    expect(row).toMatchObject({ populated: 1, cited: 0, uncited: 1 });
  });

  it("counts an active citation for that field as cited", async () => {
    addEvent("e1");
    cite("e1", "ticket_price_min");
    expect(priceRow(await readCitationCoverage(db))).toMatchObject({
      populated: 1,
      cited: 1,
      uncited: 0,
    });
  });

  it("does NOT count a SUPERSEDED citation as coverage", async () => {
    // A superseded row is a historical record, not current provenance.
    // Dropping the `state = 'active'` predicate would score this as covered.
    addEvent("e1");
    cite("e1", "ticket_price_min", "superseded");
    expect(priceRow(await readCitationCoverage(db))).toMatchObject({ cited: 0, uncited: 1 });
  });

  it("does NOT count a citation for a DIFFERENT field", async () => {
    // Forgetting the field_name predicate would score this as covered — and
    // start_date citations are the most common kind, so that mistake would
    // make the metric look far healthier than it is.
    addEvent("e1");
    cite("e1", "start_date");
    expect(priceRow(await readCitationCoverage(db))).toMatchObject({ cited: 0, uncited: 1 });
  });

  it("excludes non-public events — visitor-facing is the premise", async () => {
    addEvent("pending", { status: "PENDING" });
    expect(priceRow(await readCitationCoverage(db)).populated).toBe(0);
  });

  it("excludes merge tombstones, whose slug 301s away", async () => {
    addEvent("keeper");
    addEvent("tomb", { mergedInto: "keeper" });
    expect(priceRow(await readCitationCoverage(db)).populated).toBe(1);
  });

  it("ignores an event with no value in the column at all", async () => {
    addEvent("nulled", { ticketPriceMinCents: null });
    expect(priceRow(await readCitationCoverage(db)).populated).toBe(0);
  });

  it("splits the uncited gap by ingestion path, largest first", async () => {
    addEvent("v1", { ingestionMethod: "vendor_submission" });
    addEvent("v2", { ingestionMethod: "vendor_submission" });
    addEvent("s1", { ingestionMethod: "direct_scrape" });
    addEvent("cited", { ingestionMethod: "email_submission" });
    cite("cited", "ticket_price_min");

    const { ticket_price_uncited_by_method: byMethod } = await readCitationCoverage(db);

    expect(byMethod[0]).toEqual({ ingestion_method: "vendor_submission", uncited: 2 });
    expect(byMethod.map((m) => m.ingestion_method)).toContain("direct_scrape");
    // The cited one must not appear at all — this breakdown is of the GAP.
    expect(byMethod.map((m) => m.ingestion_method)).not.toContain("email_submission");
  });

  it("reports every field in CITED_VALUE_FIELDS, so a new one cannot be silently unmeasured", async () => {
    const cov = await readCitationCoverage(db);
    expect(cov.by_field.map((f) => f.field)).toEqual(CITED_VALUE_FIELDS.map((f) => f.field));
  });

  it("carries the do-not-backfill note, because the number invites exactly that", async () => {
    const cov = await readCitationCoverage(db);
    expect(cov.note).toMatch(/not a fault/i);
    expect(cov.note).toMatch(/backfill/i);
  });
});
