// og:image extraction + quality gate, shared between the manual sweep
// endpoint and any future scheduled job.
//
// Phase 1 scope (analyst 2026-05-25): extract og:image (with twitter:image
// fallback) from a fetched page, apply heuristic quality gates, return a
// candidate URL or null. The optional dimension-check is approximated by
// content-length for now (see acceptCandidateImage). Phase 2 = real
// header parsing for JPEG SOF0 / PNG IHDR / WebP VP8X.

import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import { parseImageDimensions, looksLikeLogo } from "./image-dimensions";

export const FETCH_TIMEOUT_MS = 15_000;

// Minimum acceptable Content-Length, a proxy for "≥ 600px on long edge."
// JPEG/PNG at that resolution with reasonable quality typically exceed
// 15KB; favicon-sized logos sit at 2-5KB; tracking pixels < 1KB. This is
// a heuristic used at the HEAD-only stage; Phase 2's measureImageBytes()
// (below) does a real Range-fetch + header parse before final accept.
const MIN_IMAGE_BYTES = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — keeps R2 cost predictable

// Phase 2 (analyst 2026-05-26): minimum long-edge pixels and minimum
// short-edge pixels for a "usable event image." 600/400 = a typical
// 3:2 photo at small-but-not-thumbnail size. The HEAD-content-length
// proxy is kept as the fast-path gate (cheaper than a Range fetch)
// but the Range probe enforces the real dimension contract.
const MIN_LONG_EDGE_PX = 600;
const MIN_SHORT_EDGE_PX = 400;
// 16KB is enough to cover the SOF marker in even progressive JPEGs;
// PNG/WebP fit in the first ~64 bytes. Range header is end-inclusive.
const DIMENSION_PROBE_BYTES = 16 * 1024;

// Content types we keep. SVG is intentionally excluded — most og:image
// SVGs in our test set are logos, not event imagery.
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

// URL substrings that mark almost-always-junk images. Add to as the
// sweep encounters new false-positives.
const URL_JUNK_PATTERNS = [
  "calendar.google.com",
  "/calendar/event",
  "/calendar?",
  "addtocalendar",
  "doubleclick.net",
  "googlesyndication",
  "1x1.gif",
  "1px.gif",
  "pixel.gif",
  "spacer.gif",
  "spacer.png",
  "transparent.gif",
];

export interface OgImageResult {
  url: string;
  source: "og:image" | "twitter:image";
}

export type RejectReason =
  | "no_meta_tag"
  | "junk_url_pattern"
  | "data_uri"
  | "fetch_failed"
  | "head_failed"
  | "non_image_content_type"
  | "disallowed_content_type"
  | "too_small"
  | "too_large"
  | "unknown_length"
  // Phase 2 — real-dimension and logo gates (analyst 2026-05-26).
  | "dimensions_unparseable"
  | "below_min_dimensions"
  | "looks_like_logo";

export interface AcceptResult {
  ok: true;
  contentType: string;
  contentLength: number;
  /** Pixel dimensions when the Range-probe parser succeeded; null when the
   *  caller skipped the probe (probeDimensions=false) or the probe couldn't
   *  reach a Phase-2 parser. */
  dimensions: { width: number; height: number } | null;
}

export interface RejectResult {
  ok: false;
  reason: RejectReason;
  detail?: string;
}

/**
 * Extract og:image (preferred) or twitter:image (fallback) from HTML.
 * Returns null if neither is present.
 */
export function extractOgImage(html: string, baseUrl: string): OgImageResult | null {
  // Try og:image first. Match both property="og:image" and content order.
  const ogMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i);
  if (ogMatch) {
    const url = absoluteUrl(ogMatch[1], baseUrl);
    if (url) return { url, source: "og:image" };
  }

  const twMatch =
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i);
  if (twMatch) {
    const url = absoluteUrl(twMatch[1], baseUrl);
    if (url) return { url, source: "twitter:image" };
  }

  return null;
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  // Skip data URIs — they're never event imagery.
  if (href.startsWith("data:")) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * URL-only screening — runs before any HTTP call. Cheap and catches the
 * obvious junk patterns.
 */
export function urlLooksLikeJunk(url: string): boolean {
  const lower = url.toLowerCase();
  return URL_JUNK_PATTERNS.some((p) => lower.includes(p));
}

/**
 * HEAD-based quality gate. Cheaper than fetching the body just to bounce.
 *
 * Phase 2 (analyst 2026-05-26): when `probeDimensions=true` (default), the
 * accept path also issues a Range GET for the first 16KB so it can parse
 * real width/height from the JPEG/PNG/WebP header. Replaces the 15KB
 * content-length proxy as the dimension contract — content-length stays
 * as the cheap pre-filter, but real dimensions are the binding check.
 *
 * On dimensions: rejects below MIN_LONG_EDGE_PX × MIN_SHORT_EDGE_PX and
 * runs the logo down-rank heuristic so a tall-narrow PNG logo can't slip
 * through purely on byte size. Falling back to allow when the Range
 * fetch fails (some CDNs reject Range) — the byte-size gate still applies.
 */
export async function acceptCandidateImage(
  url: string,
  options: { probeDimensions?: boolean } = {}
): Promise<AcceptResult | RejectResult> {
  const { probeDimensions = true } = options;
  if (url.startsWith("data:")) return { ok: false, reason: "data_uri" };
  if (urlLooksLikeJunk(url)) return { ok: false, reason: "junk_url_pattern", detail: url };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": SCRAPER_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, reason: "head_failed", detail: `HTTP ${res.status}` };
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      return { ok: false, reason: "non_image_content_type", detail: contentType };
    }
    if (!ACCEPTED_IMAGE_TYPES.has(contentType)) {
      return { ok: false, reason: "disallowed_content_type", detail: contentType };
    }
    const lenHeader = res.headers.get("content-length");
    const len = lenHeader ? parseInt(lenHeader, 10) : NaN;
    if (Number.isFinite(len)) {
      if (len < MIN_IMAGE_BYTES) {
        return { ok: false, reason: "too_small", detail: `${len} bytes` };
      }
      if (len > MAX_IMAGE_BYTES) {
        return { ok: false, reason: "too_large", detail: `${len} bytes` };
      }
    }
    // Phase 2 dimension probe. Skip when the caller opts out (legacy
    // path) or when content-length was unknown AND we can't justify a
    // Range fetch on top of an already-uncertain CDN.
    let dimensions: { width: number; height: number } | null = null;
    if (probeDimensions) {
      dimensions = await probeImageDimensions(url, contentType);
      if (dimensions) {
        if (
          Math.max(dimensions.width, dimensions.height) < MIN_LONG_EDGE_PX ||
          Math.min(dimensions.width, dimensions.height) < MIN_SHORT_EDGE_PX
        ) {
          return {
            ok: false,
            reason: "below_min_dimensions",
            detail: `${dimensions.width}x${dimensions.height}`,
          };
        }
        const logoCheck = looksLikeLogo(url, dimensions.width, dimensions.height);
        if (logoCheck.isLogo) {
          return { ok: false, reason: "looks_like_logo", detail: logoCheck.reason };
        }
      } else if (Number.isFinite(len) && len < 50_000) {
        // No dimensions AND a small file — almost certainly a logo whose
        // header sat outside our 16KB Range. Reject. Larger unparseable
        // files (likely big photos with progressive JPEG markers we
        // can't reach) are allowed through under the byte-size gate.
        return {
          ok: false,
          reason: "dimensions_unparseable",
          detail: `${len} bytes, no header parse`,
        };
      }
    }
    return {
      ok: true,
      contentType,
      contentLength: Number.isFinite(len) ? len : -1,
      dimensions,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Range-fetch the first DIMENSION_PROBE_BYTES of an image and parse
 *  width/height from its header. Returns null on any failure path; the
 *  caller treats null as "couldn't measure" rather than "rejected." */
async function probeImageDimensions(
  url: string,
  contentType: string
): Promise<{ width: number; height: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": SCRAPER_USER_AGENT,
        Range: `bytes=0-${DIMENSION_PROBE_BYTES - 1}`,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    // Some CDNs ignore Range and return 200 with the full body; that's
    // fine — we slice to PROBE_BYTES anyway. Reject only on error status.
    if (!res.ok && res.status !== 206) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const bytes = buf.length > DIMENSION_PROBE_BYTES ? buf.slice(0, DIMENSION_PROBE_BYTES) : buf;
    return parseImageDimensions(bytes, contentType);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the page HTML for og:image extraction. Caller pre-screens the
 * source URL (e.g. via shouldIngestFromSource) — this helper just runs
 * the GET with the project's polite-bot UA + a finite timeout.
 */
export async function fetchPageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SCRAPER_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function extensionForContentType(contentType: string): string | null {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}
