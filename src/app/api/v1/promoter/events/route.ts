export const dynamic = "force-dynamic";
/**
 * OPE-1620 — the promoter API: signed (HMAC-SHA256, src/lib/promoter-api/auth.ts),
 * one promoter per key. Docs: /help/promoters/api; spec: /api/v1/openapi.json.
 *
 * POST — upsert one event by the promoter's own external_id. New → a PENDING
 *        event for review; known → the changes are staged, the live event is
 *        not written. `?dry_run=true` (or `"dry_run": true`) → the report of
 *        what would happen, and nothing written (OPE-1625, dry-run.ts).
 * GET  — this promoter's external_ids with their event status, keyset-paged.
 */
import { NextResponse } from "next/server";
import { parseJson, serviceResponse, apiError, withPromoterApi } from "@/lib/promoter-api/handler";
import { toCells, upsertBodySchema, zodFieldErrors } from "@/lib/promoter-api/fields";
import { listRefs, upsertEvent } from "@/lib/promoter-api/service";
import { dryRunContext, dryRunResponse, readDryRun } from "@/lib/promoter-api/dry-run";

const ROUTE = "/api/v1/promoter/events";

export async function POST(request: Request) {
  return withPromoterApi(request, ROUTE, async ({ db, caller, body }) => {
    const json = parseJson(body, false);
    if (!json.ok) return json.response;
    const dry = readDryRun(request, json.value);
    if (!dry.ok) return dry.response;
    const parsed = upsertBodySchema.safeParse(dry.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    const { external_id, ...fields } = parsed.data;
    const cells = toCells(fields);
    if (dry.dryRun) {
      const d = dryRunContext(db, caller);
      const result = await upsertEvent(d.db, d.caller, external_id, cells);
      return dryRunResponse(d.db, d.caller, external_id, cells, result);
    }
    return serviceResponse(await upsertEvent(db, caller, external_id, cells));
  });
}

export async function GET(request: Request) {
  return withPromoterApi(request, ROUTE, async ({ db, caller }) => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const cursor = url.searchParams.get("cursor");
    return NextResponse.json(await listRefs(db, caller.promoterId, { limit, cursor }));
  });
}
