/**
 * Unit tests for the deferred-IndexNow outbox (pending_search_pings).
 *
 * Covers enqueuePendingPing + claimAndFlush behaviors: empty queue, single
 * entity, multi-entity dedup, entity_type filter, max_age_seconds filter,
 * dry_run, concurrent claim disjointness, IndexNow error rollback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { claimAndFlush, enqueuePendingPing } from "../src/pending-pings.js";
import { pendingSearchPings } from "../src/schema.js";

const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

describe("enqueuePendingPing", () => {
  it("inserts an unflushed row with the supplied metadata", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "acme-co",
      action: "create",
    });
    const rows = db.select().from(pendingSearchPings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("vendor");
    expect(rows[0].entitySlug).toBe("acme-co");
    expect(rows[0].action).toBe("create");
    expect(rows[0].flushedAt).toBeNull();
    expect(rows[0].flushedBatchId).toBeNull();
  });
});

describe("claimAndFlush — empty queue", () => {
  it("returns flushedCount=0 with no HTTP call", async () => {
    const result = await claimAndFlush(db, ENV);
    expect(result.flushedCount).toBe(0);
    expect(result.indexnowResponse).toBe("ok");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("claimAndFlush — single entity", () => {
  it("submits one URL and marks the row flushed", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "acme",
      action: "create",
    });
    const result = await claimAndFlush(db, ENV);
    expect(result.flushedCount).toBe(1);
    expect(result.byEntityType).toEqual({ vendor: 1 });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].urls).toEqual(["https://meetmeatthefair.com/vendors/acme"]);

    const rows = db.select().from(pendingSearchPings).all();
    expect(rows[0].flushedAt).not.toBeNull();
    expect(rows[0].flushedBatchId).toBe(result.batchId);
  });
});

describe("claimAndFlush — multi-entity batching + dedup", () => {
  it("dedupes by (entityType, entitySlug) and submits one batched URL list", async () => {
    // Same vendor enqueued three times (e.g. one create + two updates within a batch)
    for (let i = 0; i < 3; i++) {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: "v-1",
        entitySlug: "dup-vendor",
        action: "update",
      });
    }
    // Plus one different entity
    await enqueuePendingPing(db, {
      entityType: "event",
      entityId: "e-1",
      entitySlug: "summer-fest",
      action: "create",
    });

    const result = await claimAndFlush(db, ENV);
    expect(result.flushedCount).toBe(4);
    expect(result.byEntityType).toEqual({ vendor: 3, event: 1 });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].urls.sort()).toEqual([
      "https://meetmeatthefair.com/events/summer-fest",
      "https://meetmeatthefair.com/vendors/dup-vendor",
    ]);
  });
});

describe("claimAndFlush — entity_type filter", () => {
  it("only drains the requested type; others remain pending", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "v1",
      action: "create",
    });
    await enqueuePendingPing(db, {
      entityType: "event",
      entityId: "e-1",
      entitySlug: "e1",
      action: "create",
    });

    const result = await claimAndFlush(db, ENV, { entityType: "vendor" });
    expect(result.flushedCount).toBe(1);
    expect(result.byEntityType).toEqual({ vendor: 1 });

    const unflushedEvents = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityType, "event"))
      .all();
    expect(unflushedEvents[0].flushedAt).toBeNull();
  });
});

describe("claimAndFlush — max_age_seconds filter", () => {
  it("skips rows newer than the cutoff", async () => {
    // Insert a recent row directly (queuedAt = now)
    db.insert(pendingSearchPings)
      .values({
        id: "recent",
        entityType: "vendor",
        entityId: "v-fresh",
        entitySlug: "fresh",
        action: "create",
        queuedAt: new Date(),
      })
      .run();
    // Insert an old row (2 hours ago)
    db.insert(pendingSearchPings)
      .values({
        id: "old",
        entityType: "vendor",
        entityId: "v-old",
        entitySlug: "stale",
        action: "create",
        queuedAt: new Date(Date.now() - 7200 * 1000),
      })
      .run();

    const result = await claimAndFlush(db, ENV, { maxAgeSeconds: 3600 });
    expect(result.flushedCount).toBe(1);
    expect(mock.calls[0].urls).toEqual(["https://meetmeatthefair.com/vendors/stale"]);

    // The recent row stays pending
    const recent = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.id, "recent"))
      .all();
    expect(recent[0].flushedAt).toBeNull();
  });
});

describe("claimAndFlush — dry_run", () => {
  it("returns counts without mutating state or calling IndexNow", async () => {
    await enqueuePendingPing(db, {
      entityType: "vendor",
      entityId: "v-1",
      entitySlug: "acme",
      action: "create",
    });
    const result = await claimAndFlush(db, ENV, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.flushedCount).toBe(1);
    expect(result.indexnowResponse).toBe("dry_run");
    expect(mock.calls).toHaveLength(0);

    const rows = db.select().from(pendingSearchPings).all();
    expect(rows[0].flushedAt).toBeNull();
    expect(rows[0].flushedBatchId).toBeNull();
  });
});

describe("claimAndFlush — error rollback", () => {
  it("un-claims the batch when IndexNow submission fails", async () => {
    // Override fetch to return a 500 for the internal endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("upstream error", { status: 500 })) as typeof fetch;

    try {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: "v-1",
        entitySlug: "fail-test",
        action: "create",
      });
      const result = await claimAndFlush(db, ENV);
      expect(result.indexnowResponse).not.toBe("ok");

      // Row should still be unflushed AND flushed_batch_id un-set so the next
      // attempt picks it up.
      const rows = db.select().from(pendingSearchPings).all();
      expect(rows[0].flushedAt).toBeNull();
      expect(rows[0].flushedBatchId).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // REL4 §3 (2026-06-13) — the silent-data-loss regression: pre-fix, the
  // internal endpoint returned HTTP 200 even when Bing 429'd, so the flush
  // marked every row flushed and the URLs were dropped forever. Post-fix the
  // endpoint returns 502 with the real Bing status; the flush must leave the
  // rows pending and surface the true status, not "ok".
  it("leaves rows pending and reports the real status when Bing 429s (502 from endpoint)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, indexnow_http_status: 429, error: "HTTP 429" }),
        {
          status: 502,
        }
      )) as typeof fetch;

    try {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: "v-throttled",
        entitySlug: "throttled-vendor",
        action: "update",
      });
      const result = await claimAndFlush(db, ENV);

      // The flush must NOT report success on a throttled batch.
      expect(result.indexnowResponse).not.toBe("ok");

      // The URL must survive for the next flush/cron — not silently consumed.
      const rows = db.select().from(pendingSearchPings).all();
      expect(rows[0].flushedAt).toBeNull();
      expect(rows[0].flushedBatchId).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // OPE-73 — a breaker DEFERRAL (operator pause / cooldown) makes the endpoint
  // return HTTP 503 with deferred:true. That is NOT a failure: the flush must
  // leave the rows pending AND take the no-error-log branch (reporting the
  // distinct "deferred" response), so a paused kill-switch stops producing the
  // hourly 502 error noise that hid a 2-week IndexNow outage.
  it("treats a 503 breaker deferral as a clean no-op: rows pending, response 'deferred'", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false, deferred: true, error: "breaker_paused" }), {
        status: 503,
      })) as typeof fetch;

    try {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: "v-paused",
        entitySlug: "paused-vendor",
        action: "update",
      });
      const result = await claimAndFlush(db, ENV);

      // Distinct from a genuine failure: the flush reports "deferred" (the
      // no-error-log branch), not the raw error string.
      expect(result.indexnowResponse).toBe("deferred");

      // Rows survive for the next cron once the operator un-pauses.
      const rows = db.select().from(pendingSearchPings).all();
      expect(rows[0].flushedAt).toBeNull();
      expect(rows[0].flushedBatchId).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("claimAndFlush — concurrent disjoint claims", () => {
  it("two concurrent flushes claim non-overlapping rows", async () => {
    for (let i = 0; i < 4; i++) {
      await enqueuePendingPing(db, {
        entityType: "vendor",
        entityId: `v-${i}`,
        entitySlug: `s-${i}`,
        action: "create",
      });
    }

    // Pre-claim half manually to simulate a concurrent first flush in flight
    db.update(pendingSearchPings)
      .set({ flushedBatchId: "concurrent-batch-A" })
      .where(sql`${pendingSearchPings.entityId} IN ('v-0','v-1')`)
      .run();

    // A second flush should only claim v-2 and v-3
    const result = await claimAndFlush(db, ENV);
    expect(result.flushedCount).toBe(2);
    expect(result.batchId).not.toBe("concurrent-batch-A");
    const claimed = mock.calls[0].urls.sort();
    expect(claimed).toEqual([
      "https://meetmeatthefair.com/vendors/s-2",
      "https://meetmeatthefair.com/vendors/s-3",
    ]);

    // The pre-claimed batch is untouched
    const stillClaimed = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.flushedBatchId, "concurrent-batch-A"))
      .all();
    expect(stillClaimed).toHaveLength(2);
  });
});
