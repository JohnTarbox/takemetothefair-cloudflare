// Promoter pre-extraction dispatcher (OPE-36) — the promoter analog of the
// vendor-enrichment dispatch. One message = one promoter to enrich. The queue
// consumer fetches the promoter's own website (Browser-Rendering escalation),
// extracts fill-empty-only signals (og:image hero/logo, contact, social,
// description), STAGES proposals in promoter_enrichment_candidates, and — when
// the message is live (not dry-run) — auto-applies only the high-confidence
// ones (hero, single tel/mailto contact, recognized social domains,
// non-placeholder description).
//
// Resilience mirrors the vendor dispatcher: per-message try/ack/retry with
// exponential backoff. A fetch miss is NOT a retryable failure — a dead/blocked
// site is itself a signal; we mark BLOCKED (+ reason) and ack. Only an
// unexpected DB error retries → DLQ after max_retries.
import { and, eq, inArray } from "drizzle-orm";
import {
  computePromoterEnrichment,
  isPlaceholderDescription,
  PROMOTER_ENRICHMENT_EXHAUST_AFTER,
} from "@takemetothefair/constants";
import { sanitizeScrapedDescription } from "@takemetothefair/utils";
import { promoters, promoterEnrichmentCandidates } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import { logEnrichment } from "../helpers.js";
import { fetchVendorSite } from "./fetch-site.js";
import { extractPromoterSignals, type PromoterExtraction } from "./promoter-extract.js";
import { probePromoterImage } from "./promoter-image.js";

/** One promoter pre-extraction job. */
export interface PromoterEnrichmentMessage {
  promoterId: string;
  /** Groups a cron batch (or 'manual-<uuid>' for enrich_promoter). */
  jobRunId: string;
  /** Dry-run stages only; live also auto-applies high-confidence fills. */
  dryRun: boolean;
}

type QueueMessage<T> = {
  body: T;
  attempts?: number;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
};
type Batch<T> = { queue: string; messages: readonly QueueMessage<T>[] };

/** The subset of Env the promoter-enrichment path needs (mirrors EnrichmentEnv). */
export interface PromoterEnrichmentEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  ENRICHMENT_DRY_RUN?: string;
}

/** Promoter enrichment_blocked_reason values this dispatcher sets. */
type BlockedReason = "host_gated" | "js_gated" | "stale";

/** Map a fetchVendorSite failReason → a promoter enrichment_blocked_reason. */
function mapBlockedReason(failReason: string | undefined): BlockedReason {
  const r = failReason ?? "";
  if (r === "ssrf-blocked" || r === "bad-protocol" || r === "invalid-url") return "host_gated";
  // Browser-Rendering escalation was attempted and also failed → JS-gated.
  if (r.includes("br=")) return "js_gated";
  return "stale";
}

export async function handlePromoterEnrichmentBatch(
  batch: Batch<PromoterEnrichmentMessage>,
  env: PromoterEnrichmentEnv
): Promise<void> {
  const db = getDb(env.DB);
  for (const msg of batch.messages) {
    try {
      await processPromoterEnrichmentJob(db, env, msg.body);
      msg.ack();
    } catch (err) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:promoter-enrichment:dispatch",
        message: "promoter enrichment failed; retrying",
        error: err,
        context: { promoterId: msg.body?.promoterId, jobRunId: msg.body?.jobRunId },
      });
      // Exponential backoff on the message's own attempt counter (cap 5 min).
      const attempts = msg.attempts ?? 1;
      const delaySeconds = Math.min(300, 2 ** attempts);
      msg.retry({ delaySeconds });
    }
  }
}

const PROMOTER_COLUMNS = {
  id: promoters.id,
  companyName: promoters.companyName,
  slug: promoters.slug,
  website: promoters.website,
  heroImageUrl: promoters.heroImageUrl,
  logoUrl: promoters.logoUrl,
  description: promoters.description,
  socialLinks: promoters.socialLinks,
  contactEmail: promoters.contactEmail,
  contactPhone: promoters.contactPhone,
  enrichmentStatus: promoters.enrichmentStatus,
  enrichmentZeroYieldStreak: promoters.enrichmentZeroYieldStreak,
} as const;

/** Proposed-field → live promoter column (all six are review-applicable). */
const FIELD_TO_COLUMN: Record<string, keyof typeof promoters.$inferInsert> = {
  hero: "heroImageUrl",
  logo: "logoUrl",
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

const AFFINITY_STOPWORDS = new Set(["the", "and", "inc", "llc", "org", "com", "net", "www"]);

function nameTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !AFFINITY_STOPWORDS.has(t));
}

/** The website's host label without www/TLD: `worcester4h.org` → `worcester4h`. */
function siteLabel(website: string | null | undefined): string | null {
  try {
    const host = new URL(website ?? "").hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch {
    return null;
  }
}

/**
 * A handle that identifies an account without NAMING it — a YouTube channel id
 * (`UCLn8aDb85tYvY…`), `profile.php?id=…`, a numeric group/page, or a bare path
 * word. It cannot show affinity either way, so it is not evidence.
 */
const SOCIAL_PATH_WORDS = new Set([
  "profilephp",
  "groups",
  "pages",
  "channel",
  "events",
  "showcase",
  "videos",
  "streams",
  "featured",
  "about",
  "user",
  "c",
]);

function isOpaqueHandle(handle: string): boolean {
  if (/^uc[a-z0-9]{20,}$/.test(handle)) return true;
  if (/^\d+$/.test(handle) || /\d{6,}/.test(handle)) return true;
  return SOCIAL_PATH_WORDS.has(handle);
}

/** The NAMED handle: the last path segment that is not a path word
 *  (`youtube.com/@holycrosslutheran-kennebunk/streams` → `holycrosslutherankennebunk`). */
function namedHandleOf(url: string): string | null {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  const words = segments.map((seg) => seg.toLowerCase().replace(/[^a-z0-9]/g, ""));
  while (words.length > 0 && SOCIAL_PATH_WORDS.has(words[words.length - 1])) words.pop();
  return words.length > 0 ? words[words.length - 1] || null : null;
}

/**
 * OPE-963 — does this social payload look like the promoter's OWN accounts?
 *
 * True when at least one NAMED handle contains one of the promoter's name
 * tokens (≥3 chars, stopwords removed), or it and the website's host label
 * contain one another. Opaque handles (channel ids, profile.php, numeric groups)
 * are ignored; a payload with no named handle at all is NOT affine — a human
 * looks.
 *
 * Why "at least one" and not "every": measured against the 205 social rows
 * already auto-applied in prod, requiring every link staged 67 (33%), most of
 * them genuine accounts that failed only on a YouTube channel id or a
 * profile.php URL. The specimens this exists for — state 4-H + UMass CAFE on a
 * county chapter, a theme vendor's accounts on SoWa Boston — have NO affine
 * handle at all, so "at least one" still stages them. Exported for tests.
 */
export function socialLinksHaveNameAffinity(
  socialJson: string,
  companyName: string | null | undefined,
  website: string | null | undefined
): boolean {
  let links: Record<string, string>;
  try {
    links = JSON.parse(socialJson) as Record<string, string>;
  } catch {
    return false;
  }
  const tokens = nameTokens(companyName);
  const label = siteLabel(website);
  return Object.values(links).some((url) => {
    const handle = namedHandleOf(url);
    if (!handle || handle.length < 3 || isOpaqueHandle(handle)) return false;
    if (tokens.some((t) => handle.includes(t))) return true;
    return (
      label !== null && label.length >= 3 && (label.includes(handle) || handle.includes(label))
    );
  });
}

/**
 * Build the fill-empty-only proposal set from a promoter row + the extraction
 * (og:image already probed into hero/logo). Pure — no DB.
 */
async function buildProposals(
  row: Record<string, unknown>,
  ex: PromoterExtraction
): Promise<Proposal[]> {
  const proposals: Proposal[] = [];

  // --- hero / logo from the single og:image candidate ---
  if (ex.ogImage) {
    const probed = await probePromoterImage(ex.ogImage);
    if (probed) {
      if (probed.classification === "hero" && isEmpty(row.heroImageUrl as string | null)) {
        proposals.push({
          field: "hero",
          proposedValue: probed.url,
          method: "og-image",
          confidence: probed.heroConfident ? 0.85 : 0.5,
          flags: [],
          // Hero auto-applies only when the full hero rule holds.
          autoApply: probed.heroConfident,
        });
      } else if (probed.classification === "logo" && isEmpty(row.logoUrl as string | null)) {
        proposals.push({
          field: "logo",
          proposedValue: probed.url,
          method: "og-image",
          confidence: 0.5,
          flags: [],
          // Logo is never auto-applied (a square og:image is often a hero crop
          // or a generic share card — a human confirms).
          autoApply: false,
        });
      }
    }
  }

  // --- description (fill-empty-only; empty ⇔ blank OR placeholder) ---
  if (ex.description && isPlaceholderDescription(row.description as string | null)) {
    const clean = sanitizeScrapedDescription(ex.description.value);
    if (clean.trim() !== "") {
      proposals.push({
        field: "description",
        proposedValue: clean,
        method: ex.description.method,
        confidence: ex.description.confidence,
        flags: [],
        // Non-placeholder description → high-confidence auto-apply.
        autoApply: !isPlaceholderDescription(clean),
      });
    }
  }

  // --- social_links (fill-empty-only; recognized domains only) ---
  if (ex.socialLinks && isEmpty(row.socialLinks as string | null)) {
    // OPE-963 — name affinity. Worcester County 4-H auto-applied the STATE 4-H
    // and UMass CAFE accounts: real, related, and not the chapter's. A handle
    // that shares nothing with the promoter's name or website is staged,
    // flagged, for a human — never applied. Mirrors OPE-249 fix #5's domain
    // affinity for regex-scraped email.
    const affine = socialLinksHaveNameAffinity(
      ex.socialLinks.value,
      row.companyName as string | null,
      row.website as string | null
    );
    proposals.push({
      field: "social_links",
      proposedValue: ex.socialLinks.value,
      method: ex.socialLinks.method,
      confidence: affine ? ex.socialLinks.confidence : ex.socialLinks.confidence * 0.5,
      flags: affine ? [] : ["social_no_name_affinity"],
      autoApply: affine,
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
      // A single mailto: anchor (or JSON-LD email) is high-confidence.
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
      // A single tel: anchor (or JSON-LD telephone) is high-confidence.
      autoApply: ex.contactPhone.method === "tel" || ex.contactPhone.method === "jsonld",
    });
  }

  return proposals;
}

export interface PromoterEnrichmentRunSummary {
  promoterId: string;
  outcome: "staged" | "merged" | "blocked" | "no_source" | "not_found" | "exhausted";
  candidateCount?: number;
  appliedFields?: string[];
  blockedReason?: BlockedReason;
  fetchMethod?: string;
}

/**
 * Enrich one promoter end-to-end. Exported so the synchronous enrich_promoter
 * MCP tool reuses the exact same path (no queue) and returns inline.
 */
export async function processPromoterEnrichmentJob(
  db: Db,
  env: PromoterEnrichmentEnv,
  msg: PromoterEnrichmentMessage
): Promise<PromoterEnrichmentRunSummary> {
  const [row] = await db
    .select(PROMOTER_COLUMNS)
    .from(promoters)
    .where(eq(promoters.id, msg.promoterId))
    .limit(1);

  if (!row) return { promoterId: msg.promoterId, outcome: "not_found" };

  // --- No website → NO_SOURCE, nothing to enrich from ---
  if (!row.website || row.website.trim() === "") {
    await db
      .update(promoters)
      .set({ enrichmentStatus: "NO_SOURCE", enrichmentAttemptedAt: new Date() })
      .where(eq(promoters.id, msg.promoterId));
    await logEnrichment(db, {
      targetType: "promoter",
      targetId: msg.promoterId,
      source: "browser_enrich",
      status: "skipped",
      notes: "no website on file",
    });
    return { promoterId: msg.promoterId, outcome: "no_source" };
  }

  const sourceUrl = row.website.trim();
  const fetched = await fetchVendorSite(sourceUrl, env);

  // --- Fetch failure → BLOCKED (+ mapped reason), stamp, ack ---
  if (!fetched.ok || !fetched.html) {
    const reason = mapBlockedReason(fetched.failReason);
    await db
      .update(promoters)
      .set({
        enrichmentStatus: "BLOCKED",
        enrichmentBlockedReason: reason,
        enrichmentAttemptedAt: new Date(),
      })
      .where(eq(promoters.id, msg.promoterId));
    await logEnrichment(db, {
      targetType: "promoter",
      targetId: msg.promoterId,
      source: "browser_enrich",
      status: "failure",
      notes: `fetch failed: ${fetched.failReason ?? "unknown"} → ${reason}`,
    });
    return { promoterId: msg.promoterId, outcome: "blocked", blockedReason: reason };
  }

  const extraction = extractPromoterSignals(fetched.html, sourceUrl);
  const proposals = await buildProposals(row as Record<string, unknown>, extraction);

  // Idempotent re-run: clear this promoter's still-open proposals, then restage
  // (honors the one-pending-per-field partial unique index).
  await db
    .delete(promoterEnrichmentCandidates)
    .where(
      and(
        eq(promoterEnrichmentCandidates.promoterId, msg.promoterId),
        eq(promoterEnrichmentCandidates.decision, "pending")
      )
    );

  const now = new Date();
  if (proposals.length > 0) {
    await db.insert(promoterEnrichmentCandidates).values(
      proposals.map((p) => ({
        promoterId: msg.promoterId,
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

  // OPE-962 — count consecutive successful fetches that found NOTHING to stage.
  // (A failed fetch never reaches here: that is BLOCKED, a different fact.) At
  // the threshold a queue-selectable promoter becomes EXHAUSTED and the nightly
  // selector stops re-fetching it. Operator-owned states are left alone.
  const streak = proposals.length === 0 ? (row.enrichmentZeroYieldStreak ?? 0) + 1 : 0;
  const exhaust =
    streak >= PROMOTER_ENRICHMENT_EXHAUST_AFTER &&
    (row.enrichmentStatus === null || row.enrichmentStatus === "NEEDS_ENRICHMENT");

  // --- Dry-run: stage only, stamp the attempt ---
  if (msg.dryRun) {
    await db
      .update(promoters)
      .set({
        enrichmentAttemptedAt: now,
        enrichmentZeroYieldStreak: streak,
        ...(exhaust ? { enrichmentStatus: "EXHAUSTED" as const } : {}),
      })
      .where(eq(promoters.id, msg.promoterId));
    await logEnrichment(db, {
      targetType: "promoter",
      targetId: msg.promoterId,
      source: "browser_enrich",
      status: proposals.length > 0 ? "success" : "skipped",
      fieldsChanged: stagedFields,
      notes:
        `dry-run: ${proposals.length} candidate(s) staged` +
        (exhaust ? ` — EXHAUSTED after ${streak} consecutive zero-candidate attempts` : ""),
    });
    return {
      promoterId: msg.promoterId,
      outcome: exhaust ? "exhausted" : "staged",
      candidateCount: proposals.length,
      fetchMethod: fetched.fetchMethod,
    };
  }

  // --- Live: auto-apply the high-confidence fills (fill-empty-only) ---
  const applied = await applyFills(db, msg.promoterId, proposals);
  await recomputeAndStamp(db, msg.promoterId, applied.length > 0);
  // OPE-962 — same streak on a live run. Zero proposals means nothing was
  // applied either, so recompute cannot have completed coverage; exhaust only
  // if the recomputed status is still the queue-selectable one.
  await db
    .update(promoters)
    .set({ enrichmentZeroYieldStreak: streak })
    .where(eq(promoters.id, msg.promoterId));
  if (exhaust) {
    await db
      .update(promoters)
      .set({ enrichmentStatus: "EXHAUSTED" })
      .where(
        and(eq(promoters.id, msg.promoterId), eq(promoters.enrichmentStatus, "NEEDS_ENRICHMENT"))
      );
  }
  await logEnrichment(db, {
    targetType: "promoter",
    targetId: msg.promoterId,
    source: "browser_enrich",
    status: applied.length > 0 ? "success" : "skipped",
    fieldsChanged: applied,
    notes: `auto-apply: applied ${applied.length} field(s)`,
  });

  return {
    promoterId: msg.promoterId,
    outcome: "merged",
    candidateCount: proposals.length,
    appliedFields: applied,
    fetchMethod: fetched.fetchMethod,
  };
}

/**
 * Apply only high-confidence fills into empty promoter columns. Flagged or
 * non-auto-apply proposals stay staged for manual review. Marks the applied
 * candidate rows 'auto_merged'. Returns the promoter fields actually written.
 */
async function applyFills(db: Db, promoterId: string, proposals: Proposal[]): Promise<string[]> {
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
  await db.update(promoters).set(update).where(eq(promoters.id, promoterId));
  await db
    .update(promoterEnrichmentCandidates)
    .set({ decision: "auto_merged", reviewedAt: new Date(), reviewedBy: "auto-merge" })
    .where(
      and(
        eq(promoterEnrichmentCandidates.promoterId, promoterId),
        eq(promoterEnrichmentCandidates.decision, "pending"),
        inArray(promoterEnrichmentCandidates.proposedField, applied)
      )
    );
  return applied;
}

/**
 * Recompute enrichment_status/coverage from the promoter's now-current fields
 * (via computePromoterEnrichment) and stamp the attempt. Sets last_enriched_at
 * only when something was actually written this run.
 */
async function recomputeAndStamp(db: Db, promoterId: string, didApply: boolean): Promise<void> {
  const [p] = await db
    .select({
      website: promoters.website,
      heroImageUrl: promoters.heroImageUrl,
      logoUrl: promoters.logoUrl,
      description: promoters.description,
      socialLinks: promoters.socialLinks,
      contactEmail: promoters.contactEmail,
      contactPhone: promoters.contactPhone,
      enrichmentStatus: promoters.enrichmentStatus,
    })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  if (!p) return;
  const enrichment = computePromoterEnrichment(p, p.enrichmentStatus);
  const now = new Date();
  await db
    .update(promoters)
    .set({
      enrichmentStatus: enrichment.status,
      enrichmentCoverage: enrichment.coverageJson,
      enrichmentAttemptedAt: now,
      ...(didApply ? { lastEnrichedAt: now } : {}),
    })
    .where(eq(promoters.id, promoterId));
}
