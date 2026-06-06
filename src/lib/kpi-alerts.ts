/**
 * §6.3 KPI threshold alerts (analyst Item 8, 2026-05-30).
 *
 * Phase 1 of §6.3 shipped the state machine + dashboard. Item 1 (STALE
 * state, 2026-05-29) added detection of broken data feeds. This adds
 * the third leg: a push notification so a RED or YELLOW transition
 * gets attention in real time rather than waiting for someone to load
 * the Overview tab.
 *
 * Wired into `recomputeKpiStates` — called once per transitioning KPI
 * after the kpi_state_history row is written, so the dispatch already
 * has all the context (prev state, new state, value, computedAt) without
 * a re-read.
 *
 * Routing:
 *   - Revenue/marketing KPIs (site_ctr, conversion_rate, brand_share)
 *     → SLACK_WEBHOOK_URL_BUSINESS + ALERT_EMAIL_BUSINESS
 *   - Technical KPIs (sitemap_quality, time_to_index_h, any STALE-state
 *     breach) → SLACK_WEBHOOK_URL_TECHNICAL + ALERT_EMAIL_TECHNICAL
 *
 * Transition coverage:
 *   - All RED transitions are always sent.
 *   - YELLOW transitions are debounced 72h per KPI — if the same KPI
 *     has been YELLOW in the last 72h, the new YELLOW is silenced so
 *     a noisy oscillating KPI doesn't spam the channel.
 *   - GREEN transitions (resolutions) are NOT sent — the existing
 *     admin_actions `kpi.state_resolved` row covers the audit need.
 *   - STALE transitions are treated like RED — broken feed is an
 *     incident-level signal.
 *
 * Configuration:
 *   - If neither SLACK_WEBHOOK_URL_* nor ALERT_EMAIL_* is set for a
 *     category, alerts for that category no-op (no errors). Lets us
 *     ship the code path before SecOps wires the webhook.
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";
import { kpiStateHistory, adminActions } from "@/lib/db/schema";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { logError } from "@/lib/logger";
import { formatTimestampForServer } from "@/lib/datetime";
import type { KpiName, KpiState } from "@/lib/kpi-thresholds";
import { getCloudflareEnv } from "@/lib/cloudflare";

type Db = DrizzleD1Database<typeof schema>;

type AlertCategory = "business" | "technical";

const CATEGORY_BY_KPI: Record<KpiName, AlertCategory> = {
  site_ctr: "business",
  conversion_rate: "business",
  brand_share: "business",
  sitemap_quality: "technical",
  time_to_index_h: "technical",
};

const KPI_DISPLAY_NAME: Record<KpiName, string> = {
  site_ctr: "Site CTR",
  conversion_rate: "Conversion rate",
  brand_share: "Brand share",
  sitemap_quality: "Sitemap quality",
  time_to_index_h: "Time-to-index",
};

/** Hours of suppression after a YELLOW alert before the next YELLOW for
 *  the same KPI is allowed to fire. RED bypasses this — every RED sends. */
const YELLOW_DEBOUNCE_HOURS = 72;

/** Pull a runtime env var via the Cloudflare bindings. Missing keys
 *  return undefined; caller no-ops if the channel isn't configured. */
function getEnvVar(key: string): string | undefined {
  try {
    const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
    return env[key];
  } catch {
    // Local/dev outside CF context — fall through to process.env.
    return process.env[key];
  }
}

interface AlertConfig {
  slackWebhookUrl?: string;
  alertEmail?: string;
}

function loadConfig(category: AlertCategory): AlertConfig {
  if (category === "business") {
    return {
      slackWebhookUrl: getEnvVar("SLACK_WEBHOOK_URL_BUSINESS"),
      alertEmail: getEnvVar("ALERT_EMAIL_BUSINESS"),
    };
  }
  return {
    slackWebhookUrl: getEnvVar("SLACK_WEBHOOK_URL_TECHNICAL"),
    alertEmail: getEnvVar("ALERT_EMAIL_TECHNICAL"),
  };
}

/** Float-equality epsilon for KPI value comparison (E — ALERT1). The
 *  values that flap between STALE and not-STALE are identical in
 *  practice (the email's evidence shows `sitemap_quality` staying at
 *  exactly 0.548 across all five flips), but an epsilon guard is cheap
 *  insurance against an analytics-layer rounding wobble being read as
 *  a genuine value change. 1e-9 is far below any rendered precision. */
const STALE_FLAP_VALUE_EPSILON = 1e-9;

/**
 * E — ALERT1 (2026-06-06): suppress STALE↔{RED,YELLOW,GREEN} transitions
 * where only data-freshness toggled and the underlying KPI value is
 * unchanged. STALE is keyed on catalog freshness (dataAgeSeconds >
 * staleSlaSeconds), not on the KPI value being uncomputable — so the
 * value is often identical across the flip, making the transition pure
 * noise. (The email cites 7 such alerts on 2026-06-06: 5 sitemap_quality
 * STALE↔RED flaps + 2 GREEN/YELLOW→STALE at midnight, all with values
 * unchanged across the flip.)
 *
 * Returns `true` when the transition is a pure STALE flap and should be
 * suppressed. Caller is `dispatchKpiAlert`.
 *
 * "Value identical" tolerates both-null (e.g. RED with null value flipping
 * to STALE with null value because the catalog stopped updating). Float
 * comparison uses STALE_FLAP_VALUE_EPSILON.
 */
async function isStaleFlap(
  db: Db,
  kpiName: KpiName,
  fromState: KpiState | null,
  toState: KpiState,
  currentValue: number | null
): Promise<boolean> {
  // Must be a transition INTO or OUT OF STALE — anything else is a real
  // state change and never suppressed here.
  const involvesStale = fromState === "STALE" || toState === "STALE";
  if (!involvesStale) return false;
  // Need a previous row to compare value. The most-recent history row
  // for this KPI IS the just-inserted current row (recomputeKpiStates
  // calls dispatch AFTER the insert), so the second-most-recent is the
  // previous. Reuse the same idx_kpi_state_history_kpi_name index the
  // YELLOW debounce uses.
  const recent = await db
    .select({ value: kpiStateHistory.value })
    .from(kpiStateHistory)
    .where(eq(kpiStateHistory.kpiName, kpiName))
    .orderBy(desc(kpiStateHistory.computedAt))
    .limit(2);
  if (recent.length < 2) return false;
  const prevValue = recent[1]?.value ?? null;
  // null == null → identical (e.g. RED-with-null → STALE-with-null when
  // the feed genuinely went away mid-flap).
  if (currentValue === null && prevValue === null) return true;
  if (currentValue === null || prevValue === null) return false;
  return Math.abs(prevValue - currentValue) < STALE_FLAP_VALUE_EPSILON;
}

/**
 * Per-KPI YELLOW debounce. Returns true when the alert should fire
 * (no prior YELLOW for this KPI in the last 72h). The newly-inserted
 * row counts as the "current" YELLOW, so we look for >1 row in the
 * window — if the count is exactly 1, this is the only YELLOW and
 * we let it through.
 */
async function shouldSendYellowAlert(db: Db, kpiName: KpiName): Promise<boolean> {
  const cutoff = new Date(Date.now() - YELLOW_DEBOUNCE_HOURS * 3600_000);
  const rows = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(kpiStateHistory)
    .where(
      and(
        eq(kpiStateHistory.kpiName, kpiName),
        eq(kpiStateHistory.state, "YELLOW"),
        gte(kpiStateHistory.computedAt, cutoff)
      )
    );
  const count = Number(rows[0]?.c ?? 0);
  // If COUNT==1, only the just-inserted YELLOW exists → fire.
  // If COUNT>=2, a prior YELLOW within window already alerted → debounce.
  return count <= 1;
}

interface DispatchResult {
  dispatched: boolean;
  /** "slack" | "email" | "both" | "none" — what actually delivered. */
  channel: "slack" | "email" | "both" | "none";
  reason?: string;
}

interface AlertPayload {
  kpiName: KpiName;
  displayName: string;
  fromState: KpiState | null;
  toState: KpiState;
  value: number | null;
  category: AlertCategory;
  detectedAt: Date;
}

function severityEmoji(toState: KpiState): string {
  switch (toState) {
    case "RED":
      return "🔴";
    case "YELLOW":
      return "🟡";
    case "STALE":
      return "⚪";
    default:
      return "•";
  }
}

function formatValue(kpiName: KpiName, value: number | null): string {
  if (value === null) return "unknown";
  switch (kpiName) {
    case "site_ctr":
    case "conversion_rate":
      return `${(value * 100).toFixed(2)}%`;
    case "brand_share":
      return `${(value * 100).toFixed(1)}%`;
    case "sitemap_quality":
      return `${value.toFixed(1)}`;
    case "time_to_index_h":
      return `${value.toFixed(1)}h`;
    default:
      return String(value);
  }
}

function buildSlackPayload(p: AlertPayload): { text: string; blocks: unknown[] } {
  const emoji = severityEmoji(p.toState);
  const valueStr = formatValue(p.kpiName, p.value);
  const transition = p.fromState ? `${p.fromState} → ${p.toState}` : p.toState;
  const text = `${emoji} *${p.displayName}* transitioned ${transition} — value ${valueStr}`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Detected ${formatTimestampForServer(p.detectedAt)} · <https://meetmeatthefair.com/admin/analytics|Open Analytics>`,
          },
        ],
      },
    ],
  };
}

function buildEmailBody(p: AlertPayload): { subject: string; html: string; text: string } {
  const emoji = severityEmoji(p.toState);
  const valueStr = formatValue(p.kpiName, p.value);
  const transition = p.fromState ? `${p.fromState} → ${p.toState}` : `now ${p.toState}`;
  const subject = `${emoji} KPI alert: ${p.displayName} ${transition}`;
  const text =
    `${p.displayName}\n` +
    `State: ${transition}\n` +
    `Value: ${valueStr}\n` +
    `Detected: ${formatTimestampForServer(p.detectedAt)}\n\n` +
    `Open Analytics: https://meetmeatthefair.com/admin/analytics\n`;
  const html =
    `<p><strong>${emoji} ${p.displayName}</strong> transitioned <strong>${transition}</strong>.</p>` +
    `<ul><li>Value: ${valueStr}</li>` +
    `<li>Detected: ${formatTimestampForServer(p.detectedAt)}</li></ul>` +
    `<p><a href="https://meetmeatthefair.com/admin/analytics">Open Analytics</a></p>`;
  return { subject, html, text };
}

async function postSlackWebhook(
  url: string,
  payload: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<empty>");
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dispatch alert for a KPI state transition. Returns a result describing
 * what (if anything) was delivered. Caller is `recomputeKpiStates` —
 * dispatch errors are logged but never thrown, since a failed alert
 * MUST NOT abort the KPI recompute itself (the data is already written).
 */
export async function dispatchKpiAlert(
  db: Db,
  args: {
    kpiName: KpiName;
    fromState: KpiState | null;
    toState: KpiState;
    value: number | null;
    detectedAt: Date;
  }
): Promise<DispatchResult> {
  const { kpiName, fromState, toState, value, detectedAt } = args;

  // GREEN transitions = resolutions; admin_actions covers the audit need
  // and a "we resolved" alert is more noise than signal.
  if (toState !== "RED" && toState !== "YELLOW" && toState !== "STALE") {
    return { dispatched: false, channel: "none", reason: "non-actionable-state" };
  }

  // E — ALERT1 (2026-06-06): STALE-flap suppression. When ONLY the
  // STALE-ness changed and the value is identical across the flip, the
  // transition is a false positive (catalog freshness ticked past the
  // SLA threshold, value didn't move). Suppress + audit. Genuine state
  // changes (value moved into RED, etc.) are unaffected because the
  // value-equality check fails for them.
  const staleFlap = await isStaleFlap(db, kpiName, fromState, toState, value).catch(() => false);
  if (staleFlap) {
    await db
      .insert(adminActions)
      .values({
        action: "kpi.alert_suppressed_stale_flap",
        actorUserId: null,
        targetType: "kpi",
        targetId: kpiName,
        payloadJson: JSON.stringify({
          kpi: kpiName,
          fromState,
          toState,
          value,
          reason: "stale-flap-value-unchanged",
        }),
        createdAt: detectedAt,
      })
      .catch(async (err) => {
        // Audit-row failure must not derail the suppression — log and continue.
        await logError(db, {
          level: "warn",
          source: "kpi-alerts:suppress-audit",
          message: `Failed to write stale-flap audit row: ${err instanceof Error ? err.message : String(err)}`,
          context: { kpiName, fromState, toState },
        });
      });
    return { dispatched: false, channel: "none", reason: "stale-flap-suppressed" };
  }

  // YELLOW debounce. RED and STALE bypass — both are incident-level.
  if (toState === "YELLOW") {
    const ok = await shouldSendYellowAlert(db, kpiName);
    if (!ok) {
      return { dispatched: false, channel: "none", reason: "yellow-debounced" };
    }
  }

  // STALE always goes to the technical channel regardless of which KPI
  // is stale — it's a feed/pipeline problem, not a business problem.
  const category: AlertCategory = toState === "STALE" ? "technical" : CATEGORY_BY_KPI[kpiName];
  const config = loadConfig(category);
  if (!config.slackWebhookUrl && !config.alertEmail) {
    return { dispatched: false, channel: "none", reason: "no-config" };
  }

  const payload: AlertPayload = {
    kpiName,
    displayName: KPI_DISPLAY_NAME[kpiName],
    fromState,
    toState,
    value,
    category,
    detectedAt,
  };

  let slackOk = false;
  let emailOk = false;

  if (config.slackWebhookUrl) {
    const result = await postSlackWebhook(config.slackWebhookUrl, buildSlackPayload(payload));
    if (result.ok) {
      slackOk = true;
    } else {
      await logError(db, {
        level: "warn",
        source: "kpi-alerts:slack",
        message: `Slack alert failed: ${result.error}`,
        context: { kpiName, toState, category },
      });
    }
  }

  if (config.alertEmail) {
    const emailBody = buildEmailBody(payload);
    const result = await sendEmail(db, {
      to: config.alertEmail,
      subject: emailBody.subject,
      html: emailBody.html,
      text: emailBody.text,
      source: `kpi-alert:${kpiName}`,
    });
    if (result.ok) emailOk = true;
  }

  const channel: DispatchResult["channel"] =
    slackOk && emailOk ? "both" : slackOk ? "slack" : emailOk ? "email" : "none";
  return { dispatched: slackOk || emailOk, channel };
}

// Exported for unit tests.
export const __test = {
  shouldSendYellowAlert,
  isStaleFlap,
  buildSlackPayload,
  buildEmailBody,
  CATEGORY_BY_KPI,
  YELLOW_DEBOUNCE_HOURS,
  STALE_FLAP_VALUE_EPSILON,
  formatValue,
};
