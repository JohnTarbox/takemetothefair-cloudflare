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
import { guardedFetch, isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import { parseImageDimensions, looksLikeLogo } from "../../../src/lib/image-dimensions.js";

/** First 64KB covers the SOF marker in even progressive JPEGs; PNG/WebP fit
 *  in the first ~64 bytes. Range header is end-inclusive. */
const PROBE_BYTES = 64 * 1024;
/** OPE-1370 — this probe had no timeout; a stalled CDN held the enrichment run. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Minimum long/short aspect ratio for a wide hero band. */
const HERO_MIN_ASPECT = 1.3;

/** URL tokens that mark an image as a brand mark, never a hero. */
const LOGO_URL_TOKEN = /(logo|icon|wordmark|favicon)/i;

/**
 * OPE-1687 — filename tokens that mark an image as a banner/graphic, never a
 * logo (Soule Homestead staged `newsletter-graphic.png` as its logo). Read from
 * the LAST path segment only, so a `/headers/` directory does not count.
 */
const NOT_LOGO_FILENAME_TOKEN = /(banner|header|hero|newsletter|cover|slide)/i;

/**
 * OPE-1687 — image dimensions a Wix URL states reliably, for when the probe
 * cannot measure the image itself:
 *   - `_d_<W>_<H>` in the media id is the ORIGINAL upload's size, and every Wix
 *     transform here preserves its aspect;
 *   - `/v1/fill/w_<W>,h_<H>` crops to exactly W×H.
 * Deliberately NOT `/v1/fit/w_<W>,h_<H>`: that is a bounding box which keeps
 * the source aspect and never upscales — Chandler Center's og:image sits in a
 * `fit/w_2500,h_1330` box and is a 500×500 square (measured 2026-11-18).
 * Exported for tests.
 */
export function wixHintedDimensions(url: string): { width: number; height: number } | null {
  const orig = url.match(/_d_(\d{2,5})_(\d{2,5})/);
  if (orig) return { width: Number(orig[1]), height: Number(orig[2]) };
  const fill = url.match(/\/v1\/fill\/w_(\d{2,5}),h_(\d{2,5})/);
  if (fill) return { width: Number(fill[1]), height: Number(fill[2]) };
  return null;
}

function lastSegment(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}

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
  // OPE-1687 — a banner/header/newsletter graphic is never a logo. Without a
  // confirmed hero it stages as an UNconfident hero (never auto-applied).
  const notLogoByName = !hasLogoToken && NOT_LOGO_FILENAME_TOKEN.test(lastSegment(url));
  if (!dims) {
    // Can't measure. OPE-1687 — a Wix URL may still state the shape reliably
    // (see wixHintedDimensions); a wide one is a hero candidate, but an
    // unmeasured image is never a CONFIDENT hero.
    const hinted = wixHintedDimensions(url);
    const hintedWide =
      hinted !== null &&
      Math.min(hinted.width, hinted.height) > 0 &&
      Math.max(hinted.width, hinted.height) / Math.min(hinted.width, hinted.height) >=
        HERO_MIN_ASPECT;
    const hero = !hasLogoToken && (hintedWide || notLogoByName);
    return {
      url,
      width: null,
      height: null,
      classification: hero ? "hero" : "logo",
      heroConfident: false,
    };
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
    classification: isHero || notLogoByName ? "hero" : "logo",
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
    // OPE-1370 — guardedFetch: the SSRF guard re-runs on every redirect hop
    // (the check above covers the first only), a timeout now exists at all
    // (there was none), and a CDN that ignores Range is read only to
    // PROBE_BYTES instead of downloaded whole.
    const res = await guardedFetch(parsed.href, {
      maxBytes: PROBE_BYTES,
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    // 206 (honored Range) or 200 (CDN ignored it, sent full body) both fine.
    if (!res.ok && res.status !== 206) {
      res.cancel();
      return classifyPromoterImage(rawUrl, null);
    }
    const contentType = res.headers.get("content-type");
    const bytes = await res.bytesPrefix(PROBE_BYTES);
    const dims = parseImageDimensions(bytes, contentType);
    return classifyPromoterImage(rawUrl, dims);
  } catch {
    return classifyPromoterImage(rawUrl, null);
  }
}
