// Cannibalization: GSC queries where the top-ranking page on our site is a
// state hub (e.g. /events/massachusetts) but the query string matches an
// individual entity's name (an event/venue/vendor). Per §3.5 of the doc:
// query "bolton fair" ranking the state hub instead of the dedicated
// event page is a self-cannibalization that hurts both.
//
// Detection: pull GSC queries with their topPages, check if the top page
// is a state hub URL, then check if the query string matches any entity
// name in our DB. If yes, the entity has its own page that should be
// outranking the hub.

import { and, isNotNull, isNull } from "drizzle-orm";
import { events, vendors, venues } from "@/lib/db/schema";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { ScApiError, ScConfigError, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import type { ItemMatch, RuleDefinition } from "../engine";
import { resolveGscPath } from "../resolve-gsc-path";

// Hub URL patterns that should NOT outrank dedicated entity pages on
// entity-specific queries.
const HUB_PATH_PATTERNS = [
  /^\/events\/(?:maine|vermont|new-hampshire|massachusetts|connecticut|rhode-island)$/,
  /^\/events\/(?:fairs|festivals|craft-shows|craft-fairs|markets|farmers-markets)$/,
  /^\/vendors$/,
  /^\/venues$/,
];

const MIN_IMPRESSIONS = 5;

export const cannibalizationDetectionRule: RuleDefinition = {
  ruleKey: "cannibalization_detection",
  title: "State/category hub outranks dedicated entity page on entity-specific queries",
  rationaleTemplate:
    "{n} queries where a state or category hub page is outranking a dedicated event/vendor/venue page. The entity page should win the click. Investigate internal linking, hub page over-optimization, or the entity page's title/meta.",
  severity: "yellow",
  category: "seo",
  // No autoResolve: GSC API failures return [] silently.
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

    // Pre-filter to queries with hub topPages and enough impressions to
    // matter. This narrows the cohort before doing DB lookups.
    const hubQueries = queries.filter((q) => {
      if (q.impressions < MIN_IMPRESSIONS) return false;
      const topPath = q.topPages[0]?.path;
      if (!topPath) return false;
      return HUB_PATH_PATTERNS.some((re) => re.test(topPath));
    });

    if (hubQueries.length === 0) return [];

    // For each candidate query, check if any entity name matches. Use a
    // single bulk fetch of all entity names rather than N queries.
    const [eventRows, vendorRows, venueRows] = await Promise.all([
      db
        .select({ id: events.id, name: events.name, slug: events.slug })
        .from(events)
        .where(isNotNull(events.name)),
      db
        .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
        .from(vendors)
        .where(and(isNotNull(vendors.businessName), isNull(vendors.deletedAt))),
      db.select({ id: venues.id, name: venues.name, slug: venues.slug }).from(venues),
    ]);

    type Entity = { id: string; name: string; slug: string; type: "event" | "vendor" | "venue" };
    const allEntities: Entity[] = [
      ...eventRows.map((r) => ({ ...r, type: "event" as const })),
      ...vendorRows.map((r) => ({ ...r, type: "vendor" as const })),
      ...venueRows.map((r) => ({ ...r, type: "venue" as const })),
    ];

    // Index by lowercased name for O(1) lookup. Matches are exact (case-
    // insensitive) — fuzzy match would be too noisy.
    const byName = new Map<string, Entity>();
    for (const e of allEntities) {
      byName.set(e.name.toLowerCase(), e);
    }

    // A3 (2026-06-04): resolve historical GSC paths to current canonical
    // slugs before emitting. Mirrors low-ctr-pages / seo-position-11-20
    // (both use the same `resolveGscPath` + `topPagePath`+`topPagePathStatus`
    // payload shape). The engine's stale-path filter at canonical-paths.ts
    // then drops items whose resolved topPagePath classifies as "stale" —
    // protects against the case where GSC is still attributing impressions
    // to an outranking hub that no longer matches the live URL set.
    const matches: ItemMatch[] = [];
    for (const q of hubQueries) {
      const queryLower = q.query.toLowerCase().trim();
      const entity = byName.get(queryLower);
      if (!entity) continue;
      const resolution = await resolveGscPath(db, q.topPages[0]?.path ?? null);
      // Stable id: query string (so refreshes update the same row)
      matches.push({
        targetType: "gsc_query",
        targetId: queryLower.slice(0, 200),
        payload: {
          query: q.query,
          // Use `topPagePath` (not the old `hubPath` key) so the engine's
          // stale-path filter picks this up identically to other GSC rules.
          topPagePath: resolution.path,
          topPagePathStatus: resolution.status,
          impressions: q.impressions,
          position: Number(q.position.toFixed(1)),
          entityType: entity.type,
          entityName: entity.name,
          entitySlug: entity.slug,
          entityPath: `/${entity.type === "event" ? "events" : entity.type === "vendor" ? "vendors" : "venues"}/${entity.slug}`,
        },
      });
    }

    return matches;
  },
};
