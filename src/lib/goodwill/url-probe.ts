/**
 * The one HTTP probe every url-health sweep uses (OPE-868 promoters, OPE-1270
 * vendors, and — since OPE-1350 — the OPE-988 source-agreement sweep, which had
 * its own verbatim copy carrying the same swallowed-body bug). Moved here verbatim from the promoter sweep route so a second sweep
 * cannot drift from it — a fix to how we fetch reaches both.
 */
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import { guardedFetch } from "@takemetothefair/site-fetch";

export const FETCH_TIMEOUT_MS = 10_000;

export interface Probe {
  reachedOrigin: boolean;
  status: number | null;
  html: string | null;
  /** OPE-988 — where redirects left us; a hop to another domain is a takeover signal. */
  finalUrl?: string | null;
  /** OPE-1350 — the response arrived but its body could not be read. */
  bodyReadError?: string | null;
}

function describeBodyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 200);
  return String(e).slice(0, 200) || "unknown body read error";
}

/**
 * OPE-1370 (SSRF6) — the cap on a 2xx body. It used to be read whole; a page
 * past this is far beyond any organizer site, and its first 5 MB is still
 * read (a prefix, not an error), so the classifier sees what it always saw.
 */
export const PROBE_MAX_BYTES = 5 * 1024 * 1024;
const NON_2XX_BODY_CAP = 300_000;

export async function probe(url: string): Promise<Probe> {
  // OPE-1370 — through `guardedFetch`: redirects are followed manually with
  // the SSRF guard re-run on every hop (it followed them unchecked, with no
  // guard at all), the body is size-capped, and FETCH_TIMEOUT_MS still covers
  // the body read as well as the headers. A refused hop is unreachable.
  try {
    const res = await guardedFetch(url, {
      maxBytes: PROBE_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": SCRAPER_USER_AGENT },
    });
    // OPE-979 — the body is read on EVERY status. The classifier still
    // ignores a non-2xx body for its event-signal verdicts (a themed 404 must
    // not score as healthy), but a closure announcement is routinely served as
    // a 503 maintenance page — eagleshows.com is — and was never being read.
    // A 2xx body is read whole, as before — a JS-heavy organizer page can carry
    // its event text past any fixed cap (easterngunexpo.com reads `ok` whole and
    // `no_event_signal` cut at 300 KB, measured). Only a non-2xx body, which
    // feeds nothing but the closure check, is capped.
    //
    // OPE-1350 — a body read that THROWS is recorded, not swallowed. It used
    // to `.catch(() => "")`, so the abort timer firing mid-body (it covers the
    // read as well as the headers) or a reset stream became a 0-byte 200 —
    // which the classifier then called a parked site.
    let body = "";
    let bodyReadError: string | null = null;
    try {
      body = await res.textPrefix(res.ok ? PROBE_MAX_BYTES : NON_2XX_BODY_CAP);
    } catch (e) {
      bodyReadError = describeBodyError(e);
    }
    const html = (res.ok ? body : body.slice(0, NON_2XX_BODY_CAP)) || null;
    return {
      reachedOrigin: true,
      status: res.status,
      html,
      finalUrl: res.url || null,
      bodyReadError,
    };
  } catch {
    return { reachedOrigin: false, status: null, html: null };
  }
}
