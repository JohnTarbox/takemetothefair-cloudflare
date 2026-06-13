/**
 * I1 vendor-enrichment Worker — shared types (Dev-Brief-I1, 2026-06-13).
 *
 * The extractor (extract.ts) and the safety rules (safety-rules.ts) are pure:
 * HTML + a vendor snapshot in, proposals out. No D1, no network — the
 * dispatcher (dispatch.ts) is the only piece that touches the database.
 */

/** Vendor fields the enrichment pipeline can propose. */
export type EnrichField =
  | "contact_phone"
  | "contact_email"
  | "social_links"
  | "address"
  | "city"
  | "state"
  | "description"
  // Not a fillable field — used only for a flag-only "this website is bad"
  // review row (non_business_website).
  | "website";

export type ExtractionMethod = "jsonld" | "mailto" | "tel" | "social-link" | "regex";

export interface ExtractedValue {
  value: string;
  method: ExtractionMethod;
  confidence: number;
}

/** Raw, pre-safety-rule extraction from a single page. */
export interface VendorExtraction {
  phone?: ExtractedValue;
  email?: ExtractedValue;
  /** platform → url, e.g. { facebook: "https://facebook.com/acme" }. */
  social?: { value: Record<string, string>; method: ExtractionMethod; confidence: number };
  address?: ExtractedValue;
  city?: ExtractedValue;
  state?: ExtractedValue;
  description?: ExtractedValue;
  /** <title> text — fuel for domain-problem + closed-business detection. */
  pageTitle?: string;
  /** Visible body text (cleaned) — closed-business marker scan. */
  bodyText?: string;
}

/** Domain-level problems → set vendors.domain_hijacked, propose NOTHING. */
export type DomainProblem =
  | "domain_parked"
  | "domain_for_sale"
  | "domain_malware_redirect"
  | "domain_dead";

/** Per-candidate / per-vendor safety flags. A non-empty flag set NEVER auto-merges. */
export type CandidateFlag =
  | "city_mismatch"
  | "state_mismatch"
  | "area_code_mismatch"
  | "social_name_mismatch"
  | "business_closed"
  | "non_business_website"
  | "placeholder_email";

export interface ProposedCandidate {
  field: EnrichField;
  /** Always non-null (DB column is NOT NULL). */
  proposedValue: string;
  /** The vendor's value at proposal time. NULL for a true fill, set for a conflict. */
  currentValue: string | null;
  method: ExtractionMethod;
  confidence: number;
  flags: CandidateFlag[];
}

/** The minimal vendor snapshot the safety rules need. */
export interface VendorRowForEnrichment {
  id: string;
  businessName: string;
  website: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  socialLinks: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  description: string | null;
}

export interface EnrichmentResult {
  /** Rows to stage. Each row's `flags` already includes any vendor-level flags. */
  candidates: ProposedCandidate[];
  /** Vendor-level conflicts (also merged into every candidate's flags). */
  vendorFlags: CandidateFlag[];
  /** Set → dispatcher flips domain_hijacked and writes no field candidates. */
  domainProblem: DomainProblem | null;
}
