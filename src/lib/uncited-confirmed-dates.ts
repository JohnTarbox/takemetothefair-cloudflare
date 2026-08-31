/**
 * OPE-384 stage 5 — the Dartmouth failure, escalated instead of noticed.
 *
 * Dartmouth Grange Fair 2026 carried `dates_confirmed = 1` for Sep 11-12 while
 * the organizer's own site still showed the 2024 dates. Nothing was wrong with
 * the flag mechanically; the problem is that it can be set with nothing behind
 * it, and once set it looks exactly like a date somebody verified.
 *
 * Stage 6 counts these. Counting is not escalation: a number on a dashboard is
 * the same pull-only posture that let IndexNow sit dead for two weeks in plain
 * sight (OPE-75's founding specimen). This module shapes the count as a
 * `StaleRed` so it merges into the SAME operator digest and becomes fileable
 * through the CPI rail.
 *
 * ## Why there is no invented threshold
 *
 * The obvious design picks a number — "red above 50 uncited events" — and every
 * such number is a guess dressed as a policy. The ticket's own framing settles
 * it instead: this metric "should trend to 0". An unsupported public date claim
 * is a defect at any count, so the default gate is simply `> 0`.
 *
 * The tunable exists for the opposite reason: if the digest proves noisy while
 * the backlog drains, an operator can raise the floor in `tunable_thresholds`
 * without a deploy. Following OPE-497's rule, an unreadable or malformed row
 * fails OPEN to the code default — a broken config must never be able to
 * silence a detector.
 *
 * ## One signal, not 448 of them
 *
 * `refKey` is constant and carries no count, so the CPI auto-file rail proposes
 * ONE ticket for the condition rather than one per event, and the daily digest
 * does not re-mail every time the number wobbles by one
 * (`staleRedFingerprint` keys on `refKey`).
 */
import { and, eq, gte, isNull, notExists, sql } from "drizzle-orm";
import { events, eventDataCitations, tunableThresholds } from "@/lib/db/schema";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { Db } from "@/lib/analytics-overview/shared";

const MS_PER_HOUR = 3_600_000;

/** Where an operator goes to act on it — the asks that would fix these. */
const REVIEW_HREF = "/admin/analytics#data-health";

/** Operator override for the floor, read from `tunable_thresholds`. */
export const UNCITED_CONFIRMED_DATES_KEY = "uncited_confirmed_dates_min";

/**
 * Default floor. Zero, deliberately: the ticket asks this to trend to 0, and a
 * date we publish as confirmed with nothing behind it is wrong whether there is
 * one of them or four hundred.
 */
export const DEFAULT_UNCITED_MIN = 0;

/** The citation fields that count as backing a date claim. */
const DATE_CITATION_FIELDS = ["start_date", "end_date"];

export interface UncitedConfirmedDates {
  /** Upcoming APPROVED events asserting confirmed dates with no active citation. */
  count: number;
  /**
   * When the OLDEST such event was created — how long an unsupported claim has
   * been standing. Null when count is 0. This is the clock the red ages
   * against, so a backlog that has been wrong for months escalates immediately
   * rather than starting a fresh 72-hour countdown on each scan.
   */
  oldestAt: Date | null;
}

export async function loadUncitedConfirmedDates(db: Db, now: Date): Promise<UncitedConfirmedDates> {
  const rows = await db
    .select({
      n: sql<number>`COUNT(*)`,
      oldest: sql<number | null>`MIN(${events.createdAt})`,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "APPROVED"),
        isNull(events.mergedInto),
        gte(events.startDate, now),
        eq(events.datesConfirmed, true),
        notExists(
          db
            .select({ one: sql`1` })
            .from(eventDataCitations)
            .where(
              and(
                eq(eventDataCitations.eventId, events.id),
                eq(eventDataCitations.state, "active"),
                sql`${eventDataCitations.fieldName} IN (${sql.join(
                  DATE_CITATION_FIELDS.map((f) => sql`${f}`),
                  sql`, `
                )})`
              )
            )
        )
      )
    );

  const count = Number(rows[0]?.n ?? 0);
  const oldestRaw = rows[0]?.oldest ?? null;
  return {
    count,
    // D1 stores these columns in SECONDS; a raw aggregate returns the stored
    // number, not a Date, so it has to be widened here rather than trusted.
    oldestAt: count > 0 && oldestRaw != null ? new Date(Number(oldestRaw) * 1000) : null,
  };
}

/** Read the operator's floor. Fails OPEN to the default — never silences. */
export async function loadUncitedMin(db: Db): Promise<number> {
  try {
    const rows = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, UNCITED_CONFIRMED_DATES_KEY))
      .limit(1);
    const v = rows[0]?.value;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_UNCITED_MIN;
  } catch {
    return DEFAULT_UNCITED_MIN;
  }
}

export function assessUncitedConfirmedDates(
  state: UncitedConfirmedDates,
  now: Date,
  minCount: number = DEFAULT_UNCITED_MIN
): StaleRed | null {
  if (state.count <= minCount || state.oldestAt === null) return null;

  return {
    priority: "P1",
    title:
      `Unsupported dates (OPE-384): ${state.count} upcoming event` +
      `${state.count === 1 ? "" : "s"} published with dates_confirmed and NO ` +
      `citation behind the claim. The flag says somebody verified these; ` +
      `nothing on file says who or from what.`,
    // No count in the refKey. The CPI rail files ONE ticket for the condition,
    // and the digest must not re-mail every time the number moves by one.
    refKey: "event-dates:confirmed-uncited",
    href: REVIEW_HREF,
    firstDetectedAt: state.oldestAt.toISOString(),
    hoursInRed: (now.getTime() - state.oldestAt.getTime()) / MS_PER_HOUR,
  };
}

/** Load + assess. Returns [] when healthy, so it merges into `allReds` directly. */
export async function assessAllUncitedConfirmedDates(db: Db, now: Date): Promise<StaleRed[]> {
  const [state, min] = await Promise.all([loadUncitedConfirmedDates(db, now), loadUncitedMin(db)]);
  const red = assessUncitedConfirmedDates(state, now, min);
  return red ? [red] : [];
}
