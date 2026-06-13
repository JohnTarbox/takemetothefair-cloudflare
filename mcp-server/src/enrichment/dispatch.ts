// I1 vendor-enrichment dispatcher (Dev-Brief-I1, 2026-06-13) — MCP Worker queue
// consumer. One message = one vendor to enrich. The consumer fetches the
// vendor's own website (Browser-Rendering escalation), extracts fill-empty-only
// contact fields, applies the §5 safety rules, and STAGES proposals in
// vendor_enrichment_candidates. Nothing touches the live vendor row in dry-run
// mode (the Phase-1 default).
//
// Resilience: per-message try/ack/retry like the SYN1 dispatcher. A fetch miss
// is NOT a failure — a dead site is itself a signal; we stamp the attempt and
// ack. Only an unexpected DB error retries → DLQ after max_retries.
import { and, eq, inArray } from "drizzle-orm";
import { vendors, vendorEnrichmentCandidates } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import {
  logEnrichment,
  recomputeVendorCompleteness,
  triggerIndexNow,
  publicUrlFor,
} from "../helpers.js";
import { fetchVendorSite } from "./fetch-site.js";
import { extractVendorContact } from "./extract.js";
import { buildEnrichmentResult } from "./safety-rules.js";
import type { VendorRowForEnrichment } from "./types.js";

/** One enrichment job. */
export interface VendorEnrichmentMessage {
  vendorId: string;
  /** Groups a cron batch (or 'manual-<uuid>' for enrich_vendor). */
  jobRunId: string;
  /** Dry-run stages only; live applies non-flagged fills (Phase 2). */
  dryRun: boolean;
}

type QueueMessage<T> = { body: T; ack: () => void; retry: () => void };
type Batch<T> = { queue: string; messages: readonly QueueMessage<T>[] };

/** The subset of Env the enrichment path needs. */
export interface EnrichmentEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export async function handleEnrichmentBatch(
  batch: Batch<VendorEnrichmentMessage>,
  env: EnrichmentEnv
): Promise<void> {
  const db = getDb(env.DB);
  for (const msg of batch.messages) {
    try {
      await processEnrichmentJob(db, env, msg.body);
      msg.ack();
    } catch (err) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:enrichment:dispatch",
        message: "vendor enrichment failed; retrying",
        error: err,
        context: { vendorId: msg.body?.vendorId, jobRunId: msg.body?.jobRunId },
      });
      msg.retry();
    }
  }
}

const VENDOR_COLUMNS = {
  id: vendors.id,
  businessName: vendors.businessName,
  slug: vendors.slug,
  website: vendors.website,
  contactPhone: vendors.contactPhone,
  contactEmail: vendors.contactEmail,
  socialLinks: vendors.socialLinks,
  address: vendors.address,
  city: vendors.city,
  state: vendors.state,
  description: vendors.description,
  deletedAt: vendors.deletedAt,
} as const;

/**
 * Enrich one vendor end-to-end. Exported so the synchronous enrich_vendor MCP
 * tool can reuse the exact same path (no queue) and return the result inline.
 */
export async function processEnrichmentJob(
  db: Db,
  env: EnrichmentEnv,
  msg: VendorEnrichmentMessage
): Promise<EnrichmentRunSummary> {
  const [row] = await db
    .select(VENDOR_COLUMNS)
    .from(vendors)
    .where(eq(vendors.id, msg.vendorId))
    .limit(1);

  if (!row) return { vendorId: msg.vendorId, outcome: "not_found" };
  if (row.deletedAt) return { vendorId: msg.vendorId, outcome: "skipped", reason: "deleted" };
  if (!row.website || row.website.trim() === "") {
    await stampAttempt(db, msg.vendorId);
    await logEnrichment(db, {
      targetType: "vendor",
      targetId: msg.vendorId,
      source: "browser_enrich",
      status: "skipped",
      notes: "no website on file",
    });
    return { vendorId: msg.vendorId, outcome: "skipped", reason: "no_website" };
  }

  const sourceUrl = row.website.trim();
  const fetched = await fetchVendorSite(sourceUrl, env);
  if (!fetched.ok || !fetched.html) {
    // A dead/blocked site: stamp + log, then ack. Not a retryable error.
    await stampAttempt(db, msg.vendorId);
    await logEnrichment(db, {
      targetType: "vendor",
      targetId: msg.vendorId,
      source: "browser_enrich",
      status: "failure",
      notes: `fetch failed: ${fetched.failReason ?? "unknown"}`,
    });
    return { vendorId: msg.vendorId, outcome: "fetch_failed", reason: fetched.failReason };
  }

  const extraction = extractVendorContact(fetched.html, sourceUrl);
  const vendorRow: VendorRowForEnrichment = {
    id: row.id,
    businessName: row.businessName,
    website: row.website,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    socialLinks: row.socialLinks,
    address: row.address,
    city: row.city,
    state: row.state,
    description: row.description,
  };
  const result = buildEnrichmentResult(vendorRow, extraction, {
    sourceUrl,
    finalUrl: fetched.finalUrl,
  });

  // --- Domain problem: flag the vendor, stage nothing ---
  if (result.domainProblem) {
    await db
      .update(vendors)
      .set({ domainHijacked: true, enrichmentAttemptedAt: new Date() })
      .where(eq(vendors.id, msg.vendorId));
    await logEnrichment(db, {
      targetType: "vendor",
      targetId: msg.vendorId,
      source: "browser_enrich",
      status: "skipped",
      notes: `domain problem: ${result.domainProblem}`,
    });
    return {
      vendorId: msg.vendorId,
      outcome: "domain_problem",
      domainProblem: result.domainProblem,
      fetchMethod: fetched.fetchMethod,
    };
  }

  // Always refresh the staged proposals for this vendor (idempotent re-run).
  await db
    .delete(vendorEnrichmentCandidates)
    .where(
      and(
        eq(vendorEnrichmentCandidates.vendorId, msg.vendorId),
        eq(vendorEnrichmentCandidates.decision, "pending")
      )
    );

  const now = new Date();
  if (result.candidates.length > 0) {
    await db.insert(vendorEnrichmentCandidates).values(
      result.candidates.map((c) => ({
        vendorId: msg.vendorId,
        jobRunId: msg.jobRunId,
        proposedField: c.field,
        currentValue: c.currentValue,
        proposedValue: c.proposedValue,
        sourceUrl,
        extractionMethod: c.method,
        fetchMethod: fetched.fetchMethod,
        confidence: c.confidence,
        flags: JSON.stringify(c.flags),
        createdAt: now,
        decision: "pending" as const,
      }))
    );
  }

  const fieldsChanged = result.candidates.map((c) => c.field);

  if (msg.dryRun) {
    await stampAttempt(db, msg.vendorId);
    await logEnrichment(db, {
      targetType: "vendor",
      targetId: msg.vendorId,
      source: "browser_enrich",
      status: result.candidates.length > 0 ? "success" : "skipped",
      fieldsChanged,
      notes: `dry-run: ${result.candidates.length} candidate(s) staged${
        result.vendorFlags.length ? `; flags=${result.vendorFlags.join(",")}` : ""
      }`,
    });
    return {
      vendorId: msg.vendorId,
      outcome: "staged",
      candidateCount: result.candidates.length,
      vendorFlags: result.vendorFlags,
      fetchMethod: fetched.fetchMethod,
    };
  }

  // --- Phase 2: live auto-merge (only un-flagged fills) ---
  const applied = await applyFills(db, msg.vendorId, result.candidates);
  await stampAttempt(db, msg.vendorId);
  await logEnrichment(db, {
    targetType: "vendor",
    targetId: msg.vendorId,
    source: "browser_enrich",
    status: applied.length > 0 ? "success" : "skipped",
    fieldsChanged: applied,
    notes: `auto-merge: applied ${applied.length} field(s)`,
  });
  if (applied.length > 0) {
    await recomputeVendorCompleteness(db, msg.vendorId);
    // IndexNow re-crawl for the now-richer vendor page.
    await triggerIndexNow(publicUrlFor("vendors", row.slug), env, "vendor-enrich-merge");
  }
  return {
    vendorId: msg.vendorId,
    outcome: "merged",
    candidateCount: result.candidates.length,
    appliedFields: applied,
    vendorFlags: result.vendorFlags,
    fetchMethod: fetched.fetchMethod,
  };
}

/**
 * Apply only safe fills: a fresh value into an empty column, with NO flags.
 * Flagged or conflict candidates stay staged for manual review. Returns the
 * list of vendor columns actually written, and marks those candidate rows
 * 'auto_merged'.
 */
async function applyFills(
  db: Db,
  vendorId: string,
  candidates: {
    field: string;
    proposedValue: string;
    currentValue: string | null;
    flags: string[];
  }[]
): Promise<string[]> {
  const FIELD_TO_COLUMN: Record<string, keyof typeof vendors.$inferInsert> = {
    contact_phone: "contactPhone",
    contact_email: "contactEmail",
    social_links: "socialLinks",
    address: "address",
    city: "city",
    state: "state",
    // description is intentionally EXCLUDED — never auto-published (§5).
  };
  const update: Record<string, string> = {};
  const applied: string[] = [];
  for (const c of candidates) {
    if (c.flags.length > 0) continue; // flagged → manual review only
    if (c.currentValue != null) continue; // not a true fill
    const col = FIELD_TO_COLUMN[c.field];
    if (!col) continue;
    update[col] = c.proposedValue;
    applied.push(c.field);
  }
  if (applied.length === 0) return [];
  await db.update(vendors).set(update).where(eq(vendors.id, vendorId));
  // Mark ONLY the fields we actually applied as auto_merged. Flagged/conflict
  // candidates (e.g. a city_mismatch) stay 'pending' for manual review.
  await db
    .update(vendorEnrichmentCandidates)
    .set({ decision: "auto_merged", reviewedAt: new Date(), reviewedBy: "auto-merge" })
    .where(
      and(
        eq(vendorEnrichmentCandidates.vendorId, vendorId),
        eq(vendorEnrichmentCandidates.decision, "pending"),
        inArray(vendorEnrichmentCandidates.proposedField, applied)
      )
    );
  return applied;
}

/** Stamp enrichment_attempted_at so the cron rotates forward (any outcome). */
async function stampAttempt(db: Db, vendorId: string): Promise<void> {
  await db
    .update(vendors)
    .set({ enrichmentAttemptedAt: new Date() })
    .where(eq(vendors.id, vendorId));
}

export interface EnrichmentRunSummary {
  vendorId: string;
  outcome: "staged" | "merged" | "domain_problem" | "fetch_failed" | "skipped" | "not_found";
  reason?: string;
  candidateCount?: number;
  appliedFields?: string[];
  vendorFlags?: string[];
  domainProblem?: string;
  fetchMethod?: string;
}
