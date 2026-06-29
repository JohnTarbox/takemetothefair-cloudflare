/**
 * OPE-15 (2026-06-29) — vendor-roster research-queue notice.
 *
 * The developer-side companion to OPE-13's rails and OPE-14's interactive
 * analyst sweep. The rails (event-occurred-sweep Pass 3) seed
 * `vendor_roster_status = NEEDS_RESEARCH` server-side every day. But the sweep
 * that DRAINS that queue (OPE-14) can't run unattended — the research needs
 * web_fetch (organizer exhibitor pages, Wayback), gated in the scheduled
 * runtime exactly like event-enrichment. So the realistic automation isn't
 * "auto-drain" — it's a NOTICE that tells the operator there's research to do.
 *
 * This runs in the SAME 06:00 UTC scheduled handler, sequenced AFTER
 * runOccurredTransitionSweep so the count reflects this run's enqueue (no
 * second cron). It is server-side counts only — NO web_fetch here.
 *
 * Scope = producer-class events only (PRODUCER_CLASS_CATEGORIES): the same
 * denominator the roster-coverage metric uses, so the notice and the coverage
 * dashboard agree on what "needs research" means.
 *
 * Debounce (roster_research_notice_state, drizzle/0134): fire at most once per
 * day AND only when the producer-class NEEDS_RESEARCH count CHANGED since the
 * last notice. An unchanged backlog goes quiet — the operator already knows.
 *
 * Dispatch: env.ALERT_EMAIL_TECHNICAL via the EMAIL_JOBS queue (idempotent via
 * email_send_ledger), the same operator-alert channel the standing-failure /
 * goodwill-health canaries use. With the channel unconfigured the notice still
 * runs (computes + updates debounce) but only logs — never throws. Cosmetic-
 * failsoft by construction: every DB op catches its own error and logs, so a
 * bad row never pulls down the sibling crons it shares Promise.all with.
 */
import { and, eq, isNull, or, like, desc, sql } from "drizzle-orm";
import { events, rosterResearchNoticeState } from "@takemetothefair/db-schema";
import { PRODUCER_CLASS_CATEGORIES } from "@takemetothefair/constants";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:roster-research-notice";

/** Constant PK for the single debounce row. */
const NOTICE_KEY = "roster_research_notice";

/** How many sample event names to include in the notice body. */
const SAMPLE_LIMIT = 5;

/** Format a Date as `YYYY-MM-DD` in UTC — matches the once-per-day comparison
 *  and is timezone-stable (the debounce date is a plain UTC day key). */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure decision function — exported for unit tests. Decides whether to send
 * the research-queue notice this run.
 *
 *   - count <= 0            → never notify (empty queue is the happy path).
 *   - lastNoticeDate==today → already notified today; ≤1/day gate.
 *   - lastQueueCount==count → backlog unchanged since last notice; stay quiet.
 *   - otherwise             → fire.
 *
 * First run (no state row) passes null for both last* fields, so any non-empty
 * producer-class queue notifies once.
 */
export function decideRosterNotice(
  count: number,
  lastNoticeDate: string | null,
  lastQueueCount: number | null,
  today: string
): boolean {
  if (count <= 0) return false;
  if (lastNoticeDate === today) return false;
  if (lastQueueCount !== null && lastQueueCount === count) return false;
  return true;
}

/**
 * Main entry point. Exported for index.ts and unit tests.
 *
 * Idempotent across re-runs within a day: the ≤1/day debounce makes a second
 * fire the same UTC day a no-op.
 */
export async function runRosterResearchNotice(env: Env): Promise<void> {
  const now = new Date();
  const today = utcDayKey(now);
  const db = getDb(env.DB);

  // Producer-class match: categories is a JSON array of quoted values, so match
  // `%"Home Show"%` to avoid substring bleed across category names (mirrors the
  // roster-coverage route). Scopes the notice to the same denominator as the
  // coverage metric.
  const producerCond = or(
    ...PRODUCER_CLASS_CATEGORIES.map((c) => like(events.categories, `%"${c}"%`))
  );
  const whereCond = and(
    eq(events.lifecycleStatus, "OCCURRED"),
    isNull(events.mergedInto),
    eq(events.vendorRosterStatus, "NEEDS_RESEARCH"),
    producerCond
  );

  // Count producer-class events awaiting roster research.
  let count = 0;
  try {
    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(whereCond);
    count = countRows[0]?.n ?? 0;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[roster-notice] count query failed",
      error,
    });
    return;
  }

  // Read debounce state (single row).
  let lastNoticeDate: string | null = null;
  let lastQueueCount: number | null = null;
  try {
    const stateRow = await db.query.rosterResearchNoticeState.findFirst({
      where: eq(rosterResearchNoticeState.id, NOTICE_KEY),
    });
    if (stateRow) {
      lastNoticeDate = stateRow.lastNoticeDate;
      lastQueueCount = stateRow.lastQueueCount;
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[roster-notice] debounce read failed",
      error,
    });
    return;
  }

  if (!decideRosterNotice(count, lastNoticeDate, lastQueueCount, today)) {
    console.log(
      `[cron] roster-research-notice skip — count=${count} ` +
        `lastNoticeDate=${lastNoticeDate ?? "never"} lastCount=${lastQueueCount ?? "n/a"} today=${today}`
    );
    return;
  }

  // Fire path: gather sample names (most-recently-ended first — the playbook
  // biases toward rosters still live on the organizer's page).
  let sampleNames: string[] = [];
  try {
    const sampleRows = await db
      .select({ name: events.name })
      .from(events)
      .where(whereCond)
      .orderBy(desc(events.endDate))
      .limit(SAMPLE_LIMIT);
    sampleNames = sampleRows.map((r) => r.name).filter((n): n is string => !!n);
  } catch (error) {
    // Non-fatal: a notice without samples is still useful. Log and continue.
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "[roster-notice] sample query failed; sending count-only notice",
      error,
    });
  }

  const noun = count === 1 ? "event" : "events";
  const subject = `📋 Vendor-roster research: ${count} producer-class ${noun} need a roster sweep`;
  const sampleLine = sampleNames.length
    ? `Sample:\n${sampleNames.map((n) => ` • ${n}`).join("\n")}\n\n`
    : "";
  const textBody =
    `${count} producer-class ${noun} are in the vendor-roster NEEDS_RESEARCH queue ` +
    `and awaiting an interactive roster sweep.\n\n` +
    sampleLine +
    `To drain the queue, run an interactive vendor-roster sweep ` +
    `(\`event-vendor-roster-backfill\` skill) in a session with web_fetch. ` +
    `The research can't run unattended — organizer exhibitor pages + Wayback need web_fetch.\n`;
  const sampleHtml = sampleNames.length
    ? `<p>Sample:</p><ul>${sampleNames.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : "";
  const htmlBody =
    `<p><strong>📋 Vendor-roster research queue</strong> — <strong>${count}</strong> producer-class ${noun} ` +
    `await an interactive roster sweep.</p>` +
    sampleHtml +
    `<p>To drain the queue, run an interactive vendor-roster sweep ` +
    `(<code>event-vendor-roster-backfill</code>) in a session with <code>web_fetch</code>. ` +
    `The research can't run unattended — organizer exhibitor pages + Wayback need <code>web_fetch</code>.</p>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: "roster-research-notice",
      });
      console.log(`[cron] roster-research-notice fired — count=${count} to=${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: "[roster-notice] email enqueue failed",
        error,
        context: { count, alertEmail },
      });
    }
  } else {
    // No channel configured — still update debounce so we don't recompute a
    // "fire" every run; the operator can read the count from the log line.
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: `[roster-notice] would notify (count=${count}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      context: { count, hasAlertEmail: !!alertEmail, hasQueue: !!env.EMAIL_JOBS },
    });
  }

  // Upsert debounce row regardless of dispatch outcome — a failed send is a
  // channel problem, not a reason to re-fire every run; the ≤1/day + changed
  // gate is the mute window we want either way.
  try {
    await db
      .insert(rosterResearchNoticeState)
      .values({
        id: NOTICE_KEY,
        lastNoticeDate: today,
        lastQueueCount: count,
        lastNotifiedAt: now,
      })
      .onConflictDoUpdate({
        target: rosterResearchNoticeState.id,
        set: {
          lastNoticeDate: today,
          lastQueueCount: count,
          lastNotifiedAt: now,
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[roster-notice] debounce upsert failed",
      error,
      context: { count },
    });
  }
}

/** Minimal HTML-escape for event names interpolated into the email body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Exported for unit tests.
export const __test = {
  decideRosterNotice,
  utcDayKey,
  escapeHtml,
  NOTICE_KEY,
  SAMPLE_LIMIT,
};
