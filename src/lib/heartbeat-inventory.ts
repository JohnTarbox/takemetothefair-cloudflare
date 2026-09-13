/**
 * OPE-975 — every declared execution path names its heartbeat probe, or an
 * explicit waiver. Enforced by scripts/check-heartbeat-probes.ts in CI.
 *
 * The rule (CLAUDE.md, OPE-246): a PR that ships a new writer / cron / queue /
 * pipeline execution path adds a probe in the same PR. Until this file it was
 * enforced by whoever remembered it, and PR #1245 shipped a new writer with
 * none and a fully green CI.
 *
 * ── What counts as a path ─────────────────────────────────────────────────
 * Read from the CONFIG and the dispatcher, never guessed from a diff:
 *   queue:<name>     every [[queues.consumers]] in mcp-server/wrangler.toml
 *   workflow:<Class> every [[workflows]] class in mcp-server/wrangler.toml
 *   cron:<fn>        every run…() the MCP `scheduled()` handler calls, and
 *                    cron:main-app:<path> for each runMainAppSweep target
 *
 * ⚠️ Honest limit: a new WRITER inside an existing path — #1245's own shape, a
 * new column stamped inside the inbound-email Workflow — is not a new path by
 * this definition and is NOT caught here. That still rests on review; the
 * `workflow:` entries list the probes that cover each Workflow's writers so a
 * reviewer can see what is and is not watched.
 *
 * ── Entries ───────────────────────────────────────────────────────────────
 *   { probes: [...] }  — names from HEARTBEAT_PROBES (src/lib/heartbeat.ts)
 *   { waiver: {...} }  — a decision that this path gets no probe, with why
 *   { unreviewed: … }  — GRANDFATHERED. Paths that existed when this inventory
 *                        was created (2026-09-13) and that no probe covers by
 *                        name. Not a decision, a debt: the check reports the
 *                        count, and new entries of this kind are refused.
 */

export type InventoryEntry =
  | { probes: string[]; note?: string }
  | { waiver: { reason: string; decided: string; ope: string } }
  | { unreviewed: "grandfathered-2026-09-13" };

/** The only paths allowed to be `unreviewed`. A new path must choose. */
export const GRANDFATHERED_UNREVIEWED = new Set<string>([
  "queue:syndication-changes",
  "workflow:SchemaOrgSyncWorkflow",
  "cron:runInboundExceptionNotice",
  "cron:main-app:/api/admin/content-links/audit",
  "cron:runScheduledBingInspectionSweep",
  "cron:runScheduledCompletenessRecompute",
  "cron:runScheduledCpiScanWatchdog",
  "cron:runScheduledCpiStaleRedCanary",
  "cron:runScheduledDedupSweepCanary",
  "cron:runScheduledGa4LivenessCheck",
  "cron:runScheduledGoodwillHealthCanary",
  "cron:runScheduledHoldoutSampling",
  "cron:runScheduledInboundEmailStaleSweep",
  "cron:runScheduledKpiRecompute",
  "cron:runScheduledOperatorQueueNotice",
  "cron:runScheduledPageErrorCanary",
  "cron:runScheduledPendingPingsFlush",
  "cron:runScheduledQueueRerank",
  "cron:runScheduledSelfConsistencyCron",
  "cron:runScheduledStalePageRadar",
  "cron:runScheduledStandingFailureCanary",
  "cron:runScheduledTimeToIndexSweep",
  "cron:runWeeklyInventoryNotice",
]);

const U = { unreviewed: "grandfathered-2026-09-13" } as const;

export const HEARTBEAT_INVENTORY: Record<string, InventoryEntry> = {
  // ── queue consumers ─────────────────────────────────────────────────────
  "queue:email-jobs": { probes: ["email-send"] },
  "queue:indexnow-pings": {
    waiver: {
      reason:
        "IndexNow is paused by operator decision (REL4: `indexnow:paused` set in RATE_LIMIT_KV). A liveness probe on a deliberately silent queue is a permanent false positive; add one the day pings resume.",
      decided: "2026-09-13",
      ope: "OPE-975",
    },
  },
  "queue:event-discrepancies": { probes: ["discrepancy-detection"] },
  "queue:syndication-changes": U,
  "queue:vendor-enrichment": { probes: ["vendor-enrichment"] },
  "queue:promoter-enrichment": { probes: ["promoter-enrichment"] },
  "queue:email-delivery-events": { probes: ["email-delivery-events"] },

  // ── Workflows ───────────────────────────────────────────────────────────
  "workflow:InboundEmailWorkflow": {
    probes: [
      "inbound-submit",
      "ocr-attachment",
      "inbound-forward-analysis",
      "inbound-citation-writer",
      "venue-decision-writer",
      "spam-event-triple-detector",
      "submit-secondary-page-crawl",
      "roster-vendor-link",
      "citation-source-snapshot",
      "email-defect-candidate-detector",
      "photo-intake",
      "photo-intake-storage-record",
    ],
    note: "Writers inside this Workflow each carry their own probe; a new writer here needs one too, and this check cannot see it (see header).",
  },
  "workflow:RecommendationsScanWorkflow": { probes: ["recommendation-scan"] },
  "workflow:EventDateDriftWorkflow": {
    probes: ["promoter-url-health-sweep", "organizer-cancellation-recheck"],
    note: "OPE-987 moved this off `unreviewed`: its promoter sweep (OPE-868) and cancellation recheck (OPE-987) each carry a probe. ⚠️ The date-drift loop itself — the workflow's original writer of event_date_drift_findings — still has NONE; that debt did not go away, it is now named here instead of counted.",
  },
  "workflow:SchemaOrgSyncWorkflow": U,

  // ── scheduled() jobs ────────────────────────────────────────────────────
  "cron:runAgentSilenceWatchdog": { probes: ["agent-silence-watchdog"] },
  "cron:runInboundExceptionNotice": U,
  "cron:main-app:/api/admin/venues/geocode-venues": { probes: ["venue-geocode-sweep"] },
  "cron:main-app:/api/admin/content-links/audit": U,
  "cron:runOccurredTransitionSweep": { probes: ["occurred-transition-sweep"] },
  "cron:runRequestSampleRetention": { probes: ["request-sample-retention"] },
  "cron:runScheduledBingInspectionSweep": U,
  "cron:runScheduledBingLivenessCheck": { probes: ["bing-liveness"] },
  "cron:runScheduledBurstCapSelfTest": { probes: ["burst-cap-selftest"] },
  "cron:runScheduledCompletenessRecompute": U,
  "cron:runScheduledCpiScanWatchdog": U,
  "cron:runScheduledCpiStaleRedCanary": U,
  "cron:runScheduledDedupSweepCanary": U,
  "cron:runScheduledFaultCandidatesEmit": { probes: ["fault-emitter-run"] },
  "cron:runScheduledGa4LivenessCheck": U,
  "cron:runScheduledGoodwillHealthCanary": U,
  "cron:runScheduledGscMetricsSync": { probes: ["gsc-search-metrics-ingest"] },
  "cron:runScheduledGscSweep": { probes: ["gsc-sweep-filler-tiers"] },
  "cron:runScheduledHoldoutSampling": U,
  "cron:runScheduledImageUrlHealthSweep": { probes: ["image-url-health-sweep"] },
  "cron:runScheduledInboundEmailStaleSweep": U,
  "cron:runScheduledKpiRecompute": U,
  "cron:runScheduledNewsletterListBalanceCanary": { probes: ["newsletter-list-balance-canary"] },
  "cron:runScheduledOperatorQueueNotice": U,
  "cron:runScheduledPageErrorCanary": U,
  "cron:runScheduledPendingPingsFlush": U,
  "cron:runScheduledPhotoCoverageScan": {
    probes: ["image-coverage-scan", "photo-coverage-snapshot"],
  },
  "cron:runScheduledPromoterEnrichment": { probes: ["promoter-enrichment"] },
  "cron:runScheduledQueueRerank": U,
  "cron:runScheduledSelfConsistencyCron": U,
  "cron:runScheduledSiteHealthRefresh": { probes: ["site-health-refresh"] },
  "cron:runScheduledStalePageRadar": U,
  "cron:runScheduledStandingFailureCanary": U,
  "cron:runScheduledTimeToIndexSweep": U,
  "cron:runScheduledVendorEnrichment": { probes: ["vendor-enrichment"] },
  "cron:runWeeklyInventoryNotice": U,
};
