/**
 * Schema-org sync Workflow — proof-of-pattern.
 *
 * The existing `/api/admin/schema-org/sync` runs as a single HTTP request
 * with `limit=50` to stay under Cloudflare's 30s response cap. Works fine
 * for current usage but can't process the whole catalog in one go.
 *
 * This Workflow demonstrates the pattern for **truly long-running jobs**:
 *   - One `step.do()` per event → durable retry on per-step failure
 *   - Process arbitrary number of events without the 30s cap
 *   - Survives Worker restarts mid-run
 *
 * Today this is exposed alongside (not replacing) the existing sync
 * endpoint. Once a use case requires processing 500+ events at once, the
 * old endpoint can be retired in favour of `start-workflow` + status poll.
 *
 * Runs in the MCP Worker (Pages projects can't host WorkflowEntrypoints).
 * Triggered via the SCHEMA_ORG_SYNC binding from either main app or MCP.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { eventSchemaOrg } from "../schema.js";

/** Per-instance params handed in at `WORKFLOW.create({ params: {...} })`. */
export type SchemaOrgSyncParams = {
  /** Event IDs to process. Caller is responsible for assembling this list
   *  (e.g. via the existing admin/schema-org/sync GET endpoint that lists
   *  unsynced events). Cap at 1000 to keep workflow runtime reasonable. */
  eventIds: string[];
  /** Per-event delay between fetch calls. 500ms matches the existing sync
   *  rate limit (avoid hammering aggregator origin servers). */
  delayMs?: number;
};

type Env = {
  DB: D1Database;
};

export class SchemaOrgSyncWorkflow extends WorkflowEntrypoint<Env, SchemaOrgSyncParams> {
  async run(event: WorkflowEvent<SchemaOrgSyncParams>, step: WorkflowStep) {
    const { eventIds, delayMs = 500 } = event.payload;
    const cap = Math.min(eventIds.length, 1000);
    const ids = eventIds.slice(0, cap);

    let success = 0;
    let failure = 0;
    let notFound = 0;

    for (const eventId of ids) {
      // Each event is its own step — Cloudflare retries the step on
      // transient errors (network blips, 5xx from origin) before failing
      // the whole workflow. Step name includes the event ID so retries
      // are deduplicated correctly.
      try {
        await step.do(`fetch-${eventId}`, async () => {
          const db = getDb(this.env.DB);

          // Look up the event's ticketUrl via raw SQL since we don't have
          // the events table object imported here. Could add later.
          const rows = await this.env.DB.prepare(
            "SELECT ticket_url FROM events WHERE id = ? LIMIT 1"
          )
            .bind(eventId)
            .all<{ ticket_url: string | null }>();
          const ticketUrl = rows.results[0]?.ticket_url ?? null;
          if (!ticketUrl) {
            notFound++;
            return { status: "no_ticket_url" };
          }

          // Fetch the schema-org JSON-LD. The existing fetchSchemaOrg
          // helper is in the main app; for the proof-of-pattern we duplicate
          // a minimal version here. Long-term, hoist into a shared package.
          const result = await fetchSchemaOrgMinimal(ticketUrl);
          const now = new Date();

          if (result.status === "available" && result.data) {
            // Upsert the eventSchemaOrg row. Same shape as the inline sync
            // endpoint, just without the per-field detail (proof-of-pattern).
            const existing = await db
              .select({ id: eventSchemaOrg.id, fetchCount: eventSchemaOrg.fetchCount })
              .from(eventSchemaOrg)
              .where(eq(eventSchemaOrg.eventId, eventId))
              .limit(1);

            if (existing.length > 0) {
              await db
                .update(eventSchemaOrg)
                .set({
                  ticketUrl,
                  schemaName: result.data.name ?? null,
                  schemaDescription: result.data.description ?? null,
                  status: result.status,
                  lastFetchedAt: now,
                  lastError: null,
                  updatedAt: now,
                  fetchCount: sql`${eventSchemaOrg.fetchCount} + 1`,
                })
                .where(eq(eventSchemaOrg.eventId, eventId));
            } else {
              await db.insert(eventSchemaOrg).values({
                id: crypto.randomUUID(),
                eventId,
                ticketUrl,
                schemaName: result.data.name ?? null,
                schemaDescription: result.data.description ?? null,
                status: result.status,
                lastFetchedAt: now,
                lastError: null,
                fetchCount: 1,
                createdAt: now,
                updatedAt: now,
              });
            }
            success++;
            return { status: "ok" };
          }

          failure++;
          return { status: result.status };
        });
      } catch (err) {
        // Step exhausted retries — log and continue with the next event.
        console.error(`[workflow:schema-org-sync] event ${eventId} failed:`, err);
        failure++;
      }

      // Throttle between events. Workflow's step.sleep accepts numeric ms.
      if (delayMs > 0) await step.sleep(`delay-${eventId}`, delayMs);
    }

    return { processed: ids.length, success, failure, notFound, capped: eventIds.length > cap };
  }
}

/** Minimal schema-org fetcher — proof-of-pattern only. The full helper at
 *  src/lib/schema-org/fetcher.ts handles JSON-LD parsing, redirects, and
 *  the actual normalization. Hoist that into a shared package when this
 *  workflow becomes the canonical sync path. */
async function fetchSchemaOrgMinimal(
  url: string
): Promise<{
  status: "available" | "not_found" | "invalid" | "error";
  data?: { name?: string; description?: string };
}> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MMATF-SchemaOrgSync/1.0" },
      redirect: "follow",
    });
    if (!res.ok) return { status: res.status === 404 ? "not_found" : "error" };
    const html = await res.text();
    const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return { status: "not_found" };
    try {
      const json = JSON.parse(m[1]);
      const candidate = Array.isArray(json) ? json[0] : json;
      if (candidate?.["@type"] === "Event") {
        return {
          status: "available",
          data: { name: candidate.name, description: candidate.description },
        };
      }
      return { status: "invalid" };
    } catch {
      return { status: "invalid" };
    }
  } catch {
    return { status: "error" };
  }
}
