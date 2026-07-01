/**
 * Indexable-vendor enumeration — the single source of truth for "which vendor
 * pages are eligible for the index", shared by the vendors sitemap and the GSC
 * URL-inspection sweep (A10/A11, 2026-06-26).
 *
 * The sweep historically inspected ONLY /events/ URLs, so the 38 persisted
 * `GSC_INSPECTION_NON_OK` rows were all events and the venue/vendor "Crawled /
 * Discovered – currently not indexed" problem (A11) was invisible in our data.
 * Reusing this exact gate (rather than a simplified proxy) keeps the sweep's
 * vendor sample aligned with the sitemap — so we never inspect a vendor page
 * that legitimately emits noindex (which would surface as false-positive noise).
 *
 * The SEO gate is raw SQL because it walks event_vendors → events → venues for
 * the geographic-anchor fallback, which Drizzle's query builder can't express
 * cleanly. `getVendorTier` + `isIndexableTier` apply the same TS-side
 * defense-in-depth the sitemap uses.
 */
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { getVendorTier, isIndexableTier, type VendorTierFields } from "@/lib/vendor-tier";

type Db = DrizzleD1Database<typeof schema>;

export interface IndexableVendorRow {
  slug: string;
  /** seconds-epoch (raw column value), or null. */
  updatedAt: number | null;
  /** OPE-40 — for the crawlable A–Z/by-state browse directory. `state` also
   *  lives in `fields`, but name isn't in the tier fields, so surface both here. */
  businessName: string;
  displayName: string | null;
  fields: VendorTierFields;
  tier: ReturnType<typeof getVendorTier>;
}

/**
 * Return every vendor whose detail page is index-eligible, with its tier-fields
 * + computed tier. Callers map to sitemap URLs or inspection URLs as needed.
 */
export async function getIndexableVendorRows(db: Db): Promise<IndexableVendorRow[]> {
  const rows = await db.all<{
    slug: string;
    updatedAt: number | null;
    businessName: string;
    displayName: string | null;
    description: string | null;
    website: string | null;
    socialLinks: string | null;
    city: string | null;
    state: string | null;
    address: string | null;
    enhancedProfile: number;
    domainHijacked: number;
    eventAssociationCount: number;
    eventVenueGeoCount: number;
  }>(sql`
    SELECT
      v.slug AS slug,
      v.updated_at AS updatedAt,
      v.business_name AS businessName,
      v.display_name AS displayName,
      v.description AS description,
      v.website AS website,
      v.social_links AS socialLinks,
      v.city AS city,
      v.state AS state,
      v.address AS address,
      v.enhanced_profile AS enhancedProfile,
      v.domain_hijacked AS domainHijacked,
      (SELECT COUNT(*) FROM event_vendors ev WHERE ev.vendor_id = v.id) AS eventAssociationCount,
      (
        SELECT COUNT(*) FROM event_vendors ev
        JOIN events e ON ev.event_id = e.id
        JOIN venues vn ON e.venue_id = vn.id
        WHERE ev.vendor_id = v.id
          AND vn.city IS NOT NULL AND vn.city != ''
          AND vn.state IS NOT NULL AND vn.state != ''
      ) AS eventVenueGeoCount
    FROM vendors v
    WHERE v.deleted_at IS NULL
      AND v.domain_hijacked = 0
      AND (
        v.enhanced_profile = 1
        OR (
          v.description IS NOT NULL AND length(trim(v.description)) >= 30
          AND (
            (v.city IS NOT NULL AND v.city != '' AND v.state IS NOT NULL AND v.state != '')
            OR (v.address IS NOT NULL AND v.address != '')
            OR EXISTS (
              SELECT 1 FROM event_vendors ev2
              JOIN events e2 ON ev2.event_id = e2.id
              JOIN venues vn2 ON e2.venue_id = vn2.id
              WHERE ev2.vendor_id = v.id
                AND vn2.city IS NOT NULL AND vn2.city != ''
                AND vn2.state IS NOT NULL AND vn2.state != ''
            )
          )
        )
      )
      -- EH1 Phase 1 — exclude LOCAL_OFFICE rows that resolve to a non-self,
      -- non-both display mode (i.e. canonical-up'd to a parent). The page
      -- still loads, but it emits rel="canonical" + noindex, so including
      -- it in the sitemap would just feed Google duplicate-content signals.
      --
      -- 'both' keeps the office IN the sitemap — that mode renders the
      -- office page as canonical and additionally shows a brand link in
      -- the UI (the brand isn't the canonical, so don't exclude).
      --
      -- Also exclude aliased rows outright (alias_of_vendor_id IS NOT
      -- NULL) — they redirect to canonical and have no standalone surface.
      --
      -- Resolution rule mirrors resolveVendorDisplay() in
      -- src/lib/vendor-hierarchy.ts. Keep these two in lock-step; an
      -- audit query that returns rows where the page noindexes but the
      -- sitemap includes (or vice versa) is the canary for drift.
      AND v.alias_of_vendor_id IS NULL
      AND NOT (
        v.role = 'LOCAL_OFFICE'
        AND (
          -- Override path: gate granted AND child mode picks a non-self
          -- non-both canonical (i.e. canonical-up to brand or operator).
          (v.display_override_permitted = 1
           AND v.display_mode IN ('brand_parent','operator_parent'))
          OR
          -- Inherit path: parent's default picks a non-self non-both
          -- canonical. Default falls through when gate closed OR mode
          -- is NULL OR mode is the explicit 'inherit'.
          ((v.display_override_permitted = 0
            OR v.display_mode IS NULL
            OR v.display_mode = 'inherit')
           AND EXISTS (
             SELECT 1 FROM vendors p
             WHERE p.id = v.brand_parent_vendor_id
               AND p.default_child_display = 'brand_parent'
           ))
        )
      )
      -- EH2.4 (Dev-Email-2026-06-09-EH2.md §B3) — exclude self-mode
      -- brand hubs from the sitemap. The hub page emits noindex,follow
      -- (handled in /vendors/[slug]/page.tsx generateMetadata) and exists
      -- only for direct-link discovery (admin paths, claim flows). The
      -- franchise pages (LOCAL_OFFICE rows) get the SEO surface.
      -- brand_parent-mode hubs STAY in the sitemap because they're the
      -- canonical surface for the brand → office tree.
      AND NOT (
        v.role = 'NATIONAL'
        AND (v.default_child_display = 'self' OR v.default_child_display IS NULL)
      )
  `);

  return (
    rows
      .map((row) => {
        const fields: VendorTierFields = {
          description: row.description,
          website: row.website,
          socialLinks: row.socialLinks,
          city: row.city,
          state: row.state,
          address: row.address,
          enhancedProfile: row.enhancedProfile === 1,
          domainHijacked: row.domainHijacked === 1,
          eventAssociationCount: row.eventAssociationCount,
          eventVenueGeoCount: row.eventVenueGeoCount,
        };
        return { row, fields, tier: getVendorTier(fields) };
      })
      // Defense-in-depth: the SQL gate already excludes non-indexable
      // vendors, but if criteria drift between SQL and TS, the TS check
      // wins so we never emit a row inconsistent with the noindex meta.
      .filter(({ tier }) => isIndexableTier(tier))
      .map(({ row, fields, tier }) => ({
        slug: row.slug,
        updatedAt: row.updatedAt,
        businessName: row.businessName,
        displayName: row.displayName,
        fields,
        tier,
      }))
  );
}
