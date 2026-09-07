/**
 * OPE-838 — the inbound pipeline records the evidence it already holds.
 *
 * The filed symptom was three citations carrying `confidence 0.6`,
 * `source_type: "other"`, `source_verifiable: false` and a null
 * `source_fetched_at` on a fetch that provably succeeded. Three separate
 * mechanisms sat behind that, and each is pinned here:
 *
 *  1. The snapshot columns (`source_title` / `source_excerpt` /
 *     `source_content_hash` / `source_fetched_at`) were never written by the
 *     automated path — only by hand through `update_event`'s citation arg.
 *     `source_verifiable` is DERIVED from them (admin-citations.ts:881), so it
 *     was not an inverted flag; it was an honest "nothing here to check".
 *
 *  2. `source_type` was the constant `other` for every url source.
 *
 *  3. `description` and the venue were extracted, written to the event, and
 *     cited nowhere — the two fields that most distinguish a real extraction
 *     from the OPE-537 fabrication shape.
 *
 * ⚠️ Every test below was driven to failure against the unfixed code before
 * being kept (OPE-6 v3.8): a guard that has never been red is indistinguishable
 * from one that never runs.
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
      name: "Maine Cheese Festival",
      slug: `maine-cheese-festival-${id}`,
      promoterId: "promoter-1",
      status: "PENDING",
    })
    .run();
  return id;
}

const PAGE_URL = "https://mainecheesefestival.org/";

/** The live specimen from the ticket, reduced to what this helper reads. */
function specimen() {
  return {
    url: PAGE_URL,
    event: {
      name: "Maine Cheese Festival",
      startDate: "2026-09-13",
      endDate: "2026-09-13",
      description: "A celebration of Maine's food, beverage and artisan community.",
      venueName: "Manson Park",
      startTime: "11:00",
      endTime: "17:00",
    },
    fieldConfidence: { name: "high" as const },
  };
}

const urlSource = { kind: "url" as const, url: PAGE_URL };
const PAGE_TEXT = "Maine Cheese Festival — Sunday, September 13, 2026 — Manson Park, Pittsfield";
const FETCHED_AT = new Date("2026-09-07T11:20:30Z");
const snapshot = { title: "Maine Cheese Festival", text: PAGE_TEXT, fetchedAt: FETCHED_AT };

function readCitations(eventId: string) {
  return db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, eventId)).all();
}

/** Independent SHA-256, so the assertion does not just re-run the code under test. */
async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("OPE-838 — a fetched page leaves a snapshot on every citation it produced", () => {
  it("writes title, excerpt, content hash and fetched-at for a url source", async () => {
    const eventId = seedEvent();
    const res = await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "organizer@mainecheesefestival.org",
      snapshot,
    });
    expect(res.reason).toBeNull();

    const rows = readCitations(eventId);
    // Positive landmark: the negative assertions below are meaningless unless
    // rows actually exist to carry them (OPE-6 v3.8 obligation 2).
    expect(rows.length).toBe(7);

    const expectedHash = await sha256(PAGE_TEXT);
    for (const r of rows) {
      expect(r.sourceTitle).toBe("Maine Cheese Festival");
      expect(r.sourceExcerpt).toBe(PAGE_TEXT);
      expect(r.sourceContentHash).toBe(expectedHash);
      expect(r.sourceFetchedAt?.toISOString()).toBe(FETCHED_AT.toISOString());
    }
  });

  it("makes the DERIVED source_verifiable true — the three fields it reads are populated", async () => {
    // `source_verifiable` is not a column. admin-citations.ts:881 computes it as
    // Boolean(sourceTitle || sourceExcerpt || sourceContentHash). This asserts
    // the derivation's inputs, which is the only thing the writer controls.
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "organizer@mainecheesefestival.org",
      snapshot,
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Boolean(r.sourceTitle || r.sourceExcerpt || r.sourceContentHash)).toBe(true);
    }
  });

  it("truncates the excerpt and still hashes the WHOLE page", async () => {
    const long = "x".repeat(5000);
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "organizer@mainecheesefestival.org",
      snapshot: { title: "T", text: long, fetchedAt: FETCHED_AT },
    });
    const [row] = readCitations(eventId);
    expect(row.sourceExcerpt).toHaveLength(600);
    // The hash must cover the full text, not the excerpt — otherwise a page
    // edit past character 600 would be undetectable.
    expect(row.sourceContentHash).toBe(await sha256(long));
    expect(row.sourceContentHash).not.toBe(await sha256(long.slice(0, 600)));
  });

  it("leaves the snapshot null for a BODY source even when one is passed", async () => {
    // A body citation's source is the email, already stored on inbound_emails.
    // Copying it here would imply a fetch that never happened.
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: { ...specimen(), url: "" },
      source: { kind: "body" as const },
      fromAddress: "organizer@mainecheesefestival.org",
      snapshot,
      supportingText: PAGE_TEXT,
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.sourceTitle).toBeNull();
      expect(r.sourceExcerpt).toBeNull();
      expect(r.sourceContentHash).toBeNull();
      expect(r.sourceFetchedAt).toBeNull();
    }
  });

  it("omitting the snapshot leaves the columns null — unchanged from before this ticket", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "organizer@mainecheesefestival.org",
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.sourceContentHash).toBeNull();
      expect(r.sourceFetchedAt).toBeNull();
    }
  });
});

describe("OPE-838 scope 2 — source_type reflects an origin signal independent of the fetch", () => {
  it("official_website when the sender's own domain is the page's domain", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "info@mainecheesefestival.org",
      snapshot,
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.sourceType).toBe("official_website");
  });

  it("matches across a www. subdomain, which is the same registrable domain", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: { ...specimen(), url: "https://www.mainecheesefestival.org/tickets" },
      source: { kind: "url" as const, url: "https://www.mainecheesefestival.org/tickets" },
      fromAddress: "info@mainecheesefestival.org",
      snapshot,
    });
    const [row] = readCitations(eventId);
    expect(row.sourceType).toBe("official_website");
  });

  it("stays `other` for a stranger forwarding an aggregator link", async () => {
    // The under-claiming direction is deliberate: asserting an origin we cannot
    // evidence is worse than under-stating one, because nothing downstream can
    // tell the difference.
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: { ...specimen(), url: "https://someaggregator.com/e/123" },
      source: { kind: "url" as const, url: "https://someaggregator.com/e/123" },
      fromAddress: "randomperson@gmail.com",
      snapshot,
    });
    const [row] = readCitations(eventId);
    expect(row.sourceType).toBe("other");
  });

  it("body and attachment sources stay user_submitted", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: { ...specimen(), url: "" },
      source: { kind: "attachment" as const, name: "flyer.pdf" },
      fromAddress: "info@mainecheesefestival.org",
      supportingText: PAGE_TEXT,
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.sourceType).toBe("user_submitted");
  });
});

describe("OPE-838 scope 5 — description and venue name are cited", () => {
  it("cites description and venue_name alongside the date fields", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "info@mainecheesefestival.org",
      snapshot,
    });
    const fields = readCitations(eventId)
      .map((r) => r.fieldName)
      .sort();
    expect(fields).toEqual([
      "description",
      "end_date",
      "end_time",
      "name",
      "start_date",
      "start_time",
      "venue_name",
    ]);
  });

  it("does NOT invent a venue_id citation — this layer has a name, not an id", async () => {
    // venue_id is minted downstream by autoLinkVenue. Citing it here would
    // attribute an identifier the source never stated.
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: specimen(),
      source: urlSource,
      fromAddress: "info@mainecheesefestival.org",
      snapshot,
    });
    const rows = readCitations(eventId);
    expect(rows.length).toBe(7); // positive landmark for the negative below
    expect(rows.map((r) => r.fieldName)).not.toContain("venue_id");
  });
});

describe("OPE-838 — the widened ROW SHAPE stays under D1's bind-param ceiling", () => {
  it("never emits an insert over 100 params once the snapshot columns are bound", async () => {
    // ⚠️ This is the test the OPE-744 guard could not be: that one passes no
    // snapshot, so it counts 13 bound columns per row and goes green at a chunk
    // size that binds 17 in production. 6 x 17 = 102, over the ceiling —
    // introduced by adding COLUMNS while the row COUNT stayed legal.
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
      extracted: {
        url: PAGE_URL,
        event: {
          name: "Maine Cheese Festival",
          startDate: "2026-09-13",
          endDate: "2026-09-13",
          description: "A celebration of Maine's food and artisan community.",
          venueName: "Manson Park",
          startTime: "11:00",
          endTime: "17:00",
          ticketPriceMin: 10,
          ticketPriceMax: 35,
          vendorFeeMin: 100,
          vendorFeeMax: 400,
          estimatedAttendance: 5000,
          applicationDeadline: "2026-08-14",
        },
        fieldConfidence: {},
      },
      source: urlSource,
      fromAddress: "info@mainecheesefestival.org",
      snapshot,
    });

    // All thirteen rows land — chunking must not lose any.
    expect(res.inserted).toBe(13);
    expect(readCitations(eventId)).toHaveLength(13);

    // Match the citation INSERT precisely: a loose includes("event_data_citations")
    // also matches the SELECT that reads already-cited fields and would go
    // vacuously green on a statement binding almost nothing.
    const inserts = seen.filter((s) => /insert\s+into\s+["'`]?event_data_citations/i.test(s));
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });
});
