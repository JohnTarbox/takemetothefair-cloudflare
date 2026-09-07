/**
 * OPE-840 — the `vendor_roster` citation is actually WRITTEN.
 *
 * ⚠️ This file exists because of a surviving mutant. The first pass of this
 * ticket's tests covered the crawl layer (`rosterSources`) and the call-site
 * wiring (structural), and deleting the entire roster-citation write left all
 * 35 of them GREEN. Extraction, source attribution and call-site plumbing were
 * all pinned; the one thing that puts a row in the database was not. That is
 * the OPE-6 v3.8 shape — inert and passing were identical — arrived at by
 * mutation rather than by review.
 *
 * These run `recordSourceCitations` against a real SQLite db.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordSourceCitations } from "../src/email-handlers/pipeline-citations.js";
import { events, promoters, eventDataCitations } from "../src/schema.js";
import { eq } from "drizzle-orm";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

const ROSTER_PAGE = "https://mainecheesefestival.org/?page_id=21";
const FROM = "organizer@mainecheesefestival.org";

function seedEvent(id = "event-1"): string {
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
  db.insert(events)
    .values({
      id,
      name: "Maine Cheese Festival",
      slug: `maine-cheese-festival-${id}`,
      promoterId: "promoter-1",
      status: "PENDING",
    })
    .run();
  return id;
}

const rosterArgs = (
  eventId: string,
  value = "63 exhibitors listed: 27 North, Afterglow Ice Cream"
) => ({
  eventId,
  extracted: { url: ROSTER_PAGE, event: {} },
  source: { kind: "url" as const, url: ROSTER_PAGE },
  fromAddress: FROM,
  snapshot: {
    title: "Artisan Vendors",
    text: "2026 Artisan Vendors (to-date): 27 North, Afterglow Ice Cream",
    fetchedAt: new Date("2026-09-07T17:00:00Z"),
  },
  extraFields: [{ fieldName: "vendor_roster", value }],
});

async function citations(eventId: string) {
  return db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, eventId)).all();
}

describe("vendor_roster citation write", () => {
  it("inserts a row for a field that is not an ExtractedEvent column", async () => {
    const id = seedEvent();
    const res = await recordSourceCitations(db, rosterArgs(id));
    expect(res.inserted).toBe(1);

    const rows = await citations(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldName).toBe("vendor_roster");
    expect(rows[0].value).toContain("63 exhibitors listed");
    expect(rows[0].state).toBe("active");
  });

  it("attributes it to the ROSTER page, not the submitted homepage", async () => {
    // The whole point of carrying a separate rosterSource. Citing the homepage
    // would assert that a page which never lists a vendor listed 63 of them —
    // the OPE-457 false-attribution class.
    const id = seedEvent();
    await recordSourceCitations(db, rosterArgs(id));
    const [row] = await citations(id);
    expect(row.sourceUrl).toBe(ROSTER_PAGE);
    expect(row.sourceUrl).not.toBe("https://mainecheesefestival.org/");
  });

  it("carries the page snapshot, so the claim is checkable later", async () => {
    const id = seedEvent();
    await recordSourceCitations(db, rosterArgs(id));
    const [row] = await citations(id);
    expect(row.sourceTitle).toBe("Artisan Vendors");
    expect(row.sourceExcerpt).toContain("Artisan Vendors");
    expect(row.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sourceFetchedAt).not.toBeNull();
  });

  it("writes a NULL confidence rather than a constant that looks measured", () => {
    // OPE-457 settled this: no extractor verdict exists for a roster.
    return recordSourceCitations(db, rosterArgs(seedEvent())).then(async () => {
      const rows = await db.select().from(eventDataCitations).all();
      expect(rows[0].confidence).toBeNull();
    });
  });

  it("is idempotent — a redelivery does not duplicate the row", async () => {
    const id = seedEvent();
    const first = await recordSourceCitations(db, rosterArgs(id));
    const second = await recordSourceCitations(db, rosterArgs(id));
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(await citations(id)).toHaveLength(1);
  });

  it("writes nothing when the roster is empty", async () => {
    const id = seedEvent();
    const res = await recordSourceCitations(db, { ...rosterArgs(id), extraFields: [] });
    expect(res.inserted).toBe(0);
    expect(await citations(id)).toHaveLength(0);
  });

  it("refuses a blank value rather than citing an empty roster", async () => {
    const id = seedEvent();
    const res = await recordSourceCitations(db, rosterArgs(id, "   "));
    expect(res.inserted).toBe(0);
    expect(await citations(id)).toHaveLength(0);
  });

  it("does not touch any events column — vendor_roster is not denormalized", async () => {
    const id = seedEvent();
    await recordSourceCitations(db, rosterArgs(id));
    const [ev] = await db.select().from(events).where(eq(events.id, id)).all();
    // The deliberate property: this records what a page SAID and promotes
    // nothing to public data. `vendor_roster` is absent from DENORM_FIELD_MAP.
    expect(ev.vendorRosterStatus).toBeNull();
    expect(ev.vendorRosterSourceUrl).toBeNull();
  });

  it("coexists with a price citation from a DIFFERENT page", async () => {
    const id = seedEvent();
    await recordSourceCitations(db, rosterArgs(id));
    await recordSourceCitations(db, {
      eventId: id,
      extracted: {
        url: "https://x.festivalpro.com/form/A/0",
        event: { ticketPriceMin: 10, ticketPriceMax: 35 },
      },
      source: { kind: "url", url: "https://x.festivalpro.com/form/A/0" },
      fromAddress: FROM,
    });
    const rows = await citations(id);
    const byField = new Map(rows.map((r) => [r.fieldName, r.sourceUrl]));
    expect(byField.get("vendor_roster")).toBe(ROSTER_PAGE);
    expect(byField.get("ticket_price_min")).toContain("festivalpro.com");
    // Positive landmark: three distinct rows, two distinct sources — a run
    // that silently wrote only one of them cannot pass this.
    expect(rows).toHaveLength(3);
  });
});
