/**
 * OPE-202/203 — `photo_intake` handler for photos@meetmeatthefair.com.
 *
 * Milestone 1 (OPE-202): receive on-site fair photos, gate on authentication +
 * sender trust, acknowledge.
 * Milestone 2 (OPE-203, this): work out WHICH FAIR the photos came from and
 * name it in the reply — or hold and ask, never guess.
 *
 * Still NO public writes here — the vendor-creation tail is downstream
 * (OPE-204), which carries the OPE-6 gate. This handler only reads, resolves,
 * and records the resolved event on the row (`resulting_event_id`) for that
 * downstream step to consume.
 *
 * ── How the fair is identified ────────────────────────────────────────────
 * A fair is a **venue × date**, and a phone photo carries both: GPS → venue,
 * DateTimeOriginal → day. Resolution order (first confident hit wins):
 *
 *   1. Explicit override — `photos+<event-slug>@` sub-address (OPE-202 parses
 *      it) or an event slug in the subject. John naming the fair beats any
 *      inference, and is the documented escape hatch for photos with no GPS.
 *   2. EXIF — GPS → geocoded venues within a small radius → the APPROVED
 *      occurrence running on the photo's local date.
 *   3. Otherwise → HOLD and ask. Never a wrong silent guess: the OPE-204 tail
 *      writes vendor↔event links off this verdict, and a bad attribution would
 *      claim a vendor attended a fair they never did.
 *
 * ── Why reading EXIF here is safe ─────────────────────────────────────────
 * The entrypoint captures attachments to R2 UNSTRIPPED
 * (`email-handler.ts:captureAttachments` → `inbound-attachments/<group>/...`),
 * so GPS is still present in those bytes. `src/lib/image-optim.ts:
 * stripExifFromJpeg` is the gate for anything promoted to the PUBLIC CDN and is
 * NOT on this path — GPS still must never reach the CDN, so the OPE-204 tail
 * that promotes a booth photo to a hero has to strip. Reading here is
 * in-memory and transient.
 */
import { events, eventDays, venues } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { and, eq, inArray, isNull, isNotNull, gte, lte } from "drizzle-orm";
import type { HandlerFn, HandlerEnv, HandlerResult } from "./types.js";
import { parsePlusSegment } from "../email-intents.js";
import { logError } from "../logger.js";
import { chunkedInArray } from "@takemetothefair/utils";
import { runBoothPipeline, type BoothPipelineResult } from "../photo/booth-pipeline.js";
import { parseExif, type ExifData } from "../photo/exif.js";
import {
  resolveOccurrence,
  expandEventDates,
  VENUE_RADIUS_MILES,
  type VenueCandidate,
  type EventCandidate,
  type Resolution,
} from "../photo/resolve-occurrence.js";

interface AttachmentRef {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Miles per degree of latitude — for the bounding-box pre-filter only. */
const MILES_PER_DEG_LAT = 69;

/**
 * Widest event span we'll consider when looking back for an occurrence that
 * contains the photo's date. Mirrors the 60-day cap in `expandEventDates`, so
 * the SQL floor can never exclude an event the resolver would have matched.
 */
const MAX_EVENT_SPAN_DAYS = 60;

function parseRefs(attachmentRefs: string | null): AttachmentRef[] {
  if (!attachmentRefs) return [];
  try {
    const refs = JSON.parse(attachmentRefs) as AttachmentRef[];
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

function imageRefs(refs: AttachmentRef[]): AttachmentRef[] {
  return refs.filter(
    (r) => typeof r?.mimeType === "string" && r.mimeType.toLowerCase().startsWith("image/")
  );
}

/** Count image attachments, falling back to the raw attachment_count when refs
 *  are absent/unparseable (capture is best-effort — see email-handler.ts). */
function countPhotos(attachmentRefs: string | null, attachmentCount: number): number {
  const refs = parseRefs(attachmentRefs);
  if (refs.length === 0) return attachmentCount;
  const images = imageRefs(refs).length;
  return images > 0 ? images : attachmentCount;
}

/**
 * Slug-shaped tokens in a subject line, e.g. "Booths at fryeburg-fair" →
 * ["fryeburg-fair"]. Deliberately strict (must contain a hyphen and be
 * otherwise slug-clean) so a normal English subject yields nothing and we fall
 * through to EXIF rather than fuzzy-matching prose to a fair.
 */
export function slugCandidatesFromSubject(subject: string | null): string[] {
  if (!subject) return [];
  const out = new Set<string>();
  for (const raw of subject.toLowerCase().split(/[^a-z0-9-]+/)) {
    const token = raw.replace(/^-+|-+$/g, "");
    if (token.includes("-") && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token)) out.add(token);
  }
  return [...out];
}

/** Read EXIF from the first image attachment that yields usable data.
 *  Photos in one email are from one outing, so the first fix represents the
 *  batch. Returns {} when the bucket is missing, refs are absent, or nothing
 *  parses — every one of which must hold rather than throw. */
async function readExif(env: HandlerEnv, refs: AttachmentRef[]): Promise<ExifData> {
  const bucket = env.VENDOR_ASSETS;
  if (!bucket) return {};
  for (const ref of imageRefs(refs)) {
    try {
      const obj = await bucket.get(ref.key);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      const exif = parseExif(new Uint8Array(buf));
      // Take the first attachment that gives us BOTH signals; a photo with
      // only one is not enough to pin an occurrence.
      if (exif.gps && exif.takenOnLocalDate) return exif;
    } catch {
      // A single unreadable attachment must not sink the batch.
      continue;
    }
  }
  return {};
}

/** Venues with a geocode inside a bounding box around the photo.
 *  Box first (indexable, cheap), exact haversine second (in the resolver). */
async function loadNearbyVenues(
  db: Db,
  gps: { latitude: number; longitude: number }
): Promise<VenueCandidate[]> {
  const dLat = VENUE_RADIUS_MILES / MILES_PER_DEG_LAT;
  // Longitude degrees shrink toward the poles. Clamp cos() so a near-polar
  // photo widens the box instead of dividing by ~0.
  const cos = Math.max(0.01, Math.cos((gps.latitude * Math.PI) / 180));
  const dLon = VENUE_RADIUS_MILES / (MILES_PER_DEG_LAT * cos);

  const rows = await db
    .select({
      id: venues.id,
      name: venues.name,
      latitude: venues.latitude,
      longitude: venues.longitude,
    })
    .from(venues)
    .where(
      and(
        isNotNull(venues.latitude),
        isNotNull(venues.longitude),
        gte(venues.latitude, gps.latitude - dLat),
        lte(venues.latitude, gps.latitude + dLat),
        gte(venues.longitude, gps.longitude - dLon),
        lte(venues.longitude, gps.longitude + dLon)
      )
    );

  return rows.flatMap((r) =>
    r.latitude === null || r.longitude === null
      ? []
      : [{ id: r.id, name: r.name, latitude: r.latitude, longitude: r.longitude }]
  );
}

/**
 * APPROVED, non-tombstone occurrences at the given venues that could contain
 * the photo's date.
 *
 * APPROVED-only on purpose: a fair John is standing at is live on the site. A
 * DRAFT/PENDING row is not something we want to silently attribute photos to —
 * that case holds and he names it, which is the safe direction.
 */
async function loadCandidateEvents(
  db: Db,
  venueIds: string[],
  localDate: string
): Promise<EventCandidate[]> {
  if (venueIds.length === 0) return [];
  const dayMs = Date.parse(`${localDate}T00:00:00Z`);
  if (Number.isNaN(dayMs)) return [];
  // An event containing this date must have started within the last
  // MAX_EVENT_SPAN_DAYS and not after it.
  const lo = new Date(dayMs - MAX_EVENT_SPAN_DAYS * 86_400_000);
  const hi = new Date(dayMs + 86_400_000);

  // OPE-241 — chunked: `venueIds` is bounded by GEOGRAPHY (a radius), not by a
  // query limit, so a dense metro can put 100+ venues in range and blow D1's
  // 100-bound-param cap. Note the ~5 extra bound params from the status/date
  // predicates below come out of the same 100 budget — that headroom is exactly
  // why the default chunk is 90 rather than 100.
  const rows = await chunkedInArray(venueIds, (batch) =>
    db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        venueId: events.venueId,
        startDate: events.startDate,
        endDate: events.endDate,
      })
      .from(events)
      .where(
        and(
          inArray(events.venueId, batch),
          eq(events.status, "APPROVED"),
          isNull(events.mergedInto),
          gte(events.startDate, lo),
          lte(events.startDate, hi)
        )
      )
  );

  if (rows.length === 0) return [];

  // event_days is authoritative (it encodes closures / vendor-only days);
  // events without per-day rows fall back to their start→end range.
  // OPE-241 — chunked for the same reason: one row per in-range event.
  const dayRows = await chunkedInArray(
    rows.map((r) => r.id),
    (batch) =>
      db
        .select({ eventId: eventDays.eventId, date: eventDays.date })
        .from(eventDays)
        .where(inArray(eventDays.eventId, batch))
  );
  const daysByEvent = new Map<string, string[]>();
  for (const d of dayRows) {
    const list = daysByEvent.get(d.eventId) ?? [];
    list.push(d.date);
    daysByEvent.set(d.eventId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    venueId: r.venueId,
    dates: expandEventDates(daysByEvent.get(r.id) ?? [], r.startDate ?? null, r.endDate ?? null),
  }));
}

/** Look up an explicitly-named event (plus-address or subject slug). */
async function findOverrideEvent(
  db: Db,
  slugs: string[]
): Promise<{ id: string; name: string; slug: string } | null> {
  if (slugs.length === 0) return null;
  const rows = await db
    .select({ id: events.id, name: events.name, slug: events.slug })
    .from(events)
    .where(and(inArray(events.slug, slugs as never), isNull(events.mergedInto)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve which fair a photo batch belongs to, doing the DB work.
 *
 * Exported (and taking `db` + an EXIF thunk rather than `env`) so the whole
 * resolution path — override lookup, venue radius query, occurrence matching —
 * is testable against a real SQLite without an R2 or D1 binding. The thunk is
 * lazy on purpose: an explicitly-named fair short-circuits before we ever spend
 * R2 reads pulling bytes.
 */
export async function resolvePhotoEvent(
  db: Db,
  overrideSlugs: string[],
  readExifFn: () => Promise<ExifData>
): Promise<{ resolution: Resolution; exif: ExifData }> {
  const overrideEvent = await findOverrideEvent(db, overrideSlugs);
  if (overrideEvent) {
    return {
      resolution: resolveOccurrence({ overrideEvent, venues: [], events: [] }),
      exif: {},
    };
  }

  const exif = await readExifFn();
  let venueCandidates: VenueCandidate[] = [];
  let eventCandidates: EventCandidate[] = [];
  if (exif.gps && exif.takenOnLocalDate) {
    venueCandidates = await loadNearbyVenues(db, exif.gps);
    eventCandidates = await loadCandidateEvents(
      db,
      venueCandidates.map((v) => v.id),
      exif.takenOnLocalDate
    );
  }

  return {
    resolution: resolveOccurrence({
      gps: exif.gps,
      takenOnLocalDate: exif.takenOnLocalDate,
      venues: venueCandidates,
      events: eventCandidates,
    }),
    exif,
  };
}

/** Operator-facing explanation for each hold reason — quoted in the reply. */
const HOLD_ASK: Record<string, string> = {
  "no-exif-gps":
    "the photos have no GPS data (iPhones send HEIC or strip location when Location Services is off for the Camera, and most mail apps downsize attachments)",
  "no-exif-date": "the photos have no capture timestamp",
  "no-venue-in-radius": "no venue we have geocoded is within range of where the photos were taken",
  "no-event-on-date": "we know the venue, but no approved fair was running there on that date",
  "ambiguous-multiple-events": "more than one approved fair was running at that venue that day",
};

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  const refs = parseRefs(row.attachmentRefs);
  const photoCount = countPhotos(row.attachmentRefs, row.attachmentCount);
  const eventHint = parsePlusSegment(row.toAddress);

  // Eligible for downstream auto-write ONLY when the message is authenticated
  // (SPF/DKIM/DMARC pass) AND from a trusted sender. Everything else is held for
  // human review — no eligibility for the OPE-204 vendor write, and no reason to
  // spend R2 reads resolving a fair we won't act on.
  const eligible = ctx.emailAuth === "pass" && ctx.senderTrust === "trusted";
  if (!eligible) {
    return {
      replyKind: "photo-intake-held",
      replyParams: {
        subject: row.subject ?? "",
        photoCount,
        eventHint: eventHint ?? null,
        authVerdict: ctx.emailAuth,
        trust: ctx.senderTrust,
      },
      status: "replied",
    };
  }

  const db = getDb(env.DB);

  // Explicit override — plus-address first, then a slug in the subject.
  const overrideSlugs = [
    ...(eventHint ? [eventHint] : []),
    ...slugCandidatesFromSubject(row.subject),
  ];

  const { resolution, exif } = await resolvePhotoEvent(db, overrideSlugs, () =>
    readExif(env, refs)
  );

  if (resolution.status === "resolved") {
    // OPE-204 Milestone A — identify the booths and STAGE them for review.
    // No vendor/event/hero writes here; gated OFF by default and fail-soft, so
    // a vision outage can never cost us the (already-correct) fair match.
    let booths: BoothPipelineResult | null = null;
    try {
      booths = await runBoothPipeline(env, db, row.id, resolution.eventId, imageRefs(refs));
    } catch (e) {
      await logError(env.DB, {
        message: "Booth pipeline failed (fair match unaffected)",
        error: e,
        source: "email-handlers/photo-intake.ts:runBoothPipeline",
      });
    }

    return {
      replyKind: "photo-intake-ack",
      replyParams: {
        subject: row.subject ?? "",
        photoCount,
        eventHint: eventHint ?? null,
        authVerdict: ctx.emailAuth,
        trust: ctx.senderTrust,
        resolvedEventName: resolution.eventName,
        resolvedEventSlug: resolution.eventSlug,
        matchMethod: resolution.method,
        matchedDate: resolution.matchedDate ?? null,
        venueName: resolution.venueName ?? null,
        distanceMiles: resolution.distanceMiles ?? null,
        boothsStaged: booths?.staged ?? 0,
        boothNames: booths?.identifiedNames ?? [],
        // OPE-204 Milestone B — auto-created/linked vendors, itemized for the
        // OPE-205 §1 reply (added vs already-linked vs couldn't-write).
        autoCreated: (booths?.autoWritten ?? []).filter((a) => a.wasCreated).length,
        autoLinked: (booths?.autoWritten ?? []).filter((a) => !a.wasCreated && !a.error).length,
        autoFailed: (booths?.autoWritten ?? []).filter((a) => Boolean(a.error)).length,
        autoWrittenNames: (booths?.autoWritten ?? [])
          .filter((a) => !a.error)
          .map((a) => a.businessName),
        // OPE-205 §3 — general fair scenery attached to the event's gallery.
        galleryAttached: booths?.galleryAttached ?? 0,
        galleryFailed: booths?.galleryFailed ?? 0,
      },
      // The downstream OPE-204 vendor pipeline reads this off the row.
      resultingEventId: resolution.eventId,
      status: "replied",
    };
  }

  // Held: name the reason and tell John exactly how to fix it. Never guess.
  return {
    replyKind: "photo-intake-unresolved",
    replyParams: {
      subject: row.subject ?? "",
      photoCount,
      eventHint: eventHint ?? null,
      holdReason: resolution.reason,
      holdAsk: HOLD_ASK[resolution.reason] ?? "we could not identify the fair",
      holdDetail: resolution.detail ?? null,
      sawGps: Boolean(exif.gps),
      sawDate: exif.takenOnLocalDate ?? null,
    },
    resultingEventId: null,
    status: "replied",
  };
};
