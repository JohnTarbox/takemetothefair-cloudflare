/**
 * OPE-1371 (HARD4) — anti-framing + CSP for every response the OAuth login
 * handler serves. The sign-in/consent page at GET /authorize could be framed by
 * any site (no X-Frame-Options, no frame-ancestors), which invites
 * clickjacking of the "Sign In & Approve" button.
 *
 * What the page actually loads (login-handler.ts `renderLoginPage`): one inline
 * `<style>` block, no scripts, no images, no fonts, one form posting to
 * `/authorize`. Hence `style-src 'unsafe-inline'` and nothing else beyond
 * `default-src 'self'`.
 *
 * `form-action` MUST also allow the client's redirect origin: Chrome (and
 * Firefox) enforce `form-action` on the REDIRECT that follows a form POST, and
 * POST /authorize answers Approve AND Deny with a 302 to the client's
 * `redirect_uri` (claude.ai, `http://localhost:<port>` for desktop clients, a
 * custom scheme…). `form-action 'self'` alone would silently break every
 * connector sign-in. The redirect URI reaching here has already been checked by
 * `parseAuthRequest` against the client's registered URIs.
 */

const BASE_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
];

/** An http(s) origin as CSP spells a host-source. */
const ORIGIN_SOURCE_RE = /^https?:\/\/[a-z0-9.\-[\]:]+$/i;
/** A scheme-source (`cursor:`), for clients that register a custom scheme. */
const SCHEME_SOURCE_RE = /^[a-z][a-z0-9+.-]*:$/i;

/**
 * The CSP source that admits `redirectUri`'s target, or null when it cannot be
 * expressed safely. Only normalised URL parts are ever emitted, and they are
 * re-checked against a strict shape, so a hostile registered URI cannot inject
 * a `;` or another directive into the header.
 */
export function redirectFormActionSource(redirectUri: string | undefined | null): string | null {
  if (!redirectUri) return null;
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    return ORIGIN_SOURCE_RE.test(u.origin) ? u.origin : null;
  }
  // Never widen to script-capable schemes.
  if (["javascript:", "data:", "blob:", "filesystem:"].includes(u.protocol)) return null;
  return SCHEME_SOURCE_RE.test(u.protocol) ? u.protocol : null;
}

export function htmlContentSecurityPolicy(redirectUri?: string | null): string {
  const extra = redirectFormActionSource(redirectUri);
  const formAction = extra ? `form-action 'self' ${extra}` : "form-action 'self'";
  return [...BASE_DIRECTIVES, formAction].join("; ");
}

/** Headers for an HTML response; spread into `c.html(..., headers)`. */
export function htmlSecurityHeaders(redirectUri?: string | null): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": htmlContentSecurityPolicy(redirectUri),
  };
}

/**
 * Baseline for any response that did not set its own: adds both headers where
 * absent. A route that rendered a page with a redirect-aware CSP keeps it.
 */
export function withHtmlSecurityHeaders(response: Response): Response {
  let res = response;
  try {
    applyMissing(res.headers);
  } catch {
    // Immutable headers (e.g. a Response passed through from fetch()).
    res = new Response(res.body, res);
    applyMissing(res.headers);
  }
  return res;
}

function applyMissing(headers: Headers) {
  for (const [k, v] of Object.entries(htmlSecurityHeaders())) {
    if (!headers.has(k)) headers.set(k, v);
  }
}
