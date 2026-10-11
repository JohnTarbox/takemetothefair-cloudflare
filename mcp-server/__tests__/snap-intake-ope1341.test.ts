/**
 * OPE-1341 — a photo from the snap capture page runs through the SAME
 * photo-intake handler an emailed photo does, keyed the same way.
 *
 * Covers: ingest (strip-before-store, idempotency on the client id, the row's
 * provenance and send suppression, the Workflow start), the location decision
 * (EXIF first, device fallback, recorded), and the handler reading a snap's
 * location from `capture_meta` — including a run with NO trust params, which is
 * what the stale-inbound sweep sends when it recovers a stuck row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup-db.js";
import { buildJpegWithExif } from "./helpers/exif-jpeg.js";
import { events, eventDays, inboundEmails, promoters, venues } from "../src/schema.js";
import { parseExif } from "../src/photo/exif.js";

let currentDb: unknown = null;
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return { ...actual, getDb: () => currentDb };
});

import {
  decideLocation,
  ingestSnap,
  snapRowId,
  snapToAddress,
  SNAP_ROUTING_SOURCE,
  type SnapClientMeta,
} from "../src/photo/snap-intake.js";
import { handle as handlePhotoIntake } from "../src/email-handlers/photo-intake.js";
import type { Db } from "../src/db.js";

const CLIENT_ID = "3f1c2b9e-8d4a-4c6b-9e2f-1a2b3c4d5e6f";
const FRYEBURG = { latitude: 44.0176, longitude: -70.9803 };

function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: vi.fn(async (key: string, value: Uint8Array) => {
      objects.set(key, value);
    }),
  };
}

function fakeWorkflow() {
  return { create: vi.fn(async () => ({ id: "wf-snap-1" })) };
}

async function seedFryeburg(db: Db) {
  await db
    .insert(promoters)
    .values({ id: "p1", companyName: "Fryeburg Ag", slug: "fryeburg-ag" } as never);
  await db.insert(venues).values({
    id: "v1",
    name: "Fryeburg Fairgrounds",
    slug: "fryeburg-fairgrounds",
    address: "1154 Main St",
    city: "Fryeburg",
    state: "ME",
    zip: "04037",
    latitude: FRYEBURG.latitude,
    longitude: FRYEBURG.longitude,
  } as never);
  await db.insert(events).values({
    id: "e1",
    name: "Fryeburg Fair",
    slug: "fryeburg-fair",
    promoterId: "p1",
    venueId: "v1",
    status: "TENTATIVE",
    startDate: new Date("2026-10-04T00:00:00Z"),
    endDate: new Date("2026-10-04T00:00:00Z"),
  } as never);
  await db.insert(eventDays).values([{ id: "d1", eventId: "e1", date: "2026-10-04" }] as never);
}

const ctx = (emailAuth = "unknown", senderTrust = "unknown") =>
  ({ sessionId: "wf-1", emailAuth, senderTrust }) as never;

describe("decideLocation (OPE-1341)", () => {
  const meta: SnapClientMeta = {
    clientId: CLIENT_ID,
    latitude: 44.01,
    longitude: -70.98,
    accuracyM: 12,
    takenOnLocalDate: "2026-10-04",
  };

  it("prefers EXIF when it carries both GPS and a date, and says so", () => {
    const where = decideLocation(
      { gps: { latitude: 1, longitude: 2 }, takenOnLocalDate: "2026-10-03" },
      meta
    );
    expect(where).toEqual({
      location: { latitude: 1, longitude: 2, accuracy_m: null },
      location_source: "exif",
      taken_on_local_date: "2026-10-03",
    });
  });

  it("falls back to the device fix when EXIF has none", () => {
    expect(decideLocation({}, meta)).toEqual({
      location: { latitude: 44.01, longitude: -70.98, accuracy_m: 12 },
      location_source: "device",
      taken_on_local_date: "2026-10-04",
    });
  });

  it("records 'none' with no usable fix, and rejects out-of-range coordinates", () => {
    expect(decideLocation({}, { clientId: CLIENT_ID, latitude: 200, longitude: 5 })).toMatchObject({
      location: null,
      location_source: "none",
    });
  });

  it("derives the local date on the New England clock when the phone sent none", () => {
    // 01:30Z on Oct 5 is still Oct 4 in Maine — the UTC date would be a day late.
    expect(
      decideLocation({}, { clientId: CLIENT_ID, capturedAt: "2026-10-05T01:30:00Z" })
        .taken_on_local_date
    ).toBe("2026-10-04");
  });
});

describe("snap ids and addresses (OPE-1341)", () => {
  it("derives a stable row id from a UUID client id, and refuses anything else", () => {
    expect(snapRowId(CLIENT_ID)).toBe(`snap-${CLIENT_ID}`);
    expect(snapRowId("not-a-uuid")).toBeNull();
    expect(snapRowId("../../etc")).toBeNull();
  });
  it("puts a pinned event in the existing plus-address override", () => {
    expect(snapToAddress("fryeburg-fair")).toBe("photos+fryeburg-fair@meetmeatthefair.com");
    expect(snapToAddress(null)).toBe("photos@meetmeatthefair.com");
    expect(snapToAddress("Bad Slug!")).toBe("photos@meetmeatthefair.com");
  });
});

describe("ingestSnap (OPE-1341)", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb().db as unknown as Db;
  });

  const gpsJpeg = () =>
    buildJpegWithExif({
      gps: { latDms: [44, 1, 3.36], latRef: "N", lonDms: [70, 58, 49.08], lonRef: "W" },
      dateTimeOriginal: "2026:10:04 11:03:08",
    });

  it("strips GPS BEFORE the R2 put and records the location in capture_meta instead", async () => {
    const bytes = gpsJpeg();
    expect(parseExif(bytes).gps).toBeDefined(); // landmark: the input really has GPS
    const bucket = fakeBucket();
    const wf = fakeWorkflow();

    const res = await ingestSnap(
      { VENDOR_ASSETS: bucket as never, INBOUND_EMAIL: wf as never },
      db,
      {
        bytes,
        contentType: "image/jpeg",
        fileName: "IMG_1.jpg",
        meta: { clientId: CLIENT_ID },
        actor: "john@example.com",
      }
    );
    expect(res).toMatchObject({
      ok: true,
      deduped: false,
      workflowStarted: true,
      locationSource: "exif",
    });

    const [key, stored] = [...bucket.objects.entries()][0];
    expect(key).toBe(`inbound-attachments/snap-${CLIENT_ID}/0-IMG_1.jpg`);
    expect(parseExif(stored).gps).toBeUndefined();

    const [row] = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.id, `snap-${CLIENT_ID}`));
    expect(row).toMatchObject({
      intent: "photo_intake",
      status: "received",
      routingSource: SNAP_ROUTING_SOURCE,
      fromAddress: "john@example.com",
      toAddress: "photos@meetmeatthefair.com",
      attachmentCount: 1,
    });
    expect(row.repliesSuppressedReason).toMatch(/^snap-app/);
    const meta = JSON.parse(row.captureMeta!);
    expect(meta).toMatchObject({ location_source: "exif", taken_on_local_date: "2026-10-04" });
    expect(meta.location.latitude).toBeCloseTo(44.0176, 3);

    expect(wf.create).toHaveBeenCalledTimes(1);
    expect(wf.create.mock.calls[0][0]).toMatchObject({
      params: { messageRowId: `snap-${CLIENT_ID}`, intent: "photo_intake" },
    });
  });

  it("is idempotent on the client id: a retried upload writes nothing new", async () => {
    const bucket = fakeBucket();
    const wf = fakeWorkflow();
    const env = { VENDOR_ASSETS: bucket as never, INBOUND_EMAIL: wf as never };
    const input = {
      bytes: gpsJpeg(),
      contentType: "image/jpeg",
      meta: { clientId: CLIENT_ID },
      actor: "john@example.com",
    };
    await ingestSnap(env, db, input);
    const again = await ingestSnap(env, db, input);
    expect(again).toMatchObject({ ok: true, deduped: true, workflowStarted: false });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(wf.create).toHaveBeenCalledTimes(1);
    const rows = await db.select({ id: inboundEmails.id }).from(inboundEmails);
    expect(rows).toHaveLength(1);
  });

  it("carries a pinned event as the plus-address and refuses bad input", async () => {
    const bucket = fakeBucket();
    const env = { VENDOR_ASSETS: bucket as never, INBOUND_EMAIL: fakeWorkflow() as never };
    await ingestSnap(env, db, {
      bytes: gpsJpeg(),
      contentType: "image/jpeg",
      meta: { clientId: CLIENT_ID, eventId: "e1", eventSlug: "fryeburg-fair" },
      actor: "john@example.com",
    });
    const [row] = await db.select().from(inboundEmails);
    expect(row.toAddress).toBe("photos+fryeburg-fair@meetmeatthefair.com");

    expect(
      await ingestSnap(env, db, {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        meta: { clientId: "11111111-2222-4333-8444-555555555555" },
        actor: "john@example.com",
      })
    ).toMatchObject({ ok: false, status: 415 });
    expect(
      await ingestSnap(env, db, {
        bytes: gpsJpeg(),
        contentType: "image/jpeg",
        meta: { clientId: "nope" },
        actor: "john@example.com",
      })
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("photo-intake handler reads a snap's location from capture_meta (OPE-1341)", () => {
  let db: Db;
  beforeEach(async () => {
    db = createTestDb().db as unknown as Db;
    currentDb = db;
    await seedFryeburg(db);
  });

  const snapRow = (over: Record<string, unknown> = {}) =>
    ({
      id: `snap-${CLIENT_ID}`,
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        {
          key: `inbound-attachments/snap-${CLIENT_ID}/0-a.jpg`,
          name: "a.jpg",
          mimeType: "image/jpeg",
          size: 9,
        },
      ]),
      routingSource: SNAP_ROUTING_SOURCE,
      captureMeta: JSON.stringify({
        client_id: CLIENT_ID,
        location: {
          latitude: FRYEBURG.latitude + 0.0001,
          longitude: FRYEBURG.longitude,
          accuracy_m: 10,
        },
        location_source: "device",
        taken_on_local_date: "2026-10-04",
      }),
      ...over,
    }) as never;

  // No AI / vision / R2 bindings: the booth stage no-ops, so this isolates the
  // fair-resolution decision the ticket is about.
  const env = { DB: {} } as never;

  it("resolves by the device fix — even on a run with NO trust params (stale-sweep shape)", async () => {
    const res = await handlePhotoIntake(env, ctx(), snapRow());
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.resultingEventId).toBe("e1");
  });

  it("resolves a pinned event with no location at all (plus-address override)", async () => {
    const res = await handlePhotoIntake(
      env,
      ctx(),
      snapRow({
        toAddress: "photos+fryeburg-fair@meetmeatthefair.com",
        captureMeta: JSON.stringify({
          client_id: CLIENT_ID,
          location: null,
          location_source: "none",
        }),
      })
    );
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.resultingEventId).toBe("e1");
  });

  it("holds a snap with no location and no pin — it does not guess", async () => {
    const res = await handlePhotoIntake(
      env,
      ctx(),
      snapRow({
        captureMeta: JSON.stringify({
          client_id: CLIENT_ID,
          location: null,
          location_source: "none",
        }),
      })
    );
    expect(res.replyKind).toBe("photo-intake-unresolved");
    expect(res.replyParams?.holdReason).toBe("no-exif-gps");
  });

  it("a NON-snap row with the same metadata is still gated on trust (the bypass is snap-only)", async () => {
    const res = await handlePhotoIntake(env, ctx(), snapRow({ routingSource: "classifier" }));
    expect(res.replyKind).toBe("photo-intake-held");
  });
});
