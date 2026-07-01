/**
 * OPE-37 (2026-07-01) — promoter-enrichment queue notice.
 *
 * The promoter analog of OPE-15's vendor-roster research-queue notice
 * (roster-research-notice.ts) and OPE-17's inbound-exception notice
 * (inbound-exception-notice.ts). Same shape, different queue.
 *
 * OPE-35's rails seed `promoters.enrichment_status = 'NEEDS_ENRICHMENT'`
 * server-side (website present + a target field empty). But draining that queue
 * is interactive work — the enrichment fetches organizer sites / social pages,
 * gated in the scheduled runtime like event-enrichment. So the automation isn't
 * "auto-drain" — it's a NOTICE that tells the operator there is enrichment to do.
 *
 * This runs in the SAME 06:00 UTC scheduled handler as a failsoft sibling.
 * Server-side counts only — NO web_fetch here.
 *
 * Debounce (promoter_enrichment_notice_state, drizzle/0142): fire at most once
 * per day AND only when the NEEDS_ENRICHMENT count CHANGED since the last notice.
 * An unchanged backlog goes quiet — the operator already knows.
 *
 * Dispatch: env.ALERT_EMAIL_TECHNICAL via the EMAIL_JOBS queue (idempotent via
 * email_send_ledger), the same operator-alert channel the roster / inbound
 * notices + canaries use. With the channel unconfigured the notice still runs
 * (computes + updates debounce) but only logs — never throws. Cosmetic-failsoft
 * by construction: every DB op catches its own error and logs, so a bad row
 * never pulls down the sibling crons it shares Promise.all with.
 */
import { eq, desc, sql } from "drizzle-orm";
import { promoters, promoterEnrichmentNoticeState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:promoter-enrichment-notice";

/** Constant PK for the single debounce row. */
const NOTICE_KEY = "promoter_enrichment_notice";

/** How many sample promoter names to include in the notice body. */
const SAMPLE_LIMIT = 5;

/** Target fields tracked in the enrichment_coverage JSON snapshot — mirrors the
 *  OPE-35 coverage endpoint (/api/admin/analytics/promoter-enrichment-coverage).
 *  Each maps to a `$.<field> = 1` marker in the stored JSON. */
const COVERAGE_FIELDS = ["hero", "logo", "description", "socials", "contact"] as const;
type CoverageField = (typeof COVERAGE_FIELDS)[number];

/** Format a Date as `YYYY-MM-DD` in UTC — matches the once-per-day comparison
 *  and is timezone-stable (the debounce date is a plain UTC day key). */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure decision function — exported for unit tests. Decides whether to send the
 * promoter-enrichment notice this run. Identical shape to OPE-15/OPE-17.
 *
 *   - count <= 0            → never notify (empty queue is the happy path).
 *   - lastNoticeDate==today → already notified today; ≤1/day gate.
 *   - lastQueueCount==count → backlog unchanged since last notice; stay quiet.
 *   - otherwise             → fire.
 */
export function decidePromoterEnrichmentNotice(
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

/** Minimal HTML-escape for promoter names interpolated into the email body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Per-field fill counts across all promoters, read from the enrichment_coverage
 *  JSON snapshot (same source as the OPE-35 coverage endpoint, so the notice and
 *  the dashboard never disagree). */
export type CoverageCounts = Record<CoverageField, number>;

/** Render a compact one-line coverage summary: `hero 12, logo 30, …`. */
function formatCoverageLine(total: number, counts: CoverageCounts): string {
  return COVERAGE_FIELDS.map((f) => `${f} ${counts[f]}/${total}`).join(", ");
}

/**
 * Main entry point. Exported for index.ts and unit tests.
 *
 * Idempotent across re-runs within a day: the ≤1/day debounce makes a second
 * fire the same UTC day a no-op.
 */
export async function runPromoterEnrichmentNotice(env: Env): Promise<void> {
  const now = new Date();
  const today = utcDayKey(now);
  const db = getDb(env.DB);

  // Count promoters awaiting enrichment.
  let count = 0;
  try {
    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(promoters)
      .where(eq(promoters.enrichmentStatus, "NEEDS_ENRICHMENT"));
    count = countRows[0]?.n ?? 0;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[promoter-enrichment-notice] count query failed",
      error,
    });
    return;
  }

  // Read debounce state (single row).
  let lastNoticeDate: string | null = null;
  let lastQueueCount: number | null = null;
  try {
    const stateRow = await db.query.promoterEnrichmentNoticeState.findFirst({
      where: eq(promoterEnrichmentNoticeState.id, NOTICE_KEY),
    });
    if (stateRow) {
      lastNoticeDate = stateRow.lastNoticeDate;
      lastQueueCount = stateRow.lastQueueCount;
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[promoter-enrichment-notice] debounce read failed",
      error,
    });
    return;
  }

  if (!decidePromoterEnrichmentNotice(count, lastNoticeDate, lastQueueCount, today)) {
    console.log(
      `[cron] promoter-enrichment-notice skip — count=${count} ` +
        `lastNoticeDate=${lastNoticeDate ?? "never"} lastCount=${lastQueueCount ?? "n/a"} today=${today}`
    );
    return;
  }

  // Fire path: per-field coverage across the whole promoter corpus (reuses the
  // OPE-35 coverage query — sum of json_extract(enrichment_coverage,'$.field')=1).
  let total = 0;
  let counts: CoverageCounts = { hero: 0, logo: 0, description: 0, socials: 0, contact: 0 };
  try {
    const covered = (field: CoverageField) =>
      sql<number>`sum(case when json_extract(enrichment_coverage, ${"$." + field}) = 1 then 1 else 0 end)`;
    const [agg] = await db
      .select({
        total: sql<number>`count(*)`,
        hero: covered("hero"),
        logo: covered("logo"),
        description: covered("description"),
        socials: covered("socials"),
        contact: covered("contact"),
      })
      .from(promoters);
    total = Number(agg?.total ?? 0);
    counts = {
      hero: Number(agg?.hero ?? 0),
      logo: Number(agg?.logo ?? 0),
      description: Number(agg?.description ?? 0),
      socials: Number(agg?.socials ?? 0),
      contact: Number(agg?.contact ?? 0),
    };
  } catch (error) {
    // Non-fatal: a notice without the coverage line is still useful.
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "[promoter-enrichment-notice] coverage query failed; sending count-only notice",
      error,
    });
  }

  // Sample names (most-recently-created first — freshest promoters first).
  let sampleNames: string[] = [];
  try {
    const sampleRows = await db
      .select({ name: promoters.companyName })
      .from(promoters)
      .where(eq(promoters.enrichmentStatus, "NEEDS_ENRICHMENT"))
      .orderBy(desc(promoters.createdAt))
      .limit(SAMPLE_LIMIT);
    sampleNames = sampleRows.map((r) => r.name).filter((n): n is string => !!n);
  } catch (error) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "[promoter-enrichment-notice] sample query failed; sending count-only notice",
      error,
    });
  }

  const noun = count === 1 ? "promoter" : "promoters";
  const subject = `🏷️ Promoter enrichment: ${count} ${noun} need enrichment`;
  const coverageLine = total > 0 ? `Coverage: ${formatCoverageLine(total, counts)}\n\n` : "";
  const sampleLine = sampleNames.length
    ? `Sample:\n${sampleNames.map((n) => ` • ${n}`).join("\n")}\n\n`
    : "";
  const textBody =
    `${count} ${noun} are in the promoter-enrichment NEEDS_ENRICHMENT queue ` +
    `and awaiting interactive enrichment (hero/logo/description/socials/contact).\n\n` +
    coverageLine +
    sampleLine +
    `To drain the queue, run the interactive promoter-enrichment task in a session ` +
    `with web_fetch. The research can't run unattended — organizer sites + social ` +
    `pages need web_fetch.\n`;
  const coverageHtml =
    total > 0 ? `<p>Coverage: ${escapeHtml(formatCoverageLine(total, counts))}</p>` : "";
  const sampleHtml = sampleNames.length
    ? `<p>Sample:</p><ul>${sampleNames.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : "";
  const htmlBody =
    `<p><strong>🏷️ Promoter-enrichment queue</strong> — <strong>${count}</strong> ${noun} ` +
    `await interactive enrichment (hero/logo/description/socials/contact).</p>` +
    coverageHtml +
    sampleHtml +
    `<p>To drain the queue, run the interactive promoter-enrichment task in a session ` +
    `with <code>web_fetch</code>. The research can't run unattended — organizer sites + ` +
    `social pages need <code>web_fetch</code>.</p>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: "promoter-enrichment-notice",
      });
      console.log(`[cron] promoter-enrichment-notice fired — count=${count} to=${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: "[promoter-enrichment-notice] email enqueue failed",
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
      message: `[promoter-enrichment-notice] would notify (count=${count}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      context: { count, hasAlertEmail: !!alertEmail, hasQueue: !!env.EMAIL_JOBS },
    });
  }

  // Upsert debounce row regardless of dispatch outcome — a failed send is a
  // channel problem, not a reason to re-fire every run; the ≤1/day + changed
  // gate is the mute window we want either way.
  try {
    await db
      .insert(promoterEnrichmentNoticeState)
      .values({
        id: NOTICE_KEY,
        lastNoticeDate: today,
        lastQueueCount: count,
        lastNotifiedAt: now,
      })
      .onConflictDoUpdate({
        target: promoterEnrichmentNoticeState.id,
        set: {
          lastNoticeDate: today,
          lastQueueCount: count,
          lastNotifiedAt: now,
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[promoter-enrichment-notice] debounce upsert failed",
      error,
      context: { count },
    });
  }
}

// Exported for unit tests.
export const __test = {
  decidePromoterEnrichmentNotice,
  utcDayKey,
  escapeHtml,
  formatCoverageLine,
  NOTICE_KEY,
  SAMPLE_LIMIT,
  COVERAGE_FIELDS,
};
