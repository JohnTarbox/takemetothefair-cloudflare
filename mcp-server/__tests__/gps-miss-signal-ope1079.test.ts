/**
 * OPE-1079 — a correctly geotagged photo that matches no fair raises a signal
 * a human reads (admin_actions + flagged_for_review), and the reply is
 * unchanged.
 *
 * The specimen is the real one: four New Portland Lions Fair photos on
 * 2026-09-18 at ~44.9167,−70.0223, against a venue pin at 44.994,−70.0557
 * (9.0 km off). The fair was APPROVED and running that day.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "./setup-db.js";
import { buildJpegWithExif } from "./helpers/exif-jpeg.js";
import {
  adminActions,
  events,
  eventDays,
  inboundEmails,
  promoters,
  venues,
} from "../src/schema.js";

let currentDb: unknown = null;
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return { ...actual, getDb: () => currentDb };
});

import { handle as handlePhotoIntake } from "../src/email-handlers/photo-intake.js";
import {
  gpsMissAction,
  recordGpsMissSignal,
  GPS_NO_VENUE_IN_RANGE_ACTION,
  GPS_NO_EVENT_ON_DATE_ACTION,
} from "../src/photo/gps-miss-signal.js";
import type { Db } from "../src/db.js";

const FIX = { latitude: 44.91668, longitude: -70.02225 };
const BAD_PIN = { latitude: 44.994, longitude: -70.0557 };
const DATE = "2026-09-18";

async function seedNewPortland(db: Db, pin = BAD_PIN) {
  await db.insert(promoters).values({
    id: "p1",
    companyName: "New Portland Lions",
    slug: "new-portland-lions",
  } as never);
  await db.insert(venues).values({
    id: "v-np",
    name: "New Portland Lions Fair",
    slug: "new-portland-lions-fair",
    address: "280 School Street",
    zip: "04961",
    city: "New Portland",
    state: "ME",
    latitude: pin.latitude,
    longitude: pin.longitude,
  } as never);
  await db.insert(events).values({
    id: "e-np",
    name: "New Portland Lions Fair",
    slug: "new-portland-lions-fair",
    promoterId: "p1",
    venueId: "v-np",
    status: "APPROVED",
    startDate: new Date("2026-09-17T00:00:00Z"),
    endDate: new Date("2026-09-20T00:00:00Z"),
  } as never);
  await db.insert(eventDays).values(
    ["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"].map((date, i) => ({
      id: `d${i}`,
      eventId: "e-np",
      date,
    })) as never
  );
}

/** degrees → [d, m, s] for the EXIF builder. */
function dms(x: number): [number, number, number] {
  const a = Math.abs(x);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 100) / 100;
  return [d, m, s];
}

function geotaggedJpeg(fix: { latitude: number; longitude: number }) {
  return buildJpegWithExif({
    gps: {
      latDms: dms(fix.latitude),
      latRef: fix.latitude >= 0 ? "N" : "S",
      lonDms: dms(fix.longitude),
      lonRef: fix.longitude >= 0 ? "E" : "W",
    },
    dateTimeOriginal: "2026:09:18 14:44:03",
  });
}

const ROW_ID = "af3494c9-6009-4ad7-af14-51038c8f47eb";
const KEY = "inbound-attachments/g1/0-IMG_20260918_144737200.jpg";

async function seedInbound(db: Db) {
  await db.insert(inboundEmails).values({
    id: ROW_ID,
    receivedAt: new Date(),
    fromAddress: "jtarboxme@gmail.com",
    toAddress: "photos@meetmeatthefair.com",
    intent: "photo_intake",
    status: "processing",
    attachmentRefs: JSON.stringify([
      { key: KEY, name: "a.jpg", mimeType: "image/jpeg", size: 100 },
    ]),
    attachmentCount: 1,
    createdAt: new Date(),
  } as never);
}

function envWith(bytes: Uint8Array) {
  return {
    DB: {},
    VENDOR_ASSETS: {
      get: async (key: string) =>
        key === KEY ? { arrayBuffer: async () => bytes.slice().buffer } : null,
    },
  } as never;
}

const trusted = { sessionId: "wf-1", emailAuth: "pass", senderTrust: "trusted" } as never;

async function signalRows(db: Db, action: string) {
  return db
    .select()
    .from(adminActions)
    .where(and(eq(adminActions.action, action), eq(adminActions.targetId, ROW_ID)));
}

describe("gpsMissAction (OPE-1079, pure)", () => {
  const exif = { gps: FIX, takenOnLocalDate: DATE };
  it("signals the two GPS-bearing 'looked and found nothing' reasons", () => {
    expect(gpsMissAction("no-venue-in-radius", exif)).toBe(GPS_NO_VENUE_IN_RANGE_ACTION);
    expect(gpsMissAction("no-event-on-date", exif)).toBe(GPS_NO_EVENT_ON_DATE_ACTION);
  });
  it("is silent without a fix, without a date, at Null Island, and for other reasons", () => {
    expect(gpsMissAction("no-venue-in-radius", { takenOnLocalDate: DATE })).toBeNull();
    expect(gpsMissAction("no-venue-in-radius", { gps: FIX })).toBeNull();
    expect(
      gpsMissAction("no-venue-in-radius", {
        gps: { latitude: 0, longitude: 0 },
        takenOnLocalDate: DATE,
      })
    ).toBeNull();
    expect(gpsMissAction("ambiguous-multiple-events", exif)).toBeNull();
    expect(gpsMissAction("no-exif-gps", exif)).toBeNull();
    expect(gpsMissAction("resolver-error", exif)).toBeNull();
  });
});

describe("photo-intake handler — GPS miss signal (OPE-1079, real SQLite)", () => {
  let db: Db;
  beforeEach(async () => {
    db = createTestDb().db as unknown as Db;
    currentDb = db;
    await seedInbound(db);
  });

  it("the New Portland specimen: holds as before AND records the miss with the fair running nearby", async () => {
    await seedNewPortland(db);
    const res = await handlePhotoIntake(envWith(geotaggedJpeg(FIX)), trusted, {
      id: ROW_ID,
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        { key: KEY, name: "a.jpg", mimeType: "image/jpeg", size: 100 },
      ]),
    } as never);

    // Reply is unchanged: same kind, same reason, same params shape.
    expect(res.replyKind).toBe("photo-intake-unresolved");
    expect(res.replyParams?.holdReason).toBe("no-venue-in-radius");
    expect(res.replyParams?.sawGps).toBe(true);
    expect(res.resultingEventId).toBeNull();

    const rows = await signalRows(db, GPS_NO_VENUE_IN_RANGE_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe("inbound_email");
    const payload = JSON.parse(rows[0].payloadJson as string);
    expect(payload.taken_on_local_date).toBe(DATE);
    expect(payload.lat).toBeCloseTo(FIX.latitude, 3);
    expect(payload.nearest_venues[0]).toMatchObject({ id: "v-np", town: "New Portland, ME" });
    expect(payload.nearest_venues[0].distance_km).toBeGreaterThan(8.5);
    expect(payload.nearest_venues[0].distance_km).toBeLessThan(9.5);
    // The pin-defect fingerprint: the fair WAS running, ~9 km away.
    expect(payload.events_running_nearby).toEqual([
      expect.objectContaining({ id: "e-np", venue_id: "v-np", town: "New Portland, ME" }),
    ]);

    const [after] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, ROW_ID));
    expect(after.flaggedForReview).toBe(1);
  });

  it("does not double-record when the dispatch step is retried", async () => {
    await seedNewPortland(db);
    const row = {
      id: ROW_ID,
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        { key: KEY, name: "a.jpg", mimeType: "image/jpeg", size: 100 },
      ]),
    } as never;
    await handlePhotoIntake(envWith(geotaggedJpeg(FIX)), trusted, row);
    await handlePhotoIntake(envWith(geotaggedJpeg(FIX)), trusted, row);
    expect(await signalRows(db, GPS_NO_VENUE_IN_RANGE_ACTION)).toHaveLength(1);
  });

  it("records nothing once the pin is corrected and the photo resolves", async () => {
    await seedNewPortland(db, FIX);
    const res = await handlePhotoIntake(envWith(geotaggedJpeg(FIX)), trusted, {
      id: ROW_ID,
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        { key: KEY, name: "a.jpg", mimeType: "image/jpeg", size: 100 },
      ]),
    } as never);
    expect(res.replyKind).toBe("photo-intake-ack");
    // (flagged_for_review may still be 1 here — OPE-403 flags a resolved batch
    // whose photos stored nothing, which this binding-less env guarantees. The
    // assertion that matters is that no GPS-miss row was written.)
    expect(await signalRows(db, GPS_NO_VENUE_IN_RANGE_ACTION)).toHaveLength(0);
    expect(await signalRows(db, GPS_NO_EVENT_ON_DATE_ACTION)).toHaveLength(0);
  });

  it("a photo with NO GPS holds without a signal (nothing to act on)", async () => {
    await seedNewPortland(db);
    const res = await handlePhotoIntake(
      envWith(buildJpegWithExif({ dateTimeOriginal: "2026:09:18 14:44:03" })),
      trusted,
      {
        id: ROW_ID,
        toAddress: "photos@meetmeatthefair.com",
        subject: null,
        attachmentCount: 1,
        attachmentRefs: JSON.stringify([
          { key: KEY, name: "a.jpg", mimeType: "image/jpeg", size: 100 },
        ]),
      } as never
    );
    expect(res.replyParams?.holdReason).toBe("no-exif-gps");
    const all = await db.select().from(adminActions);
    expect(all.filter((r) => r.action.startsWith("photo.gps_"))).toHaveLength(0);
  });
});

describe("recordGpsMissSignal — the Phillips shape (no-event-on-date, OPE-1079)", () => {
  it("lists the running event whose OWN venue is 7 km off, beside the in-range venues", async () => {
    const db = createTestDb().db as unknown as Db;
    await seedInbound(db);
    await db.insert(venues).values([
      {
        id: "v-legion",
        name: "American Legion Post 64",
        slug: "legion-64",
        address: "Depot St",
        zip: "04966",
        city: "Phillips",
        state: "ME",
        latitude: 44.8230779,
        longitude: -70.3422473,
      },
      {
        id: "v-main",
        name: "Downtown Phillips — Main Street",
        slug: "downtown-phillips",
        address: "Depot St",
        zip: "04966",
        city: "Phillips",
        state: "ME",
        latitude: 44.8470536,
        longitude: -70.4245011,
      },
    ] as never);
    const ctx = await recordGpsMissSignal(db, {
      inboundEmailId: ROW_ID,
      reason: "no-event-on-date",
      gps: { latitude: 44.82366, longitude: -70.34045 },
      takenOnLocalDate: "2026-08-21",
      loadEventsAt: async (ids) => {
        expect(ids).toContain("v-main");
        return [
          {
            id: "e-ohd",
            name: "Phillips Old Home Days 2026",
            slug: "phillips-old-home-days-2026",
            venueId: "v-main",
            dates: ["2026-08-21"],
          },
          // Not running that day — must be filtered out.
          { id: "e-x", name: "Other", slug: "other", venueId: "v-legion", dates: ["2026-08-22"] },
        ];
      },
    });
    expect(ctx?.nearest_venues[0].id).toBe("v-legion");
    expect(ctx?.events_running_nearby).toHaveLength(1);
    expect(ctx?.events_running_nearby[0]).toMatchObject({ id: "e-ohd", venue_id: "v-main" });
    expect(ctx?.events_running_nearby[0].venue_distance_km).toBeGreaterThan(6.5);
    expect(await signalRows(db, GPS_NO_EVENT_ON_DATE_ACTION)).toHaveLength(1);
  });
});
