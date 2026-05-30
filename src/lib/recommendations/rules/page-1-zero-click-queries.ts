// Page-1 zero-click queries: GSC queries that rank on page 1 but get
// zero clicks despite real impressions. Complement to low_ctr_pages.
//
// low_ctr_pages catches "winning rank, low CTR" (1%+ but below baseline)
// — title/meta rewrites help there because the SERP snippet IS getting
// clicks, just not enough. THIS rule catches the harsher failure mode:
// position ≤ 10 but ZERO clicks despite ≥ 10 impressions. The snippet
// is invisible enough that Google's CTR baselines completely fail to
// trigger, meaning the title + meta-description need a fundamental
// rethink, not a tweak.
//
// Analyst Item 2 (Phase 2 spec, surfaced 2026-05-30):
// - Site CTR KPI flags RED when site-wide CTR < 2%. Current action-queue
//   guidance is "rewrite event title/description template" — correct but
//   abstract. This rule + the Opportunities feed converts the abstract
//   objective into specific URLs the operator can rewrite Monday.

import { ScApiError, ScConfigError, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { resolveGscPath } from "../resolve-gsc-path";
import type { ItemMatch, RuleDefinition } from "../engine";

const PAGE_1_MAX_POSITION = 10;
const MIN_IMPRESSIONS_ZERO_CLICK = 10;
const MAX_MATCHES = 50;

export const page1ZeroClickQueriesRule: RuleDefinition = {
  ruleKey: "page_1_zero_click_queries",
  title: "Page-1 queries getting zero clicks",
  rationaleTemplate:
    "{n} GSC queries are ranking on page 1 (position ≤ 10) with at least 10 impressions but zero clicks. The SERP snippet is invisible enough that Google's CTR baselines completely fail to trigger — title + meta-description need a fundamental rewrite, not a tweak.",
  severity: "yellow",
  category: "seo",
  // No autoResolve — GSC API failures return [] silently; auto-resolving
  // on empty would clobber valid items during a transient outage.
  // Mirrors low-ctr-pages handling.
  async run(db): Promise<ItemMatch[]> {
    const env = getCloudflareEnv() as unknown as ScEnv;
    let queries;
    try {
      const result = await getSiteSearchQueries(env, {
        rowLimit: 500,
        // Analyst spec calls for 7-day window. Differs from low_ctr_pages
        // (28d) — zero-click is a sharper signal that benefits from a
        // tighter window so we catch recent regressions instead of
        // queries that have always been bad.
        dateRange: { preset: "last_7d" },
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
          q.clicks === 0 &&
          q.impressions >= MIN_IMPRESSIONS_ZERO_CLICK
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, MAX_MATCHES);

    // Same slug-history resolution as low_ctr_pages: GSC reports
    // historical paths that may lag behind renames. resolveGscPath
    // walks slug-history and falls through to "stale" for slugs that
    // no longer exist (engine then drops those).
    return await Promise.all(
      matches.map(async (q) => {
        const topPage = q.topPages[0];
        const resolution = await resolveGscPath(db, topPage?.path ?? null);
        return {
          targetType: "gsc_query",
          targetId: q.query.toLowerCase().slice(0, 200),
          payload: {
            query: q.query,
            impressions: q.impressions,
            clicks: q.clicks,
            // ctr is always 0 for this rule by definition, but include it
            // for symmetry with low_ctr_pages so any downstream UI that
            // reads `payload.ctr` doesn't have to special-case.
            ctr: 0,
            position: Number(q.position.toFixed(1)),
            topPagePath: resolution.path,
            topPagePathStatus: resolution.status,
            topPageImpressions: topPage?.impressions ?? null,
            // Suggested action stored on the row so the Opportunities
            // feed (also Item 2) can render the "what to do" copy
            // without re-deriving it per row. Tier-3 SEO rules get a
            // standard rewrite-the-snippet hint.
            suggestedAction: "Rewrite title and meta description",
          },
        };
      })
    );
  },
};
