/**
 * OPE-447 — how long has IndexNow actually been down?
 *
 * ---------------------------------------------------------------------------
 * What the alert was measuring, and why it kept "resetting"
 * ---------------------------------------------------------------------------
 *
 * The `indexnow:health` alert reported a day count that dropped twice: 20 → 3
 * on 2026-07-18, and 23 → 6 on 2026-08-11. It was filed as a fabricated number.
 * It is not fabricated. Every figure it ever printed was ACCURATE — it was
 * accurate about the wrong thing.
 *
 * The age is parsed (indexnow.ts `maybeAlertStalePause`) out of an ISO
 * timestamp embedded in the VALUE of the `indexnow:paused` KV key. That value
 * is rewritten every time an operator re-engages the pause. And `admin_actions`
 * shows the operator doing exactly that, three times, in an identical pattern:
 *
 *   2026-06-27 03:06:32  indexnow.resume     ← pause lifted
 *   2026-06-27 03:07:13  indexnow.resubmit   ← probe Bing … HTTP 429
 *   2026-06-27 03:07:44  indexnow.pause      ← re-engaged, 31s later
 *
 *   2026-07-18 01:43:34 / 01:44:11 (429) / 01:44:44   ← same shape
 *   2026-08-11 03:07:40 / 03:08:20 (429) / 03:08:44   ← same shape
 *
 * So the counter reset because the pause genuinely restarted. The operator was
 * doing the right thing — periodically testing whether Bing's per-host penalty
 * had decayed — and the alert's clock was anchored to the state flag being
 * tested. **An outage clock anchored to a pause flag resets every time somebody
 * checks whether the outage is over.**
 *
 * Both hypotheses in the ticket were wrong, worth recording so they are not
 * re-investigated: `indexnow:paused` carries NO TTL (neither the auto-latch nor
 * `setIndexNowPaused` passes `expirationTtl`), and the age calculation never
 * reads the throttle key `indexnow:stale_pause_alerted_at` at all.
 *
 * ---------------------------------------------------------------------------
 * What an operator actually needs
 * ---------------------------------------------------------------------------
 *
 * Two different numbers, and the alert conflated them:
 *
 *   PAUSE AGE     how long the current pause has been engaged. Real, useful
 *                 for "did I forget to lift this", and correctly reset by a
 *                 deliberate re-pause.
 *   OUTAGE AGE    how long since Bing last ACCEPTED a submission. This is the
 *                 severity number — the one that decides escalation — and it
 *                 must not move when the pause is cycled.
 *
 * Outage age is anchored to the last `status='success'` row in
 * `indexnow_submissions`, which the real ping path writes (indexnow.ts ~L595 /
 * ~L633). A success is a fact about Bing, not about our own flags, so probing
 * and re-pausing cannot disturb it.
 *
 * ---------------------------------------------------------------------------
 * The seed, and why it is evidence rather than a guess
 * ---------------------------------------------------------------------------
 *
 * `indexnow_submissions` currently holds no success row at all — its earliest
 * row of any kind is 2026-07-18, so it cannot see back to the last good
 * submission. Without a floor the outage age would read as 0 ("no failure on
 * record"), which is the same silence this ticket is about.
 *
 * So the anchor falls back to a seeded epoch in `tunable_thresholds`, set to
 * 2026-06-13T02:47:47Z. That is not an estimate: it is the timestamp of the
 * last `admin_actions` row showing Bing accepting anything —
 * `search_pings.flush` with `"indexnow_response":"ok"`. Every attempt after it
 * failed (06-13 429, 07-04 503, 06-27 429, 07-18 429, 08-11 503 then 429).
 *
 * ---------------------------------------------------------------------------
 * Why the stored anchor is permanent, not a one-off backfill
 * ---------------------------------------------------------------------------
 *
 * `recordSubmission` probabilistically DELETES submission rows older than 30
 * days. So during any outage longer than 30 days the last success row is
 * guaranteed to be pruned, and the submissions table can never — by itself —
 * measure the outages that matter most.
 *
 * That makes the obvious design a trap. "Prefer the submissions table, fall
 * back to the seed" would behave like this: Bing accepts a submission today,
 * the row ages out 30 days later, and the reader silently reverts to the
 * 2026-06-13 seed and reports a four-month outage while everything is healthy —
 * this ticket's own fabricated-number failure, reintroduced by its fix.
 *
 * So the anchor RATCHETS instead: `advanceIndexNowOutageAnchor` moves it
 * forward on every accepted submission, and the reader takes the LATEST of the
 * stored anchor and any surviving success row. It can never regress, and no
 * pruning schedule can disturb it.
 */

import { desc, eq, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { indexnowSubmissions, tunableThresholds } from "@/lib/db/schema";

/** Matches the handle indexnow.ts threads around: schema-less and nullable,
 *  because the ping path runs in contexts with no DB binding at all. */
type Db = DrizzleD1Database<Record<string, unknown>> | null;

/** Threshold key holding the fallback outage anchor, as a UNIX epoch (seconds). */
export const INDEXNOW_OUTAGE_ANCHOR_KEY = "indexnow_outage_anchor_epoch";

/**
 * Last moment Bing is known to have ACCEPTED a submission, evidenced by
 * `admin_actions` (`search_pings.flush`, `"indexnow_response":"ok"`,
 * 2026-06-13 02:47:47Z). Used only when no `status='success'` row survives in
 * `indexnow_submissions`; a real success always takes precedence.
 */
export const INDEXNOW_LAST_KNOWN_SUCCESS_EPOCH = Math.floor(
  Date.parse("2026-06-13T02:47:47Z") / 1000
);

export interface IndexNowOutage {
  /** Epoch seconds of the last successful submission (real or seeded floor). */
  lastSuccessEpoch: number;
  /** Whole days since that moment. */
  days: number;
  /** True when `lastSuccessEpoch` came from a real submission row rather than
   *  the seeded floor — so the caller can say "at least N days" when seeded. */
  fromRealSuccess: boolean;
}

/**
 * Resolve the outage anchor: the newest real success, else the operator-tunable
 * seed, else the compiled-in evidenced constant.
 *
 * Never throws — this feeds an alert, and an alert that can fail closed on a DB
 * hiccup is one that goes quiet during exactly the incident it exists for.
 */
export async function getIndexNowOutage(db: Db, now: Date = new Date()): Promise<IndexNowOutage> {
  let realSuccessEpoch: number | null = null;
  let storedEpoch: number | null = null;

  // No DB binding — fall straight through to the evidenced constant rather
  // than reporting a zero-length outage.
  if (db) {
    try {
      const [row] = await db
        .select({ timestamp: indexnowSubmissions.timestamp })
        .from(indexnowSubmissions)
        .where(eq(indexnowSubmissions.status, "success"))
        .orderBy(desc(indexnowSubmissions.timestamp))
        .limit(1);
      if (row?.timestamp != null) {
        // `indexnow_submissions.timestamp` is declared `mode: "timestamp"`, so
        // Drizzle hands back a Date, not the raw epoch seconds the column holds.
        // Reading it as a number yields MILLISECONDS, which makes the subtraction
        // below negative and clamps every real success to an age of 0 — an
        // outage silently reported as healthy, i.e. this ticket's own bug class.
        realSuccessEpoch = Math.floor(new Date(row.timestamp).getTime() / 1000);
      }
    } catch {
      /* fall through to the stored anchor */
    }

    try {
      const [seed] = await db
        .select({ value: tunableThresholds.value })
        .from(tunableThresholds)
        .where(eq(tunableThresholds.key, INDEXNOW_OUTAGE_ANCHOR_KEY))
        .limit(1);
      const v = seed?.value;
      if (typeof v === "number" && v > 0) storedEpoch = v;
    } catch {
      /* fall through to the constant */
    }
  }

  // Take the LATEST of the two — never "prefer one source". `recordSubmission`
  // probabilistically DELETES submission rows older than 30 days, so a real
  // success row is guaranteed to disappear during any outage longer than that.
  // An implementation that preferred the submissions table and fell back to the
  // stored anchor would therefore do this: Bing accepts a submission today,
  // the row is pruned 30 days later, and the reader silently reverts to the
  // 2026-06-13 seed and reports a four-month outage while everything is
  // healthy. That is the same fabricated-number failure this ticket is about,
  // reintroduced by its own fix. Max() cannot regress.
  const candidates = [realSuccessEpoch, storedEpoch, INDEXNOW_LAST_KNOWN_SUCCESS_EPOCH].filter(
    (n): n is number => typeof n === "number" && n > 0
  );
  const lastSuccessEpoch = Math.max(...candidates);

  const days = Math.max(0, Math.floor((now.getTime() / 1000 - lastSuccessEpoch) / 86_400));

  return {
    lastSuccessEpoch,
    days,
    // "Real" means the anchor is backed by an observed success — either a live
    // submission row or one that advanced the stored anchor before being
    // pruned. Only the untouched seed counts as unconfirmed.
    fromRealSuccess: lastSuccessEpoch > INDEXNOW_LAST_KNOWN_SUCCESS_EPOCH,
  };
}

/**
 * Advance the durable outage anchor after Bing accepts a submission.
 *
 * Called from the success path so the anchor survives the 30-day pruning of
 * `indexnow_submissions`. Monotonic by construction — it only ever moves
 * forward, so a late or out-of-order call cannot reopen a closed outage.
 *
 * Best-effort: a failure here leaves the anchor stale (the outage reads longer
 * than it is), which is the safe direction. Never throws — this runs inside the
 * ping path and must not break indexing.
 */
export async function advanceIndexNowOutageAnchor(db: Db, when: Date = new Date()): Promise<void> {
  if (!db) return;
  const epoch = Math.floor(when.getTime() / 1000);
  try {
    await db
      .insert(tunableThresholds)
      .values({
        key: INDEXNOW_OUTAGE_ANCHOR_KEY,
        value: epoch,
        unit: "unix_epoch_seconds",
        note: "Last submission Bing accepted. Advanced automatically on success; seeded by drizzle/0198.",
        updatedAt: when,
      })
      .onConflictDoUpdate({
        target: tunableThresholds.key,
        set: { value: epoch, updatedAt: when },
        // Guard the ratchet in SQL as well as in code: concurrent pings and
        // retries must not move the anchor backwards.
        where: lt(tunableThresholds.value, epoch),
      });
  } catch {
    /* best-effort — a stale anchor overstates the outage, which is safe */
  }
}

/**
 * The severity sentence for the health alert.
 *
 * Leads with the outage, because that is the number that decides escalation;
 * the pause age follows as context. Both are labelled, so the two can never
 * again be read as one figure — which is how a 65-day outage got reported to an
 * operator as "6 days".
 *
 * When the anchor is the seeded floor we say "at least", because the true last
 * success may predate it. Overstating certainty here is the failure mode this
 * ticket is about.
 */
export function describeIndexNowOutage(outage: IndexNowOutage, pauseDays: number): string {
  const lead = outage.fromRealSuccess
    ? `Bing has accepted NO IndexNow submission for ${outage.days} days`
    : `Bing has accepted NO IndexNow submission for at least ${outage.days} days`;
  const since = new Date(outage.lastSuccessEpoch * 1000).toISOString().slice(0, 10);
  return (
    `${lead} (last success ${since}). The current pause has been engaged for ` +
    `${pauseDays} days — that is a shorter figure because lifting and re-engaging ` +
    `the pause to probe Bing restarts it; the outage number above does not move.`
  );
}
