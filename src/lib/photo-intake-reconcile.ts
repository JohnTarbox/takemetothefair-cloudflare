/**
 * OPE-403 — reconcile photo intakes: did the photos we ACKNOWLEDGED actually
 * get stored?
 *
 * ── Why this is not a heartbeat probe ───────────────────────────────────────
 * There is already a `photo-intake` heartbeat probe (`heartbeat.ts:117`) and on
 * 2026-08-15 it was GREEN throughout the failure. It watches
 * `max(inbound_emails.received_at) WHERE intent='photo_intake'`, and the emails
 * kept arriving — five of them. What did not happen was the write at the far end.
 *
 * A liveness probe answers "is this path still producing evidence?" and cannot
 * answer "is the evidence it produces CORRECT?". The same distinction is already
 * written down twice in this codebase — on the OPE-226 photo-effectiveness merge
 * (`stale-red-scan/route.ts:217-223`) and in the OPE-225 image-coverage note —
 * and it recurred here anyway, because the probe watching this lane was pointed
 * at the intake rather than the outcome.
 *
 * So this is a RECONCILIATION: two facts the system already records, compared.
 * `photos_stored = 0` means the attach path ran and stored nothing, while the
 * sender was told which fair their photos were matched to.
 *
 * ── Why it cannot false-fire while the lane is switched off ─────────────────
 * `photos_stored` is only ever written when a photo email is actually processed
 * with image attachments (see `photo-intake.ts`). It is NULL — not 0 — for every
 * other row in the table and for every row predating drizzle/0191. With
 * `PHOTO_VISION_ENABLED="false"` the count is written as 0 precisely because the
 * attach path DID run and DID decline, which is the condition worth reporting:
 * a submitter was told their photos were matched, and nothing was stored.
 *
 * That means this red is expected to fire the first time John emails photos
 * after this ships, and to clear when either the flag is flipped or the rows are
 * drained. That is the intended behaviour, not a bug — the point is that the
 * system says so itself instead of waiting to be asked.
 */
import { sql } from "drizzle-orm";
import { inboundEmails } from "@/lib/db/schema";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { Db } from "@/lib/analytics-overview/shared";

const MS_PER_HOUR = 3_600_000;

/** Where an operator goes to see the affected rows. */
const REVIEW_HREF = "/admin/inbound-emails?flagged=1";

export interface UnstoredPhotoIntakes {
  /** Rows where the attach path ran and stored nothing. */
  count: number;
  /** Oldest such row, the clock this red ages against. Null when count is 0. */
  oldestAt: Date | null;
}

export async function loadUnstoredPhotoIntakes(db: Db): Promise<UnstoredPhotoIntakes> {
  // OPE-403 follow-up — `photos_stored = 0` alone OVER-REPORTS.
  //
  // Only the classifier's "general fair scene" bucket becomes a gallery row. A
  // photo identified as a BOOTH is routed to `admin_actions` for review and
  // correctly produces zero gallery rows, so keying purely on `photos_stored=0`
  // would raise a P0 on the happy path. Exclude any email that produced a booth
  // proposal — those photos are accounted for and drainable.
  //
  // NOT EXISTS against admin_actions rather than a new column: the staging row
  // already carries `target_id = inbound_emails.id`, so the fact is recorded and
  // does not need to be recorded twice (and two copies could disagree).
  const [r] = await db
    .select({
      n: sql<number | null>`count(*)`,
      oldest: sql<number | null>`min(${inboundEmails.receivedAt})`,
    })
    .from(inboundEmails)
    .where(
      sql`${inboundEmails.photosStored} = 0
          AND NOT EXISTS (
            SELECT 1 FROM admin_actions aa
            WHERE aa.target_id = ${inboundEmails.id}
              AND aa.action = 'vendor.photo_proposed'
          )`
    );

  const count = Number(r?.n ?? 0);
  return {
    count,
    // Timestamps are stored as unix seconds by Drizzle's timestamp mode.
    oldestAt: count > 0 && r?.oldest != null ? new Date(Number(r.oldest) * 1000) : null,
  };
}

/**
 * Turn the reconciliation into a digest red.
 *
 * P0, not P1. The failure mode is that we told a real person their photos were
 * received and matched, and then stored nothing — the OPE-75 digest's whole
 * purpose is that a promise we are not keeping reaches an operator the same day,
 * not that it waits out a 72h P1 leash.
 *
 * Pure and separately exported so the threshold and the copy are testable
 * without a database.
 */
export function assessUnstoredPhotoIntakes(
  state: UnstoredPhotoIntakes,
  now: Date
): StaleRed | null {
  if (state.count === 0 || state.oldestAt === null) return null;

  const hoursInRed = (now.getTime() - state.oldestAt.getTime()) / MS_PER_HOUR;

  return {
    priority: "P0",
    title:
      `Photo intake (OPE-403): ${state.count} email${state.count === 1 ? "" : "s"} ` +
      `acknowledged with a matched fair but stored 0 photos. ` +
      `The sender was told we received them; nothing reached the gallery.`,
    refKey: "photo-intake:acked-unstored",
    href: REVIEW_HREF,
    firstDetectedAt: state.oldestAt.toISOString(),
    hoursInRed,
  };
}

/** Load + assess. Returns [] when healthy, so it merges into `allReds` directly. */
export async function assessPhotoIntakeStorage(db: Db, now: Date): Promise<StaleRed[]> {
  const red = assessUnstoredPhotoIntakes(await loadUnstoredPhotoIntakes(db), now);
  return red ? [red] : [];
}
