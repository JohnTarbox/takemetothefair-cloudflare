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
import { resolveGscPath } from "../resolve-gsc-path";
import type { ItemMatch, RuleDefinition } from "../engine";

const POSITION_MIN = 11;
const POSITION_MAX = 20;
// Raised from 10 → 25 per analyst review (2026-05-25): below 20-30
// impressions, zero-click is statistical noise rather than a real signal
// that title rewrites would help.
const MIN_IMPRESSIONS = 25;

export const seoPosition1120Rule: RuleDefinition = {
  ruleKey: "seo_position_11_20",
  title: "Improve titles/meta for queries on page 2",
  rationaleTemplate:
    "{n} GSC queries are getting at least 25 impressions but ranking just below page 1 (positions 11–20). Title/meta tweaks could push them up.",
  severity: "yellow",
  category: "seo",
  // No autoResolve: GSC API failures return [] silently (see catch below);
  // auto-resolving on empty would clobber valid items during a transient outage.
  async run(db): Promise<ItemMatch[]> {
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
      .sort((a, b) => b.impressions - a.impressions);

    // Resolve historical GSC paths to live canonical slugs by walking
    // slug-history. The engine's stale-path filter (canonical-paths.ts)
    // then drops items whose resolved path still doesn't match a current
    // entity — handles the "entity deleted" case. Items whose slug was
    // renamed survive here because resolveGscPath returns the renamed
    // path, which the engine's checker recognizes as live.
    return await Promise.all(
      matches.map(async (q) => {
        const topPage = q.topPages[0];
        const resolution = await resolveGscPath(db, topPage?.path ?? null);
        return {
          targetType: "gsc_query",
          // Slugify the query for stable DB id (queries are already short strings).
          targetId: q.query.toLowerCase().slice(0, 200),
          payload: {
            query: q.query,
            impressions: q.impressions,
            position: Number(q.position.toFixed(1)),
            topPagePath: resolution.path,
            topPagePathStatus: resolution.status,
            topPageImpressions: topPage?.impressions ?? null,
          },
        };
      })
    );
  },
};
