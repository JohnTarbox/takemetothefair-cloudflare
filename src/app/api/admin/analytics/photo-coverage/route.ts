export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { imageCoverageState } from "@/lib/db/schema";
import {
  rankImagelessByDemand,
  summarizeCoverage,
  type CoverageStateRow,
  type PhotoEntityType,
} from "@/lib/photo-coverage/model";

/**
 * GET /api/admin/analytics/photo-coverage   (OPE-225)
 *
 * The photo analog of roster-coverage / promoter-enrichment-coverage: image
 * coverage per entity type, **sliced by demand tier**, plus the demand-ranked
 * imageless backlog and URL-health counts. Auth: admin session OR X-Internal-Key.
 *
 * Reads only `image_coverage_state`, never the entity tables, so the metric and
 * the queue can never disagree about what "has an image" means — they are the
 * same rows. The state table is refreshed by the one scan writer.
 *
 * ?limit=N caps the returned backlog (default 25, max 200). The tier rollups
 * always cover every row regardless of the limit — truncating the backlog must
 * not silently shrink the headline numbers.
 */
const DEFAULT_QUEUE_LIMIT = 25;
const MAX_QUEUE_LIMIT = 200;

export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || DEFAULT_QUEUE_LIMIT, 1),
    MAX_QUEUE_LIMIT
  );

  const db = getCloudflareDb();
  const stored = await db.select().from(imageCoverageState);

  const rows: CoverageStateRow[] = stored.map((r) => ({
    entityType: r.entityType as PhotoEntityType,
    entityId: r.entityId,
    hasImage: r.hasImage,
    imageUrl: r.imageUrl,
    urlHealth: r.urlHealth,
    imageSetAt: r.imageSetAt,
    baselineHadImage: r.baselineHadImage,
    firstSeenAt: r.firstSeenAt,
    demandImpressions: r.demandImpressions,
    demandTier: r.demandTier,
    checkedAt: r.checkedAt,
    urlCheckedAt: r.urlCheckedAt,
    urlStatusCode: r.urlStatusCode,
  }));

  const slugById = new Map(stored.map((r) => [`${r.entityType}:${r.entityId}`, r.slug]));

  // The freshest checked_at IS the scan's liveness signal (same value the
  // heartbeat probe reads). Surfacing it here means a consumer of this endpoint
  // can tell "coverage is 46%" from "coverage was 46% before the scan died".
  const lastScanAt = rows.reduce<Date | null>(
    (max, r) => (max == null || r.checkedAt > max ? r.checkedAt : max),
    null
  );

  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    lastScanAt: lastScanAt?.toISOString() ?? null,
    scannedEntities: rows.length,
    byEntity: summarizeCoverage(rows),
    urlHealth: {
      owned: rows.filter((r) => r.urlHealth === "OWNED").length,
      hotlinked: rows.filter((r) => r.urlHealth === "HOTLINKED").length,
      missing: rows.filter((r) => r.urlHealth === "MISSING").length,
      unreachable: rows.filter((r) => r.urlHealth === "UNREACHABLE").length,
    },
    imagelessByDemand: rankImagelessByDemand(rows, limit).map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
      slug: slugById.get(`${r.entityType}:${r.entityId}`) ?? null,
      demandImpressions: r.demandImpressions,
      demandTier: r.demandTier,
    })),
  });
}
