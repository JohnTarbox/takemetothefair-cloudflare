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
import { events, eventDays, venues, inboundEmails } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { and, eq, inArray, isNull, isNotNull, gte, lte, sql } from "drizzle-orm";
import type { HandlerFn, HandlerEnv, HandlerResult } from "./types.js";
import { parsePlusSegment } from "../email-intents.js";
import { logError } from "../logger.js";
import { chunkedInArray, createSlug } from "@takemetothefair/utils";
import { runBoothPipeline, type BoothPipelineResult } from "../photo/booth-pipeline.js";
import { classifyPosterText, type PosterClassification } from "../photo/poster-classify.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import { submitCheckDuplicate, submitEvent, submitExtract } from "./submit.js";
import { parseExif, type ExifData } from "../photo/exif.js";
import {
  resolveOccurrence,
  expandEventDates,
  VENUE_RADIUS_MILES,
  type VenueCandidate,
  type EventCandidate,
  type Resolution,
} from "../photo/resolve-occurrence.js";

export interface AttachmentRef {
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

export function parseRefs(attachmentRefs: string | null): AttachmentRef[] {
  if (!attachmentRefs) return [];
  try {
    const refs = JSON.parse(attachmentRefs) as AttachmentRef[];
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

export function imageRefs(refs: AttachmentRef[]): AttachmentRef[] {
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
 * otherwise slug-clean). A normal English subject yields nothing HERE — the
 * fair NAME buried in prose is picked up separately by `findEventBySubjectName`
 * (OPE-254), which matches an event's own slug intact against the slugified
 * subject rather than fuzzy-matching arbitrary prose.
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

/**
 * OPE-254 — pull an event slug out of a pasted `/events/<slug>` URL in the
 * subject. John's documented way to correct a hold is to reply with the fair's
 * page URL; that URL must resolve exactly, not fall through to EXIF. Returns the
 * slug(s) found (usually 0 or 1) for the exact `findOverrideEvent` lookup.
 */
export function eventSlugsFromSubjectUrl(subject: string | null): string[] {
  if (!subject) return [];
  const out = new Set<string>();
  // `/events/<slug>` anywhere in the subject; slug is our canonical charset.
  for (const m of subject.matchAll(/\/events\/([a-z0-9][a-z0-9-]*)/gi)) {
    out.add(m[1].toLowerCase().replace(/-+$/g, ""));
  }
  return [...out];
}

/** Shortest slug we will accept as a NAME match. Single-word slugs ("fair",
 *  "expo") are far too broad to attribute photos on, so a name match must be a
 *  multi-word slug (has a hyphen) of at least this length. */
const MIN_NAME_SLUG_LEN = 8;

/** Trailing edition year on a stored slug: `phillips-old-home-days-2026`. */
const SLUG_YEAR_SUFFIX = /-(?:19|20)\d{2}$/;

/**
 * OPE-254 — the stored slug minus its edition year.
 *
 * 930 of our 1,463 approved events (64%) carry a `-YYYY` suffix, and nobody
 * replying "this photo is from Phillips Old Home Days" types the year. Matching
 * on the base is what makes a human's own words reach the row.
 *
 * Safe because the base is a PREFIX of the full slug: anything the full-slug
 * test would have matched, the base test matches too, so this only ever widens.
 */
export function slugWithoutYear(slug: string): string {
  return slug.replace(SLUG_YEAR_SUFFIX, "");
}

/** The year a subject explicitly names, if it names one. */
export function explicitYearIn(subjectSlug: string): string | null {
  const m = subjectSlug.match(/(?:^|-)((?:19|20)\d{2})(?:-|$)/);
  return m ? m[1] : null;
}

/**
 * OPE-254 — resolve the fair when its NAME (not a bare slug token) appears in
 * the subject, e.g. "Photos from the Waterford World's Fair" → the event whose
 * slug is `waterford-worlds-fair`.
 *
 * Safe-by-construction rather than fuzzy: we slugify the WHOLE subject and keep
 * only APPROVED, non-tombstone events whose OWN slug appears intact as a
 * substring of that subject-slug. Because `createSlug` normalises
 * punctuation/apostrophes/`&` identically on both sides, "World's" in the
 * subject and the stored `worlds` slug line up. The length + hyphen guard blocks
 * one-word slugs from matching prose.
 *
 * ── Why `instr()` and NOT `LIKE '%'||slug||'%'` (OPE-404) ───────────────────
 * The LIKE form threw `SQLITE_ERROR: LIKE or GLOB pattern too complex` and
 * killed the whole email — `status='failed'`, photo lost.
 *
 * The trap is which side is the PATTERN. `subjectSlug LIKE '%'||slug||'%'` makes
 * the pattern out of the **event slug column**, evaluated per row, so the email
 * had nothing to do with it. Measured on prod 2026-08-16: D1 caps a LIKE pattern
 * at **50 characters** (50 passes, 52 throws), and **114 of 1426 approved events
 * have a slug longer than 48**. Any full scan therefore hit one and threw —
 * deterministically, not intermittently.
 *
 * The subject only decided whether the query ran at all: the `< MIN_NAME_SLUG_LEN`
 * bail above meant short subjects ("PMI", "MV", null) returned before the query
 * and survived. So this matcher had **never once succeeded in production** — which
 * is the "naming the fair doesn't fire" symptom reported on OPE-254.
 *
 * `instr(subjectSlug, slug) > 0` is exactly equivalent here (slug is `[a-z0-9-]`,
 * so it carries no LIKE wildcards to honour) and has no pattern-length limit.
 * Do NOT "restore" the LIKE form, and do not fix this by capping slug length —
 * that would silently make long-slug events unmatchable instead of erroring.
 *
 * Ambiguity HOLDS (returns null): if the subject spells out two INDEPENDENT
 * fair names (neither slug a substring of the other, e.g. "Fryeburg Fair and
 * Skowhegan Fair"), we can't tell which and must ask — the same safe direction
 * as no-GPS. A more-specific name that happens to contain a shorter one is not
 * ambiguity: only the maximal (most specific) slug is kept.
 */
export async function findEventBySubjectName(
  db: Db,
  subject: string | null
): Promise<{ id: string; name: string; slug: string } | null> {
  if (!subject || !subject.trim()) return null;
  const subjectSlug = createSlug(subject);
  // createSlug of a subject with no slug-able characters is empty.
  if (subjectSlug.length < MIN_NAME_SLUG_LEN) return null;

  // The stored slug minus any `-YYYY` edition suffix. Computed in SQL so the
  // comparison stays a single indexed-ish scan rather than pulling 1,463 rows.
  const baseSlug = sql`CASE WHEN ${events.slug} GLOB '*-[12][0-9][0-9][0-9]'
      THEN substr(${events.slug}, 1, length(${events.slug}) - 5)
      ELSE ${events.slug} END`;

  const rows = await db
    .select({ id: events.id, name: events.name, slug: events.slug })
    .from(events)
    .where(
      and(
        eq(events.status, "APPROVED"),
        isNull(events.mergedInto),
        // Guards apply to the BASE, which is what we actually match on — a slug
        // that only clears the bar because of its year suffix has not really
        // cleared it.
        sql`length(${baseSlug}) >= ${MIN_NAME_SLUG_LEN}`,
        sql`${baseSlug} LIKE '%-%'`,
        // The event's name (year suffix stripped) must appear intact inside the
        // slugified subject.
        //
        // instr(), not LIKE — see the OPE-404 note in this function's docblock.
        // The LIKE form built its PATTERN from this column and blew D1's 50-char
        // pattern limit on the 114 approved events with slugs over 48 chars.
        //
        // Matching the base rather than the full slug is OPE-254: 64% of
        // approved events carry `-YYYY`, and a person naming the fair in a reply
        // does not type it. The base is a prefix of the full slug, so this can
        // only ever widen what matched before, never narrow it.
        sql`instr(${subjectSlug}, ${baseSlug}) > 0`
      )
    );

  if (rows.length === 0) return null;

  // If the subject names a year, it must be the edition's year. Without this,
  // "Phillips Old Home Days 2025" would resolve onto the 2026 row purely because
  // the base matched — attaching a photo to the wrong edition, which for a photo
  // is a wrong answer rather than a near miss. A subject with no year stays
  // eligible for every edition and is disambiguated below.
  const wantedYear = explicitYearIn(subjectSlug);
  const yearOk = wantedYear
    ? rows.filter((r) => {
        const m = r.slug.match(SLUG_YEAR_SUFFIX);
        return !m || m[0].slice(1) === wantedYear;
      })
    : rows;
  if (yearOk.length === 0) return null;

  // Keep only maximal matches: drop any name that is a substring of another
  // matched name (the shorter, redundant spelling of the same fair).
  //
  // Compared on the year-stripped base, deliberately. `fryeburg-fair-2026` is
  // NOT a substring of `fryeburg-fair-antique-show-2026` — the year sits in the
  // middle — so comparing raw slugs would call a plain containment ambiguous and
  // hold on a subject we can read perfectly well.
  const withBase = yearOk.map((r) => ({ ...r, base: slugWithoutYear(r.slug) }));
  const maximal = withBase.filter(
    (r) => !withBase.some((o) => o.base !== r.base && o.base.includes(r.base))
  );

  // Exactly one independent fair name in the subject → resolve.
  //
  // Two or more → hold and ask. That covers both genuine ambiguity ("Fryeburg
  // Fair and Skowhegan Fair") and the same fair's multiple editions, which after
  // year-stripping share a base and cannot be told apart from the name alone.
  // Measured on prod: only 19 of 1,443 base names (1.3%) have more than one
  // edition, so holding there costs little and guessing an edition would put a
  // photo on the wrong year's page.
  if (maximal.length !== 1) return null;
  const { base: _base, ...winner } = maximal[0];
  return winner;
}

/** Read EXIF from the first image attachment that yields usable data.
 *  Photos in one email are from one outing, so the first fix represents the
 *  batch. Returns {} when the bucket is missing, refs are absent, or nothing
 *  parses — every one of which must hold rather than throw. */
/**
 * OPE-469 — exported so a replay can run the identical EXIF read the live
 * handler runs, rather than a lookalike that could drift from it.
 */
export async function readExif(env: HandlerEnv, refs: AttachmentRef[]): Promise<ExifData> {
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
export async function findOverrideEvent(
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
  readExifFn: () => Promise<ExifData>,
  subject: string | null = null
): Promise<{ resolution: Resolution; exif: ExifData }> {
  // OPE-404 item 2 — a LOOKUP failure must hold the photo, never kill the email.
  //
  // The LIKE-pattern defect (fixed in PR #863) did not merely fail to match: it
  // threw, the throw became `caughtError` in the workflow, and the row landed on
  // `status='failed'` with no recovery path. `401adb3c` ("Belgrade Lakes") is
  // still sitting there — the cause was fixed on 2026-08-16 and the row has not
  // moved since 08-10, because nothing replays a failed photo.
  //
  // The specific bug is gone. This is the class guard: an identification
  // question that cannot be answered has a correct answer already — HOLD and
  // ask — and reaching it must not depend on every future lookup being
  // exception-free. Holding costs a reply; throwing costs the photo.
  //
  // Deliberately narrow: only the two identification lookups are wrapped. The
  // EXIF read below is already hold-on-failure by contract, and wrapping the
  // whole function would swallow genuine infrastructure errors that SHOULD
  // surface (a missing DB binding is not a photo we can hold).
  const identify = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      // Loud, not silent: a fail-soft reason nobody reads is how the original
      // matcher went unnoticed for months.
      console.error(`[photo-intake] ${what} lookup failed; holding photo`, err);
      return null;
    }
  };

  const overrideEvent = await identify("override-slug", () => findOverrideEvent(db, overrideSlugs));
  if (overrideEvent) {
    return {
      resolution: resolveOccurrence({ overrideEvent, venues: [], events: [] }),
      exif: {},
    };
  }

  // OPE-254 — the fair NAMED in the subject (in prose, not as a bare slug)
  // still beats EXIF/no-GPS-hold: John naming the fair is the documented
  // override, and a subject that spells out the fair name IS naming it.
  const namedEvent = await identify("subject-name", () => findEventBySubjectName(db, subject));
  if (namedEvent) {
    return {
      resolution: resolveOccurrence({ overrideEvent: namedEvent, venues: [], events: [] }),
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

/**
 * OPE-325 — OCR the first image and decide whether this is a POSTER.
 *
 * Runs only on the hold path (we could not identify a fair), so a normal
 * "photos from the Cheshire Fair" email never pays for it. Reuses OPE-297's
 * extract-image endpoint over the MAIN_APP service binding rather than a
 * second vision model — one OCR pass, and the same code path the wizard uses.
 *
 * Every verdict is logged with its reason so classification precision is
 * computable at a retro (OPE-204's rule: no public writes from an unmeasured
 * classifier — and this one makes no writes at all, it only changes the reply).
 *
 * Fail-soft in every direction: no bucket, no binding, an OCR error, an empty
 * read — all return null, and the caller falls through to the existing
 * which-fair flow. The worst case is the behaviour we have today.
 */
async function classifyAsPoster(
  env: HandlerEnv,
  refs: AttachmentRef[],
  messageRowId: string
): Promise<{ classification: PosterClassification; text: string } | null> {
  const bucket = env.VENDOR_ASSETS;
  const images = imageRefs(refs);
  if (!bucket || images.length === 0) return null;

  try {
    const obj = await bucket.get(images[0].key);
    if (!obj) return null;
    const bytes = await obj.arrayBuffer();

    const form = new FormData();
    form.append("images", new Blob([bytes]), images[0].name || "poster.jpg");
    const res = await mainAppFetch(
      env as unknown as MainAppEnv,
      "/api/admin/import-url/extract-image",
      "workflow",
      { method: "POST", body: form }
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { content?: string };
    const text = data.content ?? "";

    const classification = classifyPosterText(text);
    await logError(env.DB, {
      level: "info",
      source: "mcp:photo-intake:poster-classify",
      message: `poster classification: ${classification.verdict} — ${classification.reason}`,
      context: {
        messageRowId,
        verdict: classification.verdict,
        chars: classification.chars,
        hasDate: classification.hasDate,
      },
    });
    return { classification, text };
  } catch (err) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:photo-intake:poster-classify",
      message: "poster classification failed; falling back to which-fair",
      error: err,
      context: { messageRowId },
    });
    return null;
  }
}

/**
 * OPE-325 — stage a classified poster as a PENDING event.
 *
 * Runs the SUBMIT lane's chain, not a bespoke insert:
 *
 *   submitExtract       OCR text -> structured event (the same extractor the
 *                       URL and pasted-prose paths use)
 *   submitCheckDuplicate venue/city + date dedup, venue resolved server-side —
 *                       the guard that caught the Winthrop duplicate
 *   submitEvent         creates the event as PENDING
 *
 * Going through this chain rather than around it is the point. A naked insert
 * from the photo lane would skip dedup and venue resolution, which is exactly
 * how duplicate rows got in before. Here a poster for an event we already know
 * about resolves to the existing row instead of creating a second one.
 *
 * PENDING, never APPROVED: OPE-204's "no public writes from an unmeasured
 * classifier" holds because PENDING is not public. A wrong classification costs
 * an operator one rejection in /admin/events, not a bad public listing.
 *
 * Fail-soft: any step failing returns an outcome the reply can explain, rather
 * than throwing away an email we already told the sender we received.
 */
async function stagePosterAsPendingEvent(
  env: HandlerEnv,
  ocrText: string,
  row: { id: string; fromAddress: string; subject: string | null }
): Promise<{
  outcome: "created" | "duplicate" | "failed";
  eventId: string | null;
  eventName: string | null;
  detail?: string;
}> {
  try {
    // No source URL — a poster has no page. submitExtract tolerates this; the
    // submit schema only validates sourceUrl when present.
    // Empty url + the free-text-shaped fetch result: this is the same shape
    // the B2 pasted-prose path uses, where there is no page to have fetched.
    const extracted = await submitExtract(
      env,
      {
        url: "",
        content: ocrText,
        title: null,
        description: null,
        ogImage: null,
        jsonLdSerialized: null,
        fetchMethod: "standard",
      },
      ""
    );
    if (!extracted.event?.name) {
      return {
        outcome: "failed",
        eventId: null,
        eventName: null,
        detail: "could not read an event out of the poster",
      };
    }

    const dup = await submitCheckDuplicate(env, extracted);
    if (dup.isDuplicate && dup.existingEventId) {
      return {
        outcome: "duplicate",
        eventId: dup.existingEventId,
        eventName: dup.existingEventName ?? extracted.event.name,
        detail: dup.matchType,
      };
    }

    const created = await submitEvent(env, extracted, row.fromAddress);
    await logError(env.DB, {
      level: "info",
      source: "mcp:photo-intake:poster-staged",
      message: `poster staged as PENDING event ${created.slug}`,
      context: { messageRowId: row.id, eventId: created.id, eventName: created.eventName },
    });
    return {
      outcome: "created",
      eventId: created.id,
      eventName: created.eventName,
    };
  } catch (err) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:photo-intake:poster-staged",
      message: "poster staging failed; sender still gets a reply",
      error: err,
      context: { messageRowId: row.id },
    });
    return {
      outcome: "failed",
      eventId: null,
      eventName: null,
      detail: "staging error",
    };
  }
}

/**
 * OPE-403 — what the attach path actually DID with the sender's photos.
 *
 * The bug this exists to make impossible: `runBoothPipeline` returns a
 * `disabledReason` when it declines to run (`PHOTO_VISION_ENABLED != "true"`,
 * or a missing AI/R2 binding), the caller never read it, and the ack went out
 * naming the fair as though the photos had landed. Both facts were already in
 * memory at the call site; neither reached the sender.
 *
 * Pure and exported so the "we stored nothing and here is why" branch is
 * testable without an R2 binding, a vision model, or a live email.
 *
 * `blockedReason` is non-null ONLY when the sender attached images and none of
 * them reached `event_photos`. It is the single predicate the reply, the
 * review flag, and the reconciliation sweep all key off, so they can never
 * disagree about whether this email is finished.
 */
export interface PhotoStorageOutcome {
  /** Image attachments the sender actually sent. */
  offered: number;
  /** Rows written to `event_photos` for this email. Gallery only. */
  stored: number;
  /**
   * Photos that reached SOME durable, drainable destination: a gallery row, a
   * staged booth proposal, or an auto-written vendor link.
   *
   * This, not `stored`, is the alarm predicate — see below.
   */
  accountedFor: number;
  /** Why NOTHING happened to the photos; null when something did. */
  blockedReason: string | null;
}

/**
 * ⚠️ Corrected 2026-08-16, after the first live photo. The original version
 * keyed the alarm on `stored === 0`, i.e. "did a gallery row appear".
 *
 * That is the wrong fact. Only the classifier's **"general fair scene"** bucket
 * goes to the gallery; a photo identified as a BOOTH is routed to
 * `admin_actions` for review and correctly produces zero gallery rows. So a
 * confidently-identified booth — the happy path — would have raised a P0
 * saying "stored 0 photos" while the system did exactly the right thing.
 *
 * That is the same mistake this ticket exists to fix, committed while fixing
 * it: reasoning about a proxy (`gallery rows`) instead of the fact anyone cares
 * about (`did the photo end up anywhere a human can act on`). Recorded rather
 * than quietly patched, because the shape of the error is the lesson.
 *
 * The real harm is a photo that lands NOWHERE. That is what `accountedFor`
 * measures, and it is what the reply, the review flag, and the reconciliation
 * sweep now all key off, so they cannot disagree.
 */
export function describePhotoStorage(
  offered: number,
  booths: BoothPipelineResult | null
): PhotoStorageOutcome {
  const stored = booths?.galleryAttached ?? 0;
  const staged = booths?.staged ?? 0;
  const autoWritten = (booths?.autoWritten ?? []).filter((a) => !a.error).length;
  const accountedFor = stored + staged + autoWritten;

  // No images on the mail, or the photos went somewhere: nothing to explain.
  if (offered === 0 || accountedFor > 0) {
    return { offered, stored, accountedFor, blockedReason: null };
  }

  // Photos arrived and landed nowhere. Every branch names a cause — "we do not
  // know" is itself a reportable answer, and is never silence.
  const visionFailures = booths?.visionFailures ?? [];
  const blockedReason =
    booths === null
      ? "the photo pipeline errored before it could attach anything"
      : (booths.disabledReason ??
        (visionFailures.length > 0
          ? `vision produced nothing usable — ${visionFailures[0]}`
          : booths.galleryFailed > 0
            ? `${booths.galleryFailed} photo upload${booths.galleryFailed === 1 ? "" : "s"} failed`
            : "the attach path ran, stored nothing, and reported no reason"));

  return { offered, stored, accountedFor, blockedReason };
}

const HOLD_ASK: Record<string, string> = {
  "no-exif-gps":
    "the photos have no GPS data (iPhones send HEIC or strip location when Location Services is off for the Camera, and most mail apps downsize attachments)",
  "no-exif-date": "the photos have no capture timestamp",
  "no-venue-in-radius": "no venue we have geocoded is within range of where the photos were taken",
  "no-event-on-date": "we know the venue, but no approved fair was running there on that date",
  "ambiguous-multiple-events": "more than one approved fair was running at that venue that day",
  // OPE-404 — deliberately does NOT blame the photo. The sender did nothing
  // wrong; our lookup faulted. Telling them their photo lacked GPS would send
  // them to re-shoot it, which fixes nothing.
  "resolver-error":
    "something went wrong on our side while looking up the fair — your photos are safe and held",
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

  // Explicit override — plus-address first, then a slug or pasted /events/<slug>
  // URL in the subject. The fair NAMED in prose is handled inside
  // resolvePhotoEvent (findEventBySubjectName), which needs the raw subject.
  const overrideSlugs = [
    ...(eventHint ? [eventHint] : []),
    ...slugCandidatesFromSubject(row.subject),
    ...eventSlugsFromSubjectUrl(row.subject),
  ];

  // OPE-404 — resolution must never kill the email.
  //
  // A `SQLITE_ERROR` from the subject matcher propagated out of the handler and
  // the workflow marked the row `status='failed'` with no recovery path. Two
  // photos died that way (Belgrade Lakes 2026-08-10 was still lost five days
  // later). Identifying the fair is a BEST-EFFORT step: not knowing which fair a
  // photo belongs to is the ordinary hold case we already handle well, so any
  // failure here degrades to that instead of destroying the email.
  //
  // Deliberately catching broadly. The specific bug is fixed above, but the
  // point of this guard is the class — a photo we have in hand must not be lost
  // to any future query fault in a step whose whole job is a lookup.
  let resolution: Resolution;
  let exif: ExifData;
  try {
    ({ resolution, exif } = await resolvePhotoEvent(
      db,
      overrideSlugs,
      () => readExif(env, refs),
      row.subject
    ));
  } catch (e) {
    await logError(env.DB, {
      level: "error",
      source: "mcp:photo-intake:resolve-failed",
      message: "fair resolution threw; holding the photo instead of failing the email",
      error: e,
      context: { messageRowId: row.id, subject: row.subject },
    });
    resolution = {
      status: "held",
      reason: "resolver-error",
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    };
    exif = {};
  }

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

    // OPE-403 — record what actually reached `event_photos`, and make the row
    // drainable when the answer is "nothing".
    //
    // `resultingEventId` below says which fair we DECIDED these are from. It was
    // being read — by the ack, and by resolve-held-photos' idempotency guard —
    // as "the photos are on the site". On 2026-08-15 those two facts disagreed
    // for five emails and nothing in the system noticed. They are now recorded
    // separately, so nothing downstream has to infer one from the other.
    const storage = describePhotoStorage(imageRefs(refs).length, booths);
    if (storage.offered > 0) {
      // Written whenever the attach path was REACHED, success or not. The 0 is
      // the point: NULL means "never tried", 0 means "tried and stored nothing",
      // and only the second is a defect the sweep should surface.
      await db
        .update(inboundEmails)
        .set({
          photosStored: storage.stored,
          // Nothing landed → this email is not finished, whatever the ack says.
          // Same marker the booth staging path uses, so it surfaces in the
          // existing /admin/inbound-emails review queue rather than a new one.
          ...(storage.blockedReason ? { flaggedForReview: 1 } : {}),
        })
        .where(eq(inboundEmails.id, row.id));

      if (storage.blockedReason) {
        await logError(env.DB, {
          level: "warn",
          source: "mcp:photo-intake:photos-unstored",
          message: `photo intake matched a fair but ${storage.offered} photo(s) landed nowhere: ${storage.blockedReason}`,
          context: {
            messageRowId: row.id,
            eventId: resolution.eventId,
            offered: storage.offered,
            reason: storage.blockedReason,
          },
        });
      }

      // Logged even when the photos WERE accounted for. A vision failure that
      // still stages is not a lost photo — but it is a degraded classifier, and
      // it is invisible in the row itself (a staged proposal looks the same
      // whether the model identified a booth or gave up). Separate source from
      // the unstored warn above so the two can be counted independently.
      const visionFailures = booths?.visionFailures ?? [];
      if (visionFailures.length > 0) {
        await logError(env.DB, {
          level: "warn",
          source: "mcp:photo-intake:vision-failed",
          message: `vision produced nothing usable for ${visionFailures.length} of ${storage.offered} photo(s)`,
          context: {
            messageRowId: row.id,
            eventId: resolution.eventId,
            failures: visionFailures.slice(0, 5),
            accountedFor: storage.accountedFor,
          },
        });
      }
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
        // OPE-403 — the ack MUST state the storage outcome. Passing the reason
        // (not just the count) is what stops the reply from implying a
        // publication that did not happen.
        photosStored: storage.stored,
        photosStorageBlocked: storage.blockedReason,
      },
      // The downstream OPE-204 vendor pipeline reads this off the row.
      resultingEventId: resolution.eventId,
      status: "replied",
    };
  }

  // OPE-325 — before holding, ask whether this is a poster ANNOUNCING an event
  // rather than a photo FROM one. The Maynard case: the lane asked "which
  // fair?" about a flyer for a fair that did not exist yet, so the happy path
  // could not complete and a human extracted it by hand.
  //
  // John's ruling 2026-08-04: auto-create the PENDING event.
  //
  // My concern was that the photo lane has no dedup or venue-resolution path,
  // so creating events here would bypass the guards the submit lane enforces.
  // That is answered by ROUTING THROUGH those guards rather than around them:
  // submitExtract -> submitCheckDuplicate -> submitEvent is the exact chain an
  // emailed URL submission takes. The poster gets the same dedup (venue/city +
  // date, not just name-Levenshtein) and the same venue resolution, and lands
  // as PENDING — reviewed in /admin/events like every other submission.
  //
  // PENDING is the whole point: OPE-204's "no public writes from an unmeasured
  // classifier" holds, because PENDING is not public. Nothing this classifier
  // decides reaches a visitor without a human approving it.
  const poster = await classifyAsPoster(env, refs, row.id);
  if (poster && poster.classification.verdict === "POSTER") {
    const staged = await stagePosterAsPendingEvent(env, poster.text, row);
    return {
      replyKind: "photo-intake-poster",
      replyParams: {
        subject: row.subject ?? "",
        photoCount,
        posterHeadline: staged.eventName ?? "an event",
        posterExcerpt: poster.text.replace(/\s+/g, " ").trim().slice(0, 400),
        classifyReason: poster.classification.reason,
        staged: staged.outcome,
        stagedDetail: staged.detail ?? "",
      },
      // Links the inbound row to whatever it produced — a new PENDING event or
      // the existing one it deduped against — so /admin/inbound-emails can show
      // "resulted in" without a name+date JOIN.
      resultingEventId: staged.eventId,
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
