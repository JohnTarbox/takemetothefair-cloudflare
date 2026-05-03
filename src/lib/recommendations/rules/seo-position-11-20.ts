/**
 * GSC queries currently ranking just below page 1 (positions 11–20) with
 * impressions but no clicks. These are page-2 queries that title/meta tweaks
 * could push to page 1 — the highest-leverage SEO surface area.
 *
 * Unlike the other rules, this one fetches from Google Search Console rather
 * than D1 directly. The engine's run() signature only takes db, so we pull env
 * via getCloudflareEnv() inside the rule.
 */

import { getCloudflareEnv } from "@/lib/cloudflare";
import { ScApiError, ScConfigError, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import type { ItemMatch, RuleDefinition } from "../engine";

const POSITION_MIN = 11;
const POSITION_MAX = 20;
const MIN_IMPRESSIONS = 10;
const RESULT_LIMIT = 25;

export const seoPosition1120Rule: RuleDefinition = {
  ruleKey: "seo_position_11_20",
  title: "Improve titles/meta for queries on page 2",
  rationaleTemplate:
    "{n} GSC queries are getting impressions but ranking just below page 1 (positions 11–20). Title/meta tweaks could push them up.",
  severity: "yellow",
  category: "seo",
  async run(): Promise<ItemMatch[]> {
    const env = getCloudflareEnv() as unknown as ScEnv;
    let queries;
    try {
      const result = await getSiteSearchQueries(env, {
        rowLimit: 200,
        dateRange: { preset: "last_28d" },
      });
      queries = result.queries;
    } catch (e) {
      // GSC not configured / API failure → no items. We deliberately don't
      // surface this as an error item; the Site Health tab covers GSC config issues.
      if (e instanceof ScConfigError || e instanceof ScApiError) return [];
      throw e;
    }

    const matches = queries
      .filter(
        (q) =>
          q.position >= POSITION_MIN &&
          q.position <= POSITION_MAX &&
          q.impressions >= MIN_IMPRESSIONS &&
          q.clicks === 0
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, RESULT_LIMIT);

    return matches.map((q) => {
      const topPage = q.topPages[0];
      return {
        targetType: "gsc_query",
        // Slugify the query for stable DB id (queries are already short strings).
        targetId: q.query.toLowerCase().slice(0, 200),
        payload: {
          query: q.query,
          impressions: q.impressions,
          position: Number(q.position.toFixed(1)),
          topPagePath: topPage?.path ?? null,
          topPageImpressions: topPage?.impressions ?? null,
        },
      };
    });
  },
};
