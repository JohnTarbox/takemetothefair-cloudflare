export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { SITE_URL } from "@takemetothefair/constants";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getLatestKpiStates } from "@/lib/kpi-states";
import { loadActionQueue } from "@/lib/analytics-overview/activity";
import { enqueueEmail } from "@/lib/queues/producers";
import { logError } from "@/lib/logger";
import { faultSignatures, indexnowSubmissions, pendingSearchPings } from "@/lib/db/schema";
import { count, desc, eq, isNull } from "drizzle-orm";
import { getIndexNowQuota, type BingEnv } from "@/lib/bing-webmaster";
import { assessAllIntegrationSilence, type IntegrationActivity } from "@/lib/integration-silence";
import { assessAllQueueFreeze } from "@/lib/queue-freeze";
import { gatherQueueFlows, persistQueueSnapshots } from "@/lib/analytics-overview/queue-drain";
import { assessAllHeartbeat } from "@/lib/heartbeat";
import {
  formatStaleRedDigest,
  selectStaleFaultReds,
  selectStaleReds,
  type StaleRed,
} from "@/lib/cpi/stale-reds";

/**
 * POST /api/internal/cpi/stale-red-scan  (OPE-75 — CPI Move 1)
 *
 * Turns the pull-only dashboard into a self-escalating loop. Rebuilds the §6.3
 * action queue via the same path the overview page uses (latest KPI states →
 * loadActionQueue), picks the P0/P1 signals that have been red past their
 * threshold, and — when any exist and ALERT_EMAIL_TECHNICAL is set — enqueues
 * ONE operator digest. Auth: X-Internal-Key (called by the MCP daily cron).
 *
 * Best-effort + defensive by contract: the email send is fire-and-forget (a
 * failure returns ok:true with sent:false and logs, never 500s) and the whole
 * scan is wrapped so it never throws. De-dup/cadence is inherent — the daily
 * cron fires this at most once/day, re-listing whatever is currently stale, so
 * a persistent problem keeps nagging daily (the whole point vs. the IndexNow
 * silence) without producing a per-run flood.
 */

/** Read a runtime env var via CF bindings; falls back to process.env for local/dev. */
function getRuntimeEnv(key: string): string | undefined {
  try {
    const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
    return env[key];
  } catch {
    return process.env[key];
  }
}

/**
 * OPE-243 — build the outbound-integration activity table the silence detector
 * reads. Today: IndexNow (Bing). cf-email deliverability (OPE-177) and the Bing
 * sitemap resubmit are the next slots — add a record here, no other change.
 *
 * IndexNow silence signal:
 *   - lastSuccessAt : most recent indexnow_submissions row with status='success'
 *     (NOT the most recent attempt — the pause writes `skipped` rows hourly, and
 *     a skip is a deferral, never a success).
 *   - shouldBeActive: there are unflushed pending_search_pings — i.e. real URLs
 *     queued and waiting. Silence with an empty queue is legitimately idle.
 *   - activeReason  : queue depth + Bing monthly quota remaining, for the digest.
 */
async function gatherIntegrationActivity(
  db: Parameters<typeof loadActionQueue>[0]
): Promise<IntegrationActivity[]> {
  const [lastSuccess] = await db
    .select({ timestamp: indexnowSubmissions.timestamp })
    .from(indexnowSubmissions)
    .where(eq(indexnowSubmissions.status, "success"))
    .orderBy(desc(indexnowSubmissions.timestamp))
    .limit(1);

  const [pendingRow] = await db
    .select({ n: count() })
    .from(pendingSearchPings)
    .where(isNull(pendingSearchPings.flushedAt));
  const pendingCount = Number(pendingRow?.n ?? 0);

  const [oldestPending] = await db
    .select({ queuedAt: pendingSearchPings.queuedAt })
    .from(pendingSearchPings)
    .where(isNull(pendingSearchPings.flushedAt))
    .orderBy(pendingSearchPings.queuedAt)
    .limit(1);

  let quotaNote = "quota unknown";
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    const quota = await getIndexNowQuota(env);
    quotaNote = `Bing monthly quota ${quota.monthlyRemaining}/${quota.monthlyQuota} unspent`;
  } catch {
    // Quota is a nice-to-have detail for the digest body — never block the
    // silence check on the Bing API being reachable.
  }

  return [
    {
      name: "IndexNow (Bing)",
      refKey: "integration-silence:indexnow",
      href: `${SITE_URL}/admin/analytics?tab=site-health`,
      lastSuccessAt: lastSuccess?.timestamp ?? null,
      silentSinceAt: oldestPending?.queuedAt ?? null,
      // Only red when there's real queued work — an empty queue is idle, not silent.
      shouldBeActive: pendingCount > 0,
      activeReason: `${pendingCount} URL(s) queued and unsubmitted; ${quotaNote}`,
    },
  ];
}

export const POST = withInternalKey({ source: "cpi:stale-red-scan" }, async ({ db }) => {
  try {
    const now = new Date();
    const kpiStates = await getLatestKpiStates(db);
    const actionQueue = await loadActionQueue(db, kpiStates);
    const reds = selectStaleReds(actionQueue, now);

    // OPE-83 — merge persistent render-fault reds so a crash-on-every-load page
    // escalates through the same digest instead of waiting on a human report.
    // Defensive: a failure loading the fault ledger degrades to action-queue
    // reds only, so it never breaks the existing KPI stale-red scan.
    let faultReds: StaleRed[] = [];
    try {
      const faultRows = await db
        .select({
          signature: faultSignatures.signature,
          route: faultSignatures.route,
          status: faultSignatures.status,
          firstSeen: faultSignatures.firstSeen,
        })
        .from(faultSignatures);
      faultReds = selectStaleFaultReds(
        faultRows.map((r) => ({
          signature: r.signature,
          route: r.route,
          status: r.status,
          firstSeen: r.firstSeen.getTime(),
        })),
        now
      );
    } catch (err) {
      await logError(db, {
        level: "warn",
        source: "cpi:stale-red-scan",
        message: "fault-red load failed; degrading to action-queue reds",
        error: err,
      });
    }

    // OPE-243 — merge outbound-integration SILENCE reds so a "0 successes while
    // there's queued work" integration (IndexNow silent for 20 days behind
    // Bing's rate latch) escalates through THIS digest instead of a warn log
    // nobody reads. Defensive: any failure gathering integration state degrades
    // to KPI + fault reds only, never breaking the existing scan.
    let integrationReds: StaleRed[] = [];
    try {
      const integrations = await gatherIntegrationActivity(db);
      integrationReds = assessAllIntegrationSilence(integrations, now);
    } catch (err) {
      await logError(db, {
        level: "warn",
        source: "cpi:stale-red-scan",
        message: "integration-silence load failed; degrading to KPI + fault reds",
        error: err,
      });
    }

    // OPE-247 — merge frozen/slow-draining WORK-QUEUE reds (event discrepancies,
    // the three enrichment-review queues, site-health, inbound exceptions) and
    // persist today's drain snapshot for the /admin/analytics tile + trend. The
    // failure this catches: the discrepancy queue grew to 5,890 with 0 daily
    // resolutions and no tile showed it. Defensive: any failure degrades to the
    // prior reds, never breaking the scan.
    let queueReds: StaleRed[] = [];
    try {
      const flows = await gatherQueueFlows(db, now);
      queueReds = assessAllQueueFreeze(flows, now);
      // Persist AFTER assessing so the inbound queue's outflow delta reads the
      // prior day's row, not today's.
      await persistQueueSnapshots(db, flows, now);
    } catch (err) {
      await logError(db, {
        level: "warn",
        source: "cpi:stale-red-scan",
        message: "queue-drain load failed; degrading to KPI + fault + integration reds",
        error: err,
      });
    }

    // OPE-246 — merge post-ship first-evidence heartbeat reds: a shipped write/
    // cron path that has gone SILENT (0 evidence rows past its window) escalates
    // through this digest instead of a human noticing weeks later. Dormant/gated
    // probes (enabled_at NULL) never fire. Defensive: degrades to the prior reds.
    let heartbeatReds: StaleRed[] = [];
    try {
      heartbeatReds = await assessAllHeartbeat(db, now);
    } catch (err) {
      await logError(db, {
        level: "warn",
        source: "cpi:stale-red-scan",
        message: "heartbeat load failed; degrading to KPI + fault + integration + queue reds",
        error: err,
      });
    }

    const allReds = [...reds, ...faultReds, ...integrationReds, ...queueReds, ...heartbeatReds];

    let sent = false;
    if (allReds.length > 0) {
      const to = getRuntimeEnv("ALERT_EMAIL_TECHNICAL");
      if (to) {
        const digest = formatStaleRedDigest(allReds, SITE_URL);
        try {
          // Recipient is the OPERATOR only (ALERT_EMAIL_TECHNICAL) — never a customer.
          await enqueueEmail({
            to,
            subject: digest.subject,
            html: digest.html,
            text: digest.text,
            source: "cpi.stale-red",
          });
          sent = true;
        } catch (err) {
          // Best-effort: a send failure must not fail the scan.
          await logError(db, {
            level: "warn",
            source: "cpi:stale-red-scan",
            message: "stale-red digest enqueue failed; scan still ok",
            error: err,
            context: { count: allReds.length },
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      count: allReds.length,
      sent,
      // No PII — priority, title, and age only.
      signals: allReds.map((r) => ({
        title: r.title,
        priority: r.priority,
        hoursInRed: Math.round(r.hoursInRed),
      })),
    });
  } catch (error) {
    // The scan must never throw / never 500 — a broken scan should be quiet,
    // not an outage. Log and return an empty, well-formed result.
    await logError(db, {
      source: "cpi:stale-red-scan",
      message: "stale-red scan failed",
      error,
    });
    return NextResponse.json({ ok: true, count: 0, sent: false, signals: [] });
  }
});
