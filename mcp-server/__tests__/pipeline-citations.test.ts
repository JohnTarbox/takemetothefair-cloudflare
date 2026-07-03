/**
 * OPE-69 — per-source event_data_citations provenance for the multi-source
 * inbound-email pipeline. Unit tests for the `recordSourceCitations` helper
 * (src/email-handlers/pipeline-citations.ts).
 *
 * Covers:
 *   - new event from a url source        → sourceUrl = the URL, hostname name
 *   - new event from a body source       → sourceUrl = email://<from>
 *   - new event from an attachment source→ sourceUrl includes /attachment/
 *   - keeper dedup                       → citations land on the EXISTING id
 *   - idempotency                        → running twice inserts once
 *   - two sources, same field            → both rows stay active (coexist)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordSourceCitations } from "../src/email-handlers/pipeline-citations.js";
import { eventDataCitations, events, promoters } from "../src/schema.js";
import { and, eq } from "drizzle-orm";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
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

function extractedFixture(over: Partial<{ url: string }> = {}) {
  return {
    url: over.url ?? "",
    event: {
      name: "Fryeburg Fair 2026",
      startDate: "2026-10-04",
      endDate: "2026-10-11",
    },
    fieldConfidence: { name: "high" as const, startDate: "medium" as const },
  };
}

function readCitations(eventId: string) {
  return db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, eventId)).all();
}

describe("recordSourceCitations", () => {
  it("url source → citations with the URL as source_url and hostname as source_name", async () => {
    const eventId = seedEvent();
    const n = await recordSourceCitations(db, {
      eventId,
      extracted: extractedFixture({ url: "https://fryeburgfair.org/schedule" }),
      source: { kind: "url", url: "https://fryeburgfair.org/schedule" },
      fromAddress: "sender@example.com",
    });
    expect(n).toBe(3); // name, start_date, end_date
    const rows = readCitations(eventId);
    const byField = new Map(rows.map((r) => [r.fieldName, r]));
    expect(byField.get("name")?.sourceUrl).toBe("https://fryeburgfair.org/schedule");
    expect(byField.get("name")?.sourceName).toBe("fryeburgfair.org");
    expect(byField.get("start_date")?.value).toBe("2026-10-04");
    // All email-pipeline citations use "user_submitted" + active.
    for (const r of rows) {
      expect(r.sourceType).toBe("user_submitted");
      expect(r.state).toBe("active");
      expect(r.year).toBeNull();
      expect(r.createdBy).toBeNull();
    }
    // Confidence mapping: high→0.9, medium→0.6, absent→null.
    expect(byField.get("name")?.confidence).toBe(0.9);
    expect(byField.get("start_date")?.confidence).toBe(0.6);
    expect(byField.get("end_date")?.confidence).toBeNull();
  });

  it("body source → source_url = email://<from>, source_name = 'Email body'", async () => {
    const eventId = seedEvent();
    const n = await recordSourceCitations(db, {
      eventId,
      extracted: extractedFixture(),
      source: { kind: "body" },
      fromAddress: "promoter@fair.org",
    });
    expect(n).toBe(3);
    const rows = readCitations(eventId);
    for (const r of rows) {
      expect(r.sourceUrl).toBe("email://promoter@fair.org");
      expect(r.sourceName).toBe("Email body");
    }
  });

  it("attachment source → source_url includes /attachment/, source_name = 'Attachment: …'", async () => {
    const eventId = seedEvent();
    const n = await recordSourceCitations(db, {
      eventId,
      extracted: extractedFixture(),
      source: { kind: "attachment", name: "fair poster.pdf" },
      fromAddress: "promoter@fair.org",
    });
    expect(n).toBe(3);
    const rows = readCitations(eventId);
    for (const r of rows) {
      expect(r.sourceUrl).toBe(
        "email://promoter@fair.org/attachment/" + encodeURIComponent("fair poster.pdf")
      );
      expect(r.sourceUrl).toContain("/attachment/");
      expect(r.sourceName).toBe("Attachment: fair poster.pdf");
    }
  });

  it("keeper dedup → provenance is attached to the EXISTING event id", async () => {
    // The keeper already exists (from a prior source). A new candidate that
    // dedups into it must attach its provenance to the keeper, not drop it.
    const keeperId = seedEvent("keeper-1");
    const n = await recordSourceCitations(db, {
      eventId: keeperId,
      extracted: extractedFixture({ url: "https://second-source.example/event" }),
      source: { kind: "url", url: "https://second-source.example/event" },
      fromAddress: "sender@example.com",
    });
    expect(n).toBe(3);
    const rows = readCitations(keeperId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.eventId === keeperId)).toBe(true);
    expect(rows.every((r) => r.sourceUrl === "https://second-source.example/event")).toBe(true);
  });

  it("idempotency → running twice for the same (event, field, source) inserts once", async () => {
    const eventId = seedEvent();
    const args = {
      eventId,
      extracted: extractedFixture({ url: "https://fryeburgfair.org/schedule" }),
      source: { kind: "url" as const, url: "https://fryeburgfair.org/schedule" },
      fromAddress: "sender@example.com",
    };
    const first = await recordSourceCitations(db, args);
    const second = await recordSourceCitations(db, args);
    expect(first).toBe(3);
    expect(second).toBe(0); // dedupe guard skips all three
    expect(readCitations(eventId)).toHaveLength(3);
  });

  it("two different sources citing the same field → BOTH rows stay active (coexist)", async () => {
    const eventId = seedEvent();
    await recordSourceCitations(db, {
      eventId,
      extracted: extractedFixture({ url: "https://source-a.example/e" }),
      source: { kind: "url", url: "https://source-a.example/e" },
      fromAddress: "sender@example.com",
    });
    await recordSourceCitations(db, {
      eventId,
      extracted: extractedFixture(),
      source: { kind: "body" },
      fromAddress: "sender@example.com",
    });

    const nameRows = db
      .select()
      .from(eventDataCitations)
      .where(
        and(
          eq(eventDataCitations.eventId, eventId),
          eq(eventDataCitations.fieldName, "name"),
          eq(eventDataCitations.state, "active")
        )
      )
      .all();
    // No supersession: both the url-source and the body-source cite `name`,
    // and BOTH remain active — that coexistence is the "N sources agreed" signal.
    expect(nameRows).toHaveLength(2);
    const sourceUrls = nameRows.map((r) => r.sourceUrl).sort();
    expect(sourceUrls).toEqual(["email://sender@example.com", "https://source-a.example/e"]);
  });

  it("skips empty / missing fields (no thin rows)", async () => {
    const eventId = seedEvent();
    const n = await recordSourceCitations(db, {
      eventId,
      extracted: {
        url: "",
        event: { name: "Only A Name", startDate: null, endDate: "" },
      },
      source: { kind: "body" },
      fromAddress: "sender@example.com",
    });
    expect(n).toBe(1); // only `name`
    const rows = readCitations(eventId);
    expect(rows.map((r) => r.fieldName)).toEqual(["name"]);
  });
});
