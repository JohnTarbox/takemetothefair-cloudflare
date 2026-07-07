/**
 * Performer-signal extractor (OPE-116) — pure: HTML → PerformerExtraction.
 *
 * The performer analog of promoter-extract.ts. A performer's own website is the
 * same shape as a vendor's/promoter's, so we REUSE extractVendorContact for the
 * contact / social / description signals and add the one image signal: the
 * og:image URL (the raw candidate for the single profile image — validated
 * downstream by promoter-image.ts's probe, reused as-is).
 *
 * No network, no DB. performer-dispatch.ts is the only piece that fetches or
 * writes.
 */
import type { ExtractionMethod } from "./types.js";
import { extractVendorContact } from "./extract.js";

/** Extraction methods a performer signal can carry (vendor set + og:image). */
export type PerformerExtractionMethod = ExtractionMethod | "og-image";

export interface PerformerSignal {
  value: string;
  method: PerformerExtractionMethod;
  confidence: number;
}

/** Raw, pre-safety extraction from a single performer page. */
export interface PerformerExtraction {
  /** og:image / twitter:image URL (absolute), un-probed. Feeds the profile image. */
  ogImage?: string;
  /** Meta / og description (highest-confidence prose available). */
  description?: PerformerSignal;
  /** platform→url JSON string, e.g. {"facebook":"https://facebook.com/x"}. */
  socialLinks?: PerformerSignal;
  contactEmail?: PerformerSignal;
  contactPhone?: PerformerSignal;
  /** <title> text + cleaned body — carried through for parity with the promoter
   *  extraction; callers may use them for future marker scans. */
  pageTitle?: string;
  bodyText?: string;
}

/** Resolve a possibly-relative og:image URL against the page it came from. */
function absoluteUrl(raw: string, baseUrl: string): string {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

/**
 * Extract the og:image (preferred) or twitter:image (fallback) URL. Same
 * pattern as promoter-extract.ts / src/lib/url-import/html-parser.ts.
 */
function extractOgImageUrl(html: string, baseUrl: string): string | undefined {
  const og =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i);
  if (og) return absoluteUrl(og[1].trim(), baseUrl);
  const tw =
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i);
  if (tw) return absoluteUrl(tw[1].trim(), baseUrl);
  return undefined;
}

/**
 * Pull performer enrichment signals from a rendered page. Contact / social /
 * description come from the shared vendor extractor (identical semantics);
 * og:image is the profile-image candidate.
 */
export function extractPerformerSignals(html: string, sourceUrl: string): PerformerExtraction {
  const v = extractVendorContact(html, sourceUrl);
  const out: PerformerExtraction = {};

  const og = extractOgImageUrl(html, sourceUrl);
  if (og) out.ogImage = og;

  if (v.description) {
    out.description = {
      value: v.description.value,
      method: v.description.method,
      confidence: v.description.confidence,
    };
  }
  if (v.social) {
    out.socialLinks = {
      value: JSON.stringify(v.social.value),
      method: v.social.method,
      confidence: v.social.confidence,
    };
  }
  if (v.email) {
    out.contactEmail = {
      value: v.email.value,
      method: v.email.method,
      confidence: v.email.confidence,
    };
  }
  if (v.phone) {
    out.contactPhone = {
      value: v.phone.value,
      method: v.phone.method,
      confidence: v.phone.confidence,
    };
  }
  if (v.pageTitle) out.pageTitle = v.pageTitle;
  if (v.bodyText) out.bodyText = v.bodyText;

  return out;
}
