/**
 * I1 vendor-enrichment safety rules (Dev-Brief-I1 §5, 2026-06-13). Pure.
 *
 * Codifies the rules battle-tested in the 2026-06-03 in-session run:
 *   - fill-empty-only (never overwrite a non-empty field)
 *   - drop junk (placeholder emails, share-intent links — handled upstream)
 *   - domain-problem detection (parked / for-sale / malware-redirect / dead)
 *   - conflict flags (city/state mismatch, area-code mismatch, social-name
 *     mismatch, closed business, non-business website)
 *
 * Everything ambiguous becomes a FLAG, never a silent value. A non-empty
 * flag set blocks Phase-2 auto-merge by construction.
 */
import type {
  CandidateFlag,
  DomainProblem,
  EnrichField,
  EnrichmentResult,
  ProposedCandidate,
  VendorExtraction,
  VendorRowForEnrichment,
} from "./types.js";

/** Hosts that are never a business's own website (the bad-`website` cases). */
const NON_BUSINESS_HOSTS = [
  "facebook.com",
  "m.facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linktr.ee",
  "linktree.com",
  "yachtworld.com",
  "boattrader.com",
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "sites.google.com",
  "business.site",
];

/** Parked / for-sale lander markers (title or body). */
const FOR_SALE_MARKERS = [
  "domain is for sale",
  "this domain is for sale",
  "buy this domain",
  "the domain name is available",
  "domain for sale",
  "is for sale",
];
const PARKING_MARKERS = [
  "sedo",
  "bodis",
  "parkingcrew",
  "hugedomains",
  "domain parking",
  "godaddy.com/domainfind",
];

/** Closed-business markers. */
const CLOSED_MARKERS = [
  "permanently closed",
  "has closed",
  "now closed",
  "no longer in business",
  "out of business",
  "ceased operations",
  "closed its doors",
  "we have closed",
];

/** Known malware / scam redirect destinations (extend as cases surface). */
const KNOWN_BAD_HOSTS = ["bodis.com", "above.com", "afternic.com", "sedoparking.com"];

/**
 * Minimal area-code → state map, New-England-weighted (the catalog's home
 * turf). Best-effort: an unknown area code yields no flag, never a false
 * positive. Multi-state codes omitted to avoid spurious mismatches.
 */
const AREA_CODE_STATE: Record<string, string> = {
  "207": "ME",
  "603": "NH",
  "802": "VT",
  "401": "RI",
  "413": "MA",
  "508": "MA",
  "617": "MA",
  "774": "MA",
  "781": "MA",
  "857": "MA",
  "978": "MA",
  "351": "MA",
  "203": "CT",
  "860": "CT",
  "959": "CT",
  "475": "CT",
  "212": "NY",
  "315": "NY",
  "516": "NY",
  "518": "NY",
  "585": "NY",
  "607": "NY",
  "631": "NY",
  "716": "NY",
  "718": "NY",
  "845": "NY",
  "914": "NY",
};

function isEmpty(v: string | null | undefined): boolean {
  return v == null || v.trim() === "" || v.trim() === "{}" || v.trim() === "[]";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isPlaceholderEmail(email: string): boolean {
  const e = email.toLowerCase();
  return (
    e.includes("example.com") ||
    e.includes("example.org") ||
    e.includes("yourdomain") ||
    e.includes("domain.com") ||
    e.startsWith("noreply@") ||
    e.startsWith("no-reply@") ||
    e.startsWith("donotreply@") ||
    e === "info@info.com" ||
    e.endsWith("@email.com") ||
    e.endsWith("@sentry.io")
  );
}

// Generic words that are NOT distinctive enough to confirm a social link
// belongs to a vendor. Two unrelated breweries both contain "brewing", so
// matching on it would mask the swapped-link case the rule exists to catch
// (Saco River ↔ Lake St. George, 6/3). Drop business-category nouns + legal
// suffixes; keep proper-noun tokens (saco, river, kingfield, ...).
const NAME_STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "for",
  "at",
  "a",
  "an",
  "llc",
  "inc",
  "co",
  "company",
  "corp",
  "ltd",
  "brewing",
  "brewery",
  "brewhouse",
  "taproom",
  "beer",
  "ales",
  "restaurant",
  "tavern",
  "pub",
  "grill",
  "grille",
  "kitchen",
  "cafe",
  "coffee",
  "bakery",
  "farm",
  "farms",
  "market",
  "store",
  "shop",
  "studio",
  "gallery",
  "marine",
  "boats",
  "boat",
  "motors",
  "auto",
  "services",
  "service",
  "group",
]);

/** Tokens of a business name, lowercased, generic stopwords removed. */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

/** Does a social-profile URL's handle relate to the business name at all? */
function socialHandleMatchesName(url: string, businessName: string): boolean {
  let handle = "";
  try {
    handle = new URL(url).pathname.toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch {
    return true; // unparseable → don't flag
  }
  if (!handle) return true;
  const tokens = nameTokens(businessName);
  if (tokens.length === 0) return true;
  return tokens.some((t) => handle.includes(t));
}

function anyMarker(haystack: string, markers: string[]): boolean {
  const h = haystack.toLowerCase();
  return markers.some((m) => h.includes(m));
}

export interface BuildOptions {
  /** Post-redirect URL from the standard fetch path, if known. */
  finalUrl?: string;
  /** The URL we fetched (vendor.website). */
  sourceUrl: string;
}

/**
 * Apply §5 rules. Returns staged candidates (each already carrying vendor-level
 * flags), the vendor-level flag set, and a domain problem if the site is
 * unusable.
 */
export function buildEnrichmentResult(
  vendor: VendorRowForEnrichment,
  ex: VendorExtraction,
  opts: BuildOptions
): EnrichmentResult {
  const vendorFlags: CandidateFlag[] = [];
  const haystack = `${ex.pageTitle ?? ""} ${ex.bodyText ?? ""}`;

  // --- Domain problems: short-circuit, propose nothing ---
  let domainProblem: DomainProblem | null = null;
  if (anyMarker(ex.pageTitle ?? "", FOR_SALE_MARKERS) || anyMarker(haystack, FOR_SALE_MARKERS)) {
    domainProblem = "domain_for_sale";
  } else if (anyMarker(haystack, PARKING_MARKERS)) {
    domainProblem = "domain_parked";
  } else if (opts.finalUrl) {
    const finalHost = hostOf(opts.finalUrl);
    const srcHost = hostOf(opts.sourceUrl);
    if (finalHost && KNOWN_BAD_HOSTS.includes(finalHost) && finalHost !== srcHost) {
      domainProblem = "domain_malware_redirect";
    }
  }
  if (domainProblem) {
    return { candidates: [], vendorFlags: [], domainProblem };
  }

  // --- Closed business (vendor-level flag) ---
  if (anyMarker(haystack, CLOSED_MARKERS)) vendorFlags.push("business_closed");

  // --- Non-business website (the vendor's `website` is a FB/listing/etc.) ---
  const srcHost = hostOf(opts.sourceUrl);
  const nonBusiness = srcHost != null && NON_BUSINESS_HOSTS.includes(srcHost);
  if (nonBusiness) vendorFlags.push("non_business_website");

  const candidates: ProposedCandidate[] = [];
  const push = (
    field: EnrichField,
    proposedValue: string,
    currentValue: string | null,
    method: ProposedCandidate["method"],
    confidence: number,
    flags: CandidateFlag[] = []
  ) => {
    candidates.push({ field, proposedValue, currentValue, method, confidence, flags });
  };

  // When the website itself is non-business, don't trust scraped contact info
  // as canonical — emit a single review row and stop. (The contact details on
  // a Facebook page are often a different/closed entity — the 6/3 cases.)
  if (nonBusiness) {
    push("website", vendor.website ?? opts.sourceUrl, vendor.website, "regex", 0, [
      "non_business_website",
    ]);
    return { candidates, vendorFlags, domainProblem: null };
  }

  // --- contact_phone (fill-empty-only) ---
  if (ex.phone && isEmpty(vendor.contactPhone)) {
    const flags: CandidateFlag[] = [];
    const ac = ex.phone.value.replace(/\D/g, "").replace(/^1/, "").slice(0, 3);
    const acState = AREA_CODE_STATE[ac];
    if (acState && vendor.state && acState !== vendor.state.toUpperCase()) {
      flags.push("area_code_mismatch");
    }
    push("contact_phone", ex.phone.value, null, ex.phone.method, ex.phone.confidence, flags);
  }

  // --- contact_email (fill-empty-only + junk drop) ---
  if (ex.email && isEmpty(vendor.contactEmail)) {
    if (!isPlaceholderEmail(ex.email.value)) {
      push("contact_email", ex.email.value, null, ex.email.method, ex.email.confidence);
    }
    // placeholder → dropped entirely (no candidate), per §5 "drop junk".
  }

  // --- social_links (fill-empty-only) ---
  if (ex.social && isEmpty(vendor.socialLinks)) {
    const flags: CandidateFlag[] = [];
    for (const url of Object.values(ex.social.value)) {
      if (!socialHandleMatchesName(url, vendor.businessName)) {
        flags.push("social_name_mismatch");
        break;
      }
    }
    push(
      "social_links",
      JSON.stringify(ex.social.value),
      null,
      ex.social.method,
      ex.social.confidence,
      flags
    );
  }

  // --- address (fill-empty-only) ---
  if (ex.address && isEmpty(vendor.address)) {
    push("address", ex.address.value, null, ex.address.method, ex.address.confidence);
  }

  // --- city / state: fill if empty, FLAG-AS-CONFLICT if filled & different ---
  if (ex.city) {
    if (isEmpty(vendor.city)) {
      push("city", ex.city.value, null, ex.city.method, ex.city.confidence);
    } else if (vendor.city!.trim().toLowerCase() !== ex.city.value.trim().toLowerCase()) {
      vendorFlags.push("city_mismatch");
      push("city", ex.city.value, vendor.city, ex.city.method, ex.city.confidence, [
        "city_mismatch",
      ]);
    }
  }
  if (ex.state) {
    const exState = ex.state.value.trim().toUpperCase();
    if (isEmpty(vendor.state)) {
      push("state", exState, null, ex.state.method, ex.state.confidence);
    } else if (vendor.state!.trim().toUpperCase() !== exState) {
      vendorFlags.push("state_mismatch");
      push("state", exState, vendor.state, ex.state.method, ex.state.confidence, [
        "state_mismatch",
      ]);
    }
  }

  // --- description (staged for review ONLY; never auto-published) ---
  if (ex.description && isEmpty(vendor.description)) {
    push(
      "description",
      ex.description.value,
      null,
      ex.description.method,
      ex.description.confidence
    );
  }

  // Merge only VENDOR-WIDE flags into every candidate — a closed business or a
  // non-business website taints the whole record, so no field auto-merges. A
  // single-field conflict (city/state/area-code/social-name mismatch) stays on
  // its OWN candidate so it doesn't needlessly quarantine an unrelated clean
  // fill (e.g. a valid phone number on a page whose city disagrees with us).
  const dedupedVendorFlags = [...new Set(vendorFlags)];
  const VENDOR_WIDE: CandidateFlag[] = ["business_closed", "non_business_website"];
  const vendorWide = dedupedVendorFlags.filter((f) => VENDOR_WIDE.includes(f));
  for (const c of candidates) {
    c.flags = [...new Set([...c.flags, ...vendorWide])];
  }

  return { candidates, vendorFlags: dedupedVendorFlags, domainProblem: null };
}
