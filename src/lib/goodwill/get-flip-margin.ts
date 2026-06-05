/**
 * G remainder (Dev backlog 2026-06-05): config-driven flip margin lookup
 * for GW1.2 reliability-weighted resolution.
 *
 * Reads the single-row `goodwill_config` table (drizzle/0110) for the
 * flip margin. Falls back to the hardcoded RELIABILITY_FLIP_MARGIN (0.2)
 * when:
 *   - The table doesn't exist yet (pre-migration window).
 *   - The row id=1 hasn't been seeded yet (CREATE TABLE landed, INSERT
 *     hasn't run for some reason).
 *   - The query throws for any reason (transient D1 hiccup).
 *
 * The fallback path means GW1.2 resolution never breaks waiting on
 * config; it merely uses the spec-default margin until the row is
 * present. Production behavior is therefore identical pre- and
 * post-migration; the migration is what unlocks operator-side tuning.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { goodwillConfig } from "@/lib/db/schema";
import { RELIABILITY_FLIP_MARGIN } from "@/lib/goodwill/reliability-resolution";

export async function getFlipMargin(db: Database): Promise<number> {
  try {
    const rows = await db
      .select({ flipMargin: goodwillConfig.flipMargin })
      .from(goodwillConfig)
      .where(eq(goodwillConfig.id, 1))
      .limit(1);
    if (rows.length === 0) return RELIABILITY_FLIP_MARGIN;
    return rows[0].flipMargin;
  } catch {
    return RELIABILITY_FLIP_MARGIN;
  }
}
