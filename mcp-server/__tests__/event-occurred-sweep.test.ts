/**
 * Tests for runOccurredTransitionSweep (K27). Covers Pass 1 (transition + roll),
 * Pass 2 (backfill historical OCCURRED), eligibility exclusions, same-run
 * Pass-1↔Pass-2 idempotency, and cross-run idempotency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { runOccurredTransitionSweep } from "../src/event-occurred-sweep.js";
import * as logger from "../src/logger.js";
import { events, adminActions, promoters, eventVendors, vendors, users } from "../src/schema.js";
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

describe("runOccurredTransitionSweep — Pass 3 already-held rosters (OPE-525)", () => {
  // Prod shape this fixes: 34 OCCURRED events carrying 1,440 CONFIRMED/APPROVED
  // vendor links had ALL been stamped NEEDS_RESEARCH by this sweep, because it
  // selected on `vendor_roster_status IS NULL` and trusted a downstream worker
  // (in another repo) to skip populated events. The worker did not, so the
  // weekly drain re-surfaced them indefinitely.
  function seedVendors(eventId: string, n: number, participation = "EXHIBITOR") {
    for (let i = 0; i < n; i++) {
      const vid = `ven-${eventId}-${i}`;
      db.insert(users)
        .values({ id: `u-${vid}`, email: `${vid}@test`, role: "VENDOR" })
        .run();
      db.insert(vendors)
        .values({
          id: vid,
          userId: `u-${vid}`,
          businessName: `Vendor ${i}`,
          slug: unsafeSlug(`vendor-${eventId}-${i}`),
        })
        .run();
      db.insert(eventVendors)
        .values({
          id: `ev-${vid}`,
          eventId,
          vendorId: vid,
          status: "CONFIRMED",
          participationType: participation,
        })
        .run();
    }
  }

  it("stamps HAS_ROSTER instead of queueing research when the roster is already held", async () => {
    seed({ id: "rostered", slug: "rostered-2026" });
    seedVendors("rostered", 12); // >= ROSTER_EVIDENCE_MIN

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("rostered")).toBe("HAS_ROSTER");
    expect(res.rosterAlreadyHeld).toBe(1);
    expect(res.rosterEnqueued).toBe(0);
  });

  it("stamps checked_at, so the determination does not read as unchecked", async () => {
    seed({ id: "rostered2", slug: "rostered2-2026" });
    seedVendors("rostered2", 12);

    await runOccurredTransitionSweep(db, { now: NOW });

    const row = db.select().from(events).where(eq(events.id, "rostered2")).all()[0];
    expect(row.vendorRosterCheckedAt).not.toBeNull();
    // We assert "links exist", not "this page is where they came from".
    expect(row.vendorRosterSourceUrl ?? null).toBeNull();
  });

  it("a thin set of links is still NEEDS_RESEARCH — two vendors is not a roster", async () => {
    // 13 of the 34 prod rows had <=3 links. Re-surfacing those is CORRECT; the
    // guard must not swallow them just to drive the audit query to zero.
    seed({ id: "thin", slug: "thin-2026" });
    seedVendors("thin", 2);

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("thin")).toBe("NEEDS_RESEARCH");
    expect(res.rosterAlreadyHeld).toBe(0);
    expect(res.rosterEnqueued).toBe(1);
  });

  it("SPONSOR_ONLY links never count as a roster, however many there are", async () => {
    // Three prod events had sponsors as their ONLY links. Counting them would
    // stamp HAS_ROSTER on an event we have genuinely never rostered — removing
    // it from research on false evidence, which is worse than the original bug.
    seed({ id: "sponsors", slug: "sponsors-2026" });
    seedVendors("sponsors", 15, "SPONSOR_ONLY");

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("sponsors")).toBe("NEEDS_RESEARCH");
    expect(res.rosterAlreadyHeld).toBe(0);
  });

  it("only CONFIRMED/APPROVED links count — pending applications are not a roster", async () => {
    seed({ id: "applied", slug: "applied-2026" });
    for (let i = 0; i < 15; i++) {
      const vid = `ven-applied-${i}`;
      db.insert(users)
        .values({ id: `u-${vid}`, email: `${vid}@test`, role: "VENDOR" })
        .run();
      db.insert(vendors)
        .values({
          id: vid,
          userId: `u-${vid}`,
          businessName: `V${i}`,
          slug: unsafeSlug(`v-applied-${i}`),
        })
        .run();
      db.insert(eventVendors)
        .values({ id: `ev-${vid}`, eventId: "applied", vendorId: vid, status: "APPLIED" })
        .run();
    }

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("applied")).toBe("NEEDS_RESEARCH");
    expect(res.rosterAlreadyHeld).toBe(0);
  });

  it("does not clobber an existing terminal status", async () => {
    // The IS NULL guard predates this change; pin it, because the new branch
    // writes HAS_ROSTER and must not become a way to overwrite NO_PUBLIC_LIST.
    seed({ id: "settled", slug: "settled-2026", vendorRosterStatus: "NO_PUBLIC_LIST" });
    seedVendors("settled", 20);

    const res = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("settled")).toBe("NO_PUBLIC_LIST");
    expect(res.rosterAlreadyHeld).toBe(0);
  });

  it("is idempotent across runs", async () => {
    seed({ id: "twice", slug: "twice-2026" });
    seedVendors("twice", 12);

    await runOccurredTransitionSweep(db, { now: NOW });
    const second = await runOccurredTransitionSweep(db, { now: NOW });

    expect(rosterStatusOf("twice")).toBe("HAS_ROSTER");
    expect(second.rosterAlreadyHeld).toBe(0); // already terminal, not re-selected
  });
});
