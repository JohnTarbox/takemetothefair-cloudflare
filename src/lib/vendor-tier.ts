// Four-tier vendor display model from the SEO strategy doc §6.6.
// Single source of truth for tier classification — sitemap, vendor page
// render, badges, recommendations rules, and completeness checklist must
// all derive from getVendorTier().
//
// Decoupling principle: a vendor's tier is computed from current data; it
// is not a column. Graduation/demotion is automatic when the underlying
// fields change. This keeps ingestion aggressive (everything gets a row)
// and SEO conservative (only STANDARD+ENHANCED reach search engines).

import { parseVendorSocialLinks } from "@/lib/vendor-social";

export type VendorTier = "MENTION" | "STUB" | "STANDARD" | "ENHANCED";

export interface VendorTierFields {
  description?: string | null;
  website?: string | null;
  socialLinks?: string | Record<string, string> | null;
  city?: string | null;
  state?: string | null;
  enhancedProfile?: boolean | null;
  // Optional. When omitted, treated as 0 (no event association → MENTION
  // when STANDARD criteria fail, STUB if not applicable here).
  eventAssociationCount?: number;
}

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function meetsStandardCriteria(v: VendorTierFields): boolean {
  const hasDescription = nonEmpty(v.description);
  const hasOwnLocation = nonEmpty(v.city) && nonEmpty(v.state);
  const hasExternalSignal =
    nonEmpty(v.website) || Object.keys(parseVendorSocialLinks(v.socialLinks)).length > 0;
  return hasDescription && hasOwnLocation && hasExternalSignal;
}

export function getVendorTier(v: VendorTierFields): VendorTier {
  if (v.enhancedProfile === true) return "ENHANCED";
  if (meetsStandardCriteria(v)) return "STANDARD";
  if ((v.eventAssociationCount ?? 0) > 0) return "STUB";
  return "MENTION";
}

// SEO exposure: STANDARD and ENHANCED appear in the sitemap and are
// indexable. STUB and MENTION are excluded from sitemap and noindexed
// (rendered for users following internal links, not for search engines).
export function isIndexableTier(tier: VendorTier): boolean {
  return tier === "STANDARD" || tier === "ENHANCED";
}

// Per-tier sitemap signals. Google largely ignores priority/changefreq;
// Bing still uses them and currently delivers >4× MMATF's organic traffic
// of Google, so the gradient is meaningful.
export function sitemapPriorityFor(tier: VendorTier): number {
  switch (tier) {
    case "ENHANCED":
      return 0.8;
    case "STANDARD":
      return 0.5;
    default:
      // Caller should filter MENTION/STUB out before reaching this branch.
      // Returning 0 makes the bug visible if it slips through.
      return 0;
  }
}

export function sitemapChangeFreqFor(tier: VendorTier): "weekly" | "monthly" | "never" {
  switch (tier) {
    case "ENHANCED":
      return "weekly";
    case "STANDARD":
      return "monthly";
    default:
      return "never";
  }
}
