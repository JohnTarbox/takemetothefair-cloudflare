/**
 * OPE-458 scope 2 — `recordSourceStale` must move `n_stale` and nothing else.
 *
 * The function's docblock states this ("deliberately does not move
 * alpha/beta"), and until now nothing enforced it. That is the same shape as
 * the defect the scope was written for: `n_stale` carried a comment claiming
 * holdout sampling incremented it, and holdout sampling never touched it —
 * PR #922 is its first writer.
 *
 * Why the isolation matters, not just that it holds: a page frozen at 2024 has
 * stopped being UPDATED, it is not DISAGREEING with us. Folding staleness into
 * the accuracy score would make a dormant organizer site indistinguishable
 * from a dishonest one, and irreversibly so — the two counters cannot be
 * separated again once summed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { sourceReliability } from "../src/schema.js";
import { recordSourceStale } from "../src/goodwill/scoring.js";

/** Matches the established fixture in goodwill-queue-ranking.test.ts — the
 *  table has several NOT NULL columns that are irrelevant here, and spelling
 *  them out per-test buries the assertion under scaffolding. */
function reliabilityRow(over: {
  sourceKey: string;
  alpha: number;
  beta: number;
  fieldClass?: "date" | "venue";
  axis?: "accuracy" | "freshness";
}) {
  return {
    sourceKey: over.sourceKey,
    fieldClass: (over.fieldClass ?? "date") as "date",
    axis: (over.axis ?? "accuracy") as "accuracy",
    priorType: "aggregator",
    alpha: over.alpha,
    beta: over.beta,
    nChecks: 0,
    nAgreed: 0,
    nStale: 0,
    score: over.alpha / (over.alpha + over.beta),
    confidence: "low" as const,
    modelVersion: "gw1-2026-06",
    lastUpdated: new Date(),
  };
}

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

function cell(sourceKey: string) {
  return db
    .select()
    .from(sourceReliability)
    .where(
      and(
        eq(sourceReliability.sourceKey, sourceKey),
        eq(sourceReliability.fieldClass, "date"),
        eq(sourceReliability.axis, "accuracy")
      )
    )
    .all();
}

describe("recordSourceStale", () => {
  it("creates the cell with cold-start priors on a first sighting", async () => {
    const ok = await recordSourceStale(db as never, "vineyardartisans.com");
    expect(ok).toBe(true);

    const rows = cell("vineyardartisans.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].nStale).toBe(1);
  });

  it("leaves alpha and beta EXACTLY as they were", async () => {
    // Seed an established reputation, then mark stale.
    db.insert(sourceReliability)
      .values(reliabilityRow({ sourceKey: "frozen.example.com", alpha: 42, beta: 7 }))
      .run();

    await recordSourceStale(db as never, "frozen.example.com");

    const [row] = cell("frozen.example.com");
    expect(row.nStale).toBe(1);
    // The assertions that matter: a dormant source must not look less accurate.
    expect(row.alpha).toBe(42);
    expect(row.beta).toBe(7);
  });

  it("accumulates across repeat sightings without ever touching alpha/beta", async () => {
    db.insert(sourceReliability)
      .values(reliabilityRow({ sourceKey: "frozen.example.com", alpha: 10, beta: 3 }))
      .run();

    for (let i = 0; i < 3; i++) await recordSourceStale(db as never, "frozen.example.com");

    const [row] = cell("frozen.example.com");
    expect(row.nStale).toBe(3);
    expect(row.alpha).toBe(10);
    expect(row.beta).toBe(3);
  });

  it("touches only the (date, accuracy) cell, not the source's other cells", async () => {
    for (const [fieldClass, axis] of [
      ["date", "accuracy"],
      ["date", "freshness"],
      ["venue", "accuracy"],
    ] as const) {
      db.insert(sourceReliability)
        .values(
          reliabilityRow({ sourceKey: "multi.example.com", alpha: 5, beta: 5, fieldClass, axis })
        )
        .run();
    }

    await recordSourceStale(db as never, "multi.example.com");

    const all = db
      .select()
      .from(sourceReliability)
      .where(eq(sourceReliability.sourceKey, "multi.example.com"))
      .all();

    const marked = all.filter((r) => (r.nStale ?? 0) > 0);
    expect(marked).toHaveLength(1);
    expect(marked[0].fieldClass).toBe("date");
    expect(marked[0].axis).toBe("accuracy");
  });

  it("is best-effort — a failure returns false rather than throwing", async () => {
    // A reliability counter must never fail a submission. Passing a broken db
    // proves the contract rather than trusting the try/catch by inspection.
    const broken = {
      insert: () => {
        throw new Error("d1 down");
      },
      update: () => {
        throw new Error("d1 down");
      },
      select: () => {
        throw new Error("d1 down");
      },
    };
    await expect(recordSourceStale(broken as never, "x.example.com")).resolves.toBe(false);
  });
});
