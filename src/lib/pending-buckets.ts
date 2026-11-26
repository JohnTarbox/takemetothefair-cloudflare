/**
 * OPE-1596 — splits the PENDING queue by whether the event can still happen.
 * 137 of 210 PENDING rows had already ended, so a single count said nothing
 * about what was waiting on a decision.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { adminActions, events } from "@/lib/db/schema";
import type { Database } from "@/lib/db";

export type PendingBucket = "upcoming" | "ended" | "no_date";

export const ELAPSED_REASON = "elapsed_unreviewed";

/** An event ending today still counts as upcoming until the UTC day is over. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function pendingBucket(
  startDate: Date | string | null,
  endDate: Date | string | null,
  now: Date
): PendingBucket {
  const last = endDate ?? startDate;
  if (!last) return "no_date";
  return new Date(last).getTime() < startOfUtcDay(now).getTime() ? "ended" : "upcoming";
}

export function daysSince(date: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 86_400_000));
}

export async function pendingBucketCounts(
  db: Database,
  now: Date
): Promise<Record<PendingBucket, number>> {
  const cutoff = Math.floor(startOfUtcDay(now).getTime() / 1000);
  const last = sql`COALESCE(${events.endDate}, ${events.startDate})`;
  const [row] = await db
    .select({
      upcoming: sql<number>`COALESCE(SUM(CASE WHEN ${last} >= ${cutoff} THEN 1 ELSE 0 END), 0)`,
      ended: sql<number>`COALESCE(SUM(CASE WHEN ${last} < ${cutoff} THEN 1 ELSE 0 END), 0)`,
      noDate: sql<number>`COALESCE(SUM(CASE WHEN ${last} IS NULL THEN 1 ELSE 0 END), 0)`,
    })
    .from(events)
    .where(eq(events.status, "PENDING"));
  return {
    upcoming: Number(row?.upcoming ?? 0),
    ended: Number(row?.ended ?? 0),
    no_date: Number(row?.noDate ?? 0),
  };
}

/**
 * Rejects PENDING rows whose event has ended, with the reason in the audit
 * trail (events has no reason column). The status guard is in the UPDATE, so
 * an id that is upcoming or already decided is left alone, not trusted.
 * Sends no email: only approval notifies a submitter.
 */
export async function expireElapsedEvents(
  db: Database,
  ids: string[],
  actorUserId: string,
  now: Date
): Promise<{ expired: string[] }> {
  const cutoff = Math.floor(startOfUtcDay(now).getTime() / 1000);
  const expired: string[] = [];
  for (const chunk of chunkIds(ids)) {
    const rows = await db
      .update(events)
      .set({ status: "REJECTED", updatedAt: now })
      .where(
        and(
          inArray(events.id, chunk),
          eq(events.status, "PENDING"),
          sql`COALESCE(${events.endDate}, ${events.startDate}) < ${cutoff}`
        )
      )
      .returning({ id: events.id });
    expired.push(...rows.map((r) => r.id));
  }
  // Six bound values per row keeps a batch of 15 under D1's 100-parameter cap.
  for (const chunk of chunkIds(expired, 15)) {
    await db.insert(adminActions).values(
      chunk.map((id) => ({
        action: "event.expire_elapsed",
        actorUserId,
        targetType: "event",
        targetId: id,
        payloadJson: JSON.stringify({ reason: ELAPSED_REASON, from: "PENDING", to: "REJECTED" }),
        createdAt: now,
      }))
    );
  }
  return { expired };
}
