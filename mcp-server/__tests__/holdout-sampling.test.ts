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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  simpleNormalize,
  composeVenue,
  isComparableExtraction,
  runScheduledHoldoutSampling,
  type HoldoutDeps,
} from "../src/goodwill/holdout-sampling.js";
import { captureHoldoutSampleDiscrepancy } from "../src/goodwill/capture.js";
import {
  errorLogs,
  events,
  promoters,
  eventDiscrepancies,
  sourceReliability,
} from "../src/schema.js";
import { NonRetryableError } from "cloudflare:workflows";

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

describe("isComparableExtraction — OPE-576", () => {
  it("refuses to compare a THIN extraction", () => {
    // `thin` is the K7 deterministic composer: a name off the OG title, a date
    // off a regex. Comparing that to stored fields manufactures disagreements
    // out of formatting rather than detecting drift at the source.
    expect(isComparableExtraction("thin")).toBe(false);
  });

  it("compares real readings of the page", () => {
    expect(isComparableExtraction("ai")).toBe(true);
    expect(isComparableExtraction("json-ld")).toBe(true);
  });

  it("compares when the method is absent — an older deploy defaults to 'ai'", () => {
    // `submitExtract` defaults a missing field to "ai", so undefined here means
    // an ordinary extraction, not an unknown one. Failing closed on undefined
    // would silently stop the sampler comparing anything at all.
    expect(isComparableExtraction(undefined)).toBe(true);
  });
});

describe("runScheduledHoldoutSampling — OPE-576 one fetch per page, and not every day for a page it cannot read", () => {
  const NOW = new Date("2026-09-16T06:10:00Z");
  const ENV = { DB: {} as D1Database, MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k" };
  const LIST_PAGE = "https://trusted.org/fairs-by-date.html";
  const FAIR_PAGE = "https://trusted.org/county-fair";

  async function seedCorpus(rows: Array<{ id: string; url: string; name?: string }>) {
    await seedPromoter(db, "prom-1");
    await db.insert(sourceReliability).values({
      sourceKey: "trusted.org",
      fieldClass: "date",
      axis: "accuracy",
      priorType: "official_website",
      alpha: 50,
      beta: 5,
      nChecks: 55,
      nAgreed: 50,
      nStale: 0,
      score: 0.91,
      confidence: "established",
      modelVersion: "gw1-2026-06",
      lastUpdated: new Date(),
    });
    for (const r of rows) {
      await db.insert(events).values({
        id: r.id,
        name: r.name ?? `Fair ${r.id}`,
        slug: `fair-${r.id}`,
        promoterId: "prom-1",
        sourceUrl: r.url,
        sourceDomain: "trusted.org",
      });
    }
  }

  function fetched(url: string) {
    return {
      url,
      content: "page",
      title: null,
      description: null,
      ogImage: null,
      jsonLdSerialized: null,
      links: [],
      fetchMethod: "standard" as const,
    };
  }

  function extracted(url: string, name: string, totalEventsDetected = 1) {
    return {
      url,
      event: { name } as never,
      extractionMethod: "ai" as const,
      totalEventsDetected,
      additionalEventNames: [],
    } as unknown as Awaited<ReturnType<HoldoutDeps["submitExtract"]>>;
  }

  // The job's log rows are stamped by logError with the REAL clock, while the
  // cooldown is measured from deps.now(). Pinning Date to each run's `now`
  // keeps both on one clock; without it this suite passed only while the real
  // clock sat within a day of NOW, and began failing at 2026-09-17 06:10Z.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAt(d: HoldoutDeps) {
    vi.setSystemTime(d.now());
    return runScheduledHoldoutSampling(db as never, ENV, d);
  }

  function deps(extract: HoldoutDeps["submitExtract"]): HoldoutDeps {
    return {
      submitFetch: vi.fn(async (_env, url: string) => fetched(url)) as never,
      submitExtract: vi.fn(extract) as never,
      now: () => NOW,
    };
  }

  it("fetches a page shared by several events ONCE per run", async () => {
    await seedCorpus([
      { id: "a", url: LIST_PAGE },
      { id: "b", url: LIST_PAGE },
      { id: "c", url: LIST_PAGE },
      { id: "d", url: FAIR_PAGE },
    ]);
    const d = deps(async (_e, f) => extracted(f.url, "whatever"));

    const r = await runAt(d);

    const urls = vi.mocked(d.submitFetch).mock.calls.map((c) => c[1]);
    expect(urls.sort()).toEqual([FAIR_PAGE, LIST_PAGE].sort()); // landmark: both pages read
    expect(r.skippedDuplicateUrl).toBe(2);
  });

  it("does not re-fetch a page that timed out within the cooldown, and does once it has passed", async () => {
    await seedCorpus([
      { id: "a", url: LIST_PAGE },
      { id: "d", url: FAIR_PAGE, name: "County Fair" },
    ]);
    const timeout = async (_e: unknown, f: { url: string }) => {
      if (f.url === LIST_PAGE) throw new NonRetryableError("extract-upstream: extractor timed out");
      return extracted(f.url, "County Fair");
    };

    // Day 1: the list page times out, and the failure row carries the outcome.
    const d1 = deps(timeout as never);
    const first = await runAt(d1);
    expect(first.errors).toBe(1);
    expect(first.extracted).toBe(1);

    // Day 2: it is skipped without a fetch; the readable page still runs.
    const d2 = deps(timeout as never);
    d2.now = () => new Date(NOW.getTime() + 86_400_000);
    const second = await runAt(d2);
    expect(vi.mocked(d2.submitFetch).mock.calls.map((c) => c[1])).toEqual([FAIR_PAGE]);
    expect(second.skippedCooldown).toBe(1);

    // Day 9: the cooldown has passed, so the page is tried again.
    const d9 = deps(timeout as never);
    d9.now = () => new Date(NOW.getTime() + 8 * 86_400_000);
    await runAt(d9);
    expect(
      vi
        .mocked(d9.submitFetch)
        .mock.calls.map((c) => c[1])
        .sort()
    ).toEqual([FAIR_PAGE, LIST_PAGE].sort());
  });

  it("a THIN salvage and a failed fetch cool a page down too — neither is a comparison", async () => {
    await seedCorpus([
      { id: "a", url: LIST_PAGE },
      { id: "d", url: FAIR_PAGE },
    ]);
    const d1: HoldoutDeps = {
      submitFetch: vi.fn(async (_env, url: string) => {
        if (url === FAIR_PAGE) throw new Error("fetch-503");
        return fetched(url);
      }) as never,
      submitExtract: vi.fn(async (_e, f) => ({
        ...extracted(f.url, "x"),
        extractionMethod: "thin" as const,
      })) as never,
      now: () => NOW,
    };
    const first = await runAt(d1);
    expect(first.skippedThin).toBe(1);
    expect(first.errors).toBe(1);

    const d2 = deps(async (_e, f) => extracted(f.url, "x"));
    d2.now = () => new Date(NOW.getTime() + 86_400_000);
    const second = await runAt(d2);
    expect(vi.mocked(d2.submitFetch)).not.toHaveBeenCalled();
    expect(second.skippedCooldown).toBe(2);
  });

  it("a cooldown row written by another job, or without an outcome, does not suppress a page", async () => {
    await seedCorpus([{ id: "a", url: LIST_PAGE }]);
    await db.insert(errorLogs).values([
      {
        id: "other-source",
        timestamp: NOW,
        level: "warn",
        message: "x",
        source: "mcp:schedule:something-else",
        context: JSON.stringify({ sourceUrl: LIST_PAGE, holdoutOutcome: "thin" }),
      },
      {
        id: "no-outcome",
        timestamp: NOW,
        level: "warn",
        message: "holdout-sampling threw",
        source: "mcp:schedule:holdout-sampling",
        context: JSON.stringify({ sourceUrl: LIST_PAGE }),
      },
    ]);
    const d = deps(async (_e, f) => extracted(f.url, "Fair a"));
    const r = await runAt(d);
    expect(r.skippedCooldown).toBe(0);
    expect(vi.mocked(d.submitFetch)).toHaveBeenCalledTimes(1);
  });

  it("never compares a stored event against events[0] of a multi-event page", async () => {
    await seedCorpus([
      { id: "a", url: LIST_PAGE, name: "Blue Hill Fair" },
      { id: "d", url: FAIR_PAGE, name: "County Fair" },
    ]);
    const d = deps(
      async (_e, f) =>
        f.url === LIST_PAGE
          ? extracted(f.url, "Acton Fair", 11) // the first fair on the list, not ours
          : extracted(f.url, "County Fair Renamed") // a real single-page rename
    );

    const r = await runAt(d);

    expect(r.skippedMultiEvent).toBe(1);
    const rows = await db.select().from(eventDiscrepancies);
    // Landmark: the single-event page's rename IS captured…
    expect(rows.map((x) => x.eventId)).toEqual(["d"]);
    // …and nothing was raised against the list page's event.
    expect(rows.some((x) => x.eventId === "a")).toBe(false);
  });
});
