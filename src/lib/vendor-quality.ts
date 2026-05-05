// Binary indexability gate for vendor pages: a vendor is indexable when it has
// at least one substantive signal beyond name+slug. Used by the sitemap
// generator (to exclude thin records) and by generateMetadata (to set
// robots: noindex on the same set so internal-link discovery doesn't bypass
// the gate). Single source of truth — sitemap.ts and vendors/[slug]/page.tsx
// must stay in lockstep.

export interface VendorIndexabilityFields {
  description?: string | null;
  website?: string | null;
}

export function isVendorIndexable(vendor: VendorIndexabilityFields): boolean {
  const hasDescription = !!vendor.description && vendor.description.trim().length > 0;
  const hasWebsite = !!vendor.website && vendor.website.trim().length > 0;
  return hasDescription || hasWebsite;
}
