/**
 * OPE-1498 — mark synthetic traffic on first-party beacon rows, so funnel
 * ratios count visitors and not our own monitors (or a scraper's headless
 * browser).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 * The OPE-363 canary loads /register and /suggest-event in three Playwright
 * profiles every day. Each run writes 12 `register_view`, 9
 * `register_form_interacted` and 3 `submit_view` rows (measured on run
 * 39293497706, 2026-10-19 17:23:39–17:25:08Z) carrying nothing that sets them
 * apart from a visitor. On the low-volume funnels that is most of the traffic:
 * ~3 of 4 `submit_view` rows in 14 days, which turned a ~20% real
 * view→interacted ratio into 3%.
 *
 * A second, smaller source: a once-a-day `submit_view` classified
 * `unknown/other`. Workers Logs names it — `Lightpanda/1.0`, a headless browser
 * built for scraping, from rotating hosting ASNs (Zenlayer AS62610, RapidSeedbox
 * AS214483) on 10-16, 10-18 and 10-19. Not ours.
 *
 * ── The marker ──────────────────────────────────────────────────────────────
 * Rows are TAGGED, never dropped: the canary's own views are its liveness
 * signal, and a scraper's are evidence about scrapers. The tag is
 * `properties.synthetic = true` plus `properties.synthetic_source`, merged
 * server-side and LAST in the beacon route (like `device`/`os`), so a client can
 * neither forge it nor clear it. Real rows are byte-identical to before: the
 * key's ABSENCE means "visitor".
 *
 * Two ways a request is synthetic:
 *  1. **First-party monitor** — carries the `mmatf_synthetic=<source>` cookie,
 *     set by the Playwright context. A cookie and not a header, deliberately:
 *     `extraHTTPHeaders` adds a header to EVERY request including third-party
 *     ones, and a custom header on a cross-origin request forces a CORS
 *     preflight, which could change how Turnstile loads, i.e. change what the
 *     canary measures. A first-party cookie rides same-origin requests only.
 *  2. **Self-declared automation** — a user agent naming a headless browser or
 *     a crawler. Only clients that SAY so; nothing here guesses at a UA that
 *     looks like a person.
 *
 * Setting the cookie yourself only excludes your own rows, so it needs no
 * secret.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const SYNTHETIC_COOKIE = "mmatf_synthetic";

/** The day the marker shipped. Rows before it carry no marker — see the
 *  `completeness` notes in the read paths. */
export const SYNTHETIC_MARKER_SINCE = "2026-10-19";

/** First-party monitors and the cookie value each one sets. */
export const SYNTHETIC_SOURCES = {
  funnelCanary: "funnel-canary",
  productionVerify: "production-verify",
} as const;

/** Self-declared automation. Each alternative is a token a client puts in its
 *  own UA; `<name>bot/`, `crawler`, `spider` cover the long tail (Googlebot/2.1,
 *  bingbot/2.0, AhrefsBot/7.0, Bytespider). The bot token requires its version
 *  slash: a bare `bot\b` matches the Android phone brand "CUBOT" ("Android 9;
 *  CUBOT P30"), a real visitor. Captured so the source names WHICH one. */
const AUTOMATION_UA =
  /(lightpanda|headlesschrome|phantomjs|puppeteer|selenium|externalagent|externalhit|[a-z]*bot(?=\/)|[a-z]*crawler|[a-z]*spider)/i;

/** A cookie value we will store: short, lowercase slug. Anything else is
 *  recorded as "cookie" rather than echoed, so the column can't carry junk. */
const SOURCE_SLUG = /^[a-z0-9-]{1,40}$/;

export interface SyntheticMark {
  synthetic: true;
  synthetic_source: string;
}

function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Decide whether a beacon request is synthetic. Returns the properties to
 * merge, or null for a visitor (merge nothing).
 */
export function classifySynthetic(
  cookieHeader: string | null | undefined,
  userAgent: string | null | undefined
): SyntheticMark | null {
  const cookie = readCookie(cookieHeader, SYNTHETIC_COOKIE);
  if (cookie !== null) {
    return {
      synthetic: true,
      synthetic_source: SOURCE_SLUG.test(cookie) ? cookie : "cookie",
    };
  }
  const m = userAgent ? AUTOMATION_UA.exec(userAgent) : null;
  if (m) return { synthetic: true, synthetic_source: `ua:${m[1]!.toLowerCase()}` };
  return null;
}

/** Keys only the server may write. Stripped from client properties first. */
export const SYNTHETIC_KEYS = ["synthetic", "synthetic_source"] as const;

/**
 * Read-side predicate: the row is NOT synthetic. Every funnel read path
 * applies it unless the caller opts in with `include_synthetic=true`.
 * `json_extract` of a JSON `true` is 1 in SQLite; an absent key is NULL.
 */
export function notSynthetic(properties: AnySQLiteColumn): SQL {
  return sql`COALESCE(json_extract(${properties}, '$.synthetic'), 0) = 0`;
}

/** Parse the opt-in query flag. Only the literal "true"/"1" opts in. */
export function includeSyntheticParam(url: URL): boolean {
  const v = url.searchParams.get("include_synthetic");
  return v === "true" || v === "1";
}

/** One sentence for each read path's `completeness` note. */
export function syntheticCompletenessNote(included: boolean): string {
  return included
    ? `Synthetic rows (properties.synthetic = true: the funnel canary, production-verify, and ` +
        `self-declared crawlers/headless browsers) are INCLUDED (include_synthetic=true).`
    : `Synthetic rows (properties.synthetic = true: the funnel canary, production-verify, and ` +
        `self-declared crawlers/headless browsers) are EXCLUDED; pass include_synthetic=true to ` +
        `count them. The marker exists from ${SYNTHETIC_MARKER_SINCE} (OPE-1498); earlier rows ` +
        `carry none and are counted as visitors.`;
}
