/**
 * Tests for rolloverEventIfRecurring (K27). Exercises the core directly (it's a
 * plain function, not an MCP tool): eligibility gates, the inherited field set,
 * year-bucketed idempotency, slug derivation, the audit row, and the
 * no-children / no-IndexNow guarantees.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";
import { events, eventDays, eventVendors, adminActions, promoters } from "../src/schema.js";
import { eq } from "drizzle-orm";
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

/** Seed an OCCURRED annual event (2026 edition) with the inheritable fields set. */
function seedAnnual(overrides: Partial<typeof events.$inferInsert> = {}): string {
  const id = (overrides.id as string) ?? "evt-2026";
  db.insert(events)
    .values({
      id,
      name: "Fryeburg Fair 2026",
      slug: unsafeSlug("fryeburg-fair-2026"),
      promoterId: "promoter-1",
      description: "A big agricultural fair.",
      venueId: "venue-1",
      stateCode: "ME",
      startDate: new Date(Date.UTC(2026, 9, 4, 12, 0, 0)),
      endDate: new Date(Date.UTC(2026, 9, 13, 12, 0, 0)),
      datesConfirmed: true,
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
      categories: JSON.stringify(["agriculture"]),
      tags: JSON.stringify(["fair"]),
      imageUrl: "https://cdn.example.com/fryeburg.jpg",
      imageFocalX: 0.4,
      imageFocalY: 0.6,
      ticketPriceMinCents: 1500,
      ticketPriceMaxCents: 2500,
      status: "APPROVED",
      lifecycleStatus: "OCCURRED",
      featured: true,
      estimatedAttendance: 50000,
      ...overrides,
    })
    .run();
  return id;
}

describe("rolloverEventIfRecurring — happy path", () => {
  it("creates a TENTATIVE next-year edition inheriting key fields", async () => {
    const sourceId = seedAnnual();
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });

    expect(res.created).toBe(true);
    expect(res.newSlug).toBe("fryeburg-fair-2027");

    const [rolled] = db.select().from(events).where(eq(events.id, res.newEventId!)).all();
    expect(rolled.name).toBe("Fryeburg Fair 2027");
    expect(rolled.status).toBe("TENTATIVE");
    expect(rolled.lifecycleStatus).toBe("TENTATIVE");
    expect(rolled.datesConfirmed).toBe(false);
    expect(rolled.startDate?.toISOString()).toBe("2027-10-04T12:00:00.000Z");
    expect(rolled.endDate?.toISOString()).toBe("2027-10-13T12:00:00.000Z");
    expect(rolled.rolledFromEventId).toBe(sourceId);
    expect(rolled.flaggedForReview).toBe(1);
    expect(rolled.ingestionMethod).toBe("auto_rollover");
    // Inherited fields
    expect(rolled.description).toBe("A big agricultural fair.");
    expect(rolled.venueId).toBe("venue-1");
    expect(rolled.imageUrl).toBe("https://cdn.example.com/fryeburg.jpg");
    expect(rolled.imageFocalX).toBe(0.4);
    expect(rolled.ticketPriceMinCents).toBe(1500);
    expect(rolled.recurrenceRule).toBe("FREQ=YEARLY;INTERVAL=1");
    // featured is NOT inherited onto a skeleton
    expect(rolled.featured).toBe(false);
    // dates-pending-official tag added, original tags preserved
    expect(JSON.parse(rolled.tags!)).toEqual(["fair", "dates-pending-official"]);
    // completeness recomputed (has desc+dates+venue+categories+image+price)
    expect(rolled.completenessScore).toBeGreaterThan(0);
  });

  it("writes an event.auto_rollover admin_actions row", async () => {
    const sourceId = seedAnnual();
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "manual",
      actorUserId: "u-admin",
      now: NOW,
    });
    const [audit] = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "event.auto_rollover"))
      .all();
    expect(audit.targetId).toBe(res.newEventId);
    expect(audit.actorUserId).toBe("u-admin");
    const payload = JSON.parse(audit.payloadJson!);
    expect(payload.sourceEventId).toBe(sourceId);
    expect(payload.newSlug).toBe("fryeburg-fair-2027");
    expect(payload.via).toBe("manual");
  });

  it("copies no children and fires no IndexNow", async () => {
    const sourceId = seedAnnual();
    // give the source a child vendor + day to prove they are NOT copied
    db.insert(eventVendors).values({ id: "ev-1", eventId: sourceId, vendorId: "vend-1" }).run();
    db.insert(eventDays).values({ id: "ed-source", eventId: sourceId, date: "2026-10-04" }).run();

    // event_days on the source now gates the roll — use a fresh source without days
    const cleanId = seedAnnual({
      id: "evt-clean",
      slug: unsafeSlug("clean-fair-2026"),
      name: "Clean Fair 2026",
    });
    const res = await rolloverEventIfRecurring(db, cleanId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });

    const childVendors = db
      .select()
      .from(eventVendors)
      .where(eq(eventVendors.eventId, res.newEventId!))
      .all();
    const childDays = db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, res.newEventId!))
      .all();
    expect(childVendors).toHaveLength(0);
    expect(childDays).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("rolls biennial (INTERVAL=2) two years forward", async () => {
    const sourceId = seedAnnual({
      id: "evt-bi",
      name: "Colorful Connections Quilt Show 2025",
      slug: unsafeSlug("colorful-connections-quilt-show-2025"),
      recurrenceRule: "FREQ=YEARLY;INTERVAL=2",
      startDate: new Date(Date.UTC(2025, 8, 12, 12, 0, 0)),
      endDate: new Date(Date.UTC(2025, 8, 14, 12, 0, 0)),
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.newSlug).toBe("colorful-connections-quilt-show-2027");
    const [rolled] = db.select().from(events).where(eq(events.id, res.newEventId!)).all();
    expect(rolled.startDate?.toISOString()).toBe("2027-09-12T12:00:00.000Z");
  });

  it("appends the year to the slug when the name carries no year token", async () => {
    const sourceId = seedAnnual({
      id: "evt-noyear",
      name: "Fryeburg Fair",
      slug: unsafeSlug("fryeburg-fair"),
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.newSlug).toBe("fryeburg-fair-2027");
    const [rolled] = db.select().from(events).where(eq(events.id, res.newEventId!)).all();
    expect(rolled.name).toBe("Fryeburg Fair");
  });
});

describe("rolloverEventIfRecurring — idempotency + gates", () => {
  it("is idempotent: re-running produces no second edition", async () => {
    const sourceId = seedAnnual();
    const first = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(first.created).toBe(true);
    const second = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(second.created).toBe(false);
    expect(second.skipReason).toBe("edition-exists");
    const all2027 = db.select().from(events).where(eq(events.rolledFromEventId, sourceId)).all();
    expect(all2027).toHaveLength(1);
  });

  it("skips when there is no recurrence rule", async () => {
    const sourceId = seedAnnual({
      id: "evt-norule",
      slug: unsafeSlug("no-rule-2026"),
      recurrenceRule: null,
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res).toEqual({ created: false, skipReason: "no-recurrence-rule" });
  });

  it("skips non-YEARLY cadences", async () => {
    const sourceId = seedAnnual({
      id: "evt-weekly",
      slug: unsafeSlug("weekly-2026"),
      recurrenceRule: "FREQ=WEEKLY",
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.skipReason).toBe("unsupported-cadence");
  });

  it("skips event_days-backed series", async () => {
    const sourceId = seedAnnual({ id: "evt-days", slug: unsafeSlug("days-2026") });
    db.insert(eventDays).values({ id: "ed-1", eventId: sourceId, date: "2026-10-04" }).run();
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.skipReason).toBe("event-days-backed");
  });

  it("skips discontinuous-dates events", async () => {
    const sourceId = seedAnnual({
      id: "evt-disc",
      slug: unsafeSlug("disc-2026"),
      discontinuousDates: true,
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.skipReason).toBe("discontinuous-dates");
  });

  it("skips when dates are missing", async () => {
    const sourceId = seedAnnual({
      id: "evt-nodate",
      slug: unsafeSlug("nodate-2026"),
      startDate: null,
      endDate: null,
    });
    const res = await rolloverEventIfRecurring(db, sourceId, {
      via: "cron",
      actorUserId: null,
      now: NOW,
    });
    expect(res.skipReason).toBe("missing-dates");
  });
});
