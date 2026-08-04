/**
 * XML serialization helpers for the multi-part sitemap. We hand-roll the
 * XML instead of using Next.js's `MetadataRoute.Sitemap` so we can:
 *
 *   1. Serve at literal URLs (`/sitemap-events.xml`) that match the
 *      sitemapindex's `<loc>` entries one-to-one, which makes per-type
 *      indexation visibility in GSC trivial to debug.
 *   2. Set explicit Cache-Control headers per child (static can cache for
 *      hours; events should revalidate fast).
 *   3. Independently fail-soft per child: if D1 errors on `sitemap-events`,
 *      we return an empty `<urlset>` so the index stays healthy and the
 *      other children keep serving.
 *
 * The `safeLastMod` guard exists for the same reason it did in the old
 * single-file sitemap — a SQLite TEXT cell in a `timestamp` column returns
 * `new Date(NaN)` from Drizzle, which throws from `.toISOString()`. The
 * old code learned this the hard way (commit 2d5b53f, Apr 2026 incident);
 * keep the guard around every row's lastmod.
 */

export const SITEMAP_BASE_URL = "https://meetmeatthefair.com";

export type ChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export type SitemapUrl = {
  url: string;
  lastModified?: Date;
  changeFrequency?: ChangeFrequency;
  priority?: number;
};

export type SitemapIndexEntry = {
  loc: string;
  lastmod?: Date;
};

/**
 * Sanitize a SQLite-deserialized timestamp. Drizzle returns Invalid Date
 * for any non-numeric cell in a timestamp column, and Invalid Date throws
 * from `.toISOString()`. Default to "now" rather than crashing.
 */
export function safeLastMod(value: Date | number | null | undefined): Date {
  if (value == null) return new Date();
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return new Date();
  return d;
}

/**
 * XML 1.0-safe text escaping. URLs go inside `<loc>` and must escape the
 * five predefined entities. Slugs in this codebase are kebab-case, but
 * vendor names or external URLs sneaking into the sitemap could contain
 * `&` (especially), so escape every value defensively.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function serializeUrlEntry(entry: SitemapUrl): string {
  const parts: string[] = ["  <url>", `    <loc>${xmlEscape(entry.url)}</loc>`];
  if (entry.lastModified) {
    parts.push(`    <lastmod>${safeLastMod(entry.lastModified).toISOString()}</lastmod>`);
  }
  if (entry.changeFrequency) {
    parts.push(`    <changefreq>${entry.changeFrequency}</changefreq>`);
  }
  if (typeof entry.priority === "number") {
    // Clamp to [0.0, 1.0] per sitemap protocol; emit one decimal place.
    const p = Math.max(0, Math.min(1, entry.priority));
    parts.push(`    <priority>${p.toFixed(1)}</priority>`);
  }
  parts.push("  </url>");
  return parts.join("\n");
}

export function serializeUrlset(urls: SitemapUrl[]): string {
  const body = urls.map(serializeUrlEntry).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    "</urlset>",
    "",
  ].join("\n");
}

function serializeIndexEntry(entry: SitemapIndexEntry): string {
  const parts: string[] = ["  <sitemap>", `    <loc>${xmlEscape(entry.loc)}</loc>`];
  if (entry.lastmod) {
    parts.push(`    <lastmod>${safeLastMod(entry.lastmod).toISOString()}</lastmod>`);
  }
  parts.push("  </sitemap>");
  return parts.join("\n");
}

export function serializeSitemapIndex(entries: SitemapIndexEntry[]): string {
  const body = entries.map(serializeIndexEntry).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    "</sitemapindex>",
    "",
  ].join("\n");
}

/**
 * Standard headers for sitemap responses. Cloudflare Pages caches based on
 * Cache-Control, so a 1-hour edge cache + short browser cache balances
 * freshness against load. Override per-route when needed (static can be
 * longer; admin previews shouldn't cache at all).
 */
export function sitemapXmlHeaders(maxAgeSeconds = 3600): HeadersInit {
  return {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`,
  };
}

/**
 * OPE-333 — conditional-request (304) support for the sitemap routes.
 *
 * Google's crawl-budget guidance (updated 2026-07-22) asks for 304 so an
 * unchanged resource isn't re-downloaded on every crawl. Sitemaps are the
 * safest place to start: fetched constantly by Googlebot/Bingbot, entirely
 * non-personalized, and already served `public` — so there is no cache-policy
 * redesign and no risk of leaking a personalized body from a shared cache.
 *
 * Probe 2026-08-04: /sitemap.xml carried `cache-control: public, max-age=3600`
 * but neither `Last-Modified` nor `ETag`, so a conditional GET had nothing to
 * match on and could never short-circuit.
 *
 * Emits BOTH validators, and honours either:
 *   - ETag / If-None-Match      — exact, catches any body change
 *   - Last-Modified / If-Modified-Since — cheap, and what most crawlers send
 *
 * `If-None-Match` wins when both are present, per RFC 9110 §13.1.3: an ETag
 * mismatch means the body genuinely differs, and second-resolution timestamps
 * cannot see a change that happened within the same second.
 */
export async function conditionalXmlResponse(opts: {
  request: Request;
  body: string;
  /** Newest underlying row. Null when unknown — then only the ETag validates. */
  lastModified: Date | null;
  maxAgeSeconds?: number;
}): Promise<Response> {
  const { request, body, lastModified, maxAgeSeconds = 3600 } = opts;

  // Weak validator: the body is generated, so byte-equality is the right test
  // and a hash of it is exact. W/ because two responses can be semantically
  // equal without being byte-identical if serialization ever changes.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const etag = `W/"${Array.from(new Uint8Array(digest.slice(0, 16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}"`;

  const headers: Record<string, string> = {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`,
    ETag: etag,
  };
  if (lastModified) headers["Last-Modified"] = lastModified.toUTCString();

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) {
    // A client may send a list; any member matching is a hit.
    const matches = ifNoneMatch
      .split(",")
      .map((t) => t.trim())
      .some((t) => t === etag || t === "*");
    return matches ? new Response(null, { status: 304, headers }) : new Response(body, { headers });
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (ifModifiedSince && lastModified) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have second resolution, so compare at that granularity —
    // otherwise a sub-second difference reads as "modified" on every request
    // and the 304 path never fires.
    if (
      !Number.isNaN(since) &&
      Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000)
    ) {
      return new Response(null, { status: 304, headers });
    }
  }

  return new Response(body, { headers });
}
