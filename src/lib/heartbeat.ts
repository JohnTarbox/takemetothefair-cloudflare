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
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  entityWriteLog,
  adminActions,
  bingLivenessLog,
  eventDataCitations,
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
  urlHealthChecks,
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
  queueDrainSnapshots,
  workflowRunSteps,
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
    // OPE-847 — proof the roster vendor-linker is still writing.
    //
    // This is the only path in the inbound pipeline that creates PUBLIC vendor
    // profiles, approved by John in session on 2026-09-07. A writer that
    // silently stops is the OPE-246 class; a writer of public rows that
    // silently stops is that class on the surface that matters most.
    //
    // ⚠️ SHIPS DORMANT — `enabled_at = NULL` in migration 0275, deliberately.
    //
    // The emitting population is "submissions whose site publishes a parseable
    // roster". The crawl that produces it shipped TODAY (OPE-837) and has
    // produced zero rows, so there is no inter-arrival distribution to size a
    // window from. Every number I could put here would be an analogy — and a
    // window chosen by analogy is exactly what produced the wrong 72h figure
    // on OPE-830. CLAUDE.md explicitly permits a dormant seed for this reason:
    // a dormant probe never false-fires, whereas a guessed window either cries
    // wolf and gets muted, or sleeps through a real outage.
    //
    // ARMING CONDITION — do not skip this, or the probe is coverage-shaped and
    // covers nothing: once `secondary-page-crawl` has produced enough rows to
    // measure (a) the fraction of crawls that find a roster and (b) the gaps
    // between them, set `enabled_at` and replace the placeholder window with
    // the measured one. Tracked as its own ticket, not left implicit.
    //
    // The 720h below is NOT a measurement and must not be read as one. It is a
    // deliberately loose placeholder that only takes effect the day someone
    // arms the probe, and that person is expected to replace it.
    name: "roster-vendor-link",
    ownerOpe: "OPE-847",
    label: "submit@ roster → vendor linking (public writes)",
    priority: "P1",
    expectedWindowHours: 720,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        workflowRunSteps,
        workflowRunSteps.recordedAt,
        eq(workflowRunSteps.stepName, "roster-vendor-link")
      ),
  },
  {
    // OPE-837 — proof the same-site nav crawl is still executing.
    //
    // This is the OPE-246 class in its purest form. The crawl is enrichment:
    // it fills empty fields and never fails a submission, so if it stops
    // running, every submission still succeeds, every event is still created,
    // and the only symptom is that prices and rosters quietly stop appearing —
    // which is indistinguishable from "the sites we were sent didn't have
    // them". A crawl that never runs and a crawl that runs and finds nothing
    // look identical from the outside (OPE-6 v3.8).
    //
    // ⚠️ Evidence is the `secondary-page-crawl` STEP ROW, not a filled field.
    // The step is written whenever the crawl phase executes, including when it
    // considers zero pages — so it proves EXECUTION rather than yield, which
    // is the distinction this repo has repeatedly got wrong by probing the
    // yield and reading a quiet week as a dead path.
    //
    // 576h, MEASURED — and measured against the right COHORT, which changed
    // the answer. The population that emits this evidence is not "URL
    // submissions" but "URL submissions that produced an event", because the
    // crawl phase only runs once a URL source has yielded one:
    //
    //   all URL submissions, 180d:        151 rows, mean gap 18.0h, MAX 243.2h
    //   ...that produced an event, 180d:   80 rows, mean gap 33.9h, MAX 371.4h
    //
    // Sizing the window on the first number would have put it BELOW the second
    // cohort's observed maximum, so the probe would have gone red on an
    // ordinary quiet fortnight. 576h is ~1.55x the real maximum, the same
    // headroom ratio OPE-803 used, and above every gap in 180 days.
    //
    // ⚠️ Detection is therefore slow by construction (up to 24 days). The
    // signal is slow: this path fires roughly twice a week. A tighter window
    // would cry wolf, and a probe that cries wolf gets muted, and a muted
    // probe reads as coverage while covering nothing.
    name: "submit-secondary-page-crawl",
    ownerOpe: "OPE-837",
    label: "submit@ same-site nav crawl (price / roster reach)",
    priority: "P1",
    expectedWindowHours: 576,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        workflowRunSteps,
        workflowRunSteps.recordedAt,
        eq(workflowRunSteps.stepName, "secondary-page-crawl")
      ),
  },
  {
    // OPE-803 — proof the spam triple-detector is still running.
    //
    // `intent='spam'` is the only terminal state in the inbound lane: across
    // all 19 historical rows, routed_to_workflow / workflow_instance_id /
    // parsed_url / resulting_event_id are ALL zero. A detector that stops
    // running there restores exactly that silence, and nothing downstream
    // would notice, because "no recoveries" is the normal state.
    //
    // ⚠️ Evidence is the `spam.event_triple` telemetry row, written on every
    // QUARANTINED spam row — a MISS, not a hit. That is deliberate: a
    // dry-run over the 19 historical rows scored 1 hit / 19, so a probe
    // watching for RECOVERIES would expect roughly one every 2-3 months and
    // be red almost always. Misses are the high-frequency signal, and they
    // prove the same thing: the detector executed.
    //
    // 504h, MEASURED against spam inter-arrival: 18 gaps, mean 4.3 days,
    // MAXIMUM 14.0 days, none beyond. 336h would sit exactly ON the observed
    // maximum and fire on the next slightly-longer quiet spell — the mistake
    // made on `entity-write-log-writer` a few hours earlier, where a window
    // was chosen by analogy rather than from the gap distribution.
    //
    // ⚠️ Detection is therefore slow by construction: up to 21 days. The
    // signal is slow. A window tight enough to be fast would be a window that
    // cries wolf, and a muted probe reads as coverage while covering nothing.
    name: "spam-event-triple-detector",
    ownerOpe: "OPE-803",
    label: "Spam event-triple detector (inbound quarantine)",
    priority: "P1",
    expectedWindowHours: 504,
    lastEvidenceAt: (db) =>
      maxTs(db, adminActions, adminActions.createdAt, eq(adminActions.action, "spam.event_triple")),
  },
  {
    // OPE-830 — proof the vendor write history is still recording.
    //
    // Two live "my profile won't save" reports in ten days could not be
    // settled because nothing recorded what a save did. This table is the
    // instrument built to settle the third one — and an instrument that
    // silently stops recording is worse than no instrument, because the
    // absence of rows will be read as "no saves happened".
    //
    // ⚠️ Evidence is the newest row of ANY outcome, including `rejected`.
    // Scoping it to `applied` would go red on a quiet week rather than on a
    // broken writer, and would miss the specific regression most worth
    // catching: the rejection path being dropped in a refactor of the auth
    // gate, which compiles clean and breaks no test.
    //
    // 336h, MEASURED — not the 72h this shipped with an hour earlier.
    //
    // I picked 72h by analogy with the citation probe and then checked it
    // against the actual signal, which is `enrichment_log` where
    // `source='vendor_self'` (the same events this table now records). Over
    // the last 60 days: 29 active days, **mean gap 2.0 days, MAXIMUM gap 12
    // days**, and 3 gaps exceeding 72h. A 72h window would have fired red
    // three times in two months on entirely ordinary quiet.
    //
    // That is the failure the comment I wrote for it warned about, committed
    // in the same breath — and it is the exact correction OPE-541 already had
    // to make (drizzle/0231, 72h → 336h) for `venue-decision-writer`.
    // `event-series-write-path` uses 336h for the same reason.
    //
    // ⚠️ The cost is real and accepted: a dead writer takes up to 14 days to
    // surface. A probe that cries wolf gets muted, and a muted probe reads as
    // coverage while covering nothing — strictly worse than a slow one.
    //
    // The better instrument here is a DIVERGENCE check — `enrichment_log`
    // has vendor_self rows in a window but `entity_write_log` has none —
    // which cannot false-fire on quiet at all. It does not fit the
    // `lastEvidenceAt: () => timestamp` shape of this rail; noted for whoever
    // widens that interface.
    name: "entity-write-log-writer",
    ownerOpe: "OPE-830",
    label: "Vendor self-edit write history",
    // P1 because the type admits only P0/P1 — not because a silent write log
    // is as urgent as a dead pipeline. Recorded rather than silently rounded.
    priority: "P1",
    expectedWindowHours: 336,
    lastEvidenceAt: (db) => maxTs(db, entityWriteLog, entityWriteLog.createdAt),
  },
  {
    // OPE-540 — proof that inbound submissions are still producing PROVENANCE.
    //
    // Every email-submitted event created on 2026-08-24 had zero citations,
    // and nobody noticed until an unrelated acceptance criterion happened to
    // check. Nothing watches this table: the pipeline reports success, the
    // event exists and looks complete, and the provenance row simply is not
    // written. A silent writer, which is the exact class OPE-246 exists for.
    //
    // Evidence is the newest citation row of ANY kind. Deliberately not
    // scoped to a source_type or an ingestion path: several writers feed this
    // table (the inbound pipeline, `update_event`'s citation arg, goodwill
    // flips), and a probe narrow enough to name one of them would go red on a
    // quiet week rather than on a broken writer.
    //
    // 72h, not 48: citation volume follows submission volume, which is bursty
    // — the 30-day history has legitimate 3-day gaps with no submissions at
    // all. A window that fires on ordinary quiet is a window that gets muted.
    name: "event-data-citations-writer",
    ownerOpe: "OPE-540",
    label: "Event provenance citations (inbound pipeline)",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) => maxTs(db, eventDataCitations, eventDataCitations.createdAt),
  },
  {
    // OPE-838 — proof the pipeline is still recording WHAT THE SOURCE SAID,
    // not merely that it wrote a citation row.
    //
    // ⚠️ This exists because the probe directly above it CANNOT catch this
    // regression. `event-data-citations-writer` counts a citation of any kind,
    // and a row with a null source_excerpt is still a row — so if the snapshot
    // capture silently stopped, that probe stays green and reports coverage it
    // does not have. Asking "what would this look like if it were inert?"
    // (OPE-6 v3.8) of the existing probe is what produced this one.
    //
    // Evidence is `source_content_hash IS NOT NULL`, and that column is the
    // discriminator on purpose. Measured on prod 2026-09-07 across all 1,539
    // citation rows: source_content_hash is non-null on **0**, while
    // source_title / source_fetched_at are non-null on 44 — the rows an agent
    // wrote by hand through `update_event`'s citation arg. Keying on title or
    // fetched_at would therefore let a HUMAN edit satisfy a probe that exists
    // to watch a MACHINE, which is the vacuous-green shape this probe is
    // guarding against in the first place. Only the automated writer hashes.
    //
    // 504h, MEASURED — not borrowed from the 72h probe above it, whose
    // population (citations from every writer) is an order of magnitude busier
    // than this one (inbound emails that fetched a URL and created an event).
    // Over 180 days that population has 43 active days and 42 gaps: mean 2.67
    // days, MAXIMUM **16 days** (2026-06-05 → 2026-06-21). A 336h window would
    // have fired once on entirely ordinary quiet, and 384h would sit exactly ON
    // the observed maximum — the mistake OPE-830 had to correct twice. 504h
    // clears it with headroom.
    //
    // ⚠️ Armed, not dormant: the writer ships unflagged in this same PR, so
    // there is no flag flip to wait for. With no evidence yet, OPE-243's anchor
    // falls back to `enabled_at`, which makes this a genuine FIRST-evidence
    // probe: if no url-sourced submission produces a hashed citation within 21
    // days of shipping, that is the finding.
    name: "citation-source-snapshot",
    ownerOpe: "OPE-838",
    label: "Citation source snapshot (title/excerpt/hash from the fetch)",
    priority: "P1",
    expectedWindowHours: 504,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        eventDataCitations,
        eventDataCitations.createdAt,
        isNotNull(eventDataCitations.sourceContentHash)
      ),
  },
  {
    // OPE-547 — proof the daily OCCURRED sweep is executing.
    //
    // This cron had no probe, and that is precisely how its defect survived:
    // Pass 3 keyed on `lifecycle_status = 'OCCURRED'`, so 123 past TENTATIVE
    // events were never evaluated, and nothing anywhere said so. The sweep
    // reported success every night while a whole population went unseen.
    //
    // Watching the RUN, not the yield. The yield is not probeable: Pass 1
    // transitions nothing on a day when no event ends, and Pass 3's enqueue
    // count correctly falls to zero once the backlog drains — so a probe on
    // either would go red on a quiet week rather than on a dead cron, the
    // false-fire OPE-541 had to be corrected for. The sweep therefore stamps
    // agent_heartbeats on EVERY run and this watches the stamp.
    //
    // 48h: the sweep is daily, so one missed run is within tolerance and two
    // consecutive misses are not.
    name: "occurred-transition-sweep",
    ownerOpe: "OPE-547",
    label: "Daily OCCURRED transition + roster sweep (MCP cron)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        agentHeartbeats,
        agentHeartbeats.lastSeenAt,
        eq(agentHeartbeats.agentCode, "watchdog:occurred-sweep")
      ),
  },
  {
    // OPE-588 — proof the GSC sweep's FILLER tiers still select work.
    //
    // Tiers 1, 2, 2c and REL5 were unreachable for two months and nothing said
    // so: `fillerBudget = max(0, batchSize - guaranteed.size)` with a 50-URL
    // guaranteed set and a cron that passes batchSize=8 is zero, always. A tier
    // that selects nothing is indistinguishable from a tier with nothing to
    // select, which is exactly the OPE-246 class.
    //
    // ⚠️ This watches a YIELD, which OPE-547 warns against — a yield probe goes
    // red on a quiet week rather than on a dead path. It is the right shape
    // HERE because zero filler is never a quiet week: `fillerBudget` is derived
    // from constants, so zero means the arithmetic regressed, and tier 2c
    // (never-inspected URLs) cannot run dry while ~2,200 sitemap URLs rotate a
    // few per type per night. If it ever does fire on a genuinely empty filler,
    // that means the corpus is fully inspected — which has never been true and
    // would itself be worth knowing.
    //
    // 48h: the sweep is daily, so one missed run is tolerable and two are not.
    name: "gsc-sweep-filler-tiers",
    ownerOpe: "OPE-588",
    label: "GSC sweep filler tiers (Tier 1/2/2c/REL5) selecting work",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        agentHeartbeats,
        agentHeartbeats.lastSeenAt,
        eq(agentHeartbeats.agentCode, "watchdog:gsc-sweep-filler")
      ),
  },
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
    // OPE-532 — proof the held-submission queue is still being MEASURED.
    //
    // This probe exists because of what this ticket found: three separate
    // detectors watched ten submissions be lost on 2026-08-23 and none of them
    // said anything, each for its own reason. Adding a fourth counter without
    // asking "and what tells us THIS one stopped?" would repeat the mistake at
    // one level up.
    //
    // Evidence is a snapshot ROW for this queue name — the measurement running
    // — deliberately NOT the depth. Depth going to zero is the good outcome
    // (the queue drained); depth staying flat is what the queue's own
    // freeze-alert is for. Only the presence of the row distinguishes "nothing
    // is held" from "nobody is looking".
    //
    // 48h against a daily snapshot: one missed run is a blip, two is a pattern.
    name: "inbound-held-submissions-snapshot",
    ownerOpe: "OPE-532",
    label: "Held-submission queue snapshot",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        queueDrainSnapshots,
        queueDrainSnapshots.createdAt,
        eq(queueDrainSnapshots.queueName, "inbound_held_submissions")
      ),
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
    // OPE-637 — proof the verification-threshold tuner is EXECUTING.
    //
    // Watches the info-level `error_logs` row the endpoint writes on EVERY run,
    // not `tunable_thresholds.updated_at`. That distinction is the whole point:
    // the tuner only WRITES when the tuned value actually moves, so a correctly-stable
    // threshold and a dead cron produce byte-identical evidence in the config
    // table. Probing the yield would go red on a healthy week and green on a
    // job that stopped running — exactly backwards.
    //
    // This ticket exists because OPE-177 scope 3 shipped without three of its
    // four constraints and nothing noticed for sixteen days, so a probe on the
    // replacement is not optional.
    //
    // 48h for a daily cron: one missed run is a blip, two is a fault.
    name: "verification-threshold-tuner",
    ownerOpe: "OPE-637",
    label: "Verification staleness threshold self-tune",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        errorLogs,
        errorLogs.timestamp,
        eq(errorLogs.source, "app/api/admin/thresholds/tune-verification")
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
    //
    // ⚠️ OPE-865 — this used to have NO `audience` filter, and covered two
    // independent newsletters through one query. The weekend digest sends far
    // more often than every 21 days, so the vendor digest could be silent
    // indefinitely without this ever going stale — the vendor list going dark
    // being precisely the failure it read as covering. Worse: the accidental
    // vendor broadcast of 2026-09-09 stamped `sent_at` and refreshed the probe
    // for BOTH audiences, so the incident cleared the only signal that could
    // have reported it.
    //
    // It was never inert. It ran, and it would have fired if BOTH newsletters
    // died. It simply could not distinguish the case anyone cares about, which
    // is the amendment-H shape: a control whose population is wider than the
    // condition it claims to watch.
    name: "newsletter-broadcast-weekend",
    ownerOpe: "OPE-284",
    label: "Newsletter broadcast — weekend digest (real sends)",
    priority: "P1",
    expectedWindowHours: 21 * 24,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        newsletterIssues,
        newsletterIssues.sentAt,
        and(isNotNull(newsletterIssues.sentAt), eq(newsletterIssues.audience, "weekend"))
      ),
  },
  {
    // OPE-865 — the vendor half, and it ships DORMANT.
    //
    // ⚠️ `enabled_at` is NULL on purpose (drizzle/0277). Two independent
    // reasons, either of which alone would justify it:
    //
    //   1. Under the PARKED OPE-710(a) ruling, Path A — the only thing that
    //      stamps `newsletter_issues.sent_at` for the vendor audience — is
    //      SUPPOSED to be silent. An armed probe keyed on `sent_at` would be a
    //      permanent false positive, which is exactly the naive canary OPE-855
    //      item H proposed and then withdrew.
    //   2. Path B, the rail that actually sends today, writes NO
    //      `newsletter_issues` row at all while it rides `send_test_email`, so
    //      there is no evidence stream to measure a window from. Any number
    //      written now would be an analogy, and a window chosen by analogy is
    //      what produced the wrong 72h figure on OPE-830 (real gap: 12 days).
    //
    // The 21 * 24 below is the weekend probe's window copied across as a
    // PLACEHOLDER so the registry type-checks. It is not a measurement and must
    // be replaced before arming.
    //
    // ARMING CONDITION (a dormant probe nobody arms is the OPE-6 v3.8 failure
    // wearing a different hat):
    //   1. OPE-610 §4 lands — Path B moves onto a rail that writes a real
    //      `newsletter_issues` row with `audience='vendor'`.
    //   2. Measure the real send cadence from those rows. OPE-855 item H
    //      observed Mondays 11:18–14:09Z with one 23:59Z outlier; that is a
    //      starting point, not the answer.
    //   3. Set `expectedWindowHours` from that measurement, THEN
    //      `UPDATE heartbeat_probes SET enabled_at = unixepoch()
    //         WHERE probe_name = 'newsletter-broadcast-vendor';`
    name: "newsletter-broadcast-vendor",
    ownerOpe: "OPE-865",
    label: "Newsletter broadcast — vendor digest (real sends)",
    priority: "P1",
    expectedWindowHours: 21 * 24,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        newsletterIssues,
        newsletterIssues.sentAt,
        and(isNotNull(newsletterIssues.sentAt), eq(newsletterIssues.audience, "vendor"))
      ),
  },
  {
    // OPE-868 — the promoter website-health sweep RAN.
    //
    // CLAUDE.md (OPE-246) requires a probe in the same PR as a new execution
    // path, and this is one: a sweep driven from the daily event-date-drift
    // workflow, writing url_health_checks rows with source_field
    // 'promoters.website'.
    //
    // Evidence is scoped to THAT source_field, deliberately. OPE-860 already
    // writes to this table from the drift sweep with source_field
    // 'events.source_url', so an unscoped probe would be kept green by the
    // other writer while this one was dead — the exact defect OPE-865 fixed on
    // the newsletter probe hours earlier, and it would have been very easy to
    // repeat here.
    //
    // Window 72h: the driving workflow is on `0 6 * * *`, so the cadence is
    // daily BY CONSTRUCTION rather than by estimate, and 72h is three missed
    // runs. That is derived from the schedule, not chosen by analogy with a
    // neighbouring probe.
    name: "promoter-url-health-sweep",
    ownerOpe: "OPE-868",
    label: "Promoter website health sweep",
    priority: "P1",
    expectedWindowHours: 72,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        urlHealthChecks,
        urlHealthChecks.checkedAt,
        eq(urlHealthChecks.sourceField, "promoters.website")
      ),
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
    // OPE-541 — proof the venue-decision path (and with it, minting) still runs.
    //
    // This ships a NEW WRITER: ingest now creates venue rows from email prose
    // when `autoLinkVenue` returns `no-match`. The OPE-246 rule wants a probe
    // for it, and the obvious one is wrong.
    //
    // Watching "newest venue minted by ingest" would be a YIELD, not a run.
    // Minting fires only when a submission carries an unknown venue AND a city
    // AND a state; a quiet week, or a week in which every venue happened to
    // match, produces zero minted rows with nothing broken at all. That probe
    // REDs on ordinary weather, gets muted, and then reads as coverage while
    // covering nothing.
    //
    // The RUN is the decision record. `venue-resolution` is emitted once per
    // submission for EVERY outcome — matched, ambiguous, no-match, minted,
    // refused — so its absence means the venue path itself stopped executing,
    // which is the only thing a probe here can honestly assert.
    //
    // 336h, and the 72h this shipped with was WRONG — measured, not guessed.
    //
    // This path has no cron: it executes only when somebody submits, so the
    // probe's floor is however long the submission queue can legitimately go
    // quiet. Over the last 90 days there are 313 gaps between consecutive
    // submit-route events; SEVEN exceed 72h and the largest is 241.5h. Three
    // of those are from the last month alone (126.7h ending 08-17, 115.4h
    // ending 08-03, 94.7h ending 08-11).
    //
    // A 72h window would therefore have RED'd about once a fortnight on
    // nothing but a quiet week — which is the failure this probe's own note
    // warns about: it gets muted, and a muted probe is worse than no probe
    // because it reads as coverage. 336h clears the observed maximum with
    // headroom and matches the window `event-series-write-path` already uses
    // for the same reason.
    //
    // The cost is honest: a dead venue-decision writer now takes up to 14 days
    // to surface. That is weak, and it is the most this path can support
    // without crying wolf — the alternative is not a faster probe, it is a
    // muted one.
    name: "venue-decision-writer",
    ownerOpe: "OPE-541",
    label: "Venue resolution decisions (submit pipeline)",
    priority: "P1",
    expectedWindowHours: 336,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        errorLogs,
        errorLogs.timestamp,
        eq(errorLogs.source, "api/suggest-event/submit:venue-resolution")
      ),
  },
  {
    // OPE-408 — the nightly venue-geocode sweep RAN.
    //
    // Deliberately probes the RUN, not the yield. The obvious evidence — the
    // `venue.update` row each successful geocode writes — is a YIELD, and a
    // yield probe on this path cries wolf by construction: the sweep's job is
    // to drain a finite backlog, so a night where every remaining venue is
    // legitimately refused (low-confidence, non-point, duplicate-place) writes
    // nothing and is indistinguishable from a dead cron. Two of the ten nights
    // to 2026-08-28 wrote zero rows.
    //
    // `venue.geocode.sweep` is emitted once per `missing_only` call regardless
    // of outcome, so its absence means the sweep itself stopped executing —
    // which is the thing worth paging about, and which had NO D1 evidence at
    // all before this PR (success went to `console.log`).
    //
    // 48h on a daily 08:30 cron: one missed fire is a blip, two is a fault.
    name: "venue-geocode-sweep",
    ownerOpe: "OPE-408",
    label: "Venue geocode sweep (nightly 08:30 cron)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        adminActions,
        adminActions.createdAt,
        eq(adminActions.action, "venue.geocode.sweep")
      ),
  },
  {
    // OPE-540 — the inbound pipeline's citation writer RAN.
    //
    // This is the probe whose absence made the defect undiagnosable. The writer
    // stopped producing rows and nothing said so; it surfaced only because an
    // unrelated acceptance test happened to check citation counts, six weeks in.
    //
    // Watches the STEP RECORD, not the citation rows. A citation-row probe is a
    // yield probe, and this yield legitimately reaches zero: the writer only
    // fires when an email submission creates or dedups an event, and inbound is
    // roughly four new-event emails a week. The step row is written on every
    // attempt whatever the outcome — including `skipped` WITH the reason — so
    // its absence means the path stopped executing.
    //
    // 336h for the same reason `venue-decision-writer` uses it: at this volume
    // a quiet fortnight is ordinary and anything shorter cries wolf. The cost is
    // honest — a dead writer takes up to 14 days to surface — and it is the most
    // this traffic level supports without the probe being muted.
    name: "inbound-citation-writer",
    ownerOpe: "OPE-540",
    label: "Inbound pipeline citation writer (per-source provenance)",
    priority: "P1",
    expectedWindowHours: 336,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        workflowRunSteps,
        workflowRunSteps.recordedAt,
        eq(workflowRunSteps.stepName, "citations")
      ),
  },
  {
    // OPE-832 — proof the email defect-CANDIDATE detector is still executing.
    //
    // ⚠️ Watches the RUN, never the yield. Measured over 180 days in prod:
    // three distinct customer defect reports, four emails — roughly one
    // incident every 60 days. A probe watching for CANDIDATES would be red
    // almost always, get muted, and a muted probe reads as coverage while
    // covering nothing. The `defect-candidate` step row is written on EVERY
    // dispatched email whatever the outcome (`created` / `no-defect-language`
    // / `already-reported` / `intent-skipped`), so a MISS proves the detector
    // ran just as well as a hit does. Same reasoning as OPE-803's spam probe.
    //
    // Its absence is unambiguous: the step is unconditional on the dispatch
    // path, so no rows means the path stopped executing, not that nobody
    // reported a bug.
    //
    // 240h, MEASURED on this probe's own population — every inbound email that
    // reaches the workflow, which is far busier than the citation writer above
    // it, so 336h would be needlessly slow here. Over 180 days: 83 active days,
    // 82 gaps, mean 1.37 days, MAXIMUM **6.0 days (144h)**.
    //
    //   72h  → would have fired on 4 ordinary-quiet gaps
    //   120h → 1
    //   168h → 0, but only 1.17x the observed maximum
    //   240h → 0, with real headroom
    //
    // ⚠️ 168h is NOT chosen despite testing clean, and the reason is a limit of
    // the measurement rather than of the data: all 180 days sampled are fair
    // season. Winter inbound volume is unobserved and is very likely quieter,
    // so a window sized to summer gaps would start crying wolf in January —
    // a seasonal version of the "chosen by analogy" error OPE-830 corrected
    // twice. 240h buys that margin for a detection cost of at most four extra
    // days.
    name: "email-defect-candidate-detector",
    ownerOpe: "OPE-832",
    label: "Email defect-candidate detector (inbound dispatch)",
    priority: "P1",
    expectedWindowHours: 240,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        workflowRunSteps,
        workflowRunSteps.recordedAt,
        eq(workflowRunSteps.stepName, "defect-candidate")
      ),
  },
  {
    // OPE-510 §3 — the newsletter list-balance canary RAN.
    //
    // Watches the run stamp, not the alert. The alert is the yield and the
    // yield is ZERO on every healthy day, so a yield probe here would be red
    // whenever the system is working — the inversion that gets probes muted.
    //
    // This one is load-bearing rather than decorative. The canary's own query
    // shipped weeks before anything called it, and the gap was invisible
    // because a report field that nobody reads and a cron that never runs look
    // identical from the database. Four confirmed subscribers went five to
    // seven days receiving nothing while the check that would have caught them
    // sat uninvoked.
    //
    // 48h on a daily cron: one missed fire is a blip, two is a fault.
    name: "newsletter-list-balance-canary",
    ownerOpe: "OPE-510",
    label: "Newsletter list-balance canary (daily cron)",
    priority: "P1",
    expectedWindowHours: 48,
    lastEvidenceAt: (db) =>
      maxTs(
        db,
        agentHeartbeats,
        agentHeartbeats.lastSeenAt,
        eq(agentHeartbeats.agentCode, "watchdog:newsletter-list-balance")
      ),
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
