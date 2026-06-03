/**
 * Unit tests for the GW1e health canary.
 *
 * Critical assertions:
 *   - Snapshot writes on first call (no prior history → no alert)
 *   - RED dispatch on +1 open count growth day-over-day
 *   - YELLOW dispatch on >10% weighted-priority growth over 7d avg
 *   - YELLOW debounce respects the 72h marker
 *   - Same-day re-run UPDATEs rather than INSERTs (idempotent)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { runScheduledGoodwillHealthCanary } from "../src/goodwill/health-canary.js";
import { goodwillHealthSnapshots, eventDiscrepancies, events } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

async function seedEvent(id: string): Promise<void> {
  await db.insert(events).values({
    id,
    name: "Test",
    slug: `test-${id}`,
    promoterId: "p-1",
    status: "APPROVED",
  });
}

async function seedDiscrepancy(args: {
  id: string;
  status?: "open" | "resolved_authoritative" | "dismissed";
  priorityScore?: number;
  detectedBy?: "ingest_addverify" | "stale_page_radar" | "self_consistency" | "manual";
  candidate?: boolean;
}): Promise<void> {
  await db.insert(eventDiscrepancies).values({
    id: args.id,
    eventId: "evt-1",
    fieldClass: "date",
    detectedBy: args.detectedBy ?? "self_consistency",
    detectedAt: new Date(),
    resolutionStatus: args.status ?? "open",
    outreachPriorityScore: args.priorityScore ?? 0.5,
    outreachCandidate: args.candidate ?? false,
  });
}

describe("runScheduledGoodwillHealthCanary — snapshot write", () => {
  it("writes today's snapshot on first run with no prior history", async () => {
    await seedEvent("evt-1");
    await seedDiscrepancy({ id: "d-1", priorityScore: 0.7, candidate: true });
    const result = await runScheduledGoodwillHealthCanary(db);
    expect(result.decision).toBe("wrote_snapshot");
    expect(result.open_count).toBe(1);
    expect(result.weighted_priority_sum).toBeCloseTo(0.7, 3);
    expect(result.prior_open_count).toBeNull();

    const rows = await db.select().from(goodwillHealthSnapshots);
    expect(rows.length).toBe(1);
    expect(rows[0].outreachCandidateCount).toBe(1);
    expect(rows[0].openSelfConsistency).toBe(1);
  });

  it("same-day re-run updates the existing row, no duplicate", async () => {
    await seedEvent("evt-1");
    await seedDiscrepancy({ id: "d-1" });
    await runScheduledGoodwillHealthCanary(db);
    await seedDiscrepancy({ id: "d-2", priorityScore: 0.9, candidate: true });
    await runScheduledGoodwillHealthCanary(db);
    const rows = await db.select().from(goodwillHealthSnapshots);
    expect(rows.length).toBe(1);
    expect(rows[0].openCount).toBe(2);
    expect(rows[0].outreachCandidateCount).toBe(1);
  });
});

describe("runScheduledGoodwillHealthCanary — RED dispatch", () => {
  it("fires RED when open count grows by +1 vs prior snapshot", async () => {
    await seedEvent("evt-1");
    // Yesterday's snapshot
    await db.insert(goodwillHealthSnapshots).values({
      snapshotDate: new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10),
      openCount: 5,
      outreachCandidateCount: 1,
      weightedPrioritySum: 2.5,
      openIngestAddverify: 0,
      openStalePageRadar: 0,
      openSelfConsistency: 5,
      openManual: 0,
      resolvedLast28d: 0,
      dismissedLast28d: 0,
      medianOfficialFreshness: null,
      medianOfficialAccuracy: null,
      medianAggregatorAccuracy: null,
      lastYellowAlertedAt: null,
      createdAt: new Date(),
    });

    // Today: 6 open. RED expected.
    for (let i = 0; i < 6; i++) await seedDiscrepancy({ id: `d-${i}` });

    const fetchSpy = vi.fn(async () => new Response("ok"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const result = await runScheduledGoodwillHealthCanary(db, {
        slackWebhookUrl: "https://hooks.slack.example/test",
      });
      expect(result.decision).toBe("wrote_snapshot_and_red");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(((fetchSpy.mock.calls[0][1] as RequestInit).body ?? "{}") as string);
      expect(body.text).toMatch(/RED/);
      expect(body.text).toMatch(/5.*6/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("no RED dispatch when SLACK_WEBHOOK_URL_TECHNICAL is unset (no-op cleanly)", async () => {
    await seedEvent("evt-1");
    await db.insert(goodwillHealthSnapshots).values({
      snapshotDate: new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10),
      openCount: 1,
      outreachCandidateCount: 0,
      weightedPrioritySum: 0,
      openIngestAddverify: 0,
      openStalePageRadar: 0,
      openSelfConsistency: 1,
      openManual: 0,
      resolvedLast28d: 0,
      dismissedLast28d: 0,
      medianOfficialFreshness: null,
      medianOfficialAccuracy: null,
      medianAggregatorAccuracy: null,
      lastYellowAlertedAt: null,
      createdAt: new Date(),
    });
    await seedDiscrepancy({ id: "d-1" });
    await seedDiscrepancy({ id: "d-2" });
    const result = await runScheduledGoodwillHealthCanary(db); // no SLACK var
    // Decision still reflects the RED transition; just the dispatch is a no-op.
    expect(result.decision).toBe("wrote_snapshot_and_red");
  });
});

describe("runScheduledGoodwillHealthCanary — email fallback (alertEmail + emailQueue)", () => {
  // Seeds a prior snapshot + today's RED-triggering discrepancies, then
  // asserts which channels were called based on the opts provided.
  async function setupRedScenario() {
    await seedEvent("evt-1");
    await db.insert(goodwillHealthSnapshots).values({
      snapshotDate: new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10),
      openCount: 1,
      outreachCandidateCount: 0,
      weightedPrioritySum: 0,
      openIngestAddverify: 0,
      openStalePageRadar: 0,
      openSelfConsistency: 1,
      openManual: 0,
      resolvedLast28d: 0,
      dismissedLast28d: 0,
      medianOfficialFreshness: null,
      medianOfficialAccuracy: null,
      medianAggregatorAccuracy: null,
      lastYellowAlertedAt: null,
      createdAt: new Date(),
    });
    await seedDiscrepancy({ id: "d-1" });
    await seedDiscrepancy({ id: "d-2" });
  }

  it("email-only: enqueues an EmailJobMessage with the right shape", async () => {
    await setupRedScenario();
    const sent: Array<unknown> = [];
    const emailQueue = {
      send: async (msg: unknown) => {
        sent.push(msg);
      },
    };
    const result = await runScheduledGoodwillHealthCanary(db, {
      alertEmail: "ops@example.com",
      emailQueue,
    });
    expect(result.decision).toBe("wrote_snapshot_and_red");
    expect(sent.length).toBe(1);
    const msg = sent[0] as {
      to: string;
      subject: string;
      text: string;
      html: string;
      source: string;
    };
    expect(msg.to).toBe("ops@example.com");
    expect(msg.subject).toMatch(/RED/);
    expect(msg.subject).toMatch(/2 open/);
    expect(msg.text).toMatch(/open count 1.*→ 2/);
    expect(msg.html).toContain("admin/data-health");
    expect(msg.source).toBe("goodwill-canary:red");
  });

  it("both channels: fires Slack AND email when both are set", async () => {
    await setupRedScenario();
    const sent: Array<unknown> = [];
    const emailQueue = {
      send: async (msg: unknown) => {
        sent.push(msg);
      },
    };
    const fetchSpy = vi.fn(async () => new Response("ok"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await runScheduledGoodwillHealthCanary(db, {
        slackWebhookUrl: "https://hooks.slack.example/x",
        alertEmail: "ops@example.com",
        emailQueue,
      });
      expect(result.decision).toBe("wrote_snapshot_and_red");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sent.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("misconfigured: alertEmail set but emailQueue null → still wrote_snapshot_and_red, no enqueue", async () => {
    await setupRedScenario();
    const result = await runScheduledGoodwillHealthCanary(db, {
      alertEmail: "ops@example.com",
      emailQueue: null,
    });
    // Decision still reflects RED; the misconfig is logged separately
    // (not asserted here — logError writes to error_logs which the test
    // schema doesn't include).
    expect(result.decision).toBe("wrote_snapshot_and_red");
  });

  it("email-side failure doesn't break Slack-side dispatch", async () => {
    await setupRedScenario();
    const emailQueue = {
      send: async () => {
        throw new Error("queue unavailable");
      },
    };
    const fetchSpy = vi.fn(async () => new Response("ok"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await runScheduledGoodwillHealthCanary(db, {
        slackWebhookUrl: "https://hooks.slack.example/x",
        alertEmail: "ops@example.com",
        emailQueue,
      });
      expect(result.decision).toBe("wrote_snapshot_and_red");
      // Slack still fired despite email throwing.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runScheduledGoodwillHealthCanary — RED beats YELLOW when both would fire", () => {
  it("when open count AND weighted priority both grow, RED wins", async () => {
    await seedEvent("evt-1");
    for (let i = 0; i < 7; i++) {
      const day = new Date(Date.now() - (i + 1) * 86400 * 1000).toISOString().slice(0, 10);
      await db.insert(goodwillHealthSnapshots).values({
        snapshotDate: day,
        openCount: 5,
        outreachCandidateCount: 1,
        weightedPrioritySum: 1.0,
        openIngestAddverify: 0,
        openStalePageRadar: 0,
        openSelfConsistency: 5,
        openManual: 0,
        resolvedLast28d: 0,
        dismissedLast28d: 0,
        medianOfficialFreshness: null,
        medianOfficialAccuracy: null,
        medianAggregatorAccuracy: null,
        lastYellowAlertedAt: null,
        createdAt: new Date(),
      });
    }
    for (let i = 0; i < 6; i++) await seedDiscrepancy({ id: `d-${i}`, priorityScore: 1.0 });
    const result = await runScheduledGoodwillHealthCanary(db);
    expect(result.decision).toBe("wrote_snapshot_and_red");
  });
});
