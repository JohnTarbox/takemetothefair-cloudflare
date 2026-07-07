/**
 * OPE-114 — load an event's CONFIRMED performer appearances for the public
 * "Who's Performing" block + the schema.org `performer` emission. Only CONFIRMED
 * (PENDING/CANCELLED never surface publicly) and only non-deleted performers.
 * Joins event_days for the per-appearance date (multi-day grouping).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { eventPerformers, performers, eventDays } from "@/lib/db/schema";

export interface EventPerformerRow {
  id: string;
  performerName: string;
  performerSlug: string;
  performerType: "PERSON" | "GROUP" | null;
  actCategory: string | null;
  /** Official site → schema.org `sameAs`. */
  sameAs: string | null;
  imageUrl: string | null;
  billing: "HEADLINER" | "FEATURED" | "SUPPORTING" | null;
  stage: string | null;
  performanceStart: number | null; // epoch seconds
  performanceEnd: number | null;
  dayDate: string | null; // YYYY-MM-DD (from event_days) or null
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

export async function loadEventPerformers(
  db: Database,
  eventId: string
): Promise<EventPerformerRow[]> {
  const rows = await db
    .select({
      id: eventPerformers.id,
      name: performers.name,
      slug: performers.slug,
      performerType: performers.performerType,
      actCategory: performers.actCategory,
      website: performers.website,
      imageUrl: performers.imageUrl,
      deletedAt: performers.deletedAt,
      billing: eventPerformers.billing,
      stage: eventPerformers.stage,
      performanceStart: eventPerformers.performanceStart,
      performanceEnd: eventPerformers.performanceEnd,
      dayDate: eventDays.date,
    })
    .from(eventPerformers)
    .innerJoin(performers, eq(eventPerformers.performerId, performers.id))
    .leftJoin(eventDays, eq(eventPerformers.eventDayId, eventDays.id))
    .where(and(eq(eventPerformers.eventId, eventId), eq(eventPerformers.status, "CONFIRMED")));

  return rows
    .filter((r) => r.deletedAt == null)
    .map((r) => ({
      id: r.id,
      performerName: r.name,
      performerSlug: r.slug,
      performerType: r.performerType as "PERSON" | "GROUP" | null,
      actCategory: r.actCategory,
      sameAs: r.website ?? null,
      imageUrl: r.imageUrl ?? null,
      billing: r.billing as "HEADLINER" | "FEATURED" | "SUPPORTING" | null,
      stage: r.stage,
      performanceStart: toSec(r.performanceStart),
      performanceEnd: toSec(r.performanceEnd),
      dayDate: r.dayDate ?? null,
    }));
}
