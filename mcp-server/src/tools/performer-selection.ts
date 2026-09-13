/**
 * OPE-960 — performer-lineup selection for `list_all_events`, the twin of the
 * OPE-264 vendor-roster rails over the OPE-123 `performer_roster_*` columns.
 */
import { inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import type { PerformerRosterStatus } from "@takemetothefair/constants";
import { eventPerformers, events } from "../schema.js";
import type { Db } from "../db.js";

/**
 * Selects `performer_roster_status IS NULL`. A sentinel rather than a separate
 * boolean so one multi-valued OR expresses "NEEDS_RESEARCH or never assessed" —
 * the real worklist, since most events carry no verdict at all.
 */
export const PERFORMER_ROSTER_UNSET = "UNSET";

export function performerRosterStatusWhere(
  values: ReadonlyArray<PerformerRosterStatus | typeof PERFORMER_ROSTER_UNSET>
): SQL {
  const named = values.filter((v): v is PerformerRosterStatus => v !== PERFORMER_ROSTER_UNSET);
  const parts: SQL[] = [];
  if (named.length > 0) parts.push(inArray(events.performerRosterStatus, named));
  if (values.includes(PERFORMER_ROSTER_UNSET)) parts.push(isNull(events.performerRosterStatus));
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

/**
 * "This event holds at least one appearance." The correlation is what matters:
 * an EXISTS that forgot it is true for every row as soon as ANY event has a
 * lineup, and still reads plausibly. The outer column is qualified by hand
 * because drizzle renders interpolated columns bare in some raw-sql contexts
 * (it qualified `${events.id}` here when measured, but that is not a promise);
 * the has_performers test pins the correlation either way.
 */
export function hasPerformersWhere(): SQL {
  return sql`EXISTS (SELECT 1 FROM event_performers ep WHERE ep.event_id = "events"."id")`;
}

/** Appearance rows per event, any status — mirrors `vendor_count`. Chunked for D1's 100-param cap. */
export async function countPerformersByEvent(
  db: Db,
  eventIds: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const batch of chunkIds(eventIds)) {
    const rows = await db
      .select({ eventId: eventPerformers.eventId, n: sql<number>`count(*)` })
      .from(eventPerformers)
      .where(inArray(eventPerformers.eventId, batch))
      .groupBy(eventPerformers.eventId);
    for (const r of rows) counts.set(r.eventId, Number(r.n));
  }
  return counts;
}
