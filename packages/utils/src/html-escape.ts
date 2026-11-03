/**
 * OPE-1392 (TPL-5) — the one HTML escape for interpolating a string into
 * markup we build by hand (email templates, operator digests).
 *
 * Escapes the quote characters too, so the SAME helper is safe in a text node
 * AND inside a quoted attribute (`href="${escapeHtml(url)}"`). The copies it
 * replaces escaped only `& < >`, which is enough for a text node but lets a
 * `"` close an attribute.
 *
 * For a URL in an href this escapes; it does not VALIDATE the scheme — pair
 * it with `safeHref` when the URL is not site-built.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
