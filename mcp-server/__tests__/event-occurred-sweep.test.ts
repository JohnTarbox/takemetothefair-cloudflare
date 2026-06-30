/**
 * Tests for runOccurredTransitionSweep (K27). Covers Pass 1 (transition + roll),
 * Pass 2 (backfill historical OCCURRED), eligibility exclusions, same-run
 * Pass-1↔Pass-2 idempotency, and cross-run idempotency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { runOccurredTransitionSweep } from "../src/event-occurred-sweep.js";
import * as logger from "../src/logger.js";
import { events, adminActions, promoters } from "../src/schema.js";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";

let db: TestDb;
let mock: ReturnType<typeof mockIndexNowFetch>;

const NOW = new Date("2026-11-01T00:00:00.000Z");

beforeEach(() => {
  ({ db } = createTestDb());
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
});

afterEach(() => mock.restore());

function seed(overrides: Partial<typeof events.$inferInsert> & { id: string; slug: string }) {
  db.insert(events)
    .values({
      name: overrides.name ?? `Event ${overrides.id}`,
      promoterId: "promoter-1",
      stateCode: "ME",
      startDate: new Date(Date.UTC(2026, 9, 4, 12, 0, 0)),
      endDate: new Date(Date.UTC(2026, 9, 13, 12, 0, 0)),
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      ...overrides,
      slug: unsafeSlug(overrides.slug),
    })
    .run();
  return overrides.id;
}

function lifecycleOf(id: string): string {
  return db.select({ l: events.lifecycleStatus }).from(events).where(eq(events.id, id)).all()[0].l;
}

function rosterStatusOf(id: string): string | null {
  return db.select({ s: events.vendorRosterStatus }).from(events).where(eq(events.id, id)).all()[0]
    .s;
}

describe("runOccurredTransitionSweep — Pass 1 transition + roll", () => {
  it("transitions past-end APPROVED events to OCCURRED and rolls recurring ones", async () => {
    seed({
      id: "recurring",
      slug: "fryeburg-fair-2026",
      name: "Fryeburg Fair 2026",
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
    });
    seed({ id: "nonrec", slug: "one-off-2026", name: "One Off 2026" });

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(res.transitioned).toBe(2);
    expect(res.rolledFromTransition).toBe(1);
    expect(lifecycleOf("recurring")).toBe("OCCURRED");
    expect(lifecycleOf("nonrec")).toBe("OCCURRED");

    // recurring produced one 2027 edition; non-recurring produced none
    const rolled = db.select().from(events).where(eq(events.rolledFromEventId, "recurring")).all();
    expect(rolled).toHaveLength(1);
    expect(rolled[0].slug).toBe("fryeburg-fair-2027");
    expect(
      db.select().from(events).where(eq(events.rolledFromEventId, "nonrec")).all()
    ).toHaveLength(0);

    // a lifecycle_change audit row tagged via=occurred-sweep was written
    const audit = db
      .select()
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, "event.lifecycle_change"),
          eq(adminActions.targetId, "recurring")
        )
      )
      .all()[0];
    expect(JSON.parse(audit.payloadJson!).via).toBe("occurred-sweep");
    expect(audit.actorUserId).toBeNull();
  });

  it("does not transition ineligible events", async () => {
    seed({ id: "future", slug: "future-2027", endDate: new Date(Date.UTC(2027, 0, 1, 12, 0, 0)) });
    seed({ id: "cancelled", slug: "cancelled-2026", lifecycleStatus: "CANCELLED" });
    seed({ id: "pending", slug: "pending-2026", status: "PENDING" });
    seed({ id: "noend", slug: "noend-2026", endDate: null });
    seed({ id: "already", slug: "already-2026", lifecycleStatus: "OCCURRED" });

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(res.transitioned).toBe(0);
    expect(lifecycleOf("future")).toBe("SCHEDULED");
    expect(lifecycleOf("cancelled")).toBe("CANCELLED");
    expect(lifecycleOf("pending")).toBe("SCHEDULED");
    expect(lifecycleOf("noend")).toBe("SCHEDULED");
  });
});

describe("runOccurredTransitionSweep — Pass 2 backfill", () => {
  it("rolls already-OCCURRED recurring events that lack an edition", async () => {
    // historical OCCURRED (changedAt null, like a migration backfill)
    seed({
      id: "hist",
      slug: "winter-show-2026",
      name: "Winter Show 2026",
      lifecycleStatus: "OCCURRED",
      lifecycleStatusChangedAt: null,
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
    });

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(res.transitioned).toBe(0);
    expect(res.rolledFromBackfill).toBe(1);
    expect(db.select().from(events).where(eq(events.rolledFromEventId, "hist")).all()).toHaveLength(
      1
    );
  });

  it("does not double-roll an event transitioned in the same run", async () => {
    seed({
      id: "recurring",
      slug: "fryeburg-fair-2026",
      name: "Fryeburg Fair 2026",
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
    });

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    // rolled exactly once (by Pass 1), not again by Pass 2
    expect(res.rolledFromTransition).toBe(1);
    expect(res.rolledFromBackfill).toBe(0);
    expect(
      db.select().from(events).where(eq(events.rolledFromEventId, "recurring")).all()
    ).toHaveLength(1);
  });
});

describe("runOccurredTransitionSweep — observability", () => {
  // error_logs isn't a table in the test harness (logError no-ops its D1 write),
  // so we assert on the result struct + spy the logger to verify the heartbeat.
  it("emits an info heartbeat carrying the run counts", async () => {
    const spy = vi.spyOn(logger, "logError").mockResolvedValue(undefined);
    seed({
      id: "recurring",
      slug: "fryeburg-fair-2026",
      name: "Fryeburg Fair 2026",
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
    });

    await runOccurredTransitionSweep(db, { now: NOW });

    const beat = spy.mock.calls.find(
      ([, o]) => o?.level === "info" && o?.message === "occurred-sweep run completed"
    );
    expect(beat).toBeTruthy();
    expect(beat![1].context).toMatchObject({ transitioned: 1, rolledFromTransition: 1 });
    spy.mockRestore();
  });

  it("flags + warns when a pass hits the row cap", async () => {
    const spy = vi.spyOn(logger, "logError").mockResolvedValue(undefined);
    // Seed exactly the transition cap (200) of eligible rows; a 201st would be
    // deferred. Coupled to TRANSITION_LIMIT in event-occurred-sweep.ts.
    for (let i = 0; i < 200; i++) {
      seed({ id: `bulk-${i}`, slug: `bulk-${i}-2026`, name: `Bulk ${i} 2026` });
    }

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(res.transitioned).toBe(200);
    expect(res.transitionLimitHit).toBe(true);
    const warned = spy.mock.calls.some(
      ([, o]) => o?.level === "warn" && /transition cap/.test(o?.message ?? "")
    );
    expect(warned).toBe(true);
    spy.mockRestore();
  });
});

describe("runOccurredTransitionSweep — Pass 3 producer NO_PUBLIC_LIST (OPE-31)", () => {
  it("routes events under a never-publishes producer straight to NO_PUBLIC_LIST", async () => {
    db.insert(promoters)
      .values({
        id: "promoter-noplist",
        companyName: "No Roster Producer",
        slug: unsafeSlug("no-roster-producer"),
        vendorRosterPublishesLists: false,
      })
      .run();
    // One event under the flagged producer, one under the normal one (control).
    seed({ id: "flagged", slug: "flagged-2026", promoterId: "promoter-noplist" });
    seed({ id: "normal", slug: "normal-2026" }); // promoter-1 — no flag

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    // Both transition APPROVED → OCCURRED in Pass 1; Pass 3 then diverges by flag.
    expect(rosterStatusOf("flagged")).toBe("NO_PUBLIC_LIST");
    expect(rosterStatusOf("normal")).toBe("NEEDS_RESEARCH");
    expect(res.rosterNoPublicList).toBe(1);
    expect(res.rosterEnqueued).toBe(1);
  });

  it("a NULL flag (unknown) keeps today's NEEDS_RESEARCH behavior", async () => {
    db.insert(promoters)
      .values({
        id: "promoter-unknown",
        companyName: "Unknown Producer",
        slug: unsafeSlug("unknown-producer"),
        // vendorRosterPublishesLists left NULL
      })
      .run();
    seed({ id: "unk", slug: "unk-2026", promoterId: "promoter-unknown" });

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("unk")).toBe("NEEDS_RESEARCH");
    expect(res.rosterNoPublicList).toBe(0);
  });
});

describe("runOccurredTransitionSweep — cross-run idempotency", () => {
  it("a second run produces no second edition", async () => {
    seed({
      id: "recurring",
      slug: "fryeburg-fair-2026",
      name: "Fryeburg Fair 2026",
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
    });

    await runOccurredTransitionSweep(db, { now: NOW });
    const second = await runOccurredTransitionSweep(db, {
      now: new Date("2026-11-02T00:00:00.000Z"),
    });

    expect(second.transitioned).toBe(0); // already OCCURRED
    expect(second.rolledFromBackfill).toBe(0); // edition already exists → idempotent skip
    expect(
      db.select().from(events).where(eq(events.rolledFromEventId, "recurring")).all()
    ).toHaveLength(1);
  });
});
