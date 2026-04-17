import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { eventVendors, events } from "@/lib/db/schema";
import { getCloudflareDb } from "@/lib/cloudflare";

const DECIDED_STATUSES = ["APPROVED", "CONFIRMED", "REJECTED"] as const;
const MIN_SAMPLE_SIZE = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PromoterResponseStats {
  /** Median response time in days (rounded). */
  medianDays: number;
  /** Number of decided applications the estimate is based on. */
  sampleSize: number;
}

/**
 * Estimate how long this promoter typically takes to decide on a vendor
 * application. Uses `updatedAt - createdAt` on eventVendors rows in a decided
 * state (APPROVED/CONFIRMED/REJECTED) for events this promoter owns.
 *
 * Returns null when fewer than MIN_SAMPLE_SIZE decided applications exist —
 * a number based on 1-2 data points is misleading.
 */
export async function getPromoterResponseStats(
  promoterId: string
): Promise<PromoterResponseStats | null> {
  try {
    const db = getCloudflareDb();
    const rows = await db
      .select({
        createdAt: eventVendors.createdAt,
        updatedAt: eventVendors.updatedAt,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(
        and(
          eq(events.promoterId, promoterId),
          inArray(eventVendors.status, [...DECIDED_STATUSES]),
          isNotNull(eventVendors.createdAt),
          isNotNull(eventVendors.updatedAt)
        )
      );

    const deltas: number[] = [];
    for (const r of rows) {
      if (!r.createdAt || !r.updatedAt) continue;
      const created = new Date(r.createdAt).getTime();
      const updated = new Date(r.updatedAt).getTime();
      const delta = updated - created;
      // Ignore rows where updatedAt is not meaningfully after createdAt
      // (e.g. admin bulk-seed events have identical timestamps).
      if (delta < 60 * 1000) continue;
      deltas.push(delta);
    }

    if (deltas.length < MIN_SAMPLE_SIZE) return null;

    deltas.sort((a, b) => a - b);
    const mid = Math.floor(deltas.length / 2);
    const medianMs = deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];

    return {
      medianDays: Math.max(1, Math.round(medianMs / MS_PER_DAY)),
      sampleSize: deltas.length,
    };
  } catch {
    return null;
  }
}
