/**
 * Promoter og:image probe + hero/logo classifier (OPE-36).
 *
 * Range-fetches the first ~64KB of a candidate image, parses its real pixel
 * dimensions (REUSING src/lib/image-dimensions.ts — the same pure parsers the
 * og-image sweep uses), and decides whether it's a full-bleed HERO band or a
 * square LOGO:
 *
 *   hero  ⇔  aspect ratio (max/min) ≥ 1.3  AND  NOT looksLikeLogo(...)  AND
 *            no logo/icon/wordmark/favicon token in the URL
 *   logo  ⇔  everything else (including un-measurable images — we can't
 *            confirm a hero without dimensions, so we default to the safer
 *            logo slot and never auto-apply it)
 *
 * SSRF guard (isBlockedSsrfHost) runs BEFORE any fetch — the promoter website
 * (and thus its og:image host) is operator-curated, but the guard is cheap
 * defense-in-depth, identical to fetch-site.ts.
 */
import { isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import { parseImageDimensions, looksLikeLogo } from "../../../src/lib/image-dimensions.js";

/** First 64KB covers the SOF marker in even progressive JPEGs; PNG/WebP fit
 *  in the first ~64 bytes. Range header is end-inclusive. */
const PROBE_BYTES = 64 * 1024;

/** Minimum long/short aspect ratio for a wide hero band. */
const HERO_MIN_ASPECT = 1.3;

/** URL tokens that mark an image as a brand mark, never a hero. */
const LOGO_URL_TOKEN = /(logo|icon|wordmark|favicon)/i;

export type PromoterImageClass = "hero" | "logo";

export interface ProbedPromoterImage {
  url: string;
  width: number | null;
  height: number | null;
  classification: PromoterImageClass;
  /** True ONLY when the full hero rule holds (AR ≥ 1.3, not logo-shaped, no
   *  logo token). Gates the high-confidence hero auto-apply. */
  heroConfident: boolean;
}

/** Pure classifier — split out so tests can drive it without a network mock. */
export function classifyPromoterImage(
  url: string,
  dims: { width: number; height: number } | null
): ProbedPromoterImage {
  const hasLogoToken = LOGO_URL_TOKEN.test(url);
  if (!dims) {
    // Can't measure → can't confirm a hero. Default to the logo slot.
    return { url, width: null, height: null, classification: "logo", heroConfident: false };
  }
  const { width, height } = dims;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const aspect = short === 0 ? 0 : long / short;
  const logoCheck = looksLikeLogo(url, width, height);
  const isHero = aspect >= HERO_MIN_ASPECT && !logoCheck.isLogo && !hasLogoToken;
  return {
    url,
    width,
    height,
    classification: isHero ? "hero" : "logo",
    heroConfident: isHero,
  };
}

/**
 * Probe a candidate og:image and classify it. Returns null only when the URL
 * is unusable (unparseable / non-http / SSRF-blocked). A fetch miss (CDN
 * rejects Range, times out, non-image) resolves to a logo classification with
 * null dimensions — a dead image is a signal, never a throw.
 */
export async function probePromoterImage(rawUrl: string): Promise<ProbedPromoterImage | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isBlockedSsrfHost(parsed.hostname)) return null;

  try {
    const res = await fetch(parsed.href, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    // 206 (honored Range) or 200 (CDN ignored it, sent full body) both fine.
    if (!res.ok && res.status !== 206) {
      return classifyPromoterImage(rawUrl, null);
    }
    const contentType = res.headers.get("content-type");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dims = parseImageDimensions(bytes, contentType);
    return classifyPromoterImage(rawUrl, dims);
  } catch {
    return classifyPromoterImage(rawUrl, null);
  }
}
