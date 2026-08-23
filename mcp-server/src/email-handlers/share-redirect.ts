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

/**
 * OPE-277 — hosts that are themselves a redirect WAYPOINT, not a destination.
 *
 * `share.google/X` no longer hands back the article. Measured 2026-08-23:
 *
 *     share.google/JAFhqhevUuDYKe2Eu
 *       302 -> www.google.com/share.google?q=JAFhqhevUuDYKe2Eu
 *       301 -> www.pressherald.com/2026/08/17/7-maine-events-...
 *
 * Google inserted that middle hop some time after OPE-193 shipped, and it is
 * why the one-hop resolver started failing while looking healthy: hop 1 does not
 * error, it returns a syntactically fine `www.google.com` URL that is in neither
 * the share-host set nor the unfetchable set, so every guard passes it through
 * and the pipeline goes off to extract an event from Google's interstitial.
 *
 * Matched on host + path prefix, not host alone: `www.google.com` at large is a
 * legitimate destination we must not swallow.
 */
const REDIRECT_WAYPOINTS: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: "www.google.com", pathPrefix: "/share.google" },
  { host: "google.com", pathPrefix: "/share.google" },
  { host: "www.google.com", pathPrefix: "/url" },
  { host: "google.com", pathPrefix: "/url" },
];

/**
 * How many hops we will follow.
 *
 * Every specimen on OPE-277 resolves in exactly 2. The cap is 4 so one more
 * interstitial appearing does not silently reopen this ticket, and low enough
 * that a redirect loop costs four bounded fetches rather than a step timeout.
 */
const MAX_REDIRECT_HOPS = 4;

const REDIRECT_TIMEOUT_MS = 8000;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when this URL is a waypoint we should keep following rather than fetch. */
function isWaypoint(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (SHARE_REDIRECT_HOSTS.has(host)) return true;
  return REDIRECT_WAYPOINTS.some((w) => w.host === host && u.pathname.startsWith(w.pathPrefix));
}

/** True when `url`'s host is a known share/redirect wrapper we should resolve. */
export function isShareRedirectHost(url: string): boolean {
  const host = hostOf(url);
  return host !== null && SHARE_REDIRECT_HOSTS.has(host);
}

/** One manual-redirect hop. Returns the Location target, or null if this was
 *  not a followable redirect. Separated so the hop loop reads as a loop. */
async function oneHop(url: string): Promise<URL | null> {
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

  try {
    return new URL(location, url);
  } catch {
    return null;
  }
}

/**
 * Follow up to `MAX_REDIRECT_HOPS` redirect hops from a share/redirect link
 * with a browser UA, stopping at the first real destination.
 *
 * OPE-277 — this followed exactly ONE hop until 2026-08-23, which is why it
 * stopped working without ever going red: `share.google` gained an intermediate
 * `www.google.com/share.google?q=…` waypoint, and one hop lands on that. The
 * waypoint is not an error and not a share host, so it passed every guard and
 * the pipeline dutifully tried to extract an event from Google's interstitial.
 * Three real submissions were lost that way (2026-07-19, 07-20, 08-17), all of
 * which resolve correctly in two hops.
 *
 * Returns the resolved absolute URL to fetch, or null when there is nothing
 * safe/useful to fetch: no redirect, non-3xx (e.g. the 429 persists), missing
 * Location, non-http(s), SSRF-blocked, denylisted, a video/social/login target
 * with no event data, a redirect cycle, or still on a waypoint when the hop
 * budget runs out.
 *
 * Returning null is a real outcome, not a fallback of last resort: the caller
 * falls through to the OPE-185 body-extract and OPE-277 subject-line paths, and
 * the row still records `extract_fail_reason`. Keeping that failure LOUD is what
 * made this ticket findable at all.
 */
export async function resolveShareRedirect(url: string): Promise<string | null> {
  // Cycle guard. A share host that 302s to itself would otherwise burn the whole
  // hop budget on the same fetch.
  const seen = new Set<string>([url]);
  let current = url;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const resolved = await oneHop(current);
    if (!resolved) return null;

    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;

    const host = resolved.hostname.toLowerCase();
    // SSRF: never fetch a private/internal target. Checked EVERY hop, not just
    // the last — an open redirect could point hop 2 at an internal address.
    if (isBlockedSsrfHost(host)) return null;
    // Honor the existing URL denylist (click-trackers, shorteners).
    if (isDenylistedHost(resolved.href)) return null;
    // Video / social / login targets carry no structured event page.
    if (UNFETCHABLE_TARGET_HOSTS.has(host)) return null;

    if (seen.has(resolved.href)) return null;
    seen.add(resolved.href);

    // Still a wrapper — keep going rather than handing the caller an
    // interstitial to extract an event from.
    if (isWaypoint(resolved)) {
      current = resolved.href;
      continue;
    }

    return resolved.href;
  }

  // Out of hops and still bouncing between wrappers. Fall through loudly.
  return null;
}
