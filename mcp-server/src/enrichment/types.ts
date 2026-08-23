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
  | "placeholder_email"
  // OPE-376: a well-FORMED but fictitious phone (555 exchange, repeated or
  // sequential digits). FLAGGED, not dropped — unlike placeholder_email —
  // because a phone is the vendor's own published value and a human should see
  // that their site is serving template residue, rather than have it vanish.
  | "placeholder_phone"
  // I3 (2026-06-16): extracted email's domain doesn't match the vendor's own
  // website domain — stage it but flag for review (it may be the real contact,
  // or a scraped third-party address; a human decides). Distinct from
  // placeholder_email, which is dropped outright.
  | "email_domain_mismatch"
  // OPE-511 — the SOURCE PAGE's registrable domain bears no relation to this
  // vendor's name. Blocks auto-merge and routes to a human; it does NOT assert
  // the value is wrong. Measured against the live pending set, roughly half the
  // candidates this catches are legitimate (a bookseller at `rarebookstore.net`,
  // an acronym domain like `ecys.com`), so treating it as a discard would throw
  // away real data. Treating it as "needs eyes" is the correct strength.
  | "source_domain_unrelated"
  // OPE-511 — stronger, and the one that caught the headline specimen: ANOTHER
  // vendor is on this same website, and the domain matches THEIR name rather
  // than ours. `Third Shift Fabrication` carried `udderlygutters.com`, which is
  // also `Udderly Gutters`' site, and was proposed their phone at confidence
  // 0.90 with zero flags — fully eligible under the approved auto-merge rule,
  // and wrong. Distinct from the flag above so triage can see which is which.
  | "source_domain_other_vendor"
  // OPE-512 — this exact contact value is already proposed for a DIFFERENT
  // vendor. Auto-merging writes one phone or email onto several live vendor
  // rows and destroys the cheapest duplicate-vendor signal we have: measured on
  // prod 2026-08-23, 37 clusters covering 77 vendors, and most of them are
  // near-duplicate NAMES — "Gryffon Ridge" vs "Gryphon Ridge Spice Merchants",
  // "Hamlin's Marina" vs "Hamlin's Marine", "The Kona Brand" vs "Kona Brand".
  // Those are dedup LEADS. Merging them silently is how a duplicate pair
  // becomes two equally-plausible rows nobody can tell apart afterwards.
  | "duplicate_value_across_vendors";

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
  /**
   * OPE-504 — candidates dropped because they proposed the value already
   * stored. Surfaced rather than silently discarded: a suppression nobody can
   * count is indistinguishable from an extractor that stopped working.
   */
  suppressedNoOps: number;
  /** Set → dispatcher flips domain_hijacked and writes no field candidates. */
  domainProblem: DomainProblem | null;
}
