export const dynamic = "force-dynamic";
/**
 * OPE-1620 — POST /api/v1/promoter/events/{external_id}/cancel. Never cancels
 * directly: stages status → CANCELLED (with the optional reason) and raises a
 * `promoter_cancel_request` review flag for an operator.
 */
import { apiError, parseJson, serviceResponse, withPromoterApi } from "@/lib/promoter-api/handler";
import {
  cancelBodySchema,
  decodePathId,
  externalIdSchema,
  zodFieldErrors,
} from "@/lib/promoter-api/fields";
import { cancelEvent } from "@/lib/promoter-api/service";

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
    const parsed = cancelBodySchema.safeParse(json.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    return serviceResponse(
      await cancelEvent(ctx.db, ctx.caller, id.data, parsed.data.reason?.trim() || null)
    );
  });
}
