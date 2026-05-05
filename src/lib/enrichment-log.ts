/**
 * §10.2 enrichment audit logger.
 *
 * One row per attempt to populate or update content on a vendor or event,
 * regardless of outcome. Powers diagnostic dashboards and lets us spot
 * pipelines that silently degrade (e.g. AI extractor returning empty
 * descriptions for two weeks straight).
 *
 * Source taxonomy is closed at the TS layer (not DB-enforced) so adding a
 * new pipeline doesn't require a migration. If you add a source, update
 * ENRICHMENT_SOURCES so callers get an autocomplete + lint warning.
 */
import { eq } from "drizzle-orm";
import { enrichmentLog, vendors, events } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

export const ENRICHMENT_SOURCES = [
  "ai_workers", // Cloudflare Workers AI URL-import path
  "scraper", // mainefairs.net etc. parser
  "manual_admin", // admin-edited via UI/MCP update_*
  "vendor_self", // vendor edited via /vendor/* portal or claim flow
  "mcp_create", // MCP create_vendor / create_event
] as const;
export type EnrichmentSource = (typeof ENRICHMENT_SOURCES)[number];

export const ENRICHMENT_STATUSES = ["success", "failure", "skipped"] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];

export type EnrichmentTargetType = "vendor" | "event";

type Db = ReturnType<typeof getCloudflareDb>;

export interface LogEnrichmentParams {
  targetType: EnrichmentTargetType;
  targetId: string;
  source: EnrichmentSource;
  status: EnrichmentStatus;
  fieldsChanged?: string[];
  notes?: string;
  actorUserId?: string | null;
  /** Defaults to now. Pass for backfill/replay scenarios only. */
  attemptedAt?: Date;
  /** Defaults to now (success/failure) or null (skipped). */
  finishedAt?: Date | null;
}

/**
 * Append an enrichment log row AND update the target's enrichment_source +
 * enrichment_attempted_at columns when the attempt succeeded. Failures /
 * skips append the log row but don't touch the target's columns — the
 * "last successful enrichment" semantic is what's useful.
 */
export async function logEnrichment(db: Db, p: LogEnrichmentParams): Promise<void> {
  const now = new Date();
  const attemptedAt = p.attemptedAt ?? now;
  const finishedAt =
    p.finishedAt !== undefined ? p.finishedAt : p.status === "skipped" ? null : now;

  await db.insert(enrichmentLog).values({
    targetType: p.targetType,
    targetId: p.targetId,
    source: p.source,
    status: p.status,
    attemptedAt,
    finishedAt,
    fieldsChanged: p.fieldsChanged ? JSON.stringify(p.fieldsChanged) : null,
    notes: p.notes ?? null,
    actorUserId: p.actorUserId ?? null,
  });

  if (p.status === "success" && p.targetType === "vendor") {
    await db
      .update(vendors)
      .set({ enrichmentSource: p.source, enrichmentAttemptedAt: attemptedAt })
      .where(eq(vendors.id, p.targetId));
  }
  // Events table has no per-row enrichment_source column today; the log row
  // is the only durable record. Add events.enrichment_source if dashboards
  // need a per-event "last touched by" badge.
  void events;
}
