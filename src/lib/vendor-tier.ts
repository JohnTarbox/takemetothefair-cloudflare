// Four-tier vendor display model from the SEO strategy doc §6.6, plus a
// finer-grained sitemap priority classification for the indexable subset.
// Single source of truth — sitemap, vendor page render, badges, recommendations
// rules, and completeness checklist all derive from getVendorTier() and
// getSitemapPriorityTier().
//
// Decoupling principle: a vendor's tier is computed from current data; it
// is not a column. Graduation/demotion is automatic when the underlying
// fields change. This keeps ingestion aggressive (everything gets a row)
// and SEO conservative (only STANDARD+ENHANCED reach search engines).

export type VendorTier = "MENTION" | "STUB" | "STANDARD" | "ENHANCED";

// Finer-grained classification within indexable vendors. Drives sitemap
// <priority> and <changefreq> per §6.6.
export type SitemapPriorityTier = "HIGH" | "MEDIUM" | "LOW";

export interface VendorTierFields {
  description?: string | null;
  website?: string | null;
  socialLinks?: string | Record<string, string> | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  enhancedProfile?: boolean | null;
  // Hijacked-domain vendors host casino/spam content scraped from a
  // squatted source domain. They are never indexable regardless of other
  // fields — overrides Enhanced. Surface via the recommendations feed
  // rather than letting spam reach search engines.
  domainHijacked?: boolean | null;
  // Count of event_vendors rows in any public-status. Used for STUB
  // tier (>0 means a vendor has at least one event mention).
  eventAssociationCount?: number;
  // Count of event_vendors where the linked venue has both city AND
  // state. Used as a geographic anchor for the SEO gate when the vendor
  // has neither own city+state nor an own address.
  eventVenueGeoCount?: number;
}

// SEO gate: descriptions shorter than this don't carry enough unique
// content to rank for anything beyond brand-name queries. ≥30 chars
// matches the user-visible "real description" threshold from §10.2.
const MIN_DESCRIPTION_LENGTH = 30;

// Sitemap HIGH-tier promotion threshold. Vendors with an own-geo anchor
// AND ≥5 event associations are demonstrating sustained relevance and
// get the elevated priority/changefreq.
const HIGH_TIER_EVENT_THRESHOLD = 5;

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function hasMeaningfulDescription(v: VendorTierFields): boolean {
  return !!v.description && v.description.trim().length >= MIN_DESCRIPTION_LENGTH;
}

function hasOwnGeo(v: VendorTierFields): boolean {
  if (nonEmpty(v.city) && nonEmpty(v.state)) return true;
  if (nonEmpty(v.address)) return true;
  return false;
}

function hasAnyGeo(v: VendorTierFields): boolean {
  if (hasOwnGeo(v)) return true;
  if ((v.eventVenueGeoCount ?? 0) > 0) return true;
  return false;
}

function meetsStandardCriteria(v: VendorTierFields): boolean {
  return hasMeaningfulDescription(v) && hasAnyGeo(v);
}

export function getVendorTier(v: VendorTierFields): VendorTier {
  if (v.domainHijacked === true) return "MENTION";
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

// Within the indexable set, classify priority by quality/intent signals.
// Caller should filter MENTION/STUB out before calling this.
//
// HIGH:   Enhanced (paid), OR description+ownGeo+≥5 event associations
// MEDIUM: description+ownGeo (city+state OR address), <5 events
// LOW:    description+event-based geo only (no own city+state, no own address)
export function getSitemapPriorityTier(v: VendorTierFields, tier: VendorTier): SitemapPriorityTier {
  if (tier === "ENHANCED") return "HIGH";
  const ownGeo = hasOwnGeo(v);
  const eventCount = v.eventAssociationCount ?? 0;
  if (ownGeo && eventCount >= HIGH_TIER_EVENT_THRESHOLD) return "HIGH";
  if (ownGeo) return "MEDIUM";
  return "LOW";
}

// Per-priority sitemap signals. Google largely ignores priority/changefreq;
// Bing still uses them and currently delivers >4× MMATF's organic traffic
// of Google, so the gradient is meaningful.
export function sitemapPriorityFor(priorityTier: SitemapPriorityTier): number {
  switch (priorityTier) {
    case "HIGH":
      return 0.8;
    case "MEDIUM":
      return 0.5;
    case "LOW":
      return 0.3;
  }
}

export function sitemapChangeFreqFor(priorityTier: SitemapPriorityTier): "weekly" | "monthly" {
  return priorityTier === "HIGH" ? "weekly" : "monthly";
}
