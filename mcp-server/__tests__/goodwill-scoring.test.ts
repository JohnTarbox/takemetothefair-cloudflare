/**
 * Unit tests for GW1c Bayesian reliability updater.
 *
 * Critical assertions:
 *   - confidenceFromChecks bucket boundaries (0 / 1-9 / ≥10)
 *   - Cold-start cell creation reads source_type_priors and lands
 *     at the prior mean
 *   - Resolved-authoritative bumps the authoritative source's alpha,
 *     the divergent source's beta
 *   - Resolved-divergent inverts (authoritative beta, divergent alpha)
 *   - Dismissed resolution is a no-op
 *   - Circularity guard: resolution_source='higher_tier' +
 *     resolved_authoritative does NOT credit the authoritative side
 *     (only debits the divergent side)
 *   - Missing source_key on either side cleanly skips that side
 *   - Repeated calls update n_checks and score consistently
 */

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { updateReliability, confidenceFromChecks, MODEL_VERSION } from "../src/goodwill/scoring.js";
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

  // Seed a minimal event + sources registry + priors so the updater
  // has cells to read.
  await db.insert(events).values({
    id: "evt-1",
    name: "Test Event",
    slug: "test-event",
    promoterId: "p-1",
    status: "APPROVED",
  });

  await db.insert(sources).values([
    {
      sourceKey: "official.example",
      displayName: "Official Example",
      sourceType: "official",
      authorityWeight: 1.0,
      createdAt: new Date(),
    },
    {
      sourceKey: "aggregator.example",
      displayName: "Aggregator Example",
      sourceType: "aggregator",
      authorityWeight: 1.0,
      createdAt: new Date(),
    },
  ]);

  // Seed just the (official|aggregator) × date × accuracy priors so the
  // tests focus on the date-accuracy path. The full 112-row seed isn't
  // needed for these unit tests.
  await db.insert(sourceTypePriors).values([
    { sourceType: "official", fieldClass: "date", axis: "accuracy", priorAlpha: 8, priorBeta: 2 },
    {
      sourceType: "aggregator",
      fieldClass: "date",
      axis: "accuracy",
      priorAlpha: 2,
      priorBeta: 8,
    },
    { sourceType: "unknown", fieldClass: "date", axis: "accuracy", priorAlpha: 5, priorBeta: 5 },
  ]);
});

async function seedDiscrepancy(args: {
  id: string;
  authoritativeSourceKey: string | null;
  divergentSourceKey: string | null;
  resolutionStatus: "resolved_authoritative" | "resolved_divergent" | "dismissed" | "open";
  resolutionSource?: "higher_tier" | "post_event" | "operator" | null;
  fieldClass?: "date" | "name";
}): Promise<void> {
  await db.insert(eventDiscrepancies).values({
    id: args.id,
    eventId: "evt-1",
    fieldClass: args.fieldClass ?? "date",
    detectedBy: "ingest_addverify",
    detectedAt: new Date(),
    authoritativeSourceKey: args.authoritativeSourceKey,
    divergentSourceKey: args.divergentSourceKey,
    resolutionStatus: args.resolutionStatus,
    resolutionSource: args.resolutionSource ?? null,
    outreachCandidate: false,
  });
}

async function getCell(sourceKey: string, fieldClass: string, axis: string) {
  const rows = await db
    .select()
    .from(sourceReliability)
    .where(
      and(
        eq(sourceReliability.sourceKey, sourceKey),
        eq(sourceReliability.fieldClass, fieldClass),
        eq(sourceReliability.axis, axis)
      )
    )
    .limit(1);
  return rows[0];
}

describe("confidenceFromChecks", () => {
  it("returns prior_only at n=0", () => {
    expect(confidenceFromChecks(0)).toBe("prior_only");
  });

  it("returns low for 1 ≤ n < 10", () => {
    expect(confidenceFromChecks(1)).toBe("low");
    expect(confidenceFromChecks(9)).toBe("low");
  });

  it("returns established at n ≥ 10", () => {
    expect(confidenceFromChecks(10)).toBe("established");
    expect(confidenceFromChecks(50)).toBe("established");
  });
});

describe("updateReliability — skip paths", () => {
  it("returns skipped_missing_discrepancy for unknown id", async () => {
    const r = await updateReliability(db, "nope");
    expect(r.decision).toBe("skipped_missing_discrepancy");
  });

  it("returns skipped_not_resolved for status='open'", async () => {
    await seedDiscrepancy({
      id: "d-open",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "open",
    });
    const r = await updateReliability(db, "d-open");
    expect(r.decision).toBe("skipped_not_resolved");
  });

  it("returns skipped_not_resolved for status='dismissed'", async () => {
    await seedDiscrepancy({
      id: "d-dismissed",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "dismissed",
    });
    const r = await updateReliability(db, "d-dismissed");
    expect(r.decision).toBe("skipped_not_resolved");
  });

  it("returns skipped_no_source when both keys are null", async () => {
    await seedDiscrepancy({
      id: "d-nosrc",
      authoritativeSourceKey: null,
      divergentSourceKey: null,
      resolutionStatus: "resolved_authoritative",
      resolutionSource: "operator",
    });
    const r = await updateReliability(db, "d-nosrc");
    expect(r.decision).toBe("skipped_no_source");
  });
});

describe("updateReliability — resolved_authoritative path", () => {
  it("credits the authoritative source (+alpha) and debits the divergent (+beta)", async () => {
    await seedDiscrepancy({
      id: "d-auth",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "resolved_authoritative",
      resolutionSource: "post_event",
    });
    const r = await updateReliability(db, "d-auth");
    expect(r.decision).toBe("updated");
    expect(r.cellsTouched).toBe(2);

    const official = await getCell("official.example", "date", "accuracy");
    // Prior was (8, 2), one alpha bump → (9, 2). Score = 9/11 ≈ 0.818
    expect(official.alpha).toBe(9);
    expect(official.beta).toBe(2);
    expect(official.nChecks).toBe(1);
    expect(official.confidence).toBe("low");
    expect(official.score).toBeCloseTo(9 / 11, 3);
    expect(official.modelVersion).toBe(MODEL_VERSION);

    const aggregator = await getCell("aggregator.example", "date", "accuracy");
    // Prior was (2, 8), one beta bump → (2, 9). Score = 2/11 ≈ 0.182
    expect(aggregator.alpha).toBe(2);
    expect(aggregator.beta).toBe(9);
    expect(aggregator.score).toBeCloseTo(2 / 11, 3);
  });
});

describe("updateReliability — resolved_divergent path", () => {
  it("credits the divergent source (+alpha) and debits the authoritative (+beta)", async () => {
    await seedDiscrepancy({
      id: "d-div",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "resolved_divergent",
      resolutionSource: "post_event",
    });
    const r = await updateReliability(db, "d-div");
    expect(r.decision).toBe("updated");

    const official = await getCell("official.example", "date", "accuracy");
    // Lost: (8, 2) + (0, 1) = (8, 3). Score = 8/11 ≈ 0.727
    expect(official.alpha).toBe(8);
    expect(official.beta).toBe(3);

    const aggregator = await getCell("aggregator.example", "date", "accuracy");
    // Won: (2, 8) + (1, 0) = (3, 8). Score = 3/11 ≈ 0.273
    expect(aggregator.alpha).toBe(3);
    expect(aggregator.beta).toBe(8);
  });
});

describe("updateReliability — circularity guard", () => {
  it("does NOT credit the authoritative side when resolution_source='higher_tier' + resolved_authoritative", async () => {
    await seedDiscrepancy({
      id: "d-circular",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "resolved_authoritative",
      resolutionSource: "higher_tier",
    });
    const r = await updateReliability(db, "d-circular");
    expect(r.decision).toBe("updated");
    // Only one cell touched (the divergent side debit) per the guard.
    expect(r.cellsTouched).toBe(1);

    // Authoritative side: never written → no row.
    const official = await getCell("official.example", "date", "accuracy");
    expect(official).toBeUndefined();

    // Divergent side: still debited.
    const aggregator = await getCell("aggregator.example", "date", "accuracy");
    expect(aggregator.alpha).toBe(2);
    expect(aggregator.beta).toBe(9);
  });

  it("DOES credit the authoritative side when resolution_source='operator' + resolved_authoritative", async () => {
    // Operator-driven resolution isn't subject to the guard — the
    // operator's call comes from outside both sources.
    await seedDiscrepancy({
      id: "d-operator",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: "aggregator.example",
      resolutionStatus: "resolved_authoritative",
      resolutionSource: "operator",
    });
    const r = await updateReliability(db, "d-operator");
    expect(r.cellsTouched).toBe(2);
    const official = await getCell("official.example", "date", "accuracy");
    expect(official.alpha).toBe(9); // credited
  });
});

describe("updateReliability — repeated calls accumulate correctly", () => {
  it("two resolved_authoritative calls move alpha from 8→9→10 and bump confidence", async () => {
    for (const id of ["d-1", "d-2"]) {
      await seedDiscrepancy({
        id,
        authoritativeSourceKey: "official.example",
        divergentSourceKey: "aggregator.example",
        resolutionStatus: "resolved_authoritative",
        resolutionSource: "post_event",
      });
      await updateReliability(db, id);
    }
    const official = await getCell("official.example", "date", "accuracy");
    expect(official.alpha).toBe(10);
    expect(official.beta).toBe(2);
    expect(official.nChecks).toBe(2);
    expect(official.confidence).toBe("low");
  });

  it("reaches 'established' confidence after 10 checks", async () => {
    for (let i = 0; i < 10; i++) {
      await seedDiscrepancy({
        id: `d-${i}`,
        authoritativeSourceKey: "official.example",
        divergentSourceKey: "aggregator.example",
        resolutionStatus: "resolved_authoritative",
        resolutionSource: "post_event",
      });
      await updateReliability(db, `d-${i}`);
    }
    const official = await getCell("official.example", "date", "accuracy");
    expect(official.nChecks).toBe(10);
    expect(official.confidence).toBe("established");
  });
});

describe("updateReliability — single-source paths", () => {
  it("only updates the authoritative side when divergent is null", async () => {
    await seedDiscrepancy({
      id: "d-1side",
      authoritativeSourceKey: "official.example",
      divergentSourceKey: null,
      resolutionStatus: "resolved_authoritative",
      resolutionSource: "post_event",
    });
    const r = await updateReliability(db, "d-1side");
    expect(r.cellsTouched).toBe(1);
    const official = await getCell("official.example", "date", "accuracy");
    expect(official.alpha).toBe(9);
  });
});
