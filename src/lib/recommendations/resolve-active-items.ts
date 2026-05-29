/**
 * Display-time slug-history resolution for active recommendation items.
 *
 * Cross-cutting fix from analyst's 2026-05-29 backlog: even after the
 * scan-time stale-sweep (engine.ts) drops items whose topPagePath
 * points at a no-longer-existent slug, RENAMED-but-live items still
 * carry the pre-rename path in their stored payload. The admin panel
 * surfaced that stale path verbatim — operator clicks it, hits a 301,
 * lands on the right page, but is confused about which URL the
 * recommendation actually attaches to.
 *
 * This helper runs at display time on the already-loaded item list,
 * resolves each gsc_query item's `payload.topPagePath` through the
 * shared `resolveGscPath` (same helper the scanning rules use, so the
 * resolution policy matches), and attaches the resolved path + status
 * back onto the item. The page render layer then prefers the resolved
 * value when present.
 *
 * Performance: one `resolveGscPath` call per gsc_query item. The
 * helper does ≤5 slug-history hops + one canonical-slug existence
 * check; with the recommendations panel typically rendering <100
 * gsc_query items the per-render cost is bounded and amortizes across
 * the 5-min ISR cache on `/admin/analytics`.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import type { ActiveItem } from "./engine";
import { resolveGscPath, type GscPathStatus } from "./resolve-gsc-path";

type Db = DrizzleD1Database<typeof schema>;

export interface ResolvedActiveItem extends ActiveItem {
  /** Path after walking slug-history at render time. Populated for
   *  gsc_query items with a string `payload.topPagePath`; undefined for
   *  everything else (other targetTypes don't store a path). */
  resolvedTopPagePath?: string | null;
  /** Status of the live resolution. `renamed` is the case this whole
   *  helper exists for — the stored path differs from the live one and
   *  the display layer should swap. `live` = no change needed; `stale`
   *  = sweep should have dropped it (defense in depth). */
  resolvedTopPageStatus?: GscPathStatus;
}

export async function resolveActiveItemPaths(
  db: Db,
  items: ActiveItem[]
): Promise<ResolvedActiveItem[]> {
  // Collect the unique set of paths so we don't pay N queries for the
  // same renamed page surfacing under several gsc_query rows.
  const pathsToResolve = new Set<string>();
  for (const item of items) {
    if (item.targetType !== "gsc_query") continue;
    const p =
      item.payload && typeof item.payload.topPagePath === "string"
        ? item.payload.topPagePath
        : null;
    if (p) pathsToResolve.add(p);
  }

  // Empty fast-path — every non-gsc item flows through with no
  // resolution work and no DB round-trips.
  if (pathsToResolve.size === 0) return items as ResolvedActiveItem[];

  const resolutions = new Map<string, { path: string | null; status: GscPathStatus }>();
  await Promise.all(
    [...pathsToResolve].map(async (p) => {
      const r = await resolveGscPath(db, p);
      resolutions.set(p, r);
    })
  );

  return items.map((item) => {
    if (item.targetType !== "gsc_query") return item as ResolvedActiveItem;
    const original =
      item.payload && typeof item.payload.topPagePath === "string"
        ? item.payload.topPagePath
        : null;
    if (!original) return item as ResolvedActiveItem;
    const resolved = resolutions.get(original);
    if (!resolved) return item as ResolvedActiveItem;
    return {
      ...item,
      resolvedTopPagePath: resolved.path,
      resolvedTopPageStatus: resolved.status,
    };
  });
}
