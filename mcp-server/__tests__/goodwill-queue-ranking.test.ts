/**
 * Unit tests for GW1d queue-ranking helpers + admin discrepancy tools.
 *
 * Covers:
 *   - computeOutreachPriorityScore formula correctness
 *   - field_severity bucket boundaries
 *   - rerankOpenQueueBatch joins to events.viewCount and to
 *     source_reliability.score, writes back priority + candidate flag
 *   - resolve_discrepancy MCP tool transitions open → resolved AND
 *     fires updateReliability
 *   - create_discrepancy MCP tool writes a manual row with an
 *     initial priority score
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb, CapturingMcpServer } from "./setup-db.js";
import {
  computeOutreachPriorityScore,
  rerankOpenQueueBatch,
  runScheduledQueueRerank,
  initialCaptureScore,
  QUEUE_RANK_WEIGHTS,
} from "../src/goodwill/queue-ranking.js";
import { registerDiscrepancyTools } from "../src/tools/admin-discrepancies.js";
import {
  eventDiscrepancies,
  sourceReliability,
  sourceTypePriors,
  sources,
  events,
} from "../src/schema.js";

let db: TestDb;

beforeEach(async () => {
  ({ db } = createTestDb());
  await db.insert(events).values({
    id: "evt-1",
    name: "Test Event",
    slug: "test-event",
    promoterId: "p-1",
    status: "APPROVED",
    viewCount: 100,
  });
});

describe("computeOutreachPriorityScore — bounds", () => {
  it("returns 0..1", () => {
    const score = computeOutreachPriorityScore({
      viewCount: 0,
      divergentSourceReliability: 1, // perfectly reliable ⇒ low priority
      detectorConfidence: 0,
      detectedAt: new Date("2020-01-01"), // ancient
      fieldClass: "status", // lowest severity
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns a higher score when ALL terms point to 'high priority'", () => {
    const high = computeOutreachPriorityScore({
      viewCount: 10000, // log-normalized to 1
      divergentSourceReliability: 0, // unreliable ⇒ 1-0 = 1
      detectorConfidence: 1,
      detectedAt: new Date(), // fresh ⇒ 1
      fieldClass: "date", // severity 1
    });
    const low = computeOutreachPriorityScore({
      viewCount: 0,
      divergentSourceReliability: 1,
      detectorConfidence: 0,
      detectedAt: new Date("2020-01-01"),
      fieldClass: "status",
    });
    expect(high).toBeGreaterThan(low);
    expect(high).toBeCloseTo(1, 1);
  });
});

describe("computeOutreachPriorityScore — formula weights", () => {
  it("weights sum to 1", () => {
    const sum =
      QUEUE_RANK_WEIGHTS.viewCount +
      QUEUE_RANK_WEIGHTS.unreliable +
      QUEUE_RANK_WEIGHTS.detectorConfidence +
      QUEUE_RANK_WEIGHTS.recency +
      QUEUE_RANK_WEIGHTS.fieldSeverity;
    expect(sum).toBeCloseTo(1, 6);
  });

  it("field_severity assigns 'date' > 'price' > 'status'", () => {
    const base = {
      viewCount: 0,
      divergentSourceReliability: 0.5,
      detectorConfidence: 0.5,
      detectedAt: new Date("2020-01-01"),
    };
    const date = computeOutreachPriorityScore({ ...base, fieldClass: "date" });
    const price = computeOutreachPriorityScore({ ...base, fieldClass: "price" });
    const status = computeOutreachPriorityScore({ ...base, fieldClass: "status" });
    expect(date).toBeGreaterThan(price);
    expect(price).toBeGreaterThan(status);
  });

  it("unknown field_class falls back to 0.5", () => {
    const base = {
      viewCount: 0,
      divergentSourceReliability: 0.5,
      detectorConfidence: 0.5,
      detectedAt: new Date("2020-01-01"),
    };
    const unknown = computeOutreachPriorityScore({ ...base, fieldClass: "mystery" });
    const price = computeOutreachPriorityScore({ ...base, fieldClass: "price" });
    // unknown (0.5) is between status (0.4) and price (0.6); won't be
    // exactly equal but should be close.
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThan(price); // 0.5 < 0.6 on severity
  });
});

describe("rerankOpenQueueBatch", () => {
  beforeEach(async () => {
    // Seed a reliability row for the divergent source so the join
    // populates a non-null score.
    await db.insert(sourceReliability).values({
      sourceKey: "noisy.example",
      fieldClass: "date",
      axis: "accuracy",
      priorType: "aggregator",
      alpha: 2,
      beta: 10,
      nChecks: 8,
      nAgreed: 0,
      nStale: 0,
      score: 2 / 12, // ~0.17 — very unreliable
      confidence: "low",
      modelVersion: "gw1-2026-06",
      lastUpdated: new Date(),
    });

    // Seed two discrepancies — one missing a score (the rerank target),
    // one with a fresh recent score (should NOT be re-ranked).
    await db.insert(eventDiscrepancies).values([
      {
        id: "d-needs-rank",
        eventId: "evt-1",
        fieldClass: "date",
        detectedBy: "ingest_addverify",
        detectedAt: new Date(),
        divergentSourceKey: "noisy.example",
        confidence: 0.9,
        resolutionStatus: "open",
        outreachCandidate: false,
      },
      {
        id: "d-already-fresh",
        eventId: "evt-1",
        fieldClass: "date",
        detectedBy: "ingest_addverify",
        detectedAt: new Date(), // freshly detected
        divergentSourceKey: "noisy.example",
        confidence: 0.9,
        resolutionStatus: "open",
        outreachPriorityScore: 0.5,
        outreachCandidate: false,
      },
    ]);
  });

  it("scores the unranked row and writes outreachPriorityScore back", async () => {
    const result = await rerankOpenQueueBatch(db, { limit: 100 });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.updated).toBeGreaterThan(0);

    const ranked = await db
      .select({ score: eventDiscrepancies.outreachPriorityScore })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, "d-needs-rank"));
    expect(ranked[0].score).not.toBeNull();
    expect(ranked[0].score).toBeGreaterThan(0);
    expect(ranked[0].score).toBeLessThanOrEqual(1);
  });

  it("flags outreach_candidate=1 when score crosses 0.6", async () => {
    // The seeded discrepancy: very unreliable divergent source (0.17),
    // high detector confidence (0.9), fresh, date severity 1.0,
    // viewCount 100 (modest). Should land above 0.6.
    await rerankOpenQueueBatch(db, { limit: 100 });
    const ranked = await db
      .select({
        score: eventDiscrepancies.outreachPriorityScore,
        candidate: eventDiscrepancies.outreachCandidate,
      })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, "d-needs-rank"));
    if (ranked[0].score !== null && ranked[0].score >= 0.6) {
      expect(ranked[0].candidate).toBe(true);
    } else {
      expect(ranked[0].candidate).toBe(false);
    }
  });

  it("OPE-245: onlyMissing skips the already-scored fresh row", async () => {
    // Default path re-ranks null-score OR >24h; onlyMissing must touch ONLY
    // the null-score row, leaving the freshly-scored 0.5 row untouched.
    const result = await rerankOpenQueueBatch(db, { limit: 100, onlyMissing: true });
    expect(result.updated).toBe(1);
    const fresh = await db
      .select({ score: eventDiscrepancies.outreachPriorityScore })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, "d-already-fresh"));
    expect(fresh[0].score).toBe(0.5); // unchanged
  });

  it("OPE-245: runScheduledQueueRerank drains all missing scores", async () => {
    const result = await runScheduledQueueRerank(db, { batchSize: 1, maxBatches: 5 });
    expect(result.updated).toBe(1); // only d-needs-rank lacked a score
    const remaining = await db
      .select({ id: eventDiscrepancies.id })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.outreachPriorityScore, null as unknown as number));
    // No open row should still be null-scored.
    const nulls = await db.select().from(eventDiscrepancies);
    expect(nulls.every((r) => r.outreachPriorityScore !== null)).toBe(true);
    expect(remaining.length).toBe(0);
  });
});

describe("initialCaptureScore (OPE-245)", () => {
  it("is non-null and in [0,1] — the whole point (no more NULL on insert)", () => {
    const s = initialCaptureScore({ fieldClass: "date", confidence: 0.9, detectedAt: new Date() });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("matches computeOutreachPriorityScore with neutral view/reliability priors", () => {
    const detectedAt = new Date();
    const via = initialCaptureScore({ fieldClass: "venue", confidence: 0.7, detectedAt });
    const direct = computeOutreachPriorityScore({
      viewCount: null,
      divergentSourceReliability: null,
      detectorConfidence: 0.7,
      detectedAt,
      fieldClass: "venue",
    });
    // toBeCloseTo, not toBe: both paths recompute a recency factor from the wall
    // clock (Date.now()) internally, so the two calls — microseconds apart — can
    // differ by a float epsilon (seen in CI: 0.49 vs 0.4899999999935699). The
    // assertion is that the two paths AGREE, not that IEEE floats are identical.
    expect(via).toBeCloseTo(direct, 6);
  });

  it("stays below the 0.6 candidate threshold without a view count", () => {
    // By design: a discrepancy only becomes an outreach candidate once the
    // event's traffic is factored in by the rerank pass. Highest-severity,
    // freshest, most-confident case still can't cross 0.6 on priors alone.
    const s = initialCaptureScore({ fieldClass: "date", confidence: 1, detectedAt: new Date() });
    expect(s).toBeLessThan(0.6);
  });
});

// ── MCP tool tests ──────────────────────────────────────────────

describe("resolve_discrepancy MCP tool", () => {
  let server: CapturingMcpServer;

  beforeEach(async () => {
    server = new CapturingMcpServer();
    registerDiscrepancyTools(server as never, db, {
      role: "ADMIN",
      userId: "admin-1",
    } as never);

    await db.insert(sources).values([
      {
        sourceKey: "official.example",
        displayName: "Official",
        sourceType: "official",
        authorityWeight: 1.0,
        createdAt: new Date(),
      },
    ]);
    await db.insert(sourceTypePriors).values([
      { sourceType: "official", fieldClass: "date", axis: "accuracy", priorAlpha: 8, priorBeta: 2 },
      { sourceType: "unknown", fieldClass: "date", axis: "accuracy", priorAlpha: 5, priorBeta: 5 },
    ]);

    await db.insert(eventDiscrepancies).values({
      id: "d-resolve",
      eventId: "evt-1",
      fieldClass: "date",
      detectedBy: "ingest_addverify",
      detectedAt: new Date(),
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "open",
      outreachCandidate: false,
    });
  });

  it("transitions status open → resolved_authoritative and fires updateReliability", async () => {
    const result = (await server.invoke("resolve_discrepancy", {
      discrepancy_id: "d-resolve",
      resolution_status: "resolved_authoritative",
      resolution_source: "operator",
      resolved_value: "2026-06-15",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.new_status).toBe("resolved_authoritative");
    expect(payload.scoring_triggered).toBe(true);

    const row = await db
      .select()
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, "d-resolve"));
    expect(row[0].resolutionStatus).toBe("resolved_authoritative");
    expect(row[0].resolvedValue).toBe("2026-06-15");
  });

  it("idempotent on already-resolved rows (no re-scoring)", async () => {
    await server.invoke("resolve_discrepancy", {
      discrepancy_id: "d-resolve",
      resolution_status: "resolved_authoritative",
      resolution_source: "operator",
    });
    const second = (await server.invoke("resolve_discrepancy", {
      discrepancy_id: "d-resolve",
      resolution_status: "resolved_divergent", // try to flip
      resolution_source: "operator",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(second.content[0].text);
    // Second call still updates the row but does NOT re-fire scoring
    expect(payload.scoring_triggered).toBe(false);
  });
});

describe("create_discrepancy MCP tool", () => {
  let server: CapturingMcpServer;

  beforeEach(() => {
    server = new CapturingMcpServer();
    registerDiscrepancyTools(server as never, db, {
      role: "ADMIN",
      userId: "admin-1",
    } as never);
  });

  it("inserts a manual discrepancy with initial outreach_priority_score", async () => {
    const result = (await server.invoke("create_discrepancy", {
      event_id: "evt-1",
      field_class: "date",
      authoritative_value: "2026-06-15",
      authoritative_source_url: "https://official.example/event",
      divergent_value: "2026-06-22",
      divergent_source_url: "https://noisy.example/event",
      confidence: 0.85,
      notes: "spotted via Cowork audit",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.discrepancy_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.outreach_priority_score).toBeGreaterThan(0);

    const row = await db
      .select()
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, payload.discrepancy_id));
    expect(row[0].fieldClass).toBe("date");
    expect(row[0].detectedBy).toBe("manual");
    expect(row[0].authoritativeSourceKey).toBe("official.example");
    expect(row[0].divergentSourceKey).toBe("noisy.example");
    expect(row[0].confidence).toBeCloseTo(0.85, 3);
  });
});
