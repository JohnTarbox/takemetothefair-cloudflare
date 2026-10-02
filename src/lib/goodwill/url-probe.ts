/**
 * The one HTTP probe every url-health sweep uses (OPE-868 promoters, OPE-1270
 * vendors). Moved here verbatim from the promoter sweep route so a second sweep
 * cannot drift from it — a fix to how we fetch reaches both.
 */
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";

export const FETCH_TIMEOUT_MS = 10_000;

export interface Probe {
  reachedOrigin: boolean;
  status: number | null;
  html: string | null;
  /** OPE-988 — where redirects left us; a hop to another domain is a takeover signal. */
  finalUrl?: string | null;
}

export async function probe(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SCRAPER_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    // OPE-979 — the body is read on EVERY status. The classifier still
    // ignores a non-2xx body for its event-signal verdicts (a themed 404 must
    // not score as healthy), but a closure announcement is routinely served as
    // a 503 maintenance page — eagleshows.com is — and was never being read.
    // A 2xx body is read whole, as before — a JS-heavy organizer page can carry
    // its event text past any fixed cap (easterngunexpo.com reads `ok` whole and
    // `no_event_signal` cut at 300 KB, measured). Only a non-2xx body, which
    // feeds nothing but the closure check, is capped.
    const body = await res.text().catch(() => "");
    const html = (res.ok ? body : body.slice(0, 300_000)) || null;
    return { reachedOrigin: true, status: res.status, html, finalUrl: res.url || null };
  } catch {
    return { reachedOrigin: false, status: null, html: null };
  } finally {
    clearTimeout(timer);
  }
}
