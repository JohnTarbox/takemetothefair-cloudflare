/**
 * OPE-716 — the visibility half of the public event↔vendor boundary, in one
 * place both deploy artifacts can import.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * OPE-316 added `event_vendors.public_visible` so a participation can be
 * RECORDED but not SHOWN — the LeafFilter case. The app got the guard
 * (`isPubliclyVisibleVendorLink` in `src/lib/vendor-status.ts`). The MCP
 * `list_event_vendors` tool did not: it filtered status and soft-deletes and
 * never looked at the flag.
 *
 * So a caller could set `public_visible=false`, get `ok`, and still see the
 * vendor in the public listing. Confirmed on prod 2026-09-01 — the LeafFilter
 * link on Marshfield Fair reads `public_visible = 0` in `event_vendors`, so the
 * WRITE applied and the READER was the defect.
 *
 * The failure is invisible from the caller's side: the call succeeds, and the
 * only way to notice is to read back and specifically look for a row you
 * expected to be gone. Every prior use of the flag through this tool has been
 * ineffective.
 *
 * ── Why this lives here and is only HALF the predicate ────────────────────
 *
 * The app's `isPubliclyVisibleVendorLink()` is `status IN (...) AND
 * public_visible`, and its status half needs `PUBLIC_VENDOR_STATUSES` from
 * `@takemetothefair/constants` — a dependency this package deliberately does
 * not take. Both artifacts already have their own status filter and both had it
 * right; the flag is the half that was missing from one of them. So this
 * exports exactly that half, and each caller composes it with the status filter
 * it already has.
 *
 * `public_visible` is `NOT NULL DEFAULT true`, so there is no NULL trap here and
 * no COALESCE is needed — unlike the nullable columns elsewhere in this package.
 */
import { eq, type SQL } from "drizzle-orm";
import { eventVendors } from "./index";

/**
 * "Did this vendor ask not to be shown?" — the OPE-316 flag, as a predicate.
 *
 * ⚠️ ONLY for surfaces an anonymous visitor reaches, including schema.org
 * emission: a hidden link leaking into JSON-LD is still a leak, and a less
 * visible one. Admin roster views, coverage stats and analytics must NOT use
 * it — a hidden link still counts where the operator needs to see it. That
 * asymmetry is the entire point of the flag.
 */
export function vendorLinkIsPublicallyVisible(): SQL {
  return eq(eventVendors.publicVisible, true);
}
