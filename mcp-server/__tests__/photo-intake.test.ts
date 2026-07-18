/**
 * OPE-202 — photos@ intake lane: routing (incl. plus-addressing), the
 * auth/trust gate in the handler, and the ack/held replies.
 * OPE-203 — fair resolution: override lookup + EXIF→venue×date matching,
 * exercised against a real SQLite via resolvePhotoEvent.
 */
import { describe, it, expect } from "vitest";
import { resolveIntent, parsePlusSegment, shouldForwardToAdmin } from "../src/email-intents.js";
import {
  handle as handlePhotoIntake,
  resolvePhotoEvent,
  slugCandidatesFromSubject,
  eventSlugsFromSubjectUrl,
  findEventBySubjectName,
} from "../src/email-handlers/photo-intake.js";
import { buildReply } from "../src/email-reply-builder.js";
import type { HandlerCtx } from "../src/email-handlers/types.js";
import type { Db } from "../src/db.js";
import type { ExifData } from "../src/photo/exif.js";
import { createTestDb } from "./setup-db.js";
import { events, eventDays, promoters, venues } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ctx = (
  emailAuth: "pass" | "fail" | "unknown",
  senderTrust: "trusted" | "watchlist" | "blocked" | "unknown"
): HandlerCtx => ({ sessionId: "wf-1", emailAuth, senderTrust });

// Minimal InboundEmail-shaped row (only the fields the handler reads).
const row = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    toAddress: "photos@meetmeatthefair.com",
    subject: "booth pics",
    attachmentCount: 3,
    attachmentRefs: null,
    ...over,
  }) as never;

const refs = (mimes: string[]) =>
  JSON.stringify(mimes.map((m, i) => ({ key: `k${i}`, name: `p${i}`, mimeType: m, size: 10 })));

/** env with a DB that is never actually queried on the paths under test, and
 *  no R2 — so readExif short-circuits to {} (the no-EXIF case). */
const envNoR2 = { DB: {} } as never;

const FRYEBURG_GPS = { latitude: 44.0176, longitude: -70.9803 };

describe("photo-intake routing (OPE-202)", () => {
  it("routes photos@ to photo_intake", () => {
    expect(resolveIntent("photos@meetmeatthefair.com")).toBe("photo_intake");
  });
  it("routes plus-addressed photos+<slug>@ to photo_intake (sub-address stripped)", () => {
    expect(resolveIntent("photos+summer-fair-2026@meetmeatthefair.com")).toBe("photo_intake");
    expect(resolveIntent("Photos+Summer@MeetMeAtTheFair.com")).toBe("photo_intake");
  });
  it("parses the +slug event hint", () => {
    expect(parsePlusSegment("photos+summer-fair-2026@meetmeatthefair.com")).toBe(
      "summer-fair-2026"
    );
    expect(parsePlusSegment("photos@meetmeatthefair.com")).toBeNull();
  });
  it("does not forward photo_intake to the admin Gmail (like submit)", () => {
    expect(shouldForwardToAdmin("photo_intake")).toBe(false);
    expect(shouldForwardToAdmin("support")).toBe(true);
  });
});

describe("photo-intake handler gate (OPE-202/203)", () => {
  it("auth fail → held (no DB/R2 touched)", async () => {
    const res = await handlePhotoIntake({} as never, ctx("fail", "trusted"), row());
    expect(res.replyKind).toBe("photo-intake-held");
  });

  it("untrusted sender (even if auth passes) → held", async () => {
    const res = await handlePhotoIntake({} as never, ctx("pass", "unknown"), row());
    expect(res.replyKind).toBe("photo-intake-held");
  });

  it("trusted but unidentifiable → photo-intake-unresolved, NOT a silent ack", async () => {
    // OPE-203 behaviour change: OPE-202 ack'd everything from a trusted sender.
    // Now, with no override and no readable EXIF, we hold and ask rather than
    // imply we matched a fair.
    // subject: null so the OPE-254 name-match stays query-free (the gate tests
    // use a stub DB; the name-match path has its own real-SQLite coverage in
    // the resolvePhotoEvent suite below).
    const res = await handlePhotoIntake(envNoR2, ctx("pass", "trusted"), row({ subject: null }));
    expect(res.replyKind).toBe("photo-intake-unresolved");
    expect(res.replyParams?.holdReason).toBe("no-exif-gps");
    expect(res.resultingEventId).toBeNull();
  });

  it("counts image attachments from refs (PDF excluded)", async () => {
    const res = await handlePhotoIntake(
      envNoR2,
      ctx("pass", "trusted"),
      row({
        subject: null, // keep the gate test off the OPE-254 name-match DB path
        attachmentCount: 4,
        attachmentRefs: refs(["image/jpeg", "image/png", "application/pdf", "image/heic"]),
      })
    );
    expect(res.replyParams?.photoCount).toBe(3); // 3 images, PDF excluded
  });
});

describe("slugCandidatesFromSubject", () => {
  it("picks slug-shaped tokens out of a subject", () => {
    expect(slugCandidatesFromSubject("Booths at fryeburg-fair today")).toEqual(["fryeburg-fair"]);
  });
  it("ignores ordinary prose (so we fall through to EXIF, not fuzzy-match)", () => {
    expect(slugCandidatesFromSubject("booth pics")).toEqual([]);
    expect(slugCandidatesFromSubject("Photos from the fair")).toEqual([]);
    expect(slugCandidatesFromSubject(null)).toEqual([]);
  });
});

describe("eventSlugsFromSubjectUrl (OPE-254)", () => {
  it("extracts the slug from a pasted /events/<slug> URL", () => {
    expect(
      eventSlugsFromSubjectUrl("Re: your photos — https://meetmeatthefair.com/events/fryeburg-fair")
    ).toEqual(["fryeburg-fair"]);
  });
  it("is case-insensitive and finds multiple", () => {
    expect(
      eventSlugsFromSubjectUrl("/Events/Oxford-County-Fair and /events/skowhegan-state-fair")
    ).toEqual(["oxford-county-fair", "skowhegan-state-fair"]);
  });
  it("yields nothing for prose with no /events/ URL", () => {
    expect(eventSlugsFromSubjectUrl("booth pics from the fair")).toEqual([]);
    expect(eventSlugsFromSubjectUrl(null)).toEqual([]);
  });
});

describe("resolvePhotoEvent (OPE-203, real SQLite)", () => {
  const noExif = async (): Promise<ExifData> => ({});
  const exifAt = (date: string) => async (): Promise<ExifData> => ({
    gps: FRYEBURG_GPS,
    takenOnLocalDate: date,
  });

  /** Seed a promoter + geocoded venue + an APPROVED 2-day fair with event_days. */
  async function seed(db: Db) {
    await db.insert(promoters).values({
      id: "p1",
      companyName: "Fryeburg Agricultural Society",
      slug: "fryeburg-ag" as never,
    } as never);
    await db.insert(venues).values({
      id: "v1",
      name: "Fryeburg Fairgrounds",
      slug: "fryeburg-fairgrounds" as never,
      address: "1154 Main St",
      city: "Fryeburg",
      state: "ME",
      zip: "04037",
      latitude: FRYEBURG_GPS.latitude,
      longitude: FRYEBURG_GPS.longitude,
    } as never);
    await db.insert(events).values({
      id: "e1",
      name: "Fryeburg Fair",
      slug: "fryeburg-fair" as never,
      promoterId: "p1",
      venueId: "v1",
      status: "APPROVED",
      startDate: new Date("2026-10-04T00:00:00Z"),
      endDate: new Date("2026-10-05T00:00:00Z"),
    } as never);
    await db.insert(eventDays).values([
      { id: "d1", eventId: "e1", date: "2026-10-04" },
      { id: "d2", eventId: "e1", date: "2026-10-05" },
    ] as never);
  }

  it("resolves EXIF GPS + date to the occurrence at that venue", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(db as unknown as Db, [], exifAt("2026-10-04"));
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.eventId).toBe("e1");
    expect(resolution.method).toBe("exif");
    expect(resolution.venueName).toBe("Fryeburg Fairgrounds");
  });

  it("holds when nothing approved was running at that venue on the photo's date", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(db as unknown as Db, [], exifAt("2026-06-01"));
    expect(resolution).toMatchObject({ status: "held", reason: "no-event-on-date" });
  });

  it("an explicit +slug override resolves without reading EXIF at all", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    let exifRead = false;
    const { resolution } = await resolvePhotoEvent(
      db as unknown as Db,
      ["fryeburg-fair"],
      async () => {
        exifRead = true;
        return {};
      }
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.eventId).toBe("e1");
    expect(resolution.method).toBe("override");
    // The whole point of the lazy thunk: a named fair spends no R2 reads.
    expect(exifRead).toBe(false);
  });

  it("falls through to EXIF when the named slug matches no event", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(
      db as unknown as Db,
      ["not-a-real-fair"],
      exifAt("2026-10-05")
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.method).toBe("exif");
  });

  it("resolves the fair NAMED in the subject prose, without reading EXIF (OPE-254)", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    let exifRead = false;
    const { resolution } = await resolvePhotoEvent(
      db as unknown as Db,
      [],
      async () => {
        exifRead = true;
        return {};
      },
      "Great photos from the Fryeburg Fair last weekend!"
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.eventId).toBe("e1");
    expect(resolution.method).toBe("override");
    expect(exifRead).toBe(false); // named fair short-circuits before R2
  });

  it("prose naming no fair falls through to EXIF, not a wrong name match (OPE-254)", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(
      db as unknown as Db,
      [],
      exifAt("2026-10-04"),
      "here are some booth pics from the fair"
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.method).toBe("exif");
  });

  it("HOLDS when the subject names two independent fairs (ambiguous) (OPE-254)", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    // A second APPROVED fair whose slug is also spelled out in the subject.
    await db.insert(events).values({
      id: "e2",
      name: "Skowhegan State Fair",
      slug: "skowhegan-state-fair" as never,
      promoterId: "p1",
      status: "APPROVED",
      isStatewide: true,
      stateCode: "ME",
      startDate: new Date("2026-08-13T00:00:00Z"),
      endDate: new Date("2026-08-22T00:00:00Z"),
    } as never);
    const { resolution } = await resolvePhotoEvent(
      db as unknown as Db,
      [],
      async () => ({}), // no EXIF → an ambiguous name match must land as a hold
      "Photos from the Fryeburg Fair and the Skowhegan State Fair"
    );
    expect(resolution).toMatchObject({ status: "held", reason: "no-exif-gps" });
  });

  it("findEventBySubjectName ignores a subject with no slug-able content", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    expect(await findEventBySubjectName(db as unknown as Db, "!!! ...")).toBeNull();
    expect(await findEventBySubjectName(db as unknown as Db, null)).toBeNull();
  });

  it("does not match a DRAFT/PENDING event — holds instead of attributing", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    await db.update(events).set({ status: "PENDING" }).where(eq(events.id, "e1"));
    const { resolution } = await resolvePhotoEvent(db as unknown as Db, [], exifAt("2026-10-04"));
    expect(resolution.status).toBe("held");
  });

  it("holds when GPS lands nowhere near a geocoded venue", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(db as unknown as Db, [], async () => ({
      gps: { latitude: 40.7128, longitude: -74.006 }, // NYC
      takenOnLocalDate: "2026-10-04",
    }));
    expect(resolution).toMatchObject({ status: "held", reason: "no-venue-in-radius" });
  });

  it("holds with no EXIF at all", async () => {
    const { db } = createTestDb();
    await seed(db as unknown as Db);
    const { resolution } = await resolvePhotoEvent(db as unknown as Db, [], noExif);
    expect(resolution).toMatchObject({ status: "held", reason: "no-exif-gps" });
  });
});

describe("photo-intake replies (OPE-202/203)", () => {
  it("ack reply names the count + carries the EXIF full-size tip", () => {
    const msg = buildReply("photo-intake-ack", "j@example.com", {
      subject: "pics",
      photoCount: 3,
      eventHint: "summer-fair",
    });
    expect(msg.text).toContain("received 3 photos");
    expect(msg.text.toLowerCase()).toContain("full size");
    expect(msg.text).toContain("summer-fair");
  });

  it("ack reply names the matched fair when the resolver identified one", () => {
    const msg = buildReply("photo-intake-ack", "j@example.com", {
      subject: "pics",
      photoCount: 2,
      eventHint: null,
      resolvedEventName: "Fryeburg Fair",
      resolvedEventSlug: "fryeburg-fair",
      matchMethod: "exif",
      matchedDate: "2026-10-04",
      venueName: "Fryeburg Fairgrounds",
      distanceMiles: 0.12,
    });
    expect(msg.text).toContain("Matched to: Fryeburg Fair");
    expect(msg.text).toContain("2026-10-04");
    expect(msg.text).toContain("Fryeburg Fairgrounds");
    expect(msg.text).toContain("0.12 mi");
    // Must always offer the correction path.
    expect(msg.text).toContain("photos+<event-slug>@meetmeatthefair.com");
  });

  it("held reply explains the hold + keeps the EXIF tip", () => {
    const msg = buildReply("photo-intake-held", "j@example.com", { photoCount: 1 });
    expect(msg.text).toContain("received 1 photo");
    expect(msg.text.toLowerCase()).toContain("review");
    expect(msg.text.toLowerCase()).toContain("full size");
  });

  it("unresolved reply says WHY and how to fix it", () => {
    const msg = buildReply("photo-intake-unresolved", "j@example.com", {
      photoCount: 2,
      holdReason: "ambiguous-multiple-events",
      holdAsk: "more than one approved fair was running at that venue that day",
      holdDetail: "Fryeburg Fair, Fryeburg Antique Show",
    });
    expect(msg.text).toContain("couldn't work out which fair");
    expect(msg.text).toContain("more than one approved fair");
    expect(msg.text).toContain("Fryeburg Fair, Fryeburg Antique Show");
    expect(msg.text).toContain("photos+<event-slug>@meetmeatthefair.com");
  });
});
