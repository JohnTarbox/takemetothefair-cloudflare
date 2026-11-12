export const dynamic = "force-dynamic";
/**
 * OPE-1620 — POST /api/v1/promoter/events/{external_id}/cancel. Never cancels
 * directly: stages status → CANCELLED (with the optional reason) and raises a
 * `promoter_cancel_request` review flag for an operator.
 * `?dry_run=true` / `"dry_run": true` → the report, nothing written (OPE-1625).
 */
import { apiError, parseJson, serviceResponse, withPromoterApi } from "@/lib/promoter-api/handler";
import {
  cancelBodySchema,
  decodePathId,
  externalIdSchema,
  zodFieldErrors,
} from "@/lib/promoter-api/fields";
import { cancelEvent } from "@/lib/promoter-api/service";
import { dryRunContext, dryRunResponse, readDryRun } from "@/lib/promoter-api/dry-run";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  const { externalId } = await params;
  return withPromoterApi(request, "/api/v1/promoter/events/[externalId]/cancel", async (ctx) => {
    const id = externalIdSchema.safeParse(decodePathId(externalId));
    if (!id.success)
      return apiError(422, "validation_failed", "Invalid external_id.", {
        errors: zodFieldErrors(id.error).map((e) => ({ ...e, field: "external_id" })),
      });
    const json = parseJson(ctx.body, true);
    if (!json.ok) return json.response;
    const dry = readDryRun(request, json.value, ctx.caller);
    if (!dry.ok) return dry.response;
    const parsed = cancelBodySchema.safeParse(dry.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    const reason = parsed.data.reason?.trim() || null;
    if (dry.dryRun) {
      const d = dryRunContext(ctx.db, ctx.caller);
      const result = await cancelEvent(d.db, d.caller, id.data, reason);
      return dryRunResponse(d.db, d.caller, id.data, {}, result, { partial: true });
    }
    return serviceResponse(await cancelEvent(ctx.db, ctx.caller, id.data, reason));
  });
}
