import { parseJsonArray } from "@/types";
import { getVendorTier, type VendorTier, type VendorTierFields } from "./vendor-tier";

/**
 * Five fields that matter for a vendor to successfully apply to events:
 *   1. Logo — first thing promoters look at
 *   2. Description — explains who the vendor is
 *   3. At least one product — explains what they sell
 *   4. A contact method (email or phone)
 *   5. Location (city + state)
 *
 * Returns a percentage (0–100) plus the list of missing-field labels so
 * the UI can tell the vendor which one to add next.
 *
 * Also derives the vendor's current §6.6 tier and the gap to the next
 * tier — used by the vendor-facing checklist to surface SEO-relevant
 * field gaps separately from event-application readiness.
 */
export interface VendorCompletenessInput extends VendorTierFields {
  logoUrl: string | null;
  description: string | null;
  products: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  city: string | null;
  state: string | null;
}

export type NextTierAction = "fill_fields" | "upgrade_to_enhanced" | null;

export interface VendorCompleteness {
  percent: number;
  missing: string[];
  complete: boolean;
  currentTier: VendorTier;
  /** Next tier the vendor can graduate to, or null at ENHANCED. */
  nextTier: VendorTier | null;
  /** Specific field labels needed to reach nextTier (empty for ENHANCED upsell path). */
  tierGap: string[];
  /** How the vendor closes the gap — by filling fields or by upgrading. */
  nextTierAction: NextTierAction;
}

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

// SEO-gate description threshold; mirrors MIN_DESCRIPTION_LENGTH in vendor-tier.ts.
const MIN_DESCRIPTION_LENGTH = 30;

function hasMeaningfulDescription(v: VendorTierFields): boolean {
  return !!v.description && v.description.trim().length >= MIN_DESCRIPTION_LENGTH;
}

function computeTierGap(
  v: VendorTierFields,
  currentTier: VendorTier
): { nextTier: VendorTier | null; tierGap: string[]; nextTierAction: NextTierAction } {
  if (currentTier === "ENHANCED") {
    return { nextTier: null, tierGap: [], nextTierAction: null };
  }
  if (currentTier === "STANDARD") {
    return { nextTier: "ENHANCED", tierGap: [], nextTierAction: "upgrade_to_enhanced" };
  }
  // STUB or MENTION → STANDARD: spell out the missing §6.6 criteria.
  // External signal (website / social) is no longer required for STANDARD;
  // a meaningful description plus any geographic anchor is enough.
  const gap: string[] = [];
  if (!hasMeaningfulDescription(v)) gap.push("description");
  const hasOwnGeo = (nonEmpty(v.city) && nonEmpty(v.state)) || nonEmpty(v.address);
  const hasEventGeo = (v.eventVenueGeoCount ?? 0) > 0;
  if (!hasOwnGeo && !hasEventGeo) gap.push("city and state");
  return { nextTier: "STANDARD", tierGap: gap, nextTierAction: "fill_fields" };
}

export function computeVendorCompleteness(v: VendorCompletenessInput): VendorCompleteness {
  const missing: string[] = [];

  if (!v.logoUrl) missing.push("logo");
  if (!v.description || v.description.trim().length < 20) missing.push("description");
  if (parseJsonArray(v.products).length === 0) missing.push("products");
  if (!v.contactEmail && !v.contactPhone) missing.push("contact info");
  if (!v.city || !v.state) missing.push("location");

  const filled = 5 - missing.length;
  const percent = Math.round((filled / 5) * 100);

  const currentTier = getVendorTier(v);
  const { nextTier, tierGap, nextTierAction } = computeTierGap(v, currentTier);

  return {
    percent,
    missing,
    complete: missing.length === 0,
    currentTier,
    nextTier,
    tierGap,
    nextTierAction,
  };
}
