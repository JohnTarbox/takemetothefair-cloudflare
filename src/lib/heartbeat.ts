/**
 * OPE-246 — post-ship first-evidence heartbeat.
 *
 * The single most-recurring MMATF defect is "shipped but silently not executing"
 * (≥9 instances: IndexNow dead 2wk, fault emitter never ran, OCR silent no-op,
 * GW1d never scored a row…). Each was caught by a human noticing, days-to-weeks
 * late. This makes the check infrastructure: every probed path declares the D1
 * evidence it should keep producing; if a probe goes silent past its window it
 * escalates through the SAME OPE-75 digest that already reaches John, and — via
 * the OPE-76 filing rail — gets auto-proposed as a defect OPE.
 *
 * Design — EXTEND OPE-243, don't duplicate:
 *  - probe DEFINITIONS are code (mirrors gatherQueueFlows); the ONE stateful,
 *    operator-settable datum is `enabled_at`, in the `heartbeat_probes` table.
 *  - the silence decision reuses OPE-243's exact shape (anchor = last-evidence ??
 *    enabled-at; `shouldBeActive` gates dormant/gated paths so a deliberately-off
 *    flag is never a false RED).
 *  - auto-file dedup reuses OPE-76's `cpi_signal_filings` ledger — nothing new.
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import {
  adminActions,
  eventDiscrepancies,
  emailSendLedger,
  heartbeatProbes,
  inboundEmails,
  imageCoverageState,
  newsletterIssues,
  photoCoverageDaily,
  ga4DailyMetrics,
  membraneCrossings,
  gscSearchMetrics,
  promoterEnrichmentCandidates,
  recommendationScanState,
  vendorClaimEvidence,
  vendorEnrichmentCandidates,
} from "@/lib/db/schema";
import { SITE_URL } from "@takemetothefair/constants";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@/lib/analytics-overview/shared";

const MS_PER_HOUR = 3_600_000;
export const HEARTBEAT_HREF = `${SITE_URL}/admin/analytics#heartbeat-probes`;

/**
 * A probe: an owned execution path + the D1 evidence it should keep producing.
 * `lastEvidenceAt` is the ONLY query — silence is "how long since the newest
 * evidence row". `expectedWindowHours` is generous for low-traffic paths so a
 * quiet week isn't a false alarm.
 */
export interface HeartbeatProbe {
  name: string; // stable key → fingerprint `cpi:heartbeat:<name>`
  ownerOpe: string;
  label: string;
  priority: "P0" | "P1";
  expectedWindowHours: number;
  /** Newest evidence-row timestamp, or null if the path has never produced any. */
  lastEvidenceAt: (db: Db) => Promise<Date | null>;
}

async function maxTs(
  db: Db,
  table: SQLiteTable,
  col: AnyColumn,
  where?: SQL
): Promise<Date | null> {
  const [r] = await db
    .select({ t: sql<number | null>`max(${col})` })
    .from(table)
    .where(where);
  return r?.t != null ? new Date(Number(r.t) * 1000) : null;
}

/**
 * The probe registry. Each entry's evidence query mirrors the write it guards.
 * Windows: high-traffic paths (email, detection) short; low-traffic (photos,
 * submissions) long. A gated path (booth auto-write) has NO evidence yet AND is
 * DORMANT via a null `enabled_at` — it can't false-fire until John flips the flag.
 */
export const HEARTBEAT_PROBES: HeartbeatProbe[] = [
  {
    name: "photo-intake",
    ownerOpe: "OPE-202",
    label: "Photo-intake lane",
    priority: "P1",
    expectedWindowHours: 30 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, inboundEmails, inboundEmails.receivedAt, eq(inboundEmails.intent, "photo_intake")),
  },
  {
    name: "ocr-attachment",
    ownerOpe: "OPE-68",
    label: "Attachment OCR/extract",
    priority: "P1",
    expectedWindowHours: 21 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, inboundEmails, inboundEmails.receivedAt, isNotNull(inboundEmails.attachmentRefs)),
  },
  {
    name: "email-send",
    ownerOpe: "OPE-151",
    label: "Outbound email (send ledger)",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) =>
      maxTs(db, emailSendLedger, emailSendLedger.sentAt, eq(emailSendLedger.status, "sent")),
  },
  {
    name: "inbound-submit",
    ownerOpe: "OPE-174",
    label: "Inbound event submissions",
    priority: "P1",
    expectedWindowHours: 21 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, inboundEmails, inboundEmails.receivedAt, eq(inboundEmails.intent, "submit")),
  },
  {
    // OPE-284 — the newsletter broadcast path. Evidence is deliberately
    // `newsletter_issues.sent_at`, NOT the send ledger: a `test_recipient`
    // preview writes ledger rows with the same `newsletter:weekly-digest`
    // source, so a ledger-keyed probe would go green on a preview to John while
    // the list received nothing. `sent_at` is stamped only by a real broadcast
    // (the send route's isBroadcast branch and the OPE-231 approve latch).
    //
    // Window is 21d, not 7d: a real send needs John's approve click, so a
    // skipped week is normal operation, not a defect. Three silent weeks means
    // the flow is broken — which is exactly the failure that hid here before
    // (the gate silently reverted to "false" on a deploy and no one knew until
    // an approve click failed).
    name: "newsletter-broadcast",
    ownerOpe: "OPE-284",
    label: "Newsletter broadcast (real sends)",
    priority: "P1",
    expectedWindowHours: 21 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, newsletterIssues, newsletterIssues.sentAt, isNotNull(newsletterIssues.sentAt)),
  },
  {
    name: "vendor-enrichment",
    ownerOpe: "OPE-I1",
    label: "Vendor enrichment cron",
    priority: "P1",
    expectedWindowHours: 7 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, vendorEnrichmentCandidates, vendorEnrichmentCandidates.createdAt),
  },
  {
    // OPE-225 — the photo-coverage rails' single writer. Evidence is the
    // freshest `checked_at`: the scan touches EVERY live entity on each run, so
    // a stale max means the scan itself stopped, not merely that no image
    // changed. A probe keyed on image CHANGES would sit silent during a genuine
    // no-change week and be indistinguishable from a dead scan.
    name: "image-coverage-scan",
    ownerOpe: "OPE-225",
    label: "Photo-coverage scan",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, imageCoverageState, imageCoverageState.checkedAt),
  },
  {
    // OPE-225 PR2 — the rot sweep. Evidence is the freshest url_checked_at:
    // the sweep stamps it on EVERY row it checks, healthy or dead, so a stale
    // max means the sweep stopped rather than that nothing rotted. Window is
    // wider than the scan's because this one round-robins ~60 URLs a night.
    name: "image-url-health-sweep",
    ownerOpe: "OPE-225",
    label: "Image URL rot sweep",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, imageCoverageState, imageCoverageState.urlCheckedAt),
  },
  {
    // OPE-226 — the scorecard's snapshot writer, which runs inside the daily
    // coverage scan. It gets its OWN probe rather than riding on the scan's
    // because the two can fail independently: the snapshot write is fail-soft
    // by design (a snapshot error must not fail a good scan), so it can be
    // broken for weeks while `image-coverage-scan` stays green — and the only
    // visible symptom would be a trend that stops moving, which looks exactly
    // like a metric that legitimately did not change.
    name: "photo-coverage-snapshot",
    ownerOpe: "OPE-226",
    label: "Photo-coverage daily snapshot",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, photoCoverageDaily, photoCoverageDaily.updatedAt),
  },
  {
    // OPE-237 — every vendor SELF-REGISTRATION must write a realness-evidence
    // row. Evidence is created_at rather than assessed_at: created_at proves
    // the inline write at signup fired, which is the part that can silently
    // regress if the register route is refactored. assessed_at only moves when
    // a registrant declares a website, so keying on it would read RED for a
    // fortnight of perfectly healthy website-less craft-vendor signups.
    //
    // 30-day window: ~13 self-registrations in the 16 days to 2026-07-27, but
    // signups are seasonal (they stop dead after fair season), so a tighter
    // window would false-fire every quiet fortnight.
    name: "vendor-claim-evidence",
    ownerOpe: "OPE-237",
    label: "Vendor registration realness screen",
    priority: "P1",
    expectedWindowHours: 30 * 24,
    lastEvidenceAt: (db) => maxTs(db, vendorClaimEvidence, vendorClaimEvidence.createdAt),
  },
  {
    name: "promoter-enrichment",
    ownerOpe: "OPE-36",
    label: "Promoter enrichment cron",
    priority: "P1",
    expectedWindowHours: 7 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, promoterEnrichmentCandidates, promoterEnrichmentCandidates.createdAt),
  },
  {
    name: "discrepancy-detection",
    ownerOpe: "OPE-GW1",
    label: "Discrepancy detection",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, eventDiscrepancies, eventDiscrepancies.detectedAt),
  },
  {
    name: "gw1d-scorer",
    ownerOpe: "OPE-245",
    label: "GW1d outreach scorer",
    priority: "P1",
    expectedWindowHours: 7 * 24,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        eventDiscrepancies,
        eventDiscrepancies.detectedAt,
        isNotNull(eventDiscrepancies.outreachPriorityScore)
      ),
  },
  {
    name: "booth-autowrite",
    ownerOpe: "OPE-240",
    label: "Booth-photo auto-write",
    priority: "P1",
    expectedWindowHours: 14 * 24,
    // Gated by PHOTO_AUTOWRITE_ENABLED (off). Dormant until enabled_at is set.
    // Action string mirrors mcp-server BOOTH_AUTOWRITTEN_ACTION (auto-write.ts:30).
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        adminActions,
        adminActions.createdAt,
        eq(adminActions.action, "vendor.photo_autowritten")
      ),
  },
  // ── OPE-309 (assurance audit A6 / A7) ──────────────────────────────
  //
  // Three genuinely PERIODIC feeds. All three are written by the 06:00Z daily
  // cron and were last written 2026-08-03 06:00Z when these were added, so a
  // 48h window tolerates exactly one missed run before going red — long enough
  // that a single hiccup is not an alarm, short enough that a dead feed is
  // caught the next morning.
  //
  // A6 called these the highest-blast-radius silent gap, and rightly: both
  // metrics tables back KPI tiles, so if ingestion stops the tiles keep showing
  // the last-known number indefinitely and nothing notices.
  //
  // NOTE — the audit also asked for a "fault-emitter" probe. Deliberately NOT
  // added. fault_signatures.last_seen only advances WHEN A FAULT OCCURS, so a
  // quiet period is indistinguishable from a dead emitter (it stood at 51.7h
  // when this shipped, with nothing wrong). Probing it would rebuild the exact
  // false-STALE pattern OPE-295 removed: a freshness SLA on a signal whose
  // cadence is driven by events rather than a schedule. Probe periodic feeds;
  // for event-driven ones, absence is not evidence.
  {
    name: "gsc-search-metrics-ingest",
    ownerOpe: "OPE-309",
    label: "GSC search-metrics ingest",
    priority: "P0",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, gscSearchMetrics, gscSearchMetrics.updatedAt),
  },
  {
    name: "ga4-daily-metrics-ingest",
    ownerOpe: "OPE-309",
    label: "GA4 daily-metrics ingest",
    priority: "P0",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, ga4DailyMetrics, ga4DailyMetrics.updatedAt),
  },
  {
    name: "recommendation-scan",
    ownerOpe: "OPE-309",
    label: "Recommendation scan (cron output)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, recommendationScanState, recommendationScanState.lastRunAt),
  },
  // ── OPE-330 (Demux D-4) ────────────────────────────────────────────
  //
  // The crossing ledger only helps if it is ALIVE. If recordCrossing silently
  // stopped writing — a binding change, a schema drift — every boundary would
  // go back to being invisible and nothing would say so. That is precisely the
  // silent-boundary failure the ledger exists to end, so the ledger needs its
  // own liveness check.
  //
  // 72h: inbound email is not daily, and a quiet weekend must not read as a
  // dead writer. Note this probes the LEDGER, not the holds — "a hold with no
  // exit" is a JOIN the operator runs against source_ref, not a silence signal,
  // because a legitimately-open hold is indistinguishable from a stalled one
  // by age alone.
  {
    name: "membrane-crossing-ledger",
    ownerOpe: "OPE-330",
    label: "Membrane-crossing ledger",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, membraneCrossings, membraneCrossings.createdAt),
  },
];

/** A probe joined to its enablement anchor + newest evidence — the input to the
 *  pure silence decision. Mirrors OPE-243's IntegrationActivity. */
export interface HeartbeatActivity {
  probe: HeartbeatProbe;
  /** Operator-set enablement time; null = dormant (never fires). */
  enabledAt: Date | null;
  lastEvidenceAt: Date | null;
}

/**
 * Pure decision: is this probe SILENT past its window? Returns null when
 * dormant (`enabledAt` null), when there's no anchor to age from, or when the
 * newest evidence is recent enough. Never throws. Mirrors
 * `assessIntegrationSilence` (OPE-243).
 */
export function assessHeartbeatSilence(a: HeartbeatActivity, now: Date): StaleRed | null {
  if (a.enabledAt === null) return null; // dormant — nothing shipped/enabled yet

  // Silence clock = newest evidence, or (if none ever) since enablement.
  const anchor = a.lastEvidenceAt ?? a.enabledAt;
  const hoursSilent = (now.getTime() - anchor.getTime()) / MS_PER_HOUR;
  if (hoursSilent <= a.probe.expectedWindowHours) return null; // producing → healthy

  const neverProduced = a.lastEvidenceAt === null;
  const days = Math.floor(hoursSilent / 24);
  const title =
    `${a.probe.label} (${a.probe.ownerOpe}): 0 evidence rows in ~${days}d ` +
    `(expected within ${Math.round(a.probe.expectedWindowHours / 24)}d of activity)` +
    (neverProduced ? " — no evidence on record since enablement" : "");

  return {
    priority: a.probe.priority,
    title,
    refKey: `heartbeat:${a.probe.name}`,
    href: HEARTBEAT_HREF,
    firstDetectedAt: anchor.toISOString(),
    hoursInRed: hoursSilent,
  };
}

/** Join every probe to its `heartbeat_probes.enabled_at` + newest evidence. */
export async function gatherHeartbeatActivity(db: Db): Promise<HeartbeatActivity[]> {
  const anchors = await db
    .select({ probeName: heartbeatProbes.probeName, enabledAt: heartbeatProbes.enabledAt })
    .from(heartbeatProbes);
  const enabledByName = new Map(anchors.map((a) => [a.probeName, a.enabledAt ?? null]));

  return Promise.all(
    HEARTBEAT_PROBES.map(async (probe) => ({
      probe,
      enabledAt: enabledByName.get(probe.name) ?? null,
      lastEvidenceAt: await probe.lastEvidenceAt(db),
    }))
  );
}

/** Assess all probes; returns the silent ones as StaleReds (healthy drop out). */
export async function assessAllHeartbeat(db: Db, now: Date): Promise<StaleRed[]> {
  const activities = await gatherHeartbeatActivity(db);
  const out: StaleRed[] = [];
  for (const a of activities) {
    const red = assessHeartbeatSilence(a, now);
    if (red) out.push(red);
  }
  return out;
}

/** Tile row for /admin/analytics. */
export type HeartbeatProbeTileRow = {
  name: string;
  label: string;
  ownerOpe: string;
  enabled: boolean;
  lastEvidenceAt: number | null; // ms-epoch
  hoursSilent: number | null;
  expectedWindowHours: number;
  silent: boolean;
};
export type HeartbeatCard = { probes: HeartbeatProbeTileRow[] };

/** Tile loader — reuses gather + assess so the tile's `silent` flag matches the
 *  digest (exactly as loadQueueDrain reuses assessQueueFreeze). */
export async function loadHeartbeat(db: Db): Promise<HeartbeatCard> {
  const now = new Date();
  const activities = await gatherHeartbeatActivity(db);
  return {
    probes: activities.map((a) => {
      const anchor = a.lastEvidenceAt ?? a.enabledAt;
      const hoursSilent = anchor === null ? null : (now.getTime() - anchor.getTime()) / MS_PER_HOUR;
      return {
        name: a.probe.name,
        label: a.probe.label,
        ownerOpe: a.probe.ownerOpe,
        enabled: a.enabledAt !== null,
        lastEvidenceAt: a.lastEvidenceAt ? a.lastEvidenceAt.getTime() : null,
        hoursSilent,
        expectedWindowHours: a.probe.expectedWindowHours,
        silent: assessHeartbeatSilence(a, now) !== null,
      };
    }),
  };
}
