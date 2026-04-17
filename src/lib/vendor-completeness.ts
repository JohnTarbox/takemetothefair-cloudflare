import { parseJsonArray } from "@/types";

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
 */
export interface VendorCompletenessInput {
  logoUrl: string | null;
  description: string | null;
  products: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  city: string | null;
  state: string | null;
}

export interface VendorCompleteness {
  percent: number;
  missing: string[];
  complete: boolean;
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

  return { percent, missing, complete: missing.length === 0 };
}
