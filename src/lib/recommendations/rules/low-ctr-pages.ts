// GSC queries that are TRULY winning rank (top 5) but losing the click —
// title/meta-rewrite targets where the SERP snippet is the only lever.
//
// Tightened 2026-05-25 per analyst review: the old rule accepted any
// position ≤10 with ≥10 impressions, which was noise-dominated. Page-1
// CTR baselines: position 1 ~30%, position 5 ~5%, position 9 ~1%, so
// "winning rank battle" only applies to top-5. The impression floor was
// also too low — at 10 impressions, 0 clicks is 0% but it's also 1 click
// away from 10%, statistical noise. Bumped to 50 (the lower bound of the
// analyst's 50-100 range) to keep matches actionable.

import { ScApiError, ScConfigError, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { resolveGscPath } from "../resolve-gsc-path";
import type { ItemMatch, RuleDefinition } from "../engine";

const TOP_5_MAX_POSITION = 5;
const MIN_IMPRESSIONS = 50;
const LOW_CTR_THRESHOLD = 0.01; // 1%

export const lowCtrPagesRule: RuleDefinition = {
  ruleKey: "low_ctr_pages",
  title: "Top-5 queries with low CTR",
  rationaleTemplate:
    "{n} GSC queries are ranking in the top 5 with at least 50 impressions but less than 1% CTR. The page is winning the rank battle but losing the click. Title/meta description rewrites are the highest-leverage fix.",
  severity: "yellow",
  category: "seo",
  // No autoResolve: GSC API failures return [] silently; auto-resolving on
  // empty would clobber valid items during a transient outage.
  async run(db): Promise<ItemMatch[]> {
    const env = getCloudflareEnv() as unknown as ScEnv;
    let queries;
    try {
      const result = await getSiteSearchQueries(env, {
        rowLimit: 500,
        dateRange: { preset: "last_28d" },
      });
      queries = result.queries;
    } catch (e) {
      if (e instanceof ScConfigError || e instanceof ScApiError) return [];
      throw e;
    }

    const matches = queries
      .filter(
        (q) =>
          q.position <= TOP_5_MAX_POSITION &&
          q.impressions >= MIN_IMPRESSIONS &&
          q.ctr < LOW_CTR_THRESHOLD
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 100);

    // Resolve historical GSC paths to live canonical slugs so cards link to
    // the current URL rather than a 301-redirected one. Cheap: at most one
    // slug-history lookup per surfaced match (≤100).
    return await Promise.all(
      matches.map(async (q) => {
        const topPage = q.topPages[0];
        const resolvedPath = await resolveGscPath(db, topPage?.path ?? null);
        return {
          targetType: "gsc_query",
          targetId: q.query.toLowerCase().slice(0, 200),
          payload: {
            query: q.query,
            impressions: q.impressions,
            clicks: q.clicks,
            ctr: Number((q.ctr * 100).toFixed(2)),
            position: Number(q.position.toFixed(1)),
            topPagePath: resolvedPath,
            topPageImpressions: topPage?.impressions ?? null,
          },
        };
      })
    );
  },
};
