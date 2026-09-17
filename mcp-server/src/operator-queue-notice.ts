/**
 * OPE-599 — nothing tells the operator that an actionable queue has something
 * waiting in it.
 *
 * ── The specimen ────────────────────────────────────────────────────────────
 * Kenneth Soares claimed `gooseberry-leather-company` on 2026-07-22 and offered
 * to verify from his business domain. Nobody ever asked. The claim sat PENDING
 * for 36 days and was found only because an unrelated sweep happened to read
 * the table — which at the time held TWO ROWS IN ITS ENTIRE HISTORY. It was not
 * a needle in a haystack; it was a haystack of two, and nothing said to look.
 *
 * `list_claims` exists and works. It is *passive*: an admin has to think to
 * call it. OPE-59 scope 3 asked for the evidence fallback to "surface to admin"
 * and is marked Done — but a queue you can query on request is not surfacing.
 *
 * ── Why one notice covering two queues ──────────────────────────────────────
 * This is a family, not a one-off. `pending_email_replies` held four drafts —
 * real answers written to real people, never delivered — for exactly the same
 * reason: no notifier. Building a bespoke canary per queue is how the fifth
 * silent queue gets missed, so both read through one shape and a third is a
 * few lines.
 *
 * ── Zero-state is silent, and that is load-bearing ─────────────────────────
 * An alert that fires daily regardless becomes wallpaper, which is exactly how
 * the existing canaries stay useful. No row waiting → no mail.
 *
 * Note this differs deliberately from the OPE-510 list-balance canary, which
 * nags every day for as long as the invariant is broken. That one reports a
 * broken INVARIANT, where a steady count means people are still being harmed.
 * This one reports a WORK QUEUE, where a steady count means the operator has
 * seen it and has not got to it yet — and re-nagging that is what trains
 * someone to filter the sender.
 */
import { and, eq, gte, isNull, inArray, lte, sql } from "drizzle-orm";
import {
  entityClaims,
  pendingEmailReplies,
  emailSendLedger,
  operatorOutboundDrafts,
  inboundEmails,
  users,
  tunableThresholds,
} from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
import { toIsoDateOnly, toIsoDateOnlyInVenueZone } from "@takemetothefair/datetime";
// OPE-611 — the third queue. This file's own docblock predicted it ("a third
// is a few lines"); the alternative was a bespoke notifier, which is how the
// fourth silent queue gets missed.
import {
  readTentativePromotionQueue,
  selectImminentTentative,
  formatTentativeLine,
  IMMINENT_DAYS,
  IMMINENT_SECONDS,
} from "./events/tentative-queue.js";

const SOURCE = "mcp:schedule:operator-queue-notice";

/** `email_send_ledger.source` for this notice — also its once-per-day key. */
export const NOTICE_EMAIL_SOURCE = "operator-queue-notice";

/**
 * How long a row may wait before it is worth an email.
 *
 * ⚠️ PLACEHOLDER. OPE-599 records that John owes the real number, and the same
 * question is open on the public-submission lane, whose form promises 24–48h
 * against 0-of-6 observed compliance. 48h is the ticket's own placeholder and
 * is used here so the alert exists at all — silence was the defect. Changing it
 * is a one-line change and needs no rework.
 */
export const QUEUE_SLA_HOURS = 48;

/**
 * OPE-761 — how long the inbound workflow hibernates on its `admin-decision`
 * `waitForEvent` before giving up and sending a generic acknowledgment.
 *
 * Mirrors `timeout: "7 days"` at `mcp-server/src/workflows/inbound-email.ts`
 * (the `step.waitForEvent<AdminDecision>("admin-decision", …)` call). Kept as a
 * named constant HERE rather than imported because the workflow module pulls in
 * the Workflows runtime; the number is asserted against that literal by test.
 *
 * This is the cliff, and it is why this queue's line reports time REMAINING
 * rather than only time elapsed. Measured in prod 2026-09-02: every automated
 * acknowledgment ever sent on the correction / press / claim_request lanes —
 * 10 of 10 in `email_send_ledger` — fired at a gap of 7.0001 days. Not one is
 * a prompt ack; every single one is this timeout expiring. Past the cliff the
 * sender gets a generic reply and the correction they wrote in never happens.
 */
export const ADMIN_DECISION_TIMEOUT_HOURS = 168;

/**
 * OPE-599 rework — the verification grace window, read from the SAME
 * `tunable_thresholds` row the queue-drain page uses (OPE-637), with the same
 * fail-open default and clamp. The MCP Worker cannot import `src/lib`, so these
 * three numbers are mirrored and a test pins them to
 * `src/lib/verification-threshold.ts`.
 */
export const VERIFICATION_GRACE_KEY = "verification_alert_threshold_hours";
export const DEFAULT_VERIFICATION_GRACE_HOURS = 48;
export const VERIFICATION_GRACE_FLOOR_HOURS = 12;
export const VERIFICATION_GRACE_CEILING_HOURS = 168;

export interface OperatorQueueCounts {
  /** entity_claims rows PENDING or DISPUTED past the SLA. */
  agedClaims: number;
  /** pending_email_replies drafts still awaiting review past the SLA. */
  agedReplies: number;
  /**
   * OPE-596 — operator-initiated drafts awaiting a human decision. Each is a
   * message somebody intends to send to a real person and nobody has ruled on.
   */
  pendingOperatorDrafts: number;
  /**
   * OPE-626 — customer-facing `reply:*` emails delivered in the last 24h on a
   * path the `EMAIL_REPLY_ENABLED` gate cannot reach. Zero when the flag is
   * on, because then the sends are intended rather than a bypass.
   */
  ungatedReplies: number;
  /**
   * OPE-611 — upcoming APPROVED+TENTATIVE events within IMMINENT_DAYS of
   * opening that already carry organizer-grade provenance. Unlike the two
   * above this is NOT an age measure: these rows became urgent by the calendar
   * moving toward them, not by sitting still.
   */
  imminentTentative: number;
  /**
   * OPE-761 — inbound emails hibernating on the workflow's `admin-decision`
   * pause (`status='waiting'`) past the SLA. Each is a person who wrote to us
   * and has had no answer, on a clock that ends in a generic ack rather than
   * an answer.
   */
  agedAwaitingDecision: number;
  /**
   * OPE-760 — inbound emails in the last 7 days where a NON-furniture
   * attachment was dropped by the count cap. A file the sender meant to send
   * and we did not keep.
   *
   * Like the ungated-reply line this is an INVARIANT, not a work queue: it
   * should be zero, and a non-zero value means data was lost, not that
   * somebody has not got to it yet.
   */
  droppedRealAttachments: number;
  /**
   * OPE-1011 — upcoming public events whose `start_date` or `public_start_date`
   * renders a DIFFERENT calendar date in America/New_York than in UTC.
   *
   * An INVARIANT, like the two above: it should be zero, and a non-zero value is
   * a wrong date on a live page, not a queue somebody has not got to.
   */
  venueDateShifts: number;
  /**
   * OPE-599 rework (OPE-177's routing instruction, 2026-08-14: "Route it to the
   * operator alert channel, not a robot inbox") — people who could not finish
   * signing up, counted on ARRIVAL rather than as standing depth:
   *   - auth mail whose delivery event says bounced / rejected / failed, sent in
   *     the last 24h;
   *   - a real registration whose delivered verification mail crossed the grace
   *     window unconfirmed in the last 24h.
   * Standing depth would be wallpaper — `unconfirmed_auth_email` sat at 13 and
   * is a ceiling on drop-off, not a fault count. Each person appears on exactly
   * one day's notice.
   */
  authEmailProblems: number;
  /** Oldest waiting row in either queue, in days. */
  oldestDays: number;
  /** Human-readable lines for the alert body. */
  lines: string[];
}

/**
 * Pure decision — exported for tests.
 *
 * Zero-state silence is the FIRST condition, deliberately: it is the property
 * the ticket calls out and the one that keeps this from becoming wallpaper.
 */
export function decideOperatorQueueNotice(
  counts: Pick<
    OperatorQueueCounts,
    | "agedClaims"
    | "agedReplies"
    | "imminentTentative"
    | "ungatedReplies"
    | "pendingOperatorDrafts"
    | "agedAwaitingDecision"
    | "droppedRealAttachments"
    | "venueDateShifts"
    | "authEmailProblems"
  >,
  alreadySentToday: boolean
): boolean {
  if (totalWaiting(counts) <= 0) return false;
  return !alreadySentToday;
}

/**
 * One definition of "is there anything to say", used by the decision, the
 * early return and the subject line.
 *
 * It is a named function rather than three inline sums because OPE-611 added
 * the third term: two of the three call sites were updated by hand when the
 * second queue landed, and a queue missing from the early-return sum is silent
 * in exactly the way this whole file exists to prevent.
 */
export function totalWaiting(
  counts: Pick<
    OperatorQueueCounts,
    | "agedClaims"
    | "agedReplies"
    | "imminentTentative"
    | "ungatedReplies"
    | "pendingOperatorDrafts"
    | "agedAwaitingDecision"
    | "droppedRealAttachments"
    | "venueDateShifts"
    | "authEmailProblems"
  >
): number {
  // `?? 0` per term is not defensive clutter — it is load-bearing, and adding
  // OPE-611's field proved it. A missing term makes the sum NaN, `NaN <= 0` is
  // FALSE, and the notice therefore fires on a COMPLETELY EMPTY queue: the
  // exact wallpaper failure this file is built to avoid, reached by trying to
  // add a queue to it. The existing OPE-599 zero-state test caught it.
  //
  // TypeScript does not cover this: `mcp-server/tsconfig.json` includes only
  // `src/**/*.ts`, so no test file is typechecked and a call site there can
  // omit a field silently. The guard is in the direction that matters — a
  // dropped queue under-counts and stays quiet, rather than alerting always.
  return (
    (counts.agedClaims ?? 0) +
    (counts.agedReplies ?? 0) +
    (counts.imminentTentative ?? 0) +
    (counts.ungatedReplies ?? 0) +
    (counts.pendingOperatorDrafts ?? 0) +
    // OPE-761 is the fifth term, and this file's own warning above is why it
    // carries `?? 0` like every other: a term omitted at an untypechecked test
    // call site makes the sum NaN, and `NaN <= 0` is false, so the notice fires
    // on a completely empty queue.
    (counts.agedAwaitingDecision ?? 0) +
    (counts.droppedRealAttachments ?? 0) +
    (counts.venueDateShifts ?? 0) +
    (counts.authEmailProblems ?? 0)
  );
}

/**
 * OPE-626 — should the ungated-reply line appear at all?
 *
 * ⚠️ Unlike the other three, this is an INVARIANT, not a work queue — so it is
 * allowed to repeat every day for as long as it holds. A steady count here
 * does not mean "seen, not yet got to"; it means unreviewed mail is STILL
 * reaching customers on a path the operator believes is switched off. That is
 * the OPE-510 canary's shape, and the distinction is the one this file already
 * draws for the other queues.
 *
 * Silent when the flag is ON: those sends are then intended, and reporting
 * them as a bypass would be false.
 */
export function shouldReportUngatedReplies(
  sentLast24h: number,
  replyEnabled: string | undefined
): boolean {
  if (replyEnabled === "true") return false;
  return sentLast24h > 0;
}

/** Mirrors `loadVerificationGraceHours` in src/lib/verification-threshold.ts. */
async function loadGraceHours(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, VERIFICATION_GRACE_KEY))
      .limit(1);
    const v = row?.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return DEFAULT_VERIFICATION_GRACE_HOURS;
    }
    return Math.min(VERIFICATION_GRACE_CEILING_HOURS, Math.max(VERIFICATION_GRACE_FLOOR_HOURS, v));
  } catch {
    return DEFAULT_VERIFICATION_GRACE_HOURS;
  }
}

/** Start of the current UTC day — the debounce window boundary. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Read both queues. Exported so a test can seed real backdated rows and assert
 * the counts, rather than mocking a clock.
 */
export async function readOperatorQueues(
  db: Db,
  now: Date,
  // Structural, not `Pick<Env, …>`: the mcp-server `Env` interface does not
  // declare EMAIL_REPLY_ENABLED at all — `queue-consumers.ts` reads it through
  // its own local interface. Worth noting on OPE-626: the flag has no single
  // typed home, which is part of why it has no single enforcement point.
  env?: { EMAIL_REPLY_ENABLED?: string }
): Promise<OperatorQueueCounts> {
  const cutoff = new Date(now.getTime() - QUEUE_SLA_HOURS * 3600_000);
  const lines: string[] = [];
  let oldestMs = 0;

  const claims = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
      method: entityClaims.method,
      status: entityClaims.status,
      createdAt: entityClaims.createdAt,
      email: users.email,
    })
    .from(entityClaims)
    .leftJoin(users, eq(entityClaims.userId, users.id))
    .where(
      and(
        inArray(entityClaims.status, ["PENDING", "DISPUTED"]),
        isNull(entityClaims.decidedAt),
        lte(entityClaims.createdAt, cutoff)
      )
    );

  for (const c of claims) {
    const ageMs = now.getTime() - (c.createdAt?.getTime() ?? now.getTime());
    oldestMs = Math.max(oldestMs, ageMs);
    lines.push(
      `claim ${c.status} ${Math.floor(ageMs / 86400_000)}d — ${c.entityType} ${c.entityId} ` +
        `via ${c.method} — ${c.email ?? "(no address)"}`
    );
  }

  const replies = await db
    .select({
      id: pendingEmailReplies.id,
      to: pendingEmailReplies.toAddress,
      subject: pendingEmailReplies.subject,
      requestedAt: pendingEmailReplies.requestedAt,
    })
    .from(pendingEmailReplies)
    .where(
      and(eq(pendingEmailReplies.status, "pending"), lte(pendingEmailReplies.requestedAt, cutoff))
    );

  for (const r of replies) {
    const ageMs = now.getTime() - (r.requestedAt?.getTime() ?? now.getTime());
    oldestMs = Math.max(oldestMs, ageMs);
    lines.push(
      `reply draft ${Math.floor(ageMs / 86400_000)}d — to ${r.to} — ${r.subject ?? "(no subject)"}`
    );
  }

  // OPE-611 — imminent unpromoted events. Read within the imminence window
  // rather than pulling the whole 164-row upcoming cohort and filtering in JS:
  // the alert only ever needs the near end, and the reader is also called
  // unbounded by the MCP tool for the deliberate-drain view.
  const tentative = selectImminentTentative(
    await readTentativePromotionQueue(db, now, { withinSeconds: IMMINENT_SECONDS })
  );
  for (const t of tentative) lines.push(formatTentativeLine(t));

  // OPE-626 — `reply:*` mail that reached a customer in the last 24h.
  //
  // `EMAIL_REPLY_ENABLED` is enforced in exactly ONE place
  // (queue-consumers.ts:272) and only catches mail travelling through the
  // EMAIL_JOBS queue. The two human-reviewable paths go through the queue and
  // are gated; the highest-volume sender — the inbound workflow's auto-replies
  // — calls `env.EMAIL.send` directly and never reaches it. Measured over 30
  // days: 106 `reply:*` emails delivered across 19 distinct sources while the
  // flag read false.
  //
  // Counted from the LEDGER rather than instrumented at the send site, so it
  // stays true whatever the policy decision turns out to be — and so it also
  // catches the second direct sender (`inbound-email-stale-sweep.ts`, source
  // `reply:sweep-exceeded`) which the filing ticket did not name.
  let ungatedReplies = 0;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(emailSendLedger)
      .where(
        and(
          eq(emailSendLedger.status, "sent"),
          sql`${emailSendLedger.source} LIKE 'reply:%'`,
          gte(emailSendLedger.sentAt, new Date(now.getTime() - 24 * 3600_000))
        )
      );
    const sent = Number(row?.n ?? 0);
    if (shouldReportUngatedReplies(sent, env?.EMAIL_REPLY_ENABLED)) {
      ungatedReplies = sent;
      lines.push(
        `⚠️ ${sent} customer reply email(s) sent in the last 24h while EMAIL_REPLY_ENABLED is not "true" — ` +
          `the inbound workflow sends via env.EMAIL directly and never reaches the gate (OPE-626).`
      );
    }
  } catch {
    // Observability must not take the notice down with it.
  }

  // OPE-596 — operator-initiated drafts waiting on a human decision.
  //
  // John's item 5: this rides the notice rather than becoming a twelfth
  // bespoke canary. Unlike the ungated-reply line above, this IS a work queue
  // — a steady count means "seen, not yet decided" — so it inherits the
  // once-a-day debounce and does not re-nag.
  let pendingOperatorDrafts = 0;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(operatorOutboundDrafts)
      .where(eq(operatorOutboundDrafts.status, "pending"));
    pendingOperatorDrafts = Number(row?.n ?? 0);
    if (pendingOperatorDrafts > 0) {
      lines.push(
        `${pendingOperatorDrafts} operator-initiated email draft(s) awaiting approval — ` +
          `each is a message somebody intends to send to a real person.`
      );
    }
  } catch {
    // The table may not exist on an older deploy; never take the notice down.
  }

  // OPE-761 — inbound mail hibernating on the workflow's `admin-decision`
  // pause. This is the fifth queue, and it arrived exactly the way this file's
  // docblock predicted the third would.
  //
  // What makes it different from the four above: this queue has a DEADLINE of
  // its own. The other queues sit still until someone acts. This one ends by
  // itself after ADMIN_DECISION_TIMEOUT_HOURS, when `waitForEvent` gives up and
  // the sender is posted a generic acknowledgment instead of an answer — so the
  // row stops looking unhandled at precisely the moment it becomes unhandleable.
  //
  // Hence the line reports hours REMAINING, not just days waited. Depth alone
  // cannot show a row approaching the cliff, and the cliff is where the loss is.
  // (`queue-drain.ts:388` reports the same queue's depth on the analytics page
  // and makes the same point; what it cannot do is reach anybody.)
  let agedAwaitingDecision = 0;
  try {
    const waitingRows = await db
      .select({
        id: inboundEmails.id,
        fromAddress: inboundEmails.fromAddress,
        subject: inboundEmails.subject,
        intent: inboundEmails.intent,
        receivedAt: inboundEmails.receivedAt,
      })
      .from(inboundEmails)
      .where(and(eq(inboundEmails.status, "waiting"), lte(inboundEmails.receivedAt, cutoff)));

    agedAwaitingDecision = waitingRows.length;
    for (const w of waitingRows) {
      const ageMs = now.getTime() - (w.receivedAt?.getTime() ?? now.getTime());
      oldestMs = Math.max(oldestMs, ageMs);
      const hoursLeft = ADMIN_DECISION_TIMEOUT_HOURS - ageMs / 3600_000;
      // Past the cliff the auto-ack has already gone out, so "expires in -3h"
      // would be both wrong and quietly reassuring. Say which side it is on.
      const cliff =
        hoursLeft > 0
          ? `auto-ack in ${Math.floor(hoursLeft)}h`
          : `⚠️ PAST the ${ADMIN_DECISION_TIMEOUT_HOURS}h cliff — generic auto-ack already sent, the ask was never answered`;
      lines.push(
        `inbound ${w.intent ?? "(no intent)"} awaiting decision ${Math.floor(ageMs / 86400_000)}d — ` +
          `${w.fromAddress ?? "(no sender)"} — ${w.subject ?? "(no subject)"} — ${cliff}`
      );
    }
  } catch (error) {
    // Never take the notice down for one queue's read — the other four still
    // have people waiting in them.
    await logError(db, {
      source: SOURCE,
      message: "[operator-queue] awaiting-decision read failed",
      error,
    });
  }

  // OPE-760 — a real attachment dropped by the count cap.
  //
  // Filtered to NON-furniture deliberately. With a furniture quota of 2, a
  // six-icon Outlook signature skips four icons on every message from that
  // sender; reporting those would be wallpaper inside a week, and the one real
  // dropped file would arrive in a stream nobody reads.
  //
  // Measured over all history 2026-09-02: ONE row has any skip at all — the
  // specimen — against 94 rows carrying attachments. So the expected steady
  // state is zero, which is what makes a non-zero worth an email.
  let droppedRealAttachments = 0;
  try {
    const recent = await db
      .select({ id: inboundEmails.id, skips: inboundEmails.attachmentSkips })
      .from(inboundEmails)
      .where(
        and(
          gte(inboundEmails.receivedAt, new Date(now.getTime() - 7 * 24 * 3600_000)),
          sql`${inboundEmails.attachmentSkips} IS NOT NULL AND ${inboundEmails.attachmentSkips} <> '[]'`
        )
      );
    for (const r of recent) {
      let parsed: Array<{ name?: string; reason?: string; furniture?: boolean; size?: number }> =
        [];
      try {
        parsed = JSON.parse(r.skips ?? "[]");
      } catch {
        continue;
      }
      // `furniture === true` is the only thing that suppresses. An older row
      // where the field is ABSENT is reported — it predates the classifier, and
      // "we do not know" must not read as "it was only an icon".
      const real = parsed.filter((k) => k.reason === "over-count-cap" && k.furniture !== true);
      if (real.length > 0) {
        droppedRealAttachments += real.length;
        lines.push(
          `⚠️ ${real.length} real attachment(s) dropped by the count cap on inbound ${r.id} — ` +
            `${real.map((k) => k.name ?? "(unnamed)").join(", ")} (OPE-760)`
        );
      }
    }
  } catch {
    // Observability must not take the notice down with it.
  }

  // OPE-1011 — a start date that renders as a different day in Eastern.
  //
  // Date-only fields render in America/New_York since OPE-482, and the storage
  // convention is noon UTC. Measured 2026-09-14/15 over 1,718 public rows:
  // 1,282 at noon, 99 at local midnight (04:00Z/05:00Z), 337 at a clock time.
  // None rendered a different day that week — every 04:00Z row was dated in
  // EDT — but a 04:00Z value on a winter date is 23:00 EST the previous day.
  // `start_date_timezone_confused` flags the whole off-noon population on the
  // row it is evaluating and nothing else; this watches the subset that is
  // actually wrong on the page, across every row.
  //
  // Pre-filter is exact, not a heuristic: Eastern is UTC−4 or UTC−5, so only an
  // instant before 05:00 UTC can fall on the previous Eastern calendar day.
  let venueDateShifts = 0;
  try {
    const cutoffSec = Math.floor(now.getTime() / 1000) - 86400;
    const candidates = await db.all<{
      slug: string;
      start_date: number | null;
      public_start_date: number | null;
    }>(sql`
      SELECT slug, start_date, public_start_date
      FROM events
      WHERE status IN ('APPROVED', 'TENTATIVE')
        AND merged_into IS NULL
        AND start_date >= ${cutoffSec}
        AND (start_date % 86400 < 18000 OR public_start_date % 86400 < 18000)
    `);
    for (const c of candidates) {
      const shifted = (["start_date", "public_start_date"] as const).filter((col) => {
        const v = c[col];
        if (v == null) return false;
        const d = new Date(Number(v) * 1000);
        return toIsoDateOnly(d) !== toIsoDateOnlyInVenueZone(d);
      });
      if (shifted.length > 0) {
        venueDateShifts++;
        lines.push(
          `⚠️ ${c.slug}: ${shifted.join(" + ")} renders a different calendar day in Eastern than it stores ` +
            `(${new Date(Number(c[shifted[0]]) * 1000).toISOString()}) — re-anchor at noon UTC (OPE-1011)`
        );
      }
    }
  } catch {
    // Observability must not take the notice down with it.
  }

  // OPE-599 rework — auth email that failed to land, and registrations that
  // just crossed the verification window unconfirmed. Arrival-based, so each
  // person is named once rather than every morning.
  let authEmailProblems = 0;
  try {
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const undelivered = await db
      .select({
        recipient: emailSendLedger.recipient,
        source: emailSendLedger.source,
        deliveryStatus: emailSendLedger.deliveryStatus,
      })
      .from(emailSendLedger)
      .where(
        and(
          sql`${emailSendLedger.source} LIKE 'auth.%'`,
          inArray(emailSendLedger.deliveryStatus, ["bounced", "rejected", "failed"]),
          gte(emailSendLedger.sentAt, dayAgo)
        )
      );
    for (const u of undelivered) {
      authEmailProblems++;
      lines.push(
        `⚠️ ${u.source} to ${u.recipient ?? "(no address)"} was ${u.deliveryStatus} — ` +
          `this person cannot finish signing up (OPE-177)`
      );
    }

    const grace = await loadGraceHours(db);
    const crossedEnd = new Date(now.getTime() - grace * 3600_000);
    const crossedStart = new Date(crossedEnd.getTime() - 24 * 3600_000);
    const crossed = await db
      .selectDistinct({ email: users.email, createdAt: users.createdAt })
      .from(users)
      .innerJoin(emailSendLedger, sql`lower(${emailSendLedger.recipient}) = lower(${users.email})`)
      .where(
        and(
          // Placeholder owner accounts (OPE-292) are not registrations and never verify.
          eq(users.origin, "registration"),
          isNull(users.emailVerified),
          gte(users.createdAt, crossedStart),
          sql`${users.createdAt} < ${Math.floor(crossedEnd.getTime() / 1000)}`,
          sql`${emailSendLedger.source} LIKE 'auth.%'`,
          eq(emailSendLedger.deliveryStatus, "delivered")
        )
      );
    for (const c of crossed) {
      authEmailProblems++;
      lines.push(
        `registration ${c.email} still unverified ${grace}h after a DELIVERED verification email ` +
          `— delivered is not read; a ceiling on drop-off, not a fault (OPE-177)`
      );
    }
  } catch {
    // Observability must not take the notice down with it.
  }

  return {
    agedClaims: claims.length,
    agedReplies: replies.length,
    imminentTentative: tentative.length,
    ungatedReplies,
    pendingOperatorDrafts,
    agedAwaitingDecision,
    droppedRealAttachments,
    venueDateShifts,
    authEmailProblems,
    oldestDays: Math.floor(oldestMs / 86400_000),
    lines,
  };
}

export async function runScheduledOperatorQueueNotice(
  env: Env,
  now: Date = new Date()
): Promise<void> {
  return checkOperatorQueues(getDb(env.DB), env, now);
}

export async function checkOperatorQueues(db: Db, env: Env, now: Date = new Date()): Promise<void> {
  let counts: OperatorQueueCounts;
  try {
    counts = await readOperatorQueues(db, now, env as { EMAIL_REPLY_ENABLED?: string });
  } catch (error) {
    await logError(db, { source: SOURCE, message: "[operator-queue] read failed", error });
    return;
  }

  if (totalWaiting(counts) <= 0) {
    console.log("[cron] operator-queue-notice — queues clear, staying quiet");
    return;
  }

  let alreadySentToday = false;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(emailSendLedger)
      .where(
        and(
          eq(emailSendLedger.source, NOTICE_EMAIL_SOURCE),
          eq(emailSendLedger.status, "sent"),
          gte(emailSendLedger.sentAt, startOfUtcDay(now))
        )
      );
    alreadySentToday = Number(row?.n ?? 0) > 0;
  } catch (error) {
    // Fail OPEN: a duplicate operator email is a nuisance; a suppressed one is
    // the defect this ticket exists about.
    await logError(db, {
      source: SOURCE,
      message: "[operator-queue] debounce read failed; alerting anyway",
      error,
    });
  }

  if (!decideOperatorQueueNotice(counts, alreadySentToday)) {
    console.log("[cron] operator-queue-notice — already alerted today");
    return;
  }

  const total = totalWaiting(counts);
  const subject = `[MMATF] ${total} operator queue item${total === 1 ? "" : "s"} waiting (oldest ${counts.oldestDays}d)`;
  // The tentative clause is omitted entirely when that queue is empty, so the
  // two original queues read exactly as they did before OPE-611.
  // OPE-596 — omitted entirely when the queue is empty, so the notice reads
  // exactly as it did before this queue existed.
  const draftsClause =
    counts.pendingOperatorDrafts > 0
      ? ` ${counts.pendingOperatorDrafts} operator-initiated draft(s) are waiting on your approval; ` +
        `nothing is sent until you rule, and delivery additionally needs OPERATOR_OUTBOUND_ENABLED.`
      : "";
  const tentativeClause =
    counts.imminentTentative > 0
      ? ` ${counts.imminentTentative} event(s) open within ${IMMINENT_DAYS} days but are still ` +
        `TENTATIVE despite organizer-grade sources, so the digest and every ` +
        `SCHEDULED-filtered feed drop them.`
      : "";
  // OPE-761 — omitted entirely when the queue is empty, so the notice reads
  // exactly as it did before this queue existed.
  const awaitingClause =
    counts.agedAwaitingDecision > 0
      ? ` ${counts.agedAwaitingDecision} inbound email(s) are hibernating on the admin-decision ` +
        `pause: someone wrote to us and has had no answer. Each expires after ` +
        `${ADMIN_DECISION_TIMEOUT_HOURS}h into a GENERIC auto-ack, which is the only automated ` +
        `reply this lane has ever sent — so an unanswered row does not stay unanswered, it stops ` +
        `looking unanswered.`
      : "";
  const textBody =
    `${counts.agedClaims} entity claim(s) and ${counts.agedReplies} written reply draft(s) ` +
    `have been waiting more than ${QUEUE_SLA_HOURS}h.${awaitingClause}${tentativeClause}${draftsClause}\n\n` +
    counts.lines.map((l) => `  - ${l}`).join("\n") +
    `\n\nA claim is a real person asking to own their listing; a reply draft is an ` +
    `answer already written to a real person and not yet sent.\n`;
  const htmlBody =
    `<p><strong>${counts.agedClaims}</strong> entity claim(s) and <strong>${counts.agedReplies}</strong> ` +
    `written reply draft(s) have been waiting more than ${QUEUE_SLA_HOURS}h.` +
    `${esc(awaitingClause)}${esc(tentativeClause)}${esc(draftsClause)}</p>` +
    `<ul>${counts.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: NOTICE_EMAIL_SOURCE,
      });
      console.log(`[cron] operator-queue-notice fired — ${total} waiting to=${alertEmail}`);
    } catch (error) {
      await logError(db, {
        source: SOURCE,
        message: "[operator-queue] alert enqueue failed",
        error,
        context: { total },
      });
    }
  } else {
    await logError(db, {
      source: SOURCE,
      message: `[operator-queue] ${total} items waiting and no ALERT_EMAIL_TECHNICAL configured`,
      context: { lines: counts.lines },
    });
  }
}
