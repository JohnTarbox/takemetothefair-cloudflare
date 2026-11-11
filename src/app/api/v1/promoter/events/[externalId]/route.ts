export const dynamic = "force-dynamic";
/**
 * OPE-1620 — PATCH /api/v1/promoter/events/{external_id}: a partial update to
 * one of this key's promoter's events, staged for review (never written to the
 * live event). 404 when the external_id is unknown for this promoter.
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
    const parsed = patchBodySchema.safeParse(json.value);
    if (!parsed.success)
      return apiError(422, "validation_failed", "Invalid fields.", {
        errors: zodFieldErrors(parsed.error),
      });
    return serviceResponse(await patchEvent(ctx.db, ctx.caller, id.data, toCells(parsed.data)));
  });
}
