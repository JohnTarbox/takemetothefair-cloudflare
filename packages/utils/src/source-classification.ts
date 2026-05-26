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
  | "aggregator_import";

/** All values the ingestion_method column may take. Useful for Zod enums. */
export const INGESTION_METHODS: readonly IngestionMethod[] = [
  "direct_scrape",
  "email_submission",
  "vendor_submission",
  "community_suggestion",
  "web_research",
  "admin_manual",
  "aggregator_import",
] as const;

export interface SourceClassification {
  sourceDomain: string | null;
  ingestionMethod: IngestionMethod | null;
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
 *  domain when the label looks like a hostname. */
function inferIngestionMethod(
  sourceName: string | null | undefined,
  sourceDomain: string | null
): IngestionMethod | null {
  if (sourceName) {
    const key = sourceName.trim().toLowerCase();
    if (METHOD_BY_NAME[key]) return METHOD_BY_NAME[key];
  }
  // No method label, but we have a domain — classify by whether the
  // domain is a known aggregator host.
  if (sourceDomain) {
    if (AGGREGATOR_HOSTS.has(sourceDomain)) return "aggregator_import";
    return "direct_scrape";
  }
  // No label, no domain — admin must have created this manually.
  if (sourceName) return "admin_manual";
  return null;
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
