export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { SITE_URL } from "@takemetothefair/constants";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getLatestKpiStates } from "@/lib/kpi-states";
import { loadActionQueue } from "@/lib/analytics-overview/activity";
import { enqueueEmail } from "@/lib/queues/producers";
import { logError } from "@/lib/logger";
import { faultSignatures } from "@/lib/db/schema";
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

    const allReds = [...reds, ...faultReds];

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
