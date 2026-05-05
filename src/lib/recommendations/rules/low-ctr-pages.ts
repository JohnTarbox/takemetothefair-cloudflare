// GSC queries that ARE ranking on page 1 (positions 1-10) but getting low
// CTR (<1%) despite enough impressions to be statistically meaningful.
// These are the highest-leverage title/meta-rewrite targets — we're already
// being shown to searchers; we just need a more compelling SERP snippet
// to win the click. Per §10.4 of the SEO strategy doc.
//
// Distinct from page_2_close_calls (positions 11-20, where the issue is
// ranking, not click-through). Distinct from seoPosition1120Rule which
// targets queries with zero clicks specifically; this rule targets the
// "appearing but underclicking" cohort across all of page 1.

import { getCloudflareEnv } from "@/lib/cloudflare";
import { ScApiError, ScConfigError, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import type { ItemMatch, RuleDefinition } from "../engine";

const PAGE_1_MAX_POSITION = 10;
const MIN_IMPRESSIONS = 10;
const LOW_CTR_THRESHOLD = 0.01; // 1%

export const lowCtrPagesRule: RuleDefinition = {
  ruleKey: "low_ctr_pages",
  title: "Page-1 queries with low CTR",
  rationaleTemplate:
    "{n} GSC queries are ranking on page 1 with at least 10 impressions but less than 1% CTR. The page is winning the rank battle but losing the click. Title/meta description rewrites are the highest-leverage fix.",
  severity: "yellow",
  category: "seo",
  // No autoResolve: GSC API failures return [] silently; auto-resolving on
  // empty would clobber valid items during a transient outage.
  async run(): Promise<ItemMatch[]> {
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
          q.position <= PAGE_1_MAX_POSITION &&
          q.impressions >= MIN_IMPRESSIONS &&
          q.ctr < LOW_CTR_THRESHOLD
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 100);

    return matches.map((q) => {
      const topPage = q.topPages[0];
      return {
        targetType: "gsc_query",
        targetId: q.query.toLowerCase().slice(0, 200),
        payload: {
          query: q.query,
          impressions: q.impressions,
          clicks: q.clicks,
          ctr: Number((q.ctr * 100).toFixed(2)),
          position: Number(q.position.toFixed(1)),
          topPagePath: topPage?.path ?? null,
          topPageImpressions: topPage?.impressions ?? null,
        },
      };
    });
  },
};
