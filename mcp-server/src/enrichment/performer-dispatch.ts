// Performer pre-extraction dispatcher (OPE-116) — the performer analog of the
// promoter-enrichment dispatch. One job = one performer to enrich. Fetches the
// performer's own website (Browser-Rendering escalation), extracts fill-empty-
// only signals (og:image profile image, contact, social, description), STAGES
// proposals in performer_enrichment_candidates, and — when the run is live (not
// dry-run) — auto-applies only the high-confidence ones (single tel/mailto
// contact, recognized social domains, non-blank description). The profile IMAGE
// is never auto-applied: a wrong photo on a performer's page is high-cost, so it
// always stages for a one-click human review.
//
// Exposed via the synchronous enrich_performer tool (no queue in Phase 4 — the
// nightly selector + queue is a deferred follow-up, gated on the table having
// real volume). Resilience is not needed for the sync path, but the
// process*Job function mirrors promoter-dispatch exactly so a queue consumer can
// be added later with zero changes here.
import { and, eq, inArray } from "drizzle-orm";
import { computePerformerEnrichment } from "@takemetothefair/constants";
import { sanitizeScrapedDescription } from "@takemetothefair/utils";
import { performers, performerEnrichmentCandidates } from "../schema.js";
import { type Db } from "../db.js";
import { logEnrichment } from "../helpers.js";
import { fetchVendorSite } from "./fetch-site.js";
import { extractPerformerSignals, type PerformerExtraction } from "./performer-extract.js";
import { probePromoterImage } from "./promoter-image.js";

/** One performer pre-extraction job. */
export interface PerformerEnrichmentMessage {
  performerId: string;
  /** Groups a run's proposals ('manual-<uuid>' for enrich_performer). */
  jobRunId: string;
  /** Dry-run stages only; live also auto-applies high-confidence fills. */
  dryRun: boolean;
}

/** The subset of Env the performer-enrichment path needs (mirrors EnrichmentEnv). */
export interface PerformerEnrichmentEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  ENRICHMENT_DRY_RUN?: string;
}

/** Performer enrichment_blocked_reason values this dispatcher sets. */
type BlockedReason = "host_gated" | "js_gated" | "stale";

/** Map a fetchVendorSite failReason → a performer enrichment_blocked_reason. */
function mapBlockedReason(failReason: string | undefined): BlockedReason {
  const r = failReason ?? "";
  if (r === "ssrf-blocked" || r === "bad-protocol" || r === "invalid-url") return "host_gated";
  if (r.includes("br=")) return "js_gated";
  return "stale";
}

const PERFORMER_COLUMNS = {
  id: performers.id,
  name: performers.name,
  slug: performers.slug,
  website: performers.website,
  imageUrl: performers.imageUrl,
  description: performers.description,
  socialLinks: performers.socialLinks,
  contactEmail: performers.contactEmail,
  contactPhone: performers.contactPhone,
  enrichmentStatus: performers.enrichmentStatus,
} as const;

/** Proposed-field → live performer column (all five are review-applicable). */
const FIELD_TO_COLUMN: Record<string, keyof typeof performers.$inferInsert> = {
  image: "imageUrl",
  description: "description",
  social_links: "socialLinks",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
};

interface Proposal {
  field: string;
  proposedValue: string;
  method: string;
  confidence: number;
  flags: string[];
  /** Eligible for high-confidence auto-apply on a live (non-dry-run) run. */
  autoApply: boolean;
}

function isEmpty(v: string | null | undefined): boolean {
  return v == null || v.trim() === "" || v.trim() === "{}" || v.trim() === "[]";
}

/**
 * Build the fill-empty-only proposal set from a performer row + the extraction.
 * Pure except for the image probe (a Range fetch to validate the og:image URL).
 */
async function buildProposals(
  row: Record<string, unknown>,
  ex: PerformerExtraction
): Promise<Proposal[]> {
  const proposals: Proposal[] = [];

  // --- image from the single og:image candidate (fill-empty-only) ---
  // We reuse probePromoterImage purely to VALIDATE the URL (reject SSRF /
  // unparseable / non-image). Classification is ignored — a performer has one
  // image slot and portrait/square photos are fine. The image NEVER auto-applies
  // (a wrong face on a profile is high-cost); it always stages for review.
  if (ex.ogImage && isEmpty(row.imageUrl as string | null)) {
    const probed = await probePromoterImage(ex.ogImage);
    if (probed) {
      proposals.push({
        field: "image",
        proposedValue: probed.url,
        method: "og-image",
        confidence: probed.heroConfident ? 0.7 : 0.5,
        flags: [],
        autoApply: false,
      });
    }
  }

  // --- description (fill-empty-only; blank only — no placeholder boilerplate) ---
  if (ex.description && isEmpty(row.description as string | null)) {
    const clean = sanitizeScrapedDescription(ex.description.value);
    if (clean.trim() !== "") {
      proposals.push({
        field: "description",
        proposedValue: clean,
        method: ex.description.method,
        confidence: ex.description.confidence,
        flags: [],
        autoApply: true,
      });
    }
  }

  // --- social_links (fill-empty-only; recognized domains only) ---
  if (ex.socialLinks && isEmpty(row.socialLinks as string | null)) {
    proposals.push({
      field: "social_links",
      proposedValue: ex.socialLinks.value,
      method: ex.socialLinks.method,
      confidence: ex.socialLinks.confidence,
      flags: [],
      autoApply: true,
    });
  }

  // --- contact_email (fill-empty-only) ---
  if (ex.contactEmail && isEmpty(row.contactEmail as string | null)) {
    proposals.push({
      field: "contact_email",
      proposedValue: ex.contactEmail.value,
      method: ex.contactEmail.method,
      confidence: ex.contactEmail.confidence,
      flags: [],
      autoApply: ex.contactEmail.method === "mailto" || ex.contactEmail.method === "jsonld",
    });
  }

  // --- contact_phone (fill-empty-only) ---
  if (ex.contactPhone && isEmpty(row.contactPhone as string | null)) {
    proposals.push({
      field: "contact_phone",
      proposedValue: ex.contactPhone.value,
      method: ex.contactPhone.method,
      confidence: ex.contactPhone.confidence,
      flags: [],
      autoApply: ex.contactPhone.method === "tel" || ex.contactPhone.method === "jsonld",
    });
  }

  return proposals;
}

export interface PerformerEnrichmentRunSummary {
  performerId: string;
  outcome: "staged" | "merged" | "blocked" | "no_source" | "not_found";
  candidateCount?: number;
  appliedFields?: string[];
  blockedReason?: BlockedReason;
  fetchMethod?: string;
}

/**
 * Enrich one performer end-to-end. Exported so the synchronous enrich_performer
 * MCP tool reuses the exact same path (no queue) and returns inline.
 */
export async function processPerformerEnrichmentJob(
  db: Db,
  env: PerformerEnrichmentEnv,
  msg: PerformerEnrichmentMessage
): Promise<PerformerEnrichmentRunSummary> {
  const [row] = await db
    .select(PERFORMER_COLUMNS)
    .from(performers)
    .where(eq(performers.id, msg.performerId))
    .limit(1);

  if (!row) return { performerId: msg.performerId, outcome: "not_found" };

  // --- No website → NO_SOURCE, nothing to enrich from ---
  if (!row.website || row.website.trim() === "") {
    await db
      .update(performers)
      .set({ enrichmentStatus: "NO_SOURCE", enrichmentAttemptedAt: new Date() })
      .where(eq(performers.id, msg.performerId));
    await logEnrichment(db, {
      targetType: "performer",
      targetId: msg.performerId,
      source: "browser_enrich",
      status: "skipped",
      notes: "no website on file",
    });
    return { performerId: msg.performerId, outcome: "no_source" };
  }

  const sourceUrl = row.website.trim();
  const fetched = await fetchVendorSite(sourceUrl, env);

  // --- Fetch failure → BLOCKED (+ mapped reason), stamp ---
  if (!fetched.ok || !fetched.html) {
    const reason = mapBlockedReason(fetched.failReason);
    await db
      .update(performers)
      .set({
        enrichmentStatus: "BLOCKED",
        enrichmentBlockedReason: reason,
        enrichmentAttemptedAt: new Date(),
      })
      .where(eq(performers.id, msg.performerId));
    await logEnrichment(db, {
      targetType: "performer",
      targetId: msg.performerId,
      source: "browser_enrich",
      status: "failure",
      notes: `fetch failed: ${fetched.failReason ?? "unknown"} → ${reason}`,
    });
    return { performerId: msg.performerId, outcome: "blocked", blockedReason: reason };
  }

  const extraction = extractPerformerSignals(fetched.html, sourceUrl);
  const proposals = await buildProposals(row as Record<string, unknown>, extraction);

  // Idempotent re-run: clear this performer's still-open proposals, then restage
  // (honors the one-pending-per-field partial unique index).
  await db
    .delete(performerEnrichmentCandidates)
    .where(
      and(
        eq(performerEnrichmentCandidates.performerId, msg.performerId),
        eq(performerEnrichmentCandidates.decision, "pending")
      )
    );

  const now = new Date();
  if (proposals.length > 0) {
    await db.insert(performerEnrichmentCandidates).values(
      proposals.map((p) => ({
        performerId: msg.performerId,
        jobRunId: msg.jobRunId,
        proposedField: p.field,
        currentValue: null,
        proposedValue: p.proposedValue,
        sourceUrl,
        extractionMethod: p.method,
        fetchMethod: fetched.fetchMethod,
        confidence: p.confidence,
        flags: JSON.stringify(p.flags),
        createdAt: now,
        decision: "pending" as const,
      }))
    );
  }

  const stagedFields = proposals.map((p) => p.field);

  // --- Dry-run: stage only, stamp the attempt ---
  if (msg.dryRun) {
    await db
      .update(performers)
      .set({ enrichmentAttemptedAt: now })
      .where(eq(performers.id, msg.performerId));
    await logEnrichment(db, {
      targetType: "performer",
      targetId: msg.performerId,
      source: "browser_enrich",
      status: proposals.length > 0 ? "success" : "skipped",
      fieldsChanged: stagedFields,
      notes: `dry-run: ${proposals.length} candidate(s) staged`,
    });
    return {
      performerId: msg.performerId,
      outcome: "staged",
      candidateCount: proposals.length,
      fetchMethod: fetched.fetchMethod,
    };
  }

  // --- Live: auto-apply the high-confidence fills (fill-empty-only) ---
  const applied = await applyFills(db, msg.performerId, proposals);
  await recomputeAndStamp(db, msg.performerId, applied.length > 0);
  await logEnrichment(db, {
    targetType: "performer",
    targetId: msg.performerId,
    source: "browser_enrich",
    status: applied.length > 0 ? "success" : "skipped",
    fieldsChanged: applied,
    notes: `auto-apply: applied ${applied.length} field(s)`,
  });

  return {
    performerId: msg.performerId,
    outcome: "merged",
    candidateCount: proposals.length,
    appliedFields: applied,
    fetchMethod: fetched.fetchMethod,
  };
}

/**
 * Apply only high-confidence fills into empty performer columns. Flagged or
 * non-auto-apply proposals (incl. the image, always) stay staged for manual
 * review. Marks the applied candidate rows 'auto_merged'. Returns the performer
 * fields actually written.
 */
async function applyFills(db: Db, performerId: string, proposals: Proposal[]): Promise<string[]> {
  const update: Record<string, string> = {};
  const applied: string[] = [];
  for (const p of proposals) {
    if (!p.autoApply) continue;
    if (p.flags.length > 0) continue;
    const col = FIELD_TO_COLUMN[p.field];
    if (!col) continue;
    update[col] = p.proposedValue;
    applied.push(p.field);
  }
  if (applied.length === 0) return [];
  await db.update(performers).set(update).where(eq(performers.id, performerId));
  await db
    .update(performerEnrichmentCandidates)
    .set({ decision: "auto_merged", reviewedAt: new Date(), reviewedBy: "auto-merge" })
    .where(
      and(
        eq(performerEnrichmentCandidates.performerId, performerId),
        eq(performerEnrichmentCandidates.decision, "pending"),
        inArray(performerEnrichmentCandidates.proposedField, applied)
      )
    );
  return applied;
}

/**
 * Recompute enrichment_status/coverage from the performer's now-current fields
 * (via computePerformerEnrichment) and stamp the attempt. Sets last_enriched_at
 * only when something was actually written this run.
 */
async function recomputeAndStamp(db: Db, performerId: string, didApply: boolean): Promise<void> {
  const [p] = await db
    .select({
      website: performers.website,
      imageUrl: performers.imageUrl,
      description: performers.description,
      socialLinks: performers.socialLinks,
      contactEmail: performers.contactEmail,
      contactPhone: performers.contactPhone,
      enrichmentStatus: performers.enrichmentStatus,
    })
    .from(performers)
    .where(eq(performers.id, performerId))
    .limit(1);
  if (!p) return;
  const enrichment = computePerformerEnrichment(p, p.enrichmentStatus);
  const now = new Date();
  await db
    .update(performers)
    .set({
      enrichmentStatus: enrichment.status,
      enrichmentCoverage: enrichment.coverageJson,
      enrichmentAttemptedAt: now,
      ...(didApply ? { lastEnrichedAt: now } : {}),
    })
    .where(eq(performers.id, performerId));
}
