// og:image extraction + quality gate, shared between the manual sweep
// endpoint and any future scheduled job.
//
// Phase 1 scope (analyst 2026-05-25): extract og:image (with twitter:image
// fallback) from a fetched page, apply heuristic quality gates, return a
// candidate URL or null. The optional dimension-check is approximated by
// content-length for now (see acceptCandidateImage). Phase 2 = real
// header parsing for JPEG SOF0 / PNG IHDR / WebP VP8X.

import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";

export const FETCH_TIMEOUT_MS = 15_000;

// Minimum acceptable Content-Length, a proxy for "≥ 600px on long edge."
// JPEG/PNG at that resolution with reasonable quality typically exceed
// 15KB; favicon-sized logos sit at 2-5KB; tracking pixels < 1KB. This is
// a heuristic, not a real dimension check (Phase 2).
const MIN_IMAGE_BYTES = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — keeps R2 cost predictable

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
  | "unknown_length";

export interface AcceptResult {
  ok: true;
  contentType: string;
  contentLength: number;
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
 */
export async function acceptCandidateImage(url: string): Promise<AcceptResult | RejectResult> {
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
    if (!Number.isFinite(len)) {
      // Some CDNs omit Content-Length on HEAD. Phase 1: accept and let
      // the body fetch enforce MAX_IMAGE_BYTES. Phase 2: probe with a
      // ranged GET to read the first KB and measure dimensions directly.
      return { ok: true, contentType, contentLength: -1 };
    }
    if (len < MIN_IMAGE_BYTES) {
      return { ok: false, reason: "too_small", detail: `${len} bytes` };
    }
    if (len > MAX_IMAGE_BYTES) {
      return { ok: false, reason: "too_large", detail: `${len} bytes` };
    }
    return { ok: true, contentType, contentLength: len };
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
