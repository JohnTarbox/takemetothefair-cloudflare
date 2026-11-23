/**
 * OPE-1705 slice 3 — cards away from a fair, "Add as vendor", "Met them at…".
 *
 * Driven two ways, on the real (sqlite) schema:
 *   - `runBoothPipeline` directly, for the write rules (create / link / stage);
 *   - the photo-intake HANDLER, for the routing: a "No fair" card is never
 *     held as "which fair?", a non-card under "No fair" falls back to the
 *     ordinary path, and a card on the hold path is handled instead of held.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";

// The handler opens its own drizzle handle from env.DB; hand it the test db.
vi.mock("../src/db.js", () => ({ getDb: (d: unknown) => d }));

import {
  adminActions,
  eventDays,
  eventVendors,
  events,
  venues,
  inboundEmails,
  promoters,
  users,
  vendors,
  vendorEnrichmentCandidates,
} from "../src/schema.js";
import {
  CARD_APPLIED_ACTION,
  CARD_PROPOSED_ACTION,
  runBoothPipeline,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import { describePhotoStorage, handle } from "../src/email-handlers/photo-intake.js";
import { SNAP_ROUTING_SOURCE, type CaptureMeta } from "../src/photo/snap-intake.js";
import type { Db } from "../src/db.js";

const f = (value: unknown, confidence = 1) => ({ value, confidence });

let db: TestDb;
function seedVendor(id: string, businessName: string, extra: Record<string, unknown> = {}) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, ...extra } as never)
    .run();
}
beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "ev1", name: "CMP Fair", slug: "cmp-fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

const cardReply = (over: Record<string, unknown> = {}) => ({
  response: {
    business_name: f("Alder Brook Soaps"),
    contact_name: f("Jane Doe"),
    phone: f("207-555-0123"),
    email: f("jane@alderbrooksoaps.com"),
    website: f("alderbrooksoaps.com"),
    social: f([]),
    street: f(null),
    city: f("Gray"),
    state: f("ME"),
    zip: f(null),
    ...over,
  },
});
const classify = (kind: "business_card" | "booth") => ({
  response: {
    kind,
    name: kind === "booth" ? "Somebody's Booth" : "Alder Brook Soaps",
    website: null,
    products: [],
    confidence: 1,
    rationale: kind,
    identifiable_minor: false,
  },
});
const env = (
  card: unknown,
  opts: { autoWrite?: string; kind?: "business_card" | "booth" } = {}
): BoothPipelineEnv & { DB: unknown } => ({
  AI: {
    run: async (_m: string, input: { prompt?: string }) =>
      input?.prompt?.includes("BUSINESS CARD") ? card : classify(opts.kind ?? "business_card"),
  },
  VENDOR_ASSETS: {
    get: async () => ({
      arrayBuffer: async () => new Uint8Array([1]).buffer,
      httpMetadata: { contentType: "image/jpeg" },
    }),
  } as unknown as R2Bucket,
  PHOTO_VISION_ENABLED: "true",
  PHOTO_AUTOWRITE_ENABLED: opts.autoWrite ?? "true",
  DB: db,
});
const photos = [{ key: "inbound-attachments/snap-x/0-card.jpg", name: "0-card.jpg" }];
const actions = () => db.select().from(adminActions).all();
const payload = (a: { payloadJson: string | null }) => JSON.parse(a.payloadJson ?? "{}");
const vendorByName = (name: string) =>
  db.select().from(vendors).where(eq(vendors.businessName, name)).all();
const links = () => db.select().from(eventVendors).all();

// ─── The pipeline's write rules ─────────────────────────────────────────────

describe("runBoothPipeline — 'Add as vendor'", () => {
  it("ticked, at a pinned fair, unknown business: the vendor is created AND linked, contacts still staged, no image", async () => {
    const res = await runBoothPipeline(
      env(cardReply()),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      {
        cardIntent: { addAsVendor: true, metAtEventId: null },
      }
    );
    const [v] = vendorByName("Alder Brook Soaps");
    expect(v).toBeDefined();
    expect(v.website).toBe("https://alderbrooksoaps.com");
    expect([v.city, v.state]).toEqual(["Gray", "ME"]); // identity blank-fill, ruling (a)
    expect([v.contactEmail, v.contactPhone, v.contactName]).toEqual([null, null, null]);
    expect(v.logoUrl).toBeNull(); // the card never becomes a hero/logo
    expect(links().map((l) => [l.eventId, l.vendorId, l.status])).toEqual([
      ["ev1", v.id, "CONFIRMED"],
    ]);
    expect(
      db
        .select()
        .from(vendorEnrichmentCandidates)
        .all()
        .map((c) => c.proposedField)
    ).toEqual(["contact_email", "contact_phone", "contact_name"]);
    const a = actions().find((x) => x.action === CARD_APPLIED_ACTION)!;
    expect(payload(a)).toMatchObject({
      vendor_id: v.id,
      match_basis: "created",
      created: true,
      linked_event_id: "ev1",
      add_as_vendor: true,
    });
    expect(res.cards?.applied[0]).toMatchObject({ matchBasis: "created", linkedEventId: "ev1" });
    expect(res.cardsHandled).toBe(1);
  });

  it("unticked (the default): the same card creates NOTHING and is kept privately as card_unmatched", async () => {
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    expect(links()).toEqual([]);
    const [a] = actions();
    expect(a.action).toBe(CARD_PROPOSED_ACTION);
    expect(payload(a)).toMatchObject({ stage_kind: "card_unmatched", add_as_vendor: false });
  });

  it("ticked but the name is unreadable: still staged — the box cannot fix a bad reading", async () => {
    await runBoothPipeline(
      env(cardReply({ business_name: f("Alder Brook Soaps", 0.6) })),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      { cardIntent: { addAsVendor: true, metAtEventId: null } }
    );
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    expect(payload(actions()[0])).toMatchObject({
      stage_kind: "card_name_unreadable",
      add_as_vendor: true,
    });
  });

  it("ticked but a generic word is the 'name': still staged (OPE-1695)", async () => {
    await runBoothPipeline(
      env(cardReply({ business_name: f("Welcome"), website: f(null), email: f(null) })),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      { cardIntent: { addAsVendor: true, metAtEventId: null } }
    );
    expect(vendorByName("Welcome")).toEqual([]);
    expect(payload(actions()[0]).stage_kind).toBe("card_name_generic");
  });

  it("ticked with auto-write OFF: staged, and the reason says the box was ticked", async () => {
    await runBoothPipeline(
      env(cardReply(), { autoWrite: "false" }),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      { cardIntent: { addAsVendor: true, metAtEventId: null } }
    );
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    const p = payload(actions()[0]);
    expect(p.stage_kind).toBe("card_unmatched");
    expect(p.stage_reason).toMatch(/Add as vendor" was ticked/);
  });

  it("ticked, held fair-guess (OPE-1697): staged, nothing created", async () => {
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos, {
      cardIntent: { addAsVendor: true, metAtEventId: null },
      holdAutoWriteReason: "two fairs nearby",
    });
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
  });

  it("a dry run creates nothing and names the vendor a live run would create", async () => {
    const res = await runBoothPipeline(
      env(cardReply()),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      {
        dryRun: true,
        cardIntent: { addAsVendor: true, metAtEventId: null },
      }
    );
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    expect(actions()).toEqual([]);
    expect(res.cards?.wouldCreate).toEqual(["Alder Brook Soaps"]);
  });

  it("ticked, but an existing vendor matches: it is filled, never duplicated", async () => {
    seedVendor("v1", "Alder Brook Soaps", { website: "https://alderbrooksoaps.com" });
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos, {
      cardIntent: { addAsVendor: true, metAtEventId: null },
    });
    expect(vendorByName("Alder Brook Soaps").map((v) => v.id)).toEqual(["v1"]);
    expect(payload(actions()[0])).toMatchObject({ vendor_id: "v1", match_basis: "domain" });
  });
});

describe("runBoothPipeline — with NO event", () => {
  it("ticked, no event: a standalone vendor, no event link", async () => {
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", null, photos, {
      cardIntent: { addAsVendor: true, metAtEventId: null },
    });
    const [v] = vendorByName("Alder Brook Soaps");
    expect(v).toBeDefined();
    expect(links()).toEqual([]);
    expect(payload(actions()[0])).toMatchObject({ event_id: null, linked_event_id: null });
    // The placeholder owner is an INGESTION row, like every other create (OPE-292).
    const [u] = db.select().from(users).where(eq(users.id, v.userId)).all();
    expect(u.origin).toBe("ingestion");
  });

  it("'Met them at…' on a MATCHED card links that vendor to the past event", async () => {
    seedVendor("v1", "Alder Brook Soaps", { website: "https://alderbrooksoaps.com" });
    const res = await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", null, photos, {
      cardIntent: { addAsVendor: false, metAtEventId: "ev1" },
    });
    expect(links().map((l) => [l.eventId, l.vendorId, l.status])).toEqual([
      ["ev1", "v1", "CONFIRMED"],
    ]);
    const card = actions().find((a) => a.action === CARD_APPLIED_ACTION)!;
    expect(payload(card)).toMatchObject({
      met_at_event_id: "ev1",
      linked_event_id: "ev1",
    });
    expect(res.cards?.applied[0].linkedEventId).toBe("ev1");
  });

  it("'Met them at…' + ticked on an UNKNOWN card: created and linked to that event", async () => {
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", null, photos, {
      cardIntent: { addAsVendor: true, metAtEventId: "ev1" },
    });
    const [v] = vendorByName("Alder Brook Soaps");
    expect(links().map((l) => [l.eventId, l.vendorId])).toEqual([["ev1", v.id]]);
  });

  it("'Met them at…' is ignored when the run HAS an event (only an event-less card carries one)", async () => {
    db.insert(events)
      .values({ id: "ev2", name: "Other", slug: "other", promoterId: "p1", status: "APPROVED" })
      .run();
    seedVendor("v1", "Alder Brook Soaps", { website: "https://alderbrooksoaps.com" });
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos, {
      cardIntent: { addAsVendor: false, metAtEventId: "ev2" },
    });
    expect(links()).toEqual([]);
  });

  it("a NON-card photo writes nothing and reports notCards, so the caller resolves a fair", async () => {
    const res = await runBoothPipeline(
      env(cardReply(), { kind: "booth" }),
      db as unknown as Db,
      "ie1",
      null,
      photos,
      { cardIntent: { addAsVendor: true, metAtEventId: null } }
    );
    expect(res.notCards).toBe(1);
    expect(res.examined).toBe(1); // landmark: the photo WAS looked at
    expect(actions()).toEqual([]);
    expect(db.select().from(vendors).all()).toEqual([]);
  });
});

describe("describePhotoStorage — a card is a deliberate outcome", () => {
  it("a lone card at a fair is NOT 'landed nowhere' (else the OPE-403 sweep re-tries it)", async () => {
    const res = await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    expect(res.galleryAttached).toBe(0);
    expect(describePhotoStorage(1, res).blockedReason).toBeNull();
    // Landmark: without the card count the same result WOULD be blocked.
    expect(describePhotoStorage(1, { ...res, cardsHandled: 0 }).blockedReason).not.toBeNull();
  });
});

// ─── The handler's routing ──────────────────────────────────────────────────

const ROW = "snap-11111111-2222-3333-4444-555555555555";
function seedRow(meta: Partial<CaptureMeta> | null, over: Record<string, unknown> = {}) {
  const captureMeta: CaptureMeta | null = meta
    ? {
        client_id: "11111111-2222-3333-4444-555555555555",
        captured_at: "2026-11-23T15:00:00Z",
        location: null,
        location_source: "none",
        taken_on_local_date: "2026-11-23",
        event_id: null,
        event_slug: null,
        note: null,
        actor: "admin@example.test",
        ...meta,
      }
    : null;
  db.insert(inboundEmails)
    .values({
      id: ROW,
      receivedAt: new Date("2026-11-23T15:00:01Z"),
      fromAddress: "admin@example.test",
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      intent: "photo_intake",
      status: "processing",
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        { key: photos[0].key, name: photos[0].name, mimeType: "image/jpeg", size: 1 },
      ]),
      routingSource: meta ? SNAP_ROUTING_SOURCE : null,
      captureMeta: captureMeta ? JSON.stringify(captureMeta) : null,
      createdAt: new Date("2026-11-23T15:00:01Z"),
      ...over,
    } as never)
    .run();
  return db.select().from(inboundEmails).where(eq(inboundEmails.id, ROW)).get()!;
}
const ctx = { sessionId: "s", senderTrust: "trusted", emailAuth: "pass" } as never;
const run = (e: ReturnType<typeof env>, row: ReturnType<typeof seedRow>) =>
  handle(e as never, ctx, row as never);

describe("photo-intake handler — 'No fair: vendor card only'", () => {
  it("a ticked card shot at home: vendor created, no event link, NOT held as 'which fair?'", async () => {
    const res = await run(env(cardReply()), seedRow({ no_fair: true, add_as_vendor: true }));
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.resultingEventId).toBeNull();
    expect(res.replyParams).toMatchObject({ cardsOnly: true, cardsCreated: 1, cardsMatched: 0 });
    expect(vendorByName("Alder Brook Soaps")).toHaveLength(1);
    expect(links()).toEqual([]);
  });

  it("unticked: nothing created, the card is kept as card_unmatched — and still not held", async () => {
    const res = await run(env(cardReply()), seedRow({ no_fair: true }));
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.replyParams).toMatchObject({ cardsOnly: true, cardsProposed: 1 });
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    expect(payload(actions()[0])).toMatchObject({ stage_kind: "card_unmatched", event_id: null });
  });

  it("an existing vendor: its blanks fill and 'Met them at…' links it", async () => {
    seedVendor("v1", "Alder Brook Soaps", { website: "https://alderbrooksoaps.com" });
    const res = await run(env(cardReply()), seedRow({ no_fair: true, met_at_event_id: "ev1" }));
    expect(res.replyParams).toMatchObject({ cardsMatched: 1 });
    const v = db.select().from(vendors).where(eq(vendors.id, "v1")).get()!;
    expect([v.city, v.state]).toEqual(["Gray", "ME"]);
    expect(
      db
        .select()
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, "ev1"), eq(eventVendors.vendorId, "v1")))
        .all()
    ).toHaveLength(1);
  });

  it("'No fair' wins over the GPS: a card shot AT a running fair is not pinned to it", async () => {
    // A fair running today, at the exact spot the phone is.
    const AT = { latitude: 43.9, longitude: -70.3 };
    db.insert(venues)
      .values({
        id: "vn1",
        name: "Fairgrounds",
        slug: "fairgrounds",
        address: "1 Fair Rd",
        city: "Gray",
        state: "ME",
        zip: "04039",
        ...AT,
      } as never)
      .run();
    db.update(events)
      .set({
        venueId: "vn1",
        startDate: new Date("2026-11-23T00:00:00Z"),
        endDate: new Date("2026-11-23T00:00:00Z"),
      } as never)
      .where(eq(events.id, "ev1"))
      .run();
    db.insert(eventDays)
      .values({ id: "d1", eventId: "ev1", date: "2026-11-23" } as never)
      .run();
    const located = {
      location: { ...AT, accuracy_m: 10 },
      location_source: "device" as const,
    };
    // Landmark: WITHOUT "No fair" the same shot resolves onto ev1.
    const pinned = await run(env(cardReply()), seedRow(located));
    expect(pinned.resultingEventId).toBe("ev1");
    db.delete(inboundEmails).run();
    db.delete(adminActions).run();

    const res = await run(env(cardReply()), seedRow({ ...located, no_fair: true }));
    expect(res.resultingEventId).toBeNull();
    expect(res.replyParams).toMatchObject({ cardsOnly: true });
  });

  it("'No fair' on a shot that is NOT a card falls back to the ordinary path (here: held, no location)", async () => {
    const res = await run(
      env(cardReply(), { kind: "booth" }),
      seedRow({ no_fair: true, add_as_vendor: true })
    );
    expect(res.replyKind).toBe("photo-intake-unresolved");
    expect(db.select().from(vendors).all()).toEqual([]);
  });
});

describe("photo-intake handler — the 'which fair?' hold does not apply to cards", () => {
  it("a card snap with no fair pinned and no location: handled as a card, not held", async () => {
    const res = await run(env(cardReply()), seedRow({}));
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.replyParams).toMatchObject({ cardsOnly: true });
  });

  it("an EMAILED card with no fair: the unticked default — kept as card_unmatched, not held", async () => {
    const res = await run(env(cardReply()), seedRow(null));
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(vendorByName("Alder Brook Soaps")).toEqual([]);
    expect(payload(actions()[0]).stage_kind).toBe("card_unmatched");
  });

  it("a booth photo with no fair is still held (landmark: the hold path is live)", async () => {
    const res = await run(env(cardReply(), { kind: "booth" }), seedRow({}));
    expect(res.replyKind).toBe("photo-intake-unresolved");
  });
});
