/**
 * OPE-1371 (HARD4) — anti-framing + CSP for every response the OAuth login
 * handler serves. The sign-in/consent page at GET /authorize could be framed by
 * any site (no X-Frame-Options, no frame-ancestors), which invites
 * clickjacking of the "Sign In & Approve" button.
 *
 * What the page actually loads (login-handler.ts `renderLoginPage`): one inline
 * `<style>` block, no scripts, no images, no fonts, one form posting to
 * `/authorize`. Hence `style-src 'unsafe-inline'` and nothing else beyond
 * `default-src 'self'` — for the baseline. OPE-1380: the rendered page itself
 * now carries a per-request nonce policy instead (see htmlContentSecurityPolicy).
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

/** OPE-1380 — 128 random bits, base64: a fresh CSP nonce per rendered page. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const NONCE_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * OPE-1380 — with a `nonce`, the policy for a page we RENDER (the sign-in /
 * consent form): scripts only by nonce under `'strict-dynamic'` (the page has
 * none today, so nothing runs; a script added later must carry the nonce), and
 * the inline `<style>` only by nonce — no `'unsafe-inline'` anywhere. Without
 * one, the OPE-1371 baseline for responses that render no markup of ours
 * (error text, redirects, 404s).
 */
export function htmlContentSecurityPolicy(
  redirectUri?: string | null,
  nonce?: string | null
): string {
  const extra = redirectFormActionSource(redirectUri);
  const formAction = extra ? `form-action 'self' ${extra}` : "form-action 'self'";
  if (nonce && NONCE_RE.test(nonce)) {
    return [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'nonce-${nonce}'`,
      ...BASE_DIRECTIVES.filter((d) => !d.startsWith("default-src") && !d.startsWith("style-src")),
      formAction,
    ].join("; ");
  }
  return [...BASE_DIRECTIVES, formAction].join("; ");
}

/**
 * Headers for an HTML response; spread into `c.html(..., headers)`. Pass the
 * `nonce` the page was rendered with; such a page is also `no-store`, since a
 * cached copy would replay one nonce (and one CSRF token) to every viewer.
 */
export function htmlSecurityHeaders(
  redirectUri?: string | null,
  nonce?: string | null
): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": htmlContentSecurityPolicy(redirectUri, nonce),
    ...(nonce ? { "Cache-Control": "no-store" } : {}),
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
