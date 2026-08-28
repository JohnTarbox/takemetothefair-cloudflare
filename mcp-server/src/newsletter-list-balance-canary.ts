/**
 * OPE-510 scope §3 — the newsletter list-balance canary, made to actually fire.
 *
 * ── What was already here, and why it wasn't enough ─────────────────────────
 * `newsletter-list-balance.ts` shipped the right QUERY: two counts that must be
 * equal, and the orphan list between them. But its only caller was
 * `get_data_health_report` — an on-demand MCP tool. Nothing ran it on a
 * schedule and nothing alerted on it, so it was a number in a report rather
 * than a canary.
 *
 * The review verdict of 2026-08-28 proved the difference is not academic. Four
 * public double-opt-in signups confirmed in the window between the 08-21
 * backfill and the writer's deploy:
 *
 *   doreen_m_gamache@homedepot.com   08-21 17:58:36   footer
 *   learninstuffct@gmail.com         08-21 19:10:26   footer
 *   jfazz@mail.com                   08-22 00:50:21   footer
 *   deeogt@gmail.com                 08-23 15:05:36   footer
 *
 * They received nothing for five to seven days, and were found BY HAND — a
 * `preview_only` broadcast resolved 29 recipients against 34 confirmed-active
 * and somebody chased the delta. That count comparison is exactly what this
 * canary was specified to automate. Had it alerted, this ticket would have
 * caught its own regression.
 *
 * ── Why the debounce here is deliberately NOT the house pattern ─────────────
 * Every sibling notice (promoter-enrichment, roster-research, inbound-exception)
 * debounces on "stay quiet unless the count CHANGED since the last notice."
 * That is right for a BACKLOG somebody is draining: an unchanged number means
 * the operator already knows.
 *
 * It is wrong here, and dangerously so. This is an INVARIANT VIOLATION, not a
 * backlog. An orphan count sitting at 4 for a week does not mean "already
 * known" — it means four real people who completed double opt-in have now gone
 * a week receiving nothing, and every day it stays unchanged the harm grows.
 *
 * It is also the precise shape of the original defect: the weekend list "had 17
 * members the morning the backfill ran and still had 17 a week later", and a
 * number that never moves looks exactly like a number nothing writes to. A
 * change-gated alert would have gone quiet on the very steady state it exists
 * to report.
 *
 * So this nags once per day for as long as orphans exist — the cadence
 * `cpi-stale-red-scan` settled on for the same reason ("keeps nagging daily
 * without producing a per-run flood").
 *
 * ── Why the debounce needs no new table ─────────────────────────────────────
 * "Have I already mailed today?" is answered by the send itself.
 * `email_send_ledger` already records every send with a `source` and a
 * `sent_at`, so a bespoke `*_notice_state` row would be a second copy of a fact
 * we durably store — and a copy that can disagree with reality if a send fails
 * after the state row is written.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { agentHeartbeats, emailSendLedger } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
import { listBalance } from "./newsletter-list-balance.js";

const SOURCE = "mcp:schedule:newsletter-list-balance";

/** `email_send_ledger.source` for this canary's alert — also its debounce key. */
export const CANARY_EMAIL_SOURCE = "newsletter-list-balance-canary";

/** `agent_heartbeats.agent_code` for the per-run stamp the probe watches. */
const CANARY_CODE = "watchdog:newsletter-list-balance";

/** Orphan addresses listed in the alert body before truncating. */
const SAMPLE_LIMIT = 10;

/**
 * Pure decision — exported for tests.
 *
 * Note what is NOT a parameter: the previous orphan COUNT. That omission is the
 * design (see the docblock). An invariant violation that holds steady is not
 * less urgent than one that grows, and gating on change would mute the exact
 * steady state this canary exists to report.
 */
export function decideListBalanceAlert(orphaned: number, alreadySentToday: boolean): boolean {
  if (orphaned <= 0) return false; // balanced — the happy path is silent
  return !alreadySentToday; // at most one nag per day, every day, while broken
}

/** Minimal HTML-escape for addresses interpolated into the alert body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Start of the current UTC day, as a Date — the debounce window boundary. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The scheduled entry point. Thin by design: it only resolves the D1 handle.
 *
 * All behaviour lives in `checkNewsletterListBalance` so a test can drive the
 * whole path against a real in-memory database. That seam is not incidental —
 * the previous ship's tests all exercised the balance QUERY and none of them
 * could exercise the thing that was actually missing, which was everything
 * around it.
 */
export async function runScheduledNewsletterListBalanceCanary(
  env: Env,
  now: Date = new Date()
): Promise<void> {
  return checkNewsletterListBalance(getDb(env.DB), env, now);
}

export async function checkNewsletterListBalance(
  db: Db,
  env: Env,
  now: Date = new Date()
): Promise<void> {
  let balance: Awaited<ReturnType<typeof listBalance>>;
  try {
    balance = await listBalance(db);
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "[newsletter-list-balance] balance query failed",
      error,
    });
    return;
  }

  // The RUN stamp, written on EVERY run and before any decision about alerting.
  //
  // The alert is the yield, and the yield is zero on every healthy day — which
  // is indistinguishable from a dead cron. This stamp is what separates
  // "balanced, nothing to say" from "not running", and that distinction is the
  // entire reason the defect below went unseen for five to seven days.
  try {
    const note = `confirmed_active=${balance.confirmed_active} on_any_list=${balance.on_any_list} orphaned=${balance.orphaned}`;
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: CANARY_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    // Failsoft: a stamp failure must never suppress an alert about real people
    // receiving no mail.
    await logError(db, {
      source: SOURCE,
      message: "[newsletter-list-balance] run-stamp write failed",
      error,
    });
  }

  if (balance.orphaned <= 0) {
    console.log(`[cron] newsletter-list-balance ok — balanced at ${balance.confirmed_active}`);
    return;
  }

  // Has this canary already mailed today? Read the ledger rather than a
  // side-state row, so the debounce cannot disagree with what was actually sent.
  let alreadySentToday = false;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(emailSendLedger)
      .where(
        and(
          eq(emailSendLedger.source, CANARY_EMAIL_SOURCE),
          eq(emailSendLedger.status, "sent"),
          gte(emailSendLedger.sentAt, startOfUtcDay(now))
        )
      );
    alreadySentToday = Number(row?.n ?? 0) > 0;
  } catch (error) {
    // Fail OPEN, deliberately. If the debounce read breaks, a duplicate
    // operator email is a nuisance; a suppressed one leaves subscribers
    // silently unmailed, which is the defect itself.
    await logError(db, {
      source: SOURCE,
      message: "[newsletter-list-balance] debounce read failed; alerting anyway",
      error,
    });
  }

  if (!decideListBalanceAlert(balance.orphaned, alreadySentToday)) {
    console.log(
      `[cron] newsletter-list-balance already alerted today — orphaned=${balance.orphaned}`
    );
    return;
  }

  // Name the people. An operator cannot act on "orphaned=4", and the remedy is
  // per-address.
  let orphanEmails: string[] = [];
  try {
    const rows = await db.all<{ email: string }>(sql`
      SELECT s.email FROM newsletter_subscribers s
       WHERE s.confirmed = 1 AND s.unsubscribed = 0
         AND NOT EXISTS (
           SELECT 1 FROM newsletter_list_subscriptions l
            WHERE l.subscriber_id = s.id AND l.unsubscribed_at IS NULL)
       ORDER BY s.created_at
       LIMIT ${SAMPLE_LIMIT}`);
    orphanEmails = rows.map((r) => r.email).filter(Boolean);
  } catch {
    // The count alone is still worth sending.
  }

  const subject = `[MMATF] ${balance.orphaned} confirmed subscriber${balance.orphaned === 1 ? "" : "s"} receiving no newsletter`;
  const more = balance.orphaned - orphanEmails.length;
  const listText = orphanEmails.length
    ? orphanEmails.map((e) => `  - ${e}`).join("\n") + (more > 0 ? `\n  ...and ${more} more` : "")
    : "  (address list unavailable — query the data-health report)";
  const textBody =
    `${balance.orphaned} subscriber(s) completed double opt-in and are on NO active list, ` +
    `so the weekend broadcast skips them.\n\n` +
    `confirmed_active = ${balance.confirmed_active}\n` +
    `on_any_list      = ${balance.on_any_list}\n` +
    `orphaned         = ${balance.orphaned}\n\n` +
    `${listText}\n\n` +
    `These people asked for the newsletter and are receiving nothing. Backfilling a ` +
    `newsletter_list_subscriptions row puts them on the next broadcast.\n`;
  const htmlBody =
    `<p><strong>${balance.orphaned}</strong> subscriber(s) completed double opt-in and are on ` +
    `<strong>no active list</strong>, so the weekend broadcast skips them.</p>` +
    `<ul><li>confirmed_active: ${balance.confirmed_active}</li>` +
    `<li>on_any_list: ${balance.on_any_list}</li>` +
    `<li>orphaned: ${balance.orphaned}</li></ul>` +
    (orphanEmails.length
      ? `<ul>${orphanEmails.map((e) => `<li>${esc(e)}</li>`).join("")}` +
        (more > 0 ? `<li>…and ${more} more</li>` : "") +
        `</ul>`
      : "") +
    `<p>These people asked for the newsletter and are receiving nothing.</p>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: CANARY_EMAIL_SOURCE,
      });
      console.log(
        `[cron] newsletter-list-balance ALERT — orphaned=${balance.orphaned} to=${alertEmail}`
      );
    } catch (error) {
      await logError(db, {
        source: SOURCE,
        message: "[newsletter-list-balance] alert enqueue failed",
        error,
        context: { orphaned: balance.orphaned, alertEmail },
      });
    }
  } else {
    // Unconfigured channel must still be loud in the one place we can write to.
    await logError(db, {
      source: SOURCE,
      message: `[newsletter-list-balance] ${balance.orphaned} orphaned subscribers and no ALERT_EMAIL_TECHNICAL configured`,
      context: { orphaned: balance.orphaned, sample: orphanEmails },
    });
  }
}
