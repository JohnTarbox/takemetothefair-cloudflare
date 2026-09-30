/**
 * OPE-1165 — where did this visitor come from, attributed the way GA4
 * attributes a session, so an outbound click can be counted against the same
 * population as GA4's `sessionMedium = organic` denominator.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The Overview conversion rate divided ticket + application clicks from ALL
 * traffic by ORGANIC sessions only (OPE-1161 D13) — it could exceed 100%. The
 * click beacon recorded no traffic source at all, so the numerator could not be
 * filtered. This records one on every outbound click.
 *
 * ── Precedence (GA4's, simplified) ───────────────────────────────────────
 *
 *   1. `gclid`            → google / cpc
 *   2. utm_source/medium  → as given (lower-cased), "(not set)" for a missing half
 *   3. external referrer  → a known search engine is `organic`; anything else
 *                           is `referral` with the host as the source
 *   4. nothing            → "(direct)" / "(none)"
 *
 * ── Captured at LANDING, not at click ────────────────────────────────────
 *
 * By the time someone clicks "Buy tickets" they have usually navigated inside
 * the site, and the landing URL's utm_* parameters are gone. So the first page
 * of a tab session stores its attribution in sessionStorage and every click in
 * that tab reuses it — close to GA4's session, which is what the denominator
 * counts. If storage is unavailable the click falls back to computing from the
 * current page; in this SPA `document.referrer` still holds the landing
 * referrer across client navigations, so the fallback is usually right.
 */

export interface TrafficAttribution {
  /** GA4-style session medium: organic | referral | cpc | (none) | utm value */
  medium: string;
  /** GA4-style session source: google | bing | a host | (direct) | utm value */
  source: string;
}

const STORAGE_KEY = "mmatf_traffic_attribution_v1";

/** Search engines whose referral GA4 reports as medium `organic`. */
const SEARCH_ENGINES: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)search\.yahoo\.com$|(^|\.)yahoo\.com$/, "yahoo"],
  [/(^|\.)ecosia\.org$/, "ecosia"],
  [/(^|\.)search\.brave\.com$/, "brave"],
  [/(^|\.)baidu\.com$/, "baidu"],
  [/(^|\.)yandex\.[a-z.]+$/, "yandex"],
  [/(^|\.)startpage\.com$/, "startpage"],
  [/(^|\.)qwant\.com$/, "qwant"],
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(a) === strip(b);
}

/**
 * Pure classifier — exported for tests. `search` is `location.search`,
 * `referrer` is `document.referrer`, `selfHost` is `location.hostname`.
 */
export function classifyTrafficSource(input: {
  search: string;
  referrer: string;
  selfHost: string;
}): TrafficAttribution {
  const params = new URLSearchParams(input.search);
  if (params.get("gclid")) return { medium: "cpc", source: "google" };

  const utmSource = params.get("utm_source")?.trim().toLowerCase() || null;
  const utmMedium = params.get("utm_medium")?.trim().toLowerCase() || null;
  if (utmSource || utmMedium) {
    return { medium: utmMedium ?? "(not set)", source: utmSource ?? "(not set)" };
  }

  const refHost = input.referrer ? hostOf(input.referrer) : null;
  if (refHost && !sameSite(refHost, input.selfHost.toLowerCase())) {
    for (const [re, name] of SEARCH_ENGINES) {
      if (re.test(refHost)) return { medium: "organic", source: name };
    }
    return { medium: "referral", source: refHost.replace(/^www\./, "") };
  }
  return { medium: "(none)", source: "(direct)" };
}

function current(): TrafficAttribution {
  return classifyTrafficSource({
    search: window.location.search,
    referrer: document.referrer,
    selfHost: window.location.hostname,
  });
}

/**
 * Call once per page load (root layout). Stores the landing page's
 * attribution for this tab session if none is stored yet. Never throws.
 */
export function captureLandingAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current()));
  } catch {
    // Storage blocked (private mode, quota) — clicks compute on the fly.
  }
}

/** The tab session's attribution; computed live if none was stored. */
export function getTrafficAttribution(): TrafficAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TrafficAttribution>;
      if (typeof parsed.medium === "string" && typeof parsed.source === "string") {
        return { medium: parsed.medium, source: parsed.source };
      }
    }
  } catch {
    /* fall through to a live read */
  }
  try {
    return current();
  } catch {
    return null;
  }
}
