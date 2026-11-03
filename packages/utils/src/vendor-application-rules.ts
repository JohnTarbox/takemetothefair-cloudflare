/**
 * OPE-1361 / OPE-1396 (DUP6) — the vendor-joins-event rule, in the one place
 * both deploy artifacts can import.
 *
 * It lived in src/lib/vendor-applications.ts, which the MCP Worker cannot
 * import, so MCP `apply_to_event` (mcp-server/src/tools/vendor.ts) kept its own
 * copy — and that copy accepted TENTATIVE events where the app accepts APPROVED
 * only. The app module re-exports these, and the MCP tool calls them directly.
 *
 * Pure functions on plain values: no drizzle, no schema.
 */

export type RuleRefusal = { ok: false; httpStatus: number; error: string; message?: string };

/**
 * Can this vendor join this event at all? Same checks, same messages, as the
 * session route (`POST /api/vendor/applications`) has always returned.
 */
export function checkEventAcceptsVendor(
  vendor: { commercial: boolean | null },
  event: { status: string; commercialVendorsAllowed: boolean | null }
): { ok: true } | RuleRefusal {
  if (event.status !== "APPROVED") {
    return {
      ok: false,
      httpStatus: 400,
      error: "This event is not currently accepting vendor applications",
    };
  }
  if (vendor.commercial && !event.commercialVendorsAllowed) {
    return {
      ok: false,
      httpStatus: 403,
      error: "This event does not allow commercial vendors. Only non-commercial vendors may apply.",
    };
  }
  return { ok: true };
}

/** Initial status of a new self-submitted application. */
export function defaultApplicationStatus(
  canSelfConfirm: boolean | null | undefined
): "CONFIRMED" | "APPLIED" {
  return canSelfConfirm ? "CONFIRMED" : "APPLIED";
}
