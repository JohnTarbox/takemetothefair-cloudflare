/**
 * OPE-532 ruling part 2 — a bounded expiry for rows waiting on a submitter.
 *
 * When we cannot find a link in an inbound submission we ask the sender for
 * one and write `reply_kind='no-url'`, `status='replied'`. Nothing then reads
 * that state: it is not a salvage candidate (a human cannot act on it — the
 * ball is in the submitter's court) and it is not a success. So it accumulates.
 * On 2026-08-31 there were 16 such rows, the oldest 89 days old, **four times**
 * the threshold John ruled on 2026-08-27.
 *
 * ── Derived, not written — and that is the load-bearing choice ───────────
 *
 * The obvious reading of "auto-close" is a status write. This does not write.
 * Expiry is COMPUTED from `received_at`, exactly as `unrouted-hold.ts` computes
 * its 14-day hold expiry, for three reasons:
 *
 *   1. The reopening comment's hard constraint: *"expiring a row must not make
 *      it invisible. An auto-close that silently drops rows out of every
 *      counter recreates the defect with a tidier name."* Nothing is destroyed
 *      here, so an expired row stays as countable as it ever was.
 *   2. `expired` stays distinguishable from `resolved by a human`, which is a
 *      different fact and is recorded differently (`resulting_event_id`, or a
 *      disposed status). A single terminal status would conflate them.
 *   3. It is recomputable. Change the threshold and yesterday's answer changes
 *      with it; a written status would need a backfill and would preserve a
 *      decision made under the old number.
 *
 * The caller supplies `now` rather than this module reaching for a clock, so
 * the boundary is testable to the second — same reason `holdExpiryCutoff` does.
 */
import {
  AWAITING_SUBMITTER_REPLY_KINDS,
  AWAITING_SUBMITTER_EXPIRY_DAYS,
  DISPOSED_INBOUND_STATUSES,
} from "@takemetothefair/constants";

export type AwaitingSubmitterKind = (typeof AWAITING_SUBMITTER_REPLY_KINDS)[number];

/**
 * Where a row stands relative to the submitter.
 *
 * `not-awaiting` covers everything the queue is not about, including rows a
 * human already disposed of — folding those into `expired` would report a
 * resolved row as one that timed out.
 */
export type AwaitingSubmitterState = "not-awaiting" | "waiting" | "expired";

export interface AwaitingSubmitterRow {
  replyKind: string | null | undefined;
  status: string | null | undefined;
  receivedAt: Date | null | undefined;
  /** Non-null ⇒ the submission landed after all; nobody is waiting. */
  resultingEventId: string | null | undefined;
}

/** True when this reply kind means WE asked and are waiting on THEM. */
export function isAwaitingSubmitterKind(
  replyKind: string | null | undefined
): replyKind is AwaitingSubmitterKind {
  return (AWAITING_SUBMITTER_REPLY_KINDS as readonly string[]).includes(replyKind ?? "");
}

/**
 * The instant before which an unanswered row is past its bound.
 *
 * Returned as a Date the caller compares `received_at` against, so the
 * comparison is visible at the call site instead of hidden in here.
 */
export function awaitingSubmitterCutoff(
  now: Date,
  days: number = AWAITING_SUBMITTER_EXPIRY_DAYS
): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Classify one row.
 *
 * Order matters and each guard earns its place:
 *   - a kind we do not own is never ours to expire;
 *   - a row that produced an event was answered, whatever its reply kind;
 *   - a row a human disposed of is settled, not timed out;
 *   - a row with no `received_at` cannot be aged, so it stays `waiting` rather
 *     than being expired on a missing value. Expiring on absent data is how a
 *     clean-up silently eats rows it could not measure.
 */
export function classifyAwaitingSubmitter(
  row: AwaitingSubmitterRow,
  now: Date,
  days: number = AWAITING_SUBMITTER_EXPIRY_DAYS
): AwaitingSubmitterState {
  if (!isAwaitingSubmitterKind(row.replyKind)) return "not-awaiting";
  if (row.resultingEventId) return "not-awaiting";
  if ((DISPOSED_INBOUND_STATUSES as readonly string[]).includes(row.status ?? "")) {
    return "not-awaiting";
  }
  if (!(row.receivedAt instanceof Date) || Number.isNaN(row.receivedAt.getTime())) {
    return "waiting";
  }
  return row.receivedAt.getTime() < awaitingSubmitterCutoff(now, days).getTime()
    ? "expired"
    : "waiting";
}

export interface AwaitingSubmitterCounts {
  waiting: number;
  expired: number;
  /** Oldest still-waiting row, in whole days. Null when none are waiting. */
  oldestWaitingDays: number | null;
}

/**
 * Roll a set of rows up for the operator notice.
 *
 * Reports BOTH numbers on purpose. "Expired" is the bound doing its job and
 * needs no action; "waiting" is the live queue. Publishing only the total would
 * make a growing backlog and a working expiry look identical, which is the
 * failure this whole ticket is about.
 */
export function summariseAwaitingSubmitter(
  rows: readonly AwaitingSubmitterRow[],
  now: Date,
  days: number = AWAITING_SUBMITTER_EXPIRY_DAYS
): AwaitingSubmitterCounts {
  let waiting = 0;
  let expired = 0;
  let oldestWaitingMs: number | null = null;

  for (const row of rows) {
    const state = classifyAwaitingSubmitter(row, now, days);
    if (state === "expired") {
      expired += 1;
    } else if (state === "waiting") {
      waiting += 1;
      if (row.receivedAt instanceof Date && !Number.isNaN(row.receivedAt.getTime())) {
        const age = now.getTime() - row.receivedAt.getTime();
        if (oldestWaitingMs === null || age > oldestWaitingMs) oldestWaitingMs = age;
      }
    }
  }

  return {
    waiting,
    expired,
    oldestWaitingDays:
      oldestWaitingMs === null ? null : Math.floor(oldestWaitingMs / (24 * 60 * 60 * 1000)),
  };
}
