/**
 * OPE-1571 — one comparison key per link, so two spellings of the same hosted
 * page compare equal.
 *
 * The specimen: inbound `de188d66` linked
 *   https://my.cheddarup.com/c/holiday-market-vendor-registration-49978/items
 * while the event we list (VCS Holiday Market 2026) stores
 *   https://holiday-market-vendor-registration-49978.cheddarup.com/
 * Same Cheddar Up collection; exact string equality said "not ours", and the
 * briefing fell through to a text match that named a different fair.
 *
 * Every form below was checked against the live platform on 2026-11-03, not
 * taken from docs (the ticket's rule):
 *   - Cheddar Up: `<slug>.cheddarup.com/` redirects to `my.cheddarup.com/c/<slug>`.
 *   - Eventbrite: `/e/<id>` 301s to `/e/<name>-tickets-<id>` (canonical link
 *     carries the same trailing id).
 *   - Google Forms: `forms.gle/<code>` 302s to `docs.google.com/forms/d/e/<id>/viewform`
 *     — the short code cannot be mapped to the id without a fetch, so the two
 *     forms keep separate keys. Only the long form's `/viewform` + `?usp=` noise
 *     collapses.
 *   - Facebook events: keyed on the numeric event id, so the tracking query
 *     (`acontext`, `__cft__`, `__tn__`) and the optional name segments drop out.
 *     `m.` / `web.` hosts are NOT aliased: they could not be fetched to confirm.
 *
 * Pure — no I/O. `needle` is a substring guaranteed to appear in any stored URL
 * with the same key, so callers can pre-filter in SQL with `instr()` and then
 * compare keys in code.
 */

export interface LinkKey {
  /** Equal keys = the same page. */
  key: string;
  /** Lower-case substring any same-key URL must contain (SQL pre-filter). */
  needle: string;
  /** Which rule produced the key — recorded in the briefing. */
  rule: "cheddarup" | "eventbrite" | "facebook-event" | "google-form" | "url";
}

/** Query parameters that never identify a page — dropped from the generic key. */
const TRACKING_PARAM =
  /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|__tn__|__cft__.*|acontext|ref|ref_src|usp|mibextid|rdid|share_url)$/i;

function parse(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // A non-http scheme ("mailto:a@b.org", "tel:…") must not be rescued by the
  // bare-host prefix below into "https://mailto:a@b.org" (host b.org).
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(s) && !/^https?:/i.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/** Cheddar Up subdomains that are the platform itself, not a collection. */
const CHEDDARUP_RESERVED = new Set(["my", "www", "app", "api", "help", "support", "blog"]);

export function linkKey(raw: string | null | undefined): LinkKey | null {
  const u = parse(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const lowerPath = path.toLowerCase();

  // Cheddar Up — `<slug>.cheddarup.com/...` and `my.cheddarup.com/c/<slug>[/...]`.
  if (host === "cheddarup.com" || host.endsWith(".cheddarup.com")) {
    const sub = host === "cheddarup.com" ? "" : host.slice(0, -".cheddarup.com".length);
    let slug: string | null = null;
    if (sub && !CHEDDARUP_RESERVED.has(sub)) slug = sub;
    else {
      const m = lowerPath.match(/^\/c\/([a-z0-9-]+)/);
      if (m) slug = m[1];
    }
    if (slug) return { key: `cheddarup:${slug}`, needle: slug, rule: "cheddarup" };
  }

  // Eventbrite — any TLD; `/e/<id>` and `/e/<name>-tickets-<id>`.
  if (/(^|\.)eventbrite\.[a-z.]+$/.test(host)) {
    const m = lowerPath.match(/^\/e\/(?:[a-z0-9-]*-)?(\d{6,})$/);
    if (m) return { key: `eventbrite:${m[1]}`, needle: m[1], rule: "eventbrite" };
  }

  // Facebook events — the numeric id is the last path segment.
  if (host === "facebook.com") {
    const m = lowerPath.match(/^\/events\/(?:.*\/)?(\d{6,})$/);
    if (m) return { key: `facebook-event:${m[1]}`, needle: m[1], rule: "facebook-event" };
  }

  // Google Forms (long form only — see header).
  if (host === "docs.google.com") {
    const m = path.match(/^\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/);
    if (m) return { key: `google-form:${m[1]}`, needle: m[1].toLowerCase(), rule: "google-form" };
  }

  // Generic: host without `www.`, path without trailing slash, identifying
  // query params only (sorted), no fragment. Case is kept in the path: on many
  // hosts it matters, and over-matching here names the wrong event.
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return {
    key: `url:${host}${path}${kept ? `?${kept}` : ""}`,
    // Any same-key URL contains `host + path` (it may add `www.`, a trailing
    // slash or tracking params, none of which sit inside this run).
    needle: `${host}${lowerPath}`,
    rule: "url",
  };
}

/** True when both links parse and name the same page. */
export function sameLink(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = linkKey(a);
  const kb = linkKey(b);
  return !!ka && !!kb && ka.key === kb.key;
}
