export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";
import { PROMOTER_ENRICHMENT_STATUS_VALUES } from "@takemetothefair/constants";

/**
 * GET /api/admin/analytics/promoter-enrichment-coverage
 *
 * OPE-35 Part 3 — promoter-enrichment coverage metric (the promoter analog of
 * roster-coverage). Reports per-field fill rates + the enrichment-status
 * breakdown + the NEEDS_ENRICHMENT queue depth. Auth: admin session OR
 * X-Internal-Key (MCP).
 *
 * Per-field fill is aggregated from the stored `enrichment_coverage` JSON
 * snapshot (written by computePromoterEnrichment on every create/update and
 * seeded by drizzle/0140), so the metric never drifts from the enqueue logic.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();

    const covered = (field: string) =>
      sql<number>`sum(case when json_extract(enrichment_coverage, ${"$." + field}) = 1 then 1 else 0 end)`;

    const [agg] = await db
      .select({
        total: sql<number>`count(*)`,
        withWebsite: sql<number>`sum(case when website is not null and trim(website) <> '' then 1 else 0 end)`,
        hero: covered("hero"),
        logo: covered("logo"),
        description: covered("description"),
        socials: covered("socials"),
        contact: covered("contact"),
      })
      .from(promoters);

    // Status breakdown (NULL = never assessed).
    const statusRows = await db
      .select({ status: promoters.enrichmentStatus, n: sql<number>`count(*)` })
      .from(promoters)
      .groupBy(promoters.enrichmentStatus);
    const byStatus = (s: string | null): number => statusRows.find((r) => r.status === s)?.n ?? 0;

    const total = Number(agg?.total ?? 0);
    const pct = (num: number, den: number): number =>
      den === 0 ? 0 : Math.round((Number(num) / den) * 1000) / 10; // one decimal

    const statusCounts: Record<string, number> = { unassessed: byStatus(null) };
    for (const s of PROMOTER_ENRICHMENT_STATUS_VALUES) statusCounts[s] = byStatus(s);

    return NextResponse.json({
      success: true,
      generatedAt: new Date().toISOString(),
      total,
      withWebsite: Number(agg?.withWebsite ?? 0),
      // Per-field fill rate across all promoters (share whose field is covered).
      coverage: {
        heroPct: pct(agg?.hero ?? 0, total),
        logoPct: pct(agg?.logo ?? 0, total),
        descriptionPct: pct(agg?.description ?? 0, total),
        socialsPct: pct(agg?.socials ?? 0, total),
        contactPct: pct(agg?.contact ?? 0, total),
        counts: {
          hero: Number(agg?.hero ?? 0),
          logo: Number(agg?.logo ?? 0),
          description: Number(agg?.description ?? 0),
          socials: Number(agg?.socials ?? 0),
          contact: Number(agg?.contact ?? 0),
        },
      },
      status: statusCounts,
      // The worklist the enrichment drain agent pulls from.
      queueDepth: byStatus("NEEDS_ENRICHMENT"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
