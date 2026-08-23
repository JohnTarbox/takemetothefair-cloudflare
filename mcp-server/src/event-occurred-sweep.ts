/**
 * K27 — daily OCCURRED auto-transition sweep (+ rollover).
 *
 * Premise: there was NO automated SCHEDULED→OCCURRED transition before K27 —
 * OCCURRED was set only by the one-time migration 0067 backfill and the manual
 * update_event_lifecycle tool, so past-end events sat in SCHEDULED indefinitely.
 * This sweep closes that gap and folds the recurring-event rollover into the
 * same pass.
 *
 * Two passes, both cosmetic-failsoft (each catches its own errors and logs to
 * error_logs — a single bad row never aborts the run or the sibling crons it
 * shares the daily Promise.all with):
 *
 *   Pass 1 — transition + roll. APPROVED events whose end_date has passed move
 *     SCHEDULED/RESCHEDULED/MOVED_ONLINE → OCCURRED (mirroring 0067's
 *     conservatism: only APPROVED auto-occur). Each transition then attempts a
 *     rollover. Transition and rollover are independently failsoft, so a roll
 *     failure never unwinds a committed transition.
 *
 *   Pass 2 — backfill rolls for events already OCCURRED with a recurrence rule
 *     (e.g. the 0067-backfilled corpus once their rules are seeded), EXCLUDING
 *     rows transitioned in this same run (lifecycle_status_changed_at == now)
 *     so Pass-1 rows are owned solely by Pass 1. rolloverEventIfRecurring is
 *     idempotent, so this is safe even if the exclusion misses.
 */
import { eq, and, or, inArray, lt, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { events, adminActions, promoters, eventVendors } from "./schema.js";
import { rolloverEventIfRecurring } from "./event-rollover.js";
import { logError } from "./logger.js";
import { chunkIds } from "@takemetothefair/utils";
import type { Db } from "./db.js";

/** Per-run bounds — keep the sweep within cron CPU/subrequest limits. */
const TRANSITION_LIMIT = 200;
const BACKFILL_LIMIT = 200;
/** OPE-13 — per-run cap on the vendor-roster NEEDS_RESEARCH enqueue (Pass 3). */
const ROSTER_ENQUEUE_LIMIT = 200;

/**
 * OPE-525 — how many non-sponsor vendor links count as "we already hold this
 * roster", so the sweep stamps HAS_ROSTER instead of queueing research.
 *
 * 10 is drawn from the prod distribution of the rows this fixed, not picked for
 * roundness. Of the 34 already-linked events the sweep had stamped
 * NEEDS_RESEARCH, 15 carried >=10 non-sponsor links and held 1,396 of the 1,440
 * links between them (97%); the remaining 19 held 44 links, thirteen of them
 * three or fewer. So the threshold separates "an ingested exhibitor list" from
 * "a couple of vendors we happen to know about", and the latter genuinely does
 * still need research - re-surfacing those is correct, not a bug.
 */
const ROSTER_EVIDENCE_MIN = 10;

const SOURCE = "mcp/event-occurred-sweep";

export interface OccurredSweepResult {
  transitioned: number;
  rolledFromTransition: number;
  rolledFromBackfill: number;
  /** OPE-13 — events seeded into the vendor-roster NEEDS_RESEARCH queue. */
  rosterEnqueued: number;
  /** OPE-525/527 — events stamped HAS_LINKS_UNVERIFIED because they already held >=ROSTER_EVIDENCE_MIN non-sponsor links. */
  rosterAlreadyHeld: number;
  /** OPE-31 — events seeded straight to NO_PUBLIC_LIST because their producer is
   *  flagged vendor_roster_publishes_lists = false (never publishes a roster). */
  rosterNoPublicList: number;
  errors: number;
  /** True when a pass returned a full page (== LIMIT) — more rows remain and
   *  will be handled on the next daily run. Surfaces the otherwise-silent cap. */
  transitionLimitHit: boolean;
  backfillLimitHit: boolean;
  rosterEnqueueLimitHit: boolean;
}

export async function runOccurredTransitionSweep(
  db: Db,
  opts?: { now?: Date }
): Promise<OccurredSweepResult> {
  const now = opts?.now ?? new Date();
  const result: OccurredSweepResult = {
    transitioned: 0,
    rolledFromTransition: 0,
    rolledFromBackfill: 0,
    rosterEnqueued: 0,
    rosterAlreadyHeld: 0,
    rosterNoPublicList: 0,
    errors: 0,
    transitionLimitHit: false,
    backfillLimitHit: false,
    rosterEnqueueLimitHit: false,
  };

  // --- Pass 1: transition past-end APPROVED events to OCCURRED, then roll ----
  let pass1: { id: string; slug: string; lifecycleStatus: string }[] = [];
  try {
    pass1 = await db
      .select({ id: events.id, slug: events.slug, lifecycleStatus: events.lifecycleStatus })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          inArray(events.lifecycleStatus, ["SCHEDULED", "RESCHEDULED", "MOVED_ONLINE"]),
          isNotNull(events.endDate),
          lt(events.endDate, now),
          isNull(events.mergedInto)
        )
      )
      .orderBy(events.endDate)
      .limit(TRANSITION_LIMIT);
  } catch (error) {
    result.errors++;
    await logError(db, { message: "[occurred-sweep] pass-1 select failed", error, source: SOURCE });
  }

  if (pass1.length === TRANSITION_LIMIT) {
    result.transitionLimitHit = true;
    await logError(db, {
      level: "warn",
      message: `[occurred-sweep] pass-1 hit transition cap (${TRANSITION_LIMIT}); remainder deferred to next run`,
      source: SOURCE,
    }).catch(() => {});
  }

  for (const ev of pass1) {
    try {
      await db.batch([
        db
          .update(events)
          .set({
            lifecycleStatus: "OCCURRED",
            lifecycleStatusChangedAt: now,
            lifecycleReason: "auto: end date passed",
            updatedAt: now,
          })
          .where(eq(events.id, ev.id)),
        db.insert(adminActions).values({
          action: "event.lifecycle_change",
          actorUserId: null,
          targetType: "event",
          targetId: ev.id,
          payloadJson: JSON.stringify({
            previous_lifecycle: ev.lifecycleStatus,
            new_lifecycle: "OCCURRED",
            reason: "auto: end date passed",
            slug: ev.slug,
            via: "occurred-sweep",
          }),
          createdAt: now,
        }),
      ]);
      result.transitioned++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] transition failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
      continue;
    }

    // Rollover is independently failsoft — a failure here must not unwind the
    // committed OCCURRED transition above.
    try {
      const roll = await rolloverEventIfRecurring(db, ev.id, {
        via: "cron",
        actorUserId: null,
        now,
      });
      if (roll.created) result.rolledFromTransition++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] rollover failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
    }
  }

  // --- Pass 2: backfill rolls for already-OCCURRED recurring events ----------
  let pass2: { id: string }[] = [];
  try {
    pass2 = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.lifecycleStatus, "OCCURRED"),
          isNotNull(events.recurrenceRule),
          isNull(events.mergedInto),
          // Exclude rows flipped to OCCURRED in THIS run (changedAt == now);
          // those were already handled by Pass 1. NULL changedAt = migration-
          // backfilled historical OCCURRED → include.
          or(isNull(events.lifecycleStatusChangedAt), lt(events.lifecycleStatusChangedAt, now))
        )
      )
      .limit(BACKFILL_LIMIT);
  } catch (error) {
    result.errors++;
    await logError(db, { message: "[occurred-sweep] pass-2 select failed", error, source: SOURCE });
  }

  if (pass2.length === BACKFILL_LIMIT) {
    result.backfillLimitHit = true;
    await logError(db, {
      level: "warn",
      message: `[occurred-sweep] pass-2 hit backfill cap (${BACKFILL_LIMIT}); remainder deferred to next run`,
      source: SOURCE,
    }).catch(() => {});
  }

  for (const ev of pass2) {
    try {
      const roll = await rolloverEventIfRecurring(db, ev.id, {
        via: "cron",
        actorUserId: null,
        now,
      });
      if (roll.created) result.rolledFromBackfill++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] backfill rollover failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
    }
  }

  // --- Pass 3 (OPE-13): seed the vendor-roster NEEDS_RESEARCH queue ----------
  // The "just-occurred trigger" from the playbook. Enqueues every OCCURRED event
  // whose vendor_roster_status is still NULL (never evaluated) — which is BOTH
  // the rows Pass 1 just transitioned this run AND the historical OCCURRED corpus
  // from before the rails existed. Because Pass 1 leaves roster status untouched,
  // a single bulk update here covers the new and backfill cases at once.
  //
  // Guard semantics: IS NULL only, so a researched terminal state
  // (HAS_ROSTER / NO_PUBLIC_LIST / PARTIAL set by the research worker) is NEVER
  // clobbered — the dead-end stays sticky and the system converges. Capped per
  // run like the other passes; the remainder seeds over subsequent daily runs.
  // Soft-deleted/merged tombstones (merged_into) are excluded.
  //
  // OPE-525 — this used to read "the worker's own pre-check (skip if
  // list_event_vendors already populated) dedups events that happen to already
  // carry links, so enqueuing on NULL is safe." Prod falsified it: 34 OCCURRED
  // events carrying 1,440 CONFIRMED/APPROVED links had all been stamped
  // NEEDS_RESEARCH here, and the weekly drain re-surfaced them indefinitely.
  //
  // The assumption was not wrong so much as unenforceable: the "worker" is a
  // skill in another repo on another machine, so this sweep could never hold it
  // to that contract. The dedup now happens HERE, where it can be tested.
  try {
    const toEnqueue = await db
      .select({
        id: events.id,
        // OPE-31 — producer's roster-publishing flag (leftJoin promoters).
        // false ⇒ this producer never publishes a roster → NO_PUBLIC_LIST.
        publishesLists: promoters.vendorRosterPublishesLists,
      })
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        and(
          eq(events.lifecycleStatus, "OCCURRED"),
          isNull(events.vendorRosterStatus),
          isNull(events.mergedInto)
        )
      )
      .limit(ROSTER_ENQUEUE_LIMIT);

    if (toEnqueue.length === ROSTER_ENQUEUE_LIMIT) {
      result.rosterEnqueueLimitHit = true;
      await logError(db, {
        level: "warn",
        message: `[occurred-sweep] pass-3 hit roster-enqueue cap (${ROSTER_ENQUEUE_LIMIT}); remainder deferred to next run`,
        source: SOURCE,
      }).catch(() => {});
    }

    // OPE-31 — producers flagged "never publishes a roster" skip the research
    // queue: their events go straight to NO_PUBLIC_LIST so passes don't re-grind
    // the same producer-wide dead-end. Only an explicit `false` diverts; NULL
    // (unknown) and `true` keep today's NEEDS_RESEARCH behavior.
    // OPE-525 — count roster-grade links the event ALREADY holds, so a show whose
    // exhibitor list was ingested months ago is not queued as unresearched.
    //
    // SPONSOR_ONLY is excluded deliberately: a sponsor is not a vendor roster.
    // Three of the affected prod events had sponsors as their ONLY links, and
    // counting those would have stamped HAS_ROSTER on an event we genuinely
    // have never rostered - removing it from research on false evidence, which
    // is worse than the bug being fixed.
    const linkCounts = new Map<string, number>();
    for (const batch of chunkIds(toEnqueue.map((e) => e.id))) {
      const rows = await db
        .select({ eventId: eventVendors.eventId, n: sql<number>`COUNT(*)` })
        .from(eventVendors)
        .where(
          and(
            inArray(eventVendors.eventId, batch),
            inArray(eventVendors.status, ["CONFIRMED", "APPROVED"]),
            or(
              isNull(eventVendors.participationType),
              ne(eventVendors.participationType, "SPONSOR_ONLY")
            )
          )
        )
        .groupBy(eventVendors.eventId);
      for (const r of rows) linkCounts.set(r.eventId, Number(r.n));
    }

    const alreadyRosteredIds = toEnqueue
      .filter((e) => (linkCounts.get(e.id) ?? 0) >= ROSTER_EVIDENCE_MIN)
      .map((e) => e.id);
    const rosteredSet = new Set(alreadyRosteredIds);
    const remaining = toEnqueue.filter((e) => !rosteredSet.has(e.id));

    const noPublicListIds = remaining.filter((e) => e.publishesLists === false).map((e) => e.id);
    const needsResearchIds = remaining.filter((e) => e.publishesLists !== false).map((e) => e.id);

    // OPE-241 — chunked writes: ROSTER_ENQUEUE_LIMIT is 200, i.e. ABOVE D1's
    // 100-bound-param cap, so a full pass already throws "too many SQL
    // variables" and loses the whole enqueue. chunkIds (not chunkedInArray)
    // because these are UPDATEs — there are no rows to merge.
    for (const batch of chunkIds(noPublicListIds)) {
      await db
        .update(events)
        .set({ vendorRosterStatus: "NO_PUBLIC_LIST", updatedAt: now })
        .where(inArray(events.id, batch));
    }
    result.rosterNoPublicList = noPublicListIds.length;

    for (const batch of chunkIds(needsResearchIds)) {
      await db
        .update(events)
        .set({ vendorRosterStatus: "NEEDS_RESEARCH", updatedAt: now })
        .where(inArray(events.id, batch));
    }
    result.rosterEnqueued = needsResearchIds.length;

    // OPE-527 — writes HAS_LINKS_UNVERIFIED, not HAS_ROSTER.
    //
    // The first cut of this guard (OPE-525) wrote HAS_ROSTER and stamped
    // checked_at, reasoning that "links exist" is a determination made from
    // evidence already in the database. That reasoning was wrong in a way worth
    // recording: HAS_ROSTER is TERMINAL, so it is never revisited, and this
    // sweep has no idea where those links came from. It turned a visible gap
    // (a populated row reading NEEDS_RESEARCH — safe, self-correcting, costs a
    // wasted pass) into an invisible one (a permanent unattributed claim that
    // someone researched this roster). 14 prod rows got that treatment.
    //
    // checked_at is deliberately NOT stamped: no check occurred, and a
    // timestamp would be a second claim nobody made.
    for (const batch of chunkIds(alreadyRosteredIds)) {
      await db
        .update(events)
        .set({ vendorRosterStatus: "HAS_LINKS_UNVERIFIED", updatedAt: now })
        .where(inArray(events.id, batch));
    }
    result.rosterAlreadyHeld = alreadyRosteredIds.length;
  } catch (error) {
    result.errors++;
    await logError(db, {
      message: "[occurred-sweep] pass-3 roster enqueue failed",
      error,
      source: SOURCE,
    });
  }

  // Heartbeat: one info-level row per run so a healthy sweep is distinguishable
  // from a silently-broken one (a sweep that never runs also writes nothing).
  // Mirrors the inbound-email stale-sweep heartbeat.
  console.log(
    `[occurred-sweep] transitioned=${result.transitioned} ` +
      `rolledFromTransition=${result.rolledFromTransition} ` +
      `rolledFromBackfill=${result.rolledFromBackfill} rosterEnqueued=${result.rosterEnqueued} rosterAlreadyHeld=${result.rosterAlreadyHeld} ` +
      `errors=${result.errors} ` +
      `transitionLimitHit=${result.transitionLimitHit} backfillLimitHit=${result.backfillLimitHit} ` +
      `rosterEnqueueLimitHit=${result.rosterEnqueueLimitHit}`
  );
  await logError(db, {
    level: "info",
    source: SOURCE,
    message: "occurred-sweep run completed",
    context: {
      transitioned: result.transitioned,
      rolledFromTransition: result.rolledFromTransition,
      rolledFromBackfill: result.rolledFromBackfill,
      rosterEnqueued: result.rosterEnqueued,
      errors: result.errors,
      transitionLimitHit: result.transitionLimitHit,
      backfillLimitHit: result.backfillLimitHit,
      rosterEnqueueLimitHit: result.rosterEnqueueLimitHit,
    },
  }).catch(() => {});

  return result;
}
