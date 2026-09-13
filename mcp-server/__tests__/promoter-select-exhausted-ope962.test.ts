/**
 * OPE-962 — the nightly promoter selector, run for real against SQLite (getDb
 * is pointed at the test database), never selects an EXHAUSTED promoter.
 */
import { describe, it, expect, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { promoters } from "../src/schema.js";

const holder: { db: TestDb | null } = { db: null };
vi.mock("../src/db.js", () => ({ getDb: () => holder.db }));

const { runScheduledPromoterEnrichment } = await import("../src/enrichment/promoter-select.js");

describe("OPE-962 — runScheduledPromoterEnrichment", () => {
  it("skips EXHAUSTED; POSITIVE LANDMARK: still enqueues the NEEDS_ENRICHMENT one", async () => {
    const { db } = createTestDb();
    holder.db = db;
    for (const [id, status] of [
      ["done", "EXHAUSTED"],
      ["live", "NEEDS_ENRICHMENT"],
    ] as const) {
      await db.insert(promoters).values({
        id,
        companyName: id,
        slug: id,
        website: `https://${id}.example.com`,
        enrichmentStatus: status,
      } as never);
    }
    const sent: string[] = [];
    const queue = {
      sendBatch: async (msgs: Array<{ body: { promoterId: string } }>) => {
        sent.push(...msgs.map((m) => m.body.promoterId));
      },
    };
    const r = await runScheduledPromoterEnrichment(
      { DB: {} as D1Database, PROMOTER_ENRICHMENT: queue as never },
      "job-1",
      Date.now()
    );
    expect(sent).toEqual(["live"]);
    expect(r.enqueued).toBe(1);
  });
});
