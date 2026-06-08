/**
 * Cluster view for GSC URLs stuck in non-indexed states (analyst A3).
 *
 * Before this page, the operator's only view of "Discovered – currently
 * not indexed" rows was 39 separate rows in GSC's own UI — visually
 * identical regardless of whether they were 39 unrelated pages or one
 * VT-farmers-market cluster needing one pillar post + bulk
 * request_indexing. This page rolls them up into actionable buckets:
 *
 *   1. Entity-type bucket (events / vendors / venues / promoters / blog
 *      / listing pages) — different content types need different
 *      remediation. Events have date-window quality signals; vendors
 *      need profile completeness; listing pages need internal links.
 *
 *   2. For events: sub-cluster by state_code resolved from the slug
 *      via a JOIN against `events`. Renamed-slug rows surface as
 *      "(unknown state)" — usually a slug-history hit; flagged
 *      separately so the operator can fix the redirect.
 *
 *   3. Within each bucket: coverageState distribution
 *      (discovered_not_indexed / crawled_not_indexed / unknown).
 *
 * Server component, edge runtime, no client interactivity. Same
 * pattern as /admin/source-quality + /admin/blog.
 */

import { inArray, notInArray } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, gscInspectionState } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  classifyIndexState,
  classifyUrlBucket,
  extractDetailSlug,
  type EntityBucket,
  type IndexState,
} from "@/lib/gsc-index-state";
import { unsafeSlug } from "@/lib/utils";

export const runtime = "edge";
export const revalidate = 300;

interface ClusterRow {
  bucket: EntityBucket;
  /** Sub-cluster key: for events this is the state code; for everything
   *  else, the literal "—". Lets one render path serve both. */
  subkey: string;
  totalUrls: number;
  discoveredNotIndexed: number;
  crawledNotIndexed: number;
  unknown: number;
  sampleUrls: string[]; // First 5 (or so) URLs in this cluster
}

const BUCKET_LABEL: Record<EntityBucket, string> = {
  event: "Event detail",
  vendor: "Vendor detail",
  venue: "Venue detail",
  promoter: "Promoter detail",
  blog: "Blog post",
  event_listing: "Event listing",
  vendor_listing: "Vendor listing",
  venue_listing: "Venue listing",
  blog_listing: "Blog listing",
  other: "Other",
};

/** Sort order used everywhere we render bucket rows — keeps the most
 *  actionable bucket (event detail; usually the largest stuck cohort)
 *  at the top, with low-volume buckets at the bottom. */
const BUCKET_ORDER: EntityBucket[] = [
  "event",
  "vendor",
  "venue",
  "promoter",
  "blog",
  "event_listing",
  "vendor_listing",
  "venue_listing",
  "blog_listing",
  "other",
];

async function loadClusters(): Promise<{
  clusters: ClusterRow[];
  totalRows: number;
  totalStuckRows: number;
}> {
  const db = getCloudflareDb();

  // Pull every non-indexed inspection row. We intentionally include
  // `unknown` so the operator sees the long tail of "we tried but
  // GSC came back blank" rows — those often mean the URL hasn't been
  // crawled yet (early-stage funnel) and we want them visible alongside
  // the genuinely-stuck cohort.
  //
  // Filtering at the DB layer rather than in JS: cheap, the table is
  // small (~2k rows at current corpus size) but bounded growth is
  // unbounded so let's index-assist now.
  const inspectionRows = await db
    .select({
      url: gscInspectionState.url,
      lastVerdict: gscInspectionState.lastVerdict,
      lastCoverageState: gscInspectionState.lastCoverageState,
    })
    .from(gscInspectionState)
    .where(notInArray(gscInspectionState.lastVerdict, ["PASS", "SUCCESS"]));

  const totalRowsRes = await db.select({ url: gscInspectionState.url }).from(gscInspectionState);

  // Phase 1: classify + index state. Collect detail-event slugs so we
  // can resolve state codes in one batch.
  type Classified = {
    url: string;
    bucket: EntityBucket;
    indexState: IndexState;
    detailSlug: string | null;
  };
  const classified: Classified[] = inspectionRows
    .map((r) => {
      const bucket = classifyUrlBucket(r.url);
      const indexState = classifyIndexState(r.lastVerdict, r.lastCoverageState);
      return {
        url: r.url,
        bucket,
        indexState,
        detailSlug: extractDetailSlug(r.url, bucket),
      };
    })
    // Drop indexed (verdict was non-PASS but coverageState read as
    // indexed — the bucket exists, just not actionable here).
    .filter((c) => c.indexState !== "indexed");

  // Phase 2: state resolution for event detail URLs. One IN-list
  // against `events.slug` covers the whole batch.
  const eventSlugs = classified
    .filter((c) => c.bucket === "event" && c.detailSlug)
    .map((c) => unsafeSlug(c.detailSlug!));

  const stateBySlug = new Map<string, string | null>();
  if (eventSlugs.length > 0) {
    const eventStateRows = await db
      .select({ slug: events.slug, stateCode: events.stateCode })
      .from(events)
      .where(inArray(events.slug, eventSlugs));
    for (const r of eventStateRows) {
      stateBySlug.set(r.slug, r.stateCode);
    }
  }

  // Phase 3: cluster. Key by (bucket, subkey).
  const buckets = new Map<string, ClusterRow>();
  for (const c of classified) {
    let subkey = "—";
    if (c.bucket === "event" && c.detailSlug) {
      const state = stateBySlug.get(c.detailSlug);
      subkey = state ?? "(unknown state)";
    }
    const key = `${c.bucket}|${subkey}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.totalUrls++;
      if (c.indexState === "discovered_not_indexed") existing.discoveredNotIndexed++;
      else if (c.indexState === "crawled_not_indexed") existing.crawledNotIndexed++;
      else existing.unknown++;
      if (existing.sampleUrls.length < 5) existing.sampleUrls.push(c.url);
    } else {
      buckets.set(key, {
        bucket: c.bucket,
        subkey,
        totalUrls: 1,
        discoveredNotIndexed: c.indexState === "discovered_not_indexed" ? 1 : 0,
        crawledNotIndexed: c.indexState === "crawled_not_indexed" ? 1 : 0,
        unknown: c.indexState === "unknown" ? 1 : 0,
        sampleUrls: [c.url],
      });
    }
  }

  // Sort by bucket order, then by totalUrls desc within bucket.
  const bucketRank = new Map(BUCKET_ORDER.map((b, i) => [b, i]));
  const clusters = [...buckets.values()].sort((a, b) => {
    const ra = bucketRank.get(a.bucket) ?? 999;
    const rb = bucketRank.get(b.bucket) ?? 999;
    if (ra !== rb) return ra - rb;
    if (a.totalUrls !== b.totalUrls) return b.totalUrls - a.totalUrls;
    return a.subkey.localeCompare(b.subkey);
  });

  return {
    clusters,
    totalRows: totalRowsRes.length,
    totalStuckRows: classified.length,
  };
}

function bucketLabel(b: EntityBucket): string {
  return BUCKET_LABEL[b] ?? b;
}

export default async function StuckUrlsPage() {
  const { clusters, totalRows, totalStuckRows } = await loadClusters();
  const indexedRows = totalRows - totalStuckRows;
  const indexedPct = totalRows > 0 ? Math.round((indexedRows / totalRows) * 1000) / 10 : 0;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Stuck URLs (GSC index state)</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Clusters of URLs the URL-Inspection sweep marked non-indexed, grouped by entity type and
          (for events) state. The point: turn a list of 39 separate &quot;Discovered – currently not
          indexed&quot; rows into a worked list of 3–4 action targets (one pillar post + bulk{" "}
          <code>request_indexing</code>). Pulls from <code>gsc_inspection_state</code>.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Inspected URLs" value={totalRows} />
        <Stat label="Indexed" value={indexedRows} suffix={` (${indexedPct}%)`} accent="green" />
        <Stat label="Not indexed" value={totalStuckRows} accent="red" />
        <Stat label="Clusters" value={clusters.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Clusters</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {clusters.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing stuck. Run the URL Inspection sweep from /admin/analytics → Site Health to
              refresh.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {clusters.map((c) => (
                <li key={`${c.bucket}|${c.subkey}`} className="p-4">
                  <div className="flex items-baseline justify-between gap-4 flex-wrap">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {bucketLabel(c.bucket)}
                      </span>
                      {c.subkey !== "—" && (
                        <span className="text-xs text-muted-foreground font-mono">{c.subkey}</span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-3 text-xs">
                      {c.discoveredNotIndexed > 0 && (
                        <Badge
                          label={`${c.discoveredNotIndexed} discovered`}
                          cls="bg-red-50 text-red-800 border-red-200"
                        />
                      )}
                      {c.crawledNotIndexed > 0 && (
                        <Badge
                          label={`${c.crawledNotIndexed} crawled`}
                          cls="bg-amber-50 text-amber-800 border-amber-200"
                        />
                      )}
                      {c.unknown > 0 && (
                        <Badge
                          label={`${c.unknown} unknown`}
                          cls="bg-muted text-muted-foreground border-border"
                        />
                      )}
                      <span className="text-sm font-medium text-foreground tabular-nums">
                        {c.totalUrls} URLs
                      </span>
                    </div>
                  </div>
                  {c.sampleUrls.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs">
                      {c.sampleUrls.map((u) => {
                        let path = u;
                        try {
                          path = new URL(u).pathname;
                        } catch {
                          // leave as-is
                        }
                        return (
                          <li key={u} className="font-mono text-muted-foreground truncate">
                            <a
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-royal hover:underline"
                            >
                              {path}
                            </a>
                          </li>
                        );
                      })}
                      {c.totalUrls > c.sampleUrls.length && (
                        <li className="text-muted-foreground">
                          + {c.totalUrls - c.sampleUrls.length} more
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Use MCP <code>request_indexing</code> for high-value individual URLs. Clusters of{" "}
        <span className="text-red-700">discovered, not indexed</span> usually indicate a missing
        pillar post; clusters of <span className="text-amber-700">crawled, not indexed</span>{" "}
        indicate content-quality signals from Google&apos;s side and respond better to rewriting the
        page than to nudging the crawler.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: number;
  suffix?: string;
  accent?: "green" | "red";
}) {
  const cls =
    accent === "green" ? "text-green-700" : accent === "red" ? "text-red-700" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>
          {value}
          {suffix && <span className="text-xs ml-1">{suffix}</span>}
        </p>
      </CardContent>
    </Card>
  );
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}
