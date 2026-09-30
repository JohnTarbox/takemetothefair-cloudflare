/**
 * OPE-497 — persist WHICH signals are red, not only how many; OPE-1029 — and
 * resolve the ones that cleared, in a statement D1 will actually run.
 *
 * Extracted from `/api/internal/cpi/stale-red-scan` so the resolve pass can be
 * tested against D1's real constraint. The original resolved with
 * `ref_key NOT IN (<every live key>)`, one bound parameter per red signal. On
 * 2026-09-15 that was 391 against D1's cap of 100, so the UPDATE failed on 2 of
 * 2 scheduled runs and no `stale_red_signals` row was ever resolved.
 *
 * Local better-sqlite3 accepts 32,766 bound parameters, so an ordinary test
 * passes with the bug in. The test for this module counts `?` per statement.
 */
import { and, isNull, lt } from "drizzle-orm";
import { staleRedSignals } from "@/lib/db/schema";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

/**
 * Upsert the current red set, then resolve everything the scan no longer sees,
 * so `resolved_at IS NULL` is the answer to "what is red right now".
 *
 * Throws on a DB error; the caller logs it as best-effort (the scan's job is
 * the digest).
 */
export async function persistStaleRedSignals(
  db: Db,
  allReds: readonly StaleRed[],
  seenAt: Date
): Promise<void> {
  for (const red of allReds) {
    await db
      .insert(staleRedSignals)
      .values({
        refKey: red.refKey,
        priority: red.priority,
        title: red.title,
        href: red.href ?? null,
        firstDetectedAt: red.firstDetectedAt ? new Date(red.firstDetectedAt) : null,
        hoursInRed: red.hoursInRed ?? null,
        lastSeenAt: seenAt,
        resolvedAt: null,
      })
      .onConflictDoUpdate({
        target: staleRedSignals.refKey,
        set: {
          priority: red.priority,
          title: red.title,
          href: red.href ?? null,
          hoursInRed: red.hoursInRed ?? null,
          lastSeenAt: seenAt,
          // A signal that went green and came back is red again. Clearing this
          // is what makes recurrence visible rather than looking like one
          // continuous outage.
          resolvedAt: null,
        },
      });
  }

  // Anything still open but not seen this run has recovered.
  //
  // Keyed on `last_seen_at`, not on a list of live keys: every signal seen this
  // run was upserted just above with `last_seen_at = seenAt`, so "open and not
  // seen this run" is exactly `last_seen_at < seenAt` — ONE bound value however
  // many signals exist. Bounded by construction, not by a chunk constant.
  await db
    .update(staleRedSignals)
    .set({ resolvedAt: seenAt })
    .where(and(isNull(staleRedSignals.resolvedAt), lt(staleRedSignals.lastSeenAt, seenAt)));
}
