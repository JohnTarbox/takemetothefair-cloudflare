// Binary indexability gate for vendor pages. Delegates to the four-tier
// model in vendor-tier.ts so sitemap generator + generateMetadata + tier
// derivation all agree on what counts as indexable.

import { getVendorTier, isIndexableTier, type VendorTierFields } from "./vendor-tier";

export type VendorIndexabilityFields = VendorTierFields;

export function isVendorIndexable(vendor: VendorIndexabilityFields): boolean {
  return isIndexableTier(getVendorTier(vendor));
}
