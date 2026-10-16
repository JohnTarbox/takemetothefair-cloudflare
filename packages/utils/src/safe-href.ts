/**
 * OPE-1368 — the one rule for turning a stored, user- or vendor-supplied URL
 * into something safe to put in an `href`.
 *
 * `urlSchema` used to be `z.string().url()`, which is "does `new URL()` parse
 * it" — so `javascript:alert(1)//` and `data:text/html,…` passed, were stored,
 * and rendered raw as an `href` on the vendor / promoter / event / venue pages.
 * React 18 only WARNS on a `javascript:` href. The schema now refuses them, but
 * rows written before that (and fields written by other surfaces, e.g. the
 * admin-written `socialLinks` JSON or the MCP tools) still reach the renderer,
 * so the renderer checks too.
 *
 * Scheme detection is done by the WHATWG URL parser, not a regex, because the
 * browser's own parser is what decides what a link does: it strips leading
 * C0/space and removes tab/newline anywhere, so `" java\nscript:alert(1)"` is
 * a `javascript:` URL to the browser and must be one to us.
 */

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A bare domain with no scheme — "www.foo.com", "etsy.com/shop/x". 41 prod
 * vendor websites were stored like this (2026-10-15). Without a scheme the
 * browser treats it as a RELATIVE link (/vendors/www.foo.com), so it was
 * already broken; it is upgraded to https:// rather than dropped.
 */
const BARE_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

const HAS_SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalise a web-URL INPUT before validation: trim, and give a bare domain an
 * `https://` scheme. Anything else is returned trimmed and left for the
 * validator to accept or refuse. Used by `urlSchema` so the write side and
 * `safeHref` agree on what a bare domain means.
 */
export function normalizeWebUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!HAS_SCHEME_SLASHES.test(trimmed) && BARE_DOMAIN.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export interface SafeHrefOptions {
  /** Also allow `mailto:` (e.g. an event's application link). */
  allowMailto?: boolean;
  /** Also allow `tel:`. */
  allowTel?: boolean;
  /**
   * OPE-1385 — also allow a same-origin root-relative path ("/events/x"), for
   * admin surfaces whose stored value is sometimes a site path rather than an
   * absolute URL. Anything the browser would resolve OFF-origin
   * ("//evil.test", "/\\evil.test", "/\t/evil.test") is still refused.
   */
  allowRelative?: boolean;
}

const SAME_ORIGIN_PROBE = "https://same-origin.invalid";

/**
 * Return a value safe to render as an `href`, or `undefined` when there is no
 * safe link. Allowed: `http:` / `https:` (plus `mailto:` / `tel:` when opted
 * in). A bare domain is upgraded to `https://`. Everything else —
 * `javascript:`, `data:`, `vbscript:`, relative paths, junk — is `undefined`,
 * so the caller renders no link rather than a dangerous or broken one.
 */
export function safeHref(url: unknown, opts: SafeHrefOptions = {}): string | undefined {
  if (typeof url !== "string") return undefined;
  const candidate = normalizeWebUrlInput(url);
  if (!candidate) return undefined;
  if (opts.allowRelative === true && candidate.startsWith("/")) {
    try {
      const resolved = new URL(candidate, SAME_ORIGIN_PROBE);
      return resolved.origin === SAME_ORIGIN_PROBE ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  const protocol = parsed.protocol.toLowerCase();
  const allowed =
    WEB_PROTOCOLS.has(protocol) ||
    (opts.allowMailto === true && protocol === "mailto:") ||
    (opts.allowTel === true && protocol === "tel:");
  if (!allowed) return undefined;
  // Return the (trimmed / scheme-upgraded) input rather than `parsed.href`, so
  // an already-valid link renders byte-for-byte as before (no added trailing
  // slash, no re-encoding).
  return candidate;
}
