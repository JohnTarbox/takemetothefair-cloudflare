/**
 * K27 — auto-roll a recurring event into a next-occurrence TENTATIVE edition.
 *
 * When a recurring event (events.recurrence_rule = FREQ=YEARLY[;INTERVAL=n])
 * passes and transitions to lifecycle_status='OCCURRED', we spawn next year's
 * edition so the accumulated SEO equity + enrichment (image, description,
 * vendor fee, categories) carries forward instead of being re-discovered from
 * scratch. Called from TWO sites with identical behavior:
 *   - the daily OCCURRED auto-transition sweep (event-occurred-sweep.ts), and
 *   - the manual update_event_lifecycle tool, when an admin sets OCCURRED.
 *
 * Both pass only an eventId — this function owns the full-row fetch and the
 * "what gets inherited" decision, so a partial caller object can never produce
 * a hollow edition.
 *
 * Scope (see Dev-Brief-K27 + the approved plan):
 *   - Rolls FREQ=YEARLY only (covers annual INTERVAL=1 and biennial INTERVAL=2).
 *     WEEKLY/MONTHLY/DAILY are event_days-modeled ongoing series, not discrete
 *     editions — rolling them per-period would flood the DB. They are skipped.
 *   - Never rolls event_days-backed or discontinuous_dates events (same reason).
 *   - Idempotent: skips if a same-promoter, same-normalized-name edition already
 *     exists in the computed next year (catches prior auto-rolls, manual rolls,
 *     and the operator reconcile).
 *   - No children copied (event_vendors / event_days / citations): a future
 *     edition has no confirmed lineup or dates yet. The dates-pending-official
 *     tag + dates_confirmed=0 signal the skeleton.
 *   - No direct IndexNow ping (REL4 paused; a new TENTATIVE event is born public
 *     with no visibility-boundary crossing). The existing deferred mechanism
 *     handles indexing.
 */
import { eq, and, ne, gte, lt, isNull, sql } from "drizzle-orm";
import {
  createSlug,
  appendSlugSegment,
  normalizeName,
  computeNextOccurrence,
  parseRecurrenceRule,
  unsafeSlug,
  type Slug,
} from "@takemetothefair/utils";
import { events, eventDays, adminActions } from "./schema.js";
import { recomputeEventCompleteness } from "./helpers.js";
import type { Db } from "./db.js";

const PENDING_DATES_TAG = "dates-pending-official";

export interface RolloverOptions {
  /** How the rollover was triggered — recorded in the audit payload. */
  via: "cron" | "manual";
  /** Actor for the admin_actions row. `null` for cron-driven rollovers. */
  actorUserId: string | null;
  /**
   * Treat this instant as "now" for the rolled row's timestamps. Defaults to a
   * fresh Date(). Exposed mainly so tests are deterministic.
   */
  now?: Date;
}

export interface RolloverResult {
  created: boolean;
  newEventId?: string;
  newSlug?: string;
  /** Present when created=false — why no edition was produced. */
  skipReason?: string;
}

/** Merge a tag into a JSON-array tag string, de-duplicated. */
function addTag(tagsJson: string | null | undefined, tag: string): string {
  let arr: string[] = [];
  try {
    const parsed = JSON.parse(tagsJson ?? "[]");
    if (Array.isArray(parsed)) arr = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // malformed tags column → start fresh with just the new tag
  }
  if (!arr.includes(tag)) arr.push(tag);
  return JSON.stringify(arr);
}

/**
 * Roll `sourceEventId` forward by one cadence period if it is an eligible
 * recurring event. Returns `{ created:false, skipReason }` when a gate or the
 * idempotency check declines — those are normal outcomes, not errors. Throws
 * only on unexpected DB failures; callers run this best-effort.
 */
export async function rolloverEventIfRecurring(
  db: Db,
  sourceEventId: string,
  opts: RolloverOptions
): Promise<RolloverResult> {
  const now = opts.now ?? new Date();

  const [source] = await db.select().from(events).where(eq(events.id, sourceEventId)).limit(1);
  if (!source) return { created: false, skipReason: "source-not-found" };

  // --- Eligibility gates ----------------------------------------------------
  const parsed = parseRecurrenceRule(source.recurrenceRule);
  if (!parsed) return { created: false, skipReason: "no-recurrence-rule" };
  if (parsed.freq !== "YEARLY") return { created: false, skipReason: "unsupported-cadence" };
  if (source.discontinuousDates) return { created: false, skipReason: "discontinuous-dates" };
  if (!source.startDate || !source.endDate) return { created: false, skipReason: "missing-dates" };

  const [{ count: dayCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventDays)
    .where(eq(eventDays.eventId, sourceEventId));
  if (dayCount > 0) return { created: false, skipReason: "event-days-backed" };

  const next = computeNextOccurrence(source.startDate, source.endDate, source.recurrenceRule);
  if (!next) return { created: false, skipReason: "cannot-compute-next" };

  // --- Idempotency: skip if a next-year edition already exists ---------------
  // Year-bucketed match on (promoter, normalized name). Annual fairs drift a
  // few days year-to-year, so a fixed day window would false-negative; the
  // calendar-year bucket is the right unit for a YEARLY cadence.
  const nextYear = next.start.getUTCFullYear();
  const yearStart = new Date(Date.UTC(nextYear, 0, 1));
  const yearEnd = new Date(Date.UTC(nextYear + 1, 0, 1));
  const normalizedSourceName = normalizeName(source.name);

  const candidates = await db
    .select({ id: events.id, name: events.name })
    .from(events)
    .where(
      and(
        eq(events.promoterId, source.promoterId),
        gte(events.startDate, yearStart),
        lt(events.startDate, yearEnd),
        isNull(events.mergedInto),
        ne(events.id, sourceEventId)
      )
    );
  const existing = candidates.find((c) => normalizeName(c.name) === normalizedSourceName);
  if (existing) return { created: false, skipReason: "edition-exists" };

  // --- Derive the new edition's name + slug ---------------------------------
  // Swap a standalone source-year token (e.g. "Fryeburg Fair 2026") for the
  // next year. When the name carries no year, keep it as-is and append the
  // computed year to the slug so the slug stays year-meaningful (not "-2").
  const sourceYear = source.startDate.getUTCFullYear();
  const yearTokenRe = new RegExp(`\\b${sourceYear}\\b`);
  const nameHasYear = yearTokenRe.test(source.name);
  const newName = nameHasYear
    ? source.name.replace(new RegExp(`\\b${sourceYear}\\b`, "g"), String(nextYear))
    : source.name;
  const baseSlug: Slug = nameHasYear
    ? createSlug(newName)
    : appendSlugSegment(createSlug(source.name), nextYear);

  let finalSlug: Slug = baseSlug;
  let suffix = 0;
  // Resolve slug collisions against the unique events.slug constraint.
  for (;;) {
    const candidate: Slug = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
    const [clash] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, unsafeSlug(candidate)))
      .limit(1);
    if (!clash) {
      finalSlug = candidate;
      break;
    }
    suffix++;
  }

  // --- Insert the rolled edition + audit row, atomically --------------------
  const newEventId = crypto.randomUUID();
  const insertEvent = db.insert(events).values({
    id: newEventId,
    // EH3 P3.5 — series-aware rollover. The rolled edition inherits the source's
    // series_id, so it's a real series occurrence (not a disconnected shadow
    // sibling) by construction. NULL until the P1 backfill links the source, so
    // this is inert today. NOTE: implemented in-place rather than routing through
    // the create_occurrence HTTP route (John's selected mechanism) because that
    // route inherits only thin series defaults and would drop K27's rich
    // source-event inheritance (ticket/vendor-fee/application/attendance/scale).
    // This achieves the chosen goal — series-linked editions, automation kept —
    // with zero inheritance regression. Revisit if a single create-path is wanted.
    seriesId: source.seriesId,
    name: newName,
    slug: finalSlug,
    description: source.description,
    promoterId: source.promoterId,
    venueId: source.venueId,
    stateCode: source.stateCode,
    isStatewide: source.isStatewide,
    startDate: next.start,
    endDate: next.end,
    datesConfirmed: false,
    recurrenceRule: source.recurrenceRule,
    categories: source.categories,
    tags: addTag(source.tags, PENDING_DATES_TAG),
    ticketUrl: source.ticketUrl,
    ticketPriceMinCents: source.ticketPriceMinCents,
    ticketPriceMaxCents: source.ticketPriceMaxCents,
    imageUrl: source.imageUrl,
    imageFocalX: source.imageFocalX,
    imageFocalY: source.imageFocalY,
    // featured is an editorial promotion — never inherit it onto a skeleton.
    featured: false,
    commercialVendorsAllowed: source.commercialVendorsAllowed,
    status: "TENTATIVE",
    // Provenance: this edition was machine-generated, not externally sourced.
    sourceName: source.sourceName,
    sourceDomain: source.sourceDomain,
    ingestionMethod: "auto_rollover",
    sourceUrl: source.sourceUrl,
    sourceId: newEventId,
    syncEnabled: false,
    vendorFeeMinCents: source.vendorFeeMinCents,
    vendorFeeMaxCents: source.vendorFeeMaxCents,
    vendorFeeNotes: source.vendorFeeNotes,
    indoorOutdoor: source.indoorOutdoor,
    estimatedAttendance: source.estimatedAttendance,
    eventScale: source.eventScale,
    // applicationDeadline is the PAST edition's deadline — drop it. The portal
    // URL/instructions usually carry over, so those are inherited.
    applicationDeadline: null,
    applicationUrl: source.applicationUrl,
    applicationInstructions: source.applicationInstructions,
    walkInsAllowed: source.walkInsAllowed,
    primaryAudience: source.primaryAudience,
    publicAccess: source.publicAccess,
    accessNotes: source.accessNotes,
    registrationRequired: source.registrationRequired,
    lifecycleStatus: "TENTATIVE",
    lifecycleStatusChangedAt: now,
    lifecycleReason: `auto-rollover from ${source.slug}`,
    rolledFromEventId: sourceEventId,
    // Surface in the /admin/events?flagged=1 reconcile queue: an operator (or a
    // scheduled reconcile) must confirm the predicted dates and flip to APPROVED.
    flaggedForReview: 1,
    completenessScore: 0,
    createdAt: now,
    updatedAt: now,
  });

  const insertAudit = db.insert(adminActions).values({
    action: "event.auto_rollover",
    actorUserId: opts.actorUserId,
    targetType: "event",
    targetId: newEventId,
    payloadJson: JSON.stringify({
      sourceEventId,
      sourceSlug: source.slug,
      newSlug: finalSlug,
      recurrenceRule: source.recurrenceRule,
      nextStart: next.start.toISOString(),
      nextEnd: next.end.toISOString(),
      via: opts.via,
    }),
    createdAt: now,
  });

  await db.batch([insertEvent, insertAudit]);

  // Recompute AFTER the row exists — the scorer reads it back by id. A
  // date-predicted skeleton is objectively less complete than its parent, so
  // we never inherit the parent's score.
  await recomputeEventCompleteness(db, newEventId);

  return { created: true, newEventId, newSlug: finalSlug };
}
