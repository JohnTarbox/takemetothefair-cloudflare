/**
 * OPE-1154 rework (2026-10-04) — URLs that can never be EVIDENCE for an event
 * field, whatever they return.
 *
 * A map or search URL is a pointer to a place or a query, not a statement by
 * anyone about an event: it cannot support a date, a name or a description.
 * Prod, 2026-10-04: 10 active citations pointed at Google Maps searches for a
 * street address — 6 on a PENDING event (0e39e183) whose captured page was
 * Google's consent wall, and 3 on an APPROVED one (070584e8, name and both
 * dates) captured before titles were recorded, so no CONTENT check could ever
 * have caught them. This rule is about the URL itself, so it does not depend
 * on what the fetch returned.
 *
 * Shared by the email pipeline's citation writer AND the `dates_confirmed`
 * gate, so a maps link can neither be stored as a source nor confirm a date.
 *
 * Deliberately NOT here: `share.google` / short links in general. They resolve
 * to real pages (a Cumberland Fair news article is cited through one today),
 * so they are judged by what they return, not by their host.
 */
export function isNonSourceUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.toLowerCase();
  // google.com, google.co.uk, google.ca, … — the country TLDs share the shape.
  const isGoogle = /^(?:[a-z]+\.)?google\.[a-z.]{2,6}$/.test(host);
  if (isGoogle && (path === "/maps" || path.startsWith("/maps/"))) return true;
  if (host.startsWith("maps.google.")) return true;
  if (isGoogle && (path === "/search" || path.startsWith("/search/"))) return true;
  if (host === "maps.app.goo.gl") return true;
  if (host === "goo.gl" && path.startsWith("/maps")) return true;
  if (host === "maps.apple.com") return true;
  if (host === "bing.com" && (path === "/maps" || path.startsWith("/maps/"))) return true;
  return false;
}
