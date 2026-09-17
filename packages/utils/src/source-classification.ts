/**
 * Classify an event's ingestion provenance into:
 *   - sourceDomain: canonical origin hostname (lowercase, no www, no path,
 *     no parenthetical annotation), or null if the source was not a real URL
 *   - ingestionMethod: enum-ish string describing HOW the event entered MMATF
 *
 * Analyst backlog Item 1 (2026-05-26): events.source_name was overloaded
 * with three semantically-distinct things — origin domains, ingestion
 * methods, and freeform notes. This classifier splits a free-form
 * (sourceName, sourceUrl) pair into the two clean fields stored in
 * drizzle/0090. Used by:
 *   - Write-time: every ingest path normalizes through classifySource()
 *     before INSERT, so source_domain + ingestion_method stay aligned.
 *   - Backfill: POST /api/admin/backfill/source-domain walks existing
 *     events and populates both columns from sourceName + sourceUrl.
 */

export type IngestionMethod =
  | "direct_scrape"
  | "email_submission"
  | "vendor_submission"
  | "community_suggestion"
  | "web_research"
  | "admin_manual"
  | "aggregator_import"
  // K26 (2026-06-16): events created by the daily NE event-discovery harvest
  // skill. Previously these landed as 'vendor_submission' because the skill
  // calls suggest_event (which hard-coded that label); suggest_event now
  // accepts a source_label so the skill can tag 'daily-discovery' → this.
  | "discovery";

/** All values the ingestion_method column may take. Useful for Zod enums. */
export const INGESTION_METHODS: readonly IngestionMethod[] = [
  "direct_scrape",
  "email_submission",
  "vendor_submission",
  "community_suggestion",
  "web_research",
  "admin_manual",
  "aggregator_import",
  "discovery",
] as const;

/**
 * OPE-491 — the label `suggest_event` records when the caller passed none.
 *
 * Deliberately NOT a key in `METHOD_BY_NAME`, and deliberately not null:
 *
 *  - not a map key, so `inferIngestionMethod` falls THROUGH to the domain
 *    chain and yields the honest `aggregator_import` / `direct_scrape` /
 *    `admin_manual`. The previous default was `"vendor-submission"`, which IS
 *    a key — so it matched on the first branch and the domain inference below
 *    it was unreachable for every unlabeled caller. 670 rows (~36% of all
 *    events) were stamped `vendor_submission` that way, including 34 from
 *    `mainemade.com`, an AGGREGATOR_HOSTS member that would have classified
 *    correctly had the default not pre-empted the check.
 *  - contains no dot, so `normalizeHostname` returns null and it can never be
 *    mistaken for a domain.
 *  - not null, so `source_name` keeps a greppable marker that distinguishes
 *    "no label was passed" from the legacy NULLs.
 */
export const UNLABELED_SOURCE = "unlabeled";

/** Type guard for values arriving from outside the type system (D1 reads,
 *  JSON bodies, tool params). */
export function isIngestionMethod(value: unknown): value is IngestionMethod {
  return typeof value === "string" && (INGESTION_METHODS as readonly string[]).includes(value);
}

/**
 * Assert an ingestion_method before it reaches an INSERT/UPDATE.
 *
 * The column is plain TEXT with no CHECK constraint and no Drizzle enum, and 13
 * distinct values were live in prod when OPE-491 was filed — so nothing at the
 * database layer stops a typo becoming a permanent new category. This is the
 * only enforcement point there is.
 */
export function assertIngestionMethod(value: unknown, context: string): IngestionMethod {
  if (!isIngestionMethod(value)) {
    throw new Error(
      `${context}: refusing to write unknown ingestion_method ${JSON.stringify(value)}. ` +
        `Allowed: ${INGESTION_METHODS.join(", ")}`
    );
  }
  return value;
}

export interface SourceClassification {
  sourceDomain: string | null;
  /** Always set — classifier defaults to admin_manual when no other signal
   *  matches. This is what the backfill WHERE clause checks against to
   *  decide if a row has been classified yet. */
  ingestionMethod: IngestionMethod;
}

// Known source_name strings that map directly to ingestion methods. Built
// from the prod-D1 distribution observed on 2026-05-26 — extend if new
// labels surface. Keys are lowercase, trimmed.
const METHOD_BY_NAME: Record<string, IngestionMethod> = {
  "email-submission": "email_submission",
  "vendor-submission": "vendor_submission",
  "community-suggestion": "community_suggestion",
  "web-research": "web_research",
  "url-import": "admin_manual",
  "admin-manual": "admin_manual",
  "organizer-website": "admin_manual",
  "aggregator-listing": "aggregator_import",
  facebook: "community_suggestion",
  // K26 — the daily NE event-discovery harvest skill's provenance labels.
  discovery: "discovery",
  "daily-discovery": "discovery",
  "daily-ne-event-discovery": "discovery",
};

// Hostnames that, when seen as sourceDomain, force ingestion_method to
// `aggregator_import` regardless of which scraper actually pulled them.
// Aggregator domains carry inherent per-event quality risk (relayed data,
// dead per-event URLs, stale rows) — bucketing them together unlocks
// per-source-tier reliability scoring.
//
// Mirrors the Tier-3 hostname set in packages/utils/src/event-date-gates.ts.
// Kept duplicated rather than imported to avoid pulling a gate-evaluator
// module into the classifier hot path.
const AGGREGATOR_HOSTS = new Set<string>([
  "lakesregion.org",
  "berkshires.org",
  "capecodchamber.org",
  "visitwhitemountains.com",
  "mainemade.com",
  "visitfreeport.com",
  "mass-vacation.com",
  "visitmaine.com",
  "vermont.com",
  "visitri.com",
  "visitconnecticut.com",
  "mainetourism.com",
  "ctvisit.com",
  "visitvermont.com",
  "visitrhodeisland.com",
  "visitnh.gov",
  "fairsandfestivals.net",
]);

/** Strip a leading "www.", lowercase, drop port/path. Returns null if the
 *  input can't be parsed as a hostname. */
function normalizeHostname(input: string): string | null {
  let v = input.trim();
  if (!v) return null;

  // If the input looks like a URL, parse it. Otherwise treat the input
  // as a bare hostname candidate.
  try {
    if (v.includes("://") || v.startsWith("//")) {
      const u = new URL(v.startsWith("//") ? `https:${v}` : v);
      v = u.hostname;
    }
  } catch {
    // Fall through to bare-hostname handling
  }

  // Strip any parenthetical annotation (e.g., "visitaroostook.com (verified)")
  v = v.replace(/\s*\(.*$/, "").trim();
  // Drop any path that snuck through ("foo.com/bar" → "foo.com")
  v = v.split("/")[0];
  v = v.toLowerCase();
  v = v.replace(/^www\./, "");

  // A real hostname must contain at least one dot and no whitespace.
  if (!v.includes(".") || /\s/.test(v)) return null;
  return v;
}

/** Extract the canonical hostname from a source URL. Returns null on parse
 *  failure or for non-http(s) schemes. */
function hostnameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return normalizeHostname(u.hostname);
  } catch {
    return null;
  }
}

/** Decide ingestion_method from the sourceName label, falling back to the
 *  domain when the label looks like a hostname. Never returns null —
 *  rows with no source signal at all default to admin_manual since the
 *  most common cause is an admin-created row from before source tracking
 *  was wired up. Returning a value keeps the backfill loop from
 *  re-selecting these rows forever (the WHERE clause keys on null
 *  ingestion_method as the "unclassified" sentinel). */
function inferIngestionMethod(
  sourceName: string | null | undefined,
  sourceDomain: string | null
): IngestionMethod {
  if (sourceName) {
    const key = sourceName.trim().toLowerCase();
    if (METHOD_BY_NAME[key]) return METHOD_BY_NAME[key];
  }
  // Have a domain — classify by whether the domain is a known aggregator.
  if (sourceDomain) {
    if (AGGREGATOR_HOSTS.has(sourceDomain)) return "aggregator_import";
    return "direct_scrape";
  }
  // No domain. Anything with a freeform name (e.g. "St. John Valley
  // Chamber of Commerce") or with literally no source info at all is
  // an admin-created row — the analyst's "freeform annotation" bucket
  // and the pre-source-tracking historical rows both land here.
  return "admin_manual";
}

export function classifySource(
  sourceName: string | null | undefined,
  sourceUrl: string | null | undefined
): SourceClassification {
  // Resolve domain first: prefer the URL since it's structurally cleaner
  // than the free-form sourceName. Fall back to interpreting sourceName as
  // a hostname-like string.
  const fromUrl = hostnameFromUrl(sourceUrl);
  const fromName = sourceName ? normalizeHostname(sourceName) : null;
  const sourceDomain = fromUrl ?? fromName ?? null;

  const ingestionMethod = inferIngestionMethod(sourceName, sourceDomain);

  return { sourceDomain, ingestionMethod };
}

/**
 * OPE-491 rework — `ingestion_method` records HOW A ROW WAS COLLECTED, and
 * adding or correcting a citation URL does not change that.
 *
 * `update_event` re-ran `classifySource` whenever `source_url`/`source_name`
 * changed. `inferIngestionMethod` falls through to the domain branch for any
 * label that is not a map key, so a repair that only pointed `source_url` at an
 * organizer's Facebook page flipped a correct `email_submission` row to
 * `direct_scrape` (event 13f7f7a4, 2026-08-21) — silently, since
 * `fieldsUpdated` never mentioned it. `email_submission` is the one clean bucket
 * in the table (57/57 carry `suggester_email`), and recompute-on-write would
 * erode exactly it.
 *
 * The rule, in precedence order:
 *  1. A new `source_name` that is a recognised collection LABEL is an explicit
 *     statement about how the row was collected — it wins.
 *  2. Otherwise, a current value that records a COLLECTION method (anything the
 *     domain branch cannot produce), or a row carrying `suggester_email`, is
 *     kept: a hostname does not outrank evidence about where the row came from.
 *  3. Otherwise the value was domain-derived to begin with, so re-deriving it
 *     from the new URL is correct.
 * `source_domain` is always refreshed — it IS a property of the URL.
 */
const DOMAIN_DERIVED_METHODS: ReadonlySet<IngestionMethod> = new Set([
  "direct_scrape",
  "aggregator_import",
  "admin_manual",
]);

export function reclassifySourceOnEdit(args: {
  currentMethod: string | null | undefined;
  suggesterEmail: string | null | undefined;
  sourceName: string | null | undefined;
  sourceUrl: string | null | undefined;
}): SourceClassification & { preservedMethod: boolean } {
  const recomputed = classifySource(args.sourceName, args.sourceUrl);
  const label = args.sourceName ? METHOD_BY_NAME[args.sourceName.trim().toLowerCase()] : undefined;
  if (label) {
    return {
      sourceDomain: recomputed.sourceDomain,
      ingestionMethod: label,
      preservedMethod: false,
    };
  }
  const current = isIngestionMethod(args.currentMethod) ? args.currentMethod : null;
  const hasSubmitter = typeof args.suggesterEmail === "string" && args.suggesterEmail.trim() !== "";
  if (current && (!DOMAIN_DERIVED_METHODS.has(current) || hasSubmitter)) {
    return {
      sourceDomain: recomputed.sourceDomain,
      ingestionMethod: current,
      preservedMethod: true,
    };
  }
  return { ...recomputed, preservedMethod: false };
}
