/**
 * OPE-332 — HTTP conditional-request (304 Not Modified) support.
 *
 * Google's crawl-budget guidance (updated 2026-07-22) asks sites to support
 * 304: when a page hasn't changed since the last crawl, a 304 tells the crawler
 * to reuse its copy instead of re-downloading the body.
 *
 * ── The validator has to be TRUE, not merely present ────────────────────────
 * A 304 is an assertion: "nothing changed, keep what you have." If that is ever
 * wrong, the crawler keeps a stale page indefinitely — strictly worse than no
 * 304 at all, because the error is silent and long-lived. So the validator's
 * soundness is the whole design, not a detail.
 *
 * The audit that motivated `$onUpdateFn` on the entity tables found updated_at
 * was maintained almost nowhere (36/58 event updates, 26/31 vendor, 16/17
 * promoter, 10/11 venue updates never touched it — including image, venue and
 * geocode writes that visibly change the page). That is now fixed at the schema
 * layer rather than per-call-site, so updated_at means what this module needs
 * it to mean.
 *
 * ── Anonymous only ──────────────────────────────────────────────────────────
 * `UnverifiedBanner` sits in the root layout and calls `auth()`, so EVERY
 * page's HTML is auth-dependent. A validator shared across sessions could
 * therefore let one user's view satisfy another's request. Requests carrying a
 * session cookie are excluded entirely — they keep today's `private, no-store`
 * behaviour and never see a validator.
 */

/** Bump when the page template changes in a way that alters HTML for unchanged
 *  data. Without this, a layout-wide edit would ship behind stale validators —
 *  the entity row didn't change, so nothing else would signal the difference. */
export const TEMPLATE_VERSION = "1";

/** Public detail routes that can carry a validator. Mirrors the middleware
 *  matcher's detail-page set; `/blog` is included, feeds and list pages are not. */
export type ConditionalEntityType =
  | "event"
  | "vendor"
  | "venue"
  | "promoter"
  | "performer"
  | "blog";

/**
 * `/events/<slug>` → `{ type: "event", slug }`. Returns null for anything with
 * a different shape, which is the safe answer: an unrecognised path simply
 * renders as it does today.
 *
 * Single-segment only. `/events/maine` (a state page) and `/blog/tag/x` are
 * NOT entity detail pages and must not be given an entity's validator.
 */
export function matchConditionalRoute(
  pathname: string
): { type: ConditionalEntityType; slug: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [prefix, slug] = segments;
  const map: Record<string, ConditionalEntityType> = {
    events: "event",
    vendors: "vendor",
    venues: "venue",
    promoters: "promoter",
    performers: "performer",
    blog: "blog",
  };
  const type = map[prefix];
  if (!type) return null;
  // `feed.xml` and friends live under /blog but are route handlers with their
  // own caching; a dot in the final segment is never an entity slug.
  if (slug.includes(".")) return null;
  return { type, slug };
}

/**
 * Weak validator from the entity's identity + mtime + template version.
 *
 * Weak (`W/`) is correct here: it asserts semantic equivalence, not byte
 * equality. We do not hash the body — middleware runs before the render, which
 * is exactly what lets a matching request skip rendering altogether rather than
 * merely skip the transfer.
 */
export function buildEntityEtag(
  type: ConditionalEntityType,
  slug: string,
  updatedAt: Date | null
): string {
  const stamp = updatedAt ? Math.floor(updatedAt.getTime() / 1000) : 0;
  return `W/"${type}-${slug}-${stamp}-v${TEMPLATE_VERSION}"`;
}

/**
 * Does this request's precondition mean "you already have it"?
 *
 * Per RFC 9110 §13.1.3, `If-None-Match` takes precedence and `If-Modified-Since`
 * MUST be ignored when it is present — so this returns on the ETag branch
 * rather than falling through to the date comparison.
 */
export function isNotModified(opts: {
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
  etag: string;
  lastModified: Date | null;
}): boolean {
  const { ifNoneMatch, ifModifiedSince, etag, lastModified } = opts;

  if (ifNoneMatch) {
    // A client may send a list of candidates; any member matching is a hit.
    return ifNoneMatch
      .split(",")
      .map((t) => t.trim())
      .some((t) => t === etag || t === "*");
  }

  if (ifModifiedSince && lastModified) {
    const since = Date.parse(ifModifiedSince);
    // HTTP-dates have second resolution. Comparing at millisecond granularity
    // would read as "modified" on essentially every request, and the 304 path
    // would never fire — a bug that looks exactly like working code.
    return (
      !Number.isNaN(since) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000)
    );
  }

  return false;
}

/**
 * A session cookie means the response may carry personalized chrome, so it gets
 * no validator. Matched by suffix because Auth.js prefixes the cookie with
 * `__Secure-` under HTTPS, and by prefix family so a future rename inside the
 * same scheme still trips the guard.
 *
 * Deliberately errs toward "treat as authenticated": a false positive costs a
 * missed 304, a false negative could cross sessions.
 */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return /(^|;\s*)(__Secure-|__Host-)?(authjs|next-auth)\.session-token=/.test(cookieHeader);
}
