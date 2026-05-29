/**
 * Shared GSC index-state classifier.
 *
 * Pulled out of the inline `/admin/blog` helper (PR A4) so the
 * `/admin/stuck-urls` cluster view (this PR, A3) can use the same
 * decision tree. Two surfaces, one source of truth — when GSC ships a
 * new coverageState string we only have to teach it to this function.
 *
 * Buckets:
 *   - `indexed`                  — happy path; rule out from triage
 *   - `discovered_not_indexed`   — GSC has the URL but never fetched
 *                                  it; usually needs a re-submit or
 *                                  internal-link boost
 *   - `crawled_not_indexed`      — fetched but excluded; usually a
 *                                  content-quality / thin-page signal
 *   - `unknown`                  — verdict + coverageState both absent
 *                                  or unrecognized
 */

export type IndexState = "indexed" | "discovered_not_indexed" | "crawled_not_indexed" | "unknown";

export function classifyIndexState(
  lastVerdict: string | null,
  lastCoverageState: string | null
): IndexState {
  if (lastVerdict && (lastVerdict === "PASS" || lastVerdict === "SUCCESS")) return "indexed";
  if (!lastCoverageState) return "unknown";
  const cs = lastCoverageState.toLowerCase();
  if (cs.includes("indexed") && !cs.includes("not indexed")) return "indexed";
  if (cs.includes("discovered") && cs.includes("not indexed")) return "discovered_not_indexed";
  if (cs.includes("crawled") && cs.includes("not indexed")) return "crawled_not_indexed";
  return "unknown";
}

/**
 * Classify a meetmeatthefair.com URL into its entity type bucket. Used
 * by /admin/stuck-urls to cluster non-indexed rows into actionable
 * groups instead of showing 39 separate rows that all map to one
 * "vermont farmers markets" follow-up.
 *
 * Order matters — listing pages (`/events/maine`) are matched before
 * detail pages (`/events/<slug>`) since the former is a slash-segment
 * shorter. Static pages (`/`, `/about`) bucket as `listing` too — they
 * share the "site-level hub" rationale.
 */
export type EntityBucket =
  | "event"
  | "vendor"
  | "venue"
  | "promoter"
  | "blog"
  | "event_listing"
  | "vendor_listing"
  | "venue_listing"
  | "blog_listing"
  | "other";

/** Listing-route slugs that are NOT detail pages even though they live
 *  under /events/<x>. Mirrors EVENT_LISTING_SLUGS in src/lib/constants
 *  — duplicated here so this helper has no app-level dependencies. */
const EVENT_LISTING_SUFFIXES = new Set([
  "all",
  "fairs",
  "festivals",
  "craft-fairs",
  "craft-shows",
  "maine",
  "new-hampshire",
  "vermont",
  "massachusetts",
  "rhode-island",
  "connecticut",
]);

export function classifyUrlBucket(url: string): EntityBucket {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "other";
  }
  // Strip trailing slash for matching.
  const p = path.replace(/\/+$/, "");
  if (p === "" || p === "/events") return "event_listing";
  if (p === "/vendors") return "vendor_listing";
  if (p === "/venues") return "venue_listing";
  if (p === "/blog") return "blog_listing";

  const segs = p.split("/").filter(Boolean);
  if (segs.length < 2) return "other";

  const [type, slug, ...rest] = segs;
  if (type === "events") {
    if (rest.length === 0 && EVENT_LISTING_SUFFIXES.has(slug)) return "event_listing";
    return "event";
  }
  if (type === "vendors") return "vendor";
  if (type === "venues") return "venue";
  if (type === "promoters") return "promoter";
  if (type === "blog") {
    if (slug === "tag") return "blog_listing";
    return "blog";
  }
  return "other";
}

/** Extract the slug from a URL we've classified as a detail page.
 *  Returns null for listing-page URLs (no slug to extract). */
export function extractDetailSlug(url: string, bucket: EntityBucket): string | null {
  if (
    bucket !== "event" &&
    bucket !== "vendor" &&
    bucket !== "venue" &&
    bucket !== "promoter" &&
    bucket !== "blog"
  ) {
    return null;
  }
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const segs = path.split("/").filter(Boolean);
    return segs[1] ?? null;
  } catch {
    return null;
  }
}
