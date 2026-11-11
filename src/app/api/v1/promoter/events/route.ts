export const dynamic = "force-dynamic";
/**
 * OPE-1620 — the promoter API: signed (HMAC-SHA256, src/lib/promoter-api/auth.ts),
 * one promoter per key. Docs: /help/promoters/api; spec: /api/v1/openapi.json.
 *
 * POST — upsert one event by the promoter's own external_id. New → a PENDING
 *        event for review; known → the changes are staged, the live event is
 *        not written.
 * GET  — this promoter's external_ids with their event status, keyset-paged.
 */
import { NextResponse } from "next/server";
import { parseJson, serviceResponse, apiError, withPromoterApi } from "@/lib/promoter-api/handler";
import { toCells, upsertBodySchema, zodFieldErrors } from "@/lib/promoter-api/fields";
import { listRefs, upsertEvent } from "@/lib/promoter-api/service";

const ROUTE = "/api/v1/promoter/events";

export async function POST(request: Request) {
  return withPromoterApi(request, ROUTE, async ({ db, caller, body }) => {
    const json = parseJson(body, false);
    if (!json.ok) return json.response;
    const parsed = upsertBodySchema.safeParse(json.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    const { external_id, ...fields } = parsed.data;
    return serviceResponse(await upsertEvent(db, caller, external_id, toCells(fields)));
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
