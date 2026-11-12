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
  | "discovery"
  // OPE-1348 (2026-10-14): created from a press release the organizer SENT us
  // — their own words, on purpose, often before their site is updated. It
  // landed as `direct_scrape` because the label was not a map key and the
  // domain fallback saw a source_url. A different trust class from a scrape.
  | "press_release";

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
  "press_release",
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

/**
 * OPE-1058 — the provenance tags a created event carries, derived from the
 * label its creator actually passed.
 *
 * `suggest_event` stamped `["community-suggestion", "vendor-submission"]` on
 * every create, whatever `source_label` said. The Alexander Hamfest was created
 * with `source_label: "email-submission"` and still told the tag column it was a
 * vendor submission, contradicting its own `source_name` and `ingestion_method`.
 *
 * - The three human submission lanes keep their legacy bare tags, which the main
 *   app's submit route already writes and every existing reader knows.
 * - Any other label becomes `src:<label>`, a namespaced tag, so the public
 *   renderer hides it by shape (OPE-884) and a new label can never leak as a
 *   hashtag.
 * - No label means no provenance claim at all.
 */
export function provenanceTags(sourceLabel: string | null | undefined): string[] {
  const label = (sourceLabel ?? "").trim().toLowerCase();
  if (label === "" || label === UNLABELED_SOURCE) return [];
  if (label === "vendor-submission") return ["community-suggestion", "vendor-submission"];
  if (label === "email-submission") return ["community-suggestion", "email-submission"];
  if (label === "community-suggestion" || label === "facebook") return ["community-suggestion"];
  const safe = label.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe ? [`src:${safe}`] : [];
}

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
  // OPE-1348 — both spellings: citations already use `press_release` as a
  // source_type, and callers reach for either.
  "press-release": "press_release",
  press_release: "press_release",
};

/**
 * OPE-1348 — was this label RECOGNISED, or did classification fall back to the
 * domain chain? An unknown label used to vanish silently: `press-release`
 * became `direct_scrape` and the caller learned nothing without reading the
 * row back. Writers return this as a warning.
 *
 * `null` for no label / `unlabeled` (falling back is the documented behaviour
 * there, OPE-491) and for a recognised label.
 */
export function unrecognisedSourceLabel(
  sourceLabel: string | null | undefined,
  sourceUrl: string | null | undefined
): { label: string; fellBackTo: IngestionMethod } | null {
  const key = (sourceLabel ?? "").trim().toLowerCase();
  if (key === "" || key === UNLABELED_SOURCE) return null;
  if (METHOD_BY_NAME[key]) return null;
  return { label: key, fellBackTo: classifySource(sourceLabel, sourceUrl).ingestionMethod };
}

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
 *  input can't be parsed as a hostname. Exported (OPE-1231) so the
 *  dates_confirmed gate compares a citation's host with the promoter's site
 *  under the same normalization `classifySource` uses. */
export function normalizeHostname(input: string): string | null {
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
 * `ingestion_method` records HOW A ROW WAS COLLECTED. It is written once, at
 * insert; an edit to the row's source never rewrites it (OPE-1642).
 *
 * History. OPE-491 made `update_event` recompute it on every source edit;
 * its rework (2026-09-16) kept a collection method against a domain-only edit,
 * but still let a new `source_name` that is a `METHOD_BY_NAME` key WIN. That
 * rule relabeled Pine State Expo 2027 (`3b7ddadb`, a daily-discovery row,
 * `web_research`) as `community_suggestion` when its citation was repointed at
 * the organizer's Facebook page with `source_name="facebook"` — silently, and
 * irreversibly, since setting the label back yields `discovery`. `source_name`
 * names the source we CITE now; it is not evidence of how the row arrived.
 *
 * The rule now:
 *  - `source_domain` is always refreshed — it IS a property of the URL;
 *  - a current `ingestion_method` that is a valid value is KEPT, whatever the
 *    new label or URL;
 *  - only a row with no (or an invalid) value gets one derived from the new
 *    source — filling a blank, not overwriting a fact.
 * Changing how a row was collected is a deliberate act: `update_event`'s
 * explicit `ingestion_method` parameter.
 */
export function reclassifySourceOnEdit(args: {
  currentMethod: string | null | undefined;
  sourceName: string | null | undefined;
  sourceUrl: string | null | undefined;
}): SourceClassification & { preservedMethod: boolean } {
  const recomputed = classifySource(args.sourceName, args.sourceUrl);
  if (isIngestionMethod(args.currentMethod)) {
    return {
      sourceDomain: recomputed.sourceDomain,
      ingestionMethod: args.currentMethod,
      preservedMethod: true,
    };
  }
  return { ...recomputed, preservedMethod: false };
}
