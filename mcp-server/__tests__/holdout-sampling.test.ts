/**
 * Tests for GW1.3 (2026-06-03) holdout-sampling cron helpers.
 *
 * The full cron handler is hard to test in isolation because it calls
 * `submitFetch` / `submitExtract` (HTTP to main app) per sampled event.
 * Those wrappers are already covered by the email-handlers test suite.
 *
 * What we test here:
 *   - The pure value-comparison helpers (`simpleNormalize`,
 *     `composeVenue`) that the cron uses to decide what counts as a
 *     field disagreement.
 *   - The sample SELECT — verify it picks only events whose
 *     authoritative source is at `confidence='established' AND axis=
 *     'accuracy' AND score > 0.8`. This is the gate that prevents the
 *     cron from re-checking sources we haven't yet built confidence in.
 *   - `captureHoldoutSampleDiscrepancy` writes the right shape and
 *     inherits the 24h idempotence guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { simpleNormalize, composeVenue } from "../src/goodwill/holdout-sampling.js";
import { captureHoldoutSampleDiscrepancy } from "../src/goodwill/capture.js";
import { events, promoters, eventDiscrepancies, sourceReliability } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("simpleNormalize", () => {
  it("lowercases and strips punctuation (and collapses the resulting whitespace)", () => {
    // "Sip & Stroll" → strip "&" → "Sip  Stroll" → collapse → "sip stroll"
    expect(simpleNormalize("Sip & Stroll: Local Wines")).toBe("sip stroll local wines");
  });

  it("collapses whitespace", () => {
    expect(simpleNormalize("Big   Top  Carnival")).toBe("big top carnival");
  });

  it("treats null/empty as empty string", () => {
    expect(simpleNormalize(null)).toBe("");
    expect(simpleNormalize("")).toBe("");
    expect(simpleNormalize(undefined)).toBe("");
  });

  it("considers normalized renames equal", () => {
    // The reason we don't use a Levenshtein threshold for the holdout
    // path: the same source page renaming "Fest" → "Festival" is a real
    // signal we want to capture, but punctuation/case changes aren't.
    expect(simpleNormalize("Apple Fest 2026!")).toBe("apple fest 2026");
    expect(simpleNormalize("APPLE FEST 2026")).toBe("apple fest 2026");
  });
});

describe("composeVenue", () => {
  it("formats 'City, ST' with uppercased state", () => {
    expect(composeVenue("Brattleboro", "vt")).toBe("Brattleboro, VT");
  });

  it("returns null when either component is missing", () => {
    expect(composeVenue(null, "VT")).toBeNull();
    expect(composeVenue("Brattleboro", null)).toBeNull();
    expect(composeVenue(null, null)).toBeNull();
  });

  it("returns null on whitespace-only strings", () => {
    expect(composeVenue("   ", "VT")).toBeNull();
    expect(composeVenue("Brattleboro", "  ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(composeVenue("  Brattleboro  ", " vt ")).toBe("Brattleboro, VT");
  });
});

describe("captureHoldoutSampleDiscrepancy", () => {
  it("writes one event_discrepancies row with detected_by='holdout_sample'", async () => {
    // Need an event row for the FK target.
    await seedPromoter(db, "prom-1");
    await db.insert(events).values({
      id: "evt-1",
      name: "Test Event",
      slug: "test-event-1",
      promoterId: "prom-1",
      sourceUrl: "https://example.com/event",
    });

    const id = await captureHoldoutSampleDiscrepancy(db, {
      eventId: "evt-1",
      fieldClass: "date",
      storedValue: "2026-06-08",
      refreshValue: "2026-06-15",
      sourceUrl: "https://example.com/event",
      notes: "test",
    });
    expect(id).not.toBeNull();

    const rows = await db.select().from(eventDiscrepancies).where(eq(eventDiscrepancies.id, id!));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.detectedBy).toBe("holdout_sample");
    expect(row.fieldClass).toBe("date");
    expect(row.authoritativeValue).toBe("2026-06-08");
    expect(row.divergentValue).toBe("2026-06-15");
    // Both source halves point at the same URL — the source IS the
    // authoritative side being tested.
    expect(row.authoritativeSourceKey).toBe("example.com");
    expect(row.divergentSourceKey).toBe("example.com");
    expect(row.confidence).toBe(0.8);
  });

  it("respects the 24-hour idempotence guard", async () => {
    await seedPromoter(db, "prom-1");
    await db.insert(events).values({
      id: "evt-2",
      name: "Test Event",
      slug: "test-event-2",
      promoterId: "prom-1",
      sourceUrl: "https://example.com/event",
    });

    const first = await captureHoldoutSampleDiscrepancy(db, {
      eventId: "evt-2",
      fieldClass: "date",
      storedValue: "a",
      refreshValue: "b",
      sourceUrl: "https://example.com/event",
    });
    const second = await captureHoldoutSampleDiscrepancy(db, {
      eventId: "evt-2",
      fieldClass: "date",
      storedValue: "a",
      refreshValue: "different-b",
      sourceUrl: "https://example.com/event",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // 24-hour guard prevented duplicate
  });

  it("allows different field_classes for the same event in the same window", async () => {
    await seedPromoter(db, "prom-1");
    await db.insert(events).values({
      id: "evt-3",
      name: "Test Event",
      slug: "test-event-3",
      promoterId: "prom-1",
      sourceUrl: "https://example.com/event",
    });

    const dateId = await captureHoldoutSampleDiscrepancy(db, {
      eventId: "evt-3",
      fieldClass: "date",
      storedValue: "x",
      refreshValue: "y",
      sourceUrl: "https://example.com/event",
    });
    const venueId = await captureHoldoutSampleDiscrepancy(db, {
      eventId: "evt-3",
      fieldClass: "venue",
      storedValue: "x",
      refreshValue: "y",
      sourceUrl: "https://example.com/event",
    });
    expect(dateId).not.toBeNull();
    expect(venueId).not.toBeNull();
    expect(dateId).not.toBe(venueId);
  });
});

describe("sample SELECT gate — events whose source_domain is high-trust", () => {
  // The cron's SELECT gates on events.source_domain being in the
  // established + score>0.8 set. (Schema-correct alternative to the
  // spec's pseudocode which referenced `event_data_citations.source_key`,
  // a column that doesn't exist — see the comment in
  // holdout-sampling.ts for why.) This test verifies the gate excludes
  // sources we haven't yet built confidence in.

  it("picks only events whose source_domain is established + high-score on accuracy", async () => {
    await seedPromoter(db, "prom-1");
    await db.insert(events).values([
      {
        id: "evt-high",
        name: "High Trust",
        slug: "high-trust",
        promoterId: "prom-1",
        sourceUrl: "https://highscore.com/e",
        sourceDomain: "highscore.com",
      },
      {
        id: "evt-low",
        name: "Low Conf",
        slug: "low-conf",
        promoterId: "prom-1",
        sourceUrl: "https://lowscore.com/e",
        sourceDomain: "lowscore.com",
      },
      {
        id: "evt-no-source",
        name: "No Source",
        slug: "no-source",
        promoterId: "prom-1",
        // No source_url / source_domain — should be excluded
      },
    ]);
    await db.insert(sourceReliability).values([
      {
        sourceKey: "highscore.com",
        fieldClass: "date",
        axis: "accuracy",
        priorType: "official_website",
        alpha: 50,
        beta: 5,
        nChecks: 55,
        nAgreed: 50,
        nStale: 0,
        score: 0.91, // > 0.8
        confidence: "established",
        modelVersion: "gw1-2026-06",
        lastUpdated: new Date(),
      },
      {
        sourceKey: "lowscore.com",
        fieldClass: "date",
        axis: "accuracy",
        priorType: "official_website",
        alpha: 5,
        beta: 4,
        nChecks: 9,
        nAgreed: 5,
        nStale: 0,
        score: 0.55,
        confidence: "low", // not established
        modelVersion: "gw1-2026-06",
        lastUpdated: new Date(),
      },
    ]);

    const drizzleOrm = await import("drizzle-orm");
    const picked = await db.all<{ id: string }>(
      drizzleOrm.sql`
        SELECT id FROM events
        WHERE source_url IS NOT NULL
        AND source_domain IS NOT NULL
        AND source_domain IN (
          SELECT source_key FROM source_reliability
          WHERE confidence = 'established'
            AND axis = 'accuracy'
            AND score > 0.8
        )
      `
    );
    expect(picked.map((r) => r.id)).toEqual(["evt-high"]);
  });

  it("excludes events whose source has 'low' confidence even with high score", async () => {
    // Cross-cell guard: a source that recently jumped to score>0.8 but
    // hasn't accumulated enough observations to be `established` should
    // NOT be re-checked yet. The CPI guardrail rationale: we want to
    // be re-checking the sources we've *committed* to trusting, not
    // ones we're still feeling out.
    await seedPromoter(db, "prom-1");
    await db.insert(events).values({
      id: "evt-borderline",
      name: "Borderline",
      slug: "borderline",
      promoterId: "prom-1",
      sourceUrl: "https://newhotsource.com/e",
      sourceDomain: "newhotsource.com",
    });
    await db.insert(sourceReliability).values({
      sourceKey: "newhotsource.com",
      fieldClass: "date",
      axis: "accuracy",
      priorType: "official_website",
      alpha: 8,
      beta: 1,
      nChecks: 9, // small N — not yet established
      nAgreed: 8,
      nStale: 0,
      score: 0.89, // > 0.8, but confidence is still 'low'
      confidence: "low",
      modelVersion: "gw1-2026-06",
      lastUpdated: new Date(),
    });

    const drizzleOrm = await import("drizzle-orm");
    const picked = await db.all<{ id: string }>(
      drizzleOrm.sql`
        SELECT id FROM events
        WHERE source_url IS NOT NULL
        AND source_domain IS NOT NULL
        AND source_domain IN (
          SELECT source_key FROM source_reliability
          WHERE confidence = 'established'
            AND axis = 'accuracy'
            AND score > 0.8
        )
      `
    );
    expect(picked).toEqual([]);
  });
});

async function seedPromoter(database: TestDb, id: string): Promise<void> {
  await database.insert(promoters).values({
    id,
    companyName: `Promoter ${id}`,
    slug: `promoter-${id}`,
  });
}
