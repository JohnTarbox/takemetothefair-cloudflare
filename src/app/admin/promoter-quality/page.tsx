/**
 * Per-promoter quality dashboard — analyst J5 (2026-05-29 PM).
 *
 * Structural fork of /admin/source-quality (PR #252): same Stat /
 * ConcernBadge components, same JS-side merge pattern, same edge-runtime
 * + 5-min ISR cache. Differences:
 *
 *   GROUP BY     promoter_id (not source_domain + ingestion_method)
 *   Concerns     rejected + cancelled (from lifecycleStatus) + gate_flagged
 *                + drift + imageless
 *   Lifecycle    CANCELLED + POSTPONED rates (new dimension; source-
 *                quality has no equivalent because sources don't have
 *                lifecycle states)
 *   Tier         explicit T1 / T2 / T3 classification, not implicit via
 *                concern %. Sets up tier-aware auto-approval as the
 *                analyst-noted downstream payoff.
 *
 * Tier classification is per-promoter so a downstream auto-approval
 * pipeline can read promoter.tier=T1 → auto-approve without admin
 * review, T2 → admin reviews, T3 → admin reviews + extra scrutiny.
 * This page just surfaces the tier in v1; tier-aware approval is a
 * separate follow-up that touches the suggest-event submit pipeline.
 */

import { requireAdmin } from "@/lib/require-admin";
import { MIN_EVENTS_FOR_TIER } from "@/lib/admin-list/promoter-quality";
import { PromoterQualityTable } from "./promoter-quality-table";

export const dynamic = "force-dynamic";

export default async function PromoterQualityPage() {
  await requireAdmin();

  return (
    <div className="max-w-7xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Per-promoter quality</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reliability metrics grouped by promoter. Composite concern % combines rejection,
          cancellation (post-approval lifecycle), postponement, gate-flag, and unresolved-drift
          rates. Tier classification gates downstream auto-approval scrutiny — T1 = clean, T2 =
          watch, T3 = risky. Forked from <code>/admin/source-quality</code> (PR #252) per analyst J5
          (2026-05-29 PM).
        </p>
      </header>

      <PromoterQualityTable />

      <p className="text-xs text-muted-foreground">
        Concern % = (rejected + cancelled + postponed + gate-flagged + unresolved-drift) / total.
        Tier thresholds: T1 &lt; 10%, T2 10–25%, T3 ≥ 25%. Promoters with fewer than{" "}
        {MIN_EVENTS_FOR_TIER} events default to T2 (insufficient signal). Imageless rate shown
        separately — it&apos;s a coverage gap, not a quality flag.
      </p>
    </div>
  );
}
