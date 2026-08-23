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
  bingLivenessLog,
  eventDiscrepancies,
  emailSendLedger,
  emailDeliveryEvents,
  heartbeatProbes,
  siteHealthRefreshState,
  agentHeartbeats,
  errorLogs,
  eventSeries,
  inboundEmails,
  imageCoverageState,
  newsletterIssues,
  photoCoverageDaily,
  ga4DailyMetrics,
  membraneCrossings,
  promoterOutreachAttempts,
  gscDailyTotals,
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
    // OPE-348 — proof the agent-silence watchdog is ITSELF executing.
    //
    // The watchdog's normal output is silence, so "no alert" is indistinguishable
    // from "the watchdog is dead" — which is the same shape as the outage it
    // exists to catch, one level up. It therefore stamps a run row on EVERY run
    // (kind='watchdog'), and this probe watches that stamp.
    //
    // Deliberately NOT watching kind='agent' rows: those going stale is the
    // condition the watchdog reports, not a defect in the watchdog.
    name: "agent-silence-watchdog",
    ownerOpe: "OPE-348",
    label: "Agent-silence watchdog (Cloudflare cron)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(db, agentHeartbeats, agentHeartbeats.lastSeenAt, eq(agentHeartbeats.kind, "watchdog")),
  },
  {
    // OPE-345 (A6 freshness) — the summable GSC feed. A gap here means the
    // daily ingest stopped, which would otherwise leave every property-level
    // number quietly frozen at a still-plausible value.
    name: "gsc-daily-totals",
    ownerOpe: "OPE-345",
    label: "GSC property daily totals",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, gscDailyTotals, gscDailyTotals.updatedAt),
  },
  {
    // OPE-363 — proof the synthetic funnel canary is still RUNNING.
    //
    // The CI job going red says "the canary ran and failed". Nothing says "the
    // canary stopped running" — a deleted schedule, an expired token or a
    // disabled workflow all look identical to a healthy green week. That is the
    // exact shape of the 2026-08-05→09 outage, where every dead-man check ran on
    // the thing it was watching.
    //
    // Watches kind='canary' explicitly, NOT the whole table: the agent-silence
    // probe above filters kind='watchdog', and agent rows are kind='agent'. One
    // table, three independent liveness questions, each pinned to its own kind.
    //
    // 48h against a daily schedule — one missed run is a blip (a runner outage,
    // a rate limit), two is a pattern.
    name: "funnel-canary",
    ownerOpe: "OPE-363",
    label: "Synthetic funnel canary (register/claim/submit, mobile)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        agentHeartbeats,
        agentHeartbeats.lastSeenAt,
        eq(agentHeartbeats.agentCode, "canary:funnel")
      ),
  },
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
    // OPE-403 — proof the lane still RECORDS what it stored.
    //
    // The probe directly above watches `intent='photo_intake'` arrivals, and it
    // stayed green through the 2026-08-15 loss: five emails arrived, were acked
    // as matched, and stored nothing. Arrivals were never the problem.
    //
    // The reconciliation in `photo-intake-reconcile.ts` catches the WRONG
    // outcome (`photos_stored = 0`). This probe catches the case that
    // reconciliation is blind to: the write disappearing entirely. If a refactor
    // drops the `photosStored` update, no row is ever 0, the reconciliation sees
    // a clean table and reports healthy — which is precisely the shape of the
    // original defect, one level up. Liveness and reconciliation are not
    // redundant here; each is the other's blind spot.
    //
    // NOT gated: the count is written whenever a photo email with attachments is
    // processed, regardless of PHOTO_VISION_ENABLED. A 0 written while the gate
    // is off is evidence the lane is working as designed, not evidence of a gap.
    name: "photo-intake-storage-record",
    ownerOpe: "OPE-403",
    label: "Photo-intake storage accounting",
    priority: "P1",
    // Matches the sibling probe: this lane is seasonal and genuinely quiet for
    // weeks at a time, so a tighter window would page for winter, not for a bug.
    expectedWindowHours: 30 * 24,
    lastEvidenceAt: (db) =>
      maxTs(db, inboundEmails, inboundEmails.receivedAt, isNotNull(inboundEmails.photosStored)),
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
    // OPE-177 — proof the Email Sending event subscription is still publishing.
    //
    // Distinct from the `email-send` probe directly above, which watches that we
    // still SEND. That one stayed green for the entire failure this ticket is
    // about: three verification emails went out, all recorded 'sent', and none
    // arrived. Sending was never the problem — knowing what happened next was.
    //
    // A dead subscription is invisible by construction: no events arrive, no
    // error is raised, and every ledger row simply keeps reading 'sent' with a
    // NULL delivery_status. That is indistinguishable from "our mail is fine"
    // unless something watches for the silence.
    //
    // 72h window: at ~15 sends/day every day produces delivered events, so three
    // silent days is a fault, not a quiet weekend. Seeded dormant (enabled_at
    // NULL in drizzle/0193) because a probe enabled ahead of its producer just
    // teaches the operator to ignore reds.
    //
    // ENABLED 2026-08-23, once the producer was proven rather than assumed. The
    // subscription was created 08-17 00:57:28Z and the first event did not
    // arrive until 06:01:37Z — a ~5h gap on Cloudflare's side that read exactly
    // like a dead subscription while it lasted, and briefly got recorded as one.
    // Do not treat a few silent hours after creating a subscription as evidence
    // of anything.
    //
    // The window is now measured, not estimated: 91 events over the first seven
    // days, 6-32 per day, with no zero days. 72h holds.
    name: "email-delivery-events",
    ownerOpe: "OPE-177",
    label: "Email delivery events (CF subscription)",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, emailDeliveryEvents, emailDeliveryEvents.receivedAt),
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
  // NOTE — the audit also asked for a "fault-emitter" probe watching
  // `fault_signatures.last_seen`. Still deliberately NOT added, and the reasoning
  // stands: that column only advances WHEN A FAULT OCCURS, so a quiet period is
  // indistinguishable from a dead emitter (it stood at 51.7h when this shipped,
  // with nothing wrong). Probing it would rebuild the exact false-STALE pattern
  // OPE-295 removed — a freshness SLA on a signal whose cadence is driven by
  // events rather than a schedule.
  //
  // OPE-488 found the probe that IS sound, by applying that same rule instead of
  // overturning it. The emitter writes one `mcp:fault-signatures-emit` info row
  // per RUN, hourly, whether or not it finds anything. That signal is
  // schedule-driven, so absence genuinely is evidence — the distinction this note
  // already drew. Probe the run, never the yield.
  //
  // Why it was worth adding: on 2026-08-19 the ledger had not moved in ~50h and
  // two tickets were filed asserting the emitter had stopped. It had not — it ran
  // every hour on schedule, and the ledger was quiet because ChunkLoadError is on
  // the curated NOISE_DENYLIST by design. This probe answers "did it run?"
  // definitively, so that question never again has to be inferred from the ledger.
  {
    // OPE-472 rework. The defect this probe exists for is not a crash — it is
    // SILENCE. `event_series` was backfilled once and went inert for seven
    // weeks while every new event was born unparented, and nothing said so;
    // the newest-series date sat frozen at 2026-06-30 and no one was looking.
    //
    // Evidence is a series row being CREATED, not an orphan count falling.
    // The orphan total legitimately climbs whenever a venue-less event arrives
    // (the resolver skips those by design), so it cannot distinguish "working"
    // from "dead" — reading it that way is what produced a REVIEW FAIL against
    // a live fix on 2026-08-20.
    //
    // 336h (14d) because series creation is demand-driven: a parent is minted
    // only for the FIRST edition of a fair at a venue, and a quiet fortnight of
    // familiar events is normal. Prod rate at ship time was ~4 series/day, so
    // 14d of true silence is a real signal rather than a slow week.
    name: "series-write-path",
    ownerOpe: "OPE-472",
    label: "Series parent minted at event write time",
    priority: "P1",
    expectedWindowHours: 336,
    lastEvidenceAt: (db) => maxTs(db, eventSeries, eventSeries.createdAt),
  },
  {
    name: "fault-emitter-run",
    ownerOpe: "OPE-488",
    label: "Render-fault emitter run (hourly cron)",
    priority: "P1",
    // Hourly cron; 6h tolerates a few missed fires without crying wolf.
    expectedWindowHours: 6,
    lastEvidenceAt: (db) =>
      maxTs(db, errorLogs, errorLogs.timestamp, eq(errorLogs.source, "mcp:fault-signatures-emit")),
  },
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
  // ── OPE-309 (assurance audit A5) ───────────────────────────────────
  //
  // Evidence is the freshest GREEN check, not the freshest check. That single
  // choice makes ONE probe answer both questions that matter:
  //   - Bing has been unhealthy for 2+ days  → no new green rows → RED
  //   - the prober itself stopped running    → no new green rows → RED
  // Both demand the same operator move (go look at Bing), and the log row
  // carries `status`/`error` so which one it is takes a single query.
  //
  // Keying on checked_at instead would be the classic verify-by-echo mistake:
  // the check would keep stamping rows saying "critical" every morning and the
  // probe would call that healthy, because something was still writing.
  //
  // 48h matches BING_ALERT_AFTER_CONSECUTIVE=2 on a daily cron, so the probe
  // and the streak counter cross their thresholds together instead of
  // disagreeing about when Bing is in trouble.
  //
  // P0 per the ticket's "consecutive-failure P0 escalation". Note this rail —
  // assessAllHeartbeat → StaleRed → OPE-75 digest — is deliberately NOT the
  // admin_actions row the GA4 original writes: nothing reads admin_actions as
  // an alert channel, which is why ga4.liveness_alert has fired 96 times since
  // 2026-05-07 without ever reaching anyone.
  {
    name: "bing-liveness",
    ownerOpe: "OPE-309",
    label: "Bing Webmaster API liveness",
    priority: "P0",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(db, bingLivenessLog, bingLivenessLog.checkedAt, eq(bingLivenessLog.status, "green")),
  },
  // ── OPE-309 (assurance audit A7/A8, third instance) ─────────────────
  //
  // The site-health refresh, probed on its RUN rather than its output.
  //
  // Measured before choosing: BING_SCAN / BING_SITEMAP / GSC_SITEMAP — the
  // three sources this cron owns — have written ZERO rows across the entire
  // life of `health_issues` (639 rows, all GSC_URL_INSPECTION + 1
  // EMAIL_DELIVERY). Not a dead cron: Bing's GetCrawlIssues genuinely returns
  // [] and all 8 sitemaps report Success. A healthy site produces no issue
  // rows, indefinitely.
  //
  // So an output-freshness probe here would sit permanently RED on a perfectly
  // working feed — the same false-STALE pattern declined for the fault emitter
  // on this very ticket. The distinction is that the fault emitter's RUN is
  // event-driven too, whereas this one is a daily cron: the run is periodic
  // even though the output is not, so the run is what gets stamped and read.
  {
    name: "site-health-refresh",
    ownerOpe: "OPE-309",
    label: "Site-health refresh (cron output)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) => maxTs(db, siteHealthRefreshState, siteHealthRefreshState.lastRunAt),
  },
  {
    name: "membrane-crossing-ledger",
    ownerOpe: "OPE-330",
    label: "Membrane-crossing ledger",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, membraneCrossings, membraneCrossings.createdAt),
  },
  {
    // OPE-384 stage 1 — promoter confirmation outreach.
    //
    // ⚠️ Ships DORMANT (`enabled_at` NULL). `PROMOTER_OUTREACH_ENABLED` is
    // "false" until John approves the organizer-facing copy, and a probe that
    // fired while the capability was deliberately switched off would be pure
    // noise. Set `enabled_at` the day the flag flips — that is the whole
    // convention the OPE-246 rule describes for gated ships.
    //
    // Watches `created_at`, not `sent_at`, on purpose. The row is written
    // BEFORE the send and survives a gated refusal, so this measures "is the
    // capability being exercised at all" rather than "is mail going out" —
    // which is the question that distinguishes a dead rail from a paused one.
    name: "promoter-outreach-attempts",
    ownerOpe: "OPE-384",
    label: "Promoter confirmation outreach",
    // P1 like every other probe. This is less urgent than a dead GSC feed, and
    // the type offers only P0/P1 — widening the union to say so would reach
    // into the alerting pipeline for a cosmetic gain. Once enabled, a silent
    // outreach rail IS the shipped-but-never-executing class, so P1 is not a
    // misfit; the long 14-day window carries the "this is slower-moving"
    // signal instead.
    priority: "P1",
    expectedWindowHours: 14 * 24,
    lastEvidenceAt: (db) => maxTs(db, promoterOutreachAttempts, promoterOutreachAttempts.createdAt),
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
