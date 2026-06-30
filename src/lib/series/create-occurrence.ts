/**
 * EH3 P3.1 — DB-aware create_occurrence core, extracted from the
 * `/api/admin/occurrences/create` route (K34, 2026-06-26) so the discovery /
 * community-suggestion ingest path can attach a matched edition as an occurrence
 * in-process, without a self-fetch. The route, the `create_occurrence` MCP tool,
 * and the K27 rollover all funnel through here. Pure field-inheritance stays in
 * create-occurrence-core.ts; this module owns the lookup + idempotency + insert.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, eventSeries, eventDays, adminActions } from "@/lib/db/schema";
import { createSlug, appendSlugSegment, unsafeSlug } from "@takemetothefair/utils";
import {
  inheritSeriesDefaults,
  type SeriesRow,
  type OccurrenceOverrides,
} from "./create-occurrence-core";

type Db = Database;

export interface CreateOccurrenceInput {
  seriesId: string;
  /** Edition year — idempotency key (one occurrence per series per year). */
  year: number;
  overrides?: OccurrenceOverrides;
  rolledFromEventId?: string | null;
  actorUserId?: string | null;
  /** Provenance on the inserted row. Defaults mirror the admin route. */
  sourceName?: string;
  ingestionMethod?: string;
}

export type CreateOccurrenceResult =
  | { created: false; reason: "series_not_found"; year: number }
  | {
      created: false;
      reason: "occurrence_exists";
      existingEventId: string;
      year: number;
      /**
       * OPE-28 — for a sub-annual (FREQ=MONTHLY/WEEKLY/DAILY) series, true when
       * the incoming date was attached as a NEW event_day on the existing
       * year-occurrence (false = that date was already present / not sub-annual).
       */
      attachedEventDay?: boolean;
    }
  | { created: false; reason: "promoter_required"; year: number }
  | { created: true; occurrenceId: string; slug: string; year: number };

/** Year of an existing series sibling — from its start date, else a -YYYY slug suffix. */
function siblingYear(startDate: Date | null, slug: string): number | null {
  if (startDate) return new Date(startDate).getUTCFullYear();
  const m = slug.match(/-(\d{4})$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** UTC `YYYY-MM-DD` key for an event_days row. */
function utcDateKey(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** A sub-annual series (monthly/weekly/daily) legitimately has multiple dates
 *  within one year, so a same-year hit is a NEW DATE — not a duplicate. */
function isSubAnnual(recurrenceRule: string | null): boolean {
  return /FREQ=(MONTHLY|WEEKLY|DAILY)/i.test(recurrenceRule ?? "");
}

/**
 * OPE-28 — attach `date` as an event_day to an existing sub-annual occurrence,
 * idempotently. Returns true when a new day row was inserted, false when that
 * date was already present. Also flips the occurrence to discontinuous_dates and
 * widens its end_date when the new date extends the range.
 */
async function attachDateAsEventDay(
  db: Db,
  occurrenceId: string,
  currentEndDate: Date | null,
  date: Date,
  actorUserId: string | null
): Promise<boolean> {
  const dateKey = utcDateKey(date);
  const existing = await db
    .select({ id: eventDays.id })
    .from(eventDays)
    .where(and(eq(eventDays.eventId, occurrenceId), eq(eventDays.date, dateKey)))
    .limit(1);
  if (existing.length > 0) return false; // idempotent — that date is already a day

  const now = new Date();
  await db.insert(eventDays).values({
    id: crypto.randomUUID(),
    eventId: occurrenceId,
    date: dateKey,
    createdAt: now,
  });
  await db
    .update(events)
    .set({
      discontinuousDates: true,
      // Widen the visible range only when the new date is later than the current end.
      endDate: currentEndDate && currentEndDate >= date ? currentEndDate : date,
      updatedAt: now,
    })
    .where(eq(events.id, occurrenceId));
  await db.insert(adminActions).values({
    action: "event.occurrence_day_attached",
    actorUserId,
    targetType: "event",
    targetId: occurrenceId,
    payloadJson: JSON.stringify({ date: dateKey, via: "discovery-occurrence" }),
    createdAt: now,
  });
  return true;
}

/**
 * Create a new dated occurrence under a series — NEVER mutating a past one.
 * Skeleton posture (TENTATIVE, dates_confirmed=false, flagged_for_review, dates
 * only from explicit overrides). Year-bucketed idempotency. Returns a discrim-
 * inated result the caller maps to HTTP (route) or a submit response (ingest).
 */
export async function createOccurrenceForSeries(
  db: Db,
  input: CreateOccurrenceInput
): Promise<CreateOccurrenceResult> {
  const { seriesId, year } = input;

  const [series] = await db
    .select({
      id: eventSeries.id,
      name: eventSeries.name,
      venueId: eventSeries.venueId,
      promoterId: eventSeries.promoterId,
      recurrenceRule: eventSeries.recurrenceRule,
      description: eventSeries.description,
      imageUrl: eventSeries.imageUrl,
      categories: eventSeries.categories,
      tags: eventSeries.tags,
      primaryAudience: eventSeries.primaryAudience,
      publicAccess: eventSeries.publicAccess,
    })
    .from(eventSeries)
    .where(eq(eventSeries.id, seriesId))
    .limit(1);

  if (!series) return { created: false, reason: "series_not_found", year };

  // Year-bucketed idempotency: one occurrence per series per year.
  const siblings = await db
    .select({
      id: events.id,
      slug: events.slug,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(events)
    .where(eq(events.seriesId, seriesId));
  const clash = siblings.find((s) => siblingYear(s.startDate ?? null, s.slug) === year);
  if (clash) {
    // OPE-28 — for a sub-annual series (FREQ=MONTHLY/WEEKLY), a same-year hit is
    // a NEW DATE of the existing year-occurrence, not a duplicate: attach it as
    // an event_day rather than dropping it (the bug that minted month-suffixed
    // siblings). Annual series keep the no-op (a same-year hit is a true dupe).
    const incomingStart = input.overrides?.startDate ?? null;
    if (isSubAnnual(series.recurrenceRule) && incomingStart) {
      const attachedEventDay = await attachDateAsEventDay(
        db,
        clash.id,
        clash.endDate ?? null,
        incomingStart,
        input.actorUserId ?? null
      );
      return {
        created: false,
        reason: "occurrence_exists",
        existingEventId: clash.id,
        year,
        attachedEventDay,
      };
    }
    return { created: false, reason: "occurrence_exists", existingEventId: clash.id, year };
  }

  const values = inheritSeriesDefaults(series as SeriesRow, input.overrides ?? {}, {
    rolledFromEventId: input.rolledFromEventId ?? null,
  });

  // events.promoter_id is NOT NULL — a series with no default promoter needs one.
  if (!values.promoterId) return { created: false, reason: "promoter_required", year };

  // Year-suffixed slug, uniqueness-resolved (mirrors suggest_event).
  const baseSlug = createSlug(`${values.name} ${year}`);
  let finalSlug = baseSlug;
  let suffix = 0;
  for (;;) {
    const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
    const existing = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, unsafeSlug(candidate)))
      .limit(1);
    if (existing.length === 0) {
      finalSlug = candidate;
      break;
    }
    suffix++;
  }

  const eventId = crypto.randomUUID();
  const now = new Date();
  await db.insert(events).values({
    id: eventId,
    seriesId: values.seriesId,
    name: values.name,
    slug: finalSlug,
    description: values.description,
    promoterId: values.promoterId,
    venueId: values.venueId,
    startDate: values.startDate,
    endDate: values.endDate,
    datesConfirmed: values.datesConfirmed,
    recurrenceRule: values.recurrenceRule,
    categories: values.categories ?? "[]",
    tags: values.tags ?? "[]",
    imageUrl: values.imageUrl,
    primaryAudience: values.primaryAudience,
    publicAccess: values.publicAccess,
    status: values.status,
    lifecycleStatus: values.lifecycleStatus,
    // flagged_for_review is a plain INTEGER column (not boolean-mode).
    flaggedForReview: values.flaggedForReview ? 1 : 0,
    rolledFromEventId: values.rolledFromEventId,
    sourceName: input.sourceName ?? "series-occurrence",
    ingestionMethod: input.ingestionMethod ?? "admin_manual",
    syncEnabled: false,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(adminActions).values({
    action: "event.occurrence_created",
    actorUserId: input.actorUserId ?? null,
    targetType: "event",
    targetId: eventId,
    payloadJson: JSON.stringify({
      series_id: values.seriesId,
      year,
      slug: finalSlug,
      rolled_from_event_id: values.rolledFromEventId,
      source: input.sourceName ?? "series-occurrence",
    }),
    createdAt: now,
  });

  return { created: true, occurrenceId: eventId, slug: finalSlug, year };
}
