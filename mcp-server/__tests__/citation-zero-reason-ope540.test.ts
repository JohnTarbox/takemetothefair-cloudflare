/**
 * OPE-540 — a zero that names itself.
 *
 * Every email-submitted event created on 2026-08-24 had zero citations
 * (`25c9c493`, `1da06d90`, `ea4fcb63`, `f5bc157e`, `5f917800`). The
 * investigation ruled out five candidate causes from source and still could
 * not say which one fired, because prod carries no evidence either way:
 *
 *   - `recordSourceCitations` returned a bare `number`, so 0 carried no reason
 *   - its caller wrote a `workflow_run_steps` row ONLY on throw
 *
 * So "the method was never reached" and "it ran and wrote nothing" left
 * byte-identical evidence: nothing at all. Five distinct causes, one
 * observable. `multi-source-fanout` records its own decline (OPE-537) and
 * that is exactly why it was diagnosable at a glance.
 *
 * These tests pin that every zero-return branch names itself. Coverage of the
 * happy paths lives in pipeline-citations.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordSourceCitations } from "../src/email-handlers/pipeline-citations.js";
import { events, promoters } from "../src/schema.js";

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

const FULL_EVENT = {
  name: "Fryeburg Fair 2026",
  startDate: "2026-10-04",
  endDate: "2026-10-11",
};

describe("every zero-citation outcome names its cause", () => {
  it("no-source-url: a url source carrying no URL", async () => {
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: { url: "", event: FULL_EVENT },
      // `url` kind with an empty url on both the extract and the source.
      source: { kind: "url", url: "" },
      fromAddress: "someone@example.com",
    });
    expect(out).toEqual({ inserted: 0, reason: "no-source-url" });
  });

  it("no-citeable-fields: the extractor produced nothing to cite", async () => {
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: {
        url: "https://example.com/e",
        event: { name: null, startDate: null, endDate: null },
      },
      source: { kind: "url", url: "https://example.com/e" },
      fromAddress: "someone@example.com",
    });
    expect(out).toEqual({ inserted: 0, reason: "no-citeable-fields" });
  });

  it("no-citeable-fields: whitespace-only values are not citeable either", async () => {
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: {
        url: "https://example.com/e",
        event: { name: "   ", startDate: "", endDate: null },
      },
      source: { kind: "url", url: "https://example.com/e" },
      fromAddress: "someone@example.com",
    });
    expect(out).toEqual({ inserted: 0, reason: "no-citeable-fields" });
  });

  it("all-fields-already-cited: a redelivery of the same source", async () => {
    // Distinguishing THIS from `no-citeable-fields` is the whole point: one
    // means the pipeline is working and idempotent, the other means the
    // extractor gave us nothing. A bare 0 conflated them.
    const eventId = seedEvent();
    const args = {
      eventId,
      extracted: { url: "https://example.com/e", event: FULL_EVENT },
      source: { kind: "url" as const, url: "https://example.com/e" },
      fromAddress: "someone@example.com",
    };
    const first = await recordSourceCitations(db, args);
    expect(first).toEqual({ inserted: 3, reason: null });

    const second = await recordSourceCitations(db, args);
    expect(second).toEqual({ inserted: 0, reason: "all-fields-already-cited" });
  });

  it("all-fields-contradicted: a body source whose text carries no year", async () => {
    // OPE-457's guard. Only the date fields are droppable, so this reason can
    // only surface when the dates are ALL there was — here, no name.
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: {
        url: "",
        event: { name: null, startDate: "2026-10-04", endDate: "2026-10-11" },
      },
      source: { kind: "body" },
      fromAddress: "someone@example.com",
      supportingText: "come to the fair next weekend, it is great",
    });
    expect(out).toEqual({ inserted: 0, reason: "all-fields-contradicted" });
  });

  it("a partial drop still reports success, not a reason", async () => {
    // The name survives the contradiction guard, so this is NOT a zero — and
    // must not be reported as one. `reason` is strictly about writing nothing.
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: { url: "", event: FULL_EVENT },
      source: { kind: "body" },
      fromAddress: "someone@example.com",
      supportingText: "come to the fair next weekend, it is great",
    });
    expect(out).toEqual({ inserted: 1, reason: null });
  });

  it("a successful write never carries a reason", async () => {
    const eventId = seedEvent();
    const out = await recordSourceCitations(db, {
      eventId,
      extracted: { url: "https://example.com/e", event: FULL_EVENT },
      source: { kind: "url", url: "https://example.com/e" },
      fromAddress: "someone@example.com",
    });
    expect(out.inserted).toBe(3);
    expect(out.reason).toBeNull();
  });
});
