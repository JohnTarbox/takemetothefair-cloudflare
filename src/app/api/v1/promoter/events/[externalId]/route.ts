export const dynamic = "force-dynamic";
/**
 * OPE-1620 — PATCH /api/v1/promoter/events/{external_id}: a partial update to
 * one of this key's promoter's events, staged for review (never written to the
 * live event). 404 when the external_id is unknown for this promoter.
 * `?dry_run=true` / `"dry_run": true` → the report, nothing written (OPE-1625).
 */
import { apiError, parseJson, serviceResponse, withPromoterApi } from "@/lib/promoter-api/handler";
import {
  decodePathId,
  externalIdSchema,
  patchBodySchema,
  toCells,
  zodFieldErrors,
} from "@/lib/promoter-api/fields";
import { patchEvent } from "@/lib/promoter-api/service";
import { dryRunContext, dryRunResponse, readDryRun } from "@/lib/promoter-api/dry-run";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  const { externalId } = await params;
  return withPromoterApi(request, "/api/v1/promoter/events/[externalId]", async (ctx) => {
    const id = externalIdSchema.safeParse(decodePathId(externalId));
    if (!id.success)
      return apiError(422, "validation_failed", "Invalid external_id.", {
        errors: zodFieldErrors(id.error).map((e) => ({ ...e, field: "external_id" })),
      });
    const json = parseJson(ctx.body, false);
    if (!json.ok) return json.response;
    const dry = readDryRun(request, json.value);
    if (!dry.ok) return dry.response;
    const parsed = patchBodySchema.safeParse(dry.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    const cells = toCells(parsed.data);
    if (dry.dryRun) {
      const d = dryRunContext(ctx.db, ctx.caller);
      const result = await patchEvent(d.db, d.caller, id.data, cells);
      return dryRunResponse(d.db, d.caller, id.data, cells, result, { partial: true });
    }
    return serviceResponse(await patchEvent(ctx.db, ctx.caller, id.data, cells));
  });
}
