/**
 * K12 submission-seeded discovery — enqueue the submitter's organizer
 * domain into the harvest pipeline so the daily-discovery cron picks
 * up the organizer's OTHER upcoming events.
 *
 * Surfaced 6/2 by watching the Lupine Festival workflow: a single-
 * event submission for `historicrangeley.org/lupine-festival` led the
 * operator to crawl that org's `/events` page and find Oquossoc Day +
 * Fall Festival (added), recognize 5 already-in-DB events (deduped),
 * and skip ~8 museum lectures/workshops/meetings (filtered by the
 * sibling relevance classifier at ./relevance.ts).
 *
 * ## Architecture (per the user-confirmed plan, 2026-06-02)
 *
 * Two-table fanout based on `classifyDomainTier()`:
 *
 *   T1 (organizer-domain match) + T2 (DMO / tourism / .gov / chamber)
 *     → write directly to `discovery_candidates` with rule_slug =
 *       'email_suggestion'. The harvest skill (out-of-repo, owned by
 *       the daily NE event discovery cron) picks up the row next run.
 *       Bypasses the admin-approval gate because the source-tier
 *       classifier has already confirmed trustworthiness.
 *
 *   T3 (everything else: aggregators / social / unknown)
 *     → write to `email_source_suggestions` with status =
 *       'pending_review'. Admin reviews via the existing 3-tier
 *       source-suggestion handler path. K12 doesn't auto-promote T3
 *       because aggregator/social URLs at this stage have a much
 *       higher false-positive rate.
 *
 * ## Guardrails (C5 of the dev email)
 *
 * - **30-day per-domain TTL cache** on BOTH tables. Prevents re-seeding
 *   on every Rangeley submission. Implemented as a `createdAt >
 *   now - 30 days` check before INSERT.
 *
 * - **Per-domain opt-out** via `email_source_suggestions.status =
 *   'rejected'`. Admins can pre-emptively block a domain from ever
 *   being seeded (for organizers who explicitly don't want to be in
 *   MMATF). Short-circuits BOTH the T1/T2 and T3 paths.
 *
 * - **Failsoft / cosmetic-step semantics** per
 *   [[feedback_workflow_cosmetic_steps_failsoft]]. Wraps every DB call
 *   in try/catch INSIDE the step body so a transient D1 hiccup on this
 *   side-effect can't kill the inbound-email submit pipeline. Callers
 *   should wrap THIS function's call in `step.do(... { retries: 1 })`
 *   for the workflow infrastructure's idempotency layer.
 *
 * - **URL validation** via `new URL(...)`. Bad inputs return
 *   `skipped_no_url` and write zero rows.
 *
 * - **Politeness, multi-event-cap, future-dated-only, attribution**
 *   are enforced by the harvest skill on the read side, not here.
 *
 * The actual harvest crawl never runs in this Worker. K12 enqueues;
 * the harvest skill consumes. Two reasons: (1) the daily-discovery
 * pipeline is already wired and tested, (2) crawling inline would
 * blow the 30s CF response budget per
 * [[feedback_cloudflare_30s_budget_for_browser_loops]].
 */

import { eq, and, sql, gt } from "drizzle-orm";
import { classifyDomainTier, type SourceTier } from "@takemetothefair/utils";
import { discoveryCandidates, emailSourceSuggestions } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

/** TTL for the per-domain cache. 30 days matches the dev-email spec. */
const CACHE_TTL_SECS = 30 * 24 * 60 * 60;

export type SeedDecision =
  | "skipped_no_url"
  | "skipped_invalid_url"
  | "skipped_cached"
  | "skipped_opted_out"
  | "skipped_db_error"
  | "promoted_to_discovery_candidates"
  | "queued_to_email_source_suggestions";

export interface SeedDiscoveryArgs {
  /** The event's source_url as extracted by K7 / AI extractor. NULL is fine. */
  sourceUrl: string | null;
  /** Submitter's email address for `classifyDomainTier`'s T1
   *  (organizer-domain) match heuristic + audit-trail attribution. */
  fromAddress: string | null;
  /** FK back to the inbound_emails row so admin can trace the trigger. */
  inboundEmailId: string | null;
}

export interface SeedDiscoveryResult {
  decision: SeedDecision;
  host: string | null;
  tier: SourceTier | null;
}

/**
 * Enqueue (or skip) one submitter's source URL into the harvest
 * pipeline. Idempotent within the 30-day TTL. Never throws — all
 * errors are caught + logged + returned as `skipped_db_error`.
 */
export async function seedDiscoveryCandidate(
  db: Db,
  args: SeedDiscoveryArgs
): Promise<SeedDiscoveryResult> {
  const { sourceUrl, fromAddress, inboundEmailId } = args;

  // ── 1. URL guard ───────────────────────────────────────────────
  if (!sourceUrl) {
    return { decision: "skipped_no_url", host: null, tier: null };
  }

  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { decision: "skipped_invalid_url", host: null, tier: null };
  }
  if (!host) {
    return { decision: "skipped_invalid_url", host: null, tier: null };
  }

  // ── 2. Tier classification ─────────────────────────────────────
  const contactEmailDomain = fromAddress?.split("@")[1]?.toLowerCase() ?? null;
  const tier = classifyDomainTier(sourceUrl, { contactEmailDomain });

  try {
    // ── 3. Per-domain opt-out check ──────────────────────────────
    // A 'rejected' email_source_suggestions row is the admin's "never
    // seed this host" signal. Applies to BOTH the T1/T2 and T3 paths.
    const optedOut = await db
      .select({ id: emailSourceSuggestions.id })
      .from(emailSourceSuggestions)
      .where(
        and(eq(emailSourceSuggestions.host, host), eq(emailSourceSuggestions.status, "rejected"))
      )
      .limit(1);
    if (optedOut.length > 0) {
      return { decision: "skipped_opted_out", host, tier };
    }

    // ── 4. 30-day TTL cache check (both tables) ──────────────────
    // discovery_candidates.createdAt is "timestamp" mode = seconds-epoch;
    // we compare via raw sql to avoid Drizzle Date marshalling at the
    // boundary. cutoff = (now - 30d) seconds.
    const cutoffSecs = Math.floor(Date.now() / 1000) - CACHE_TTL_SECS;

    // discovery_candidates: same rule_slug, sourceLabel matches host
    // (we store host in sourceLabel per the existing schema convention),
    // created in the last 30 days.
    const recentDcRows = await db
      .select({ id: discoveryCandidates.id })
      .from(discoveryCandidates)
      .where(
        and(
          eq(discoveryCandidates.ruleSlug, "email_suggestion"),
          sql`LOWER(${discoveryCandidates.sourceLabel}) = ${host}`,
          gt(discoveryCandidates.createdAt, new Date(cutoffSecs * 1000))
        )
      )
      .limit(1);
    if (recentDcRows.length > 0) {
      return { decision: "skipped_cached", host, tier };
    }

    // email_source_suggestions: same host, created in the last 30 days,
    // regardless of status (pending/active/rejected — we already excluded
    // rejected above but include them here too for the cache semantics).
    const recentEssRows = await db
      .select({ id: emailSourceSuggestions.id })
      .from(emailSourceSuggestions)
      .where(
        and(
          eq(emailSourceSuggestions.host, host),
          gt(emailSourceSuggestions.createdAt, new Date(cutoffSecs * 1000))
        )
      )
      .limit(1);
    if (recentEssRows.length > 0) {
      return { decision: "skipped_cached", host, tier };
    }

    // ── 5. Path-specific write ──────────────────────────────────
    if (tier === "T1" || tier === "T2") {
      // T1/T2: auto-promote to discovery_candidates. The harvest skill
      // picks it up at the next cron run. sourceType + sourceLabel
      // match the values documented in the schema comment at
      // packages/db-schema/src/index.ts:1758-1763.
      await db.insert(discoveryCandidates).values({
        id: crypto.randomUUID(),
        ruleSlug: "email_suggestion",
        sourceType: "aggregator", // existing enum value for email-suggestion promotions
        sourceLabel: host,
        sourceUrl,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { decision: "promoted_to_discovery_candidates", host, tier };
    }

    // T3: queue to email_source_suggestions for admin review.
    // Partial-unique index on (host) WHERE status='pending_review'
    // means a duplicate pending suggestion from a different sender
    // collides harmlessly. We use ON CONFLICT DO NOTHING for that
    // case explicitly even though the cache check above should make
    // it unreachable on the happy path.
    await db
      .insert(emailSourceSuggestions)
      .values({
        id: crypto.randomUUID(),
        url: sourceUrl,
        host,
        status: "pending_review",
        suggestedByEmail: fromAddress,
        suggestedViaInboundId: inboundEmailId,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    return { decision: "queued_to_email_source_suggestions", host, tier };
  } catch (err) {
    // Best-effort. Don't propagate — the caller's submit pipeline must
    // not fail because the discovery side-effect did.
    await logError(db, {
      source: "mcp:goodwill:seed-discovery",
      message: `seedDiscoveryCandidate failed for host=${host}`,
      error: err,
    });
    return { decision: "skipped_db_error", host, tier };
  }
}
