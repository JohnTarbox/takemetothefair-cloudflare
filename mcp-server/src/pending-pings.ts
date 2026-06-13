/**
 * Outbox for deferred IndexNow pings.
 *
 * Bulk-ingestion workflows set `defer_search_ping: true` on each write, which
 * routes the lifecycle hook into the `pending_search_pings` table instead of
 * firing an IndexNow ping inline (1–3 sec per call adds up over 384 vendors).
 * The flush_pending_search_pings MCP tool (and the hourly cron) drains the
 * table, dedupes by entity URL, and submits one batched IndexNow call via the
 * main app's /api/internal/indexnow endpoint.
 *
 * Design choices:
 * - D1 outbox table over Cloudflare Queue: matches the project's existing
 *   "manual sweep endpoints" pattern, gives operators a SELECT for queue
 *   depth, and dedup-in-flush is cheaper as SQL.
 * - Claim-via-UPDATE for concurrency: a single `UPDATE ... SET flushed_batch_id`
 *   acts as both lock and idempotency token. Concurrent flushes claim disjoint
 *   batches by writing different batch_id values; no row-level lock needed.
 * - Submission via main-app endpoint: the IndexNow client logic, retry,
 *   observability (indexnow_submissions, time_to_index_log) all live there.
 *   Re-implementing it in MCP would duplicate the upstream concerns.
 */

import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { pendingSearchPings } from "./schema.js";
import type { Db } from "./db.js";
import { publicUrlFor } from "./helpers.js";
import { logError } from "./logger.js";

export type EntityType = "vendor" | "venue" | "event" | "promoter" | "blog";
export type PingAction = "create" | "update" | "status_change";

const URL_KIND_BY_ENTITY: Record<EntityType, Parameters<typeof publicUrlFor>[0]> = {
  vendor: "vendors",
  venue: "venues",
  event: "events",
  promoter: "promoters",
  blog: "blog",
};

const MAX_FLUSH_BATCH = 10_000; // matches main-app pingIndexNow MAX_BATCH_SIZE

export interface EnqueueArgs {
  entityType: EntityType;
  entityId: string;
  entitySlug: string;
  action: PingAction;
}

export async function enqueuePendingPing(db: Db, args: EnqueueArgs): Promise<void> {
  await db.insert(pendingSearchPings).values({
    entityType: args.entityType,
    entityId: args.entityId,
    entitySlug: args.entitySlug,
    action: args.action,
    queuedAt: new Date(),
  });
}

interface FlushEnv {
  DB?: D1Database;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export interface FlushOpts {
  entityType?: EntityType | "all";
  maxAgeSeconds?: number | null;
  dryRun?: boolean;
  source?: string;
}

export interface FlushResult {
  batchId: string;
  flushedCount: number;
  byEntityType: Record<string, number>;
  indexnowResponse: string;
  schemaOrgRegenCount: number; // always 0 in v1 — no regen pipeline today
  dryRun: boolean;
}

/**
 * Drain queued pings into one batched IndexNow submission. Returns counts +
 * the batch id used to claim the rows. Safe to call concurrently — two
 * invocations get disjoint batches because the claim UPDATE is atomic on the
 * `flushed_batch_id IS NULL` predicate.
 *
 * Error semantics:
 * - Network/IndexNow failure → rolls back the claim (un-sets flushed_batch_id)
 *   so a later flush retries. Result.indexnowResponse reports the error.
 * - Empty queue → no-op, flushedCount: 0, indexnowResponse: "ok".
 * - dry_run: true → SELECT counts only, no UPDATEs, no HTTP call.
 */
export async function claimAndFlush(
  db: Db,
  env: FlushEnv,
  opts: FlushOpts = {}
): Promise<FlushResult> {
  const batchId = crypto.randomUUID();
  const entityFilter = opts.entityType && opts.entityType !== "all" ? opts.entityType : null;
  const maxAge = opts.maxAgeSeconds ?? null;
  const ageCutoff = maxAge !== null ? new Date(Date.now() - maxAge * 1000) : null;

  // dry_run: just count what would flush. No claim, no submit.
  if (opts.dryRun) {
    const filters = [isNull(pendingSearchPings.flushedAt)];
    if (entityFilter) filters.push(eq(pendingSearchPings.entityType, entityFilter));
    if (ageCutoff) filters.push(lt(pendingSearchPings.queuedAt, ageCutoff));
    const rows = await db
      .select({ entityType: pendingSearchPings.entityType })
      .from(pendingSearchPings)
      .where(and(...filters));
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.entityType] = (byType[r.entityType] ?? 0) + 1;
    return {
      batchId,
      flushedCount: rows.length,
      byEntityType: byType,
      indexnowResponse: "dry_run",
      schemaOrgRegenCount: 0,
      dryRun: true,
    };
  }

  // 1. Claim a batch. The UPDATE is the lock: rows with flushed_batch_id NULL
  //    AND matching filters get our batchId. Concurrent flushers claim disjoint
  //    rows. SQLite/D1 doesn't support FOR UPDATE; this pattern is the SQL
  //    equivalent of a compare-and-set per row.
  const claimWhere = [
    isNull(pendingSearchPings.flushedAt),
    isNull(pendingSearchPings.flushedBatchId),
  ];
  if (entityFilter) claimWhere.push(eq(pendingSearchPings.entityType, entityFilter));
  if (ageCutoff) claimWhere.push(lt(pendingSearchPings.queuedAt, ageCutoff));

  // D1 doesn't accept a LIMIT clause on UPDATE without `update ... where rowid in (select ...)`.
  // For our scale (a few thousand rows per flush) the unbounded claim is fine;
  // chunking happens at the IndexNow-submit step below.
  await db
    .update(pendingSearchPings)
    .set({ flushedBatchId: batchId })
    .where(and(...claimWhere));

  // 2. Fetch the claimed rows in queue order.
  const claimed = await db
    .select({
      id: pendingSearchPings.id,
      entityType: pendingSearchPings.entityType,
      entityId: pendingSearchPings.entityId,
      entitySlug: pendingSearchPings.entitySlug,
    })
    .from(pendingSearchPings)
    .where(
      and(eq(pendingSearchPings.flushedBatchId, batchId), isNull(pendingSearchPings.flushedAt))
    )
    .orderBy(asc(pendingSearchPings.queuedAt));

  if (claimed.length === 0) {
    return {
      batchId,
      flushedCount: 0,
      byEntityType: {},
      indexnowResponse: "ok",
      schemaOrgRegenCount: 0,
      dryRun: false,
    };
  }

  // 3. Dedupe by (entityType, entitySlug). Multiple writes to the same entity
  //    in one batch collapse to a single IndexNow URL.
  const byType: Record<string, number> = {};
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const row of claimed) {
    byType[row.entityType] = (byType[row.entityType] ?? 0) + 1;
    const key = `${row.entityType}:${row.entitySlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = URL_KIND_BY_ENTITY[row.entityType as EntityType];
    if (!kind) continue; // unknown entity type — log + skip
    urls.push(publicUrlFor(kind, row.entitySlug));
  }

  // 4. Submit in chunks of MAX_FLUSH_BATCH. The main-app endpoint accepts
  //    up to 10k URLs per call; for our current scale we only ever hit one
  //    chunk in practice. Defensive against future growth.
  let response = "ok";
  for (let i = 0; i < urls.length; i += MAX_FLUSH_BATCH) {
    const chunk = urls.slice(i, i + MAX_FLUSH_BATCH);
    try {
      const submitted = await submitIndexNowBatch(env, chunk, opts.source ?? "flush-pending");
      if (!submitted.ok) {
        response = submitted.error ?? `HTTP ${submitted.status}`;
        await logError(env.DB ?? null, {
          source: "mcp:pending-pings:flush",
          message: "submitIndexNowBatch returned non-ok",
          statusCode: submitted.status,
          sessionId: batchId,
          context: { chunkStart: i, chunkSize: chunk.length, error: submitted.error },
        });
        break;
      }
    } catch (err) {
      response = err instanceof Error ? err.message : String(err);
      await logError(env.DB ?? null, {
        source: "mcp:pending-pings:flush",
        message: "submitIndexNowBatch threw",
        error: err,
        sessionId: batchId,
        context: { chunkStart: i, chunkSize: chunk.length },
      });
      break;
    }
  }

  // 5. Mark flushed or roll back the claim on error.
  if (response === "ok") {
    await db
      .update(pendingSearchPings)
      .set({ flushedAt: new Date() })
      .where(eq(pendingSearchPings.flushedBatchId, batchId));
  } else {
    await db
      .update(pendingSearchPings)
      .set({ flushedBatchId: sql`NULL` })
      .where(
        and(eq(pendingSearchPings.flushedBatchId, batchId), isNull(pendingSearchPings.flushedAt))
      );
  }

  return {
    batchId,
    flushedCount: claimed.length,
    byEntityType: byType,
    indexnowResponse: response,
    schemaOrgRegenCount: 0,
    dryRun: false,
  };
}

/** Structured fields the REL4-updated /api/internal/indexnow endpoint returns
 *  in its JSON body so callers can surface the TRUE Bing outcome. */
export interface IndexNowEndpointBody {
  success?: boolean;
  count?: number;
  attempted?: number;
  succeeded?: number;
  failed?: number;
  /** The real Bing HTTP status (e.g. 429) when the submission failed. */
  indexnow_http_status?: number | null;
  error?: string;
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  error?: string;
  /** Parsed endpoint body (REL4) — carries the true Bing status + counts. */
  body?: IndexNowEndpointBody;
}

async function parseBody(response: Response): Promise<IndexNowEndpointBody | undefined> {
  try {
    return (await response.clone().json()) as IndexNowEndpointBody;
  } catch {
    return undefined;
  }
}

/**
 * POST a URL batch to the main app's /api/internal/indexnow endpoint. The
 * endpoint runs pingIndexNow against the URL list, persists submissions to
 * indexnow_submissions, and seeds time_to_index_log — all the observability
 * that the inline pingIndexNow path provides.
 *
 * Prefers the MAIN_APP service binding (zero-latency); falls back to public
 * HTTPS via MAIN_APP_URL + INTERNAL_API_KEY when unbound (typical in local
 * dev or until the binding is enabled per wrangler.toml comment).
 *
 * Exported so the K23 resubmit tool can reuse the same transport (and inherit
 * REL4's true-status reporting) rather than re-implementing the binding/public
 * branching.
 */
export async function submitIndexNowBatch(
  env: FlushEnv,
  urls: string[],
  source: string
): Promise<SubmitResult> {
  if (urls.length === 0) return { ok: true, status: 200 };

  const body = JSON.stringify({ urls, source });
  const headers = {
    "Content-Type": "application/json",
    "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
  };

  if (env.MAIN_APP) {
    const response = await env.MAIN_APP.fetch(
      new Request("https://meetmeatthefair.com/api/internal/indexnow", {
        method: "POST",
        headers,
        body,
      })
    );
    const parsed = await parseBody(response);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      return {
        ok: false,
        status: response.status,
        error: text || `HTTP ${response.status}`,
        body: parsed,
      };
    }
    return { ok: true, status: response.status, body: parsed };
  }

  if (!env.MAIN_APP_URL || !env.INTERNAL_API_KEY) {
    return { ok: false, status: 0, error: "MAIN_APP_URL or INTERNAL_API_KEY missing" };
  }

  const response = await fetch(`${env.MAIN_APP_URL}/api/internal/indexnow`, {
    method: "POST",
    headers,
    body,
  });
  const parsed = await parseBody(response);
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    return {
      ok: false,
      status: response.status,
      error: text || `HTTP ${response.status}`,
      body: parsed,
    };
  }
  return { ok: true, status: response.status, body: parsed };
}
