/**
 * OPE-193 — resolve share/redirect short-links to their real target page.
 *
 * Context: for `share.google` and similar share/redirect hosts, the inbound
 * submit pipeline's `submit/fetch-url` step (which hits the main app's
 * /api/admin/import-url/fetch endpoint — itself already a browser-UA fetch that
 * follows redirects) gets an HTTP 429 back: these hosts rate-limit server-side
 * fetchers *before* emitting the redirect, so the default-follow fetch never
 * sees the `Location`. That bounce is caught by OPE-185's body-extract fallback.
 *
 * This is the quality upgrade on top of it: do ONE manual-redirect hop from the
 * share link with a browser User-Agent (`redirect: "manual"`) so we can read the
 * `Location` the follow-fetch never surfaces, then hand the *resolved real URL*
 * back to the normal URL fetch path (richer + higher-confidence than the
 * forwarded body prose). Strictly additive: any failure here returns null and
 * the caller falls through to the unchanged OPE-185 body-extract path.
 */
import { FETCH_UA, isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import { isDenylistedHost } from "../url-denylist.js";

/**
 * Share/redirect hosts we attempt to resolve. NOTE: the classic shorteners
 * (`bit.ly`, `t.co`, `tinyurl.com`, `ow.ly`) are handled UPSTREAM by
 * url-denylist.ts — they're filtered out before ever becoming the primary URL,
 * so they never reach this path. Only the non-denylisted share hosts below do.
 */
export const SHARE_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "share.google",
  "g.co",
  "youtu.be",
  "fb.me",
]);

/**
 * If a share link resolves to one of these, there is no structured event page
 * to extract (video / social / login wall) — return null so the caller falls
 * through to the body-extract path rather than wasting a fetch + AI extract.
 */
const UNFETCHABLE_TARGET_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "www.tiktok.com",
  "accounts.google.com",
]);

const REDIRECT_TIMEOUT_MS = 8000;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url`'s host is a known share/redirect wrapper we should resolve. */
export function isShareRedirectHost(url: string): boolean {
  const host = hostOf(url);
  return host !== null && SHARE_REDIRECT_HOSTS.has(host);
}

/**
 * Follow ONE redirect hop from a share/redirect link with a browser UA.
 *
 * Returns the resolved absolute URL to fetch, or null when there is nothing
 * safe/useful to fetch: no redirect, non-3xx (e.g. the 429 persists), missing
 * Location, non-http(s), SSRF-blocked, denylisted, a loop back to another share
 * host, or a video/social/login target with no event data.
 */
export async function resolveShareRedirect(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      // Manual so we can read the Location header ourselves — the default
      // follow-fetch (the main-app endpoint) 429s before it ever redirects.
      redirect: "manual",
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  // We only need the headers; release the (small) redirect body.
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }

  // Only a 3xx carrying a Location is a redirect we follow.
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get("location");
  if (!location) return null;

  let resolved: URL;
  try {
    resolved = new URL(location, url);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;

  const host = resolved.hostname.toLowerCase();
  // SSRF: never fetch a private/internal target.
  if (isBlockedSsrfHost(host)) return null;
  // Don't loop back to another share host; honor the existing URL denylist.
  if (SHARE_REDIRECT_HOSTS.has(host) || isDenylistedHost(resolved.href)) return null;
  // Video / social / login targets carry no structured event page.
  if (UNFETCHABLE_TARGET_HOSTS.has(host)) return null;

  return resolved.href;
}
