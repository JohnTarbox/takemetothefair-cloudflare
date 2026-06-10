/**
 * Redirect Location-header host rewrite for the apex proxy Worker.
 *
 * Why this exists
 * ---------------
 * The Worker proxies meetmeatthefair.com → env.UPSTREAM
 * (takemetothefair.pages.dev) by issuing `fetch` against an upstream
 * URL. That makes the upstream `Host` the Pages hostname, so any
 * absolute redirect the origin generates from the request host — every
 * slug-rename 301 in src/middleware.ts builds `request.nextUrl.clone()`
 * — emits `Location: https://takemetothefair.pages.dev/...`. Left
 * unrewritten, crawlers and users following a rename 301 land on the
 * raw Pages origin instead of the canonical apex.
 *
 * This helper rewrites the Location host back to the public-facing host
 * the client actually used, but ONLY when the redirect points at the
 * upstream host. A redirect to any other host (an intentional offsite
 * redirect) is left untouched.
 *
 * Pure function (no Worker globals) so it can be unit-tested directly,
 * matching the inspect.ts / hasErrorMarker testing pattern.
 */
export function rewriteRedirectLocation(
  /** The raw `Location` header value from the upstream response (may be null). */
  location: string | null,
  /** env.UPSTREAM — the Pages origin URL, e.g. "https://takemetothefair.pages.dev". */
  upstream: string,
  /** The public-facing protocol + host the client used (from the incoming request URL). */
  publicTarget: { protocol: string; host: string },
  /** Absolute base to resolve a relative Location against (the upstream request URL). */
  base: string
): string | null {
  if (!location) return null;

  let upstreamHost: string;
  try {
    upstreamHost = new URL(upstream).host;
  } catch {
    return null;
  }

  let loc: URL;
  try {
    // `base` resolves a relative Location (e.g. "/vendors/foo"); an
    // already-absolute Location ignores the base, as desired.
    loc = new URL(location, base);
  } catch {
    return null;
  }

  // Only rewrite when the redirect targets the upstream origin host.
  // Anything else is an intentional offsite redirect — leave it alone.
  if (loc.host !== upstreamHost) return null;

  loc.protocol = publicTarget.protocol;
  loc.host = publicTarget.host;
  return loc.toString();
}
