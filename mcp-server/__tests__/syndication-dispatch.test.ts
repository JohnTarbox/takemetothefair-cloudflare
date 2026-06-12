/**
 * SYN1 PR2 — dispatcher coverage. Exercises the core delivery path
 * (processSyndicationEntity) against the in-memory D1 with a mocked fetch:
 * venue→N-event fan-out, per-(subscriber,event) POST count, HMAC signature,
 * processed_at bookkeeping, and retry-on-failure (row stays unprocessed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { processSyndicationEntity, hmacSha256Hex } from "../src/syndication/dispatch.js";
import {
  events,
  venues,
  promoters,
  eventDays,
  syndicationOutbox,
  syndicationSubscribers,
  syndicationSubscriptions,
} from "../src/schema.js";
import { eq } from "drizzle-orm";

let db: TestDb;
let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

const VENUE_ID = "venue-1";
const E1 = "event-1";
const E2 = "event-2";
const SUB_ID = "sub-1";
const SECRET = "super-secret-signing-key";

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(venues)
    .values({
      id: VENUE_ID,
      name: "Common",
      slug: "common",
      address: "1 Main St",
      city: "Gray",
      state: "ME",
      zip: "04039",
      status: "ACTIVE",
    })
    .run();
  for (const id of [E1, E2]) {
    db.insert(events)
      .values({
        id,
        name: `Event ${id}`,
        slug: id,
        promoterId: "p1",
        venueId: VENUE_ID,
        status: "APPROVED",
        syndicationVersion: 2,
      })
      .run();
  }
  db.insert(syndicationSubscribers)
    .values({
      id: SUB_ID,
      name: "mcw",
      callbackUrl: "https://consumer.example/webhook",
      signingSecret: SECRET,
      active: true,
      createdAt: new Date(),
    })
    .run();

  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function seedVenueOutbox() {
  db.insert(syndicationOutbox)
    .values({
      id: "ob-1",
      entityType: "venue",
      entityId: VENUE_ID,
      changeVersion: 1,
      changedFields: JSON.stringify(["city"]),
      snapshot: JSON.stringify({ name: "Common", city: "Gray" }),
      createdAt: new Date(),
    })
    .run();
}

describe("processSyndicationEntity — venue fan-out", () => {
  it("POSTs once per (subscriber, event) and marks the outbox row processed", async () => {
    // Subscriber tracks only E1 → exactly one delivery even though the venue
    // hosts two events.
    db.insert(syndicationSubscriptions)
      .values({ id: "ss-1", subscriberId: SUB_ID, eventId: E1, createdAt: new Date() })
      .run();
    seedVenueOutbox();

    await processSyndicationEntity(db, { entityType: "venue", entityId: VENUE_ID });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://consumer.example/webhook");
    const body = init.body as string;
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ eventId: E1, eventVersion: 2, name: "Event event-1" });

    // Signature header matches an independent HMAC of the exact body.
    const expectedSig = `sha256=${await hmacSha256Hex(SECRET, body)}`;
    expect(init.headers["X-Syndication-Signature"]).toBe(expectedSig);

    const row = db.select().from(syndicationOutbox).where(eq(syndicationOutbox.id, "ob-1")).get();
    expect(row?.processedAt).not.toBeNull();
  });

  it("fans out to both events when the subscriber tracks both", async () => {
    db.insert(syndicationSubscriptions)
      .values([
        { id: "ss-1", subscriberId: SUB_ID, eventId: E1, createdAt: new Date() },
        { id: "ss-2", subscriberId: SUB_ID, eventId: E2, createdAt: new Date() },
      ])
      .run();
    seedVenueOutbox();

    await processSyndicationEntity(db, { entityType: "venue", entityId: VENUE_ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips inactive subscribers and events with no subscribers", async () => {
    db.update(syndicationSubscribers)
      .set({ active: false })
      .where(eq(syndicationSubscribers.id, SUB_ID))
      .run();
    db.insert(syndicationSubscriptions)
      .values({ id: "ss-1", subscriberId: SUB_ID, eventId: E1, createdAt: new Date() })
      .run();
    seedVenueOutbox();

    await processSyndicationEntity(db, { entityType: "venue", entityId: VENUE_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    // No subscriber received it, but the row is still considered processed.
    const row = db.select().from(syndicationOutbox).where(eq(syndicationOutbox.id, "ob-1")).get();
    expect(row?.processedAt).not.toBeNull();
  });

  it("throws and leaves the row unprocessed when a delivery fails (→ queue retry)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    db.insert(syndicationSubscriptions)
      .values({ id: "ss-1", subscriberId: SUB_ID, eventId: E1, createdAt: new Date() })
      .run();
    seedVenueOutbox();

    await expect(
      processSyndicationEntity(db, { entityType: "venue", entityId: VENUE_ID })
    ).rejects.toThrow(/delivery failed/);

    const row = db.select().from(syndicationOutbox).where(eq(syndicationOutbox.id, "ob-1")).get();
    expect(row?.processedAt).toBeNull();
  });
});

describe("processSyndicationEntity — event_day resolves to parent event", () => {
  it("delivers the parent event for an event_day outbox row", async () => {
    db.insert(syndicationSubscriptions)
      .values({ id: "ss-1", subscriberId: SUB_ID, eventId: E1, createdAt: new Date() })
      .run();
    // event_day outbox row keyed by a day id; dispatcher maps it to its parent.
    db.insert(syndicationOutbox)
      .values({
        id: "ob-day",
        entityType: "event_day",
        entityId: "day-1",
        changeVersion: 1,
        changedFields: JSON.stringify(["date"]),
        snapshot: JSON.stringify({ name: "Event event-1" }),
        createdAt: new Date(),
      })
      .run();
    // Need the day row so resolveAffectedEventIds can find its parent.
    db.insert(eventDays).values({ id: "day-1", eventId: E1, date: "2026-08-15" }).run();

    await processSyndicationEntity(db, { entityType: "event_day", entityId: "day-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).eventId).toBe(E1);
  });
});

describe("hmacSha256Hex", () => {
  it("is deterministic and 64 hex chars", async () => {
    const a = await hmacSha256Hex("k", "msg");
    const b = await hmacSha256Hex("k", "msg");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacSha256Hex("k2", "msg")).not.toBe(a);
  });
});
