/**
 * Shared mechanics for the routes that INSERT into `events` (WS2a, 2026-06-11).
 *
 * The five insert paths (admin/events, admin/import-url, promoter/events,
 * promoter/events/draft, suggest-event/submit) diverge on POLICY — status,
 * gates, venue resolution, category inference, source provenance, post-insert
 * hooks — and that divergence is intentional, so it stays in each caller. What
 * they shared (and duplicated, sometimes incorrectly) is the MECHANICS below.
 *
 * See docs/event-insert-paths.md for the full per-path divergence matrix.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, gt, lt, or } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { eventDays, events, entityDataCitations } from "@/lib/db/schema";
import { recordMutation } from "@/lib/audit/record-mutation";
import {
  buildEntityCitations,
  toCitationFields,
  type CitationSourceType,
} from "@takemetothefair/utils";
import { findUniqueSlug, getSlugPrefixBounds, unsafeSlug, type Slug } from "@/lib/utils";

type Db = DrizzleD1Database<typeof schema>;

/**
 * D1 caps bound parameters per statement (~100). Each event_days row binds 8
 * columns, so a single multi-row insert silently fails once an event has ≥12
 * days — the bug that wiped event_days on save (admin/events PATCH incident,
 * 2026-06-04) and that the promoter create/draft paths still carried (they
 * inserted ALL days in one statement). Chunk at 11 rows (11×8 = 88 < 100).
 */
export const EVENT_DAYS_BATCH_SIZE = 11;

export interface EventDayInput {
  date: string;
  openTime?: string | null;
  closeTime?: string | null;
  notes?: string | null;
  closed?: boolean | null;
  vendorOnly?: boolean | null;
}

/**
 * Insert event_days rows in D1-safe batches. No-op for an empty/missing array.
 * Mirrors the field mapping the existing paths used (`notes || null`,
 * `closed/vendorOnly || false`) so behavior is identical row-for-row — the only
 * change for the previously-unbatched promoter paths is that ≥12-day events no
 * longer blow the parameter limit.
 */
export async function insertEventDaysBatched(
  db: Db,
  eventId: string,
  days: EventDayInput[] | null | undefined,
  /**
   * OPE-433 scope 5 — WHO is creating these days.
   *
   * Optional, and the audit is skipped when absent. Deliberate: an anonymous
   * audit row records that something happened and still cannot say what, which
   * is the specimen's failure with extra steps. Callers that know their
   * identity should pass it; the guard in
   * `scripts/check-venue-day-writes-audited.ts` makes the omission visible.
   */
  actor?: string,
  /**
   * OPE-433 scope 4 — WHERE these hours came from, when the caller knows.
   *
   * `event_days` is where BOTH logged fabricated-fact instances live: MDI's
   * invented 10-5/10-4/10-3 hours against a published flat 9-4, and OPE-411's
   * 09:00–18:00 rows. A day row that cannot say where its hours came from is
   * indistinguishable from one somebody made up, which is why they were made
   * up for months without anyone being able to tell.
   *
   * Optional on purpose. A caller with no real source passes nothing and
   * records nothing — absence is the honest value, and inventing a source to
   * satisfy a required argument would be the very failure this closes.
   *
   * `actor` and `source` are separate questions and are kept separate: an
   * admin typing hours by hand HAS an actor and no source; an importer has
   * both; a migration has a source and no person.
   */
  source?: {
    sourceUrl: string;
    sourceName?: string | null;
    sourceType: CitationSourceType;
    confidence?: number | null;
    createdBy?: string | null;
  }
): Promise<void> {
  if (!days || days.length === 0) return;
  const rows = days.map((day) => ({
    id: crypto.randomUUID(),
    eventId,
    date: day.date,
    openTime: day.openTime ?? null,
    closeTime: day.closeTime ?? null,
    notes: day.notes || null,
    closed: day.closed || false,
    vendorOnly: day.vendorOnly || false,
  }));
  for (let i = 0; i < rows.length; i += EVENT_DAYS_BATCH_SIZE) {
    await db.insert(eventDays).values(rows.slice(i, i + EVENT_DAYS_BATCH_SIZE));
  }

  // OPE-433 scope 5 — WHO. One row per day rather than one for the batch: the
  // question asked later is "where did THIS day's hours come from", and a
  // batch-level entry cannot answer it.
  if (actor) {
    for (const r of rows) {
      await recordMutation(db, {
        entityType: "event_day",
        entityId: r.id,
        verb: "create",
        actor,
        after: { date: r.date, openTime: r.openTime, closeTime: r.closeTime },
        note: `event ${eventId}`,
      });
    }
  }

  // OPE-433 scope 4 — WHERE FROM.
  if (!source?.sourceUrl) return;
  // Best-effort, and chunked to the same D1 parameter ceiling as the rows
  // themselves. Provenance must never be able to fail an insert that already
  // succeeded — the days are worth more than the note about them.
  try {
    const now = new Date();
    const cites = rows.flatMap((r) =>
      buildEntityCitations(
        "EVENT_DAY",
        r.id,
        toCitationFields({
          date: r.date,
          openTime: r.openTime,
          closeTime: r.closeTime,
          notes: r.notes,
        }),
        source,
        now
      )
    );
    for (let i = 0; i < cites.length; i += EVENT_DAYS_BATCH_SIZE) {
      await db.insert(entityDataCitations).values(cites.slice(i, i + EVENT_DAYS_BATCH_SIZE));
    }
  } catch {
    // Additive. The day rows are already stored.
  }
}

/**
 * Resolve a unique `events.slug` from an already-created base slug: returns the
 * base if free, else `base-2`, `base-3`, … via findUniqueSlug. Uses a single
 * prefix-range query (string-range, not LIKE — avoids D1 "pattern too complex").
 *
 * The caller still does `createSlug(name)` and its own empty-slug handling, then
 * passes the resulting `Slug` here. This standardizes the two former
 * while-loop paths (import-url, suggest-event) onto the prefix-range approach
 * the other three already used. NOTE: those two previously produced `base-1`
 * first on collision; they now produce `base-2` first (findUniqueSlug skips
 * `-1`) — a cosmetic suffix change on the rare same-name-collision case, with
 * no effect on existing URLs.
 */
export async function resolveUniqueEventSlug(db: Db, baseSlug: Slug): Promise<Slug> {
  const [lowerBound, upperBound] = getSlugPrefixBounds(baseSlug);
  const existing = await db
    .select({ slug: events.slug })
    .from(events)
    .where(
      or(
        eq(events.slug, baseSlug),
        and(gt(events.slug, unsafeSlug(lowerBound)), lt(events.slug, unsafeSlug(upperBound)))
      )
    );
  return findUniqueSlug(
    baseSlug,
    existing.map((r) => r.slug)
  );
}
