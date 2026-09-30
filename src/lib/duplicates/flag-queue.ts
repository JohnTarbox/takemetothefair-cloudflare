/**
 * OPE-1117 — the consumer `events.possible_duplicate_of` never had.
 *
 * OPE-627 made the detector fire on every intake path, and it now writes a
 * flag roughly once every 4.6 days. Nothing read the flag. Of the eight rows
 * carrying one on 2026-09-22, five were resolved by people who were not looking
 * for duplicates, and two expired unread past their OWN event date — one of
 * them TENTATIVE, so publicly listed beside the event it was flagged against.
 *
 * This module is the one place that decides what "an unresolved flag" means,
 * so the review queue, the submissions badge, the drain tile and the deadline
 * alert cannot disagree about it.
 *
 * ## Three facts, never conflated
 *
 *   possible_duplicate_of      — the matcher's guess (base rate 40% on OPE-627's census)
 *   rejected_as_duplicate_of   — a human ruled it IS a duplicate (OPE-450)
 *   event_duplicate_dismissals — a human ruled it is NOT
 *
 * A dismissal never writes either `events` column. See the schema comment on
 * `eventDuplicateDismissals` for the poisoning that would cause.
 *
 * ## Nothing here merges
 *
 * The predicate is a candidate generator, not a defect list. The queue offers
 * merge as one of three actions a HUMAN takes; nothing in this file calls it.
 */
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  adminActions,
  eventDuplicateDismissals,
  events,
  tunableThresholds,
  venues,
} from "@/lib/db/schema";
import { SITE_URL } from "@takemetothefair/constants";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { Db } from "@/lib/analytics-overview/shared";

const MS_PER_HOUR = 3_600_000;
const DAY_MS = 86_400_000;

/** The review queue. The digest red and the drain tile both link here. */
export const DUPLICATE_FLAGS_PATH = "/admin/duplicates/flags";
export const DUPLICATE_FLAGS_HREF = `${SITE_URL}${DUPLICATE_FLAGS_PATH}`;

/** Operator override for the alert horizon, read from `tunable_thresholds`. */
export const DUPLICATE_FLAG_ALERT_DAYS_KEY = "duplicate_flag_alert_days";

/**
 * Default horizon: alert when a flagged event starts within a week, or has
 * already started. Both misses that produced this ticket would have fired —
 * `bd1b1f4c` was flagged the day before its event, `77b95478` a week before.
 */
export const DEFAULT_DUPLICATE_FLAG_ALERT_DAYS = 7;

/**
 * THE definition of an unresolved flag. A flagged row leaves the queue when it
 * is merged, rejected (as a duplicate or otherwise — a REJECTED row is off the
 * site, so the flag is moot), or its pair is dismissed.
 *
 * Measured on prod 2026-09-23 this matches exactly `77b95478` (TENTATIVE) and
 * `bd1b1f4c` (PENDING) — the two rows the ticket names — out of eight flagged.
 */
export function unresolvedDuplicateFlag(db: Db): SQL {
  return and(
    isNotNull(events.possibleDuplicateOf),
    isNull(events.mergedInto),
    isNull(events.rejectedAsDuplicateOf),
    ne(events.status, "REJECTED"),
    notExists(
      db
        .select({ one: sql`1` })
        .from(eventDuplicateDismissals)
        .where(
          and(
            eq(eventDuplicateDismissals.eventId, events.id),
            eq(eventDuplicateDismissals.candidateId, events.possibleDuplicateOf)
          )
        )
    )
  ) as SQL;
}

export interface FlagSide {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  venue: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  createdAt: Date | null;
}

export interface UnresolvedDuplicateFlag {
  flagged: FlagSide;
  /** Null when the candidate row no longer exists. */
  candidate: FlagSide | null;
  /** When the flag was raised — the flagged row's creation (the detector runs at insert). */
  flaggedAt: Date | null;
  /** Whole days until the flagged event starts; negative once it has started. Null without a date. */
  daysUntilStart: number | null;
}

function venueLabel(name: string | null, city: string | null, state: string | null): string | null {
  const parts = [name, [city, state].filter(Boolean).join(", ")].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  return parts.length > 0 ? parts.join(" — ") : null;
}

/**
 * Whole CALENDAR days (UTC) from today to the start date. Not elapsed time
 * divided by 24h: a fair at noon tomorrow is "in 1d" at 3pm today, not "today",
 * and one that started at noon eleven days ago is "11d ago", not 12.
 */
function daysUntil(start: Date | null, now: Date): number | null {
  if (!start) return null;
  const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcDay(start) - utcDay(now)) / DAY_MS);
}

/**
 * Every unresolved flag with both sides side by side, soonest event first —
 * the row most likely to expire unread is the one to look at first.
 */
export async function listUnresolvedDuplicateFlags(
  db: Db,
  now: Date = new Date()
): Promise<UnresolvedDuplicateFlag[]> {
  const candidate = alias(events, "candidate");
  const flaggedVenue = alias(venues, "flagged_venue");
  const candidateVenue = alias(venues, "candidate_venue");

  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      startDate: events.startDate,
      endDate: events.endDate,
      sourceName: events.sourceName,
      sourceUrl: events.sourceUrl,
      createdAt: events.createdAt,
      venueName: flaggedVenue.name,
      venueCity: flaggedVenue.city,
      venueState: flaggedVenue.state,
      cId: candidate.id,
      cName: candidate.name,
      cSlug: candidate.slug,
      cStatus: candidate.status,
      cStartDate: candidate.startDate,
      cEndDate: candidate.endDate,
      cSourceName: candidate.sourceName,
      cSourceUrl: candidate.sourceUrl,
      cCreatedAt: candidate.createdAt,
      cVenueName: candidateVenue.name,
      cVenueCity: candidateVenue.city,
      cVenueState: candidateVenue.state,
    })
    .from(events)
    .leftJoin(candidate, eq(candidate.id, events.possibleDuplicateOf))
    .leftJoin(flaggedVenue, eq(flaggedVenue.id, events.venueId))
    .leftJoin(candidateVenue, eq(candidateVenue.id, candidate.venueId))
    .where(unresolvedDuplicateFlag(db))
    // NULL start dates last: a dated row can expire, an undated one cannot.
    .orderBy(sql`${events.startDate} IS NULL`, events.startDate);

  return rows.map((r) => ({
    flagged: {
      id: r.id,
      name: r.name,
      slug: r.slug as string,
      status: r.status,
      startDate: r.startDate,
      endDate: r.endDate,
      venue: venueLabel(r.venueName, r.venueCity, r.venueState),
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      createdAt: r.createdAt,
    },
    candidate: r.cId
      ? {
          id: r.cId,
          name: r.cName as string,
          slug: r.cSlug as string,
          status: r.cStatus as string,
          startDate: r.cStartDate,
          endDate: r.cEndDate,
          venue: venueLabel(r.cVenueName, r.cVenueCity, r.cVenueState),
          sourceName: r.cSourceName,
          sourceUrl: r.cSourceUrl,
          createdAt: r.cCreatedAt,
        }
      : null,
    flaggedAt: r.createdAt,
    daysUntilStart: daysUntil(r.startDate, now),
  }));
}

/**
 * The keeper an event is flagged against, if and only if that flag is still
 * unresolved — the same predicate as the queue. Null for an unflagged row, a
 * resolved one, or a dismissed pair.
 */
export async function loadUnresolvedFlagForEvent(
  db: Db,
  eventId: string
): Promise<{
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date | null;
} | null> {
  const candidate = alias(events, "candidate");
  const [row] = await db
    .select({
      id: candidate.id,
      name: candidate.name,
      slug: candidate.slug,
      status: candidate.status,
      startDate: candidate.startDate,
    })
    .from(events)
    .innerJoin(candidate, eq(candidate.id, events.possibleDuplicateOf))
    .where(and(eq(events.id, eventId), unresolvedDuplicateFlag(db)))
    .limit(1);
  return row ? { ...row, slug: row.slug as string } : null;
}

/**
 * The ids, among `ids`, whose CURRENT flag has been dismissed. The admin events
 * API uses it so a dismissed pair stops being badged on the submissions page.
 */
export async function dismissedFlagIds(db: Db, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  // D1 caps bound parameters at 100 per statement.
  const BATCH = 90;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    // Joined on the PAIR, so a dismissal of an earlier candidate does not hide
    // a row that has since been flagged against a different one.
    const rows = await db
      .select({ id: eventDuplicateDismissals.eventId })
      .from(eventDuplicateDismissals)
      .innerJoin(
        events,
        and(
          eq(events.id, eventDuplicateDismissals.eventId),
          eq(events.possibleDuplicateOf, eventDuplicateDismissals.candidateId)
        )
      )
      .where(inArray(eventDuplicateDismissals.eventId, batch));
    for (const r of rows) out.add(r.id);
  }
  return out;
}

export type ResolveFailure =
  | "not_found"
  | "not_flagged"
  | "candidate_mismatch"
  | "already_resolved";

export type ResolveResult = { ok: true } | { ok: false; reason: ResolveFailure };

interface ResolveInput {
  eventId: string;
  /** Must equal the row's current flag — the operator adjudicates the pair they SAW. */
  candidateId: string;
  actorUserId: string | null;
  now?: Date;
}

async function loadFlaggedRow(db: Db, eventId: string) {
  const [row] = await db
    .select({
      id: events.id,
      status: events.status,
      possibleDuplicateOf: events.possibleDuplicateOf,
      mergedInto: events.mergedInto,
      rejectedAsDuplicateOf: events.rejectedAsDuplicateOf,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

async function precheck(
  db: Db,
  eventId: string,
  candidateId: string
): Promise<{ ok: true; status: string } | { ok: false; reason: ResolveFailure }> {
  const row = await loadFlaggedRow(db, eventId);
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.possibleDuplicateOf) return { ok: false, reason: "not_flagged" };
  // A re-flag against a different candidate between page load and click must
  // not be adjudicated on the strength of a pair nobody looked at.
  if (row.possibleDuplicateOf !== candidateId) return { ok: false, reason: "candidate_mismatch" };
  if (row.mergedInto || row.rejectedAsDuplicateOf || row.status === "REJECTED") {
    return { ok: false, reason: "already_resolved" };
  }
  const [dismissed] = await db
    .select({ id: eventDuplicateDismissals.id })
    .from(eventDuplicateDismissals)
    .where(
      and(
        eq(eventDuplicateDismissals.eventId, eventId),
        eq(eventDuplicateDismissals.candidateId, candidateId)
      )
    )
    .limit(1);
  if (dismissed) return { ok: false, reason: "already_resolved" };
  return { ok: true, status: row.status };
}

/**
 * "Looked at it — two different events." Records the verdict against the PAIR
 * and writes neither `possible_duplicate_of` nor `rejected_as_duplicate_of`.
 * The flag itself stays on the row as the historical record of what the
 * matcher thought; the dismissal is what takes it out of the queue.
 */
export async function dismissDuplicateFlag(
  db: Db,
  input: ResolveInput & { note?: string | null }
): Promise<ResolveResult> {
  const now = input.now ?? new Date();
  const check = await precheck(db, input.eventId, input.candidateId);
  if (!check.ok) return check;

  await db
    .insert(eventDuplicateDismissals)
    .values({
      eventId: input.eventId,
      candidateId: input.candidateId,
      dismissedBy: input.actorUserId,
      dismissedAt: now,
      note: input.note ?? null,
    })
    .onConflictDoNothing();

  await db.insert(adminActions).values({
    action: "event.duplicate_flag.dismiss",
    actorUserId: input.actorUserId,
    targetType: "EVENT",
    targetId: input.eventId,
    payloadJson: JSON.stringify({ candidateId: input.candidateId, note: input.note ?? null }),
    createdAt: now,
  });
  return { ok: true };
}

/**
 * "Yes, it is a duplicate" WITHOUT a merge — the path known to work while
 * OPE-793's `merge_events` failure class is still being watched. Writes the
 * OPE-450 adjudication explicitly, naming the candidate the operator saw.
 */
export async function rejectFlaggedAsDuplicate(
  db: Db,
  input: ResolveInput
): Promise<ResolveResult> {
  const now = input.now ?? new Date();
  const check = await precheck(db, input.eventId, input.candidateId);
  if (!check.ok) return check;

  await db
    .update(events)
    .set({ status: "REJECTED", rejectedAsDuplicateOf: input.candidateId, updatedAt: now })
    .where(eq(events.id, input.eventId));

  await db.insert(adminActions).values({
    action: "event.duplicate_flag.reject",
    actorUserId: input.actorUserId,
    targetType: "EVENT",
    targetId: input.eventId,
    payloadJson: JSON.stringify({
      candidateId: input.candidateId,
      previousStatus: check.status,
      newStatus: "REJECTED",
    }),
    createdAt: now,
  });
  return { ok: true };
}

// ── The deadline alert ──────────────────────────────────────────────────────

/** Read the operator's horizon. Fails OPEN to the default — never silences. */
export async function loadDuplicateFlagAlertDays(db: Db): Promise<number> {
  try {
    const rows = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, DUPLICATE_FLAG_ALERT_DAYS_KEY))
      .limit(1);
    const v = rows[0]?.value;
    return typeof v === "number" && Number.isFinite(v) && v >= 0
      ? v
      : DEFAULT_DUPLICATE_FLAG_ALERT_DAYS;
  } catch {
    return DEFAULT_DUPLICATE_FLAG_ALERT_DAYS;
  }
}

/**
 * Alert on AGE AGAINST THE EVENT, not on count. The harm here was never volume
 * — it was a flag sitting unread while its event came and went. So the red
 * fires when any unresolved flag's event starts within `alertDays`, INCLUDING
 * events that have already started: an expired flag on a live row is the
 * failure itself, not an exemption from it.
 *
 * Pure: takes the listed flags, so it is testable without a database.
 */
export function assessDuplicateFlagDeadlines(
  flags: UnresolvedDuplicateFlag[],
  now: Date,
  alertDays: number = DEFAULT_DUPLICATE_FLAG_ALERT_DAYS
): StaleRed | null {
  const due = flags.filter((f) => f.daysUntilStart !== null && f.daysUntilStart <= alertDays);
  if (due.length === 0) return null;

  // `flags` arrives soonest-first; restate it so the title does not depend on a caller.
  const soonest = [...due].sort((a, b) => a.daysUntilStart! - b.daysUntilStart!)[0];
  const when =
    soonest.daysUntilStart! < 0
      ? `started ${-soonest.daysUntilStart!}d ago`
      : soonest.daysUntilStart === 0
        ? "starts today"
        : `starts in ${soonest.daysUntilStart}d`;

  const oldest = due
    .map((f) => f.flaggedAt)
    .filter((d): d is Date => d instanceof Date)
    .reduce<Date | null>((acc, d) => (acc === null || d < acc ? d : acc), null);
  const since = oldest ?? now;

  return {
    priority: "P1",
    title:
      `Duplicate flags unread (OPE-1117): ${due.length} flagged event` +
      `${due.length === 1 ? "" : "s"} starting within ${alertDays}d or already started, ` +
      `nobody has adjudicated the flag. Soonest: ${soonest.flagged.slug} (${soonest.flagged.status}, ${when}).`,
    // No count in the refKey: one CPI ticket for the condition, and the digest
    // does not re-mail every time the number moves by one.
    refKey: "duplicate-flags:unread-near-event",
    href: DUPLICATE_FLAGS_HREF,
    firstDetectedAt: since.toISOString(),
    hoursInRed: (now.getTime() - since.getTime()) / MS_PER_HOUR,
  };
}

/** Load + assess. Returns [] when healthy, so it merges into `allReds` directly. */
export async function assessAllDuplicateFlagDeadlines(db: Db, now: Date): Promise<StaleRed[]> {
  const [flags, days] = await Promise.all([
    listUnresolvedDuplicateFlags(db, now),
    loadDuplicateFlagAlertDays(db),
  ]);
  const red = assessDuplicateFlagDeadlines(flags, now, days);
  return red ? [red] : [];
}

// ── Drain-tile inputs ───────────────────────────────────────────────────────

export interface DuplicateFlagFlowCounts {
  depth: number;
  inflow1d: number;
  inflow7d: number;
  inflow14d: number;
  outflow1d: number;
  outflow7d: number;
  outflow14d: number;
  oldestOpenAt: Date | null;
}

/**
 * Inputs for the OPE-247 drain tile. Inflow = rows flagged in the window.
 * Outflow = rows that LEFT the queue in the window: dismissals (stamped), plus
 * flagged rows that were merged or rejected (dated by `updated_at`, a reliable
 * change signal since OPE-308).
 */
export async function loadDuplicateFlagFlow(db: Db, now: Date): Promise<DuplicateFlagFlowCounts> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const count = async (where: SQL | undefined) => {
    const [r] = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(where);
    return Number(r?.n ?? 0);
  };
  const dismissedSince = async (d: Date) => {
    const [r] = await db
      .select({ n: sql<number>`count(*)` })
      .from(eventDuplicateDismissals)
      .where(gte(eventDuplicateDismissals.dismissedAt, d));
    return Number(r?.n ?? 0);
  };
  const adjudicated = and(
    isNotNull(events.possibleDuplicateOf),
    sql`(${events.mergedInto} IS NOT NULL OR ${events.rejectedAsDuplicateOf} IS NOT NULL OR ${events.status} = 'REJECTED')`
  );
  const leftSince = async (d: Date) =>
    (await count(and(adjudicated, gte(events.updatedAt, d)))) + (await dismissedSince(d));

  const flaggedSince = (d: Date) =>
    count(and(isNotNull(events.possibleDuplicateOf), gte(events.createdAt, d)));

  const [depth, inflow1d, inflow7d, inflow14d, outflow1d, outflow7d, outflow14d, oldest] =
    await Promise.all([
      count(unresolvedDuplicateFlag(db)),
      flaggedSince(since(1)),
      flaggedSince(since(7)),
      flaggedSince(since(14)),
      leftSince(since(1)),
      leftSince(since(7)),
      leftSince(since(14)),
      db
        .select({ t: sql<number | null>`min(${events.createdAt})` })
        .from(events)
        .where(and(unresolvedDuplicateFlag(db), lte(events.createdAt, now))),
    ]);

  const oldestSec = oldest[0]?.t ?? null;
  return {
    depth,
    inflow1d,
    inflow7d,
    inflow14d,
    outflow1d,
    outflow7d,
    outflow14d,
    // D1 stores timestamps in SECONDS; a raw aggregate is the stored number.
    oldestOpenAt: oldestSec != null ? new Date(Number(oldestSec) * 1000) : null,
  };
}
