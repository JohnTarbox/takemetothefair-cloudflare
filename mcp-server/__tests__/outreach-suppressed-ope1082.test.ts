/**
 * OPE-1082 — a capture-time "never outreach" decision survives the re-ranker.
 *
 * It was written only as outreach_candidate = 0, and rerankOpenQueueBatch's
 * default selection (score NULL or detected > 24h ago — the manual
 * rerank_outreach_queue path) recomputes that bit from score alone, so the
 * first manual rerank re-promoted an aggregator's stale listing into the
 * promoter-outreach queue. Measured on prod 2026-09-19: latent (0 rows
 * re-promoted yet — the 6 open candidates predate OPE-815's suppression).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { events, eventDiscrepancies, promoters } from "../src/schema.js";
import { captureDiscrepancy } from "../src/goodwill/capture.js";
import { rerankOpenQueueBatch } from "../src/goodwill/queue-ranking.js";

let db: TestDb;
let raw: { exec: (s: string) => unknown };

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as { exec: (s: string) => unknown };
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  for (const id of ["agg", "org"]) {
    db.insert(events)
      .values({
        id,
        name: id,
        slug: id,
        promoterId: "p1",
        status: "APPROVED",
        viewCount: 5000,
      } as never)
      .run();
  }
});

const row = (eventId: string) =>
  db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.eventId, eventId)).all()[0];

describe("OPE-1082 — suppression is stored and honoured by the re-ranker", () => {
  it("a suppressed row stays out through a default rerank; an identical control is promoted", async () => {
    const base = {
      fieldClass: "date" as const,
      detectedBy: "stale_page_radar" as const,
      confidence: 1,
    };
    await captureDiscrepancy(db, { ...base, eventId: "agg", forceOutreachCandidate: false });
    await captureDiscrepancy(db, { ...base, eventId: "org" });
    expect(row("agg").outreachSuppressed).toBe(true);
    expect(row("org").outreachSuppressed).toBe(false);

    // Age both past 24h so the manual-rerank selection picks them up.
    raw.exec("UPDATE event_discrepancies SET detected_at = unixepoch() - 3 * 86400");
    const r = await rerankOpenQueueBatch(db, { limit: 100 });
    expect(r.scanned).toBe(2); // landmark: both rows were re-ranked

    // The control proves these inputs clear the threshold, so the suppressed
    // row's false is the stored decision, not a low score.
    expect(row("org").outreachCandidate).toBe(true);
    expect(row("agg").outreachPriorityScore).toBeCloseTo(row("org").outreachPriorityScore!, 6);
    expect(row("agg").outreachCandidate).toBe(false);
  });
});

describe("OPE-1082 — drizzle/0298 backfills only from stored facts", () => {
  const sql = readFileSync(
    join(__dirname, "../../drizzle/0298_ope1082_outreach_suppressed.sql"),
    "utf8"
  );
  // The ALTER is already applied by the test schema; run the data statements.
  const dataStatements = sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("UPDATE"));

  it("suppresses the four stored reasons, and leaves an organizer comparison alone", () => {
    expect(dataStatements).toHaveLength(2); // landmark: the statements were found
    const ins = (id: string, detectedBy: string, notes: string) =>
      raw.exec(`INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at,
        resolution_status, outreach_candidate, notes)
        VALUES ('${id}', 'agg', 'date', '${detectedBy}', unixepoch(), 'open', 1, '${notes}')`);
    ins("aggregator", "stale_page_radar", "drift 40d [target=aggregator]");
    ins("unknown", "stale_page_radar", "drift 40d [target=unknown]");
    ins("cancel", "stale_page_radar", "OPE-987 organizer-page cancellation notice (scopes: x)");
    ins("sa", "source_agreement", "OPE-988 source_url does not describe this event");
    ins("organizer", "stale_page_radar", "drift 40d [target=organizer]");
    ins("legacy", "stale_page_radar", "drift 43d between stored start_date and source");

    for (const s of dataStatements) raw.exec(s);

    const got = Object.fromEntries(
      db
        .select()
        .from(eventDiscrepancies)
        .all()
        .map((r) => [r.id, [r.outreachSuppressed, r.outreachCandidate]])
    );
    expect(got).toEqual({
      aggregator: [true, false],
      unknown: [true, false],
      cancel: [true, false],
      sa: [true, false],
      organizer: [false, true],
      // Pre-OPE-815 rows carry no target stamp: nothing stored says suppress.
      legacy: [false, true],
    });
  });
});
