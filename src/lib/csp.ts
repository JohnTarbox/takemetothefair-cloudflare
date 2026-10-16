/**
 * OPE-1380 — per-request nonce Content-Security-Policy on uncached routes.
 *
 * Two policies serve the site:
 *
 *   - PUBLIC (cached/ISR) pages keep the host-allowlist policy set in
 *     `next.config.mjs` `headers()`, which still carries `'unsafe-inline'`. A
 *     nonce cannot live there: the HTML is cached and shared, so every viewer
 *     would get the same "per-request" nonce.
 *   - The routes below render per request for a signed-in (or signing-in) user
 *     and are where an XSS would hurt: admin, auth, the vendor/promoter
 *     portals, suggest-event, account pages. They get a fresh nonce on every
 *     request and `script-src 'nonce-…' 'strict-dynamic'` with NO
 *     `'unsafe-inline'`. Middleware sets it (src/middleware.ts) and excludes
 *     these paths from the next.config policy, so a response carries ONE CSP.
 *
 * How the nonce reaches the markup:
 *   - Next.js reads it from the `Content-Security-Policy` REQUEST header that
 *     middleware forwards and stamps every script it emits (framework chunks,
 *     the inline flight data, `next/script`) — app-render.js
 *     `getScriptNonceFromHeader`.
 *   - Our own tags in the root layout (the `__name` polyfill, gtag loader +
 *     init, Cloudflare beacon) and next-themes' inline script read it through
 *     `useCspNonce()` (src/components/security/nonce-script.tsx), which takes
 *     it from the same context `next/script` uses. Reading `headers()` in the
 *     root layout instead would make EVERY page dynamic and kill ISR.
 *
 * `'strict-dynamic'`: gtag.js and the Cloudflare beacon are allow-listed BY
 * NONCE, not dropped; scripts they (or Turnstile's next/script loader) insert
 * are trusted transitively. Host sources and `'self'` stay in the directive as
 * the fallback CSP2 browsers use; CSP3 browsers ignore them under
 * strict-dynamic.
 *
 * Every page under these prefixes must render dynamically (each protected
 * root's layout exports `dynamic = "force-dynamic"`; no page may export
 * `revalidate`, `generateStaticParams` or another `dynamic`). A statically
 * rendered page would carry no nonce and every script on it would be blocked.
 * Guarded by scripts/check-nonce-csp-routes.ts.
 */

/**
 * URL prefixes that get the nonce policy. A path matches when it IS the prefix
 * or continues with `/` — so `/vendor/profile` matches and the public
 * `/vendors/…` directory does not.
 *
 * Adding a prefix here also needs: a middleware `config.matcher` entry, a
 * `force-dynamic` layout, and an entry in `NONCE_CSP_EXCLUDED_SOURCE` in
 * next.config.mjs. The CI guard checks all three.
 */
export const NONCE_CSP_PREFIXES = [
  "/admin",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/vendor",
  "/promoter",
  "/suggest-event",
  "/dashboard",
] as const;

export function isNonceCspPath(pathname: string): boolean {
  return NONCE_CSP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** 128 random bits, base64 — the shape Next's nonce regex accepts. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Script hosts we load from. Fallback only — ignored under strict-dynamic. */
const SCRIPT_HOSTS =
  "https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com";

/**
 * The nonce policy. Every directive other than `script-src` matches the
 * public policy in next.config.mjs, so a page moving between the two only
 * changes how scripts are trusted.
 */
export function nonceContentSecurityPolicy(
  nonce: string,
  opts: { dev?: boolean } = {}
): string {
  const dev = opts.dev ?? process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // `next dev` evaluates modules with eval; production never gets it (OPE-909).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""} ${SCRIPT_HOSTS}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com https://www.google.com https://cloudflareinsights.com",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
