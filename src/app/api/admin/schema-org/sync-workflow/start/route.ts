/**
 * Start a schema-org-sync Workflow.
 *
 * This is the canonical sync trigger — the older
 * /api/admin/schema-org/sync chunked POST endpoint was retired in favour
 * of this Workflow path, which handles any number of events durably with
 * per-event step retry.
 *
 * Two trigger modes:
 *   1. Explicit IDs: `{ "eventIds": ["id1", "id2", ...] }` — useful for
 *      "retry these failed events" flows.
 *   2. Query mode:  `{ "mode": "missing" | "existing" | "all", "max"?: N }`
 *      — resolves IDs server-side from the events + event_schema_org
 *      tables, mirroring the three modes the old endpoint supported.
 *
 * Returns the workflow instance ID so the caller can poll status via
 * GET /api/admin/schema-org/sync-workflow/[id]/status.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, eventSchemaOrg } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const MAX_EVENT_IDS = 1000;

const explicitSchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(MAX_EVENT_IDS),
  delayMs: z.number().int().min(0).max(5000).optional(),
});

const modeSchema = z.object({
  mode: z.enum(["missing", "existing", "all"]),
  max: z.number().int().min(1).max(MAX_EVENT_IDS).optional(),
  delayMs: z.number().int().min(0).max(5000).optional(),
});

const bodySchema = z.union([explicitSchema, modeSchema]);

export async function POST(request: NextRequest) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.message },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();

  // Resolve the eventIds to feed the workflow. Either explicit or by mode.
  let eventIds: string[];
  let delayMs: number | undefined;

  if ("eventIds" in parsed.data) {
    eventIds = parsed.data.eventIds;
    delayMs = parsed.data.delayMs;
  } else {
    const { mode, max = MAX_EVENT_IDS } = parsed.data;
    delayMs = parsed.data.delayMs;

    // Same three query shapes the old /sync endpoint supported.
    let query;
    if (mode === "missing") {
      // Events with ticketUrl but no successful schema-org row.
      query = db
        .select({ id: events.id })
        .from(events)
        .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(
          and(
            isNotNull(events.ticketUrl),
            or(isNull(eventSchemaOrg.id), ne(eventSchemaOrg.status, "available"))
          )
        )
        .limit(max);
    } else if (mode === "existing") {
      // Re-fetch events that already have a successful row (refresh).
      query = db
        .select({ id: events.id })
        .from(events)
        .innerJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(and(isNotNull(events.ticketUrl), eq(eventSchemaOrg.status, "available")))
        .limit(max);
    } else {
      query = db
        .select({ id: events.id })
        .from(events)
        .where(isNotNull(events.ticketUrl))
        .limit(max);
    }

    const rows = await query;
    eventIds = rows.map((r) => r.id);

    if (eventIds.length === 0) {
      return NextResponse.json(
        { error: "no_events_to_sync", mode, message: "query matched zero events" },
        { status: 400 }
      );
    }
  }

  const env = getCloudflareEnv() as unknown as {
    SCHEMA_ORG_SYNC?: { create: (opts: { params: unknown }) => Promise<{ id: string }> };
  };

  if (!env.SCHEMA_ORG_SYNC) {
    return NextResponse.json(
      {
        error: "workflow_unbound",
        message: "SCHEMA_ORG_SYNC binding missing — local dev or misconfigured",
      },
      { status: 503 }
    );
  }

  try {
    const instance = await env.SCHEMA_ORG_SYNC.create({
      params: delayMs !== undefined ? { eventIds, delayMs } : { eventIds },
    });
    return NextResponse.json({ workflowId: instance.id, eventCount: eventIds.length });
  } catch (error) {
    await logError(db, {
      message: "Failed to start schema-org-sync workflow",
      error,
      source: "api/admin/schema-org/sync-workflow/start",
      request,
      context: { eventCount: eventIds.length },
    });
    return NextResponse.json({ error: "workflow_create_failed" }, { status: 500 });
  }
}
