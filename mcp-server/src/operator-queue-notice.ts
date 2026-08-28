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
  users,
} from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
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
    "agedClaims" | "agedReplies" | "imminentTentative" | "ungatedReplies" | "pendingOperatorDrafts"
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
    "agedClaims" | "agedReplies" | "imminentTentative" | "ungatedReplies" | "pendingOperatorDrafts"
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
    (counts.pendingOperatorDrafts ?? 0)
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

  return {
    agedClaims: claims.length,
    agedReplies: replies.length,
    imminentTentative: tentative.length,
    ungatedReplies,
    pendingOperatorDrafts,
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
  const textBody =
    `${counts.agedClaims} entity claim(s) and ${counts.agedReplies} written reply draft(s) ` +
    `have been waiting more than ${QUEUE_SLA_HOURS}h.${tentativeClause}${draftsClause}\n\n` +
    counts.lines.map((l) => `  - ${l}`).join("\n") +
    `\n\nA claim is a real person asking to own their listing; a reply draft is an ` +
    `answer already written to a real person and not yet sent.\n`;
  const htmlBody =
    `<p><strong>${counts.agedClaims}</strong> entity claim(s) and <strong>${counts.agedReplies}</strong> ` +
    `written reply draft(s) have been waiting more than ${QUEUE_SLA_HOURS}h.` +
    `${esc(tentativeClause)}${esc(draftsClause)}</p>` +
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
